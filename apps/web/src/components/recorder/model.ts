import type { UiKey } from "@quizzy/shared";

/**
 * Запись приёма в браузере: микрофон, рекордер, отправка — без React.
 *
 * Прежде всё это жило прямо в компоненте, и в трёх местах запись терялась
 * или микрофон оставался включённым:
 *
 *   — буфер и ссылка на рекордер очищались ДО ответа сервера: сеть
 *     моргнула при отправке — и часовой разговор пропадал, повторить было
 *     нечего;
 *   — при уходе с экрана рекордер и дорожки микрофона никто не
 *     останавливал: индикатор записи исчезал вместе с экраном, а микрофон
 *     продолжал писать;
 *   — если сервер отказывал в старте уже после того, как браузер дал
 *     микрофон (согласие отозвано, запись уже идёт), поток оставался
 *     открытым до закрытия вкладки.
 *
 * Здесь каждая ветка кончается освобождением микрофона, а аудио живёт до
 * подтверждения сервера. Логика отдельно от экрана — чтобы проверять её
 * тестами без браузера (apps/web/test/visitRecorder.test.ts).
 */

/**
 * idle — ничего не пишется и неотправленного нет;
 * acquiring — спрашиваем микрофон и сервер;
 * live — пишется;
 * stopping — рекордер отдаёт последний кусок;
 * sending — аудио уходит на сервер;
 * unsent — отправка не удалась, аудио в памяти вкладки, можно повторить.
 */
export type RecorderPhase = "idle" | "acquiring" | "live" | "stopping" | "sending" | "unsent";

export type RecorderNotice =
  /** браузер не дал микрофон */
  | { kind: "micDenied" }
  /** действие не удалось (сервер отказал в старте, рекордер не запустился) */
  | { kind: "failed"; message: string }
  /** отправка не удалась, аудио сохранено — можно повторить */
  | { kind: "sendFailed"; message: string }
  /** сервер отказал по существу — повтор не поможет, аудио стёрто */
  | { kind: "sendRefused"; message: string }
  /** запись остановила вторая сторона; записанное до того отправлено */
  | { kind: "stoppedRemotely" }
  /** запись удалили или отозвали согласие — записанное стёрто */
  | { kind: "withdrawn" };

export interface RecorderView {
  phase: RecorderPhase;
  notice: RecorderNotice | null;
  /** Начало идущей здесь записи по часам сервера — для секундомера до первого ответа опроса */
  startedAt: string | null;
}

/** Поток микрофона — ровно то, что нужно, чтобы его освободить */
export interface MicStream {
  getTracks(): { stop(): void }[];
}

/** Рекордер глазами модели; в браузере — обёртка над MediaRecorder (VisitRecorder.tsx) */
export interface RecorderLike {
  readonly mimeType: string;
  /** Начать; куски приходят раз в timesliceMs */
  start(timesliceMs: number, onChunk: (chunk: Blob) => void): void;
  /** Остановить; обещание исполняется после последнего куска */
  stop(): Promise<void>;
}

export interface RecorderDeps<S extends MicStream = MicStream> {
  getMic(): Promise<S>;
  makeRecorder(stream: S): RecorderLike;
  /** Сервер отмечает начало; отвечает моментом начала — по нему узнаётся своя запись в опросе */
  startOnServer(): Promise<{ startedAt?: string | null } | undefined>;
  /** Передать аудио; uploadId один на запись — по нему сервер узнаёт повтор */
  sendAudio(audio: Blob, uploadId: string): Promise<void>;
  /** Остановить на сервере без аудио — когда записать ничего не успели */
  stopOnServer(): Promise<void>;
  newId(): string;
}

/**
 * Кусок записи — раз в пять секунд. Рекордер отдаёт аудио кусками, и
 * последний приходит перед событием остановки — поэтому остановка ждёт его,
 * а не собирает то, что успело прийти.
 */
export const CHUNK_MS = 5000;

