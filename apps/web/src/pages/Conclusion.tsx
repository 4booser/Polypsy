import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { DecisionRule, RespondentDynamics, ResponseContext, ResponseDetail, RuleHit } from "@quizzy/shared";
import { api, openInTab, type ConclusionState } from "../api";
import { useAuth } from "../auth";
import { useDecimal } from "../charts/kit";
import { ConclusionEditor, type SignLock } from "../components/ConclusionEditor";
import { dateTime, day, timeOfDay } from "../format";
import { useLang } from "../lang";
import { ActivityList, Callout, Ic, Loading, Popover, useAction } from "../ui";
import { cx } from "../ui/cx";
import { Panel } from "../ui/layout";
import { Button, ButtonLink, SeverityTag } from "../ui/primitives";
import { useResource } from "../useResource";
import { mainScore, reviewHref, signalStrip, signalTimer } from "./response/context";
import { useResponseExtras } from "./response/data";
import { ResponseBanner, ResponseFrame } from "./response/frame";
import { Rx } from "./response/icons";
import { scaleChange, type ShiftLine } from "./response/model";
import { RulesPanel } from "./response/panels";

/*
 * Заключение по прохождению — лист во всю колонку (Polypsy 2.0, кадр
 * methods-conclusion).
 *
 * Над листом — та же шапка пациента, что над протоколом, со строкой
 * открытого: пилюля черновика здесь «нажата». Слева — редактор: название,
 * сводка результата, вывод, сигналы этого прохождения, подпись; под ним —
 * что уйдёт в печатный отчёт. Справа — результаты человека по всем
 * методикам (для вывода), предложения правил, аналитические модели и
 * история версий.
 *
 * /responses/:id/conclusion/draft — тот же экран: инструменты черновика
 * («Зібрати з результатів», шаблоны, формулировки, «Зберегти чернетку»)
 * теперь стоят на самом листе, а не прячутся за отдельным адресом.
 */
export default function ConclusionPage() {
  const { ut } = useLang();
  const { can } = useAuth();
  const { id } = useParams<{ id: string }>();
  const responseId = id!;
  /*
   * keep: false (#177, #200): прохождение и заключение прежнего адреса под
   * новым — чужой документ, а не устаревающий.
   */
  const res = useResource(
    async () => {
      const detail = await api.responseDetail(responseId);
      return { detail };
    },
    [responseId],
    { keep: false },
  );
  const conclusion = useResource(() => api.conclusion(responseId), [responseId], { manual: true, keep: false });

  /*
   * Название набирается на экране. Столбца title у заключения на сервере
   * пока нет: сохранение его передаёт, сегодняшний сервер отбрасывает, и
   * экран держит набранное у себя, не затирая пустотой из ответа. Набранное к
   * прежнему прохождению к новому не переходит.
   */
  const [title, setTitle] = useState("");
  useEffect(() => setTitle(""), [responseId]);
  useEffect(() => {
    const t = conclusion.data?.current?.title;
    if (typeof t === "string") setTitle(t);
  }, [conclusion.data]);

  /* в поле — черновик, если он есть; после подписи поле пустеет под новую версию */
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const current = conclusion.data?.current;
    setText(current?.status === "draft" ? current.text : "");
  }, [conclusion.data]);

  const detail = res.data && res.data.detail.id === responseId ? res.data.detail : null;
  const x = useResponseExtras(detail, { dynamics: true, conclusion: false });
  const surveyId = detail?.survey.id;
  /* правила поддержки решений — «моделі аналітики»; вердикт — по срабатываниям этого прохождения */
  const models = useResource(() => api.decisionRules(), [responseId, surveyId], {
    enabled: !!surveyId,
    keep: false,
  });
  const all = useResource(
    () => api.dynamics(detail!.userId!).then((d): { d: RespondentDynamics | null } => ({ d }), () => ({ d: null })),
    [detail?.userId],
    { enabled: !!detail?.userId && x.wantsDynamics, keep: false },
  );
  const historyRef = useRef<HTMLElement | null>(null);

  if (!detail) return <Loading rows={8} error={res.error} onRetry={res.reload} />;
  const ctx = x.ctx.data;
  const lock = signLock(ctx, detail, ut);
  const main = mainScore(detail.scores);

  return (
    <ResponseFrame banner={<ResponseBanner detail={detail} ctx={ctx} conclusion={conclusion.data} place="conclusion" />}>
      <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_360px] max-[1360px]:grid-cols-[minmax(0,1fr)_320px] max-[1100px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          {detail.status !== "completed" ? (
            /* заключение пишется только по завершённому: сервер ответит 409 — экран говорит это сразу */
            <Callout kind="warn" title={ut(`rstatus.${detail.status}`, detail.status)}>
              {ut("rp.concl.afterSubmit")}
            </Callout>
          ) : null}
          <ConclusionEditor
            responseId={responseId}
            state={conclusion.data}
            error={conclusion.error}
            onState={conclusion.patch}
            onReload={conclusion.reload}
            title={title}
            setTitle={setTitle}
            text={text}
            setText={setText}
            areaRef={areaRef}
            heading={ut("cnx.heading").replace("{survey}", detail.survey.title).replace("{at}", detail.submittedAt ? dateTime(detail.submittedAt) : "—")}
            summary={main ? <Summary detail={detail} dynamics={x.dynamics} /> : null}
            signals={<SignalsSection ctx={ctx} detail={detail} />}
            lock={lock}
            canWrite={can("conclusions.write")}
            canSign={can("conclusions.sign")}
            onHistory={() => {
              historyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
              historyRef.current?.focus();
            }}
          />
          <ReportPanel responseId={responseId} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ResultsSide detail={detail} dyn={all.data?.d ?? null} loading={all.loading} enabled={x.wantsDynamics} />
          {ctx?.hits ? <RulesPanel hits={ctx.hits} reload={x.ctx.reload} title={ut("ds.title")} hint={ut("ds.sub")} /> : null}
          <ModelsPanel rules={models.data} error={models.error} hits={ctx?.hits ?? []} responseId={responseId} surveyId={detail.survey.id} />
          <HistoryPanel state={conclusion.data} anchor={historyRef} />
        </div>
      </div>
    </ResponseFrame>
  );
}

