import { eq, isNotNull, sql } from "drizzle-orm";
import type {
  AccountState,
  GrantStats,
  OpsSessionsSummary,
  OpsUsersRoleSummary,
  OpsUsersSummary,
  Role,
  SessionAgeBucket,
  SuspiciousRule,
  SuspiciousStats,
} from "@quizzy/shared";
import { db } from "../db";
import { refreshTokens, userSecondFactor, users } from "../db/schema";
import { env } from "../env";
import { liveTokenCondition } from "./accounts";
import { lockedEmails } from "./loginGuard";
import { SMALL_CELL_FLOOR, suppress, suppressedKeys } from "./privacy";

/**
 * Числа для графиков разделов людей техпанели (волна 11, участок people):
 * «Користувачі», «Сесії», «Підозріла активність», «Тимчасові доступи».
 *
 * Решение заказчика 2026-09-26: «должны быть графики в админ панеле». Списки
 * этих разделов постраничные и с отбором — собрать форму данных из того,
 * что приходит экрану, нельзя: «входы по дням» не лежат ни в одной странице
 * реестра. Поэтому здесь агрегаты, и наружу — только числа: ни почты, ни
 * имени, ни идентификатора.
 *
 * ═══ Где порог малых чисел, а где нет ═══
 *
 * То же разделение, что у отчётов «Дані й продукт» (lib/opsData.ts): порог
 * стоит там, где число — это ЛЮДИ-ПАЦИЕНТЫ (учётки пациентов по состоянию,
 * новые пациенты за неделю, сессии пациентов). Не стоит там, где число —
 * персонал (его список с именами открыт тому же праву на соседней вкладке,
 * и прятать от заведующего, что суперадминов трое, значило бы охранять не
 * то) или события (входы, срабатывания правил, выдачи доступов).
 *
 * Где рядом с частями печатается целое, скрытая часть восстановима
 * вычитанием — поэтому части пациентов идут через suppressedKeys
 * (дополняющее подавление), а не через suppress поштучно. И поэтому у
 * сессий нет «всего»: персонал печатается числом, и «всего» минус персонал
 * назвало бы скрытое у пациентов.
 *
 * Все функции только читают и зовутся под asSystem: числа техпанели — про
 * всю систему, а попытки входа и второй фактор политики строк открывают
 * одной системе (миграции 0075 и 0094). Без системной роли «заперто: 0» у
 * заведующего с users.manage значило бы «не вижу», а не «нет».
 */

/** Окна рядов — постоянные: сравнивают неделю с неделей, а не окно с окном */
export const LOGIN_DAYS = 30;
export const NEW_WEEKS = 12;
export const FINDING_DAYS = 30;
export const GRANT_WEEKS = 12;

const ROLES: readonly Role[] = ["superadmin", "admin", "user"];
export const ACCOUNT_STATES: readonly AccountState[] = ["active", "never", "locked", "disabled"];
export const AGE_BUCKETS: readonly SessionAgeBucket[] = ["day", "week", "month", "older"];

/*
 * Дни и недели — по часам учреждения, как у остальных рядов техпанели:
 * «вход в 00:30 по Киеву» принадлежит сегодняшнему дню, а не вчерашнему по
 * Гринвичу. Свои копии, а не импорт из lib/opsData.ts: там они закрыты
 * модулем, а открывать чужой модуль ради четырёх строк SQL незачем.
 */
const today = () => sql`(now() at time zone ${env.institutionTz})::date`;
const windowStart = (days: number) =>
  sql`((${today()} - ${days - 1}::int)::timestamp at time zone ${env.institutionTz})`;
const daySeries = (days: number) =>
  sql`select d::date as day from generate_series(${today()} - ${days - 1}::int, ${today()}, interval '1 day') d`;
const thisWeek = () => sql`date_trunc('week', ${today()})::date`;
const weekSeries = (weeks: number) =>
  sql`select d::date as week from generate_series(${thisWeek()} - ${(weeks - 1) * 7}::int, ${thisWeek()}, interval '7 days') d`;