/**
 * Какой контейнер просить у браузера.
 *
 * Opus в WebM или Ogg (Chrome, Firefox) — 32 кбит/с дают около 15 МБ на
 * час приёма; Safari умеет только MP4/AAC. Всё это сервер принимает по
 * сигнатуре и переводит в WAV для расшифровки (lib/recordings.ts).
 */
export const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"] as const;

export function pickMimeType(supported: (type: string) => boolean): string | null {
  for (const type of MIME_PREFERENCE) {
    try {
      if (supported(type)) return type;
    } catch {
      // isTypeSupported бросает в старых браузерах — считаем «не умеет»
    }
  }
  return null;
}

/** Имя файла в форме — по типу; сервер ему не верит (смотрит в байты), но в журналах так понятнее */
export function audioFileName(type: string): string {
  if (type.includes("ogg")) return "visit.ogg";
  if (type.includes("mp4")) return "visit.m4a";
  if (type.includes("wav")) return "visit.wav";
  return "visit.webm";
}

/** Статус ответа из ошибки клиента API; 0 — до сервера не дошли */
export function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Отказ по существу — повтор не поможет.
 *
 * 400/403/404/409/410/413/415/422: запись удалили, согласие отозвали,
 * формат не тот, файл велик. Держать такое аудио дальше незачем — а
 * удалённое по просьбе человека не должно жить и в памяти вкладки.
 * Всё прочее — нет сети (0), истёк вход (401), перегрузка (408/429), сбой
 * сервера (5xx) — повторяемо, и аудио остаётся.
 */
export function refusedForGood(status: number): boolean {
  return [400, 403, 404, 409, 410, 413, 415, 422].includes(status);
}

/**
 * Код причины отказа расшифровки → строка экрана.
 *
 * Сервер пишет в failure код и подробность (lib/recordings.ts,
 * TranscribeFailure). Специалисту нужна не подробность ffmpeg, а что
 * делать: проверить микрофон или звать администратора.
 */
const FAILURE_KEYS: Record<string, UiKey> = {
  "audio-unreadable": "rec.fail.unreadable",
  "audio-empty": "rec.fail.silent",
  "empty-transcript": "rec.fail.silent",
  "converter-missing": "rec.fail.engine",
  "whisper-exit": "rec.fail.engine",
};

export function failureKey(failure: string | null | undefined): UiKey | null {
  if (!failure) return null;
  const match = /\b(audio-unreadable|audio-empty|empty-transcript|converter-missing|whisper-exit)\b/.exec(failure);
  return match ? (FAILURE_KEYS[match[1]!] ?? null) : null;
}

const sameMoment = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && Date.parse(a) === Date.parse(b);

export class RecorderSession<S extends MicStream = MicStream> {
  private view: RecorderView = { phase: "idle", notice: null, startedAt: null };
  private readonly listeners = new Set<() => void>();
  private stream: S | null = null;
  private recorder: RecorderLike | null = null;
  private chunks: Blob[] = [];
  private pending: { audio: Blob; uploadId: string } | null = null;
  private sending = false;
  /** Начало записи по часам сервера — чтобы узнать свою запись в опросе */
  private startedAt: string | null = null;
  /** Экран записи закрыт */
  private away = false;

  constructor(private readonly deps: RecorderDeps<S>) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Для useSyncExternalStore: тот же объект, пока ничего не менялось */
  snapshot = (): RecorderView => this.view;

  get phase(): RecorderPhase {
    return this.view.phase;
  }

  /** Есть аудио, которого сервер ещё не подтвердил: пишется, отправляется или ждёт повтора */
  get unsent(): boolean {
    const p = this.view.phase;
    return p === "live" || p === "stopping" || p === "sending" || p === "unsent";
  }

  private set(phase: RecorderPhase, notice: RecorderNotice | null): void {
    this.view = { phase, notice, startedAt: phase === "live" ? this.startedAt : null };
    for (const fn of this.listeners) fn();
  }

