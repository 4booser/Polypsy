import { useState, type ReactNode } from "react";
import type { RespondentDynamics, ResponseContext, ResponseDetail, RuleHit, SurveyFull } from "@quizzy/shared";
import { api } from "../../api";
import { decideHit } from "../../components/Suggestions";
import { ScaleProfile, SeverityMeter } from "../../charts/clinical";
import { ChartLegend, OTHER_COLOR, SINGLE_COLOR, useDecimal } from "../../charts/kit";
import { dateTime, day, duration } from "../../format";
import { useLang } from "../../lang";
import { Callout, Ic, KV, Loading, Popover, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { IconTile, Panel } from "../../ui/layout";
import { Button, ButtonLink, Input, SeverityTag, Tag } from "../../ui/primitives";
import { firstChange, mainScore, reviewHref, signalStrip } from "./context";
import { ItemTimes } from "./ItemTimes";
import { buildAnswering, resultRows, scaleChange, type ResultRow, type ScaleChange, type ShiftLine } from "./model";
import { Rx } from "./icons";

/*
 * Общие панели протокола и графиков: «Результат» и «Як відповідав». На
 * протоколе — короче (лестница полос с рекомендациями, малый график времени),
 * на графиках — полнее (сведения о шкале, смысл результата, время с порогом
 * и перечнями).
 */

const VERDICT_KEY = {
  better: "kit.reliablyBetter",
  worse: "kit.reliablyWorse",
  within: "kit.withinError",
  changed: "course.v.changed",
  unknown: "course.v.unknown",
  version: "rp.cmp.version",
  units: "rp.cmp.units",
  unreliable: "rp.cmp.unreliable",
} as const;

/** «−5 від 24 серп., у межах похибки» */
function ShiftText({ line }: { line: ShiftLine }) {
  const { ut } = useLang();
  const dec = useDecimal();
  const sign = line.delta > 0 ? "+" : line.delta < 0 ? "−" : "±";
  return (
    <span>
      <b className="font-extrabold text-text">
        {sign}
        {dec(Math.abs(line.delta))}
      </b>{" "}
      {ut("rp.since").replace("{d}", day(line.at))}, {ut(VERDICT_KEY[line.verdict])}
    </span>
  );
}

function ChangeLines({ change }: { change: ScaleChange | null }) {
  const { ut } = useLang();
  const dec = useDecimal();
  if (!change || (!change.fromPrev && !change.fromStart)) return null;
  return (
    <div className="flex flex-col items-end gap-0.5 text-right text-small text-text-2 max-[700px]:items-start max-[700px]:text-left">
      {change.fromPrev ? <ShiftText line={change.fromPrev} /> : null}
      {change.fromStart ? <ShiftText line={change.fromStart} /> : null}
      {change.rc !== null ? <span>{ut("rp.rcLine").replace("{n}", dec(change.rc))}</span> : null}
    </div>
  );
}

/**
 * Значение шкалы словами экрана: «14 з 27», «частка 0,2», «T 64» — с
 * запятой там, где её пишет язык (ResultRow.valueText — с точкой, для
 * проверок и печати).
 */
function useValueText(): (r: ResultRow) => string {
  const { ut } = useLang();
  const dec = useDecimal();
  return (r) => {
    if (!r.normalized || r.normalization === "raw") {
      const top = r.meterMax ?? (r.rungs.length ? Math.max(...r.rungs.map((g) => g.max)) : null);
      return top !== null && top > 0 ? `${dec(r.value)} ${ut("common.of")} ${dec(top)}` : dec(r.value);
    }
    return `${ut(`norm.${r.normalization}`)} ${dec(r.value)}`;
  };
}

function rulerLabel(r: ResultRow, text: string): string {
  return `${r.title}: ${text}${r.band ? ` — ${r.band.label}` : ""}`;
}

function drawable(r: ResultRow): boolean {
  return r.rungs.length > 0 || r.meterMax !== null;
}

/** Крупное число шкалы: «14 з 27» и ступень словом */
function BigNumber({ r }: { r: ResultRow }) {
  const { ut } = useLang();
  const dec = useDecimal();
  const raw = !r.normalized || r.normalization === "raw";
  const valueText = useValueText();
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      {raw ? (
        <>
          <span className="text-stat font-extrabold leading-none tracking-[-0.03em] text-text tabular-nums">{dec(r.value)}</span>
          {r.meterMax !== null || r.rungs.length ? (
            <span className="text-body font-bold text-muted">
              {ut("common.of")} {dec(r.meterMax ?? Math.max(...r.rungs.map((g) => g.max)))}
            </span>
          ) : null}
        </>
      ) : (
        <span className="text-stat font-extrabold leading-none tracking-[-0.03em] text-text tabular-nums">{valueText(r)}</span>
      )}
      {r.band ? <SeverityTag level={r.band.severity}>{r.band.label}</SeverityTag> : null}
    </div>
  );
}

