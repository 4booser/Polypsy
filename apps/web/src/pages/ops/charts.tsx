import type { ReactNode } from "react";
import type {
  OpsConnections,
  OpsErrors,
  OpsErrorWindow,
  OpsJob,
  OpsLogVolume,
  OpsRouteStat,
  OpsScheduleHour,
  OpsTableStat,
  OpsTrafficBucket,
  UiKey,
} from "@quizzy/shared";
import { Figure, HBars, ShareBar, StackColumns, TimeColumns, TimeLines, type HBar } from "../../charts/clinical";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { fill } from "../dashboard/model";
import {
  CLASS_COLOR,
  CONN_KEY,
  ERROR_STEP,
  JOB_KEY,
  LEVEL_COLOR,
  LOG_STEP,
  PCT_COLOR,
  QUIET_COLOR,
  ROLE_KEY,
  ROUTE_P95_MIN,
  SHARE_5XX_LIMIT,
  STEP_KEY,
  binColumns,
  binSeries,
  binStack,
  connectionShares,
  deadRowsAlarm,
  errorGroupsTop,
  fmtBytes,
  fmtInt,
  fmtMs,
  fmtShare,
  fmtUptime,
  hhmm,
  jobsByDuration,
  jobsByFailures,
  jobsByRuns,
  latencyLines,
  routes5xx,
  routesByCount,
  routesByP95,
  share5xxLine,
  tablesByDead,
  tablesBySize,
  trafficStack,
  trafficTip,
  trafficTotals,
  type TopRest,
} from "./model";
import { Quiet } from "./parts";

/**
 * Графики вкладок наблюдаемости (волна 11): нагрузка, маршруты, ошибки,
 * объём лога, задачи, база.
 *
 * Решение заказчика 2026-09-26: «должны быть графики в админ панеле». Всё —
 * над таблицами, таблицы остаются: они и есть табличный вид графика для
 * чтения и для диктора. Здесь только рисование — ряды считает model.ts, а
 * данные приходят готовыми из вкладки: блоки не ходят в сеть сами, поэтому
 * рисуются в тестах (apps/web/test/opsChartsRender.test.tsx) без сервера.
 *
 * Сетка — две колонки от 900 px, одна ниже, как у соседних разделов
 * (pages/ops/data); графики без данных говорят словами, а не пустыми осями.
 */

export const CHART_GRID = "grid grid-cols-1 gap-x-[32px] gap-y-[28px] min-[900px]:grid-cols-2";

/** Маршрут в подписи полосы — моноширинно, метод приглушён: так он напечатан в таблице ниже */
function RouteLabel({ r }: { r: Pick<OpsRouteStat, "method" | "route"> }) {
  return (
    <span className="font-mono text-[12px]" title={`${r.method} ${r.route}`}>
      <span className="text-muted">{r.method}</span> {r.route}
    </span>
  );
}

/** Строка «інші (N)» для величин, которые складываются; пусто — строки нет */
function restBar(rest: TopRest<unknown>, label: string, text: string): HBar[] {
  return rest.rest > 0 ? [{ key: "__rest", label, value: rest.restSum, text }] : [];
}

/** Остаток для величин, которые не складываются (p95, длительность), — словами под полосами */
function MoreNote({ n }: { n: number }) {
  const { ut } = useLang();
  return n > 0 ? <p className="m-0 mt-[8px] text-[12px] leading-[16px] text-muted">{fill(ut("ops.ch.more"), { n })}</p> : null;
}

/* ─────────── нагрузка: Огляд и Запити ─────────── */

/**
 * Нагрузка за окно графика: запросы по классам ответа, время ответа тремя
 * перцентилями, доля пятисоток с порогом и состав ответов за окно.
 *
 * `compact` — только первые два (вкладка «Запити»: там разговор о
 * маршрутах, а доля и состав — на «Огляді»).
 */
