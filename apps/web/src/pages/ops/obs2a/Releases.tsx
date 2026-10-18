import { useMemo } from "react";
import type { OpsCompareStats, OpsReleaseCompare, OpsRouteCompare, OpsShift } from "@quizzy/shared";
import { api } from "../../../api";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { DataTable, FilterBar, Loading, ViewPills, useUrlState, type Column } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { Button, ButtonLink, Select, Switch } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { OpsIcon } from "../icons";
import { fmtInt, fmtMs, fmtShare } from "../model";
import { CopyLinkButton, MethodRoute, Mono, OpsHead, OpsToolbar, PanelNote, Quiet, StatusMark } from "../parts";
import { ReleaseCharts } from "./charts";
import {
  SHIFT_KEY,
  SHIFT_TONE,
  defaultPair,
  filterCompare,
  fmtSignedMs,
  fmtSignedPct,
  fmtSignedPp,
  onlyWorse,
  p95Delta,
  p95Ratio,
  shareDelta,
} from "./model";

/*
 * Порівняння випусків: что стало с маршрутами после выкатки.
 *
 * Решение заказчика 2026-09-26: «время ответа и ошибки по маршрутам за час
 * до и после выкатки». Выкатка — смена версии (QUIZZY_VERSION) в суммах
 * запросов; сервер берёт последний час старой версии и первый час новой
 * (apps/api/src/lib/opsReleases.ts) и выставляет сдвиг по порогам.
 *
 * Пара версий — в адресе (?before=&after=), по умолчанию — версия этого
 * процесса и предыдущая. «Лише погіршення» (?worse=1), вид по сдвигу
 * (?shift=) и поиск (?q=) — тоже в адресе: ссылку «вот что сломала
 * выкатка» пересылают.
 *
 * Сдвиг — словом и формой значка, а не цветом: «гірше» янтарём (требует
 * внимания), «краще» — зелёным, «без змін» и «замало запитів» — тихо.
 * Где запросов меньше порога, процентов нет вовсе: «+300 %» от трёх
 * запросов — шум, и экран не должен выдавать его за вывод.
 *
 * Над таблицей — окна сравнения и самые большие сдвиги парами полос «було /
 * стало» по всей паре окон: поиск и фильтры сужают только таблицу.
 */

type ShiftView = "all" | OpsShift;
const SHIFT_VIEWS: readonly ShiftView[] = ["all", "worse", "better", "same", "few"];
const parseShift = (v: string): ShiftView => (SHIFT_VIEWS.includes(v as ShiftView) ? (v as ShiftView) : "all");

