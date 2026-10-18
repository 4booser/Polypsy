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
import { Figure, ShareBar, StackColumns, TimeColumns, TimeLines, type GapColumn, type TimeLineMark } from "../../charts/clinical";
import { RowTip, TipHead, TipRow, TipText } from "../../charts/kit";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { ButtonLink } from "../../ui/primitives";
import { fill } from "../dashboard/model";
import { OpsIcon } from "./icons";
import {
  CONN_KEY,
  ERROR_STEP,
  JOB_KEY,
  LOG_STEP,
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
  fmtAgo,
  fmtBytes,
  fmtInt,
  fmtMs,
  fmtShare,
  fmtUptime,
  hhmm,
  jobsByDuration,
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

} from "./model";
import { Facts, Mono, Quiet } from "./parts";

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

export const CHART_GRID = "grid grid-cols-1 gap-x-6 gap-y-7 min-[900px]:grid-cols-2";

/*
 * Цвета нагрузки — категориальные ряды набора, в одном порядке на всех
 * экранах техпанели: успешные — c1 (фиолетовый), отказы клиенту — c3
 * (бирюза), сбои сервера — c2 (охра). Перцентили — p95 главным рядом c1,
 * p50 — c3, p99 — c2 пунктиром. Янтарь внимания (--warn) — только у
 * порога и ромбов над ним: его рисует сам TimeLines.
 */
export const CLASS_TONE = { ok: "var(--c1)", c4: "var(--c3)", c5: "var(--c2)" } as const;
export const PCT_TONE = { p50: "var(--c3)", p95: "var(--c1)", p99: "var(--c2)" } as const;
/* строки лога: предупреждение — «прочее» (c5), его много и оно само действия не требует; ошибка — c2, как 5xx */
export const LEVEL_TONE = { warn: "var(--c5)", error: "var(--c2)" } as const;

