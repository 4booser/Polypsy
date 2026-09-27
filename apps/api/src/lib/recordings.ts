import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { visitRecordings } from "../db/schema";
import { env } from "../env";
import { activeKey, keyById, loadedKeyIds } from "./crypto";
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

/**
 * Каким ключом зашифрован файл: идентификатор из заголовка, null — файл без
 * заголовка (записан до его появления). Хватает первых MAX_HEADER байт —
 * техпанель считает файлы по ключам, не читая многомегабайтное тело.
 */
export function recordingKeyId(blob: Buffer): { keyId: string | null; bodyAt: number } {
  const head = blob.subarray(0, MAX_HEADER).toString("latin1");
  if (!head.startsWith(`${FILE_PREFIX}:`)) return { keyId: null, bodyAt: 0 };
  const end = head.indexOf(":", FILE_PREFIX.length + 1);
  return { keyId: end > 0 ? head.slice(FILE_PREFIX.length + 1, end) : "", bodyAt: end + 1 };
}

/** Разобрать заголовок: ключ файла и то, что после заголовка */
function openFile(blob: Buffer): { key: Buffer; body: Buffer } {
  const { keyId, bodyAt } = recordingKeyId(blob);
  if (keyId !== null) {
    const key = keyId ? keyById(keyId) : undefined;
    if (!key) throw new Error(`ключ ${keyId || "?"} не найден: запись приёма не расшифровать`);
    return { key, body: blob.subarray(bodyAt) };
  }
  // легаси: заголовка нет, писалось активным ключом
  const active = activeKey();
  if (!active) throw new Error("шифрование не настроено");
  return { key: active.key, body: blob };
}

function decryptPayload(key: Buffer, payload: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

/**
 * Перешифровать файл записи на основной ключ — шаг ротации ключей.
 *
 * Без этого шага ротация тихо губила бы записи приёма: поля в базе
 * перешифровываются, счётчик «на старом ключе» показывает ноль, старый ключ
 * убирают — и файлы, записанные им, больше не открыть. Хуже того, файлы без
 * заголовка читаются ОСНОВНЫМ ключом (см. openFile), то есть ломаются уже в
 * момент, когда основным становится новый ключ.
 *
 * Для файла без заголовка ключ ищется перебором загруженных: тег GCM
 * отличает верный ключ от неверного без догадок. Новый файл пишется рядом и
 * подменяет старый переименованием — атомарно: читающий видит либо прежний
 * файл целиком, либо новый целиком.
 */
export async function rewrapAudio(
  path: string,
): Promise<"rewrapped" | "current" | "unreadable" | "missing"> {
  const active = activeKey();
  if (!active) throw new Error("шифрование не настроено");
  let blob: Buffer;
  try {
    blob = await readFile(path);
  } catch {
    return "missing";
  }
  const { keyId, bodyAt } = recordingKeyId(blob);
  if (keyId === active.id) return "current";

  const candidates = keyId !== null ? [keyById(keyId)] : loadedKeyIds().map((id) => keyById(id));
  const payload = blob.subarray(bodyAt);
  let plain: Buffer | null = null;
  for (const key of candidates) {
    if (!key) continue;
    try {
      plain = decryptPayload(key, payload);
      break;
    } catch {
      // не тот ключ — тег не сошёлся; пробуем следующий
    }
  }
  if (!plain) return "unreadable";

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", active.key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const next = `${path}.rewrap-${crypto.randomUUID()}`;
  await writeFile(next, Buffer.concat([fileHeader(active.id), iv, cipher.getAuthTag(), body]));
  await rename(next, path);
  return "rewrapped";
}

/**
 * Записать аудио на диск зашифрованным.
 *
 * Без ключа файл не пишется вовсе, а не ложится открытым. Открытая запись
 * приёма на диске — это та же утечка, только медленная: её найдут при
 * следующем разборе бэкапов.
 *
 * Имя у каждого файла своё — `<id записи>.<случайное>.enc`, — а не одно на
 * запись. Прежде две одновременные остановки писали в один путь `<id>.enc`:
 * вторая перезаписывала файл первой, а проигравшая условное обновление
 * стирала «свой» файл, который был общим. В базе оставалось «загружено», на
 * диске — пусто; специалист при этом видел «ок». Теперь каждая загрузка
 * трогает только свой файл, публикует его строка в базе (условным
 * обновлением, см. routes/recordings), и проигравший стирает своё и только
 * своё.
 *
 * Тело пишется во временный `.part` и переименовывается целиком: путь,
 * который попадёт в базу (и который техпанель посчитает как `.enc`), всегда
 * ведёт к дописанному файлу, а оборванная запись остаётся `.part`.
 */
export async function storeAudio(id: string, bytes: Uint8Array): Promise<string> {
  const active = activeKey();
  if (!active) throw new Error("шифрование не настроено: запись приёма не сохраняется открытой");

  const path = resolve(join(env.recordingsDir, `${id}.${crypto.randomUUID()}.enc`));
  await mkdir(dirname(path), { recursive: true });

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", active.key, iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const part = `${path}.part`;
  try {
    await writeFile(part, Buffer.concat([fileHeader(active.id), iv, cipher.getAuthTag(), body]));
    await rename(part, path);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  return path;
}

/** Контейнеры, которые пишут браузеры (и WAV — на случай записи не из браузера) */
export type AudioContainer = "webm" | "ogg" | "mp4" | "wav";

/**
 * Что за аудио — по первым байтам, а не по имени и типу из формы.
 *
 * Имя и Content-Type части формы задаёт клиент, и верить им нельзя: прежде
 * сервер принимал что угодно, а ошибку формата узнавал только расшифровщик
 * — часами позже, когда исправить уже нечего. Теперь нечитаемое
 * отклоняется при приёме, пока у специалиста запись ещё в браузере.
 *
 * Сигнатуры: WebM/Matroska — EBML `1A 45 DF A3` (Chrome, Firefox); Ogg —
 * `OggS` (Firefox); MP4 — коробка `ftyp` с четвёртого байта (Safari); WAV —
 * `RIFF....WAVE`. Всё это ffmpeg расшифровщика переводит в WAV для whisper.
 */
export function sniffAudio(bytes: Uint8Array): AudioContainer | null {
  if (bytes.length < 12) return null;
  const at = (offset: number, sig: readonly number[]) => sig.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (at(0, [0x4f, 0x67, 0x67, 0x53])) return "ogg";
  if (at(4, [0x66, 0x74, 0x79, 0x70])) return "mp4";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x41, 0x56, 0x45])) return "wav";
  return null;
}

