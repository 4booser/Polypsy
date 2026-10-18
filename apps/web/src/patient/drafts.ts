/**
 * Черновик прохождения на этом устройстве — «Збережено на цьому пристрої».
 *
 * Каждый ответ ложится сюда сразу после выбора: закрытая вкладка, разряженный
 * ноутбук или «Вийти з методики» не стирают сделанного, и человек
 * продолжает с того же пункта (kit pt-runner-question, «Відповідь
 * зберігається одразу»). Черновик привязан к версии методики: обновили
 * методику — прежние ответы к новым пунктам не подставляются, начинается
 * заново.
 *
 * Хранится отдельной записью на человека: за одним компьютером входят разные
 * люди, и чужой черновик не читается. Но и не лежит (ревью волны 26): в
 * черновике ответы как есть, со словами человека в текстовых пунктах, а
 * компьютер в палате или ординаторской общий. Поэтому черновики живут, только
 * пока их хозяин внутри:
 *
 * - выход стирает черновики с устройства (auth.tsx, logout);
 * - сессию погасил сервер или вход не восстановился при открытии — тоже
 *   (auth.tsx: dropTabSession и старт);
 * - вошёл человек — черновики всех остальных стираются (forgetDrafts):
 *   прежнего, если он ушёл, не выйдя, и сессия закончилась без вкладки;
 * - черновик, к которому не возвращались DRAFT_TTL_MS, не продолжается и
 *   стирается при следующей записи или входе.
 *
 * Очередь несданных ответов (outbox.ts) при выходе не стирается, и это не
 * то же самое: там законченные сдачи, которых больше нигде нет, — в них
 * бывает и сигнал риска, а черновик сервер ещё не ждёт.
 *
 * Модуль маленький и без зависимостей намеренно: его зовёт вход (auth.tsx),
 * а он лежит в начальном куске консоли (test/bundle.test.ts).
 */
export interface RunnerDraft {
  surveyId: string;
  versionId: string | null;
  /** Название — для строки «почато» на «Моїх тестах» без загрузки методики */
  title?: string;
  /** Ответы по пунктам: id пункта → ответ в форме Answer (без телеметрии) */
  answers: Record<string, Record<string, unknown>>;
  /** Время на пункт, мс — из него считается достоверность */
  times: Record<string, number>;
  step: number;
  /** Сколько пунктов было видно и сколько отвечено — для полосы «почато» */
  total: number;
  answered: number;
  startedAt: string;
  savedAt: string;
}

/**
 * Сколько черновик ждёт возвращения: неделя от последнего ответа.
 *
 * Столько же по умолчанию живёт назначение (семь календарных дней), а
 * рамка ответа у методик кабинета — «за останні 2 тижні»: ответы недельной
 * давности ещё про то же время, а продолжение через месяц смешало бы два
 * разных состояния в одном протоколе.
 */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIX = "quizzy.drafts.";
const draftsKey = (userId: string) => `${PREFIX}${userId}`;

/** Что нужно хранилищу черновиков одного человека */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Обойти все ключи — для чистки по всем людям (forgetDrafts) */
export type DeviceStorage = DraftStorage & Pick<Storage, "key" | "length">;

/** Ещё не просрочен: сохранён меньше DRAFT_TTL_MS назад (неразборчивое время — просрочен) */
function fresh(draft: RunnerDraft, now: number): boolean {
  const at = Date.parse(draft?.savedAt ?? "");
  return Number.isFinite(at) && now - at < DRAFT_TTL_MS;
}

/** Черновики одного человека, только живые; испорченная запись — пустая */
function readFresh(storage: DraftStorage, key: string, now: number): Record<string, RunnerDraft> {
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as Record<string, RunnerDraft>) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, d]) => fresh(d, now)));
  } catch {
    return {};
  }
}

function writeAll(storage: DraftStorage, key: string, all: Record<string, RunnerDraft>): void {
  if (Object.keys(all).length) storage.setItem(key, JSON.stringify(all));
  else storage.removeItem(key);
}

/**
 * Хранилище черновиков. `storage` — само хранилище или способ его достать:
 * браузерное берётся в момент вызова, а не загрузки модуля.
 */
export function createDrafts(storage: DraftStorage | (() => DraftStorage), now: () => number = Date.now) {
  const store = typeof storage === "function" ? storage : () => storage;
  const readAll = (userId: string) => readFresh(store(), draftsKey(userId), now());

  return {
    /** Черновик методики — только живой */
    get(userId: string, surveyId: string): RunnerDraft | null {
      return readAll(userId)[surveyId] ?? null;
    },

    list(userId: string): RunnerDraft[] {
      return Object.values(readAll(userId)).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },

    /** Записать черновик (просроченные при этом уходят); false — хранилище недоступно (приватный режим, переполнено) */
    save(userId: string, draft: RunnerDraft): boolean {
      try {
        writeAll(store(), draftsKey(userId), { ...readAll(userId), [draft.surveyId]: draft });
        return true;
      } catch {
        return false;
      }
    },

    drop(userId: string, surveyId: string): void {
      const all = readAll(userId);
      if (!(surveyId in all)) return;
      delete all[surveyId];
      try {
        writeAll(store(), draftsKey(userId), all);
      } catch {
        /* не записалось — черновик останется и будет перезаписан следующей сдачей */
      }
    },
  };
}

/** Память вместо хранилища: закрытое хранилище (приватный режим) не должно ронять кабинет */
function memoryStorage(): DeviceStorage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const memory = memoryStorage();

/** Хранилище браузера в момент вызова; закрыто или его нет — память вкладки */
function deviceStorage(): DeviceStorage {
  try {
    return typeof localStorage === "undefined" ? memory : localStorage;
  } catch {
    return memory;
  }
}

export const drafts = createDrafts(deviceStorage);

/**
 * Стереть с устройства черновики всех, кроме `keep`, а у него — просроченные.
 * `keep` — null: внутри никого, стереть все.
 *
 * Зовёт вход (auth.tsx): выход, конец сессии, вход другого человека. Порядок
 * «собрать, потом стереть»: removeItem сдвигает номера ключей.
 */
export function forgetDrafts(keep: string | null, storage: DeviceStorage = deviceStorage(), now = Date.now()): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      if (keep !== null && key === draftsKey(keep)) writeAll(storage, key, readFresh(storage, key, now));
      else storage.removeItem(key);
    }
  } catch {
    /* хранилище недоступно — черновиков в нём и нет */
  }
}
