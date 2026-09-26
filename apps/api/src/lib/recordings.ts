import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { visitRecordings } from "../db/schema";
import { env } from "../env";
import { activeKey, encryptField, keyById, loadedKeyIds } from "./crypto";
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
   * Расшифровать. `signal` срабатывает, если запись удалили или отозвали
   * согласие, пока модель работает: жечь процессор дальше на разговор,
   * который просили убрать, незачем — а у whisper.cpp этот разговор всё это
   * время лежит открытым временным файлом. Движок вправе сигнал не слушать
   * (вызов whisper пока не слушает — он на участке recordings): итог всё
   * равно отбросит запись результата.
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

/*
 * ─── захват, работа модели, запись итога ───
 *
 * Три шага, и транзакция только у крайних.
 *
 * Прежде воркер звал расшифровку внутри systemContext — одной транзакцией на
 * всё: захват строки, чтение файла, минуты работы модели, запись итога. Это
 * значило три вещи сразу. Строчный замок захвата держался, пока работает
 * модель, — и человек, нажавший «удалить» или «отозвать согласие», ждал
 * конца расшифровки (запрос висел минутами, а то и падал по таймауту
 * прокси). Статус «розшифровується» не видел никто до самого коммита: экран
 * приёма показывал «в очереди», пока всё уже шло. И соединение из пула было
 * занято на всё это время одним воркером. Тест этого не замечал: он звал
 * функцию без транзакции вокруг — не так, как воркер.
 *
 * Теперь захват — короткой транзакцией, коммит сразу: статус виден, замка
 * нет. Модель работает вне транзакции вовсе. Итог пишется второй короткой
 * транзакцией, и она заново смотрит на строку: не удалили ли запись, не
 * отозвали ли согласие, не перехватил ли её другой воркер. Любое «да» —
 * итог отбрасывается. Всё это верно, в какой бы транзакции расшифровку ни
 * позвали: шаги берут свои транзакции от baseDb и чужую не трогают.
 *
 * Цена короткого захвата — упавший воркер больше не «отпускает» строку
 * откатом: коммит уже был. Поэтому у захвата есть аренда. Пока модель
 * работает, воркер её продлевает; просроченную берёт следующий проход.
 * Метка захвата отличает свою аренду от чужой: опоздавший воркер, чью
 * аренду уже перехватили, своё не запишет.
 */

/** Аренда захвата: столько строка остаётся за воркером без продления */
const LEASE_MS = 10 * 60_000;
/**
 * Как часто воркер продлевает аренду — и заодно смотрит, жива ли запись.
 * Десять продлений на одну аренду: воркер, у которого моргнула база,
 * не теряет запись с первого же пропуска.
 */
const HEARTBEAT_MS = 60_000;

let timing = { leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS };

/** Тестам — короткие аренда и продление; null — как в бою */
export function setTranscribeTimingForTests(next: Partial<typeof timing> | null): void {
  timing = { leaseMs: next?.leaseMs ?? LEASE_MS, heartbeatMs: next?.heartbeatMs ?? HEARTBEAT_MS };
}

interface TranscribeJob {
  id: string;
  audioPath: string;
  /** Метка этого захвата: итог пишется, только пока строка захвачена ею */
  claim: string;
}

/**
 * Взять запись: самую старую ждущую — или брошенную упавшим воркером.
 *
 * Одним оператором, а не «выбрать, потом пометить». Два действия порознь
 * означают, что второй воркер видит ту же строку ещё не помеченной и
 * берётся за неё тоже: двойная нагрузка на процессор и затёртая
 * стенограмма. `for update skip locked` пропускает занятые строки вместо
 * ожидания, поэтому второй воркер сразу берёт следующую.
 *
 * Условия на согласие и файл — прямо здесь. Строка без файла, взятая в
 * работу, прежде оставалась в «розшифровується» навсегда (воркер брал её и
 * тут же бросал), а без согласия расшифровывать нечего по определению.
 *
 * Захват без срока (transcribe_lease_until пуст) считается брошенным: такие
 * строки остаются от расшифровки, позванной без транзакции до миграции 0103.
 */
async function claimRecording(): Promise<TranscribeJob | null> {
  const claim = crypto.randomUUID();
  const [row] = await db.execute<{ id: string; audio_path: string }>(sql`
    update visit_recordings
       set status = 'transcribing',
           transcribe_claim = ${claim},
           transcribe_lease_until = now() + make_interval(secs => ${timing.leaseMs / 1000})
     where id = (
       select id from visit_recordings
        where audio_path is not null
          and consent_at is not null
          and (status = 'uploaded'
               or (status = 'transcribing'
                   and (transcribe_lease_until is null or transcribe_lease_until < now())))
        order by created_at
        for update skip locked
        limit 1
     )
    returning id, audio_path
  `);
  return row ? { id: String(row.id), audioPath: String(row.audio_path), claim } : null;
}

/**
 * Продлить аренду. Ложь — запись больше не наша: удалена, согласие
 * отозвано или захват перехвачен.
 */
async function extendLease(job: TranscribeJob): Promise<boolean> {
  const rows = await db.execute(sql`
    update visit_recordings
       set transcribe_lease_until = now() + make_interval(secs => ${timing.leaseMs / 1000})
     where id = ${job.id}
       and transcribe_claim = ${job.claim}
       and status = 'transcribing'
       and consent_at is not null
    returning id
  `);
  return rows.length > 0;
}