export async function readAudio(path: string): Promise<Buffer> {
  const blob = await readFile(path);
  const { key, body: payload } = openFile(blob);
  return decryptPayload(key, payload);
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
  /**
   * Текст разговора. Пустой строкой whisper не отвечает: нет текста — это
   * отказ (исключение с причиной), а не успешная пустая стенограмма.
   *
   * signal — запись удалили или отозвали согласие, пока работает модель
   * (воркер видит это при продлении аренды, участок delivery). По сигналу
   * процесс гасится, временные файлы стираются, обещание отклоняется
   * ошибкой с name = "AbortError".
   */
  run(audio: Buffer, lang: "uk" | "ru", signal?: AbortSignal): Promise<string>;
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

/**
 * Причина отказа расшифровки — кодом в начале текста.
 *
 * Текст ложится в visit_recordings.failure, а его показывают и экран приёма,
 * и техпанель. По коду экран приёма объясняет отказ человеческими словами
 * (rec.fail.*), подробность после двоеточия остаётся для разбора. Ни в одном
 * тексте отказа нет вывода whisper в stdout: stdout — это и есть разговор.
 */
export type TranscribeFailure =
  | "audio-unreadable"
  | "audio-empty"
  | "converter-missing"
  | "whisper-exit"
  | "empty-transcript";

function failure(code: TranscribeFailure, detail: string): Error {
  return new Error(`${code}: ${detail}`);
}

/** Префикс рабочих каталогов расшифровки; по нему их находит и уборка */
const WORK_PREFIX = "quizzy-transcribe-";
/** Каталог старше этого — остаток убитого процесса: расшифровка столько не идёт */
const STALE_WORK_MS = 6 * 3600_000;
/** Заголовок WAV и десятая доля секунды звука (16 кГц, 16 бит, моно): меньше — записи нет */
const MIN_WAV_BYTES = 44 + 3200;

interface ToolRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Расшифровку отменили: запись удалили или отозвали согласие, пока шла работа */
function aborted(): Error {
  const error = new Error("aborted: запись удалена или согласие отозвано во время расшифровки");
  error.name = "AbortError";
  return error;
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

/**
 * Запустить внешний процесс и дочитать оба потока.
 *
 * Потоки читаются одновременно. Прежде stdout дочитывался до конца, а stderr
 * — только после выхода: whisper пишет в stderr килобайты журнала загрузки
 * модели, и переполненный канал stderr остановил бы процесс, который ждёт,
 * пока его прочтут, — а мы ждали бы его выхода. Расшифровка висела бы вечно.
 *
 * По сигналу отмены процесс убивается (SIGKILL: модель на середине часовой
 * записи на SIGTERM может отвечать долго, а писать дальше ей нечего), и
 * обещание отклоняется, когда процесс действительно вышел — только после
 * этого вызывающий стирает временный каталог, и движок уже не допишет туда
 * ничего после уборки. Потоков после отмены не ждём: их могли унаследовать
 * дочерние процессы.
 */
async function runTool(argv: string[], signal?: AbortSignal): Promise<ToolRun> {
  if (signal?.aborted) throw aborted();
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (!signal) {
    const [stdout, stderr, code] = await finished;
    return { code, stdout, stderr };
  }
  let onAbort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // уже вышел
      }
      void proc.exited.then(() => reject(aborted()));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const [stdout, stderr, code] = await Promise.race([finished, cancelled]);
    if (signal.aborted) throw aborted();
    return { code, stdout, stderr };
  } finally {
    signal.removeEventListener("abort", onAbort);
    // гонку выиграли потоки — отклонение отмены больше никому не нужно
    cancelled.catch(() => {});
  }
}

