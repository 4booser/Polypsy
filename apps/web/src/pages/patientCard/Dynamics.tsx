import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { pointValueTop, type RespondentDynamics, type ScaleDynamics } from "@quizzy/shared";
import { api } from "../../api";
import { CourseChart } from "../../charts/course";
import { courseEventsFromTimeline, courseFromDynamics } from "../../charts/courseModel";
import { sortRungs } from "../../charts/ladder";
import { severityKey } from "../../format";
import { useLang } from "../../lang";
import { useResourceMap } from "../../useResource";
import { Empty, Ic, Loading, Popover } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { signed } from "../../ui/numbers";
import { Button, Segmented, Select, SeverityTag, Switch } from "../../ui/primitives";
import { useUrlState } from "../../ui/urlState";
import { CLINICAL_DOMAIN_KEY as DOMAIN_KEY, shownStep, signedShown } from "../patients/model";
import { ChangeWords, ScoreText } from "./words";
import { itemsGrid, scaleRow, sevRank, type ItemsGrid, type PictureRow } from "./clinical";
import { dm } from "./format";
import { Pi } from "./icons";
import type { CardView } from "./types";

/*
 * «Динаміка» — одна методика целиком: как шёл балл по полосам, что с каждой
 * её шкалой, что человек отвечал по пунктам. Методика выбирается слева
 * (в узкой колонке — списком над графиком) в том же порядке, что строки
 * «Клінічної картини»: строка картины ведёт сюда с этой методикой (?m=).
 *
 * Прежде было два экрана с этим именем: «Графіки» карточки (по графику на
 * каждую шкалу в сетке, третий — один в полупустом ряду) и «Динаміка»
 * клинической карты (большие числа, курс, таблица RCI, «методики разом» в
 * процентах от максимума). Большие числа и надёжность сдвига теперь — слова
 * «Клінічної картини»; «методики разом» ушли: доля от максимума у WHO-5
 * (больше — лучше) и у AUDIT (больше — хуже) на одной оси читалась наоборот.
 */

export function DynamicsTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  const [m, setM] = useUrlState("m", "");
  if (!v.dynamics) return <Loading rows={6} error={v.dynamicsError} onRetry={v.reloadDynamics} />;
  /* порядок методик — как в картине: тяжёлое и рисковое первым */
  const order = [...new Set(v.picture.flatMap((g) => g.rows.map((r) => r.surveyId)))];
  const surveys = order
    .map((id) => v.dynamics!.surveys.find((s) => s.surveyId === id))
    .filter((s): s is RespondentDynamics["surveys"][number] => !!s);
  if (!surveys.length) return <Empty icon={<Pi.chartSpline />} title={ut("pt.noCompleted")} hint={ut("dyn.emptyHint")} />;
  const current = surveys.find((s) => s.surveyId === m) ?? surveys[0]!;
  return (
    <div className="@container">
      <div className="grid items-start gap-4 @min-[1000px]:grid-cols-[232px_minmax(0,1fr)]">
        <MethodRail v={v} surveys={surveys} current={current.surveyId} onPick={setM} />
        <MethodView key={current.surveyId} v={v} sv={current} />
      </div>
    </div>
  );
}

