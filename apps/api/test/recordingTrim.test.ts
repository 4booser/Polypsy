import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { api, app, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, visitRecordings } from "../src/db/schema";
import { eraseAudio, localWhisper, setTranscriberForTests, transcribeNext } from "../src/lib/recordings";
import { env } from "../src/env";

/**
 * Остановка пациентом и хвост записи.
 *
 * Пациент нажимает «зупинити» — сервер отмечает конец сразу, а браузер
 * специалиста, который и пишет звук, узнаёт об этом опросом (раз в четыре
 * секунды, во вкладке на заднем плане — реже) и всё это время пишет
 * дальше. Файл приходит длиннее разговора, и в стенограмму попадало
 * сказанное после остановки. Теперь преобразование в WAV обрезает звук по
 * длительности строки — от начала записи до остановки.
 *
 * Движки поддельные (как в recordingPipeline.test.ts): проверяется, какие
 * флаги получает ffmpeg, а не качество распознавания.
 */

let work: string;
let departmentId: string;
const mine: string[] = [];
const saved = { bin: env.whisperBin, model: env.whisperModel, ffmpeg: (env as { ffmpegBin?: string }).ffmpegBin };

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "quizzy-trim-"));
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({ id: departmentId, title: { uk: "Відділення обрізки", ru: "Отделение обрезки" }, timezone: "Europe/Kyiv" });
});

afterAll(async () => {
  env.whisperBin = saved.bin;
  env.whisperModel = saved.model;
  (env as { ffmpegBin?: string }).ffmpegBin = saved.ffmpeg;
  setTranscriberForTests(null);
  // свои строки — в конечное состояние: очередь расшифровки общая на процесс
  if (mine.length) {
    const rows = await db.select().from(visitRecordings).where(inArray(visitRecordings.appointmentId, mine));
    for (const row of rows) await eraseAudio(row.audioPath);
    await db
      .update(visitRecordings)
      .set({ status: "discarded", audioPath: null, audioBytes: null })
      .where(inArray(visitRecordings.appointmentId, mine));
  }
  await rm(work, { recursive: true, force: true });
});

async function visit() {
  const specialist = await makeUser("admin", `trim-s-${crypto.randomUUID()}@test`);
  const patient = await makeUser("user", `trim-p-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: specialist.id, departmentId }).onConflictDoNothing();
  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    specialistId: specialist.id,
    departmentId,
    startsAt: new Date(Date.now() + 3600_000).toISOString(),
    endsAt: new Date(Date.now() + 7200_000).toISOString(),
    kind: "any",
  });
  const id = crypto.randomUUID();
  await db.insert(appointments).values({
    id,
    slotId,
    patientId: patient.id,
    specialistId: specialist.id,
    kind: "primary",
    status: "in_progress",
  });
  mine.push(id);
  return { id, patient, specialist };
}

/** ffmpeg: записывает свои аргументы и кладёт в выход WAV с тишиной */
async function loggingFfmpeg() {
  const log = join(work, `ffmpeg-${crypto.randomUUID()}.log`);
  const bin = join(work, `ffmpeg-${crypto.randomUUID()}.sh`);
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" > '${log}'
for last; do :; done
printf 'RIFF\\044\\000\\000\\000WAVEfmt ' > "$last"
head -c 32000 /dev/zero >> "$last"
exit 0
`,
  );
  await chmod(bin, 0o755);
  return { bin, log };
}

