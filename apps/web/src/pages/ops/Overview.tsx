import type { OpsHealthCheck, OpsOverview } from "@quizzy/shared";
import { api } from "../../api";
import { Kpi } from "../../charts/clinical";
import { dateTime, locale } from "../../format";
import { useLang } from "../../lang";
import { Loading, useUrlState } from "../../ui";
import { Num } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { fill } from "../dashboard/model";
import { PeriodSwitch } from "../dashboard/parts";
import { AccountsShare, TrafficCharts } from "./charts";
import { HEALTH_NAME, STATUS_KEY, fmtAgo, fmtBytes, fmtInt, fmtMs, fmtShare, fmtUptime, healthReason, parseWindow } from "./model";
import { Facts, Stamp, StatusMark, type Tone, useOpsResource } from "./parts";

/*
 * Огляд техпанели: «жива ли система и как ей сейчас».
 *
 * Сверху — шесть чисел, которые читают первыми (запросы за час, доля 5xx,
 * p95, время работы, память, подключения к базе). Под ними — нагрузка за
 * час или сутки (волна 11, pages/ops/charts.tsx): запросы столбцами по
 * классам ответа, время ответа тремя перцентилями, доля пятисоток с порогом
 * и состав ответов за окно. Дальше проверки здоровья словами и сведения о
 * сборке и базе; учётки по ролям — полосой долей.
 *
 * Обновляется сам раз в двадцать секунд, пока вкладка открыта; окно
 * графика — в адресе (?window=24h), ссылку «вот так было сутки» пересылают.
 */

const POLL_MS = 20_000;

const TONE: Record<OpsHealthCheck["status"], Tone> = { ok: "ok", warn: "warn", fail: "fail" };

export default function OpsOverview() {
  const { ut } = useLang();
  const loc = locale();
  const [rawWindow, setWindow] = useUrlState("window", "1h");
  const win = parseWindow(rawWindow);

  const ov = useOpsResource(() => api.opsOverview(), [], POLL_MS);
  const traffic = useOpsResource(() => api.opsTraffic(win), [win], POLL_MS);

  if (ov.error && !ov.data) return <Loading error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <Loading rows={6} />;
  const d = ov.data;
  const h1 = d.traffic.h1;

  return (
    <div>
      <Stamp since={d.since} updatedAt={ov.updatedAt} />

      <div className="mt-[16px] grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-[16px]">
        <Kpi
          label={ut("ops.kpi.requests")}
          value={fmtInt(h1.requests, loc)}
          hint={fill(ut("ops.kpi.requestsHint"), {
            m5: fmtInt(d.traffic.m5.requests, loc),
            h24: fmtInt(d.traffic.h24.requests, loc),
          })}
        />
        {/* янтарь — только когда пятисоток больше процента: тот же порог, что у оповещения в RUNBOOK */}
        <Kpi
          label={ut("ops.kpi.share5xx")}
          value={fmtShare(h1.share5xx, loc)}
          tone={h1.share5xx !== null && h1.share5xx > 0.01 ? "attention" : "plain"}
          hint={fill(ut("ops.kpi.share5xxHint"), { n: fmtInt(h1.errors5xx, loc) })}
        />
        <Kpi
          label={ut("ops.kpi.p95")}
          value={fmtMs(h1.p95, loc)}
          hint={fill(ut("ops.kpi.p95Hint"), { p50: fmtMs(h1.p50, loc), max: fmtMs(h1.maxMs, loc) })}
        />
        <Kpi
          label={ut("ops.kpi.uptime")}
          value={fmtUptime(d.process.uptimeSec, loc)}
          hint={fill(ut("ops.kpi.uptimeHint"), { time: dateTime(d.build.startedAt) })}
        />
        <Kpi
          label={ut("ops.kpi.memory")}
          value={fmtBytes(d.process.rssBytes, loc)}
          hint={fill(ut("ops.kpi.memoryHint"), {
            used: fmtBytes(d.process.heapUsedBytes, loc),
            total: fmtBytes(d.process.heapTotalBytes, loc),
          })}
        />
        <Kpi
          label={ut("ops.kpi.dbConn")}
          value={d.db.connections ? fmtInt(d.db.connections.total, loc) : null}
          hint={
            d.db.connections?.max
              ? fill(ut("ops.kpi.dbConnHint"), { max: fmtInt(d.db.connections.max, loc) })
              : ut("ops.kpi.dbConnHidden")
          }
        />
      </div>

      <RuleSection
        className="mt-[32px]"
        title={ut("ops.traffic.title")}
        actions={
          <PeriodSwitch
            label={ut("ops.traffic.window")}
            value={win}
            onChange={(w) => setWindow(w)}
            options={[
              ["1h", ut("ops.window.1h")],
              ["24h", ut("ops.window.24h")],
            ]}
          />
        }
      >
        {traffic.error && !traffic.data ? (
          <Loading error={traffic.error} onRetry={traffic.reload} />
        ) : !traffic.data ? (
          <Loading rows={3} />
        ) : (
          <TrafficCharts buckets={traffic.data.buckets} stepSec={traffic.data.stepSec} since={traffic.data.since} />
        )}
      </RuleSection>

      <RuleSection title={ut("ops.health.title")} hint={ut("ops.health.hint")}>
        <Health checks={d.health} />
      </RuleSection>

      <div className="grid grid-cols-1 gap-x-[45px] min-[900px]:grid-cols-2">
        <RuleSection title={ut("ops.build.title")}>
          <Build d={d} />
        </RuleSection>
        <RuleSection title={ut("ops.data.title")}>
          <DataFacts d={d} />
        </RuleSection>
      </div>
    </div>
  );
}

