import type { OpsRouteCompare, OpsStatement, OpsStatementSort, OpsTraceSummary } from "@quizzy/shared";
import { Figure, PairBars, ShareBar } from "../../../charts/clinical";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { fill } from "../../dashboard/model";
import { CHART_GRID, RankBars } from "../charts";
import { fmtInt, fmtMs, fmtShare } from "../model";
import { Quiet, StatusMark } from "../parts";
import { SHIFT_KEY, SHIFT_TONE, errorPairs, latencyPairs, statementMetric, statementShares, statementsTop, traceTime } from "./model";

/**
 * Графики второй половины наблюдаемости (волна 11): сравнение выкаток,
 * медленные SQL, трасса. Рисование только — ряды в ./model.ts, данные
 * приходят из вкладки (рисуются в apps/web/test/opsChartsRender.test.tsx).
 */

const SORT_KEY = { total: "ops.sql.byTotal", calls: "ops.sql.byCalls", mean: "ops.sql.byMean" } as const;

function RouteLabel({ r }: { r: Pick<OpsRouteCompare, "method" | "route"> }) {
  return (
    <span className="font-mono text-[12px]" title={`${r.method} ${r.route}`}>
      <span className="text-muted">{r.method}</span> {r.route}
    </span>
  );
}

/**
 * «Було / стало» по маршрутам: p95 и доля пятисоток парами полос.
 *
 * Янтарь у «стало» — только там, где сервер выставил «гірше» (пороги —
 * в пояснении раздела), и слово сдвига стоит рядом: полоса длиннее
 * прежней ещё не значит «гірше», если разница в пределах порога.
 * «Замало запитів» на график не идёт — как и в проценты таблицы.
 */
export function ReleaseCharts({ items }: { items: readonly OpsRouteCompare[] }) {
  const { ut } = useLang();
  const loc = locale();
  const lat = latencyPairs(items);
  const err = errorPairs(items);
  const shift = (s: OpsRouteCompare["latency"]) =>
    s === "worse" || s === "better" ? <StatusMark tone={SHIFT_TONE[s]}>{ut(SHIFT_KEY[s])}</StatusMark> : null;

  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.ch.relP95")} caption={ut("ops.ch.relP95Hint")}>
        {lat.length ? (
          <PairBars
            before={ut("ops.rel.before")}
            after={ut("ops.rel.after")}
            rows={lat.map((r) => ({
              key: `${r.method} ${r.route}`,
              label: <RouteLabel r={r} />,
              before: r.before!.p95,
              after: r.after!.p95,
              text: `${fmtMs(r.before!.p95, loc)} → ${fmtMs(r.after!.p95, loc)}`,
              attention: r.latency === "worse",
              note: shift(r.latency),
            }))}
          />
        ) : (
          <Quiet>{ut("ops.ch.relFew")}</Quiet>
        )}
      </Figure>
      <Figure title={ut("ops.ch.rel5xx")} caption={ut("ops.ch.rel5xxHint")}>
        {err.length ? (
          <PairBars
            before={ut("ops.rel.before")}
            after={ut("ops.rel.after")}
            /* доля — от 0 до 100 %, как у пятисоток на «Запитах»: полоса — доля запросов маршрута */
            max={1}
            rows={err.map((r) => ({
              key: `${r.method} ${r.route}`,
              label: <RouteLabel r={r} />,
              before: r.before!.share5xx,
              after: r.after!.share5xx,
              text: `${fmtShare(r.before!.share5xx, loc)} → ${fmtShare(r.after!.share5xx, loc)}`,
              attention: r.errors === "worse",
              note: shift(r.errors),
            }))}
          />
        ) : (
          <Quiet>{ut("ops.ch.rel5xxNone")}</Quiet>
        )}
      </Figure>
    </div>
  );
}

/**
 * Первые восемь запросов по выбранному порядку и доля каждого из первых
 * пяти в общем времени базы — полосой с «рештою». Номер у полосы — тот же,
 * что у строки списка ниже: текст запроса длинный, и в подписи полосы его
 * видно только началом.
 */
export function StatementCharts({ items, sort }: { items: readonly OpsStatement[]; sort: OpsStatementSort }) {
  const { ut } = useLang();
  const loc = locale();
  const { top } = statementsTop(items, sort);
  const shares = statementShares(items);
  const rank = new Map(items.map((s, i) => [s.id, i + 1]));
  const value = (s: OpsStatement) => {
    const v = statementMetric(s, sort);
    return sort === "calls" ? fmtInt(v, loc) : fmtMs(v, loc);
  };
  const label = (s: OpsStatement) => (
    <span className="font-mono text-[11.5px] font-medium text-text">
      <span className="mr-1.5 text-muted">{rank.get(s.id)}</span>
      {s.query}
    </span>
  );
  /* доли — категории (свой запрос — свой цвет), «решта» — дорожкой */
  const SHARE_TONES = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"];

  return (
    <div className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
      <Figure title={fill(ut("opx.st.topTitle"), { sort: ut(SORT_KEY[sort]).toLowerCase() })} caption={ut("opx.st.topHint")}>
        <RankBars
          labelW={176}
          items={top.map((s) => ({ key: s.id, title: s.query, label: label(s), value: statementMetric(s, sort), text: value(s) }))}
        />
      </Figure>
      {shares ? (
        <Figure title={ut("ops.ch.sqlShare")} caption={ut("ops.ch.sqlShareHint")}>
          {/*
            Части — сами доли (в сумме с «рештою» — целое), поэтому процент
            от целого не дописывается: он повторил бы число. Подпись — номер
            запроса: текст длинный, а номер тот же, что в списке.
          */}
          <ShareBar
            label={ut("ops.ch.sqlShare")}
            format={(v) => fmtShare(v, loc)}
            percent={false}
            parts={[
              ...shares.top.map((s, i) => ({
                key: s.id,
                label: fill(ut("opx.st.no"), { n: rank.get(s.id) ?? i + 1 }),
                value: s.share,
                color: SHARE_TONES[i] ?? "var(--c5)",
              })),
              { key: "rest", label: ut("ops.ch.sqlRest"), value: shares.rest, color: "var(--track)" },
            ]}
          />
        </Figure>
      ) : null}
    </div>
  );
}

/**
 * Куда ушло время одного запроса: запросы к базе и всё остальное — одной
 * полосой. Отвечает на первый вопрос разбора «медленно»: ждали базу или
 * считали сами. База — c3 (как SQL в трассе), остальное — c1.
 */
export function TraceTime({ summary }: { summary: OpsTraceSummary | null }) {
  const { ut } = useLang();
  const loc = locale();
  const t = traceTime(summary);
  if (!t) return null;
  return (
    <div className="grid grid-cols-[136px_minmax(0,1fr)] items-start gap-4 max-[700px]:grid-cols-1">
      <span className="pt-0.5 text-small font-bold text-text-2">{ut("ops.ch.traceTime")}</span>
      <ShareBar
        label={ut("ops.ch.traceTime")}
        format={(v) => fmtMs(v, loc)}
        parts={[
          { key: "sql", label: ut("ops.ch.traceSql"), value: t.sql, color: "var(--c3)" },
          { key: "other", label: ut("ops.ch.traceOther"), value: t.other, color: "var(--c1)" },
        ]}
      />
    </div>
  );
}