/** whisper-cli: отвечает фразой, если вход — WAV */
async function fakeWhisper(text: string) {
  const bin = join(work, `whisper-${crypto.randomUUID()}.sh`);
  await writeFile(
    bin,
    `#!/bin/sh
in=""
while [ $# -gt 0 ]; do case "$1" in -f) in="$2"; shift ;; esac; shift; done
[ "$(head -c 4 "$in")" = "RIFF" ] || exit 0
printf '\\n%s' '${text}'
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

async function useEngines() {
  const ffmpeg = await loggingFfmpeg();
  env.whisperBin = await fakeWhisper("Розмова до зупинки");
  env.whisperModel = join(work, "ggml-test.bin");
  (env as { ffmpegBin?: string }).ffmpegBin = ffmpeg.bin;
  setTranscriberForTests(null);
  return ffmpeg;
}

/** Аргументы ffmpeg: значение после `-t`, если он был, и последним ли стоит выход */
async function ffmpegSaw(log: string) {
  const argv = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  const at = argv.indexOf("-t");
  return { argv, limitSec: at >= 0 ? Number(argv[at + 1]) : null, beforeOutput: at >= 0 && at < argv.length - 2 };
}

const EBML = [0x1a, 0x45, 0xdf, 0xa3];
function webm(size = 4096): Uint8Array {
  const b = new Uint8Array(size).fill(0x42);
  b.set(EBML, 0);
  return b;
}

describe("хвост после остановки пациентом", () => {
  test("стенограмма обрезается по моменту остановки, а не по приходу файла", async () => {
    const ffmpeg = await useEngines();
    const v = await visit();
    await api(`/api/recordings/${v.id}/consent`, v.patient.token, { method: "POST" });
    expect((await api(`/api/recordings/${v.id}/start`, v.specialist.token, { method: "POST" })).status).toBe(200);

    // разговор шёл десять секунд (согласие — раньше начала, как и в жизни)
    const now = Date.now();
    await db
      .update(visitRecordings)
      .set({ consentAt: new Date(now - 3600_000).toISOString(), startedAt: new Date(now - 10_000).toISOString() })
      .where(eq(visitRecordings.appointmentId, v.id));

    // пациент останавливает — без файла: звук у специалиста
    const stop = await app.request(`/api/recordings/${v.id}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${v.patient.token}` },
    });
    expect(stop.status).toBe(200);

    // браузер специалиста узнаёт об остановке опросом — и шлёт файл позже
    await Bun.sleep(1500);
    const form = new FormData();
    form.append("audio", new File([webm()], "visit.webm", { type: "audio/webm" }));
    form.append("uploadId", crypto.randomUUID());
    const upload = await app.request(`/api/recordings/${v.id}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${v.specialist.token}` },
      body: form,
    });
    expect(upload.status).toBe(200);

    // первой в очереди: очередь общая на процесс, расшифровщик берёт самую старую
    await db
      .update(visitRecordings)
      .set({ createdAt: new Date(Date.UTC(1980, 0, 1)).toISOString() })
      .where(eq(visitRecordings.appointmentId, v.id));

    expect(await transcribeNext()).toBe(true);
    const row = await db.query.visitRecordings.findFirst({ where: eq(visitRecordings.appointmentId, v.id) });
    expect(row!.status, "взята чужая строка очереди или расшифровка сорвалась").toBe("done");

    const saw = await ffmpegSaw(ffmpeg.log);
    expect(saw.limitSec, "звук после остановки пациентом ушёл в стенограмму").not.toBeNull();
    // десять секунд разговора, а не одиннадцать с половиной до прихода файла
    expect(saw.limitSec!).toBeGreaterThan(9.5);
    expect(saw.limitSec!).toBeLessThan(10.8);
    expect(saw.beforeOutput, "-t после имени выхода ffmpeg не применит").toBe(true);
  }, 30_000);

  test("длительность неизвестна — звук не режется", async () => {
    const ffmpeg = await useEngines();
    const riff = new Uint8Array(4096);
    riff.set(new TextEncoder().encode("RIFF"), 0);
    riff.set(new TextEncoder().encode("WAVEfmt "), 8);
    await localWhisper()!.run(Buffer.from(riff), "uk", undefined, null);
    const saw = await ffmpegSaw(ffmpeg.log);
    expect(saw.argv).not.toContain("-t");
  });
});
