import { and, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { uiText, type ClinicalTrace, type ClinicalTraceKey, type Lang, type UiKey } from "@quizzy/shared";
import { db } from "../db";
import { auditLog, refreshTokens, users } from "../db/schema";

/**
 * Учётные записи в техпанели: след, сессии, выключение, временный пароль.
 *
 * Отдельным модулем, а не внутри маршрута: «что держит учётку от удаления»
 * спрашивают и список (чтобы экран честно показал, можно ли удалять), и само
 * удаление (чтобы отказать). Два списка источников в двух местах разошлись бы
 * на первой же новой таблице — и разошлись бы в опасную сторону: список
 * показал бы «можно», удаление унесло бы каскадом чьи-то прохождения.
 */

/* ─────────── последний вход ─────────── */

/**
 * Не чаще раза в пять минут.
 *
 * Отметка пишется на входе и на обмене refresh, а тот случается раз в
 * полчаса работы. Прореживание — страховка от клиента, который меняет пару
 * чаще, чем нужно (две вкладки, поломанный таймер): строка users читается
 * на каждом запросе всей консоли, и превращать её в точку записи незачем.
 */
export const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/**
 * Отметить, что человек был в системе.
 *
 * Условие — в самом UPDATE, а не проверкой прочитанного: две вкладки,
 * обменявшие пару в одну секунду, иначе обе прошли бы проверку и обе
 * записали. Время — часами приложения, как и всё, что сравнивается с
 * отметками в токенах (см. миграцию 0074 про расхождение часов).
 */
export async function touchLastSeen(userId: string): Promise<void> {
  const now = Date.now();
  await db
    .update(users)
    .set({ lastSeenAt: new Date(now).toISOString() })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.lastSeenAt), lt(users.lastSeenAt, new Date(now - LAST_SEEN_THROTTLE_MS).toISOString())),
      ),
    );
}

/* ─────────── временный пароль ─────────── */

/*
 * Алфавит без знаков, которые путают на слух и на глаз: 0/O, 1/l/I. Пароль
 * диктуют по телефону и переписывают с экрана — «это ноль или буква?»
 * стоит одной неудачной попытки входа из пяти до блокировки.
 */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Временный пароль: четыре группы по четыре знака через дефис.
 *
 * 16 знаков из 56 — около 93 бит, с запасом больше, чем требует смена пароля
 * (changePasswordSchema, от 10 знаков). Группы — для человека: так пароль
 * читают вслух и сверяют глазами.
 *
 * Отбор с отбраковкой, а не остаток от деления: 256 на 56 не делится, и
 * первые знаки алфавита выпадали бы чаще остальных.
 */
export function generateTempPassword(): string {
  const out: string[] = [];
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  while (out.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const b of bytes) {
      if (b >= limit) continue;
      out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]!);
      if (out.length === 16) break;
    }
  }
  return [0, 4, 8, 12].map((i) => out.slice(i, i + 4).join("")).join("-");
}

/* ─────────── клинический след ─────────── */

/**
 * Источники следа: таблица, чем считать строку и какие колонки указывают на
 * человека.
 *
 * Список шире, чем «прохождения, заключения, записи приёма, случаи,
 * методики» из постановки: всё, что уходит вместе с учётной записью каскадом
 * (согласия, приёмы, переписка, учёт) или остаётся без автора, — это
 * документы о живом человеке, и удаление одной кнопкой не должно их уносить.
 * Внешние ключи RESTRICT — последняя защита, а не первая: каскадные ключи
 * ничего не защищают вовсе, и половина источников ниже именно каскадные.
 *
 * Заключение считается и по автору, и по прохождению обследуемого: у
 * заключения нет своей ссылки на пациента, она идёт через прохождение.
 */
interface TraceSource {
  key: ClinicalTraceKey;
  table: string;
  /** Выражение, отличающее строку: у согласия и учёта своего id нет */
  row: string;
  columns: string[];
  /** Дополнительный путь к человеку, если прямой колонки нет */
  via?: string;
}

const TRACE_SOURCES: TraceSource[] = [
  { key: "responses", table: "responses", row: "id", columns: ["user_id"] },
  {
    key: "conclusions",
    table: "conclusions",
    row: "id",
    columns: ["created_by", "signed_by"],
    via: "select c.id as rid, r.user_id as uid from conclusions c join responses r on r.id = c.response_id where r.user_id in",
  },
  { key: "notes", table: "patient_notes", row: "id", columns: ["user_id", "created_by", "signed_by"] },
  { key: "cases", table: "alert_cases", row: "id", columns: ["user_id"] },
  { key: "surveys", table: "surveys", row: "id", columns: ["created_by"] },
  { key: "referrals", table: "referrals", row: "id", columns: ["user_id", "created_by"] },
  { key: "appointments", table: "appointments", row: "id", columns: ["patient_id", "specialist_id"] },
  { key: "episodes", table: "episodes", row: "id", columns: ["patient_id"] },
  { key: "safetyPlans", table: "safety_plans", row: "id", columns: ["user_id", "created_by"] },
  { key: "recordings", table: "visit_recordings", row: "id", columns: ["patient_id", "specialist_id"] },
  { key: "consents", table: "consents", row: "consent_text_id", columns: ["user_id"] },
  { key: "threads", table: "threads", row: "id", columns: ["patient_id", "specialist_id"] },
  { key: "dispensary", table: "dispensary", row: "patient_id", columns: ["patient_id"] },
];