const weekStart = (weeks: number) =>
  sql`((${thisWeek()} - ${(weeks - 1) * 7}::int)::timestamp at time zone ${env.institutionTz})`;
const localDay = (column: string) => sql`(${sql.raw(column)} at time zone ${env.institutionTz})::date`;
const localWeek = (column: string) => sql`date_trunc('week', ${sql.raw(column)} at time zone ${env.institutionTz})::date`;

const rowsOf = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
  [...(await db.execute<T & Record<string, unknown>>(query))] as T[];

/* ─────────────────────── чистые правила ─────────────────────── */

/**
 * Состояние учётки — одно, по старшинству (см. AccountState): выключенная
 * остаётся выключенной, даже если её сейчас кто-то перебирает, а запертая
 * перебором — запертой, даже если в неё ни разу не входили. Иначе части
 * полосы не сложились бы в число учёток.
 */
export function accountState(
  u: { email: string; disabledAt: string | null; lastSeenAt: string | null },
  locked: ReadonlySet<string>,
): AccountState {
  if (u.disabledAt) return "disabled";
  if (locked.has(u.email.toLowerCase())) return "locked";
  if (!u.lastSeenAt) return "never";
  return "active";
}

export interface RoleTally {
  total: number;
  states: Record<AccountState, number>;
  mfaEnabled: number;
  mfaTotal: number;
}

export const emptyTally = (): RoleTally => ({
  total: 0,
  states: { active: 0, never: 0, locked: 0, disabled: 0 },
  mfaEnabled: 0,
  mfaTotal: 0,
});

/**
 * Части целого через порог: целое — suppress, части — suppressedKeys.
 *
 * Скрыто целое — скрыто всё: части без целого складывались бы в него
 * обратно. Показано целое — одна скрытая часть восстановилась бы вычитанием,
 * и suppressedKeys прячет рядом с ней вторую (lib/privacy.ts).
 */
export function hiddenParts<K extends string>(
  total: number,
  parts: readonly { key: K; n: number }[],
): { total: number | null; parts: { key: K; count: number | null }[] } {
  const shown = suppress(total);
  if (shown === null) return { total: null, parts: parts.map((p) => ({ key: p.key, count: null })) };
  const hidden = suppressedKeys(parts.map((p) => ({ key: p.key, n: p.n })));
  return { total: shown, parts: parts.map((p) => ({ key: p.key, count: hidden.has(p.key) ? null : p.n })) };
}

/** Строка роли: персонал числом, пациенты — через порог и без второго фактора */
export function roleSummary(role: Role, t: RoleTally): OpsUsersRoleSummary {
  const parts = ACCOUNT_STATES.map((key) => ({ key, n: t.states[key] }));
  if (role === "user") {
    const cut = hiddenParts(t.total, parts);
    return { role, total: cut.total, states: cut.parts, mfa: null };
  }
  return {
    role,
    total: t.total,
    states: parts.map((p) => ({ key: p.key, count: p.n })),
    mfa: { enabled: t.mfaEnabled, total: t.mfaTotal },
  };
}

const DAY_MS = 86_400_000;

/** Возраст сессии от входа: до суток, до недели, до тридцати дней (срок refresh-токена), дольше */
export function ageBucket(startedAt: string, now: number): SessionAgeBucket {
  const age = now - new Date(startedAt).getTime();
  if (age < DAY_MS) return "day";
  if (age < 7 * DAY_MS) return "week";
  if (age < 30 * DAY_MS) return "month";
  return "older";
}

/* ─────────────────────── учётки ─────────────────────── */