export function TrafficCharts({
  buckets,
  stepSec,
  since,
  compact = false,
}: {
  buckets: readonly OpsTrafficBucket[];
  stepSec: number;
  since: string;
  compact?: boolean;
}) {
  const { ut } = useLang();
  const loc = locale();
  const label = (iso: string) => hhmm(iso, loc);
  const tip = (iso: string) => trafficTip(iso, stepSec, loc);
  const columns = trafficStack(buckets, stepSec, since, label, tip);
  const x = buckets.map((b) => ({ key: b.at, label: label(b.at), tip: tip(b.at) }));
  const lines = latencyLines(buckets);
  const share = share5xxLine(buckets);
  const totals = trafficTotals(buckets);
  const ms = (v: number) => fmtMs(v, loc);
  const pct = (v: number) => fmtShare(v, loc);

  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.traffic.requests")} caption={fill(ut("ops.ch.requestsHint"), { step: fmtUptime(stepSec, loc) })}>
        <StackColumns
          label={ut("ops.traffic.requests")}
          series={[
            { key: "ok", label: ut("ops.ch.class.ok"), color: CLASS_COLOR.ok },
            { key: "c4", label: ut("ops.ch.class.c4"), color: CLASS_COLOR.c4 },
            { key: "c5", label: ut("ops.ch.class.c5"), color: CLASS_COLOR.c5 },
          ]}
          columns={columns}
          total={ut("ops.ch.total")}
          emptyTip={ut("ops.ch.noProcess")}
          format={(v) => fmtInt(v, loc)}
        />
      </Figure>
      <Figure title={ut("ops.traffic.latency")} caption={ut("ops.ch.latencyHint")}>
        <TimeLines
          label={ut("ops.traffic.latency")}
          x={x}
          series={[
            { key: "p50", label: ut("ops.col.p50"), color: PCT_COLOR.p50, values: lines.p50 },
            { key: "p95", label: ut("ops.col.p95"), color: PCT_COLOR.p95, values: lines.p95 },
            { key: "p99", label: ut("ops.col.p99"), color: PCT_COLOR.p99, values: lines.p99 },
          ]}
          format={ms}
          tick={(v) => fmtInt(v, loc)}
        />
      </Figure>
      {compact ? null : (
        <>
          <Figure title={ut("ops.ch.share5xx")} caption={ut("ops.ch.share5xxHint")}>
            <TimeLines
              label={ut("ops.ch.share5xx")}
              x={x}
              series={[{ key: "share", label: ut("ops.ch.share5xx"), color: "var(--primary)", values: share }]}
              format={pct}
              threshold={{ value: SHARE_5XX_LIMIT, label: fill(ut("ops.ch.limit"), { v: pct(SHARE_5XX_LIMIT) }) }}
            />
          </Figure>
          <Figure title={ut("ops.ch.mix")} caption={ut("ops.ch.mixHint")}>
            {totals.ok + totals.c4 + totals.c5 > 0 ? (
              <ShareBar
                label={ut("ops.ch.mix")}
                parts={[
                  { key: "ok", label: ut("ops.ch.class.ok"), value: totals.ok, color: CLASS_COLOR.ok },
                  { key: "c4", label: ut("ops.ch.class.c4"), value: totals.c4, color: CLASS_COLOR.c4 },
                  { key: "c5", label: ut("ops.ch.class.c5"), value: totals.c5, color: CLASS_COLOR.c5 },
                ]}
              />
            ) : (
              <Quiet>{ut("ops.routes.empty")}</Quiet>
            )}
          </Figure>
        </>
      )}
    </div>
  );
}

/** Учётки по ролям — полосой долей вместо строки «суперадмін 1 · адмін 12 · пацієнт 340» */
export function AccountsShare({ accounts }: { accounts: { superadmin: number; admin: number; user: number } }) {
  const { ut } = useLang();
  const roles = ["superadmin", "admin", "user"] as const;
  return (
    <ShareBar
      className="w-full py-[8px]"
      label={ut("ops.data.accounts")}
      parts={roles.map((r, i) => ({ key: r, label: ut(ROLE_KEY[r]), value: accounts[r], step: 1 - i / (roles.length - 1) }))}
    />
  );
}

/* ─────────── маршруты ─────────── */

/**
 * Рейтинги маршрутов с момента запуска: по числу запросов, по p95 (от
 * порога выборки) и по доле пятисоток. Поиск на них не действует — он
 * сужает таблицу; рейтинг «первые восемь из найденного» читался бы как
 * рейтинг всех.
 */