/** Строки отказа из stderr — для текста причины; путь рабочего каталога заменён */
function errorLines(stderr: string, dir: string, fallbackToTail = true): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errors = lines.filter((l) => /error|invalid|failed|could not/i.test(l));
  const picked = errors.length ? errors : fallbackToTail ? lines : [];
  return picked.slice(-3).join(" | ").replaceAll(dir, "<tmp>").slice(0, 300);
}

let swept = false;

/**
 * Убрать рабочие каталоги, брошенные убитым процессом.
 *
 * finally не выполняется, если процесс убили посреди расшифровки (выкатка,
 * нехватка памяти), — и открытое аудио осталось бы лежать. Раз за жизнь
 * процесса, при первой расшифровке, убирается всё старше шести часов:
 * свежие каталоги могут принадлежать соседнему процессу на той же машине.
 * В контейнере /tmp — tmpfs (docker-compose.yml), и после перезапуска там и
 * так пусто; уборка — для установки без контейнера.
 */
async function sweepStaleWork(root: string): Promise<void> {
  if (swept) return;
  swept = true;
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(WORK_PREFIX)) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > STALE_WORK_MS) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Перевести запись в WAV 16 кГц моно — формат, который whisper.cpp читает сам.
 *
 * Браузер пишет WebM/Opus (Chrome, Firefox), Ogg (Firefox) или MP4/AAC
 * (Safari); whisper.cpp v1.7.4 собран без FFmpeg и читает только WAV, MP3 и
 * FLAC. Прежде байты WebM сохранялись под именем .wav и уходили в whisper
 * как есть: тот писал «failed to read» в stderr и выходил с кодом 0 и пустым
 * выводом — и в карту ложилась успешная пустая стенограмма.
 *
 * Почему преобразование на сервере, а не WAV из браузера: WAV 16 кГц — это
 * 115 МБ на час приёма против 15 МБ Opus, то есть восьмикратная выгрузка по
 * сети отделения, восьмикратный диск и копии. Браузеры пишут разное, и
 * сервер всё равно должен понимать всё, что уже лежит в хранилище: записи,
 * сделанные до этой правки, — WebM, и теперь их можно расшифровать повтором
 * из техпанели. ffmpeg в образе собран только под эти форматы (Dockerfile) и
 * на непонятном входе выходит с ненулевым кодом, а не молчит.
 */
