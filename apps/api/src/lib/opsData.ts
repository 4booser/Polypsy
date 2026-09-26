import { sql } from "drizzle-orm";
import {
  compareVersions,
  type MobileReport,
  type MobileVersionRow,
  type PushReport,
  type ScreenViewsInput,
  type UsageReport,
} from "@quizzy/shared";
import { db } from "../db";
import { env } from "../env";
import { SMALL_CELL_FLOOR, suppress } from "./privacy";

/**
 * Отчёты техпанели «Дані й продукт»: использование продукта, мобильное
 * приложение, пуш-уведомления. Проверки качества данных — отдельным модулем
 * (lib/dataChecks.ts): там SQL на каждую проверку и свои тесты.
 *
 * Все функции только читают и зовутся под asSystem (routes/opsData.ts):
 * числа техпанели — про всю систему, а не про зону ответственности того, кто
 * смотрит. Наружу — только агрегаты: ни одного человека, адреса экрана с
 * идентификатором или токена устройства.
 *
 * ═══ Где стоит порог малых ячеек, а где нет ═══
 *
 * Порог (lib/privacy.ts) охраняет людей от опознания в маленьком
 * подразделении, поэтому стоит там, где число — это ЛЮДИ-ПАЦИЕНТЫ:
 * активные пациенты по дням и ступени воронки. Не стоит там, где число —
 * события или устройства без признака: открытия экранов, версии сборок,
 * исходы уведомлений. «/patients/:userId открывали 3 раза» и «на сборке
 * 1.0.2 два устройства» ни о ком ничего не говорят. Специалисты — числом
 * всегда: их список с именами и так открыт в разделе людей, и прятать от
 * техпанели, что вчера работали трое, значило бы охранять не то.
 */

const DAY_MS = 86_400_000;

/** Сегодня в поясе учреждения — день, по которому режутся все дневные ряды */
const today = () => sql`(now() at time zone ${env.institutionTz})::date`;
/** Начало первого дня окна из `days` дней, как момент времени */
const windowStart = (days: number) =>
  sql`((${today()} - ${days - 1}::int)::timestamp at time zone ${env.institutionTz})`;
/** Сплошной ряд дней окна: пустой день — строка с нулём, а не дыра в графике */
const daySeries = (days: number) =>
  sql`select d::date as day from generate_series(${today()} - ${days - 1}::int, ${today()}, interval '1 day') d`;
const localDay = (column: string) => sql`(${sql.raw(column)} at time zone ${env.institutionTz})::date`;

const rowsOf = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
  [...(await db.execute<T & Record<string, unknown>>(query))] as T[];

/* ─────────────────────── телеметрия экранов ─────────────────────── */

/**
 * Принять пачку счётчиков. Одинаковые шаблоны в пачке складываются до
 * записи: две строки с одним ключом в одном INSERT … ON CONFLICT PostgreSQL
 * отвергает («cannot affect row a second time»), и пачка пропала бы целиком.
 */
export async function recordScreenViews(input: ScreenViewsInput): Promise<number> {
  const merged = new Map<string, { app: string; route: string; count: number }>();
  for (const v of input.views) {
    const key = `${v.app}\u0000${v.route}`;
    const prev = merged.get(key);
    merged.set(key, { app: v.app, route: v.route, count: (prev?.count ?? 0) + v.count });
  }
  const values = [...merged.values()];
  await db.execute(sql`
    insert into screen_views (day, app, route, views)
    values ${sql.join(
      values.map((v) => sql`(${today()}, ${v.app}, ${v.route}, ${v.count})`),
      sql`, `,
    )}
    on conflict (day, app, route) do update set views = screen_views.views + excluded.views
  `);
  return values.length;
}

/* ─────────────────────── использование ─────────────────────── */