export async function usersSummary(): Promise<OpsUsersSummary> {
  const rows = await db
    .select({ id: users.id, email: users.email, role: users.role, disabledAt: users.disabledAt, lastSeenAt: users.lastSeenAt })
    .from(users);
  const locked = await lockedEmails();
  const factors = new Set(
    (await db.select({ userId: userSecondFactor.userId }).from(userSecondFactor).where(isNotNull(userSecondFactor.confirmedAt))).map(
      (f) => f.userId,
    ),
  );

  const tally = new Map<Role, RoleTally>(ROLES.map((r) => [r, emptyTally()]));
  for (const u of rows) {
    const t = tally.get(u.role)!;
    t.total++;
    t.states[accountState(u, locked)]++;
    /* охват второго фактора — среди действующих: выключенной учётке он ни к чему */
    if (!u.disabledAt) {
      t.mfaTotal++;
      if (factors.has(u.id)) t.mfaEnabled++;
    }
  }

  const weeks = await rowsOf<{ week: string; staff: number; patients: number }>(sql`
    with w as (${weekSeries(NEW_WEEKS)})
    select to_char(w.week, 'YYYY-MM-DD') as week,
           count(u.id) filter (where u.role <> 'user')::int as staff,
           count(u.id) filter (where u.role = 'user')::int as patients
      from w
      left join (select id, role, ${localWeek("created_at")} as week from users where created_at >= ${weekStart(NEW_WEEKS)}) u
        on u.week = w.week
     group by w.week order by w.week
  `);

  /*
   * Вход — это «auth.login» с успехом (второй фактор пишет его после кода,
   * значит один вход — одна строка). Неудача — любая «auth.login_failed»:
   * неверный пароль, неизвестный адрес, запертый адрес, выключенная учётка,
   * неверный код второго фактора. Для графика это одно: дверь не открылась.
   */
  const logins = await rowsOf<{ date: string; success: number; failed: number }>(sql`
    with s as (${daySeries(LOGIN_DAYS)})
    select to_char(s.day, 'YYYY-MM-DD') as date,
           count(a.day) filter (where a.action = 'auth.login' and a.outcome = 'success')::int as success,
           count(a.day) filter (where a.action = 'auth.login_failed')::int as failed
      from s
      left join (
        select ${localDay("at")} as day, action, outcome from audit_log
         where at >= ${windowStart(LOGIN_DAYS)} and action in ('auth.login', 'auth.login_failed')
      ) a on a.day = s.day
     group by s.day order by s.day
  `);

  return {
    roles: ROLES.map((r) => roleSummary(r, tally.get(r)!)),
    newByWeek: weeks.map((w) => ({ week: w.week, staff: Number(w.staff), patients: suppress(Number(w.patients)) })),
    loginsByDay: logins.map((d) => ({ date: d.date, success: Number(d.success), failed: Number(d.failed) })),
    smallCellFloor: SMALL_CELL_FLOOR,
  };
}

/* ─────────────────────── сессии ─────────────────────── */

/**
 * Живые сессии по роли и возрасту. Сессия — семья refresh-токенов (как у
 * списка «Сесій»): начало — первый токен семьи, живой токен в семье один.
 *
 * Устройства и клиента здесь нет по той же причине, что в списке: у
 * refresh-токена они не хранятся, а подбирать их по журналу входов значило
 * бы рисовать догадку как факт.
 */
export async function sessionsSummary(now = Date.now()): Promise<OpsSessionsSummary> {
  const rows = await db
    .select({
      familyId: refreshTokens.familyId,
      role: users.role,
      startedAt: sql<string>`(select min(f.created_at) from refresh_tokens f where f.family_id = ${refreshTokens.familyId})`,
      lastUsedAt: refreshTokens.createdAt,
    })
    .from(refreshTokens)
    .innerJoin(users, eq(users.id, refreshTokens.userId))
    .where(liveTokenCondition());

  const seen = new Set<string>();
  const byRole = new Map<Role, number>(ROLES.map((r) => [r, 0]));
  const ages = { staff: new Map<SessionAgeBucket, number>(), patients: new Map<SessionAgeBucket, number>() };
  for (const r of rows) {
    if (seen.has(r.familyId)) continue;
    seen.add(r.familyId);
    byRole.set(r.role, byRole.get(r.role)! + 1);
    const group = r.role === "user" ? ages.patients : ages.staff;
    const key = ageBucket(new Date(r.startedAt ?? r.lastUsedAt).toISOString(), now);
    group.set(key, (group.get(key) ?? 0) + 1);
  }

  const staffTotal = byRole.get("superadmin")! + byRole.get("admin")!;
  const patients = hiddenParts(
    byRole.get("user")!,
    AGE_BUCKETS.map((key) => ({ key, n: ages.patients.get(key) ?? 0 })),
  );
  return {
    byRole: [
      { role: "superadmin", sessions: byRole.get("superadmin")! },
      { role: "admin", sessions: byRole.get("admin")! },
      { role: "user", sessions: patients.total },
    ],
    byAge: [
      { group: "staff", total: staffTotal, buckets: AGE_BUCKETS.map((key) => ({ key, count: ages.staff.get(key) ?? 0 })) },
      { group: "patients", total: patients.total, buckets: patients.parts },
    ],
    smallCellFloor: SMALL_CELL_FLOOR,
  };
}

