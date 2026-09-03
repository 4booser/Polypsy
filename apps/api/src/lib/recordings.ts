import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { visitRecordings } from "../db/schema";
import { env } from "../env";
import { log } from "./log";

/**
 * Хранение и расшифровка записей приёма.
 *
 * Аудио не покидает учреждение. Это не предпочтение, а условие: отправить
 * запись психотерапевтической сессии в облачный сервис распознавания значит
 * раскрыть её третьей стороне — и человек, который говорил о себе, об этом не
 * узнает.
 */

/** Ключ шифрования файлов — тот же, что у полей: одна вещь, которую нельзя потерять */
function fileKey(): Buffer | null {
  const spec = env.encryptionKeys;
  if (!spec) return null;
  // формат тот же, что в lib/crypto: "id:base64key" через запятую, первый — активный
  const first = spec.split(",")[0]?.trim();
  const raw = first?.includes(":") ? first.split(":")[1] : first;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

/**
 * Записать аудио на диск зашифрованным.
 *
 * Без ключа файл не пишется вовсе, а не ложится открытым. Открытая запись
 * приёма на диске — это та же утечка, только медленная: её найдут при
 * следующем разборе бэкапов.
 */
export async function storeAudio(id: string, bytes: Uint8Array): Promise<string> {
  const key = fileKey();
  if (!key) throw new Error("шифрование не настроено: запись приёма не сохраняется открытой");

  const path = resolve(join(env.recordingsDir, `${id}.enc`));
  await mkdir(dirname(path), { recursive: true });

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  await writeFile(path, Buffer.concat([iv, cipher.getAuthTag(), body]));
  return path;
}

export async function readAudio(path: string): Promise<Buffer> {
  const key = fileKey();
  if (!key) throw new Error("шифрование не настроено");
  const blob = await readFile(path);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Стереть файл. Строка в базе остаётся: след того, что запись была, нужен */
export async function eraseAudio(path: string | null): Promise<void> {
  if (!path) return;
  await rm(path, { force: true });
}

/* ═══════════ расшифровка ═══════════ */

export interface Transcriber {
  /** Имя движка и версия — попадают в базу рядом со стенограммой */
  name: string;
  run(audio: Buffer, lang: "uk" | "ru"): Promise<string>;
}

/**
 * Расшифровщик подменяется в тестах.
 *
 * По умолчанию — свой whisper.cpp, запускаемый как процесс. Не настроен —
 * значит расшифровки нет, и это видно на экране: запись остаётся аудио, а не
 * молча числится «в обработке» до скончания века.
 */
let transcriber: Transcriber | null = null;

export function setTranscriberForTests(next: Transcriber | null): void {
  transcriber = next;
}

function localWhisper(): Transcriber | null {
  if (!env.whisperBin || !env.whisperModel) return null;
  return {
    name: `whisper.cpp ${env.whisperModel.split("/").pop() ?? ""}`.trim(),
    async run(audio, lang) {
      /*
       * Через временный файл, а не через stdin: whisper.cpp читает файл, и
       * подсовывать ему поток означало бы держать вторую реализацию ради
       * экономии одной записи на диск.
       */
      const tmp = resolve(join(env.recordingsDir, `tmp-${crypto.randomUUID()}.wav`));
      await mkdir(dirname(tmp), { recursive: true });
      await writeFile(tmp, audio);
      try {
        const proc = Bun.spawn(
          [env.whisperBin!, "-m", env.whisperModel!, "-f", tmp, "-l", lang, "--output-txt", "--no-timestamps"],
          { stdout: "pipe", stderr: "pipe" },
        );
        const out = await new Response(proc.stdout).text();
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          throw new Error(`whisper вышел с кодом ${code}: ${err.slice(0, 400)}`);
        }
        return out.trim();
      } finally {
        await rm(tmp, { force: true });
      }
    },
  };
}

/** Есть ли чем расшифровывать. Экран показывает это честно, а не обещает */
export function transcriptionAvailable(): boolean {
  return transcriber !== null || localWhisper() !== null;
}

/**
 * Расшифровать одну запись.
 *
 * По одной, а не пачкой: расшифровка часового приёма занимает минуты, и
 * очередь из пяти записей, взятая разом, заняла бы процессор на полчаса — а
 * рядом работает приложение, которым в это время пользуются.
 */
export async function transcribeNext(): Promise<boolean> {
  const engine = transcriber ?? localWhisper();
  if (!engine) return false;

  const [row] = await db
    .select()
    .from(visitRecordings)
    .where(eq(visitRecordings.status, "uploaded"))
    .limit(1);
  if (!row || !row.audioPath) return false;

  await db
    .update(visitRecordings)
    .set({ status: "transcribing" })
    .where(eq(visitRecordings.id, row.id));

  try {
    const audio = await readAudio(row.audioPath);
    const { encryptField } = await import("./crypto");
    const text = await engine.run(audio, "uk");
    await db
      .update(visitRecordings)
      .set({
        status: "done",
        transcriptEnc: encryptField(text),
        transcriptEngine: engine.name,
        transcriptAt: new Date().toISOString(),
      })
      .where(eq(visitRecordings.id, row.id));
    log.info("recording.transcribed", { id: row.id, chars: text.length });
    return true;
  } catch (error) {
    /*
     * Отказ записывается словами и остаётся видимым. Молчаливый провал
     * означал бы запись, которая «обрабатывается» третью неделю, и человека,
     * который ждёт стенограммы, не подозревая, что её не будет.
     */
    await db
      .update(visitRecordings)
      .set({ status: "failed", failure: String(error).slice(0, 500) })
      .where(eq(visitRecordings.id, row.id));
    log.error("recording.transcribe_failed", { id: row.id, error: String(error) });
    return true;
  }
}

/** Сколько записей ждёт расшифровки — для честной подписи на экране */
export async function pendingTranscriptions(): Promise<number> {
  const rows = await db
    .select({ id: visitRecordings.id })
    .from(visitRecordings)
    .where(inArray(visitRecordings.status, ["uploaded", "transcribing"]));
  return rows.length;
}
