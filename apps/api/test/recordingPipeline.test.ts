import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { api, app, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, visitRecordings } from "../src/db/schema";
import {
  eraseAudio,
  localWhisper,
  setTranscriberForTests,
  sniffAudio,
  storeAudio,
  transcribeNext,
} from "../src/lib/recordings";
import { env } from "../src/env";

/**
 * Путь записи приёма от браузера до стенограммы — на поддельных движках,
 * которые ведут себя как настоящие.
 *
 * Поддельные whisper-cli и ffmpeg повторяют ровно то поведение, из-за
 * которого случились дефекты, — проверено на настоящих whisper.cpp v1.7.4 и
 * ffmpeg в образе (см. отчёт волны 12):
 *
 *   — whisper-cli с `--output-txt` кладёт `<вход>.txt` РЯДОМ с входным
 *     файлом — открытый текст разговора на диске;
 *   — не-WAV (запись браузера — WebM/Opus) whisper-cli не читает, пишет
 *     «failed to read» в stderr и выходит с кодом 0 и пустым stdout;
 *   — ffmpeg на мусоре выходит с ненулевым кодом.
 *
 * Настоящие движки в сюите не запускаются: модели нет, и прогон
 * расшифровки занимал бы минуты. Проверяется то, что делает НАШ код вокруг
 * них: какие флаги передаёт, что остаётся на диске, что пишется в базу.
 */

let departmentId: string;
let work: string;
const mine: string[] = [];

const saved = {
  bin: env.whisperBin,
  model: env.whisperModel,
  ffmpeg: (env as { ffmpegBin?: string }).ffmpegBin,
};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "quizzy-fake-engines-"));
  setTranscriberForTests(null);
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

async function visit(tag: string) {
  if (!departmentId) {
    departmentId = crypto.randomUUID();
    await db.insert(departments).values({
      id: departmentId,
      title: { uk: "Відділення розшифровки", ru: "Отделение расшифровки" },
      timezone: "Europe/Kyiv",
    });
  }
  const specialist = await makeUser("admin", `pipe-s-${tag}-${crypto.randomUUID()}@test`);
  const patient = await makeUser("user", `pipe-p-${tag}-${crypto.randomUUID()}@test`);
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

/* ── образцы байтов: только сигнатуры, тело — заполнитель ── */

const EBML = [0x1a, 0x45, 0xdf, 0xa3];
function webm(size = 2048): Uint8Array {
  const b = new Uint8Array(size).fill(0x42);
  b.set(EBML, 0);
  return b;
}
function wav(size = 2048): Uint8Array {
  const b = new Uint8Array(size).fill(0);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVEfmt "), 8);
  return b;
}

/* ── поддельные движки ── */

/**
 * whisper-cli: флаги разбираются как у настоящего v1.7.4. Вход — после
 * `-f`; `--output-txt`/`-otxt` кладёт `<вход>.txt` (или `<-of>.txt`);
 * не-WAV — отказ в stderr и код 0. `always` — движок, который пишет побочные
 * файлы сам, без флагов: наш код обязан убрать и их.
 */
async function fakeWhisper(opts: { text: string; always?: boolean; name?: string }) {
  const log = join(work, `${opts.name ?? "whisper"}-${crypto.randomUUID()}.log`);
  const bin = join(work, `${opts.name ?? "whisper"}-${crypto.randomUUID()}.sh`);
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" > '${log}'
in=""; of=""; txt=0
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--file) in="$2"; shift ;;
    -of|--output-file) of="$2"; shift ;;
    -otxt|--output-txt) txt=1 ;;
  esac
  shift
done
printf 'input=%s\\n' "$in" >> '${log}'
magic=$(head -c 4 "$in")
printf 'magic=%s\\n' "$magic" >> '${log}'
if [ "$magic" != "RIFF" ]; then
  echo "error: failed to open '$in' as WAV file" >&2
  echo "error: failed to read WAV file '$in'" >&2
  exit 0
fi
[ -z "$of" ] && of="$in"
text='${opts.text}'
if [ $txt = 1 ]; then printf '%s\\n' "$text" > "$of.txt"; fi
${opts.always ? `printf '%s\\n' "$text" > "$in.txt"; printf '{"text":"%s"}' "$text" > "$in.json"` : ""}
echo "whisper_init_from_file_with_params_no_state: loading model" >&2
[ -n "$text" ] && printf '\\n%s' "$text"
exit 0
`,
  );
  await chmod(bin, 0o755);
  return { bin, log };
}

/**
 * ffmpeg: понимает вход по сигнатуре (WebM/Ogg/MP4/WAV) и кладёт в выход
 * WAV-заголовок с тишиной; на прочем — отказ с кодом 183, как настоящий.
 */
async function fakeFfmpeg() {
  const bin = join(work, `ffmpeg-${crypto.randomUUID()}.sh`);
  await writeFile(
    bin,
    `#!/bin/sh