  /** Микрофон — освобождается в каждой ветке, где он больше не нужен */
  private release(): void {
    const stream = this.stream;
    this.stream = null;
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // дорожка уже остановлена
      }
    }
  }

  /** Остановить рекордер, освободить микрофон и собрать записанное */
  private async finish(): Promise<Blob | null> {
    const recorder = this.recorder;
    this.recorder = null;
    try {
      await recorder?.stop();
    } catch {
      // рекордер уже встал сам — берём то, что успело прийти
    } finally {
      this.release();
    }
    const chunks = this.chunks;
    this.chunks = [];
    if (!chunks.length) return null;
    return new Blob(chunks, { type: recorder?.mimeType || chunks[0]?.type || "audio/webm" });
  }

  /**
   * Начать запись.
   *
   * Порядок — микрофон, сервер, рекордер. Микрофон первым: если браузер
   * откажет, сервер не должен считать, что запись идёт. Сервер раньше
   * рекордера: он проверяет согласие, и до его «да» не пишется ни секунды.
   */
  async start(): Promise<void> {
    if (this.view.phase !== "idle") return;
    this.away = false;
    this.set("acquiring", null);

    let stream: S;
    try {
      stream = await this.deps.getMic();
    } catch {
      this.set("idle", { kind: "micDenied" });
      return;
    }
    this.stream = stream;
    if (this.away) {
      // с экрана ушли, пока браузер спрашивал разрешение: записи не будет
      this.release();
      this.set("idle", null);
      return;
    }

    let recorder: RecorderLike;
    let started: { startedAt?: string | null } | undefined;
    try {
      recorder = this.deps.makeRecorder(stream);
      started = await this.deps.startOnServer();
    } catch (error) {
      // сервер отказал (нет согласия, запись уже идёт) — микрофон не держим
      this.release();
      this.set("idle", { kind: "failed", message: messageOf(error) });
      return;
    }
    this.startedAt = started?.startedAt ?? null;

    if (this.away) {
      // ушли, пока сервер отвечал: он уже считает запись идущей — говорим, что её не было
      this.release();
      this.set("idle", null);
      await this.deps.stopOnServer().catch(() => {});
      return;
    }

    this.chunks = [];
    try {
      recorder.start(CHUNK_MS, (chunk) => {
        if (chunk.size) this.chunks.push(chunk);
      });
    } catch (error) {
      this.release();
      this.set("idle", { kind: "failed", message: messageOf(error) });
      await this.deps.stopOnServer().catch(() => {});
      return;
    }
    this.recorder = recorder;
    this.set("live", null);
  }

  /**
   * Остановить и отправить.
   *
   * Записанное становится «ожидающим отправки» и стирается только после
   * ответа сервера «принято» (или отказа по существу). Ключ отправки — один
   * на запись: повтор после обрыва сервер узнаёт и подтверждает.
   */
  async stop(notice: RecorderNotice | null = null): Promise<void> {
    if (this.view.phase !== "live") return;
    this.set("stopping", notice);
    const audio = await this.finish();
    if (!audio) {
      // ничего не записалось — но у второй стороны запись «идёт», пока сервер не узнает
      this.set("sending", notice);
      try {
        await this.deps.stopOnServer();
        this.set("idle", notice);
      } catch (error) {
        this.set("idle", { kind: "failed", message: messageOf(error) });
      }
      return;
    }
    this.pending = { audio, uploadId: this.deps.newId() };
    await this.send(notice);
  }

  /** Отправить ожидающее аудио — после остановки и по кнопке «Повторити відправлення» */
  async send(notice: RecorderNotice | null = null): Promise<void> {
    const pending = this.pending;
    if (!pending || this.sending) return;
    this.sending = true;
    this.set("sending", notice);
    try {
      await this.deps.sendAudio(pending.audio, pending.uploadId);
    } catch (error) {
      this.sending = false;
      if (this.pending !== pending) return; // стёрто, пока шла отправка
      if (refusedForGood(statusOf(error))) {
        this.pending = null;
        this.set("idle", { kind: "sendRefused", message: messageOf(error) });
      } else {
        this.set("unsent", { kind: "sendFailed", message: messageOf(error) });
      }
      return;
    }
    this.sending = false;
    if (this.pending !== pending) return;
    this.pending = null;
    this.set("idle", notice);
  }

  /**
   * Прекратить и стереть записанное — запись удаляют или согласие отозвано.
   * Удалённое по просьбе человека не должно дожить даже до повтора отправки.
   */
  async abandon(notice: RecorderNotice | null = null): Promise<void> {
    this.pending = null;
    if (this.view.phase === "live") {
      this.set("stopping", notice);
      await this.finish();
    }
    this.set("idle", notice);
  }

  /**
   * Состояние сервера, пришедшее опросом, пока здесь идёт запись.
   *
   * Своя запись узнаётся по моменту начала: ответ, отправленный ещё до
   * старта, приходит со старым состоянием («готово») и ничего не значит.
   * Остановила вторая сторона («готово» у ЭТОЙ записи) — останавливаемся и
   * досылаем записанное: сервер его ждёт. Удалили или отозвали согласие —
   * останавливаемся и стираем.
   *
   * Отвечает, пришлось ли что-то делать: экран перечитывает состояние
   * только тогда — иначе каждый ответ опроса порождал бы новый запрос.
   */
  async remote(status: string, startedAt: string | null | undefined): Promise<boolean> {
    if (this.view.phase !== "live" || status === "recording") return false;
    if (!sameMoment(this.startedAt, startedAt)) return false;
    if (status === "ready") await this.stop({ kind: "stoppedRemotely" });
    else await this.abandon({ kind: "withdrawn" });
    return true;
  }

  /**
   * Экран записи закрыт.
   *
   * Идущая запись останавливается и уходит на сервер: писать дальше без
   * индикатора на экране нельзя — человек напротив не видит, что его
   * пишут. Неотправленное остаётся в сессии (она переживает экран, см.
   * RecorderRegistry) и ждёт повтора, когда специалист вернётся.
   */
  async leave(): Promise<void> {
    this.away = true;
    if (this.view.phase === "live") await this.stop();
  }

  /** Экран записи снова открыт */
  attach(): void {
    this.away = false;
  }
}