export function RouteCharts({ items }: { items: readonly OpsRouteStat[] }) {
  const { ut } = useLang();
  const loc = locale();
  const byCount = routesByCount(items);
  const byP95 = routesByP95(items);
  const by5xx = routes5xx(items);

  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.ch.routesCount")} caption={ut("ops.ch.sinceStart")}>
        <HBars
          items={[
            ...byCount.top.map((r) => ({ key: `${r.method} ${r.route}`, label: <RouteLabel r={r} />, value: r.requests, text: fmtInt(r.requests, loc) })),
            ...restBar(byCount, fill(ut("ops.ch.others"), { n: byCount.rest }), fmtInt(byCount.restSum, loc)),
          ]}
        />
      </Figure>
      <Figure title={ut("ops.ch.routesP95")} caption={fill(ut("ops.ch.routesP95Hint"), { n: ROUTE_P95_MIN })}>
        {byP95.top.length ? (
          <>
            <HBars
              items={byP95.top.map((r) => ({ key: `${r.method} ${r.route}`, label: <RouteLabel r={r} />, value: r.p95, text: fmtMs(r.p95, loc) }))}
            />
            <MoreNote n={byP95.rest} />
          </>
        ) : (
          <Quiet>{fill(ut("ops.ch.routesP95Few"), { n: ROUTE_P95_MIN })}</Quiet>
        )}
      </Figure>
      <Figure title={ut("ops.ch.routes5xx")} caption={ut("ops.ch.routes5xxHint")}>
        {by5xx.top.length ? (
          <>
            {/* от 0 до 100 %: доля маршрута — это доля его запросов, а не «место среди соседей» */}
            <HBars
              max={1}
              items={by5xx.top.map((r) => ({
                key: `${r.method} ${r.route}`,
                label: <RouteLabel r={r} />,
                value: r.errors5xx / r.requests,
                text: fill(ut("ops.ch.nOfM"), { v: fmtShare(r.errors5xx / r.requests, loc), n: fmtInt(r.errors5xx, loc), m: fmtInt(r.requests, loc) }),
                attention: true,
              }))}
            />
            <MoreNote n={by5xx.rest} />
          </>
        ) : (
          <Quiet>{ut("ops.ch.routes5xxNone")}</Quiet>
        )}
      </Figure>
    </div>
  );
}

/* ─────────── ошибки ─────────── */

/**
 * Случаи по времени и самые частые группы — за период истории.
 *
 * Столбцы — из часов базы (`hours`), разложенных в местные корзины; без
 * них (история не прочиталась — экран показывает память процесса) времени
 * у групп нет, и график говорит об этом словами. Янтарь — вся фигура:
 * каждый случай здесь необработанное исключение.
 */
export function ErrorCharts({ data, window, now }: { data: OpsErrors; window: OpsErrorWindow; now: number }) {
  const { ut } = useLang();
  const loc = locale();
  const step = ERROR_STEP[window];
  const top = errorGroupsTop(data.items);
  const columns =
    data.hours && data.from ? binColumns(binSeries(data.hours, ["count"], Date.parse(data.from), now, step), "count", step, loc) : null;

  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.ch.errCases")} caption={ut(STEP_KEY[step])}>
        {columns ? (
          <TimeColumns columns={columns} label={ut("ops.ch.errCases")} tone="attention" />
        ) : (
          <Quiet>{ut("ops.ch.errNoHours")}</Quiet>
        )}
      </Figure>
      <Figure title={ut("ops.ch.errTop")} caption={ut("ops.ch.errTopHint")}>
        {top.top.length ? (
          <HBars
            items={[
              ...top.top.map((g) => ({
                key: g.fingerprint,
                label: (
                  <span className="font-mono text-[12px]" title={g.message}>
                    <span className="font-bold text-text">{g.name}</span> <span className="text-muted">{g.message}</span>
                  </span>
                ),
                value: g.count,
                text: fmtInt(g.count, loc),
                attention: true,
              })),
              ...restBar(top, fill(ut("ops.ch.others"), { n: top.rest }), fmtInt(top.restSum, loc)),
            ]}
          />
        ) : (
          <Quiet>{data.from ? ut("ops.history.errorsEmpty") : ut("ops.errors.empty")}</Quiet>
        )}
      </Figure>
    </div>
  );
}

/* ─────────── объём лога ─────────── */

/**
 * Строки лога за период: всего и отдельно предупреждения с ошибками.
 *
 * Отдельно — потому что «інфо» по строке на запрос в сотни раз больше, и
 * в общем столбце предупреждения были бы невидимой полоской. Янтарь —
 * только у ошибок (строка «помилка»); предупреждение — первым
 * категориальным: оно заметно, но само по себе действия не требует.
 */