in=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in -i) in="$2"; shift ;; esac
  out="$1"
  shift
done
magic=$(head -c 4 "$in" | od -An -tx1 | tr -d ' \\n')
box=$(dd if="$in" bs=1 skip=4 count=4 2>/dev/null)
case "$magic" in
  1a45dfa3|4f676753|52494646) ok=1 ;;
  *) [ "$box" = "ftyp" ] && ok=1 || ok=0 ;;
esac
if [ $ok = 0 ]; then
  echo "[in#0] Error opening input: Invalid data found when processing input" >&2
  exit 183
fi
printf 'RIFF\\044\\000\\000\\000WAVEfmt ' > "$out"
head -c 32000 /dev/zero >> "$out"
exit 0
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

function useEngines(whisper: string, ffmpeg: string) {
  env.whisperBin = whisper;
  env.whisperModel = join(work, "ggml-test.bin");
  (env as { ffmpegBin?: string }).ffmpegBin = ffmpeg;
  setTranscriberForTests(null);
}

/**
 * Положить запись в очередь первой.
 *
 * Очередь общая на процесс: расшифровщик берёт САМУЮ СТАРУЮ строку в
 * статусе uploaded. Дата заведения отодвинута далеко в прошлое — раньше, чем
 * у соседних файлов (они ставят 2000 год), — и после каждого прогона
 * проверяется, что взята именно наша строка.
 */
let order = 0;
async function queued(bytes: Uint8Array) {
  const v = await visit(`q${order}`);
  await api(`/api/recordings/${v.id}/consent`, v.patient.token, { method: "POST" });
  const [row] = await db.select().from(visitRecordings).where(eq(visitRecordings.appointmentId, v.id));
  const path = await storeAudio(row!.id, bytes);
  order += 1;
  await db
    .update(visitRecordings)
    .set({
      status: "uploaded",
      audioPath: path,
      audioBytes: bytes.byteLength,
      createdAt: new Date(Date.UTC(1990, 0, 1, 0, order)).toISOString(),
    })
    .where(eq(visitRecordings.id, row!.id));
  return { ...v, recId: row!.id, path };
}

const rowOf = (appointmentId: string) =>
  db.query.visitRecordings.findFirst({ where: eq(visitRecordings.appointmentId, appointmentId) });

/** Все файлы под каталогом (рекурсивно); каталога нет — пусто */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

/** Файлы, в которых встречается фраза открытым текстом */
async function plaintextHits(dir: string, phrase: string): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await filesUnder(dir)) {
    const s = await stat(file).catch(() => null);
    if (!s || s.size > 4 * 1024 * 1024) continue;
    const body = await readFile(file).catch(() => null);
    if (body?.includes(Buffer.from(phrase, "utf8"))) hits.push(file);
  }
  return hits;
}

async function whisperSaw(log: string) {
  const lines = (await readFile(log, "utf8")).split("\n");
  const input = lines.find((l) => l.startsWith("input="))?.slice("input=".length) ?? "";
  const magic = lines.find((l) => l.startsWith("magic="))?.slice("magic=".length) ?? "";
  const argv = lines.filter((l) => !l.startsWith("input=") && !l.startsWith("magic="));
  return { input, magic, argv };
}