export default function OpsReleasesPage() {
  const { ut } = useLang();
  const loc = locale();
  const [rawBefore, setBefore] = useUrlState("before", "");
  const [rawAfter, setAfter] = useUrlState("after", "");
  const [worse, setWorse] = useUrlState("worse", "");
  const [rawShift, setShift] = useUrlState("shift", "all");
  const [q, setQ] = useUrlState("q", "");
  const shiftView = parseShift(rawShift);

  const list = useResource(() => api.opsReleaseVersions(), []);
  const pair = useMemo(
    () => (list.data ? defaultPair(list.data.items, list.data.current) : { before: null, after: null }),
    [list.data],
  );
  const before = rawBefore || pair.before || "";
  const after = rawAfter || pair.after || "";

  const cmp = useResource(
    () => api.opsReleaseCompare(before || undefined, after || undefined),
    [before, after],
    { enabled: Boolean(list.data) },
  );

  const rows = useMemo(() => {
    if (!cmp.data) return null;
    let base = worse ? onlyWorse(cmp.data.items) : cmp.data.items;
    if (shiftView !== "all") base = base.filter((r) => r.latency === shiftView);
    return filterCompare(base, q);
  }, [cmp.data, worse, shiftView, q]);

  const releases = list.data?.items ?? [];
  const versionOption = (v: string) => {
    const r = releases.find((x) => x.version === v);
    if (!r) return v;
    const isCurrent = list.data && v === list.data.current;
    return isCurrent
      ? fill(ut("opx.cmp.optCurrent"), { v })
      : fill(ut("opx.cmp.optSince"), { v, date: new Date(r.firstAt).toLocaleDateString(loc, { day: "2-digit", month: "2-digit" }) });
  };

  const head = (
    <OpsHead
      meta={
        list.data && before && after
          ? [
              `${before} → ${after}`,
              fill(ut("opx.cmp.metaSub"), {
                min: cmp.data ? fmtInt(cmp.data.windowMin, loc) : "60",
                current: list.data.current,
              }),
            ]
          : null
      }
      actions={
        <>
          <ButtonLink to="/ops/releases">
            <OpsIcon name="rocket" size={15} />
            {ut("ops.tab.releases")}
          </ButtonLink>
          <CopyLinkButton />
        </>
      }
      toolbar={
        releases.length >= 2 ? (
          <OpsToolbar
            right={
              list.data ? (
                <span className="inline-flex items-center gap-1.5 text-small text-muted">
                  <OpsIcon name="history" size={14} />
                  {fill(ut("opx.cmp.kept"), { n: list.data.retentionDays })}
                </span>
              ) : null
            }
          >
            <span className="text-small text-muted">{ut("ops.rel.before")}</span>
            <Select aria-label={ut("ops.rel.before")} value={before} onChange={(e) => setBefore(e.target.value)} className="w-[220px]">
              {releases.map((r) => (
                <option key={r.version} value={r.version}>
                  {versionOption(r.version)}
                </option>
              ))}
            </Select>
            <OpsIcon name="arrow-right" size={15} className="text-muted" />
            <span className="text-small text-muted">{ut("ops.rel.after")}</span>
            <Select aria-label={ut("ops.rel.after")} value={after} onChange={(e) => setAfter(e.target.value)} className="w-[220px]">
              {releases.map((r) => (
                <option key={r.version} value={r.version}>
                  {versionOption(r.version)}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="xs"
              icon={<OpsIcon name="arrow-left-right" />}
              onClick={() => {
                setBefore(after);
                setAfter(before);
              }}
            >
              {ut("opx.cmp.swap")}
            </Button>
          </OpsToolbar>
        ) : null
      }
    />
  );

  if (list.error && !list.data) {
    return (
      <>
        {head}
        <Loading error={list.error} onRetry={list.reload} />
      </>
    );
  }
  if (!list.data) {
    return (
      <>
        {head}
        <Loading rows={5} />
      </>
    );
  }

  if (releases.length < 2) {
    return (
      <div className="flex flex-col gap-4">
        {head}
        <Panel title={ut("opx.cmp.windows")} icon={<OpsIcon name="git-compare" />}>
          <Quiet>{releases.length === 0 ? ut("ops.rel.none") : fill(ut("ops.rel.single"), { version: releases[0]!.version })}</Quiet>
        </Panel>
      </div>
    );
  }

  const c = cmp.data;
  return (
    <div className="flex flex-col gap-4">
      {head}
      {cmp.error && !c ? (
        <Loading error={cmp.error} onRetry={cmp.reload} />
      ) : !c || !rows ? (
        <Loading rows={5} />
      ) : !c.before || !c.after ? (
        <Panel title={ut("opx.cmp.windows")} icon={<OpsIcon name="git-compare" />}>
          <Quiet>{ut("ops.rel.noPair")}</Quiet>
        </Panel>
      ) : (
        <>
          <WindowsPanel c={c} />
          {c.items.length ? (
            <Panel title={ut("opx.cmp.shifts")} icon={<OpsIcon name="arrow-up-down" />} sub={ut("opx.cmp.shiftsSub")}>
              <ReleaseCharts items={c.items} />
            </Panel>
          ) : null}
          <Panel
            title={ut("ops.rel.title")}
            icon={<OpsIcon name="table-2" />}
            sub={fill(ut("opx.cmp.tableSub"), { n: fmtInt(c.items.length, loc), k: fmtInt(rows.length, loc) })}
            flush
            footer={<PanelNote>{ut("opx.cmp.note")}</PanelNote>}
          >
            <div className="px-4 pb-3">
              <FilterBar
                search={{ value: q, onChange: setQ, placeholder: ut("opx.rq.search"), width: 220 }}
                chips={
                  <ViewPills
                    label={ut("opx.cmp.views")}
                    value={shiftView}
                    onChange={(k) => setShift(k)}
                    items={SHIFT_VIEWS.map((k) => ({
                      key: k,
                      label: k === "all" ? ut("opx.jb.viewAll") : capital(ut(SHIFT_KEY[k])),
                      count: k === "all" ? c.items.length : c.items.filter((r) => r.latency === k).length,
                    }))}
                  />
                }
                right={<Switch checked={Boolean(worse)} onChange={(v) => setWorse(v ? "1" : "")} label={ut("ops.rel.onlyWorse")} />}
              />
            </div>
            {c.items.length === 0 ? (
              <div className="px-4 pb-3">
                <Quiet>{ut("ops.rel.empty")}</Quiet>
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 pb-3">
                <Quiet>{worse ? ut("ops.rel.noWorse") : ut("ops.routes.noMatch")}</Quiet>
              </div>
            ) : (
              <CompareTable rows={rows} />
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

/** «гірше» → «Гірше» — подпись пилюли вида начинается с прописной */
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/* ─────────── окна ─────────── */

function WindowsPanel({ c }: { c: OpsReleaseCompare }) {
  const { ut } = useLang();
  const loc = locale();
  const side = (label: string, s: NonNullable<OpsReleaseCompare["before"]>, after?: boolean) => (
    <div className={cx("min-w-0 flex-1 rounded-panel px-3.5 py-3", after ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vring)]" : "bg-sunk")}>
      <span className="block text-caption font-bold text-muted">{label}</span>
      <Mono className="mt-0.5 block text-[15px] font-bold leading-5 text-text">{s.version}</Mono>
      <span className="mt-0.5 block text-small text-text-2">
        {fill(ut("opx.cmp.windowLine"), {
          from: new Date(s.from).toLocaleString(loc, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
          to: new Date(s.to).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" }),
          n: fmtInt(s.requests, loc),
        })}
      </span>
    </div>
  );
  const counts = (["worse", "better", "same", "few"] as const).map((k) => [k, c.items.filter((r) => r.latency === k).length] as const);
  return (
    <Panel title={ut("opx.cmp.windows")} icon={<OpsIcon name="git-compare" />}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-6 max-[1100px]:grid-cols-1">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            {side(ut("ops.rel.before"), c.before!)}
            <OpsIcon name="arrow-right" size={16} className="shrink-0 text-muted" />
            {side(ut("ops.rel.after"), c.after!, true)}
          </div>
          {c.grain === "hour" ? <StatusMark tone="warn">{ut("ops.rel.hourly")}</StatusMark> : null}
        </div>
        <div className="flex flex-col gap-3">
          <p className="m-0 text-small text-text-2">
            {fill(ut("ops.rel.thresholds"), {
              min: c.thresholds.minSample,
              ratio: fmtShare(c.thresholds.p95Ratio - 1, loc),
              ms: fmtMs(c.thresholds.p95MinMs, loc),
              pp: fmtInt(c.thresholds.errorPp * 100, loc),
              errors: c.thresholds.errorMin,
            })}
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            {counts.map(([k, n]) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <StatusMark tone={SHIFT_TONE[k]}>{ut(SHIFT_KEY[k])}</StatusMark>
                <b className="font-extrabold tabular-nums">{fmtInt(n, loc)}</b>
              </span>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ─────────── таблица ─────────── */

function latencyDetail(b: OpsCompareStats | null, a: OpsCompareStats | null, loc: string): string | null {
  const d = p95Delta(b, a);
  if (d === null) return null;
  const r = p95Ratio(b, a);
  return r === null ? fmtSignedMs(d, loc) : `${fmtSignedPct(r, loc)}, ${fmtSignedMs(d, loc)}`;
}

/**
 * Сдвиг словом с формой значка и под ним — разница числом. У «замало
 * запитів» разницы нет: ни мс, ни процентов, иначе глаз прочтёт число, а
 * не оговорку.
 */
function Shift({ shift, detail }: { shift: OpsShift; detail: string | null }) {
  const { ut } = useLang();
  return (
    <span className="flex flex-col gap-0.5">
      <StatusMark tone={SHIFT_TONE[shift]}>{ut(SHIFT_KEY[shift])}</StatusMark>
      {shift !== "few" && shift !== "same" && detail ? <span className="text-caption tabular-nums text-muted">{detail}</span> : null}
    </span>
  );
}

function CompareTable({ rows }: { rows: OpsRouteCompare[] }) {
  const { ut } = useLang();
  const loc = locale();
  const few = (r: OpsRouteCompare) => r.latency === "few";
  const columns: Column<OpsRouteCompare>[] = [
    {
      key: "route",
      header: ut("ops.col.route"),
      required: true,
      sort: (r) => `${r.route} ${r.method}`,
      csv: (r) => `${r.method} ${r.route}`,
      render: (r) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <MethodRoute method={r.method} route={r.route} />
          {!r.before || !r.after ? <span className="text-caption text-muted">{ut(r.before ? "ops.rel.gone" : "ops.rel.new")}</span> : null}
        </span>
      ),
    },
    {
      key: "requests",
      header: ut("ops.rel.requests"),
      num: true,
      width: 96,
      required: true,
      sort: (r) => (r.after?.requests ?? 0) + (r.before?.requests ?? 0),
      render: (r) => (
        <span className={few(r) ? "text-muted" : "text-text-2"}>
          {fmtInt(r.before?.requests ?? 0, loc)} / {fmtInt(r.after?.requests ?? 0, loc)}
        </span>
      ),
    },
    {
      key: "p95b",
      header: ut("ops.rel.p95Before"),
      num: true,
      width: 92,
      required: true,
      sort: (r) => r.before?.p95 ?? null,
      render: (r) => <span className={few(r) ? "text-muted" : "text-text-2"}>{fmtMs(r.before?.p95 ?? null, loc)}</span>,
    },
    {
      key: "p95a",
      header: ut("ops.rel.p95After"),
      num: true,
      width: 92,
      required: true,
      sort: (r) => r.after?.p95 ?? null,
      render: (r) => (
        <b className={cx("font-extrabold", r.latency === "worse" && "text-warn", few(r) && "font-medium text-muted")}>{fmtMs(r.after?.p95 ?? null, loc)}</b>
      ),
    },
    {
      key: "latency",
      header: ut("ops.rel.p95Shift"),
      width: 150,
      required: true,
      sort: (r) => (r.latency === "worse" ? 0 : r.latency === "better" ? 1 : r.latency === "same" ? 2 : 3),
      render: (r) => <Shift shift={r.latency} detail={latencyDetail(r.before, r.after, loc)} />,
    },
    {
      key: "eb",
      header: ut("ops.rel.errBefore"),
      num: true,
      width: 76,
      required: true,
      sort: (r) => r.before?.share5xx ?? null,
      render: (r) => <span className="text-text-2">{fmtShare(r.before?.share5xx ?? null, loc)}</span>,
    },
    {
      key: "ea",
      header: ut("ops.rel.errAfter"),
      num: true,
      width: 76,
      required: true,
      sort: (r) => r.after?.share5xx ?? null,
      render: (r) => <span className={r.errors === "worse" ? "font-extrabold text-warn" : "text-text-2"}>{fmtShare(r.after?.share5xx ?? null, loc)}</span>,
    },
    {
      key: "errors",
      header: ut("ops.rel.errShift"),
      width: 130,
      required: true,
      sort: (r) => (r.errors === "worse" ? 0 : r.errors === "better" ? 1 : r.errors === "same" ? 2 : 3),
      render: (r) => {
        const d = shareDelta(r.before, r.after);
        return <Shift shift={r.errors} detail={d === null ? null : fill(ut("ops.rel.pp"), { n: fmtSignedPp(d, loc) })} />;
      },
    },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={(r) => `${r.method} ${r.route}`} stateKey="cmp" initialSort={{ key: "latency" }} dense label={ut("ops.rel.title")} />;
}