/* ─────────── подпись после разбора сигнала ─────────── */

function signLock(ctx: ResponseContext | null, detail: ResponseDetail, ut: ReturnType<typeof useLang>["ut"]): SignLock | null {
  const open = signalStrip(ctx?.signals ?? null).openHere;
  if (!open.length) return null;
  const oldest = [...open].sort((a, b) => b.minutesOpen - a.minutesOpen)[0]!;
  const timer = signalTimer(oldest, ut("rp.hours"));
  return {
    title: ut("cnx.lockTitle"),
    body: (
      <>
        {open.map((s) => s.label).join("; ")}.{" "}
        {timer
          ? ut("cnx.lockTimer").replace("{t}", ut("kit.timerOf").replace("{elapsed}", timer.elapsed).replace("{of}", timer.of))
          : ut("cnx.lockSince").replace("{t}", timeOfDay(oldest.at))}
        . {ut("cnx.lockDraftOk")}
      </>
    ),
    action: (
      <ButtonLink to={reviewHref(ctx?.patient?.id ?? detail.userId)} variant="risk" size="xs">
        <Ic.alert />
        {ut("rp.reviewSignal")}
      </ButtonLink>
    ),
  };
}

/* ─────────── сводка результата над выводом ─────────── */

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

function Summary({ detail, dynamics }: { detail: ResponseDetail; dynamics: RespondentDynamics | null }) {
  const { ut } = useLang();
  const dec = useDecimal();
  const main = mainScore(detail.scores)!;
  const rungs = main.bands.map((b) => ({ min: b.minScore, max: b.maxScore, label: b.label, severity: b.severity }));
  const change = scaleChange(detail, dynamics, main.scaleCode, rungs);
  const line = change?.fromStart ?? change?.fromPrev ?? null;
  const shift = (l: ShiftLine) => `${l.delta > 0 ? "+" : l.delta < 0 ? "−" : "±"}${dec(Math.abs(l.delta))}`;
  return (
    <div className="flex items-center gap-4 rounded-[12px] bg-panel-2 px-4 py-3">
      <span className="text-stat font-extrabold leading-none tracking-[-0.03em] text-text tabular-nums">{dec(main.value)}</span>
      <span className="min-w-0 text-small text-text-2">
        <span className="flex flex-wrap items-center gap-2">
          <b className="font-extrabold text-text">{main.scaleTitle}</b>
          {main.band ? (
            <SeverityTag level={main.band.severity} small>
              {main.band.label}
            </SeverityTag>
          ) : null}
        </span>
        {line ? (
          <span className="mt-1 block">
            <b className="font-extrabold text-text">{shift(line)}</b>{" "}
            {(change?.fromStart ? ut("cnx.fromStart") : ut("rp.since")).replace("{d}", day(line.at))}, {ut(VERDICT_KEY[line.verdict])}
            {change?.rc != null ? `; ${ut("rp.rcLine").replace("{n}", dec(change.rc))}` : ""}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/* ─────────── сигналы этого прохождения ─────────── */

const OUTCOME_KEY = {
  confirmed: "rp.outcome.confirmed",
  not_confirmed: "rp.outcome.not_confirmed",
  needs_followup: "rp.outcome.needs_followup",
} as const;

function SignalsSection({ ctx, detail }: { ctx: ResponseContext | null; detail: ResponseDetail }) {
  const { ut } = useLang();
  const here = (ctx?.signals ?? []).filter((s) => s.here);
  if (!here.length) return null;
  return (
    <section className="border-t border-divider pt-4" aria-labelledby="cn-signals">
      <h3 id="cn-signals" className="m-0 flex items-baseline gap-2 text-h3 font-extrabold text-text">
        {ut("cnx.signalsTitle")}
        <span className="text-small font-medium text-muted">{ut("cnx.signalsSub")}</span>
      </h3>
      <ul className="m-0 mt-2.5 flex list-none flex-col gap-2 p-0">
        {here.map((s) => (
          <li
            key={s.id}
            className={cx(
              "flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[12px] px-3.5 py-2.5 text-small",
              s.reviewedAt ? "bg-sunk text-text-2" : "shadow-[inset_0_0_0_1.5px_var(--ctl)] text-text-2",
            )}
          >
            {s.reviewedAt ? <Ic.circleCheck size={15} className="text-good" /> : <Ic.lock size={15} className="text-risk-ink" />}
            <span className={cx("min-w-0 flex-1", !s.reviewedAt && "font-bold text-text")}>{s.label}</span>
            {s.reviewedAt ? (
              <span>
                {ut("rp.reviewedBy").replace("{name}", s.reviewedByName ?? "—")}, {dateTime(s.reviewedAt)}
                {s.outcome ? `: ${ut(OUTCOME_KEY[s.outcome])}` : ""}
              </span>
            ) : (
              <ButtonLink to={reviewHref(ctx?.patient?.id ?? detail.userId)} variant="ghost" size="xs">
                {ut("rp.review")}
              </ButtonLink>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ─────────── печатный отчёт ─────────── */

function ReportPanel({ responseId }: { responseId: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  return (
    <Panel
      title={ut("cnx.report")}
      icon={<Rx.printer />}
      sub={ut("cnx.reportSub")}
      actions={
        <Button size="xs" icon={<Ic.eye />} disabled={busy} onClick={() => void run(() => openInTab(api.reportUrl(responseId)))}>
          {ut("cnx.preview")}
        </Button>
      }
    >
      <p className="m-0 text-small text-text-2">{ut("cnc.onlySignedInReport")}</p>
      <Callout kind="info" icon={<Ic.message />} className="mt-3">
        {ut("cn3.mailUnavailable")}
      </Callout>
    </Panel>
  );
}

/* ─────────── результаты человека по всем методикам ─────────── */

interface ResultLine {
  key: string;
  code: string;
  survey: string;
  at: string;
  value: number;
  band: { label: string; severity: "none" | "mild" | "moderate" | "severe" } | null;
  delta: number | null;
  here: boolean;
  responseId: string;
  surveyId: string;
}

/** Последний замер каждой методики человека — главная шкала: первая с полосой, иначе первая */
export function resultLines(dyn: RespondentDynamics, responseId: string): ResultLine[] {
  const out: ResultLine[] = [];
  for (const sv of dyn.surveys) {
    const scales = sv.scales.filter((s) => s.points.length);
    const scale = scales.find((s) => s.points.some((p) => p.severity !== null)) ?? scales[0];
    if (!scale) continue;
    const pts = [...scale.points].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    const here = pts.find((p) => p.responseId === responseId);
    const last = here ?? pts[pts.length - 1]!;
    const first = pts[0]!;
    out.push({
      key: `${sv.surveyId}-${scale.code}`,
      code: scale.code,
      survey: sv.title,
      at: last.submittedAt,
      value: last.rawScore,
      band: last.bandLabel && last.severity ? { label: last.bandLabel, severity: last.severity } : null,
      delta: pts.length > 1 && last !== first ? Math.round((last.rawScore - first.rawScore) * 100) / 100 : null,
      here: !!here,
      responseId: last.responseId,
      surveyId: sv.surveyId,
    });
  }
  return out.sort((a, b) => Number(b.here) - Number(a.here) || b.at.localeCompare(a.at));
}

function ResultsSide({
  detail,
  dyn,
  loading,
  enabled,
}: {
  detail: ResponseDetail;
  dyn: RespondentDynamics | null;
  loading: boolean;
  enabled: boolean;
}) {
  const { ut } = useLang();
  const dec = useDecimal();
  const lines = dyn ? resultLines(dyn, detail.id) : [];
  return (
    <Panel title={ut("cnx.results")} icon={<Ic.clipboard />}>
      {!enabled ? (
        <p className="m-0 text-small text-muted">{ut("cnx.resultsNone")}</p>
      ) : loading ? (
        <Loading rows={3} bare />
      ) : lines.length ? (
        <ul className="m-0 list-none p-0">
          {lines.map((l) => (
            <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 border-t border-divider py-2.5 first:border-t-0 first:pt-0.5">
              <span className="min-w-0 text-small">
                {l.here ? (
                  <b className="block truncate font-bold text-text">{l.survey}</b>
                ) : (
                  <Link
                    to={`/surveys/${l.surveyId}/responses/${l.responseId}`}
                    className="block truncate font-bold text-text no-underline hover:underline hover:decoration-violet-line"
                  >
                    {l.survey}
                  </Link>
                )}
                <span className="block text-caption text-muted">
                  {l.here ? ut("cnx.thisAttempt").replace("{d}", day(l.at)) : day(l.at)}
                  {l.delta !== null ? `, ${ut("cnx.fromStartDelta").replace("{v}", `${l.delta > 0 ? "+" : l.delta < 0 ? "−" : "±"}${dec(Math.abs(l.delta))}`)}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <b className="text-h3 font-extrabold tabular-nums text-text">{dec(l.value)}</b>
                {l.band ? (
                  <SeverityTag level={l.band.severity} small>
                    {l.band.label}
                  </SeverityTag>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-small text-muted">{ut("cnx.resultsNone")}</p>
      )}
      <ButtonLink to="/batteries" size="xs" className="mt-3 w-full">
        <Ic.layers />
        {ut("cn3.addTest")}
      </ButtonLink>
    </Panel>
  );
}

/* ─────────── аналитические модели ─────────── */

export interface AppliedModel {
  id: string;
  title: string;
  description: string;
  matched: boolean;
}

/**
 * Модели, применимые к этой методике, и сработала ли каждая на ЭТОМ
 * прохождении.
 *
 * Модель — правило поддержки решений (DecisionRule). Применима, если включена
 * и её условия по шкалам не привязаны к другой методике: условия по риску и
 * без методики применимы к любой. Вердикт — по срабатыванию этого
 * прохождения, а не любого: на соседнем прохождении того же человека модель
 * могла сработать, и «відповідає» тогда было бы неправдой о документе.
 */
export function applicableModels(
  rules: (DecisionRule & { note: string | null })[],
  hits: RuleHit[],
  responseId: string,
  surveyId: string,
): AppliedModel[] {
  const mine = hits.filter((h) => h.responseId === responseId);
  const hitByTitle = new Map(mine.map((h) => [h.ruleTitle, h]));
  return rules
    .filter((r) => r.enabled)
    .filter((r) => r.conditions.every((c) => c.kind !== "scale" || !c.surveyId || c.surveyId === surveyId))
    .map((r) => {
      const hit = hitByTitle.get(r.title);
      return {
        id: r.id,
        title: r.title,
        description: r.note ?? hit?.explanation.because.map((b) => b.text).join("; ") ?? "",
        matched: hit !== undefined,
      };
    });
}

function ModelsPanel({
  rules,
  error,
  hits,
  responseId,
  surveyId,
}: {
  rules: (DecisionRule & { note: string | null })[] | null;
  error: string | null;
  hits: RuleHit[];
  responseId: string;
  surveyId: string;
}) {
  const { ut } = useLang();
  const models = rules ? applicableModels(rules, hits, responseId, surveyId) : null;
  return (
    <Panel
      title={ut("cnx.models")}
      icon={<Ic.chart />}
      sub={models ? ut("cnx.modelsCount").replace("{n}", String(models.length)) : undefined}
      actions={
        /* завести модель — экран аналитики (/analytics/new) */
        <ButtonLink to="/analytics/new" variant="ghost" size="icon-sm" aria-label={ut("cnx.newModel")} title={ut("cnx.newModel")}>
          <Ic.plus />
        </ButtonLink>
      }
    >
      {/*
        Отказ — словами, а не пустотой: у специалиста без права alerts.review
        список правил закрыт, и «моделей нет» было бы неправдой.
      */}
      {error ? (
        <p className="m-0 text-small text-muted">
          {ut("cn3.modelsUnavailable")}: {error}
        </p>
      ) : models === null ? (
        <Loading rows={2} bare />
      ) : models.length === 0 ? (
        <p className="m-0 text-small text-muted">{ut("cn3.modelsNone")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {models.map((m) => (
            <li
              key={m.id}
              data-verdict={m.matched ? "matched" : "not-matched"}
              className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-2 border-t border-divider py-2 text-small first:border-t-0 first:pt-0.5"
            >
              {m.matched ? <Ic.circleCheck size={15} className="mt-0.5 text-good" /> : <Rx.circleMinus size={15} className="mt-0.5 text-muted" />}
              <Popover title={m.title} content={m.description ? <p className="m-0">{m.description}</p> : undefined}>
                <span className="min-w-0 cursor-default text-text-2">{m.title}</span>
              </Popover>
              <span className={cx("whitespace-nowrap", m.matched ? "font-bold text-good" : "text-muted")}>
                {m.matched ? ut("cnx.matched") : ut("cnx.notMatched")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ─────────── история версий ─────────── */

function HistoryPanel({ state, anchor }: { state: ConclusionState | null; anchor: React.RefObject<HTMLElement | null> }) {
  const { ut } = useLang();
  const versions = state?.versions ?? [];
  return (
    <section ref={anchor} tabIndex={-1} className="outline-none" aria-label={ut("cnc.showHistory")}>
      <Panel
        title={ut("cnc.showHistory")}
        icon={<Ic.history />}
        sub={versions.some((v) => v.status === "signed") ? undefined : ut("cnx.noSigned")}
        flush
      >
        {versions.length ? (
          <ActivityList
            events={versions.map((v) => ({
              date: day(v.status === "signed" && v.signedAt ? v.signedAt : v.createdAt),
              time: timeOfDay(v.status === "signed" && v.signedAt ? v.signedAt : v.createdAt),
              icon: v.status === "signed" ? <Rx.signature /> : <Rx.filePen />,
              tone: v.status === "signed" ? "good" : "neutral",
              text: (
                <Popover title={versionTitle(v, ut)} content={<p className="m-0 whitespace-pre-wrap">{v.text}</p>} width={380}>
                  <span className="cursor-default">
                    <b>{versionTitle(v, ut)}</b> <span className="text-muted">{v.authorName}</span>
                  </span>
                </Popover>
              ),
            }))}
          />
        ) : (
          <p className="m-0 px-4 pb-4 text-small text-muted">{ut("cnx.historyNone")}</p>
        )}
      </Panel>
    </section>
  );
}

function versionTitle(v: { status: "draft" | "signed"; version: number }, ut: ReturnType<typeof useLang>["ut"]): string {
  return (v.status === "signed" ? ut("cnx.signedV") : ut("cnx.draftV")).replace("{n}", String(v.version));
}
