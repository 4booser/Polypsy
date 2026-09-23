import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { visitRecordings } from "../db/schema";
import { env } from "../env";
import { activeKey, keyById } from "./crypto";
import { log } from "./log";

/**
 * Хранение и расшифровка записей приёма.
 *
 * Аудио не покидает учреждение. Это не предпочтение, а условие: отправить
 * запись психотерапевтической сессии в облачный сервис распознавания значит
 * раскрыть её третьей стороне — и человек, который говорил о себе, об этом не
 * узнает.
 */

/**
 * Каким ключом зашифрован файл — написано в самом файле.
 *
 * Заголовок «enc1:<id ключа>:» повторяет разметку шифрованных полей (см.
 * lib/crypto), дальше идут iv, тег и тело. Без него запись читалась первым
 * ключом из списка — то есть ротация ключей делала все прежние записи
 * приёмов нечитаемыми. Заметно это стало бы не в день ротации, а когда
 * специалист откроет прошлогодний приём: файл на диске есть, расшифровать
 * нечем, и понять, каким ключом он писался, уже неоткуда.
 *
 * Файлы без заголовка — записанные до этой правки — читаются первым ключом,
 * как и раньше: другого способа их прочесть нет.
 */
const FILE_PREFIX = "enc1";
/** Идентификатор ключа короткий («v1»); с запасом хватит на любое имя */
const MAX_HEADER = 80;

function fileHeader(keyId: string): Buffer {
  return Buffer.from(`${FILE_PREFIX}:${keyId}:`, "utf8");
}

/** Разобрать заголовок: ключ файла и то, что после заголовка */
function openFile(blob: Buffer): { key: Buffer; body: Buffer } {
  const head = blob.subarray(0, MAX_HEADER).toString("latin1");
  if (head.startsWith(`${FILE_PREFIX}:`)) {
    const end = head.indexOf(":", FILE_PREFIX.length + 1);
    const keyId = end > 0 ? head.slice(FILE_PREFIX.length + 1, end) : "";
    const key = keyId ? keyById(keyId) : undefined;
    if (!key) throw new Error(`ключ ${keyId || "?"} не найден: запись приёма не расшифровать`);
    return { key, body: blob.subarray(end + 1) };
  }
  // легаси: заголовка нет, писалось активным ключом
  const active = activeKey();
  if (!active) throw new Error("шифрование не настроено");
  return { key: active.key, body: blob };
}

/**
 * Записать аудио на диск зашифрованным.
 *
 * Без ключа файл не пишется вовсе, а не ложится открытым. Открытая запись
 * приёма на диске — это та же утечка, только медленная: её найдут при
 * следующем разборе бэкапов.
 */
export async function storeAudio(id: string, bytes: Uint8Array): Promise<string> {
  const active = activeKey();
  if (!active) throw new Error("шифрование не настроено: запись приёма не сохраняется открытой");

  const path = resolve(join(env.recordingsDir, `${id}.enc`));
  await mkdir(dirname(path), { recursive: true });

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", active.key, iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  await writeFile(path, Buffer.concat([fileHeader(active.id), iv, cipher.getAuthTag(), body]));
  return path;
}

export async function readAudio(path: string): Promise<Buffer> {
  const blob = await readFile(path);
  const { key, body: payload } = openFile(blob);
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const body = payload.subarray(28);
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

  /*
   * Запись забирается одним оператором, а не «выбрать, потом пометить».
   *
   * Два действия порознь означают, что второй воркер видит ту же строку
   * ещё не помеченной и берётся за неё тоже: расшифровка идёт двадцать
   * минут, всё это время его UPDATE ждёт на строчном замке, а потом
   * перезаписывает уже готовый результат — двойная нагрузка на процессор и
   * затёртая стенограмма.
   *
   * `for update skip locked` вдобавок пропускает занятые строки вместо
   * ожидания, поэтому второй воркер сразу берёт следующую.
   */
  const [claimed] = await db.execute<{ id: string; audio_path: string | null }>(sql`
    update visit_recordings
       set status = 'transcribing'
     where id = (
       select id from visit_recordings
        where status = 'uploaded'
        order by created_at
        for update skip locked
        limit 1
     )
    returning id, audio_path
  `);
  if (!claimed?.audio_path) return false;
  const row = { id: String(claimed.id), audioPath: String(claimed.audio_path) };

  try {
    const audio = await readAudio(row.audioPath);
    const { encryptField } = await import("./crypto");
    const text = await engine.run(audio, "uk");
    /*
     * Пишем только если запись всё ещё расшифровывается.
     *
     * Расшифровка идёт минутами, и за это время человек может попросить её
     * удалить. Без условия в самом UPDATE текст разговора ложился бы в базу
     * ПОСЛЕ просьбы удалить — и оставался там, потому что удаление уже
     * отработало.
     */
    const written = await db
      .update(visitRecordings)
      .set({
        status: "done",
        transcriptEnc: encryptField(text),
        transcriptEngine: engine.name,
        transcriptAt: new Date().toISOString(),
      })
      .where(and(eq(visitRecordings.id, row.id), eq(visitRecordings.status, "transcribing")))
      .returning({ id: visitRecordings.id });
    if (!written.length) {
      log.info("recording.transcribe_discarded", { id: row.id });
      return true;
    }
    log.info("recording.transcribed", { id: row.id, chars: text.length });
    return true;
  } catch (error) {
    /*
     * Отказ записывается словами и остаётся видимым. Молчаливый провал
     * означал бы запись, которая «обрабатывается» третью неделю, и человека,
     * который ждёт стенограммы, не подозревая, что её не будет.
     */
    const marked = await db
      .update(visitRecordings)
      .set({ status: "failed", failure: String(error).slice(0, 500) })
      /*
       * Условие то же, что у успешной ветки, и по той же причине.
       * Расшифровка идёт минутами, за это время запись могли удалить — и
       * безусловный UPDATE поднимал удалённую строку обратно в «не
       * получилось». На экране приёма она снова числилась записью: с
       * текстом ошибки, кнопкой «повторить» и без всякого следа того, что
       * человек попросил её убрать.
       */
      .where(and(eq(visitRecordings.id, row.id), eq(visitRecordings.status, "transcribing")))
      .returning({ id: visitRecordings.id });
    if (!marked.length) {
      log.info("recording.transcribe_failed_discarded", { id: row.id });
      return true;
    }
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