/**
 * Ступени воронки через порог — не каждая сама по себе, а цепочкой.
 *
 * Ступени вложены: прошедшие первое прохождение — часть
 * зарегистрировавшихся. Поэтому скрытой бывает не только малая ступень, но и
 * малая РАЗНИЦА соседних: «зарегистрировались 20, прошли 18» печатает двоих,
 * так и не дошедших до первого прохождения, — горстку, которую порог обязан
 * прятать (lib/privacy.ts, cell: восстановить скрытое вычитанием может кто
 * угодно). Правило: ступень показывается, если она не меньше порога И
 * отличается от последней ПОКАЗАННОЙ либо на ноль, либо не меньше чем на
 * порог. Иначе она скрыта, и следующая сравнивается с последней показанной.
 *
 * Что это даёт читателю: каждая напечатанная разность — ноль или не меньше
 * порога, последняя показанная ступень — не меньше порога; скрытая ступень
 * лежит в отрезке не короче двух целых. Однозначно не восстанавливается
 * ничего.
 */
export function funnelCells(values: readonly number[]): (number | null)[] {
  const out: (number | null)[] = [];
  let last: number | null = null;
  for (const v of values) {
    const drop = last === null ? 0 : last - v;
    if (suppress(v) === null || (drop > 0 && drop < SMALL_CELL_FLOOR)) {
      out.push(null);
      continue;
    }
    out.push(v);
    last = v;
  }
  return out;
}

/** Окно воронки: путь от приглашения до повторного прохождения длиннее месяца */
export const FUNNEL_DAYS = 90;

/**
 * `inviterId` сужает воронку до приглашений одного сотрудника. Экрану это
 * пока не нужно; нужно тестам — в общей тестовой базе приглашения выписывают
 * и другие файлы, и счёт «всей базы» был бы лотереей.
 */
