/**
 * Связь с сервером — одно состояние на вкладку.
 *
 * Внешний разбор (волна 13): «в веб-консоли отсутствовало понятное
 * восстановление после потери связи». Так и было: каждый экран узнавал об
 * обрыве сам, по своему отказу, и сам же предлагал «повторить»; вернулась
 * связь — экран об этом не узнавал, пока человек не нажмёт кнопку или не
 * перезагрузит страницу. Специалист со слабым Wi-Fi в кабинете видел полосу
 * «нет связи» над картой, которая давно могла бы обновиться сама.
 *
 * Теперь знание одно. Сетевой клиент (api.ts) сообщает сюда о каждом
 * запросе, не дошедшем до сервера, и о каждом ответе; браузер — о своих
 * событиях online/offline. Пока связи нет, отсюда же раз в несколько секунд
 * уходит лёгкая проверка — и как только сервер ответил, состояние
 * меняется, а слой загрузки (query.ts) перечитывает всё, что на экране.
 *
 * Модуль без React и без TanStack: его зовёт api.ts, а тот не должен
 * тянуть за собой слой загрузки (круг импортов, который работает до первой
 * перестановки). Подключение к TanStack — в query.ts, строка на экране —
 * ui/ConnectionLine.tsx.
 */

export interface ConnectionState {
  online: boolean;
  /** Когда связь пропала — для строки «немає зв’язку з 14:32»; null — связь есть */
  lostAt: number | null;
  /** Когда связь вернулась — строка «відновлено» держится несколько секунд; null — не было обрыва */
  restoredAt: number | null;
}

/*
 * Проверка — публичное состояние службы: без входа (обрыв мог случиться и
 * на экране входа), лёгкое и уже спрашиваемое баннером работ. Отдельного
 * «пинга» сервер не заводит: адрес, который существует только ради
 * проверки, рано или поздно перестают поддерживать.
 */
const PROBE_URL = "/api/status";

/*
 * Пауза между проверками растёт до полуминуты: сервер после перезапуска не
 * должен получить разом сотню проверок от всех открытых вкладок, а человек,
 * которому надо сейчас, нажмёт «перевірити зараз».
 */
const DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
let delays = DELAYS_MS;

type Probe = () => Promise<boolean>;

/**
 * Ответил ли сервер. Любой ответ — да, даже отказ: до приложения дошли.
 * Кроме отказа шлюза (502/504): ответил прокси, а приложение за ним лежит
 * или перезапускается — связи с сервером ещё нет.
 */
export function serverAnswered(status: number): boolean {
  return status !== 502 && status !== 504;
}

const defaultProbe: Probe = async () => {
  try {
    const res = await fetch(PROBE_URL, { cache: "no-store", headers: { Accept: "application/json" } });
    return serverAnswered(res.status);
  } catch {
    return false;
  }
};

let state: ConnectionState = { online: true, lostAt: null, restoredAt: null };
const listeners = new Set<() => void>();
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let probing: Promise<boolean> | null = null;
let probe: Probe = defaultProbe;
let now: () => number = () => Date.now();

function emit(next: ConnectionState): void {
  state = next;
  for (const l of listeners) l();
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function scheduleProbe(): void {
  clearTimer();
  if (state.online) return;
  const delay = delays[Math.min(attempt, delays.length - 1)]!;
  timer = setTimeout(() => void check(), delay);
}

/** Проверить связь сейчас. Ответ — есть ли она; параллельные вызовы делят одну проверку */
function check(): Promise<boolean> {
  probing ??= probe()
    .catch(() => false)
    .then((ok) => {
      if (ok) connection.reached();
      else if (!state.online) {
        attempt += 1;
        scheduleProbe();
      }
      return ok;
    })
    .finally(() => {
      probing = null;
    });
  return probing;
}

export const connection = {
  get(): ConnectionState {
    return state;
  },

  isOnline(): boolean {
    return state.online;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Запрос не дошёл до сервера (fetch бросил не от отмены) или браузер сказал «offline» */
  lost(): void {
    if (!state.online) return;
    attempt = 0;
    emit({ online: false, lostAt: now(), restoredAt: null });
    scheduleProbe();
  },

  /** Сервер ответил — чем угодно, кроме отказа шлюза: значит, связь есть */
  reached(): void {
    if (state.online) return;
    clearTimer();
    attempt = 0;
    emit({ online: true, lostAt: null, restoredAt: now() });
  },

  /** «Перевірити зараз» и возврат на вкладку: не ждать очередной паузы */
  check,

  /**
   * События браузера. Возвращает отписку.
   *
   * «offline» — сразу обрыв: ждать отказа запроса незачем, браузер знает
   * точно. «online» — только повод проверить: сеть вернулась, но сервер за
   * ней может и не отвечать (VPN ещё поднимается, сервер перезапускают).
   * Возврат на вкладку — тоже повод: таймер в скрытой вкладке браузер
   * притормаживает, и человек, вернувшийся к консоли, не должен ждать
   * полминуты до очередной проверки.
   */
  install(): () => void {
    if (typeof window === "undefined") return () => {};
    const onOffline = () => connection.lost();
    const onOnline = () => {
      if (!state.online) void check();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && !state.online) void check();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  },

  /** Только для тестов: подменить проверку, паузы и часы, вернуть «связь есть» и сказать об этом подписчикам */
  resetForTest(options: { probe?: Probe; now?: () => number; delays?: number[] } = {}): void {
    clearTimer();
    probing = null;
    attempt = 0;
    probe = options.probe ?? defaultProbe;
    now = options.now ?? (() => Date.now());
    delays = options.delays ?? DELAYS_MS;
    emit({ online: true, lostAt: null, restoredAt: null });
  },
};