/** Пометки шкалы словами: не нормировано, полос нет, вне лестницы */
function ScaleNote({ r }: { r: ResultRow }) {
  const { ut } = useLang();
  const text = !r.normalized ? ut("rch.notNormalized") : r.noBands ? ut("rch.noBands") : r.outside ? ut("rch.outside") : null;
  return text ? <p className="m-0 mt-2 text-small text-muted">{text}</p> : null;
}

/**
 * «Результат».
 *
 * Одна содержательная шкала — крупно: число, ступень, сдвиг от прошлого и от
 * старта с порогом надёжной зміни, шкала тяжести. Шкалы достоверности при
 * этом идут строкой ниже — они говорят о бланке, а не о человеке. Несколько
 * содержательных шкал — профилем строками.
 */
export function ResultPanel({
  detail,
  dynamics,
  ctx,
  variant,
  chartsHref,
}: {
  detail: ResponseDetail;
  dynamics: RespondentDynamics | null;
  ctx: ResponseContext | null;
  variant: "protocol" | "charts";
  chartsHref?: string;
}) {
  const { ut } = useLang();
  const dec = useDecimal();
  const valueText = useValueText();
  const rows = resultRows(detail, {
    of: ut("common.of"),
    norm: { raw: ut("norm.raw"), ratio: ut("norm.ratio"), tscore: ut("norm.tscore"), sten: ut("norm.sten") },
  });
  const action = chartsHref ? (
    <ButtonLink to={chartsHref} variant="ghost" size="xs">
      {ut("rch.tabCharts")}
      <Ic.chevronRight />
    </ButtonLink>
  ) : null;

  if (!rows.length) {
    return (
      <Panel title={ut("rch.result")} icon={<Ic.gauge />}>
        <p className="m-0 text-small text-muted">
          {!detail.survey.scoringEnabled || detail.status === "completed" ? ut("rsp.scoresOff") : ut("rsp.notSubmitted")}
        </p>
      </Panel>
    );
  }

  const clinical = detail.scores.filter((s) => s.kind === "clinical");
  const main = mainScore(detail.scores)!;
  if (clinical.length > 1) return <ProfilePanel rows={rows} action={action} />;

  const r = rows.find((x) => x.scaleId === main.scaleId)!;
  const validity = rows.filter((x) => x.scaleId !== main.scaleId);
  const change = scaleChange(detail, dynamics, r.code, r.rungs);
  const bands = main.bands;
  const answered = detail.answers.filter((a) => a.answered).length;
  const skipped = detail.answers.length - answered;
  const critical = detail.answers.some((a) => a.options.some((o) => o.riskFlag && (a.optionIds ?? []).includes(o.id)));
  const strip = signalStrip(ctx?.signals ?? null);
  const sub = [r.title, ut(`norm.${r.normalization}`)].join(", ");

  const head = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <BigNumber r={r} />
        <ChangeLines change={change} />
      </div>
      {drawable(r) ? (
        <div className="mt-4">
          <SeverityMeter rungs={r.rungs} value={r.value} max={r.meterMax} valueLabel={valueText(r)} label={rulerLabel(r, valueText(r))} />
        </div>
      ) : null}
      <ScaleNote r={r} />
      {validity.length ? (
        <p className="m-0 mt-3 text-small text-text-2">
          {validity.map((v, i) => (
            <span key={v.scaleId}>
              {i ? "; " : ""}
              <b className="font-bold text-text">{v.title}</b> {valueText(v)}
              {v.band ? ` — ${v.band.label}` : ""}
            </span>
          ))}
        </p>
      ) : null}
    </>
  );

  if (variant === "protocol") {
    return (
      <Panel title={ut("rch.result")} icon={<Ic.gauge />} sub={sub} actions={action}>
        {head}
        {bands.length ? (
          <ol className="m-0 mt-4 list-none p-0">
            {[...bands]
              .sort((a, b) => a.minScore - b.minScore)
              .map((b) => (
                <li
                  key={b.id}
                  className={cx(
                    "grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 border-t border-divider px-2 py-3 first:border-t-0",
                    b.hit && "rounded-[12px] border-t-transparent bg-violet-tint [&+li]:border-t-transparent",
                  )}
                >
                  <span className="pt-0.5 text-small font-extrabold text-text tabular-nums">
                    {dec(b.minScore)}–{dec(b.maxScore)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <SeverityTag level={b.severity} small>
                        {b.label}
                      </SeverityTag>
                      {b.hit ? (
                        <Tag tone="primary">
                          {ut("kit.thisOne")}
                          <span className="sr-only"> — {ut("rsp.hitBand")}</span>
                        </Tag>
                      ) : null}
                    </div>
                    {b.recommendation || b.description ? (
                      <p className="m-0 mt-1.5 whitespace-pre-line text-small text-text-2">{b.recommendation ?? b.description}</p>
                    ) : null}
                  </div>
                </li>
              ))}
          </ol>
        ) : null}
      </Panel>
    );
  }

  const band = r.band;
  return (
    <Panel title={ut("rch.result")} icon={<Ic.gauge />} sub={sub}>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-6 max-[1100px]:grid-cols-1">
        <div className="min-w-0">
          {head}
          <KV
            className="mt-4"
            w={130}
            rows={[
              [ut("rp.kv.norm"), ut(`norm.${r.normalization}`)],
              [ut("rp.kv.rc"), change?.rc != null ? ut("rp.kv.rcFrom").replace("{n}", dec(change.rc)) : ut("course.v.unknown")],
              [ut("rp.kv.sem"), change?.sem != null ? `±${dec(change.sem)}` : "—"],
              [
                ut("rp.kv.answers"),
                `${ut("rp.kv.answered").replace("{n}", String(answered)).replace("{m}", String(detail.answers.length))}${
                  skipped ? `, ${ut("rp.kv.skipped").replace("{n}", String(skipped))}` : `, ${ut("rp.kv.noSkips")}`
                }`,
              ],
            ]}
          />
        </div>
        <div className="flex flex-col gap-3 self-start rounded-[12px] bg-panel-2 px-4 py-3.5">
          {band?.description ? (
            <div>
              <h3 className="m-0 text-caption font-bold text-muted">{ut("rch.interpretation")}</h3>
              <p className="m-0 mt-1 whitespace-pre-line text-body text-text">{band.description}</p>
            </div>
          ) : null}
          {band?.recommendation ? (
            <div>
              <h3 className="m-0 text-caption font-bold text-muted">{ut("rch.recommendation")}</h3>
              <p className="m-0 mt-1 whitespace-pre-line text-body text-text">{band.recommendation}</p>
            </div>
          ) : null}
          {!band?.description && !band?.recommendation ? <p className="m-0 text-small text-muted">{ut("rp.noMeaning")}</p> : null}
          {critical ? (
            <Callout
              kind="risk"
              icon={<Rx.siren />}
              actions={
                strip.openHere.length ? (
                  <ButtonLink to={reviewHref(ctx?.patient?.id ?? detail.userId)} variant="risk" size="xs">
                    {ut("rp.reviewSignal")}
                  </ButtonLink>
                ) : null
              }
            >
              {strip.openHere.length ? ut("rp.criticalOpen") : ut("rp.criticalAnswer")}
            </Callout>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function ProfilePanel({ rows, action }: { rows: ResultRow[]; action: ReactNode }) {
  const { ut } = useLang();
  const valueText = useValueText();
  const notes = rows.filter((r) => !r.normalized || r.noBands || r.outside || !!r.band?.description || !!r.band?.recommendation);
  return (
    <Panel title={ut("rch.result")} icon={<Ic.gauge />} actions={action}>
      <ScaleProfile
        rows={rows.map((r) => ({
          key: r.scaleId,
          title: r.title,
          rungs: r.rungs,
          value: drawable(r) ? r.value : null,
          max: r.meterMax,
          valueText: valueText(r),
          band: r.band ? { label: r.band.label, severity: r.band.severity } : null,
        }))}
      />
      {notes.length ? (
        <dl className="m-0 mt-5 grid gap-y-3">
          {notes.map((r) => (
            <div key={r.scaleId} className="grid grid-cols-[minmax(96px,200px)_minmax(0,1fr)] gap-x-5 gap-y-1 max-[700px]:grid-cols-1">
              <dt className="text-small font-extrabold text-text">{r.title}</dt>
              <dd className="m-0 flex min-w-0 flex-col gap-1 text-small text-text-2">
                {r.band ? (
                  <span>
                    <SeverityTag level={r.band.severity} small>
                      {r.band.label}
                    </SeverityTag>
                  </span>
                ) : null}
                {!r.normalized ? <span className="text-muted">{ut("rch.notNormalized")}</span> : null}
                {r.noBands ? <span className="text-muted">{ut("rch.noBands")}</span> : null}
                {r.outside ? <span className="text-muted">{ut("rch.outside")}</span> : null}
                {r.band?.description ? <span className="whitespace-pre-line">{r.band.description}</span> : null}
                {r.band?.recommendation ? (
                  <span className="whitespace-pre-line">
                    <b className="font-bold text-muted">{ut("rch.recommendation")}: </b>
                    {r.band.recommendation}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Panel>
  );
}

/**
 * «Як відповідав»: сколько заняло, медиана на пункт, смены и пропуски — и
 * время по пунктам столбцами. Подсказка разбирающему, а не вердикт: об этом
 * говорит строка под графиком.
 */
export function AnsweringPanel({
  detail,
  survey,
  surveyLoading,
  variant,
  chartsHref,
}: {
  detail: ResponseDetail;
  survey: SurveyFull | null;
  /** Порог «слишком быстро» — методики той версии: пока она едет, столбцы не красятся дважды */
  surveyLoading: boolean;
  variant: "protocol" | "charts";
  chartsHref?: string;
}) {
  const { ut } = useLang();
  const dec = useDecimal();
  const action =
    variant === "protocol" && chartsHref ? (
      <ButtonLink to={chartsHref} variant="ghost" size="xs">
        {ut("rp.ans.details")}
      </ButtonLink>
    ) : null;
  if (surveyLoading) {
    return (
      <Panel title={ut("rch.answering")} icon={<Ic.timer />} actions={action}>
        <Loading rows={2} bare />
      </Panel>
    );
  }
  const a = buildAnswering(detail, survey?.tooFastMs ?? null);
  if (!a.items.length) return null;
  const secs = (ms: number) => dec(ms / 1000, 1);
  const item = (n: number) => ut("rch.itemN").replace("{n}", String(n));
  const textOf = new Map(detail.answers.flatMap((x) => x.options.map((o) => [o.id, o.text] as const)));
  const ordered = [...detail.answers].sort((x, y) => x.position - y.position);
  const changeNote = (n: number) => {
    const ans = ordered[n - 1];
    const fc = ans ? firstChange(ans) : null;
    if (!ans || !fc) return null;
    const final = (ans.optionIds ?? [])[0];
    return ut("rp.ans.changedFrom")
      .replace("{from}", textOf.get(fc.firstOptionId) ?? "—")
      .replace("{to}", final ? (textOf.get(final) ?? "—") : "—")
      .replace("{s}", secs(fc.afterMs));
  };

  const parts: string[] = [];
  if (a.totalMs !== null) parts.push(ut("rp.ans.total").replace("{t}", duration(a.totalMs)));
  if (a.medianMs !== null) parts.push(ut("rp.ans.median").replace("{t}", `${secs(a.medianMs)} ${ut("rch.sec")}`));
  if (a.changed.length) parts.push(ut("rp.ans.changed").replace("{n}", String(a.changed.length)));
  if (a.unanswered) parts.push(ut("rp.ans.skipped").replace("{n}", String(a.unanswered)));
  if (a.fast.length) parts.push(ut("rp.ans.fast").replace("{n}", String(a.fast.length)));
  if (!a.unanswered && !a.fast.length) parts.push(ut("rp.ans.clean"));

  const changedSet = new Set(a.changed.map((c) => c.number));
  const chart = a.timed ? (
    <ItemTimes
      label={ut("rch.timeChart")}
      threshold={a.thresholdMs / 1000}
      thresholdLabel={ut("rch.threshold")}
      fastLabel={ut("rch.fastList")}
      aboveLabel={ut("rch.aboveAxis")}
      changedLabel={ut("rp.ans.lgChanged")}
      unit={ut("rch.sec")}
      height={variant === "protocol" ? 150 : 190}
      columns={a.items.map((i) => ({
        key: i.questionId,
        label: variant === "protocol" ? String(i.number) : item(i.number),
        title: item(i.number),
        value: Math.round(i.ms / 100) / 10,
        fast: i.fast,
        changed: changedSet.has(i.number),
      }))}
    />
  ) : (
    <p className="m-0 text-small text-muted">{ut("rch.noTimes")}</p>
  );
  const legend = a.timed ? (
    <ChartLegend
      always
      items={[
        ...(changedSet.size
          ? [
              { key: "changed", label: ut("rp.ans.lgChanged"), color: SINGLE_COLOR },
              { key: "other", label: ut("rp.ans.lgOther"), color: OTHER_COLOR },
            ]
          : []),
        { key: "thr", label: `${ut("rch.threshold")} ${secs(a.thresholdMs)} ${ut("rch.sec")}`, color: "var(--axis)", kind: "dash" as const },
      ]}
    />
  ) : null;
  const sentence = <p className="m-0 text-small text-text-2">{parts.join(", ")}.</p>;

  if (variant === "protocol") {
    return (
      <Panel title={ut("rch.answering")} icon={<Ic.timer />} actions={action}>
        {sentence}
        <div className="mt-3">{chart}</div>
        {legend}
        {a.timed ? <p className="m-0 mt-2 text-caption text-muted">{ut("rch.timeCaption").replace("{t}", secs(a.thresholdMs))}</p> : null}
      </Panel>
    );
  }
  return (
    <Panel title={ut("rch.answering")} icon={<Ic.timer />}>
      {sentence}
      <h3 className="m-0 mt-3 text-small font-extrabold text-text">{ut("rch.timeChart")}</h3>
      <div className="mt-2">{chart}</div>
      {legend}
      {a.timed ? <p className="m-0 mt-2 text-caption text-muted">{ut("rch.timeCaption").replace("{t}", secs(a.thresholdMs))}</p> : null}
      <KV
        className="mt-4"
        w={150}
        rows={[
          [
            `${ut("rch.fastList")}`,
            a.fast.length ? a.fast.map(item).join(", ") : a.timed ? ut("rch.noneWord") : "—",
          ],
          [
            ut("rch.changedList"),
            a.changed.length ? (
              <span className="flex flex-col gap-0.5">
                {a.changed.map((c) => (
                  <span key={c.number}>
                    <b className="font-extrabold">{item(c.number)}</b>
                    {c.times > 1 ? ` ×${c.times}` : ""}
                    {changeNote(c.number) ? ` — ${changeNote(c.number)}` : ""}
                  </span>
                ))}
              </span>
            ) : (
              ut("rch.noneWord")
            ),
          ],
        ]}
      />
      <p className="m-0 mt-3 text-caption text-muted">{ut("rch.answeringHint")}</p>
    </Panel>
  );
}

/* ─────────── правила ─────────── */

function hitIcon(h: RuleHit): ReactNode {
  const kind = h.explanation.actions[0]?.kind;
  if (kind === "notify_duty") return <Rx.bellRing />;
  if (kind === "suggest_survey") return <Rx.clipboardPlus />;
  if (kind === "suggest_pathway") return <Rx.route />;
  return <Ic.info />;
}

const ACTION_KEY = {
  notify_duty: "ds.actNotifyDuty",
  suggest_survey: "ds.actSurvey",
  suggest_pathway: "ds.actPathway",
} as const;

/**
 * «Що далі за правилами»: что по этому прохождению предложили правила
 * поддержки решений, и решение — тут же. Отклонение требует причины (сервер:
 * err.declineNeedsNote), поэтому «Відхилити» сперва просит строку.
 */
export function RulesPanel({ hits, reload, title, hint }: { hits: RuleHit[]; reload: () => void; title?: string; hint?: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [declining, setDeclining] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [meanwhile, setMeanwhile] = useState<string | null>(null);
  const decide = (hit: RuleHit, status: "accepted" | "declined", done: string, why?: string) =>
    void run(async () => {
      setMeanwhile(null);
      const outcome = await decideHit(() => api.decideHit(hit.id, status, why), reload);
      if (declining === hit.id) {
        setDeclining(null);
        setNote("");
      }
      if (!outcome.meanwhile) return true;
      setMeanwhile(outcome.meanwhile);
      return false;
    }, done);
  const actionText = (h: RuleHit) =>
    h.explanation.actions.map((a) => (a.kind === "advise" ? a.text : ut(ACTION_KEY[a.kind]))).join("; ");
  return (
    <Panel title={title ?? ut("rp.rules")} icon={<Rx.branch />}>
      {hint ? <p className="m-0 mb-2 text-small text-muted">{hint}</p> : null}
      {meanwhile ? (
        <p role="status" className="m-0 mb-2 text-small text-text-2">
          {meanwhile}
        </p>
      ) : null}
      {hits.length === 0 ? (
        <p className="m-0 text-small text-muted">{ut("rp.rulesNone")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {hits.map((h) => (
            <li key={h.id} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 border-t border-divider py-2.5 first:border-t-0 first:pt-0.5">
              <IconTile icon={hitIcon(h)} size={28} tone={h.explanation.actions.some((a) => a.kind === "notify_duty") ? "risk" : "neutral"} />
              <div className="min-w-0">
                <Popover
                  title={h.ruleTitle}
                  note={dateTime(h.createdAt)}
                  content={
                    <ul className="m-0 list-disc pl-4">
                      {h.explanation.because.map((b, i) => (
                        <li key={i}>{b.text}</li>
                      ))}
                    </ul>
                  }
                >
                  <b className="block cursor-default text-[13px] font-extrabold text-text">{h.ruleTitle}</b>
                </Popover>
                <span className="block text-small text-text-2">
                  {actionText(h)}
                  {h.status !== "suggested" ? (
                    <span className="text-muted">
                      {"; "}
                      {h.status === "accepted" ? ut("rp.hitAccepted") : ut("rp.hitDeclined")}
                    </span>
                  ) : null}
                </span>
                {h.status === "suggested" ? (
                  declining === h.id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Input
                        autoFocus
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={ut("ds.whyDecline")}
                        aria-label={ut("ds.whyDecline")}
                        className="min-w-[160px] flex-1"
                      />
                      <Button size="xs" disabled={busy || !note.trim()} onClick={() => decide(h, "declined", ut("ds.declined"), note.trim())}>
                        {ut("ds.decline")}
                      </Button>
                      <Button size="xs" variant="quiet" onClick={() => setDeclining(null)}>
                        {ut("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="xs" disabled={busy} icon={<Ic.check />} onClick={() => decide(h, "accepted", ut("ds.accepted"))}>
                        {ut("ds.accept")}
                      </Button>
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => setDeclining(h.id)}>
                        {ut("ds.decline")}
                      </Button>
                    </div>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
