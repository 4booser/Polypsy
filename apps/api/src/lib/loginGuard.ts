import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import { durable } from "../db/context";
import { loginAttempts } from "../db/schema";

/**
 * Защита входа от перебора.
 *
 * Порог по email, а не по IP: за NAT госпиталя все с одного адреса, и лимит по
 * IP запирал бы целое отделение из-за одного забывчивого. Против распределённого
 * перебора одного аккаунта email-ключ работает как надо.
 */
const WINDOW_MINUTES = 15;
const MAX_FAILURES = 5;

export async function isLockedOut(email: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), gte(loginAttempts.at, since)));
  return Number(row?.n ?? 0) >= MAX_FAILURES;
}

/**
 * Все адреса, запертые прямо сейчас, — для сводки учёток техпанели (волна 11).
 *
 * Здесь, рядом с isLockedOut, а не счётом в маршруте: окно и порог — одно
 * правило, и «заперто» на графике обязано значить ровно то же, что отказ на
 * входе. Таблица попыток открыта одной системе (миграция 0075) — зовут под
 * asSystem.
 */
export async function lockedEmails(): Promise<Set<string>> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const rows = await db
    .select({ email: loginAttempts.email })
    .from(loginAttempts)
    .where(gte(loginAttempts.at, since))
    .groupBy(loginAttempts.email)
    .having(sql`count(*) >= ${MAX_FAILURES}`);
  return new Set(rows.map((r) => r.email));
}

/**
 * Запертые адреса с подробностями — для строк и «Потребує уваги» реестра
 * (Polypsy 2.0): сколько неудач в окне и когда вход откроется сам.
 *
 * Правило то же, что у isLockedOut: заперт, пока в окне не меньше порога
 * неудач. Откроется, когда из окна выйдет (n − порог + 1)-я с конца попытка
 * — с этого мига в окне останется на одну меньше порога. Ключ — адрес в
 * нижнем регистре, как его сверяет сводка (accountState). Под asSystem, как
 * и lockedEmails.
 */
export async function lockStates(now = Date.now()): Promise<Map<string, { failures: number; until: string }>> {
  const since = new Date(now - WINDOW_MINUTES * 60_000).toISOString();
  const rows = await db
    .select({ email: loginAttempts.email, at: loginAttempts.at })
    .from(loginAttempts)
    .where(gte(loginAttempts.at, since));
  const byEmail = new Map<string, number[]>();
  for (const r of rows) {
    const key = r.email.toLowerCase();
    const list = byEmail.get(key) ?? [];
    list.push(new Date(r.at).getTime());
    byEmail.set(key, list);
  }
  const out = new Map<string, { failures: number; until: string }>();
  for (const [email, times] of byEmail) {
    if (times.length < MAX_FAILURES) continue;
    times.sort((a, b) => a - b);
    const pivot = times[times.length - MAX_FAILURES]!;
    out.set(email, { failures: times.length, until: new Date(pivot + WINDOW_MINUTES * 60_000).toISOString() });
  }
  return out;
}

/*
 * Отметка неудачи обязана пережить откат запроса (db/context.ts, durable).
 *
 * Вход и второй шаг пишут её в системной транзакции и отказывают снаружи —
 * там откатывать нечему. Но выключение второго фактора (routes/secondFactor.ts,
 * POST /disable) идёт внутри транзакции запроса, и с тех пор как неудачный
 * ответ её честно откатывает (волна 12), отметка уходила бы вместе с отказом:
 * перебор пароля и кода через «выключить фактор» перестал бы считаться.
 * Идентификатор строки выбирается один раз — повтор после отката пишет ту
 * же самую строку, а не вторую.
 */
export async function recordFailure(email: string, ip: string | null): Promise<void> {
  const id = crypto.randomUUID();
  await durable(() => db.insert(loginAttempts).values({ id, email, ip }));
}

/** Успешный вход сбрасывает счётчик — иначе легальный пользователь копит хвост */
export async function clearFailures(email: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
}