/**
 * Продлевать аренду, пока модель работает; запись пропала — сказать модели
 * остановиться. Возвращает «хватит»: ждёт продление, если оно в пути, чтобы
 * оно не легло поверх уже записанного итога.
 */
function keepLease(job: TranscribeJob, stop: AbortController): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight || stop.signal.aborted) return;
    inFlight = systemContext(baseDb, () => extendLease(job))
      .then((ours) => {
        if (ours) return;
        log.info("recording.transcribe_stopped", { id: job.id });
        stop.abort();
      })
      // база моргнула — не повод бросать работу: аренда рассчитана на десять пропусков
      .catch((error) => log.warn("recording.lease_extend_failed", { id: job.id, error: String(error) }))
      .finally(() => {
        inFlight = null;
      });
  }, timing.heartbeatMs);
  return async () => {
    clearInterval(timer);
    if (inFlight) await inFlight;
  };
}

type TranscribeResult = { text: string } | { error: unknown };

/**
 * Записать итог — если запись всё ещё наша.
 *
 * Строка перечитывается под замком, и итог ложится, только если она по-
 * прежнему расшифровывается ЭТИМ захватом и согласие на месте. Модель
 * работала минутами, и за это время человек мог:
 *   — удалить запись: безусловный UPDATE клал бы текст разговора в базу
 *     ПОСЛЕ просьбы удалить — и он там оставался, потому что удаление уже
 *     отработало; неудачу — поднимал бы удалённую строку в «не вдалося», с
 *     кнопкой «повторить» и без следа того, что человек просил её убрать;
 *   — отозвать согласие: стенограмма разговора, хранить который больше нет
 *     основания;
 *   — отозвать и дать согласие снова, записать приём заново: статус опять
 *     дойдёт до «розшифровується», но захват будет уже другой, и старый итог
 *     лёг бы на новую запись.
 *
 * Отброшенный итог уносит и файл — если строка на него больше не ссылается,
 * а запись удалена или без согласия (или строки нет вовсе). Иначе файл не
 * трогается: при повторной записи путь тот же (`<id>.enc`), и стереть его
 * значило бы стереть НОВЫЙ разговор. Стирается под тем же замком: пока он
 * держится, запись не перейдёт ни в «іде запис», ни дальше.
 */
async function settleRecording(
  job: TranscribeJob,
  engine: string,
  result: TranscribeResult,
): Promise<"done" | "failed" | "discarded"> {
  const [row] = await db.execute<{
    status: string;
    consent_at: string | null;
    audio_path: string | null;
    transcribe_claim: string | null;
  }>(sql`
    select status, consent_at, audio_path, transcribe_claim
      from visit_recordings
     where id = ${job.id}
       for update
  `);
  const ours = row?.status === "transcribing" && row.transcribe_claim === job.claim && row.consent_at != null;
  if (!ours) {
    const gone = !row || ((row.status === "discarded" || row.status === "consent_pending") && !row.audio_path);
    if (gone) await eraseAudio(job.audioPath);
    return "discarded";
  }

  const released = { transcribeClaim: null, transcribeLeaseUntil: null };
  if ("text" in result) {
    await db
      .update(visitRecordings)
      .set({
        status: "done",
        transcriptEnc: encryptField(result.text),
        transcriptEngine: engine,
        transcriptAt: new Date().toISOString(),
        ...released,
      })
      .where(eq(visitRecordings.id, job.id));
    return "done";
  }
  /*
   * Отказ записывается словами и остаётся видимым. Молчаливый провал
   * означал бы запись, которая «обрабатывается» третью неделю, и человека,
   * который ждёт стенограммы, не подозревая, что её не будет.
   */
  await db
    .update(visitRecordings)
    .set({ status: "failed", failure: String(result.error).slice(0, 500), ...released })
    .where(eq(visitRecordings.id, job.id));
  return "failed";
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

  const job = await systemContext(baseDb, () => claimRecording());
  if (!job) return false;

  const stop = new AbortController();
  const release = keepLease(job, stop);
  let result: TranscribeResult;
  try {
    const audio = await readAudio(job.audioPath);
    result = { text: await engine.run(audio, "uk", stop.signal) };
  } catch (error) {
    result = { error };
  } finally {
    await release();
  }

  const outcome = await systemContext(baseDb, () => settleRecording(job, engine.name, result));
  if (outcome === "done") {
    log.info("recording.transcribed", { id: job.id, chars: "text" in result ? result.text.length : 0 });
  } else if (outcome === "failed") {
    log.error("recording.transcribe_failed", { id: job.id, error: String("error" in result ? result.error : "") });
  } else {
    log.info("error" in result ? "recording.transcribe_failed_discarded" : "recording.transcribe_discarded", {
      id: job.id,
    });
  }
  return true;
}

/** Сколько записей ждёт расшифровки — для честной подписи на экране */
export async function pendingTranscriptions(): Promise<number> {
  const rows = await db
    .select({ id: visitRecordings.id })
    .from(visitRecordings)
    .where(inArray(visitRecordings.status, ["uploaded", "transcribing"]));
  return rows.length;
}