export async function usageReport(days: number, scope: { inviterId?: string } = {}): Promise<UsageReport> {
  /* ── экраны ── */
  const top = await rowsOf<{ app: string; route: string; views: number; days: number }>(sql`
    select app, route, sum(views)::int as views, count(distinct day)::int as days
      from screen_views
     where day > ${today()} - ${days}::int
     group by app, route
     order by sum(views) desc, app, route
     limit 40
  `);
  const screensByDay = await rowsOf<{ date: string; views: number }>(sql`
    with s as (${daySeries(days)})
    select to_char(s.day, 'YYYY-MM-DD') as date, coalesce(sum(v.views), 0)::int as views
      from s left join screen_views v on v.day = s.day
     group by s.day order by s.day
  `);

  /*
   * ── активные люди ──
   *
   * Из того, что сервер уже знает, — своего счётчика «зашёл» не заводится:
   * вход и регистрация (журнал), обновление токена (refresh_tokens: каждый
   * обмен — новая строка, то есть «был в сети» раз в полчаса работы) и
   * прохождение (responses: пациент, сдавший тест с телефона без нового
   * входа, тоже был активен). Человек в день считается один раз, сколько бы
   * следов он ни оставил.
   */
  const span = Math.max(days, 30);
  const marked = sql`
    ev as (
      select a.actor_id as user_id, a.at from audit_log a
       where a.action in ('auth.login', 'auth.register') and a.outcome = 'success'
         and a.actor_id is not null and a.at >= ${windowStart(span)}
      union all
      select t.user_id, t.created_at from refresh_tokens t where t.created_at >= ${windowStart(span)}
      union all
      select r.user_id, coalesce(r.submitted_at, r.last_saved_at, r.started_at) from responses r
       where r.user_id is not null and coalesce(r.submitted_at, r.last_saved_at, r.started_at) >= ${windowStart(span)}
    ),
    marked as (
      select ev.user_id, ${localDay("ev.at")} as day, u.role <> 'user' as staff
        from ev join users u on u.id = ev.user_id
    )`;
  const activeByDay = await rowsOf<{ date: string; staff: number; patients: number }>(sql`
    with ${marked}, s as (${daySeries(days)})
    select to_char(s.day, 'YYYY-MM-DD') as date,
           count(distinct m.user_id) filter (where m.staff)::int as staff,
           count(distinct m.user_id) filter (where not m.staff)::int as patients
      from s left join marked m on m.day = s.day
     group by s.day order by s.day
  `);
  const [totals] = await rowsOf<{ staff7: number; staff30: number; patients7: number; patients30: number }>(sql`
    with ${marked}
    select count(distinct user_id) filter (where staff and day > ${today()} - 7)::int as staff7,
           count(distinct user_id) filter (where staff and day > ${today()} - 30)::int as staff30,
           count(distinct user_id) filter (where not staff and day > ${today()} - 7)::int as patients7,
           count(distinct user_id) filter (where not staff and day > ${today()} - 30)::int as patients30
      from marked
  `);

  /*
   * ── воронка пациента ──
   *
   * Когорта — приглашения, выписанные за окно, и люди, пришедшие по ним.
   * «Повторное» — сдачи в двух разных днях, а не две сдачи: батарея из трёх
   * методик за один приход дала бы три прохождения, но человек не
   * возвращался. Вопрос ступени — «пришёл ли снова».
   */
  const [funnel] = await rowsOf<{ invites: number; registered: number; first: number; repeat: number; self: number }>(sql`
    with inv as (
      select id from invites
       where created_at >= ${windowStart(FUNNEL_DAYS)}${scope.inviterId ? sql` and created_by = ${scope.inviterId}` : sql``}
    ),
    reg as (select distinct iu.user_id from invite_uses iu join inv on inv.id = iu.invite_id),
    per as (
      select reg.user_id,
             count(r.id) as n,
             count(distinct ${localDay("r.submitted_at")}) as days
        from reg left join responses r on r.user_id = reg.user_id and r.status = 'completed'
       group by reg.user_id
    )
    select (select count(*) from inv)::int as invites,
           (select count(*) from reg)::int as registered,
           (select count(*) from per where n >= 1)::int as first,
           (select count(*) from per where days >= 2)::int as repeat,
           (select count(*) from users u
             where u.role = 'user' and u.created_at >= ${windowStart(FUNNEL_DAYS)}
               and not exists (select 1 from invite_uses iu where iu.user_id = u.id))::int as self
  `);
  const [registered, firstResponse, repeatResponse] = funnelCells([
    funnel?.registered ?? 0,
    funnel?.first ?? 0,
    funnel?.repeat ?? 0,
  ]);

  return {
    days,
    smallCellFloor: SMALL_CELL_FLOOR,
    screens: {
      total: screensByDay.reduce((s, d) => s + d.views, 0),
      top: top.map((r) => ({ ...r, app: r.app as UsageReport["screens"]["top"][number]["app"] })),
      byDay: screensByDay,
    },
    active: {
      byDay: activeByDay.map((d) => ({ date: d.date, staff: d.staff, patients: suppress(d.patients) })),
      staff7: totals?.staff7 ?? 0,
      staff30: totals?.staff30 ?? 0,
      patients7: suppress(totals?.patients7 ?? 0),
      patients30: suppress(totals?.patients30 ?? 0),
    },
    funnel: {
      days: FUNNEL_DAYS,
      invites: funnel?.invites ?? 0,
      registered: registered ?? null,
      firstResponse: firstResponse ?? null,
      repeatResponse: repeatResponse ?? null,
      selfRegistered: suppress(funnel?.self ?? 0),
    },
  };
}

/* ─────────────────────── мобильное приложение ─────────────────────── */

const LAG = { hour: 3_600_000, day: DAY_MS, week: 7 * DAY_MS };