/** Маршрут в подписи полосы — моноширинно, метод приглушён: так он напечатан в таблице ниже */
function RouteLabel({ r }: { r: Pick<OpsRouteStat, "method" | "route"> }) {
  return (
    <span className="font-mono text-[11.5px] font-medium text-text" title={`${r.method} ${r.route}`}>
      <span className="text-muted">{r.method}</span> {r.route}
    </span>
  );
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
  marks,
}: {
  buckets: readonly OpsTrafficBucket[];
  stepSec: number;
  since: string;
  compact?: boolean;
  /** Отметки на оси времени линий: запуск процесса, выкатка */
  marks?: readonly TimeLineMark[];
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
            { key: "ok", label: ut("ops.ch.class.ok"), color: CLASS_TONE.ok },
            { key: "c4", label: ut("ops.ch.class.c4"), color: CLASS_TONE.c4 },
            { key: "c5", label: ut("ops.ch.class.c5"), color: CLASS_TONE.c5 },
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
            { key: "p50", label: ut("ops.col.p50"), color: PCT_TONE.p50, values: lines.p50 },
            { key: "p95", label: ut("ops.col.p95"), color: PCT_TONE.p95, values: lines.p95 },
            { key: "p99", label: ut("ops.col.p99"), color: PCT_TONE.p99, dashed: true, values: lines.p99 },
          ]}
          format={ms}
          tick={(v) => fmtInt(v, loc)}
          marks={marks}
        />
      </Figure>
      {compact ? null : (
        <>
          <Figure title={ut("ops.ch.share5xx")} caption={ut("ops.ch.share5xxHint")}>
            <TimeLines
              label={ut("ops.ch.share5xx")}
              x={x}
              series={[{ key: "share", label: ut("ops.ch.share5xx"), color: CLASS_TONE.c5, values: share }]}
              format={pct}
              threshold={{ value: SHARE_5XX_LIMIT, label: fill(ut("ops.ch.limit"), { v: pct(SHARE_5XX_LIMIT) }) }}
              marks={marks}
            />
          </Figure>
          <Figure title={ut("ops.ch.mix")} caption={ut("ops.ch.mixHint")}>
            {totals.ok + totals.c4 + totals.c5 > 0 ? (
              <ShareBar
                label={ut("ops.ch.mix")}
                parts={[
                  { key: "ok", label: ut("ops.ch.class.ok"), value: totals.ok, color: CLASS_TONE.ok },
                  { key: "c4", label: ut("ops.ch.class.c4"), value: totals.c4, color: CLASS_TONE.c4 },
                  { key: "c5", label: ut("ops.ch.class.c5"), value: totals.c5, color: CLASS_TONE.c5 },
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
  /* роли — категории, а не ступени: каждой свой ряд набора, самая многочисленная первой */
  const roles = [
    ["user", "var(--c1)"],
    ["admin", "var(--c2)"],
    ["superadmin", "var(--c3)"],
  ] as const;
  return (
    <ShareBar
      className="w-full pt-1"
      label={ut("ops.data.accounts")}
      parts={roles.map(([r, color]) => ({ key: r, label: ut(ROLE_KEY[r]), value: accounts[r], color }))}
    />
  );
}

/* ─────────── рейтинг с широкой подписью ─────────── */

export interface RankBar {
  key: string;
  label: ReactNode;
  /** Полная подпись для подсказки и диктора: маршрут целиком, запрос SQL */
  title: string;
  value: number;
  text: string;
  /** Требует внимания: полоса янтарём (пятисотки, p95 над порогом) */
  attention?: boolean;
  /** Не требует ничего и не в счёт пути: полоса серым (удалённые записи) */
  muted?: boolean;
  /** Приписка после числа приглушённым: объём «38,0 ГБ», «файл стерто» */
  extra?: string;
  /** Пояснение в подсказке: «4 з 21» */
  note?: string;
}

/**
 * Рейтинг строками с подписью фиксированной ширины (.hbx набора техпанели):
 * подпись — маршрут или запрос моноширинно, ей нужно больше места, чем
 * полосе. HBars набора делит строку 2 : 3 и в узкой панели обрезает
 * маршрут до «GET /api/aut…».
 *
 * Полоса от нуля до общего максимума (или `max`); `reference` — риска
 * поперёк полос (порог), с подписью под списком.
 */
export function RankBars({
  items,
  max,
  labelW = 176,
  reference,
}: {
  items: readonly RankBar[];
  max?: number;
  /** Ширина подписи: 176 — маршрут, 150 — маршрут рядом с долей */
  labelW?: 150 | 176;
  reference?: { value: number; label: string };
}) {
  const top = max ?? Math.max(0, reference?.value ?? 0, ...items.map((i) => i.value));
  return (
    <div>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {items.map((i) => {
          const w = top > 0 ? Math.max(0.012, Math.min(1, i.value / top)) : 0;
          return (
            <li
              key={i.key}
              tabIndex={0}
              aria-label={`${i.title}: ${i.text}`}
              className={cx(
                "group/row relative grid min-h-7 items-center gap-3 rounded-[8px] outline-none hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]",
                labelW === 150 ? "grid-cols-[minmax(0,150px)_minmax(24px,1fr)_auto]" : "grid-cols-[minmax(0,176px)_minmax(24px,1fr)_auto]",
              )}
            >
              <span className="min-w-0 truncate">{i.label}</span>
              <span className="relative h-3.5">
                {i.value > 0 ? (
                  <span
                    data-bar
                    className={cx("block h-full rounded-r-[4px]", i.attention ? "bg-warn" : i.muted ? "bg-[var(--c5)]" : "bg-[var(--series)]")}
                    style={{ width: `${(w * 100).toFixed(2)}%` }}
                  />
                ) : null}
                {reference && top > 0 ? (
                  <span
                    aria-hidden
                    className="absolute -top-1 -ml-px h-[22px] w-0.5 rounded-[1px] bg-text"
                    style={{ left: `${Math.min(100, (reference.value / top) * 100).toFixed(2)}%` }}
                  />
                ) : null}
              </span>
              <span className="whitespace-nowrap text-right text-[13px] font-extrabold tabular-nums text-text">
                {i.text}
                {i.extra ? <span className="ml-1.5 text-caption font-semibold text-muted">{i.extra}</span> : null}
              </span>
              <RowTip at={0.3 + w * 0.4}>
                <TipHead>{i.title}</TipHead>
                <TipRow
                  kind="box"
                  color={i.attention ? "var(--warn)" : i.muted ? "var(--c5)" : "var(--series)"}
                  value={i.extra ? `${i.text} · ${i.extra}` : i.text}
                />
                {i.note ? <TipText muted>{i.note}</TipText> : null}
              </RowTip>
            </li>
          );
        })}
      </ul>
      {reference ? (
        <p className="m-0 mt-2 flex items-center gap-1.5 text-caption text-muted">
          <span aria-hidden className="inline-block h-3 w-0.5 rounded-[1px] bg-text" />
          {reference.label}
        </p>
      ) : null}
    </div>
  );
}

/* ─────────── маршруты ─────────── */

/**
 * Рейтинги маршрутов с момента запуска — три панели рядом: по числу
 * запросов, по p95 (от порога выборки) и по доле пятисоток. Поиск на них
 * не действует — он сужает таблицу; рейтинг «первые восемь из найденного»
 * читался бы как рейтинг всех.
 *
 * `p95Limit` — порог оповещения о p95: риской поперёк полос, чтобы было
 * видно, кто к нему подходит. `errorsTo` — куда ведёт «До помилок».
 */
export function RouteCharts({
  items,
  p95Limit,
  errorsTo = "/ops/errors",
}: {
  items: readonly OpsRouteStat[];
  p95Limit?: number | null;
  errorsTo?: string;
}) {
  const { ut } = useLang();
  const loc = locale();
  const byCount = routesByCount(items, 6);
  const byP95 = routesByP95(items, 6);
  const by5xx = routes5xx(items, 4);
  const clean = items.filter((r) => r.errors5xx === 0).length;

  return (
    <div className="grid grid-cols-3 items-start gap-4 max-[1180px]:grid-cols-2 max-[800px]:grid-cols-1">
      <Panel title={ut("ops.ch.routesCount")} icon={<OpsIcon name="list-ordered" />} sub={ut("opx.rq.sinceStart")}>
        <RankBars
          items={[
            ...byCount.top.map((r) => ({
              key: `${r.method} ${r.route}`,
              title: `${r.method} ${r.route}`,
              label: <RouteLabel r={r} />,
              value: r.requests,
              text: fmtInt(r.requests, loc),
            })),
            ...(byCount.rest > 0
              ? [
                  {
                    key: "__rest",
                    title: fill(ut("ops.ch.others"), { n: byCount.rest }),
                    label: <span className="text-small text-text-2">{fill(ut("ops.ch.others"), { n: byCount.rest })}</span>,
                    value: byCount.restSum,
                    text: fmtInt(byCount.restSum, loc),
                  },
                ]
              : []),
          ]}
        />
      </Panel>
      <Panel title={ut("ops.ch.routesP95")} icon={<OpsIcon name="turtle" />}>
        {byP95.top.length ? (
          <>
            <RankBars
              items={byP95.top.map((r) => ({
                key: `${r.method} ${r.route}`,
                title: `${r.method} ${r.route}`,
                label: <RouteLabel r={r} />,
                value: r.p95 ?? 0,
                text: fmtMs(r.p95, loc),
                note: fill(ut("opx.rq.ofRequests"), { n: fmtInt(r.requests, loc) }),
                attention: !!p95Limit && r.p95 !== null && r.p95 >= p95Limit,
              }))}
              reference={p95Limit ? { value: p95Limit, label: fill(ut("opx.rq.p95Limit"), { v: fmtMs(p95Limit, loc) }) } : undefined}
            />
            <MoreNote n={byP95.rest} />
          </>
        ) : (
          <Quiet>{fill(ut("ops.ch.routesP95Few"), { n: ROUTE_P95_MIN })}</Quiet>
        )}
        <p className="m-0 mt-2 text-caption text-muted">{fill(ut("ops.ch.routesP95Hint"), { n: ROUTE_P95_MIN })}</p>
      </Panel>
      <Panel title={ut("ops.ch.routes5xx")} icon={<OpsIcon name="octagon-alert" />} tone="warn">
        {by5xx.top.length ? (
          <>
            {/* от 0 до 100 %: доля маршрута — это доля его запросов, а не «место среди соседей» */}
            <RankBars
              max={1}
              labelW={150}
              items={by5xx.top.map((r) => ({
                key: `${r.method} ${r.route}`,
                title: `${r.method} ${r.route}`,
                label: <RouteLabel r={r} />,
                value: r.errors5xx / r.requests,
                text: fmtShare(r.errors5xx / r.requests, loc),
                note: fill(ut("opx.rq.nOfM"), { n: fmtInt(r.errors5xx, loc), m: fmtInt(r.requests, loc) }),
                attention: true,
              }))}
            />
            <MoreNote n={by5xx.rest} />
            <p className="m-0 mt-3 text-small text-text-2">{fill(ut("opx.rq.restClean"), { n: fmtInt(clean, loc) })}</p>
            <div className="mt-3">
              <ButtonLink to={errorsTo} size="xs" variant="secondary">
                <OpsIcon name="bug" size={14} />
                {ut("opx.rq.toErrors")}
              </ButtonLink>
            </div>
          </>
        ) : (
          <Quiet>{ut("ops.ch.routes5xxNone")}</Quiet>
        )}
      </Panel>
    </div>
  );
}

/* ─────────── отметки выкаток на столбцах ─────────── */

/** Отметка выкатки над столбцом: индекс корзины и подпись («v1.22.0») */
export interface ColumnMark {
  index: number;
  label: string;
}

/*
 * Геометрия TimeColumns набора (charts/clinical.tsx, CP): поле слева 40,
 * справа 8, сверху 16, снизу 26; столбец i стоит в середине своего слота.
 * Отметка рисуется слоем поверх графика по тем же числам — в процентах от
 * ширины, поэтому живёт при любой ширине контейнера.
 */
const COL_LEFT = 40;
const COL_SIDES = 48;
const COL_TOP = 16;
const COL_BOTTOM = 26;

/** Отметки выкаток (пунктир с подписью) поверх столбцов по корзинам */
export function MarkedColumns({
  columns,
  marks,
  label,
  tone,
  height = 200,
}: {
  columns: readonly GapColumn[];
  marks: readonly ColumnMark[];
  label: string;
  tone?: "plain" | "attention";
  height?: number;
}) {
  const n = columns.length;
  return (
    <div className="relative min-w-0">
      <TimeColumns columns={columns} label={label} tone={tone} height={height} />
      {n
        ? marks.map((m) => (
            <span
              key={`${m.index}-${m.label}`}
              aria-hidden
              className="pointer-events-none absolute w-0 border-l border-dashed border-violet-ink"
              style={{
                left: `calc(${COL_LEFT}px + (100% - ${COL_SIDES}px) * ${((m.index + 0.5) / n).toFixed(4)})`,
                top: COL_TOP - 4,
                height: height - COL_TOP - COL_BOTTOM + 4,
              }}
            >
              <span
                className={cx(
                  "absolute top-0 whitespace-nowrap rounded-[4px] bg-panel px-0.5 text-micro font-extrabold leading-none text-violet-ink",
                  /* у правого края подпись — слева от черты, иначе она уходит за график */
                  (m.index + 0.5) / n > 0.7 ? "right-1" : "left-1",
                )}
              >
                {m.label}
              </span>
            </span>
          ))
        : null}
    </div>
  );
}

/** Индекс корзины, в которую попадает момент; вне ряда — null */
export function binIndexOf(bins: readonly { start: number }[], at: number, end: number): number | null {
  if (!bins.length || at < bins[0]!.start || at > end) return null;
  let idx = 0;
  for (let i = 0; i < bins.length; i++) if (bins[i]!.start <= at) idx = i;
  return idx;
}

/* ─────────── ошибки ─────────── */

/**
 * Огляд периоду ошибок: случаи по времени с отметками выкаток слева,
 * самые частые группы и сводка периода справа.
 *
 * Столбцы — из часов базы (`hours`), разложенных в местные корзины; без
 * них (история не прочиталась — экран показывает память процесса) времени
 * у групп нет, и график говорит об этом словами. Янтарь — вся фигура:
 * каждый случай здесь необработанное исключение. Выкатки — из истории
 * версий в запросах (`releases`): пунктир в корзине, где версия появилась.
 */
export function ErrorCharts({
  data,
  window,
  now,
  releases = [],
}: {
  data: OpsErrors;
  window: OpsErrorWindow;
  now: number;
  releases?: readonly { version: string; firstAt: string }[];
}) {
  const { ut } = useLang();
  const loc = locale();
  const step = ERROR_STEP[window];
  const top = errorGroupsTop(data.items, 5);
  const bins = data.hours && data.from ? binSeries(data.hours, ["count"], Date.parse(data.from), now, step) : null;
  const columns = bins ? binColumns(bins, "count", step, loc) : null;
  /* в одной корзине — одна отметка, самой поздней версии: две подписи в одном столбце не читаются */
  const byBin = new Map<number, { at: number; label: string }>();
  if (bins) {
    for (const r of releases) {
      const at = Date.parse(r.firstAt);
      const i = binIndexOf(bins, at, now);
      if (i === null) continue;
      const cur = byBin.get(i);
      if (!cur || at > cur.at) byBin.set(i, { at, label: r.version });
    }
  }
  const marks: ColumnMark[] = [...byBin].map(([index, m]) => ({ index, label: m.label }));
  const from = data.from ? Date.parse(data.from) : null;
  const fresh = from === null ? 0 : data.items.filter((g) => Date.parse(g.firstAt) >= from).length;
  const total = data.items.reduce((s, g) => s + g.count, 0);
  const routes = new Set(data.items.filter((g) => g.route).map((g) => `${g.method} ${g.route}`)).size;
  const outside = data.items.filter((g) => !g.route).length;
  const last = data.items.reduce<OpsErrors["items"][number] | null>((m, g) => (!m || g.lastAt > m.lastAt ? g : m), null);
  const caption = marks.length ? fill(ut("opx.er.stepMarks"), { step: ut(STEP_KEY[step]) }) : ut(STEP_KEY[step]);

  return (
    <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
      <Figure title={ut("ops.ch.errCases")} caption={caption}>
        {columns ? (
          <MarkedColumns columns={columns} marks={marks} label={ut("ops.ch.errCases")} tone="attention" />
        ) : (
          <Quiet>{ut("ops.ch.errNoHours")}</Quiet>
        )}
      </Figure>
      <div className="flex min-w-0 flex-col gap-4">
        <Figure title={ut("ops.ch.errTop")} caption={ut("ops.ch.errTopHint")}>
          {top.top.length ? (
            <RankBars
              labelW={176}
              items={[
                ...top.top.map((g) => ({
                  key: g.fingerprint,
                  title: `${g.name}: ${g.message}`,
                  label: (
                    <span className="font-mono text-[11.5px] font-medium text-text">
                      <b className="font-bold">{g.name}</b> {g.message}
                    </span>
                  ),
                  value: g.count,
                  text: fmtInt(g.count, loc),
                  attention: from !== null && Date.parse(g.firstAt) >= from,
                })),
                ...(top.rest > 0
                  ? [
                      {
                        key: "__rest",
                        title: fill(ut("ops.ch.others"), { n: top.rest }),
                        label: <span className="text-small text-text-2">{fill(ut("ops.ch.others"), { n: top.rest })}</span>,
                        value: top.restSum,
                        text: fmtInt(top.restSum, loc),
                      },
                    ]
                  : []),
              ]}
            />
          ) : (
            <Quiet>{data.from ? ut("ops.history.errorsEmpty") : ut("ops.errors.empty")}</Quiet>
          )}
        </Figure>
        {data.items.length ? (
          <div className="border-t border-divider pt-3">
            <Facts
              w={130}
              items={[
                [ut("opx.er.kvGroups"), fill(ut("opx.er.groupsNew"), { n: fmtInt(data.items.length, loc), k: fmtInt(fresh, loc) })],
                [ut("opx.er.kvCases"), <b key="c" className="font-extrabold">{fmtInt(total, loc)}</b>],
                [
                  ut("opx.er.kvRoutes"),
                  outside
                    ? fill(ut("opx.er.routesOutside"), { n: fmtInt(routes, loc), k: fmtInt(outside, loc) })
                    : fill(ut("opx.er.routesHit"), { n: fmtInt(routes, loc) }),
                ],
                [
                  ut("opx.er.kvLast"),
                  last ? (
                    <span key="l">
                      <b className="font-extrabold">{hhmm(last.lastAt, loc)}</b>
                      {`, ${fmtAgo(last.lastAt, now, loc)}, `}
                      <Mono>{last.name}</Mono>
                    </span>
                  ) : (
                    "—"
                  ),
                ],
              ]}
            />
          </div>
        ) : null}
      </div>
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
  const sum = (k: "debug" | "info" | "warn" | "error") => bins.reduce((s, b) => s + b.values[k], 0);
  const total = sum("debug") + sum("info") + sum("warn") + sum("error");

  return (
    <>
      {volume.historyUnavailable ? <Quiet>{ut("ops.ch.logUnavailable")}</Quiet> : null}
      <div className={CHART_GRID}>
        <Figure title={ut("ops.ch.logAll")} caption={fill(ut("opx.lg.totalLines"), { n: fmtInt(total, loc) })}>
          <TimeColumns columns={binColumns(all, "all", step, loc)} label={ut("ops.ch.logAll")} />
        </Figure>
        <Figure title={ut("ops.ch.logLoud")} caption={fill(ut("opx.lg.loudLines"), { w: fmtInt(sum("warn"), loc), e: fmtInt(sum("error"), loc) })}>
          {loud ? (
            <StackColumns
              label={ut("ops.ch.logLoud")}
              series={[
                { key: "warn", label: ut("ops.level.warn"), color: LEVEL_TONE.warn },
                { key: "error", label: ut("ops.level.error"), color: LEVEL_TONE.error },
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
 * Проходы задач с момента запуска (янтарём — у кого были сбои, их число
 * рядом) и длительность последнего прохода (янтарём — если он кончился
 * сбоем). Длительности не складываются, поэтому остаток — словами.
 */
export function JobCharts({ items }: { items: readonly OpsJob[] }) {
  const { ut } = useLang();
  const loc = locale();
  const runs = jobsByRuns(items, 7);
  const took = jobsByDuration(items, 7);
  const label = (j: OpsJob) => <span className="text-small font-semibold text-text-2">{jobName(j, ut)}</span>;
  const title = (j: OpsJob) => (JOB_KEY[j.name] ? ut(JOB_KEY[j.name]!) : j.name);

  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.ch.jobRuns")} caption={ut("opx.jb.runsHint")}>
        <RankBars
          items={[
            ...runs.top.map((j) => ({
              key: j.name,
              title: title(j),
              label: label(j),
              value: j.runs,
              text: j.failures ? fill(ut("opx.jb.runsFails"), { runs: fmtInt(j.runs, loc), n: fmtInt(j.failures, loc) }) : fmtInt(j.runs, loc),
              attention: j.failures > 0,
            })),
            ...(runs.rest > 0
              ? [
                  {
                    key: "__rest",
                    title: fill(ut("ops.ch.others"), { n: runs.rest }),
                    label: <span className="text-small text-text-2">{fill(ut("ops.ch.others"), { n: runs.rest })}</span>,
                    value: runs.restSum,
                    text: fmtInt(runs.restSum, loc),
                  },
                ]
              : []),
          ]}
        />
      </Figure>
      <Figure title={ut("ops.ch.jobTook")} caption={ut("opx.jb.tookHint")}>
        {took.top.length ? (
          <>
            <RankBars
              items={took.top.map((j) => ({
                key: j.name,
                title: title(j),
                label: label(j),
                value: j.lastDurationMs ?? 0,
                text: fmtMs(j.lastDurationMs, loc),
                attention: j.lastResult === "error",
              }))}
            />
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
 * Срабатывания расписаний по местным суткам за месяц: сколько назначено и
 * сколько пропущено. Из базы — переживает перезапуск, в отличие от
 * проходов выше. Пропущенное — не сбой (у человека уже висит незакрытое
 * назначение): второй ряд набора, а не янтарь внимания.
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
  return (
    <Figure title={fill(ut("opx.jb.schedTitle"), { n: days })} caption={ut("opx.jb.schedHint")}>
      <StackColumns
        label={ut("ops.ch.schedAssigned")}
        series={[
          { key: "assigned", label: ut("ops.col.assigned"), color: "var(--c1)" },
          { key: "skipped", label: ut("ops.col.skipped"), color: "var(--c2)" },
        ]}
        columns={binStack(bins, ["assigned", "skipped"], "day", loc)}
        total={ut("ops.ch.total")}
        format={(v) => fmtInt(v, loc)}
      />
    </Figure>
  );
}

/* ─────────── база ─────────── */

/**
 * Десять самых больших таблиц и «інші» — остаток из тех, что прислал сервер
 * (он отдаёт самые большие, не все); и мёртвые строки, где они есть, —
 * янтарём там, где автоочистка не успевает (то же правило, что у колонки
 * таблицы ниже, deadRowsAlarm). Две фигуры без своей сетки: «База»
 * ставит их в один ряд с подключениями.
 */
export function TableCharts({ tables }: { tables: readonly OpsTableStat[] }) {
  const { ut } = useLang();
  const loc = locale();
  const size = tablesBySize(tables, 8);
  const dead = tablesByDead(tables, 8);
  const name = (t: OpsTableStat, strong?: boolean) => (
    <span className={cx("font-mono text-[11.5px] text-text", strong ? "font-bold" : "font-medium")}>{t.table}</span>
  );

  return (
    <>
      <Figure title={ut("ops.ch.tableSize")} caption={fill(ut("ops.ch.tableSizeHint"), { n: tables.length })}>
        <RankBars
          labelW={150}
          items={[
            ...size.top.map((t) => ({ key: t.table, title: t.table, label: name(t), value: t.totalBytes, text: fmtBytes(t.totalBytes, loc) })),
            ...(size.rest > 0
              ? [
                  {
                    key: "__rest",
                    title: fill(ut("ops.ch.others"), { n: size.rest }),
                    label: <span className="text-small text-text-2">{fill(ut("ops.ch.others"), { n: size.rest })}</span>,
                    value: size.restSum,
                    text: fmtBytes(size.restSum, loc),
                  },
                ]
              : []),
          ]}
        />
      </Figure>
      <Figure title={ut("ops.ch.deadRows")} caption={ut("ops.ch.deadRowsHint")}>
        {dead.top.length ? (
          <>
            <RankBars
              labelW={150}
              /* внимание — янтарём и жирной подписью: цвет в одиночку «выделено» не несёт */
              items={dead.top.map((t) => ({
                key: t.table,
                title: t.table,
                label: name(t, deadRowsAlarm(t)),
                value: t.deadRows ?? 0,
                text: fmtInt(t.deadRows, loc),
                note: t.liveRows ? fill(ut("opx.db.deadShare"), { v: fmtShare((t.deadRows ?? 0) / t.liveRows, loc) }) : undefined,
                attention: deadRowsAlarm(t),
              }))}
            />
            <MoreNote n={dead.rest} />
          </>
        ) : (
          <Quiet>{ut("ops.ch.deadNone")}</Quiet>
        )}
      </Figure>
    </>
  );
}

/* состояния подключения — категории: у каждого свой ряд набора, свободное — дорожкой */
const CONN_TONE: Partial<Record<OpsConnections["byState"][number]["state"], string>> = {
  active: "var(--c1)",
  idle: "var(--c2)",
  idle_in_transaction: "var(--c3)",
  idle_in_transaction_aborted: "var(--c4)",
};

/**
 * Подключения по состояниям и свободные до max_connections — одной
 * полосой. Свободные — дорожкой сетки, а не ещё одной ступенью фиолетового:
 * это не состояние подключения, а место, которого пока никто не занял.
 */
export function ConnectionsShare({ c }: { c: OpsConnections }) {
  const { ut } = useLang();
  const parts = connectionShares(c);
  return (
    <ShareBar
      label={ut("ops.db.connections")}
      parts={parts.map((p) =>
        p.state === "free"
          ? { key: "free", label: ut("ops.ch.free"), value: p.count, color: "var(--track)" }
          : { key: p.state, label: ut(CONN_KEY[p.state]), value: p.count, color: CONN_TONE[p.state] ?? "var(--c5)" },
      )}
    />
  );
}