export function LogVolumeCharts({ volume, now }: { volume: OpsLogVolume; now: number }) {
  const { ut } = useLang();
  const loc = locale();
  const step = LOG_STEP[volume.window];
  const bins = binSeries(volume.buckets, ["debug", "info", "warn", "error"], Date.parse(volume.from), now, step);
  const all = bins.map((b) => ({ ...b, values: { ...b.values, all: b.values.debug + b.values.info + b.values.warn + b.values.error } }));
  const loud = bins.some((b) => b.values.warn + b.values.error > 0);
  const caption = fill(ut("ops.ch.logHint"), { step: ut(STEP_KEY[step]) });

  return (
    <>
      {volume.historyUnavailable ? <Quiet>{ut("ops.ch.logUnavailable")}</Quiet> : null}
      <div className={CHART_GRID}>
        <Figure title={ut("ops.ch.logAll")} caption={caption}>
          <TimeColumns columns={binColumns(all, "all", step, loc)} label={ut("ops.ch.logAll")} />
        </Figure>
        <Figure title={ut("ops.ch.logLoud")} caption={caption}>
          {loud ? (
            <StackColumns
              label={ut("ops.ch.logLoud")}
              series={[
                { key: "warn", label: ut("ops.level.warn"), color: LEVEL_COLOR.warn },
                { key: "error", label: ut("ops.level.error"), color: LEVEL_COLOR.error },
              ]}
              columns={binStack(bins, ["warn", "error"], step, loc)}
              total={ut("ops.ch.total")}
              format={(v) => fmtInt(v, loc)}
            />
          ) : (
            <Quiet>{ut("ops.ch.logQuiet")}</Quiet>
          )}
        </Figure>
      </div>
    </>
  );
}

/* ─────────── фоновые задачи ─────────── */

/** Имя задачи по-человечески; незнакомая (сервер новее консоли) — своим кодом */
const jobName = (j: OpsJob, ut: (k: UiKey) => string): ReactNode => {
  const key = JOB_KEY[j.name];
  return key ? ut(key) : <span className="font-mono text-[12px]">{j.name}</span>;
};

/**
 * Проходы задач с момента запуска, сбои (только у тех, у кого они были) и
 * длительность последнего прохода. Сбои — янтарём: упавший проход и есть
 * «требует внимания».
 */
export function JobCharts({ items }: { items: readonly OpsJob[] }) {
  const { ut } = useLang();
  const loc = locale();
  const runs = jobsByRuns(items);
  const fails = jobsByFailures(items);
  const took = jobsByDuration(items);

  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.ch.jobRuns")} caption={ut("ops.ch.sinceStart")}>
        <HBars
          items={[
            ...runs.top.map((j) => ({
              key: j.name,
              label: jobName(j, ut),
              value: j.runs,
              text: j.failures ? fill(ut("ops.ch.jobRunsText"), { runs: fmtInt(j.runs, loc), n: fmtInt(j.failures, loc) }) : fmtInt(j.runs, loc),
            })),
            ...restBar(runs, fill(ut("ops.ch.others"), { n: runs.rest }), fmtInt(runs.restSum, loc)),
          ]}
        />
      </Figure>
      <Figure title={ut("ops.ch.jobFails")} caption={ut("ops.ch.sinceStart")}>
        {fails.length ? (
          <HBars items={fails.map((j) => ({ key: j.name, label: jobName(j, ut), value: j.failures, text: fmtInt(j.failures, loc), attention: true }))} />
        ) : (
          <Quiet>{ut("ops.ch.jobNoFails")}</Quiet>
        )}
      </Figure>
      <Figure title={ut("ops.ch.jobTook")}>
        {took.top.length ? (
          <>
            <HBars items={took.top.map((j) => ({ key: j.name, label: jobName(j, ut), value: j.lastDurationMs, text: fmtMs(j.lastDurationMs, loc) }))} />
            <MoreNote n={took.rest} />
          </>
        ) : (
          <Quiet>{ut("ops.ch.jobNeverRan")}</Quiet>
        )}
      </Figure>
    </div>
  );
}