/* ─────────────────────── подозрительная активность ─────────────────────── */

/**
 * Срабатывания по правилам — за всё время (открытые и все), и по дням — за
 * FINDING_DAYS по концу серии (window_to): «когда это случилось», а не
 * «когда заметила проверка». Числа — события, порога нет: имя за ними
 * список и так показывает тому же праву.
 */
export async function suspiciousStats(): Promise<SuspiciousStats> {
  const byRule = await rowsOf<{ rule: string; total: number; open: number }>(sql`
    select rule, count(*)::int as total, count(*) filter (where resolved_at is null)::int as open
      from suspicious_findings
     group by rule
     order by count(*) desc, rule
  `);
  const byDay = await rowsOf<{ date: string; open: number; resolved: number }>(sql`
    with s as (${daySeries(FINDING_DAYS)})
    select to_char(s.day, 'YYYY-MM-DD') as date,
           count(f.day) filter (where not f.resolved)::int as open,
           count(f.day) filter (where f.resolved)::int as resolved
      from s
      left join (
        select ${localDay("window_to")} as day, resolved_at is not null as resolved
          from suspicious_findings where window_to >= ${windowStart(FINDING_DAYS)}
      ) f on f.day = s.day
     group by s.day order by s.day
  `);
  return {
    days: FINDING_DAYS,
    byRule: byRule.map((r) => ({ rule: r.rule as SuspiciousRule, total: Number(r.total), open: Number(r.open) })),
    byDay: byDay.map((d) => ({ date: d.date, open: Number(d.open), resolved: Number(d.resolved) })),
  };
}

/* ─────────────────────── временные доступы ─────────────────────── */

/**
 * Все личные исключения — по состоянию (одно на строку: отзыв старше срока),
 * и выдачи по неделям. Исключения выдаются персоналу — порога нет.
 */
export async function grantStats(): Promise<GrantStats> {
  const [counts] = await rowsOf<{ active: number; permanent: number; expired: number; revoked: number }>(sql`
    select count(*) filter (where revoked_at is null and expires_at is not null and expires_at > now())::int as active,
           count(*) filter (where revoked_at is null and expires_at is null)::int as permanent,
           count(*) filter (where revoked_at is null and expires_at is not null and expires_at <= now())::int as expired,
           count(*) filter (where revoked_at is not null)::int as revoked
      from permission_exceptions
  `);
  const weeks = await rowsOf<{ week: string; count: number }>(sql`
    with w as (${weekSeries(GRANT_WEEKS)})
    select to_char(w.week, 'YYYY-MM-DD') as week, count(e.week)::int as count
      from w
      left join (
        select ${localWeek("granted_at")} as week from permission_exceptions where granted_at >= ${weekStart(GRANT_WEEKS)}
      ) e on e.week = w.week
     group by w.week order by w.week
  `);
  return {
    active: Number(counts?.active ?? 0),
    permanent: Number(counts?.permanent ?? 0),
    expired: Number(counts?.expired ?? 0),
    revoked: Number(counts?.revoked ?? 0),
    byWeek: weeks.map((w) => ({ week: w.week, count: Number(w.count) })),
  };
}