async function toWav(ffmpeg: string, input: string, output: string, dir: string, signal?: AbortSignal): Promise<void> {
  let run: ToolRun;
  try {
    run = await runTool(
      [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "-y",
        output,
      ],
      signal,
    );
  } catch (error) {
    if (isAbort(error)) throw error;
    throw failure("converter-missing", `ffmpeg не запустился (${ffmpeg}): ${String(error).slice(0, 200)}`);
  }
  if (run.code !== 0) {
    throw failure("audio-unreadable", `ffmpeg вышел с кодом ${run.code}: ${errorLines(run.stderr, dir)}`);
  }
  const size = (await stat(output).catch(() => null))?.size ?? 0;
  if (size < MIN_WAV_BYTES) throw failure("audio-empty", `после преобразования звука нет (${size} байт)`);
}

/**
 * Запустить whisper.cpp и взять текст из stdout.
 *
 * Ни одного флага вывода в файл (`--output-txt` и родня). С ним whisper
 * клал `<вход>.txt` рядом с входом — открытую стенограмму в каталоге
 * записей, которую не видели ни удаление записи, ни ротация ключей, а
 * уборка стирала только сам вход. stdout у whisper-cli — ровно текст
 * сегментов; журнал и ошибки идут в stderr.
 *
 * Код 0 ещё не успех: на нечитаемом входе whisper-cli v1.7.4 пишет ошибку
 * и выходит с нулём. Пустой вывод (или только «[BLANK_AUDIO]») при
 * непустом аудио — отказ с причиной, а не пустая стенограмма в карте.
 */
async function whisper(
  bin: string,
  model: string,
  wav: string,
  lang: string,
  dir: string,
  signal?: AbortSignal,
): Promise<string> {
  let run: ToolRun;
  try {
    run = await runTool([bin, "-m", model, "-f", wav, "-l", lang, "--no-timestamps"], signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw failure("whisper-exit", `whisper не запустился (${bin}): ${String(error).slice(0, 200)}`);
  }
  if (run.code !== 0) {
    throw failure("whisper-exit", `whisper вышел с кодом ${run.code}: ${errorLines(run.stderr, dir)}`);
  }
  const text = run.stdout.trim();
  if (!text.replace(/\[BLANK_AUDIO\]/g, "").trim()) {
    const why = errorLines(run.stderr, dir, false);
    throw failure("empty-transcript", `whisper не вернул текста${why ? `: ${why}` : ""}`);
  }
  return text;
}

/**
 * Свой whisper.cpp (с ffmpeg перед ним). Экспортирован для проверки отмены:
 * воркер в сюите подменён, а сигнал отмены передаёт только он.
 */
export function localWhisper(): Transcriber | null {
  if (!env.whisperBin || !env.whisperModel) return null;
  const bin = env.whisperBin;
  const model = env.whisperModel;
  const ffmpeg = env.ffmpegBin;
  return {
    name: `whisper.cpp ${model.split("/").pop() ?? ""}`.trim(),
    async run(audio, lang, signal) {
      /*
       * Открытое аудио живёт только в своём временном каталоге, и каталог
       * удаляется целиком в finally — вместе со всем, что движки положили
       * рядом, с флагом или без (и при отмене тоже: runTool отклоняет
       * обещание, только когда процесс уже вышел). Прежде временный файл
       * лежал в каталоге записей (это том, который уходит в копии), и
       * убирался только он сам.
       *
       * Каталог — во временном каталоге системы, а не в хранилище записей: в
       * контейнере это tmpfs, и открытые данные не касаются диска вовсе.
       */
      if (signal?.aborted) throw aborted();
      const root = tmpdir();
      await sweepStaleWork(root);
      const dir = await mkdtemp(join(root, WORK_PREFIX));
      try {
        const input = join(dir, "input");
        const wav = join(dir, "audio.wav");
        await writeFile(input, audio, { mode: 0o600 });
        await toWav(ffmpeg, input, wav, dir, signal);
        return await whisper(bin, model, wav, lang, dir, signal);
      } finally {
        await rm(dir, { recursive: true, force: true });
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
