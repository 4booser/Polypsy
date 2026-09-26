/**
 * Сессия на устройстве: когда продлевать токен и как отзывать его при выходе.
 *
 * Без react-native и без клиента запросов — оба решения проверяются тестом.
 */

/*
 * Маршруты, где 401 значит «неверные учётные данные», а не «истёк access».
 *
 * Клиент исключал из продления весь `/api/auth/*` — вместе с защищёнными
 * `/api/auth/me` и `/api/auth/me/reveal`. Восстановление сессии при запуске
 * спрашивает именно `/api/auth/me`: access к тому времени обычно истёк,
 * продлевать его клиент отказывался, и запуск стирал сессию, хотя refresh
 * был жив, — человека выкидывало на вход каждое утро.
 *
 * Продлевать нельзя только там, где токен и выдаётся или гасится: вход,
 * второй шаг входа, регистрация, обмен кода Google, сам обмен refresh и
 * выход. Там 401 — ответ по существу, и повтор с новым токеном его не
 * изменит (а обмен refresh, продлевающий сам себя, зациклился бы).
 */
const CREDENTIAL_ROUTES = [
  "/api/auth/login",
  "/api/auth/mfa/",
  "/api/auth/register",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/auth/google/exchange",
  "/api/auth/google/callback",
];

export function refreshOnUnauthorized(path: string): boolean {
  const bare = path.split("?")[0]!;
  return !CREDENTIAL_ROUTES.some((route) =>
    route.endsWith("/") ? bare.startsWith(route) : bare === route || bare.startsWith(`${route}/`),
  );
}

/**
 * Выход отзывает сессию на сервере.
 *
 * Раньше выход только стирал токены на устройстве и отвязывал пуш: refresh
 * оставался действующим на сервере до конца своего срока. Для телефона,
 * который потеряли или с которого токен могли скопировать, это окно, в
 * котором учётная запись открыта чужому.
 *
 * Выход при этом не ждёт отзыва: человек нажал «вийти» и должен выйти, в
 * подвале без связи тоже. Поэтому порядок такой: токены стираются сразу, а
 * refresh кладётся в короткий список «отозвать» и уходит на сервер
 * немедленно или при первой связи (прогон при старте и при
 * возвращении приложения). Список хранит только то, что уже нельзя
 * использовать для входа из приложения: оно само его не читает ни для чего,
 * кроме отзыва. Сервер отверг (4xx: токен и так недействителен) — запись
 * снимается; сети нет или сервер лежит (0, 5xx) — ждёт следующей попытки.
 */
export interface RevokeStore {
  get(): Promise<string[]>;
  set(tokens: string[]): Promise<void>;
}

/** Сколько неотозванных держать: выходов без сети подряд больше не бывает, а место в защищённом хранилище мало */
export const REVOKE_CAP = 5;

export async function queueRevocation(store: RevokeStore, refreshToken: string): Promise<void> {
  const list = (await store.get()).filter((t) => t !== refreshToken);
  list.push(refreshToken);
  await store.set(list.slice(-REVOKE_CAP));
}

export async function flushRevocations(
  store: RevokeStore,
  revoke: (refreshToken: string) => Promise<void>,
): Promise<number> {
  const processed = new Set<string>();
  for (const token of await store.get()) {
    try {
      await revoke(token);
    } catch (error) {
      const status = (error as { status?: number } | null)?.status ?? 0;
      // связи нет или сервер лежит — остальные тоже не уйдут; ждут следующей попытки
      if (status === 0 || status >= 500) break;
      // 4xx: сервер этот токен уже не знает — отзывать нечего
    }
    processed.add(token);
  }
  if (processed.size) {
    /*
     * Перечитывается, а не пишется список, прочитанный в начале: пока шли
     * запросы, мог выйти ещё кто-то, и его токен затёрся бы.
     */
    const now = await store.get();
    await store.set(now.filter((t) => !processed.has(t)));
  }
  return processed.size;
}
