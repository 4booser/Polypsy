import { ageAt, deviceTimeZone, evaluateSubmission, isTransientStatus, type Answer, type SurveyFull } from "@quizzy/shared";
import { ownerOfToken, tokenStore } from "../api";

/**
 * Несданные ответы веб-кабинета — ждут конца работ или появления сети.
 *
 * До режима обслуживания у веб-кабинета очереди не было вовсе: отказ сдачи
 * показывался всплывашкой, ответы жили в состоянии экрана, и закрытая
 * вкладка теряла их целиком. С режимом обслуживания это стало не редкостью,
 * а расписанием: на время работ сервер отвечает 503 на каждую сдачу.
 * Ответы — клинические данные, и потерять их из-за объявленных работ
 * нельзя.
 *
 * Устроено как очередь мобилки (apps/mobile/src/offline/queue.ts), и по тем
 * же правилам:
 *
 * - порядок сдачи сохраняется, отправка — по одной;
 * - временный отказ (нет сети, 502/503/504 — isTransientStatus)
 *   останавливает проход, следующая попытка начнёт с того же места;
 * - 401 — тоже не отказ по существу (#172): сессии нет или токен уже чужой.
 *   Запись не помечается и ждёт, когда владелец войдёт снова, — прежде она
 *   становилась отвергнутой навсегда, и после входа её не было чем отправить;
 * - сбой сервера (500 и прочие 5xx) — не приговор (#172): разовый 500 при
 *   досылке делал запись отвергнутой навсегда, хотя следующий проход её бы
 *   принял. Теперь попытка считается, проход останавливается, как при
 *   временном отказе, и запись уйдёт следующим проходом. Отвергнутой она
 *   становится, только если сервер падает на ней SERVER_FAILURES_MAX раз:
 *   битая сдача не должна ни держать очередь, ни крутиться вечно;
 * - отказ по существу (прочие 4xx) помечает запись и не блокирует остальных:
 *   битую сдачу нельзя ни потерять молча, ни повторять вечно. Решение по
 *   ней — человека: повторить или отказаться (кабинет, OutboxStrip);
 * - у каждой сдачи clientRequestId с ПЕРВОЙ попытки, и сервер узнаёт
 *   дубль, если первая попытка всё же успела записаться (504 от прокси
 *   приходит и тогда, когда приложение своё сделало).
 *
 * Хранится в localStorage, отдельной записью на человека. Не общей: за
 * одним компьютером входят разные люди, и чужая сдача не должна уйти под
 * чужим входом — очередь другого человека просто не читается. При выходе
 * она НЕ стирается: стереть — значит потерять ответы, которых больше нигде
 * нет; уходит она при следующем входе того же человека. Цена названа:
 * ответы лежат в браузере открытыми до отправки — ровно как черновик в
 * мобилке. Отправленное удаляется сразу.
 *
 * Отдельного ключа мало (#166): ключ выбирает человек на экране вкладки, а
 * токен в запросе — тот, что лежит в общем хранилище сейчас. Во второй
 * вкладке вошёл B — таймер первой отправлял очередь A с токеном B: ответы
 * ложились в карту B, а у A стирались как отправленные. Поэтому у записи
 * есть владелец, и перед каждой отправкой он сверяется с `sub` токена,
 * который уйдёт в запросе (как в мобилке, CR-088). Не совпал — проход
 * останавливается: запись не уходит, не стирается и не помечается
 * отказом, а ждёт своего владельца.
 */

export interface OutboxItem {
  id: string;
  /**
   * Чья сдача — `sub` токена, с которым её можно отправить (#166). У записей,
   * легших до появления поля, его нет: их владелец — тот, под чьим ключом
   * они лежат.
   */
  ownerId?: string;
  surveyId: string;
  /** Название методики — чтобы в кабинете было видно, чья сдача ждёт решения (у ранних записей нет) */
  title?: string;
  payload: Record<string, unknown> & { clientRequestId: string };
  queuedAt: string;
  attempts: number;
  /** Отказ по существу: ждёт решения человека, сам не уходит */
  rejectedReason?: string;
}

export type OutboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface FlushResult {
  sent: number;
  left: number;
  rejected: number;
}

const keyOf = (userId: string) => `quizzy.outbox.${userId}`;

/** Сколько раз сервер может упасть на одной сдаче, прежде чем она станет отвергнутой (#172) */
export const SERVER_FAILURES_MAX = 5;

/**
 * `tokenOwner` — владелец токена, который уйдёт в ближайшем запросе. Сверка
 * стоит вплотную к вызову `submit`, в том же синхронном шаге: запрос читает
 * токен из хранилища в первой же строке (api.ts, request), и между сверкой
 * и чтением чужой токен подложиться не успевает.
 */