export async function mobileReport(days: number): Promise<MobileReport> {
  const since = sql`now() - make_interval(days => ${days}::int)`;
  /*
   * Устройства — те, что отмечались за окно и не стёрты: стёртое устройство
   * после стирания представляется новым (offline/device.ts), и старая строка
   * о нём больше ничего не говорит.
   */
  const groups = await rowsOf<{ platform: string | null; version: string | null; build: string | null; n: number; last_seen: string }>(sql`
    select platform, app_version as version, app_build as build, count(*)::int as n,
           to_char(max(last_seen_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_seen
      from devices
     where last_seen_at >= ${since} and wiped_at is null
     group by 1, 2, 3
  `);
  const known = groups.filter((g) => g.version);
  const newest = known.reduce<string | null>(
    (best, g) => (best === null || compareVersions(g.version!, best) > 0 ? g.version! : best),
    null,
  );
  const versions: MobileVersionRow[] = groups
    .map((g) => ({
      platform: g.platform,
      version: g.version,
      build: g.build,
      devices: g.n,
      old: !!g.version && !!newest && compareVersions(g.version, newest) < 0,
      lastSeenAt: g.last_seen,
    }))
    .sort((a, b) => {
      if (!a.version || !b.version) return a.version ? -1 : b.version ? 1 : b.devices - a.devices;
      return compareVersions(b.version, a.version) || b.devices - a.devices;
    });
  const total = groups.reduce((s, g) => s + g.n, 0);
  const knownCount = known.reduce((s, g) => s + g.n, 0);
  const oldCount = versions.filter((v) => v.old).reduce((s, v) => s + v.devices, 0);

  const [queue] = await rowsOf<MobileReport["queue"]>(sql`
    select count(*) filter (where queue_pending is not null)::int as "devicesReporting",
           coalesce(sum(queue_pending), 0)::int as pending,
           coalesce(sum(queue_rejected), 0)::int as rejected,
           count(*) filter (where queue_pending > 0)::int as "devicesWithPending",
           count(*) filter (where queue_rejected > 0)::int as "devicesWithRejected"
      from devices
     where last_seen_at >= ${since} and wiped_at is null
  `);

  /*
   * Опоздавшие сдачи. clientRequestId у прохождения ставит только офлайн-
   * очередь мобильного приложения (offline/queue.ts): прямая сдача его не
   * шлёт. Значит, строка с ним — досылка.
   *
   * Опоздание = момент приёма (submitted_at — время сервера) минус момент,
   * когда человек закончил: начало плюс длительность, обе с устройства.
   * Часы устройства могут врать на минуты — поэтому корзины крупные, от
   * часа, и отрицательное опоздание считается нулём.
   */
  const lag = sql`greatest(0, extract(epoch from (r.submitted_at - r.started_at)) * 1000 - r.duration_ms)`;
  const [late] = await rowsOf<{ total: number; lt1h: number; lt1d: number; lt7d: number; gte7d: number; median: number | null; p90: number | null }>(sql`
    with q as (
      select ${lag} as lag from responses r
       where r.client_request_id is not null and r.submitted_at >= ${windowStart(days)}
    )
    select count(*)::int as total,
           count(*) filter (where lag < ${LAG.hour})::int as lt1h,
           count(*) filter (where lag >= ${LAG.hour} and lag < ${LAG.day})::int as lt1d,
           count(*) filter (where lag >= ${LAG.day} and lag < ${LAG.week})::int as lt7d,
           count(*) filter (where lag >= ${LAG.week})::int as gte7d,
           percentile_cont(0.5) within group (order by lag) as median,
           percentile_cont(0.9) within group (order by lag) as p90
      from q
  `);
  const [submitted] = await rowsOf<{ n: number }>(sql`
    select count(*)::int as n from responses
     where status = 'completed' and submitted_at >= ${windowStart(days)}
  `);
  const lateByDay = await rowsOf<{ date: string; count: number }>(sql`
    with s as (${daySeries(days)})
    select to_char(s.day, 'YYYY-MM-DD') as date, count(r.id)::int as count
      from s left join responses r
        on r.client_request_id is not null and ${localDay("r.submitted_at")} = s.day
     group by s.day order by s.day
  `);

  const ms = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return {
    days,
    devices: { total, known: knownCount, unknown: total - knownCount },
    newest,
    versions,
    /*
     * Доля — от устройств, приславших версию: неизвестная версия не старая и
     * не новая, и в знаменателе она сделала бы долю меньше, чем она есть.
     */
    old: { devices: oldCount, percent: knownCount > 0 ? Math.round((oldCount / knownCount) * 100) : null },
    queue: queue ?? { devicesReporting: 0, pending: 0, rejected: 0, devicesWithPending: 0, devicesWithRejected: 0 },
    late: {
      total: late?.total ?? 0,
      submitted: submitted?.n ?? 0,
      buckets: [
        { key: "lt1h", count: late?.lt1h ?? 0 },
        { key: "lt1d", count: late?.lt1d ?? 0 },
        { key: "lt7d", count: late?.lt7d ?? 0 },
        { key: "gte7d", count: late?.gte7d ?? 0 },
      ],
      // null, а не ноль: у пустой выборки медианы нет
      medianLagMs: ms(late?.median),
      p90LagMs: ms(late?.p90),
      byDay: lateByDay,
    },
  };
}