/** То, что умеет окно: предупредить при уходе */
export interface BeforeUnloadLike {
  preventDefault(): void;
  returnValue: unknown;
}
export interface UnloadTarget {
  addEventListener(type: "beforeunload", listener: (event: BeforeUnloadLike) => void): void;
  removeEventListener(type: "beforeunload", listener: (event: BeforeUnloadLike) => void): void;
}

/**
 * Сессии записи по приёмам — дольше, чем живёт экран.
 *
 * Неотправленная запись не должна исчезать вместе с экраном: специалист
 * ушёл в карту пациента, вернулся — кнопка «Повторити відправлення» на
 * месте. И пока где-то есть неотправленное аудио, закрытие или
 * перезагрузка вкладки спрашивает подтверждения: аудио живёт только в её
 * памяти.
 */
export class RecorderRegistry {
  private readonly sessions = new Map<string, RecorderSession<MicStream>>();
  private guarded = false;

  constructor(private readonly target: UnloadTarget | null) {}

  session<S extends MicStream>(key: string, make: () => RecorderDeps<S>): RecorderSession<S> {
    const known = this.sessions.get(key);
    if (known) return known as unknown as RecorderSession<S>;
    const made = new RecorderSession<S>(make());
    made.subscribe(() => this.sync());
    this.sessions.set(key, made as unknown as RecorderSession<MicStream>);
    return made;
  }

  get unsent(): boolean {
    for (const s of this.sessions.values()) if (s.unsent) return true;
    return false;
  }

  private readonly guard = (event: BeforeUnloadLike): void => {
    event.preventDefault();
    // старые браузеры спрашивают только при непустом returnValue
    event.returnValue = "";
  };

  private sync(): void {
    const need = this.unsent;
    if (!this.target || need === this.guarded) return;
    if (need) this.target.addEventListener("beforeunload", this.guard);
    else this.target.removeEventListener("beforeunload", this.guard);
    this.guarded = need;
  }
}
