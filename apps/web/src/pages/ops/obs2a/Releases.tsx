import { useMemo } from "react";
import type { OpsCompareStats, OpsReleaseCompare, OpsRouteCompare } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useUrlState } from "../../../ui";
import { Button, Field, Input, Num, Select } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { fmtInt, fmtMs, fmtShare } from "../model";
import { Cell, GridRow, GridTable, NumHead, Quiet, StatusMark } from "../parts";
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
 * процесса и предыдущая. «Лише погіршення» — тоже в адресе (?worse=1):
 * ссылку «вот что сломала выкатка» пересылают.
 *
 * Сдвиг — словом и формой точки, а не цветом: «гірше» янтарём (требует
 * внимания), «краще» — фиолетовым, «без змін» и «замало запитів» — тихо.
 * Где запросов меньше порога, процентов нет вовсе: «+300 %» от трёх
 * запросов — шум, и экран не должен выдавать его за вывод.
 */

const COLS = "grid-cols-[minmax(240px,1fr)_96px_80px_80px_150px_72px_72px_150px]";

export default function OpsReleasesPage() {
  const { ut } = useLang();
  const loc = locale();
  const [rawBefore, setBefore] = useUrlState("before", "");
  const [rawAfter, setAfter] = useUrlState("after", "");
  const [worse, setWorse] = useUrlState("worse", "");
  const [q, setQ] = useUrlState("q", "");

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
    const base = worse ? onlyWorse(cmp.data.items) : cmp.data.items;
    return filterCompare(base, q);
  }, [cmp.data, worse, q]);

  if (list.error && !list.data) return <Loading error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading rows={5} />;
  const releases = list.data.items;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-[24px] gap-y-[4px] pt-[20px] text-[13px] leading-[18px] text-muted">
        <span>
          {fill(ut("ops.rel.lead"), { current: list.data.current, n: list.data.retentionDays })}
        </span>
      </div>

      <RuleSection
        className="mt-[16px]"
        title={ut("ops.rel.title")}
        hint={
          cmp.data
            ? fill(ut("ops.rel.thresholds"), {
                min: cmp.data.thresholds.minSample,
                ratio: fmtShare(cmp.data.thresholds.p95Ratio - 1, loc),
                ms: fmtMs(cmp.data.thresholds.p95MinMs, loc),
                pp: fmtInt(cmp.data.thresholds.errorPp * 100, loc),
                errors: cmp.data.thresholds.errorMin,
              })
            : undefined
        }
      >
        {releases.length < 2 ? (
          <Quiet>
            {releases.length === 0
              ? ut("ops.rel.none")
              : fill(ut("ops.rel.single"), { version: releases[0]!.version })}
          </Quiet>
        ) : (
          <>
            <div className="mb-[14px] flex flex-wrap items-end gap-[12px]">
              {/* подпись видимая: «було» и «стало» — не подсказка поля, а смысл выбора */}
              <Field inline label={ut("ops.rel.before")} labelClassName="mb-[4px] block text-[13px] font-bold leading-[16px] text-muted">
                <Select value={before} onChange={(e) => setBefore(e.target.value)} className="w-[260px] max-[600px]:w-full">
                  {releases.map((r) => (
                    <option key={r.version} value={r.version}>
                      {r.version} · {dateTime(r.firstAt)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field inline label={ut("ops.rel.after")} labelClassName="mb-[4px] block text-[13px] font-bold leading-[16px] text-muted">
                <Select value={after} onChange={(e) => setAfter(e.target.value)} className="w-[260px] max-[600px]:w-full">
                  {releases.map((r) => (
                    <option key={r.version} value={r.version}>
                      {r.version} · {dateTime(r.firstAt)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Input
                look="fill"
                ph="plain"
                aria-label={ut("ops.routes.search")}
                placeholder={ut("ops.routes.search")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-[240px] px-[10px] max-[600px]:w-full"
                autoComplete="off"
                maxLength={120}
              />
              <Button variant={worse ? "primary" : "ghost"} aria-pressed={Boolean(worse)} onClick={() => setWorse(worse ? "" : "1")}>
                {ut("ops.rel.onlyWorse")}
              </Button>
            </div>

            {cmp.error && !cmp.data ? (
              <Loading error={cmp.error} onRetry={cmp.reload} />
            ) : !cmp.data || !rows ? (
              <Loading rows={5} />
            ) : (
              <CompareTable c={cmp.data} rows={rows} worse={Boolean(worse)} />
            )}
          </>
        )}
      </RuleSection>
    </div>
  );
}

function Windows({ c }: { c: OpsReleaseCompare }) {
  const { ut } = useLang();
  const loc = locale();
  const side = (label: string, s: NonNullable<OpsReleaseCompare["before"]>) => (
    <span className="min-w-0">
      <span className="font-bold text-text">{label}</span>{" "}
      {fill(ut("ops.rel.window"), {
        version: s.version,
        from: dateTime(s.from),
        to: new Date(s.to).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" }),
        n: fmtInt(s.requests, loc),
      })}
    </span>
  );
  return (
    <div className="mb-[12px] flex flex-col gap-[4px] text-[13px] leading-[18px] text-muted">
      {c.before ? side(ut("ops.rel.before"), c.before) : null}
      {c.after ? side(ut("ops.rel.after"), c.after) : null}
      {c.grain === "hour" ? <StatusMark tone="warn">{ut("ops.rel.hourly")}</StatusMark> : null}
    </div>
  );
}

function CompareTable({ c, rows, worse }: { c: OpsReleaseCompare; rows: OpsRouteCompare[]; worse: boolean }) {
  const { ut } = useLang();
  const loc = locale();
  if (!c.before || !c.after) return <Quiet>{ut("ops.rel.noPair")}</Quiet>;
  return (
    <>
      <Windows c={c} />
      {c.items.length === 0 ? (
        <Quiet>{ut("ops.rel.empty")}</Quiet>
      ) : rows.length === 0 ? (
        <Quiet>{worse ? ut("ops.rel.noWorse") : ut("ops.routes.noMatch")}</Quiet>
      ) : (
        <GridTable
          label={ut("ops.rel.title")}
          cols={COLS}
          minW="min-w-[1000px]"
          head={[
            ut("ops.col.route"),
            <NumHead key="n">{ut("ops.rel.requests")}</NumHead>,
            <NumHead key="pb">{ut("ops.rel.p95Before")}</NumHead>,
            <NumHead key="pa">{ut("ops.rel.p95After")}</NumHead>,
            ut("ops.rel.p95Shift"),
            <NumHead key="eb">{ut("ops.rel.errBefore")}</NumHead>,
            <NumHead key="ea">{ut("ops.rel.errAfter")}</NumHead>,
            ut("ops.rel.errShift"),
          ]}
        >
          {rows.map((r) => (
            <GridRow key={`${r.method} ${r.route}`} cols={COLS} className="items-start">
              <Cell>
                <span className="flex min-w-0 items-baseline gap-[8px] font-mono text-[12px]">
                  <span className="w-[48px] shrink-0 text-muted">{r.method}</span>
                  <span className="min-w-0 break-all text-text">{r.route}</span>
                </span>
                {!r.before || !r.after ? (
                  <span className="mt-[2px] block text-[12px] text-muted">{ut(r.before ? "ops.rel.gone" : "ops.rel.new")}</span>
                ) : null}
              </Cell>
              <Cell num className="text-text-2">
                {fmtInt(r.before?.requests ?? 0, loc)} → {fmtInt(r.after?.requests ?? 0, loc)}
              </Cell>
              <Cell num>{fmtMs(r.before?.p95 ?? null, loc)}</Cell>
              <Cell num className={r.latency === "worse" ? "font-bold text-text" : undefined}>
                {fmtMs(r.after?.p95 ?? null, loc)}
              </Cell>
              <Cell>
                <Shift shift={r.latency} detail={latencyDetail(r.before, r.after, loc)} />
              </Cell>
              <Cell num>{fmtShare(r.before?.share5xx ?? null, loc)}</Cell>
              <Cell num className={r.errors === "worse" ? "font-bold text-text" : undefined}>
                {fmtShare(r.after?.share5xx ?? null, loc)}
              </Cell>
              <Cell>
                <Shift
                  shift={r.errors}
                  detail={(() => {
                    const d = shareDelta(r.before, r.after);
                    return d === null ? null : fill(ut("ops.rel.pp"), { n: fmtSignedPp(d, loc) });
                  })()}
                />
              </Cell>
            </GridRow>
          ))}
        </GridTable>
      )}
    </>
  );
}

function latencyDetail(b: OpsCompareStats | null, a: OpsCompareStats | null, loc: string): string | null {
  const d = p95Delta(b, a);
  if (d === null) return null;
  const r = p95Ratio(b, a);
  return r === null ? fmtSignedMs(d, loc) : `${fmtSignedMs(d, loc)} (${fmtSignedPct(r, loc)})`;
}

/**
 * Сдвиг словом с формой точки и под ним — разница числом. У «замало
 * запитів» разницы нет: ни мс, ни процентов, иначе глаз прочтёт число, а
 * не оговорку.
 */
function Shift({ shift, detail }: { shift: OpsRouteCompare["latency"]; detail: string | null }) {
  const { ut } = useLang();
  return (
    <span className="flex flex-col gap-[2px]">
      <StatusMark tone={SHIFT_TONE[shift]}>{ut(SHIFT_KEY[shift])}</StatusMark>
      {shift !== "few" && detail ? <Num className="text-[12px] text-muted">{detail}</Num> : null}
    </span>
  );
}