function Health({ checks }: { checks: readonly OpsHealthCheck[] }) {
  const { ut } = useLang();
  const loc = locale();

  /* число в пояснении — в своей единице: миллисекунды, проценты, штуки */
  const valueOf = (c: OpsHealthCheck): string => {
    if (c.value === null || c.value === undefined) return "";
    if (c.key === "db") return fmtMs(c.value, loc);
    if (c.key === "errorRate") return fmtShare(c.value / 100, loc);
    return fmtInt(c.value, loc);
  };

  return (
    <ul className="m-0 list-none p-0">
      {checks.map((c) => {
        const reason = healthReason(c);
        return (
          <li
            key={c.key}
            className="grid min-h-[44px] grid-cols-[minmax(0,240px)_150px_minmax(0,1fr)] items-center gap-x-[16px] border-b border-hairline py-[8px] max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:gap-y-[4px]"
          >
            <span className="min-w-0 text-[15px] font-bold leading-[19px] text-primary">{ut(HEALTH_NAME[c.key])}</span>
            <StatusMark tone={TONE[c.status]}>{ut(STATUS_KEY[c.status])}</StatusMark>
            <span className="min-w-0 text-[13px] leading-[18px] text-muted max-[700px]:col-span-2">
              {reason ? fill(ut(reason), { n: valueOf(c) }) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Build({ d }: { d: OpsOverview }) {
  const { ut } = useLang();
  const loc = locale();
  const unset = <span className="text-muted">{ut("ops.build.unset")}</span>;
  const lag = d.process.eventLoopLagMs;
  return (
    <Facts
      items={[
        [ut("ops.build.version"), d.build.version ? <Num>{d.build.version}</Num> : unset],
        [ut("ops.build.commit"), d.build.commit ? <Num>{d.build.commit}</Num> : unset],
        [ut("ops.build.package"), <Num key="p">{d.build.packageVersion}</Num>],
        [ut("ops.build.env"), ut(d.build.env === "production" ? "ops.env.production" : "ops.env.development")],
        [ut("ops.build.runtime"), <Num key="r">{d.build.runtime}</Num>],
        [ut("ops.build.started"), dateTime(d.build.startedAt)],
        [
          ut("ops.proc.load"),
          <span key="l">
            <Num>{d.process.loadAvg.join(" · ")}</Num>{" "}
            <span className="text-muted">{fill(ut("ops.proc.cpus"), { n: d.process.cpus })}</span>
          </span>,
        ],
        [
          ut("ops.proc.lag"),
          lag.mean === null ? (
            <span className="text-muted">{ut("ops.proc.lagNone")}</span>
          ) : (
            <Num>{fill(ut("ops.proc.lagValue"), { mean: fmtMs(lag.mean, loc), max: fmtMs(lag.max, loc) })}</Num>
          ),
        ],
      ]}
    />
  );
}

function DataFacts({ d }: { d: OpsOverview }) {
  const { ut } = useLang();
  const loc = locale();
  const now = Date.now();
  const s = d.scheduler;
  return (
    <Facts
      items={[
        [ut("ops.data.size"), <Num key="s">{fmtBytes(d.db.bytes, loc)}</Num>],
        [ut("ops.data.latency"), <Num key="l">{fmtMs(d.db.latencyMs, loc)}</Num>],
        [
          ut("ops.data.migration"),
          <span key="m" className="flex min-w-0 flex-wrap items-center gap-x-[12px]">
            <Num className="truncate">{d.db.lastMigration?.tag ?? "—"}</Num>
            {d.db.pendingMigrations ? (
              <StatusMark tone="fail">{fill(ut("ops.data.pending"), { n: d.db.pendingMigrations })}</StatusMark>
            ) : null}
          </span>,
        ],
        [
          ut("ops.data.tick"),
          !s.enabled ? (
            <span key="t" className="text-muted">{ut("ops.data.tickOff")}</span>
          ) : s.lastTickAt ? (
            <span key="t" title={dateTime(s.lastTickAt)}>{fmtAgo(s.lastTickAt, now, loc)}</span>
          ) : (
            <span key="t" className="text-muted">{ut("ops.never")}</span>
          ),
        ],
        [ut("ops.data.cases"), <Num key="c">{fmtInt(d.openCases, loc)}</Num>],
        [
          ut("ops.data.accounts"),
          /* полосой долей (волна 11): «сколько пациентов на одного специалиста» видно длиной, числа — в легенде */
          d.accounts ? <AccountsShare key="a" accounts={d.accounts} /> : "—",
        ],
      ]}
    />
  );
}
