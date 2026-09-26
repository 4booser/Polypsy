import type { OpsRouteCompare, OpsStatement, OpsStatementSort, OpsTraceSummary } from "@quizzy/shared";
import { Figure, HBars, PairBars, ShareBar } from "../../../charts/clinical";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { fill } from "../../dashboard/model";
import { CHART_GRID } from "../charts";
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
 * Первые восемь запросов по выбранному порядку и доля каждого в общем
 * времени базы — полосой с «рештою». Номер у полосы — тот же, что у строки
 * списка ниже: текст запроса длинный, и в подписи полосы его видно только
 * началом.
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
    <span className="font-mono text-[12px]" title={s.query}>
      <span className="text-muted">{rank.get(s.id)}.</span> {s.query}
    </span>
  );

  return (
    <div className={CHART_GRID}>
      <Figure title={ut("ops.ch.sqlTop")} caption={fill(ut("ops.ch.sqlTopHint"), { sort: ut(SORT_KEY[sort]) })}>
        <HBars items={top.map((s) => ({ key: s.id, label: label(s), value: statementMetric(s, sort), text: value(s) }))} />
      </Figure>
      {shares ? (
        <Figure title={ut("ops.ch.sqlShare")} caption={ut("ops.ch.sqlShareHint")}>
          {/*
            Легенда — строками ниже, а не подписью в строку: текст запроса
            длинный, и в перенос по словам он читается хуже, чем столбцом.
            Части — сами доли (в сумме с «рештою» — целое), поэтому процент
            от целого не дописывается: он повторил бы число.
          */}
          <ShareBar
            label={ut("ops.ch.sqlShare")}
            format={(v) => fmtShare(v, loc)}
            percent={false}
            legend={false}
            parts={[
              ...shares.top.map((s, i) => ({
                key: s.id,
                label: `${rank.get(s.id)}. ${s.query.slice(0, 40)}${s.query.length > 40 ? "…" : ""}`,
                value: s.share,
                step: 1 - i / Math.max(1, shares.top.length),
              })),
              { key: "rest", label: ut("ops.ch.sqlRest"), value: shares.rest, color: "var(--grid)" },
            ]}
          />
          <ul className="m-0 mt-[8px] grid list-none gap-[4px] p-0 text-[13px] leading-[18px]">
            {shares.top.map((s) => (
              <li key={s.id} className="flex min-w-0 items-baseline justify-between gap-[12px]">
                <span className="min-w-0 truncate font-mono text-[12px] text-text-2" title={s.query}>
                  <span className="text-muted">{rank.get(s.id)}.</span> {s.query}
                </span>
                <span className="shrink-0 font-mono text-[12px] text-muted tabular-nums">{fmtShare(s.share, loc)}</span>
              </li>
            ))}
            <li className="flex min-w-0 items-baseline justify-between gap-[12px]">
              <span className="text-text-2">{ut("ops.ch.sqlRest")}</span>
              <span className="shrink-0 font-mono text-[12px] text-muted tabular-nums">{fmtShare(shares.rest, loc)}</span>
            </li>
          </ul>
        </Figure>
      ) : null}
    </div>
  );
}

/**
 * Куда ушло время одного запроса: запросы к базе и всё остальное — одной
 * полосой. Отвечает на первый вопрос разбора «медленно»: ждали базу или
 * считали сами.
 */
export function TraceTime({ summary }: { summary: OpsTraceSummary | null }) {
  const { ut } = useLang();
  const loc = locale();
  const t = traceTime(summary);
  if (!t) return null;
  return (
    <Figure title={ut("ops.ch.traceTime")} caption={fmtMs(summary!.ms, loc)} className="mt-[24px] max-w-[560px]">
      <ShareBar
        label={ut("ops.ch.traceTime")}
        format={(v) => fmtMs(v, loc)}
        parts={[
          { key: "sql", label: ut("ops.ch.traceSql"), value: t.sql, step: 1 },
          /* «решта» — дорожкой сетки: это не ещё одна часть той же величины, а всё, что не база */
          { key: "other", label: ut("ops.ch.traceOther"), value: t.other, color: "var(--grid)" },
        ]}
      />
    </Figure>
  );
}
