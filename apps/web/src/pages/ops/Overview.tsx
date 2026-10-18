import { useState, type ReactNode } from "react";
import type {
  OpsAlerts,
  OpsErrorGroup,
  OpsHealthCheck,
  OpsOverview,
  OpsTraffic,
  OpsTrafficBucket,
  ServiceStatus,
  UiKey,
} from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import type { TimeLineMark } from "../../charts/clinical";
import { dateTime, locale } from "../../format";
import { useLang } from "../../lang";
import { refreshServiceStatus } from "../../service/status";
import { AlertChip, AlertStrip, Drawer, DrawerSection, KV, Loading, useAction, useToast, useUrlState } from "../../ui";
import { IconTile, Panel } from "../../ui/layout";
import { Button, ButtonLink, Field, Segmented, Select, Tag, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { fill } from "../dashboard/model";
import { AccountsShare, TrafficCharts } from "./charts";
import { OpsIcon, type OpsIconName } from "./icons";
import { enabledForNobody } from "./maint/model";
import {
  HEALTH_NAME,
  SHARE_5XX_LIMIT,
  STATUS_KEY,
  fmtAgo,
  fmtBytes,
  fmtInt,
  fmtMs,
  fmtShare,
  fmtUptime,
  healthReason,
  hhmm,
  parseTrafficWindow,
} from "./model";
import { RULE_NAME } from "./obs2b/model";
import {
  type MetricRow,
  CopyLinkButton,
  Facts,
  Live,
  MetricsTable,
  Mono,
  OpsHead,
  PanelNote,
  RefreshButton,
  SinceNote,
  StatusMark,
  type Tone,
  TraceBox,
  Was,
  sinceText,
  useOpsResource,
} from "./parts";

/*
 * Огляд техпанели: «жива ли система и что требует внимания».
 *
 * Сверху — состояние системы одной панелью: работает ли, сборка, процесс и
 * строка «Потребує уваги» пилюлями (проверки не «гаразд», сработавшие
 * правила оповещений, новые группы ошибок), у каждой свой поповер и свой
 * переход. Ниже — «Показники процесу» таблицей (вместо плиток KPI: у
 * каждого числа сравнение и состояние словом), нагрузка за час, шесть
 * часов или сутки, проверки здоровья, «Стан для людей» (что видят люди и
 * объявление о сбоях в ящике), сборка и база.
 *
 * Обновляется сам раз в двадцать секунд, пока вкладка открыта; окно
 * графика — в адресе (?window=24h), ссылку «вот так было сутки» пересылают.
 */

const POLL_MS = 20_000;
const SLOW_POLL_MS = 60_000;

const TONE: Record<OpsHealthCheck["status"], Tone> = { ok: "ok", warn: "warn", fail: "fail" };

export default function OpsOverview() {
  const { ut } = useLang();
  const [rawWindow, setWindow] = useUrlState("window", "1h");
  const win = parseTrafficWindow(rawWindow);

  const ov = useOpsResource(() => api.opsOverview(), [], POLL_MS);
  const traffic = useOpsResource(() => api.opsTraffic(win), [win], POLL_MS);
  /* сутки — для сравнения в «Показниках»: «6 год тому», ход за шесть часов */
  const day = useOpsResource(() => api.opsTraffic("24h"), [], POLL_MS);
  const errors = useOpsResource(() => api.opsErrors(), [], POLL_MS);
  const alerts = useOpsResource(() => api.opsAlerts(), [], SLOW_POLL_MS);

  const d = ov.data;
  const head = (
    <OpsHead
      meta={d ? [ut(overallKey(d.health, "meta")), fill(ut("opx.ov.metaSince"), { time: sinceText(d.since, locale()) })] : null}
      actions={
        <>
          <TraceBox />
          <CopyLinkButton />
          <RefreshButton
            busy={ov.loading}
            onRefresh={() => {
              ov.reload();
              traffic.reload();
              day.reload();
              errors.reload();
              alerts.reload();
            }}
          />
        </>
      }
    />
  );

  if (ov.error && !d) {
    return (
      <>
        {head}
        <Loading error={ov.error} onRetry={ov.reload} />
      </>
    );
  }
  if (!d) {
    return (
      <>
        {head}
        <Loading rows={6} />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {head}
      <SystemPanel d={d} updatedAt={ov.updatedAt} errors={errors.data?.items ?? null} alerts={alerts.data ?? null} />
      <Panel title={ut("opx.ov.metrics")} icon={<OpsIcon name="gauge" />} sub={ut("opx.ov.metricsSub")} flush>
        <MetricsTable label={ut("opx.ov.metrics")} rows={metricRows(d, day.data, alerts.data ?? null, ut)} />
      </Panel>
      <LoadPanel win={win} onWindow={setWindow} traffic={traffic.data} error={traffic.error} onRetry={traffic.reload} d={d} />
      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4 max-[1100px]:grid-cols-1">
        <ChecksPanel d={d} onCheck={ov.reload} />
        <PeoplePanel alerts={alerts.data ?? null} />
      </div>
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-4 max-[1000px]:grid-cols-1">
        <BuildPanel d={d} />
        <DataPanel d={d} />
      </div>
    </div>
  );
}

/* ─────────── состояние системы ─────────── */

type Overall = "ok" | "warn" | "fail";

function overallOf(health: readonly OpsHealthCheck[]): Overall {
  if (health.some((c) => c.status === "fail")) return "fail";
  if (health.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

function overallKey(health: readonly OpsHealthCheck[], what: "meta" | "word") {
  const o = overallOf(health);
  if (what === "meta") return o === "ok" ? "opx.ov.metaOk" : o === "warn" ? "opx.ov.metaWarn" : "opx.ov.metaFail";
  return o === "ok" ? "opx.ov.up" : o === "warn" ? "opx.ov.upWarn" : "opx.ov.down";
}

/** Группы ошибок, впервые появившиеся за последний час: «новое» — то, чего не было до этого часа */
function freshGroups(items: readonly OpsErrorGroup[], now: number): OpsErrorGroup[] {
  return items.filter((g) => now - Date.parse(g.firstAt) <= 3_600_000);
}

function SystemPanel({
  d,
  updatedAt,
  errors,
  alerts,
}: {
  d: OpsOverview;
  updatedAt: number | null;
  errors: readonly OpsErrorGroup[] | null;
  alerts: OpsAlerts | null;
}) {
  const { ut } = useLang();
  const loc = locale();
  const now = updatedAt ?? Date.now();
  const overall = overallOf(d.health);
  const notOk = d.health.filter((c) => c.status !== "ok");
  const firing = alerts?.rules.filter((r) => r.enabled && r.state === "firing") ?? [];
  const fresh = errors ? freshGroups(errors, now) : [];
  const attention = notOk.length + firing.length + (fresh.length ? 1 : 0);
  const okChecks = d.health.length - notOk.length;
  const alertWord = !alerts
    ? ut("opx.ov.alertsUnknown")
    : firing.length
      ? fill(ut("opx.ov.alertsFiring"), { n: firing.length })
      : ut("opx.ov.alertsQuiet");

  /* версия и коммит — только заданные: «не задано» дважды в строке читалось бы как сбой; оно есть в «Збірці» */
  const facts: [OpsIconName, ReactNode][] = [
    ["server", window.location.host],
    ...(d.build.version ? [["rocket", <Mono key="v" className="font-bold">{d.build.version}</Mono>] as [OpsIconName, ReactNode]] : []),
    ...(d.build.commit ? [["git-commit-horizontal", <Mono key="c">{d.build.commit}</Mono>] as [OpsIconName, ReactNode]] : []),
    ["cpu", d.build.runtime],
    [
      "clock",
      fill(ut("opx.ov.process"), { time: sinceText(d.since, loc), uptime: fmtUptime(d.process.uptimeSec, loc) }),
    ],
  ];

  return (
    <section aria-label={ut("opx.ov.systemLabel")} className="rounded-panel border border-border bg-panel px-4 pb-3.5 pt-4 shadow-panel">
      <div className="flex items-start gap-3">
        <IconTile
          size={40}
          tone={overall === "ok" ? "good" : "warn"}
          icon={<OpsIcon name={overall === "ok" ? "circle-check" : overall === "warn" ? "triangle-alert" : "octagon-x"} />}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="m-0 text-big font-extrabold leading-7 tracking-[-0.02em] text-text">{ut(overallKey(d.health, "word"))}</h2>
            <Tag tone={d.build.env === "production" ? "good" : "info"} icon={<OpsIcon name="check" />}>
              {ut(d.build.env === "production" ? "opx.ov.envProduction" : "opx.ov.envDevelopment")}
            </Tag>
          </div>
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-[13px] leading-[18px] text-text-2">
            {facts.map(([icon, text]) => (
              <span key={icon} className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                <OpsIcon name={icon} size={15} className="text-muted" />
                <span className="min-w-0 truncate">{text}</span>
              </span>
            ))}
          </div>
        </div>
        <span className="shrink-0 self-start max-[900px]:hidden">
          <Live pollSec={POLL_MS / 1000} updatedAt={updatedAt} />
        </span>
      </div>

      {attention ? (
        <>
          <div className="mt-4 flex items-center gap-2">
            <span className="whitespace-nowrap text-caption font-bold text-muted">{fill(ut("opx.ov.attention"), { n: attention })}</span>
          </div>
          <AlertStrip label={ut("opx.ov.attentionLabel")} className="mt-2">
            {fresh.length ? (
              <AlertChip
                kind="warn"
                icon={<OpsIcon name="bug" />}
                label={fresh.length === 1 ? ut("opx.ov.newGroup") : fill(ut("opx.ov.newGroups"), { n: fresh.length })}
                detail={fill(ut("opx.ov.casesHour"), { n: fmtInt(fresh.reduce((s, g) => s + g.count, 0), loc) })}
                to="/ops/errors"
                popTitle={ut("opx.ov.newGroupsTitle")}
                pop={
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {fresh.slice(0, 3).map((g) => (
                      <li key={g.fingerprint} className="min-w-0 truncate">
                        <Mono className="font-bold">{g.name}</Mono> <span className="text-text-2">{g.message}</span>
                      </li>
                    ))}
                  </ul>
                }
              />
            ) : null}
            {firing.map((r) => (
              <AlertChip
                key={r.key}
                kind="warn"
                icon={<OpsIcon name="bell-ring" />}
                label={ut(RULE_NAME[r.key])}
                detail={r.firingSince ? fill(ut("opx.ov.since"), { time: hhmm(r.firingSince, loc) }) : undefined}
                to="/ops/alerts"
                popTitle={ut("opx.ov.ruleFiring")}
                pop={<span>{ut("opx.ov.ruleFiringHint")}</span>}
              />
            ))}
            {notOk.map((c) => {
              const reason = healthReason(c);
              return (
                <AlertChip
                  key={c.key}
                  kind={c.status === "ok" ? "neutral" : "warn"}
                  icon={<OpsIcon name={c.status === "fail" ? "octagon-x" : "triangle-alert"} />}
                  label={ut(HEALTH_NAME[c.key])}
                  detail={ut(STATUS_KEY[c.status])}
                  onClick={() => document.getElementById("ops-checks")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  popTitle={ut(HEALTH_NAME[c.key])}
                  pop={reason ? <span>{fill(ut(reason), { n: healthValue(c, loc) })}</span> : undefined}
                />
              );
            })}
          </AlertStrip>
        </>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-small text-text-2">
        <OpsIcon name="circle-check" size={15} className="text-good" />
        <span className="min-w-0">
          {fill(ut(attention ? "opx.ov.restOk" : "opx.ov.allOk"), { ok: okChecks, n: d.health.length, alerts: alertWord })}
        </span>
        {updatedAt !== null ? (
          <span className="ml-auto whitespace-nowrap text-muted">{fill(ut("opx.ov.assessed"), { time: hhmm(new Date(updatedAt).toISOString(), loc) })}</span>
        ) : null}
      </div>
    </section>
  );
}

/* ─────────── показники ─────────── */

/**
 * Часовые суммы за последние `hours` часов из суточного ряда (корзины по
 * 15 минут), старые первыми. null — час не целиком при живом процессе:
 * процесс тогда ещё не работал, и «0» был бы неправдой.
 */
export function hourlyFrom(day: OpsTraffic, hours: number): (number | null)[] {
  const per = Math.max(1, Math.round(3600 / day.stepSec));
  const since = Date.parse(day.since);
  const out: (number | null)[] = [];
  const b = day.buckets;
  for (let h = hours - 1; h >= 0; h--) {
    const end = b.length - h * per;
    const part = b.slice(Math.max(0, end - per), end);
    if (part.length < per || Date.parse(part[0]!.at) < since - day.stepSec * 1000) out.push(null);
    else out.push(part.reduce((s, x) => s + x.requests, 0));
  }
  return out;
}

/** p95 корзин суточного ряда за последние `hours` часов — ход, а не сумма: перцентили не складываются */
function p95Run(day: OpsTraffic, hours: number): number[] {
  const per = Math.max(1, Math.round(3600 / day.stepSec));
  return day.buckets
    .slice(-hours * per)
    .map((x: OpsTrafficBucket) => x.p95)
    .filter((v): v is number => v !== null);
}

function metricRows(d: OpsOverview, day: OpsTraffic | null, alerts: OpsAlerts | null, ut: (k: UiKey) => string): MetricRow[] {
  const loc = locale();
  const h1 = d.traffic.h1;
  const hours = day ? hourlyFrom(day, 6) : [];
  const known = hours.filter((v): v is number => v !== null);
  const sixAgo = hours[0] ?? null;
  const p95s = day ? p95Run(day, 6) : [];
  const limit = fmtShare(SHARE_5XX_LIMIT, loc);
  const p95Rule = alerts?.rules.find((r) => r.key === "p95") ?? null;
  const heapShare = d.process.heapTotalBytes ? d.process.heapUsedBytes / d.process.heapTotalBytes : null;
  const conn = d.db.connections;
  const free = conn?.max ? conn.max - conn.total : null;

  return [
    {
      key: "requests",
      label: ut("ops.kpi.requests"),
      now: fmtInt(h1.requests, loc),
      spark: known.length > 1 ? known : undefined,
      compare: fill(ut("ops.kpi.requestsHint"), { m5: fmtInt(d.traffic.m5.requests, loc), h24: fmtInt(d.traffic.h24.requests, loc) }),
      state:
        sixAgo !== null ? (
          <Was>{fill(ut("opx.ov.hoursAgo"), { h: 6, v: fmtInt(sixAgo, loc) })}</Was>
        ) : (
          <Was>{ut("opx.ov.noEarlier")}</Was>
        ),
    },
    {
      key: "share5xx",
      label: ut("ops.kpi.share5xx"),
      now: fmtShare(h1.share5xx, loc),
      compare: fill(ut("opx.ov.errors5xx"), { n: fmtInt(h1.errors5xx, loc), total: fmtInt(h1.requests, loc) }),
      state:
        h1.share5xx === null ? (
          <StatusMark tone="quiet">{ut("ops.health.errorRate.quiet")}</StatusMark>
        ) : h1.share5xx > SHARE_5XX_LIMIT ? (
          <StatusMark tone="warn">{fill(ut("opx.ov.aboveLimit"), { v: limit })}</StatusMark>
        ) : (
          <StatusMark tone="ok">{fill(ut("opx.ov.belowLimit"), { v: limit })}</StatusMark>
        ),
    },
    {
      key: "p95",
      label: ut("opx.ov.p95"),
      now: fmtMs(h1.p95, loc),
      spark: p95s.length > 1 ? p95s : undefined,
      compare: fill(ut("opx.ov.p95Compare"), { p50: fmtMs(h1.p50, loc), max: fmtMs(h1.maxMs, loc) }),
      state:
        !p95Rule || !p95Rule.enabled || p95Rule.threshold === null ? (
          <StatusMark tone="quiet">{ut("opx.ov.alertOff")}</StatusMark>
        ) : h1.p95 !== null && h1.p95 > p95Rule.threshold ? (
          <StatusMark tone="warn">{fill(ut("opx.ov.alertAbove"), { v: fmtMs(p95Rule.threshold, loc) })}</StatusMark>
        ) : (
          <StatusMark tone="ok">{fill(ut("opx.ov.alertLimit"), { v: fmtMs(p95Rule.threshold, loc) })}</StatusMark>
        ),
    },
    {
      key: "uptime",
      label: ut("ops.kpi.uptime"),
      now: fmtUptime(d.process.uptimeSec, loc),
      compare: fill(ut("ops.kpi.uptimeHint"), { time: sinceText(d.since, loc) }),
      state: <Was>{d.build.version ? fill(ut("opx.ov.release"), { v: d.build.version }) : ut("opx.ov.releaseUnset")}</Was>,
    },
    {
      key: "memory",
      label: ut("ops.kpi.memory"),
      now: fmtBytes(d.process.rssBytes, loc),
      compare: fill(ut("ops.kpi.memoryHint"), { used: fmtBytes(d.process.heapUsedBytes, loc), total: fmtBytes(d.process.heapTotalBytes, loc) }),
      state:
        heapShare === null ? (
          <Was>—</Was>
        ) : (
          <StatusMark tone={heapShare >= 0.9 ? "warn" : "ok"}>{fill(ut("opx.ov.heapUsed"), { v: fmtShare(heapShare, loc) })}</StatusMark>
        ),
    },
    {
      key: "conn",
      label: ut("ops.kpi.dbConn"),
      now: conn ? fmtInt(conn.total, loc) : "—",
      compare: conn?.max ? fill(ut("ops.kpi.dbConnHint"), { max: fmtInt(conn.max, loc) }) : ut("ops.kpi.dbConnHidden"),
      state:
        free === null || !conn?.max ? (
          <Was>—</Was>
        ) : (
          <StatusMark tone={free < conn.max * 0.1 ? "warn" : "ok"}>{fill(ut("opx.ov.headroom"), { n: fmtInt(free, loc) })}</StatusMark>
        ),
    },
  ];
}

/* ─────────── нагрузка ─────────── */

/** Отметка запуска процесса на оси, если он внутри окна: после неё ряд начинается заново */
function startMark(buckets: readonly OpsTrafficBucket[], since: string, label: string): TimeLineMark[] {
  const t = Date.parse(since);
  if (!buckets.length || t <= Date.parse(buckets[0]!.at)) return [];
  let at: string | null = null;
  for (const b of buckets) if (Date.parse(b.at) <= t) at = b.at;
  return at ? [{ at, label }] : [];
}

function LoadPanel({
  win,
  onWindow,
  traffic,
  error,
  onRetry,
  d,
}: {
  win: "1h" | "6h" | "24h";
  onWindow: (w: string) => void;
  traffic: OpsTraffic | null;
  error: string | null;
  onRetry: () => void;
  d: OpsOverview;
}) {
  const { ut } = useLang();
  const loc = locale();
  const first = traffic?.buckets[0];
  const last = traffic?.buckets.at(-1);
  const sub =
    traffic && first && last
      ? fill(ut("opx.ov.loadSub"), {
          from: hhmm(first.at, loc),
          to: hhmm(new Date(Date.parse(last.at) + traffic.stepSec * 1000).toISOString(), loc),
          step: fmtUptime(traffic.stepSec, loc),
        })
      : undefined;
  return (
    <Panel
      title={ut("ops.traffic.title")}
      icon={<OpsIcon name="chart-column" />}
      sub={sub}
      actions={
        <Segmented
          label={ut("ops.traffic.window")}
          value={win}
          onChange={(w) => onWindow(w)}
          items={[
            { key: "1h", label: ut("ops.window.1h") },
            { key: "6h", label: ut("ops.window.6h") },
            { key: "24h", label: ut("ops.window.24h") },
          ]}
        />
      }
      footer={<SinceNote since={d.since} />}
    >
      {error && !traffic ? (
        <Loading bare error={error} onRetry={onRetry} />
      ) : !traffic ? (
        <Loading bare rows={3} />
      ) : (
        <TrafficCharts
          buckets={traffic.buckets}
          stepSec={traffic.stepSec}
          since={traffic.since}
          marks={startMark(traffic.buckets, d.since, d.build.version ?? ut("opx.mark.start"))}
        />
      )}
    </Panel>
  );
}

/* ─────────── перевірки ─────────── */

/** Число в пояснении проверки — в своей единице: миллисекунды, проценты, штуки */
function healthValue(c: OpsHealthCheck, loc: string): string {
  if (c.value === null || c.value === undefined) return "";
  if (c.key === "db") return fmtMs(c.value, loc);
  if (c.key === "errorRate") return fmtShare(c.value / 100, loc);
  return fmtInt(c.value, loc);
}

function ChecksPanel({ d, onCheck }: { d: OpsOverview; onCheck: () => void }) {
  const { ut } = useLang();
  const toast = useToast();
  const loc = locale();
  const ok = d.health.filter((c) => c.status === "ok").length;
  return (
    <Panel
      id="ops-checks"
      title={ut("ops.health.title")}
      icon={<OpsIcon name="list-checks" />}
      sub={fill(ut("opx.ov.checksOk"), { ok, n: d.health.length })}
      actions={
        <Button
          variant="ghost"
          size="xs"
          icon={<OpsIcon name="refresh-cw" />}
          onClick={() => {
            onCheck();
            toast(fill(ut("opx.ov.checksRun"), { time: hhmm(new Date().toISOString(), loc) }), "ok");
          }}
        >
          {ut("opx.ov.checkNow")}
        </Button>
      }
      footer={<PanelNote icon="lock">{ut("ops.health.hint")}</PanelNote>}
    >
      <ul className="m-0 list-none p-0">
        {d.health.map((c) => {
          const reason = healthReason(c);
          return (
            <li
              key={c.key}
              className="grid min-h-11 grid-cols-[minmax(0,180px)_150px_minmax(0,1fr)] items-center gap-3 border-t border-divider py-1.5 text-[13px] leading-[18px] first:border-t-0 max-[700px]:grid-cols-[minmax(0,1fr)_auto]"
            >
              <b className="min-w-0 font-bold text-text">{ut(HEALTH_NAME[c.key])}</b>
              <StatusMark tone={TONE[c.status]}>{ut(STATUS_KEY[c.status])}</StatusMark>
              <span className="min-w-0 text-small text-text-2 max-[700px]:col-span-2">
                {reason ? fill(ut(reason), { n: healthValue(c, loc) }) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ─────────── стан для людей ─────────── */

const STATUS_TILE: Record<ServiceStatus, "good" | "warn"> = { ok: "good", degraded: "warn", maintenance: "warn" };
const STATUS_LINE: Record<ServiceStatus, UiKey> = {
  ok: "opx.ov.peopleOk",
  degraded: "opx.ov.peopleDegraded",
  maintenance: "opx.ov.peopleMaintenance",
};

function PeoplePanel({ alerts }: { alerts: OpsAlerts | null }) {
  const { ut } = useLang();
  const { can } = useAuth();
  const loc = locale();
  const manage = can("ops.manage");
  const status = useOpsResource(() => api.opsStatus(), [], SLOW_POLL_MS);
  const history = useResource(() => api.opsAlertHistory(), []);
  const flags = useResource(() => api.opsFlags(), []);
  const [open, setOpen] = useState(false);

  const s = status.data;
  const cur = s?.current.status ?? "ok";
  const rules = alerts?.rules.filter((r) => r.enabled) ?? [];
  const rulesOk = rules.filter((r) => r.state === "ok").length;
  const lastFired = history.data?.items.find((e) => e.kind === "fired") ?? null;
  const flagItems = flags.data?.items ?? null;
  const flagsOn = flagItems?.filter((f) => f.enabled).length ?? 0;
  const nobody = flagItems?.filter((f) => enabledForNobody(f.enabled, f.audience)).length ?? 0;

  return (
    <Panel title={ut("opx.ov.people")} icon={<OpsIcon name="monitor-check" />}>
      {!s ? (
        <Loading bare rows={3} error={status.error} onRetry={status.reload} />
      ) : (
        <>
          <div className="flex items-start gap-3">
            <IconTile tone={STATUS_TILE[cur]} icon={<OpsIcon name={cur === "ok" ? "users" : "construction"} />} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <b className="text-h3 font-extrabold text-text">{ut(`svc.status.${cur}`)}</b>
              <span className="text-small text-muted">{ut(STATUS_LINE[cur])}</span>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            {manage ? (
              <Button className="flex-1 px-3" icon={<OpsIcon name="megaphone" />} aria-expanded={open} onClick={() => setOpen(true)}>
                {ut("opx.ov.announce")}
              </Button>
            ) : null}
            <ButtonLink to="/ops/maintenance" className="flex-1 px-3">
              <OpsIcon name="construction" size={15} />
              {ut("ops.tab.maintenance")}
            </ButtonLink>
          </div>
          <div className="mt-4 border-t border-divider pt-3">
            <KV
              w={150}
              rows={[
                [ut("opx.ov.lastAnnounce"), s.history[0] ? dateTime(s.history[0].at) : ut("svc.noHistory")],
                [
                  ut("opx.ov.alerts"),
                  !alerts ? (
                    "—"
                  ) : rules.length ? (
                    <StatusMark tone={rulesOk === rules.length ? "ok" : "warn"}>
                      {fill(ut("opx.ov.rulesOk"), { ok: rulesOk, n: rules.length })}
                    </StatusMark>
                  ) : (
                    <StatusMark tone="quiet">{ut("opx.ov.rulesNone")}</StatusMark>
                  ),
                ],
                [ut("opx.ov.lastFired"), lastFired ? dateTime(lastFired.at) : ut("ops.never")],
                [
                  ut("opx.ov.flags"),
                  flagItems === null
                    ? "—"
                    : nobody
                      ? fill(ut("opx.ov.flagsNobody"), { n: flagsOn, nobody })
                      : fill(ut("opx.ov.flagsOn"), { n: flagsOn }),
                ],
              ]}
            />
          </div>
          {manage ? (
            <AnnounceDrawer
              open={open}
              onClose={() => setOpen(false)}
              onReturn={() => setOpen(true)}
              last={s.history[0] ? `${dateTime(s.history[0].at)}, ${ut(`svc.status.${s.history[0].status}`)}` : ut("svc.noHistory")}
              onDone={() => status.reload()}
            />
          ) : null}
          {s.current.since && cur !== "ok" ? (
            <p className="m-0 mt-3 text-caption text-muted">{fill(ut("opx.ov.statusSince"), { time: fmtAgo(s.current.since, Date.now(), loc) })}</p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

/**
 * Объявление о сбоях — в ящике, страница остаётся на месте. Сбой
 * сохранения не закрывает: люди видят баннер, изменения сохраняются;
 * «Працює» баннер снимает. Режим обслуживания — на своей странице: он
 * закрывает запись всем и требует подтверждения.
 */
function AnnounceDrawer({
  open,
  onClose,
  onReturn,
  last,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onReturn: () => void;
  last: string;
  onDone: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [kind, setKind] = useState<"degraded" | "ok">("degraded");
  const [note, setNote] = useState("");
  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      title={ut("mt.announce")}
      sub={ut("opx.ov.announceSub")}
      icon={<OpsIcon name="megaphone" />}
      dirty={note.trim() !== ""}
      draftName={ut("opx.ov.announceDraft")}
      note={ut("opx.ov.announceNote")}
      noteIcon={<OpsIcon name="history" />}
      footer={
        <>
          <Button
            variant="primary"
            icon={<OpsIcon name="megaphone" />}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.opsAnnounce({ status: kind, message: note.trim() || null, expectedEnd: null });
                setNote("");
                onDone();
                onClose();
                // баннер этой же вкладки — сразу, а не через две минуты опроса
                await refreshServiceStatus();
              }, ut("mt.done"))
            }
          >
            {ut("mt.publish")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <DrawerSection title={ut("mt.status")}>
        <div className="flex flex-col gap-3">
          <Field label={ut("mt.status")} hint={ut("opx.ov.okHint")}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as "ok" | "degraded")}>
              <option value="degraded">{ut("svc.status.degraded")}</option>
              <option value="ok">{ut("svc.status.ok")}</option>
            </Select>
          </Field>
          <Field label={ut("mt.message")}>
            <Textarea
              rows={4}
              maxLength={500}
              value={note}
              placeholder={ut("opx.ov.messagePh")}
              onChange={(e) => setNote(e.target.value)}
              data-autofocus
            />
          </Field>
        </div>
      </DrawerSection>
      <DrawerSection title={ut("opx.ov.now")}>
        <KV
          w={96}
          rows={[
            [ut("opx.ov.last"), last],
            [ut("opx.ov.seen"), ut("opx.ov.seenWhere")],
          ]}
        />
      </DrawerSection>
    </Drawer>
  );
}

/* ─────────── збірка, база ─────────── */

function BuildPanel({ d }: { d: OpsOverview }) {
  const { ut } = useLang();
  const loc = locale();
  const unset = <span className="text-muted">{ut("ops.build.unset")}</span>;
  const lag = d.process.eventLoopLagMs;
  return (
    <Panel
      title={ut("ops.build.title")}
      icon={<OpsIcon name="package" />}
      actions={<HeadLink to="/ops/releases">{ut("ops.tab.releases")}</HeadLink>}
    >
      <Facts
        items={[
          [
            ut("ops.build.version"),
            d.build.version ? (
              <span className="flex items-center gap-2">
                <Mono className="font-bold">{d.build.version}</Mono>
                <Tag tone="good" icon={<OpsIcon name="check" />}>
                  {ut("opx.ov.current")}
                </Tag>
              </span>
            ) : (
              unset
            ),
          ],
          [ut("ops.build.commit"), d.build.commit ? <Mono>{d.build.commit}</Mono> : unset],
          [ut("ops.build.package"), <Mono key="p">{d.build.packageVersion}</Mono>],
          [ut("ops.build.env"), ut(d.build.env === "production" ? "ops.env.production" : "ops.env.development")],
          [ut("ops.build.runtime"), <Mono key="r">{d.build.runtime}</Mono>],
          [ut("ops.build.started"), dateTime(d.build.startedAt)],
          [
            ut("ops.proc.load"),
            <span key="l">
              <Mono>{d.process.loadAvg.map((v) => v.toLocaleString(loc, { maximumFractionDigits: 2 })).join("  ")}</Mono>{" "}
              <span className="text-muted">{fill(ut("ops.proc.cpus"), { n: d.process.cpus })}</span>
            </span>,
          ],
          [
            ut("ops.proc.lag"),
            lag.mean === null ? (
              <span className="text-muted">{ut("ops.proc.lagNone")}</span>
            ) : (
              fill(ut("ops.proc.lagValue"), { mean: fmtMs(lag.mean, loc), max: fmtMs(lag.max, loc) })
            ),
          ],
        ]}
      />
    </Panel>
  );
}

function DataPanel({ d }: { d: OpsOverview }) {
  const { ut } = useLang();
  const loc = locale();
  const now = Date.now();
  const s = d.scheduler;
  return (
    <Panel title={ut("ops.data.title")} icon={<OpsIcon name="database" />} actions={<HeadLink to="/ops/db">{ut("ops.tab.db")}</HeadLink>}>
      <Facts
        items={[
          [ut("ops.data.size"), fmtBytes(d.db.bytes, loc)],
          [ut("ops.data.latency"), fmtMs(d.db.latencyMs, loc)],
          [
            ut("ops.data.migration"),
            <span key="m" className="flex min-w-0 flex-wrap items-center gap-x-3">
              <Mono className="truncate">{d.db.lastMigration?.tag ?? "—"}</Mono>
              {d.db.pendingMigrations ? <StatusMark tone="fail">{fill(ut("ops.data.pending"), { n: d.db.pendingMigrations })}</StatusMark> : null}
            </span>,
          ],
          [
            ut("ops.data.tick"),
            !s.enabled ? (
              <span key="t" className="text-muted">
                {ut("ops.data.tickOff")}
              </span>
            ) : s.lastTickAt ? (
              <span key="t" title={dateTime(s.lastTickAt)}>
                {fmtAgo(s.lastTickAt, now, loc)}
              </span>
            ) : (
              <span key="t" className="text-muted">
                {ut("ops.never")}
              </span>
            ),
          ],
          [
            ut("ops.data.cases"),
            <span key="c" className="flex items-center gap-2">
              <b className="font-extrabold">{fmtInt(d.openCases, loc)}</b>
              <HeadLink to="/cases" plain>
                {ut("opx.ov.cases")}
              </HeadLink>
            </span>,
          ],
          [ut("ops.data.accounts"), d.accounts ? <AccountsShare key="a" accounts={d.accounts} /> : "—"],
        ]}
      />
    </Panel>
  );
}

/** Ссылка в шапке панели: «Випуски ↗», «База ↗» */
function HeadLink({ to, children, plain }: { to: string; children: ReactNode; plain?: boolean }) {
  return (
    <ButtonLink to={to} variant="ghost" size="xs" className={plain ? "-ml-2" : undefined}>
      {children}
      {plain ? null : <OpsIcon name="arrow-up-right" size={14} />}
    </ButtonLink>
  );
}