/**
 * Срабатывания расписаний по местным суткам за месяц: сколько раз и сколько
 * назначено и пропущено. Из базы — переживает перезапуск, в отличие от
 * проходов выше. Пропущенное — не сбой (у человека уже висит незакрытое
 * назначение), поэтому не янтарём.
 */
export function ScheduleCharts({
  activity,
  days,
  now,
}: {
  activity: { from: string; hours: readonly OpsScheduleHour[] };
  days: number;
  now: number;
}) {
  const { ut } = useLang();
  const loc = locale();
  const bins = binSeries(activity.hours, ["runs", "assigned", "skipped"], Date.parse(activity.from), now, "day");
  if (!bins.some((b) => b.values.runs > 0)) return <Quiet>{fill(ut("ops.ch.schedEmpty"), { n: days })}</Quiet>;
  const caption = fill(ut("ops.ch.schedHint"), { n: days });
  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.ch.schedDays")} caption={caption}>
        <TimeColumns columns={binColumns(bins, "runs", "day", loc)} label={ut("ops.ch.schedDays")} />
      </Figure>
      <Figure title={ut("ops.ch.schedAssigned")} caption={caption}>
        <StackColumns
          label={ut("ops.ch.schedAssigned")}
          series={[
            { key: "assigned", label: ut("ops.col.assigned"), color: "var(--primary)" },
            { key: "skipped", label: ut("ops.col.skipped"), color: QUIET_COLOR },
          ]}
          columns={binStack(bins, ["assigned", "skipped"], "day", loc)}
          format={(v) => fmtInt(v, loc)}
        />
      </Figure>
    </div>
  );
}

/* ─────────── база ─────────── */

/**
 * Десять самых больших таблиц и «інші» — остаток из тех, что прислал сервер
 * (он отдаёт самые большие, не все); и мёртвые строки, где они есть, —
 * янтарём там, где автоочистка не успевает (то же правило, что у колонки
 * таблицы ниже, deadRowsAlarm).
 */
export function TableCharts({ tables }: { tables: readonly OpsTableStat[] }) {
  const { ut } = useLang();
  const loc = locale();
  const size = tablesBySize(tables);
  const dead = tablesByDead(tables);
  const name = (t: OpsTableStat) => <span className="font-mono text-[12px]">{t.table}</span>;

  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.ch.tableSize")} caption={fill(ut("ops.ch.tableSizeHint"), { n: tables.length })}>
        <HBars
          items={[
            ...size.top.map((t) => ({ key: t.table, label: name(t), value: t.totalBytes, text: fmtBytes(t.totalBytes, loc) })),
            ...restBar(size, fill(ut("ops.ch.others"), { n: size.rest }), fmtBytes(size.restSum, loc)),
          ]}
        />
      </Figure>
      <Figure title={ut("ops.ch.deadRows")} caption={ut("ops.ch.deadRowsHint")}>
        {dead.top.length ? (
          <>
            <HBars
              /* внимание — янтарём и жирной подписью: цвет в одиночку «выделено» не несёт */
              items={dead.top.map((t) => ({
                key: t.table,
                label: name(t),
                value: t.deadRows,
                text: fmtInt(t.deadRows, loc),
                attention: deadRowsAlarm(t),
                strong: deadRowsAlarm(t),
              }))}
            />
            <MoreNote n={dead.rest} />
          </>
        ) : (
          <Quiet>{ut("ops.ch.deadNone")}</Quiet>
        )}
      </Figure>
    </div>
  );
}

/**
 * Подключения по состояниям и свободные до max_connections — одной
 * полосой. Свободные — дорожкой сетки, а не ещё одной ступенью фиолетового:
 * это не состояние подключения, а место, которого пока никто не занял.
 */
export function ConnectionsShare({ c }: { c: OpsConnections }) {
  const { ut } = useLang();
  const parts = connectionShares(c);
  const busy = parts.filter((p) => p.state !== "free").length;
  return (
    <ShareBar
      label={ut("ops.db.connections")}
      parts={parts.map((p, i) =>
        p.state === "free"
          ? { key: "free", label: ut("ops.ch.free"), value: p.count, color: "var(--grid)" }
          : {
              key: p.state,
              label: ut(CONN_KEY[p.state]),
              value: p.count,
              /* одна величина — один тон, порядок читается светлотой: самое частое темнее */
              step: busy > 1 ? 1 - i / (busy - 1) : 1,
            },
      )}
    />
  );
}