describe("стенограмма не остаётся на диске открытым текстом", () => {
  test("после расшифровки ни рядом с аудио, ни в хранилище записей текста нет", async () => {
    const phrase = `Пацієнт розповів про безсоння ${crypto.randomUUID()}`;
    const whisper = await fakeWhisper({ text: phrase });
    useEngines(whisper.bin, await fakeFfmpeg());
    const rec = await queued(wav());

    expect(await transcribeNext()).toBe(true);
    const row = await rowOf(rec.id);
    expect(row!.status, "взята чужая строка очереди или расшифровка сорвалась").toBe("done");

    const saw = await whisperSaw(whisper.log);
    /*
     * Флагов вывода в файл нет вовсе: текст читается из stdout. С
     * `--output-txt` whisper кладёт `<вход>.txt` рядом с входом — и эту
     * стенограмму не видят ни удаление записи, ни ротация ключей.
     */
    expect(saw.argv.filter((a) => /^-o|^--output/.test(a)), "расшифровщик просит писать текст в файл").toEqual([]);

    // каталог, где лежал открытый вход, убран целиком — вместе со всем, что движок положил рядом
    const leftovers = await filesUnder(dirname(saw.input));
    expect(leftovers.filter((f) => f.startsWith(dirname(saw.input))), "рядом с открытым аудио что-то осталось").toEqual(
      [],
    );
    expect(await plaintextHits(resolve(env.recordingsDir), phrase), "стенограмма лежит в хранилище открытым текстом").toEqual(
      [],
    );
    expect(await plaintextHits(dirname(saw.input), phrase)).toEqual([]);
    // обход всего хранилища записей: на машине разработчика в нём копится всё, что оставили прогоны
  }, 30_000);

  test("побочные файлы убираются, даже если движок пишет их без спроса", async () => {
    /*
     * Отказ от флага — половина защиты: следующая версия движка или чужая
     * сборка может писать файлы и без него. Поэтому открытые данные живут в
     * своём временном каталоге, и он удаляется целиком в finally.
     */
    const phrase = `Сторож побочних файлів ${crypto.randomUUID()}`;
    const whisper = await fakeWhisper({ text: phrase, always: true });
    useEngines(whisper.bin, await fakeFfmpeg());
    const rec = await queued(wav());

    await transcribeNext();
    expect((await rowOf(rec.id))!.status).toBe("done");

    const saw = await whisperSaw(whisper.log);
    expect(existsSync(`${saw.input}.txt`), "побочный .txt пережил расшифровку").toBe(false);
    expect(existsSync(`${saw.input}.json`), "побочный .json пережил расшифровку").toBe(false);
    expect(await plaintextHits(resolve(env.recordingsDir), phrase)).toEqual([]);
  }, 30_000);
});

describe("формат записи браузера", () => {
  test("WebM из браузера доходит до whisper уже как WAV и расшифровывается", async () => {
    /*
     * Браузер пишет WebM/Opus; whisper.cpp без FFmpeg его не читает и
     * выходит с кодом 0 и пустым выводом. Прежде это сохранялось как
     * успешная пустая стенограмма.
     */
    const phrase = `Розмова про тривогу ${crypto.randomUUID()}`;
    const whisper = await fakeWhisper({ text: phrase });
    useEngines(whisper.bin, await fakeFfmpeg());
    const rec = await queued(webm());

    await transcribeNext();
    const saw = await whisperSaw(whisper.log);
    expect(saw.magic, "whisper получил не WAV").toBe("RIFF");

    const state = await api(`/api/recordings/${rec.id}`, rec.specialist.token);
    expect(state.body.status).toBe("done");
    expect(state.body.transcript).toContain(phrase);
  });

  test("пустая стенограмма при непустом аудио — сбой с причиной, а не «готово»", async () => {
    const whisper = await fakeWhisper({ text: "" });
    useEngines(whisper.bin, await fakeFfmpeg());
    const rec = await queued(webm());

    await transcribeNext();
    const row = await rowOf(rec.id);
    expect(row!.status, "пустая стенограмма записана как успешная").toBe("failed");
    expect(row!.transcriptEnc).toBeNull();
    expect(String(row!.failure)).toContain("empty-transcript");
  });

  test("аудио, которое не читается, — сбой с причиной", async () => {
    /*
     * Файл, принятый до проверки сигнатуры (или повреждённый), доходит до
     * преобразования, и ffmpeg от него отказывается. Это видно словами.
     */
    const whisper = await fakeWhisper({ text: "не должно дойти" });
    useEngines(whisper.bin, await fakeFfmpeg());
    const rec = await queued(new Uint8Array(512).fill(7));

    await transcribeNext();
    const row = await rowOf(rec.id);
    expect(row!.status).toBe("failed");
    expect(String(row!.failure)).toContain("audio-unreadable");
    expect(existsSync(whisper.log), "до whisper дошёл нечитаемый файл").toBe(false);
  });
});

