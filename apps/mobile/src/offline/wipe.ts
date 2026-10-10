import { leftAfterWipe, wipeLocalData } from "./device";
import { closeForWipe, ownerOfToken } from "./owner";
import { store } from "./store";

/**
 * Удалённое стирание как операция, которая переживает сбой и перезапуск.
 *
 * Было (внешний разбор, волна 15, п. 3 — P1): отметка устройства получала
 * команду, СНАЧАЛА подтверждала серверу «стёрто», потом чистила хранилище и
 * снимала токены. Хранилище, бросившее исключение посреди очистки, оставляло
 * на планшете и кэш обхода, и сессию, а сервер уже считал устройство стёртым
 * и команды больше не выдавал; в консоли стояло «стёрто». Прежний порядок
 * объяснялся тем, что после стирания устройство представится новым и
 * подтверждать будет нечем, — это правда, но решается она запоминанием, а не
 * ранним подтверждением.
 *
 * Порядок теперь такой:
 *   1. на устройство записывается след операции (установка и чья команда);
 *   2. хранилище чистится, и очистка ПРОВЕРЯЕТСЯ тем, что осталось;
 *   3. сессия снимается — даже если очистка не удалась: нашедший планшет не
 *      должен открыть отделение, пусть и без кэша;
 *   4. только после проверенной очистки — подтверждение серверу, токеном,
 *      запомненным до снятия сессии;
 *   5. след снимается, когда всё сделано.
 *
 * Сбой на любом шаге оставляет след, и следующий запуск (отметка устройства
 * зовётся первой) доводит операцию: очистку — без сети, подтверждение — когда
 * снова войдёт тот, чья была команда. Не записался и сам след (хранилище
 * отказало целиком) — держит второй рубеж: сервер подтверждения не получил и
 * выдаст команду снова при следующей отметке. Серверу не сообщается ничего,
 * чего не случилось.
 *
 * Без react-native и без клиента запросов — порядок проверяется тестом
 * (test/wipe.test.ts), а зависимости передаёт клиент (api/client.ts).
 */

/** След незавершённого стирания; wipeLocalData его не трогает */
export const WIPE_STATE_KEY = "wipe:state";

export interface WipeState {
  /** Установка, для которой пришла команда: после очистки устройство представится новым */
  deviceId: string;
  /** Чья была команда (sub токена): подтверждение уходит только от его имени */
  owner: string | null;
  /** Очистка проверена: кроме следа, на устройстве ничего */
  erased: boolean;
  /** Сессия снята */
  signedOut: boolean;
}

export interface WipeDeps {
  /** Токен, с которым сейчас ушёл бы запрос */
  token(): Promise<string | null>;
  clearTokens(): Promise<void>;
  /** POST /api/devices/wiped явно переданным токеном: хранилище к этому моменту уже пусто */
  confirm(deviceId: string, token: string): Promise<void>;
}

export interface WipeOutcome {
  erased: boolean;
  signedOut: boolean;
  /** Сервер принял подтверждение сейчас */
  confirmed: boolean;
}

function save(state: WipeState): void {
  try {
    store.write(WIPE_STATE_KEY, state);
  } catch {
    /* след не лёг — довода при запуске не будет; держит сервер, не получивший подтверждения */
  }
}

/**
 * Очистить и проверить.
 *
 * Проверка — по оставшемуся, а не по отсутствию исключения: нативное
 * хранилище глотает отказ удаления, и тихо уцелевшая запись выглядела бы
 * удачей (offline/device.ts, leftAfterWipe).
 */
function erase(): boolean {
  try {
    wipeLocalData([WIPE_STATE_KEY]);
    return leftAfterWipe([WIPE_STATE_KEY]).length === 0;
  } catch {
    return false;
  }
}

/**
 * Сервер говорит, что подтверждения не ждёт: команды для этой пары
 * «установка + учётная запись» нет (404) или запрос ему непонятен (400).
 * Повтор ответа не изменит — след снимается. Сеть, 401, 5xx — ждём.
 */
function notExpected(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 400;
}

async function advance(state: WipeState, confirmWith: string | null, deps: WipeDeps): Promise<WipeOutcome> {
  if (!state.erased) {
    state.erased = erase();
    save(state);
  }
  if (!state.signedOut) {
    try {
      await deps.clearTokens();
      state.signedOut = true;
    } catch {
      /* защищённое хранилище отказало — снимем при следующем запуске */
    }
    save(state);
  }

  let confirmed = false;
  let settled = false;
  if (state.erased && confirmWith) {
    try {
      await deps.confirm(state.deviceId, confirmWith);
      confirmed = true;
      settled = true;
    } catch (error) {
      settled = notExpected(error);
    }
  }
  if (state.erased && state.signedOut && settled) {
    try {
      store.remove(WIPE_STATE_KEY);
    } catch {
      /* останется — следующий запуск получит 404 на подтверждение и снимет */
    }
  }
  return { erased: state.erased, signedOut: state.signedOut, confirmed };
}

/*
 * Кому сказать, что сессию закрыло стирание (#125).
 *
 * Хранилище чистилось и токены снимались, а интерфейс об этом не знал:
 * пользователь оставался в состоянии React, экраны — с данными пациентов, и
 * так до перезапуска. Слушают корень приложения (вход, AuthContext) и стек
 * экранов (переход на вход, app/_layout.tsx).
 */
const wipedListeners = new Set<() => void>();

export function onWiped(listener: () => void): () => void {
  wipedListeners.add(listener);
  return () => {
    wipedListeners.delete(listener);
  };
}

/**
 * Исполнить команду стирания, полученную при отметке устройства `deviceId`.
 *
 * Команда — того, чья сессия сейчас в хранилище: сервер выдаёт её паре
 * «установка + учётная запись» (routes/devices.ts), и отметку делал он.
 *
 * Первым делом, ещё до очистки, офлайн-слой закрывается на запись — ответ,
 * запрошенный раньше команды и пришедший после неё, на устройство не ляжет
 * (owner.ts, closeForWipe), — и интерфейс закрывает сессию: показывать
 * экраны дальше, пока идут очистка и подтверждение, незачем.
 */
export async function carryOutWipe(deviceId: string, deps: WipeDeps): Promise<WipeOutcome> {
  closeForWipe();
  for (const listener of wipedListeners) {
    try {
      listener();
    } catch {
      /* интерфейс не смог — стирание от этого не зависит */
    }
  }
  const token = await deps.token().catch(() => null);
  const state: WipeState = { deviceId, owner: ownerOfToken(token), erased: false, signedOut: false };
  save(state);
  return advance(state, token, deps);
}

/**
 * Довести стирание, начатое прошлым запуском. `null` — доводить нечего.
 *
 * Сессия, которая сейчас в хранилище, снимается, только если прошлый раз её
 * снять не удалось; свежий вход после стирания — законный, его не трогаем.
 * Подтверждение уходит только токеном того, чья была команда: чужой вход на
 * том же планшете подтверждать её не вправе.
 */
export async function resumeWipe(deps: WipeDeps): Promise<WipeOutcome | null> {
  const state = store.read<WipeState>(WIPE_STATE_KEY);
  if (!state?.deviceId) return null;
  const token = await deps.token().catch(() => null);
  const confirmWith = token && ownerOfToken(token) === state.owner ? token : null;
  return advance(state, confirmWith, deps);
}