/** Список методик: колонкой слева на широком экране, выпадающим списком — на узком */
function MethodRail({
  v,
  surveys,
  current,
  onPick,
}: {
  v: CardView;
  surveys: RespondentDynamics["surveys"];
  current: string;
  onPick: (id: string) => void;
}) {
  const { ut } = useLang();
  const rowOf = (id: string) => v.picture.flatMap((g) => g.rows).find((r) => r.surveyId === id);
  return (
    <>
      <div className="flex items-center gap-2.5 @min-[1000px]:hidden">
        <span className="text-small font-bold text-muted">{ut("card.colInstrument")}</span>
        <Select value={current} onChange={(e) => onPick(e.target.value)} aria-label={ut("card.colInstrument")} className="max-w-[420px] flex-1">
          {v.picture.map((g) => (
            <optgroup key={g.domain} label={ut(DOMAIN_KEY[g.domain])}>
              {g.rows
                .filter((r, i, all) => all.findIndex((x) => x.surveyId === r.surveyId) === i)
                .map((r) => (
                  <option key={r.key} value={r.surveyId}>
                    {r.surveyTitle}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      </div>
      <nav aria-label={ut("card.colInstrument")} className="hidden @min-[1000px]:block">
        <Panel flush as="div">
          <ul className="m-0 list-none p-1.5">
            {surveys.map((s) => {
              const r = rowOf(s.surveyId);
              const on = s.surveyId === current;
              return (
                <li key={s.surveyId}>
                  <button
                    type="button"
                    aria-current={on || undefined}
                    onClick={() => onPick(s.surveyId)}
                    className={cx(
                      "flex w-full cursor-pointer items-center gap-2 rounded-[10px] border-0 px-2.5 py-2 text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]",
                      on ? "bg-violet-tint" : "bg-transparent hover:bg-panel-2",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <b className={cx("block truncate text-small font-extrabold", on ? "text-violet-ink" : "text-text")}>{r?.code ?? s.title}</b>
                      <span className="block truncate text-caption text-muted">{r ? ut(DOMAIN_KEY[r.domain]) : s.title}</span>
                    </span>
                    {r?.last.severity ? <i aria-hidden className={cx("size-2 shrink-0 rounded-full", SEV_DOT[r.last.severity])} /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      </nav>
    </>
  );
}

const SEV_DOT = { none: "bg-sev-0", mild: "bg-sev-1", moderate: "bg-sev-2", severe: "bg-sev-4" } as const;

/** Шкалы методики, о человеке: достоверности — нет; тяжёлая первой */
function clinicalScales(sv: RespondentDynamics["surveys"][number]): ScaleDynamics[] {
  const lastOf = (sc: ScaleDynamics) => [...sc.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).at(-1);
  return sv.scales
    .filter((sc) => sc.points.length > 0 && (sc.kind ?? "clinical") === "clinical")
    .sort((a, b) => sevRank(lastOf(b)?.severity) - sevRank(lastOf(a)?.severity));
}

function MethodView({ v, sv }: { v: CardView; sv: RespondentDynamics["surveys"][number] }) {
  const { ut } = useLang();
  const scales = clinicalScales(sv);
  const domainOf = (code: string) => v.card.domains?.find((d) => d.surveyId === sv.surveyId && d.code === code)?.domain ?? "other";
  const rows = scales.map((sc) => scaleRow(sv, sc, domainOf(sc.code)));
  const [pick, setPick] = useState<string>(scales[0]?.code ?? "");
  const row = rows.find((r) => r.scale.code === pick) ?? rows[0];
  const [equating, setEquating] = useState(false);
  const events = useMemo(() => courseEventsFromTimeline(v.timeline ?? []), [v.timeline]);
  if (!row) return <Empty title={ut("pt.noCompleted")} />;
  const last = row.last;
  const canEquate = !!row.scale.equated?.length;
  const series = equating ? { ...row.scale, points: row.scale.points.map((p) => ({ ...p, rawScore: equatedValue(p, row.scale.equated) })) } : row.scale;
  const rungs = sortRungs((row.scale.bands ?? []).map((b) => ({ min: b.min, max: b.max, label: b.label, severity: b.severity })));
  const course = courseFromDynamics(series, rungs);
  const draftable = v.can("conclusions.write") && v.card.responses.some((r) => r.responseId === last.responseId);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel
        title={sv.title}
        icon={<Pi.chartSpline />}
        sub={ut("ws.methodSub")
          .replace("{n}", String(sv.responseCount))
          .replace("{a}", sv.firstAt ? dm(sv.firstAt) : "—")
          .replace("{b}", sv.lastAt ? dm(sv.lastAt) : "—")}
        actions={
          <>
            <Link to={`/surveys/${sv.surveyId}/responses/${last.responseId}`} className="text-small font-bold text-violet-ink">
              {ut("ws.lastProtocol")}
            </Link>
            {draftable ? (
              <Button size="xs" icon={<Pi.filePlus />} onClick={() => v.open("concl", { responseId: last.responseId })}>
                {ut("card.concl")}
              </Button>
            ) : null}
          </>
        }
      >
        {rows.length > 1 ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {rows.length <= 5 ? (
              <Segmented
                label={ut("sum.scale")}
                value={row.scale.code}
                onChange={setPick}
                items={rows.map((r) => ({ key: r.scale.code, label: r.scaleTitle.length > 22 ? `${r.scaleTitle.slice(0, 21)}…` : r.scaleTitle }))}
              />
            ) : (
              <Select value={row.scale.code} onChange={(e) => setPick(e.target.value)} aria-label={ut("sum.scale")} className="max-w-[360px]">
                {rows.map((r) => (
                  <option key={r.scale.code} value={r.scale.code}>
                    {r.scaleTitle}
                  </option>
                ))}
              </Select>
            )}
          </div>
        ) : null}
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ScoreText p={last} big />
          {last.severity || last.bandLabel ? (
            <SeverityTag level={last.severity ?? "none"} className="!h-auto min-h-[26px] !whitespace-normal py-1">
              {last.bandLabel ?? ut(severityKey[last.severity ?? "none"])}
            </SeverityTag>
          ) : null}
          <ChangeWords r={row} />
        </div>
        <CourseChart title={row.scaleTitle} {...course} max={pointValueTop(last)} events={events} />
        {canEquate ? (
          <div className="mt-3 rounded-panel bg-sunk px-3.5 py-3">
            <Switch checked={equating} onChange={setEquating} label={ut("eq.title")} sub={ut("dyn.equateSub")} />
            <p className="m-0 mt-1.5 text-caption text-text-2">{ut("eq.hint")}</p>
          </div>
        ) : null}
      </Panel>
      {rows.length > 1 ? <ScalesTable rows={rows} current={row.scale.code} onPick={setPick} /> : null}
      <MeasuresOfScale row={row} />
      <ItemsPanel v={v} sv={sv} />
    </div>
  );
}

/** Все шкалы методики: последний балл, полоса и сдвиг словами — выбор шкалы для графика */
function ScalesTable({ rows, current, onPick }: { rows: PictureRow[]; current: string; onPick: (code: string) => void }) {
  const { ut } = useLang();
  return (
    <Panel title={ut("ws.scalesOf")} icon={<Ic.list />} flush>
      <ul className="m-0 list-none p-0">
        {rows.map((r) => (
          <li
            key={r.scale.code}
            className={cx(
              "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-divider px-4 py-2 @min-[760px]:grid-cols-[minmax(0,240px)_96px_minmax(0,1fr)_minmax(0,220px)]",
              r.scale.code === current && "bg-panel-2",
            )}
          >
            <button
              type="button"
              onClick={() => onPick(r.scale.code)}
              className="min-h-0 min-w-0 cursor-pointer truncate rounded-[4px] border-0 bg-transparent p-0 text-left text-small font-bold text-text outline-none hover:underline focus-visible:shadow-[0_0_0_2px_var(--vring)]"
            >
              {r.scaleTitle}
            </button>
            <ScoreText p={r.last} />
            <span className="min-w-0">
              {r.last.severity || r.last.bandLabel ? (
                <SeverityTag level={r.last.severity ?? "none"} small className="!h-auto min-h-[22px] !whitespace-normal py-[3px] leading-[14px]">
                  {r.last.bandLabel ?? ut(severityKey[r.last.severity ?? "none"])}
                </SeverityTag>
              ) : (
                <span className="text-small text-muted">{ut("ws.noBands")}</span>
              )}
            </span>
            <ChangeWords r={r} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Замеры шкалы по датам: балл, полоса, сдвиг от предыдущего, протокол */
function MeasuresOfScale({ row }: { row: PictureRow }) {
  const { ut } = useLang();
  const pts = [...row.points].reverse();
  const pp = row.last.normalization === "ratio" ? ` ${ut("card.pp")}` : "";
  return (
    <Panel title={ut("ws.measuresOf").replace("{s}", row.scaleTitle)} icon={<Ic.clipboard />} count={pts.length} flush>
      <table className="w-full table-fixed border-collapse text-small">
        <colgroup>
          <col className="w-[88px]" />
          <col className="w-[120px]" />
          <col />
          <col className="w-[110px]" />
          <col className="w-[96px]" />
        </colgroup>
        <thead>
          <tr className="[&>th]:h-[34px] [&>th]:border-y [&>th]:border-divider [&>th]:bg-panel-2 [&>th]:px-2 [&>th]:text-left [&>th]:text-caption [&>th]:font-bold [&>th]:text-muted">
            <th className="!pl-4">{ut("card.colDate")}</th>
            <th>{ut("ws.colScore")}</th>
            <th>{ut("sum.interpretation")}</th>
            <th>{ut("ws.colFromPrev")}</th>
            <th className="!pr-4" aria-label={ut("kit.rowActions")} />
          </tr>
        </thead>
        <tbody>
          {pts.map((p, i) => {
            const prev = pts[i + 1];
            const d = prev ? shownStep(p.rawScore - prev.rawScore, p.normalization) : null;
            return (
              <tr key={p.responseId} className="[&>td]:border-b [&>td]:border-divider [&>td]:px-2 [&>td]:py-2 [&>td]:align-middle">
                <td className="!pl-4 tabular-nums text-text-2">{dm(p.submittedAt)}</td>
                <td>
                  <ScoreText p={p} />
                </td>
                <td>
                  {p.severity || p.bandLabel ? (
                    <SeverityTag level={p.severity ?? "none"} small className="!h-auto min-h-[22px] !whitespace-normal py-[3px] leading-[14px]">
                      {p.bandLabel ?? ut(severityKey[p.severity ?? "none"])}
                    </SeverityTag>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                  {p.reliable === false ? <span className="ml-2 text-caption font-bold text-warn">{ut("ws.unreliable")}</span> : null}
                </td>
                <td className="tabular-nums text-text-2">{d === null ? ut("ws.vSingle") : `${signedShown(d)}${d ? pp : ""}`}</td>
                <td className="!pr-4 text-right">
                  <Link to={`/surveys/${row.surveyId}/responses/${p.responseId}`} className="font-bold text-violet-ink">
                    {ut("ws.protocol")}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

/**
 * Балл, приведённый к версии последнего замера.
 *
 * Если для версии этой точки коэффициентов нет — балл остаётся своим. Это
 * лучше, чем прятать точку: пропуск в ряду читается как «замера не было», а
 * замер был, просто свести его не из чего.
 */
function equatedValue(
  point: { rawScore: number; versionNo?: number | null },
  rules: { fromVersion: number; slope: number; intercept: number }[] | null | undefined,
): number {
  const rule = rules?.find((r) => r.fromVersion === point.versionNo);
  if (!rule) return point.rawScore;
  return Math.round((rule.slope * point.rawScore + rule.intercept) * 100) / 100;
}

/* ─────────── ответы по пунктам ─────────── */

function ItemsPanel({ v, sv }: { v: CardView; sv: RespondentDynamics["surveys"][number] }) {
  const ids = useMemo(() => {
    const at = new Map<string, number>();
    for (const sc of sv.scales) for (const p of sc.points) at.set(p.responseId, Date.parse(p.submittedAt));
    return [...at.keys()].sort((a, b) => at.get(a)! - at.get(b)!).slice(-4);
  }, [sv]);
  const details = useResourceMap("rd", ids, api.responseDetail);
  const ready = ids.length > 0 && ids.every((id) => id in details);
  const grid = useMemo(
    () => (ready ? itemsGrid(ids.map((id) => details[id]).filter((d): d is NonNullable<typeof d> => !!d)) : null),
    [ready, ids, details],
  );
  if (!ids.length) return null;
  return <ItemsTable v={v} title={sv.title} grid={grid} loading={!ready} surveyId={sv.surveyId} />;
}

const LONG = 12;

type ItemRowT = ItemsGrid["rows"][number];

/** Слово ответа в клетке — коротко: «Так», «Ні», первые буквы длинного */
const shortWord = (w: string | null) => (w === null ? "—" : w.length > 5 ? `${w.slice(0, 4)}…` : w);

function ItemsTable({ v, title, grid, loading, surveyId }: { v: CardView; title: string; grid: ItemsGrid | null; loading: boolean; surveyId: string }) {
  const { ut } = useLang();
  const [all, setAll] = useState(false);
  const caseHere = v.cases?.some((c) => c.surveyId === surveyId);
  const heading = ut("ws.itemsOf");
  if (loading) {
    return (
      <Panel title={heading} sub={title} icon={<Pi.listOrdered />}>
        <Loading rows={4} bare />
      </Panel>
    );
  }
  if (!grid) return null;
  const n = grid.columns.length;
  const cat = grid.categorical;
  const at = (r: ItemRowT, j: number) => (cat ? r.words[j] : r.cells[j]) ?? null;
  const changed = (r: ItemRowT) => n > 1 && at(r, n - 1) !== at(r, n - 2);
  const hot = (r: ItemRowT) => (cat ? !!r.flags[n - 1] : r.critical && (r.cells[n - 1] ?? 0) > 0);
  const long = grid.rows.length > LONG;
  const shown = all || !long ? grid.rows : grid.rows.filter((r) => hot(r) || changed(r));
  const level = (val: number) => (val <= 0 ? 0 : Math.min(5, Math.max(1, Math.round((val / Math.max(grid.max, 1)) * 5 + 0.49))));
  const cell = (r: ItemRowT | null, j: number, val: number | null) => {
    const flagged = r ? (cat ? !!r.flags[j] : r.critical && val !== null && val > 0) : false;
    if ((cat ? r?.words[j] : val) === null || (cat ? r?.words[j] : val) === undefined)
      return { cls: "bg-transparent text-muted shadow-[inset_0_0_0_1px_var(--border)]", style: undefined };
    if (flagged) return { cls: "bg-risk text-onfill", style: undefined };
    if (cat) return { cls: "bg-sunk text-text-2", style: undefined };
    const k = level(val ?? 0);
    return k === 0 ? { cls: "bg-sunk text-muted", style: undefined } : { cls: "", style: { background: `var(--h${k})`, color: `var(--h${k}i)` } };
  };
  const delta = (r: ItemRowT) => {
    const a = r.cells[0];
    const b = r.cells[n - 1];
    return a === null || a === undefined || b === null || b === undefined || n < 2 ? null : b - a;
  };
  const sumDelta = !cat && n > 1 && grid.sums[0] !== null && grid.sums[n - 1] !== null ? grid.sums[n - 1]! - grid.sums[0]! : null;
  return (
    <Panel
      title={heading}
      sub={title}
      icon={<Pi.listOrdered />}
      flush
      footer={
        <div className="flex w-full flex-wrap items-center gap-x-3.5 gap-y-1.5 text-caption font-semibold text-text-2">
          {cat ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="grid h-5 min-w-6 place-items-center rounded-[6px] bg-risk px-1 text-[11px] font-bold text-onfill" aria-hidden>
                !
              </span>
              {ut("card.criticalAnswer")}
            </span>
          ) : (
            grid.legend.map((l, i) => {
              const c = cell(null, 0, l.value);
              return (
                <span key={`${l.value}-${i}`} className="inline-flex items-center gap-1.5">
                  <span className={cx("grid h-5 min-w-6 place-items-center rounded-[6px] px-1 text-[11px] font-bold", c.cls)} style={c.style}>
                    {l.value}
                  </span>
                  {l.label}
                </span>
              );
            })
          )}
          {long ? (
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setAll((x) => !x)}>
              {all ? ut("card.itemsChanged") : ut("card.itemsAll").replace("{n}", String(grid.rows.length))}
            </Button>
          ) : null}
        </div>
      }
    >
      <table className="w-full table-fixed border-collapse text-[13px]">
        <colgroup>
          <col />
          {grid.columns.map((c) => (
            <col key={c.responseId} className="w-[52px]" />
          ))}
          {/* «Изменение» по-русски в 58 px не помещалось и резалось краем панели */}
          {cat ? null : <col className="w-[80px]" />}
        </colgroup>
        <thead>
          <tr className="[&>th]:h-[34px] [&>th]:border-y [&>th]:border-divider [&>th]:bg-panel-2 [&>th]:px-1 [&>th]:text-center [&>th]:text-[11.5px] [&>th]:font-bold [&>th]:text-muted">
            <th className="!pl-4 !text-left">{ut("cases.item")}</th>
            {grid.columns.map((c, j) => (
              <th key={c.responseId} className={j === n - 1 ? "!text-text" : undefined}>
                {dm(c.at)}
              </th>
            ))}
            {cat ? null : <th className="!pr-3.5">{ut("card.colDelta")}</th>}
          </tr>
        </thead>
        <tbody>
          {!shown.length ? (
            <tr>
              <td colSpan={n + 2} className="border-b border-divider px-4 py-3 text-small text-muted">
                {ut("card.itemsQuiet")}
              </td>
            </tr>
          ) : null}
          {shown.map((r) => {
            const d = delta(r);
            const critNow = hot(r);
            return (
              <tr
                key={r.questionId}
                className={cx("[&>td]:h-9 [&>td]:border-b [&>td]:px-1 [&>td]:text-center", critNow ? "[&>td]:border-risk-line [&>td]:bg-risk-tint" : "[&>td]:border-divider")}
              >
                <td className={cx("!pl-4 !text-left font-semibold", critNow ? "font-extrabold text-risk-ink" : "text-text-2")}>
                  <span className="flex min-w-0 items-center">
                    <i className={cx("inline-block w-6 shrink-0 font-bold not-italic", critNow ? "text-risk-ink" : "text-muted")}>{r.n}</i>
                    <Popover title={ut("card.itemN").replace("{n}", String(r.n))} note={r.critical ? ut("card.critical") : undefined} content={<ItemPeek r={r} grid={grid} />}>
                      <span tabIndex={0} className="min-w-0 cursor-default truncate border-b border-dotted border-ctl outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]">
                        {r.title}
                      </span>
                    </Popover>
                    {critNow && caseHere && v.can("alerts.review") && r === shown.find(hot) ? (
                      <Button variant="ghost" size="xs" className="ml-auto h-7 shrink-0 !text-risk-ink" onClick={() => v.open("signal")}>
                        {ut("card.review")}
                      </Button>
                    ) : null}
                  </span>
                </td>
                {r.cells.map((val, j) => {
                  const c = cell(r, j, val);
                  const word = r.words[j];
                  return (
                    <td key={grid.columns[j]!.responseId}>
                      <Popover title={r.title} note={dm(grid.columns[j]!.at)} content={<p className="m-0">{cat ? (word ?? "—") : val === null ? "—" : `${val}${word ? `, ${word}` : ""}`}</p>}>
                        <span
                          tabIndex={0}
                          className={cx(
                            "inline-grid h-6 min-w-8 cursor-default place-items-center rounded-[8px] px-1 text-caption font-bold outline-none hover:shadow-[0_0_0_2px_var(--panel),0_0_0_3.5px_var(--vring)] focus-visible:shadow-[0_0_0_2px_var(--panel),0_0_0_3.5px_var(--vring)]",
                            c.cls,
                          )}
                          style={c.style}
                        >
                          {cat ? shortWord(word) : val === null ? "—" : val}
                        </span>
                      </Popover>
                    </td>
                  );
                })}
                {cat ? null : (
                  <td className="!pr-3.5">
                    <span
                      className={cx(
                        "text-small font-bold",
                        d === null || d === 0 ? "text-muted" : r.critical && d > 0 ? "text-risk-ink" : d < 0 ? "text-good" : "text-muted",
                      )}
                    >
                      {d === null ? "—" : d === 0 ? "0" : signed(d)}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
          {cat ? null : (
            <tr className="[&>td]:h-10 [&>td]:px-1 [&>td]:text-center [&>td]:font-extrabold [&>td]:text-text">
              <td className="!pl-4 !text-left">{ut("card.sum")}</td>
              {grid.sums.map((s, j) => (
                <td key={grid.columns[j]!.responseId} className="tabular-nums">
                  {s ?? "—"}
                </td>
              ))}
              <td className="!pr-3.5">
                <span className="text-small font-bold text-muted">{sumDelta === null ? "—" : sumDelta === 0 ? "0" : signed(sumDelta)}</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function ItemPeek({ r, grid }: { r: ItemsGrid["rows"][number]; grid: ItemsGrid }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 text-text">{r.title}</p>
      <ul className="m-0 list-none p-0">
        {grid.columns.map((c, j) => (
          <li key={c.responseId} className="py-0.5">
            {dm(c.at)}:{" "}
            {grid.categorical ? (
              <b className="font-extrabold text-text">{r.words[j] ?? "—"}</b>
            ) : (
              <>
                <b className="font-extrabold text-text">{r.cells[j] ?? "—"}</b> {r.words[j] ? <span className="text-muted">{r.words[j]}</span> : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