describe("отмена расшифровки", () => {
  /*
   * Запись удалили или отозвали согласие, пока работает модель: воркер
   * (участок delivery) видит это при продлении аренды и передаёт сигнал.
   * Процесс должен погаснуть сразу, а открытое аудио и всё, что движок
   * успел положить рядом, — исчезнуть: расшифровывать то, что человек
   * попросил стереть, дальше незачем.
   */
  async function slowWhisper() {
    const log = join(work, `slow-${crypto.randomUUID()}.log`);
    const bin = join(work, `slow-${crypto.randomUUID()}.sh`);
    await writeFile(
      bin,
      `#!/bin/sh
in=""
while [ $# -gt 0 ]; do case "$1" in -f) in="$2"; shift ;; esac; shift; done
printf 'секрет розмови\\n' > "$in.txt"
printf 'input=%s\\npid=%s\\n' "$in" "$$" > '${log}'
exec sleep 30
`,
    );
    await chmod(bin, 0o755);
    return { bin, log };
  }

  test("по сигналу процесс гасится, временные файлы стираются", async () => {
    const slow = await slowWhisper();
    useEngines(slow.bin, await fakeFfmpeg());
    const engine = localWhisper()!;
    const controller = new AbortController();
    const running = engine.run(Buffer.from(wav()), "uk", controller.signal).catch((e: unknown) => e);

    let seen = "";
    for (let i = 0; i < 500 && !seen.includes("pid="); i++) {
      seen = await readFile(slow.log, "utf8").catch(() => "");
      if (!seen.includes("pid=")) await Bun.sleep(10);
    }
    const input = /input=(.*)/.exec(seen)?.[1] ?? "";
    const pid = Number(/pid=(\d+)/.exec(seen)?.[1]);
    expect(existsSync(`${input}.txt`), "поддельный движок не успел начать").toBe(true);

    const t0 = Date.now();
    controller.abort();
    const error = (await running) as Error;
    expect(error.name).toBe("AbortError");
    expect(Date.now() - t0, "отмена ждала, пока модель доработает").toBeLessThan(5000);

    expect(existsSync(dirname(input)), "временный каталог с открытым аудио пережил отмену").toBe(false);
    expect(existsSync(`${input}.txt`)).toBe(false);
    expect(() => process.kill(pid, 0), "процесс whisper пережил отмену").toThrow();
  }, 20_000);

  test("отменённое заранее до диска не доходит", async () => {
    const whisper = await fakeWhisper({ text: "не має дійти" });
    useEngines(whisper.bin, await fakeFfmpeg());
    const controller = new AbortController();
    controller.abort();
    const error = (await localWhisper()!
      .run(Buffer.from(wav()), "uk", controller.signal)
      .catch((e: unknown) => e)) as Error;
    expect(error.name).toBe("AbortError");
    expect(existsSync(whisper.log)).toBe(false);
  });
});

describe("сигнатуры аудио", () => {
  const ascii = (s: string) => Array.from(new TextEncoder().encode(s));
  const bytes = (head: number[], size = 64) => {
    const b = new Uint8Array(size);
    b.set(head, 0);
    return b;
  };

  test("узнаются контейнеры браузеров и WAV", () => {
    expect(sniffAudio(webm())).toBe("webm"); // Chrome, Firefox
    expect(sniffAudio(bytes(ascii("OggS")))).toBe("ogg"); // Firefox
    expect(sniffAudio(bytes([0, 0, 0, 0x1c, ...ascii("ftypiso5")]))).toBe("mp4"); // Safari
    expect(sniffAudio(wav())).toBe("wav");
  });

  test("прочее не принимается, как бы оно ни называлось", () => {
    expect(sniffAudio(new Uint8Array(4096).fill(7))).toBeNull();
    expect(sniffAudio(bytes(ascii("RIFF\0\0\0\0AVI ")))).toBeNull(); // RIFF, но видео
    expect(sniffAudio(bytes(ascii("%PDF-1.7")))).toBeNull();
    expect(sniffAudio(new Uint8Array([0x1a, 0x45, 0xdf]))).toBeNull(); // обрывок
  });
});

describe("приём файла проверяет формат по байтам", () => {
  async function upload(bytes: Uint8Array) {
    const v = await visit("sniff");
    await api(`/api/recordings/${v.id}/consent`, v.patient.token, { method: "POST" });
    await api(`/api/recordings/${v.id}/start`, v.specialist.token, { method: "POST" });
    const form = new FormData();
    // тип и имя намеренно «правильные»: верить им нельзя, смотрим в байты
    form.append("audio", new File([bytes], "visit.webm", { type: "audio/webm" }));
    const res = await app.request(`/api/recordings/${v.id}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${v.specialist.token}` },
      body: form,
    });
    return { res, v };
  }

  test("файл без сигнатуры аудио отклоняется и не ложится на диск", async () => {
    const { res, v } = await upload(new Uint8Array(4096).fill(7));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(String(body.error)).toContain("формат");
    const row = await rowOf(v.id);
    expect(row!.status, "запись не должна уходить из «идёт запись»: аудио ещё можно дослать").toBe("recording");
    expect(row!.audioPath).toBeNull();
  });

  test("WebM принимается", async () => {
    const { res, v } = await upload(webm(8192));
    expect(res.status).toBe(200);
    const row = await rowOf(v.id);
    expect(row!.status).toBe("uploaded");
    expect(existsSync(row!.audioPath!)).toBe(true);
  });
});