export const TRACE_KEYS: readonly ClinicalTraceKey[] = TRACE_SOURCES.map((s) => s.key);

export function emptyTrace(): ClinicalTrace {
  return Object.fromEntries(TRACE_KEYS.map((k) => [k, 0])) as unknown as ClinicalTrace;
}

/** Список идентификаторов параметрами, а не склейкой строки */
function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * След по каждому из людей — числом по каждому источнику.
 *
 * Один запрос на источник, а не на человека: страница списка — до сотни
 * учёток, и тринадцать запросов на страницу дешевле тысячи трёхсот.
 * Строка, где человек стоит в двух колонках сразу (сам себе автор записи),
 * считается один раз — count(distinct).
 *
 * Имена таблиц и колонок — константы модуля, а не ввод: sql.raw здесь не
 * открывает инъекции, а идентификаторы людей уходят параметрами.
 */
export async function clinicalTraceOf(ids: string[]): Promise<Map<string, ClinicalTrace>> {
  const out = new Map<string, ClinicalTrace>(ids.map((id) => [id, emptyTrace()]));
  if (!ids.length) return out;
  const list = idList(ids);

  for (const source of TRACE_SOURCES) {
    const parts = source.columns.map(
      (col) =>
        sql`select ${sql.raw(source.row)}::text as rid, ${sql.raw(col)} as uid from ${sql.raw(source.table)} where ${sql.raw(col)} in (${list})`,
    );
    if (source.via) parts.push(sql`${sql.raw(source.via)} (${list})`);
    const rows = await db.execute<{ uid: string; n: number }>(
      sql`select uid, count(distinct rid)::int as n from (${sql.join(parts, sql` union all `)}) s group by uid`,
    );
    for (const r of rows) {
      const trace = out.get(r.uid);
      if (trace) trace[source.key] = Number(r.n);
    }
  }
  return out;
}

/**
 * Сколько записей журнала сделано от имени человека.
 *
 * Журнал держит actor_id под RESTRICT и включает его в хэш строки: удалить
 * учётку, у которой есть хоть одна такая запись, нельзя, не переписав журнал.
 * Поэтому это число стоит рядом с клиническим следом, а не отдельно:
 * «видалити» для учётки, которая хоть раз входила, — не вариант, и экран
 * должен знать это заранее, а не узнавать из отказа базы.
 */
export async function journalEntriesOf(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: auditLog.actorId, n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(inArray(auditLog.actorId, ids))
    .groupBy(auditLog.actorId);
  for (const r of rows) if (r.id) out.set(r.id, Number(r.n));
  return out;
}

/** Что держит учётку: ненулевые источники следа и журнал — в порядке TRACE_KEYS */
export function holdsOf(trace: ClinicalTrace, journal: number): { key: ClinicalTraceKey | "journal"; count: number }[] {
  const holds: { key: ClinicalTraceKey | "journal"; count: number }[] = TRACE_KEYS.filter((k) => trace[k] > 0).map(
    (k) => ({ key: k, count: trace[k] }),
  );
  if (journal > 0) holds.push({ key: "journal", count: journal });
  return holds;
}

/**
 * Перечень «что держит» словами — для текста отказа.
 *
 * Слова берутся из словаря оболочки (ops.hold.*), а не пишутся здесь: те же
 * подписи стоят на экране техпанели, и два перевода одного «проходження»
 * разошлись бы. Отказ читает и мобильное приложение, у которого своего
 * экрана для этого нет, — поэтому текст полный, а не код.
 */
export function holdsText(holds: { key: ClinicalTraceKey | "journal"; count: number }[], lang: Lang): string {
  return holds.map((h) => `${uiText(`ops.hold.${h.key}` as UiKey, lang)}: ${h.count}`).join(", ");
}

/* ─────────── сессии ─────────── */

/**
 * Живая сессия — семья, в которой есть неотозванный, непогашенный и
 * неистёкший токен. Условие одно на список сессий и на счётчик в списке
 * учёток: иначе «2 сесії» в строке и одна строка во вкладке «Сесії»
 * расходились бы на глазах.
 */
export function liveTokenCondition(): SQL {
  return and(
    isNull(refreshTokens.revokedAt),
    isNull(refreshTokens.rotatedAt),
    gt(refreshTokens.expiresAt, new Date().toISOString()),
  )!;
}

export async function sessionCountsOf(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: refreshTokens.userId, n: sql<number>`count(distinct ${refreshTokens.familyId})::int` })
    .from(refreshTokens)
    .where(and(inArray(refreshTokens.userId, ids), liveTokenCondition()))
    .groupBy(refreshTokens.userId);
  for (const r of rows) out.set(r.id, Number(r.n));
  return out;
}

/* ─────────── последний суперадминистратор ─────────── */

/**
 * Останется ли после действия хоть один действующий суперадминистратор.
 *
 * Под транзакционным замком: два суперадмина, выключающие друг друга в одну
 * секунду, иначе оба увидели бы «есть ещё один» и оба выключили бы — и
 * системой стало бы некому управлять. Проигравший ждёт коммита победителя и
 * пересчитывает уже по свежему снимку (READ COMMITTED берёт новый снимок на
 * каждый оператор). Замок живёт до конца транзакции запроса — ровно столько,
 * сколько нужно, чтобы изменение успело стать видимым.
 */
export async function otherActiveSuperadmins(exceptId: string): Promise<number> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('ops:superadmins'))`);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "superadmin"), isNull(users.disabledAt), ne(users.id, exceptId)));
  return Number(row?.n ?? 0);
}