export function createOutbox(storage: OutboxStorage, tokenOwner: () => string | null) {
  function read(userId: string): OutboxItem[] {
    try {
      const raw = storage.getItem(keyOf(userId));
      return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    } catch {
      return [];
    }
  }

  function write(userId: string, items: OutboxItem[]) {
    if (items.length) storage.setItem(keyOf(userId), JSON.stringify(items));
    else storage.removeItem(keyOf(userId));
  }

  let flushing = false;

  return {
    /** Положить сдачу ждать. Бросает, если хранилище недоступно: тогда ответы остаются на экране */
    enqueue(userId: string, surveyId: string, payload: Record<string, unknown>, title?: string): OutboxItem {
      const clientRequestId =
        typeof payload.clientRequestId === "string" ? payload.clientRequestId : crypto.randomUUID();
      const item: OutboxItem = {
        id: crypto.randomUUID(),
        ownerId: userId,
        surveyId,
        ...(title ? { title } : {}),
        payload: { ...payload, clientRequestId },
        queuedAt: new Date().toISOString(),
        attempts: 0,
      };
      write(userId, [...read(userId), item]);
      return item;
    },

    waiting(userId: string): OutboxItem[] {
      return read(userId).filter((i) => !i.rejectedReason);
    },

    rejected(userId: string): OutboxItem[] {
      return read(userId).filter((i) => !!i.rejectedReason);
    },

    /** Отправить ждущие по порядку; submit бросает ошибку со `status` */
    async flush(userId: string, submit: (item: OutboxItem) => Promise<unknown>): Promise<FlushResult> {
      const count = (): FlushResult => {
        const all = read(userId);
        return { sent: 0, left: all.filter((i) => !i.rejectedReason).length, rejected: all.filter((i) => !!i.rejectedReason).length };
      };
      if (flushing) return count();
      flushing = true;
      let sent = 0;
      try {
        for (const item of read(userId)) {
          if (item.rejectedReason) continue;
          // токен уже чужой — ни эта, ни следующие от его имени не уйдут; запись цела и ждёт владельца
          if ((item.ownerId ?? userId) !== tokenOwner()) break;
          try {
            await submit(item);
            write(userId, read(userId).filter((i) => i.id !== item.id));
            sent++;
          } catch (error) {
            const status = (error as { status?: number }).status ?? 0;
            if (isTransientStatus(status)) break;
            // сессии нет или она чужая — запись цела и ждёт входа владельца, как при чужом токене выше
            if (status === 401) break;
            const attempts = item.attempts + 1;
            const serverFailure = status >= 500 && attempts < SERVER_FAILURES_MAX;
            write(
              userId,
              read(userId).map((i) =>
                i.id !== item.id
                  ? i
                  : serverFailure
                    ? { ...i, attempts }
                    : { ...i, attempts, rejectedReason: error instanceof Error ? error.message : String(status) },
              ),
            );
            // сбой сервера останавливает проход, как временный отказ: следующий начнёт с этой же записи
            if (serverFailure) break;
          }
        }
      } finally {
        flushing = false;
      }
      return { ...count(), sent };
    },

    /** Вернуть отклонённую сдачу в очередь — решение человека, а не кода */
    retry(userId: string, id: string): void {
      write(
        userId,
        read(userId).map((i) => {
          if (i.id !== id) return i;
          const { rejectedReason: _dropped, ...rest } = i;
          return rest;
        }),
      );
    },

    /**
     * Отказаться от сдачи — тоже решение человека (#172): ответы стираются с
     * устройства и не уйдут никуда. Кабинет спрашивает подтверждение до вызова.
     */
    discard(userId: string, id: string): void {
      write(userId, read(userId).filter((i) => i.id !== id));
    },
  };
}

/** Память вместо хранилища: закрытое хранилище (приватный режим) не должно ронять кабинет */
function memoryStorage(): OutboxStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function browserStorage(): OutboxStorage {
  try {
    return typeof localStorage === "undefined" ? memoryStorage() : localStorage;
  } catch {
    return memoryStorage();
  }
}

/* владелец — тот, чей токен уйдёт в запросе: под входом «от имени» это тот, от чьего имени смотрят */
export const outbox = createOutbox(browserStorage(), () => ownerOfToken(tokenStore.get()));

/**
 * Памятка при сдаче, ушедшей в очередь: план безопасности показывается так
 * же, как после обычной сдачи, поднявшей риск.
 *
 * Риск решает тот же код, что на сервере, — evaluateSubmission из общего
 * пакета (packages/shared/src/risk.ts): критические варианты, числовые
 * пороги, ответы матрицы и полосы шкал, только по видимым ответам. Здесь
 * стояла своя проверка — по одному флагу варианта, — и без сети карточки не
 * было ровно у тех, у кого риск выражен порогом числового пункта или
 * тяжёлой полосой шкалы. Сервер решил бы то же самое, просто позже; а
 * человеку памятка нужна сейчас, а не после работ.
 *
 * Пол и возраст — того, кто вошёл: нормы шкал стратифицированы, и без них
 * T-балл не посчитается, а с ним не назначится и полоса.
 */
export function offlineSafetyPlan(
  survey: SurveyFull,
  answers: Answer[],
  me: { sex?: "male" | "female" | null; birthDate?: string | null } | null,
  now = new Date().toISOString(),
): string | null {
  if (!survey.safetyPlan) return null;
  /* день — по календарю устройства: пояса учреждения клиент не знает, окончательный возраст считает сервер */
  const respondent = { sex: me?.sex ?? null, age: ageAt(me?.birthDate ?? null, now, deviceTimeZone()) };
  return evaluateSubmission(survey, answers, respondent).risk.severity ? survey.safetyPlan : null;
}