/* ─────────────────────── пуш-уведомления ─────────────────────── */

export async function pushReport(days: number): Promise<PushReport> {
  const since = windowStart(days);
  const [first] = await rowsOf<{ at: string | null }>(sql`
    select to_char(min(at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at from push_outcomes
  `);
  const [totals] = await rowsOf<PushReport["totals"]>(sql`
    select count(*)::int as sent,
           count(*) filter (where status = 'accepted')::int as accepted,
           count(*) filter (where status = 'rejected')::int as rejected,
           count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where receipt_status = 'ok')::int as delivered,
           count(*) filter (where receipt_status = 'error')::int as "receiptErrors",
           count(*) filter (where ticket_id is not null and receipt_status is null)::int as "awaitingReceipt"
      from push_outcomes where at >= ${since}
  `);
  /* ошибка — любой исход, кроме «принято и не отвергнуто квитанцией» */
  const isError = sql`(o.status <> 'accepted' or o.receipt_status = 'error')`;
  const byDay = await rowsOf<{ date: string; sent: number; errors: number }>(sql`
    with s as (${daySeries(days)})
    select to_char(s.day, 'YYYY-MM-DD') as date,
           count(o.id)::int as sent,
           count(o.id) filter (where ${isError})::int as errors
      from s left join push_outcomes o on ${localDay("o.at")} = s.day
     group by s.day order by s.day
  `);
  const byKind = await rowsOf<{ kind: string; sent: number; errors: number; delivered: number }>(sql`
    select o.kind, count(*)::int as sent,
           count(*) filter (where ${isError})::int as errors,
           count(*) filter (where o.receipt_status = 'ok')::int as delivered
      from push_outcomes o where o.at >= ${since}
     group by o.kind order by count(*) desc, o.kind
  `);
  const errors = await rowsOf<{ code: string; count: number; tokens: number }>(sql`
    select coalesce(o.receipt_error, o.error, 'unknown') as code,
           count(*)::int as count, count(distinct o.token_hash)::int as tokens
      from push_outcomes o where o.at >= ${since} and ${isError}
     group by 1 order by count(*) desc, 1 limit 12
  `);
  const platforms = await rowsOf<{ platform: string; count: number; stale: number }>(sql`
    select platform, count(*)::int as count,
           count(*) filter (where last_seen_at < now() - interval '90 days')::int as stale
      from push_tokens group by platform order by count(*) desc
  `);
  const events = await rowsOf<{ kind: string; count: number }>(sql`
    select kind, count(*)::int as count from push_deliveries
     where sent_at >= ${since} group by kind order by count(*) desc, kind
  `);

  return {
    days,
    since: first?.at ?? null,
    totals: totals ?? { sent: 0, accepted: 0, rejected: 0, failed: 0, delivered: 0, receiptErrors: 0, awaitingReceipt: 0 },
    byDay,
    byKind,
    errors,
    tokens: {
      registered: platforms.reduce((s, p) => s + p.count, 0),
      stale: platforms.reduce((s, p) => s + p.stale, 0),
      byPlatform: platforms.map((p) => ({ platform: p.platform, count: p.count })),
    },
    events,
  };
}
