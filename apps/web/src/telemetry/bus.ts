/**
 * Провод от сетевого клиента (api.ts) к телеметрии (client.ts).
 *
 * Отдельным модулем без зависимостей, а не прямым импортом: телеметрия
 * берёт токен из api.ts, и прямой импорт в обратную сторону сделал бы круг,
 * который работает ровно до первой перестановки импортов. Пока телеметрия
 * не заведена (тесты, раннее падение до main.tsx), сбои просто никуда не
 * идут.
 */
export interface NetworkFailure {
  method: string;
  path: string;
  /** HTTP-код; 0 — до сервера не дошли */
  status: number;
}

let sink: ((f: NetworkFailure) => void) | null = null;

export function onNetworkFailure(fn: ((f: NetworkFailure) => void) | null): void {
  sink = fn;
}

/** Сообщить о сбое. Никогда не бросает: телеметрия не вправе ронять запрос */
export function noteNetworkFailure(f: NetworkFailure): void {
  try {
    sink?.(f);
  } catch {
    /* сбой учёта сбоя — не повод для второго сбоя */
  }
}
