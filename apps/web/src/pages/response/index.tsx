import { useState, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { ResponseContext, ResponseDetail, SurveyFull } from "@quizzy/shared";
import { api, type ConclusionState } from "../../api";
import { useAuth } from "../../auth";
import { betterOf } from "../../charts/courseModel";
import { useDecimal } from "../../charts/kit";
import { dateTime, day, duration } from "../../format";
import { useLang } from "../../lang";
import { Panel } from "../../ui/layout";
import { Ic, KV, Loading, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { Button, ButtonLink, Segmented, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import {
  attemptNav,
  firstChange,
  mainScore,
  prevAnswers,
  reviewHref,
  signLockedBySignal,
} from "./context";
import { useResponseExtras } from "./data";
import { ResponseBanner, ResponseFrame } from "./frame";
import { Rx } from "./icons";
import { answerGrid, answerList, type AnswerGrid, type QuestionView } from "./model";
import { AnsweringPanel, ResultPanel, RulesPanel } from "./panels";
import { ResponseTabs } from "./tabs";

/*
 * Пройденный тест — протокол (Polypsy 2.0, кадр methods-response).
 *
 * Над протоколом — шапка пациента со строкой открытого и переключатель
 * попыток той же методики. Слева — ответы (сеткой, как бланк, или списком) и
 * результат на шкале тяжести с лестницей полос; справа — сведения о
 * прохождении, как отвечал, заключение и что предложили правила.
 *
 * Адрес лежит под методикой — /surveys/:id/responses/:rid, — а данные
 * грузятся по идентификатору прохождения: оно само знает свою методику, и
 * если в адресе чужая, экран уходит на правильный адрес, а не показывает
 * одну методику над ответами другой.
 *
 * Экран персонала. Пациент к нему не попадает по построению — маршрут лежит
 * в ветке консоли, у кабинета своя оболочка, — и потому веса вариантов здесь
 * показывать можно.
 */
export default function ResponseView() {
  const { id: surveyId, rid } = useParams<{ id: string; rid: string }>();

  /*
   * keep: false (#200): протокол прежнего прохождения под адресом нового —
   * чужие ответы, а не устаревающие; пока едет новый — загрузка.
   */
  const res = useResource(() => api.responseDetail(rid!), [rid], { enabled: !!rid, keep: false });
  const detail = res.data && res.data.id === rid ? res.data : null;
  const x = useResponseExtras(rid ?? null, detail, { prev: true, dynamics: true });

  if (!detail) return <Loading rows={8} error={res.error} onRetry={res.reload} />;
  if (surveyId && detail.survey.id !== surveyId) {
    return <Navigate to={`/surveys/${detail.survey.id}/responses/${detail.id}`} replace />;
  }

  const ctx = x.ctx.data;
  const main = mainScore(detail.scores);
  const nav = ctx && detail.userId ? attemptNav(ctx.attempts, detail.id, main?.scaleCode ?? null) : null;
  const chartsHref = `/surveys/${detail.survey.id}/responses/${detail.id}/charts`;

  return (
    <ResponseFrame banner={<ResponseBanner detail={detail} ctx={ctx} conclusion={x.conclusion.data} place="protocol" pending={!x.ctx.data && !x.ctx.error} />}>
      <ResponseTabs surveyId={detail.survey.id} responseId={detail.id} nav={nav} charts={false} scale={main?.scaleTitle ?? null} />
      <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_360px] max-[1360px]:grid-cols-[minmax(0,1fr)_320px] max-[1100px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          {/* протокол открывают ради результата: он первым, ответы — под ним */}
          <ResultPanel detail={detail} dynamics={x.dynamics} ctx={ctx} variant="protocol" chartsHref={chartsHref} />
          <AnswersPanel detail={detail} survey={x.survey} ctx={ctx} prev={x.prev} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <AttemptPanel detail={detail} ctx={ctx} />
          <AnsweringPanel detail={detail} survey={x.survey} surveyLoading={x.surveyLoading} variant="protocol" chartsHref={chartsHref} />
          <ConclusionSide detail={detail} state={x.conclusion.data} error={x.conclusion.error} ctx={ctx} />
          {ctx?.hits ? <RulesPanel hits={ctx.hits} reload={x.ctx.reload} /> : null}
        </div>
      </div>
    </ResponseFrame>
  );
}

/* ─────────── ответы ─────────── */

type AnswersMode = "grid" | "list";

/**
 * «Відповіді»: сеткой — пункты строками, варианты столбцами, выбранный
 * залит, прежний ответ кольцом — или списком, как бланк. Сетка — только
 * когда у пунктов общий набор вариантов (answerGrid); иначе список.
 */
export function AnswersPanel({
  detail,
  survey,
  ctx,
  prev,
}: {
  detail: ResponseDetail;
  survey: SurveyFull | null;
  ctx: ResponseContext | null;
  prev: ResponseDetail | null;
}) {
  const { ut } = useLang();
  const grid = answerGrid(detail, survey, prevAnswers(prev));
  const [mode, setMode] = useState<AnswersMode>("grid");
  const shown: AnswersMode = grid ? mode : "list";
  return (
    <Panel
      title={ut("rch.tabAnswers")}
      icon={<Rx.listOrdered />}
      flush
      actions={
        grid ? (
          <Segmented<AnswersMode>
            label={ut("rp.answersView")}
            value={shown}
            onChange={setMode}
            items={[
              { key: "grid", label: ut("rp.viewGrid") },
              { key: "list", label: ut("rp.viewList") },
            ]}
          />
        ) : null
      }
    >
      {shown === "grid" && grid ? (
        <Grid detail={detail} grid={grid} survey={survey} ctx={ctx} prev={prev} />
      ) : (
        <List items={answerList(detail)} />
      )}
    </Panel>
  );
}

const COLS = (n: number, scored: boolean, withDelta: boolean) =>
  `22px minmax(0,1fr) repeat(${n}, var(--oc))${scored ? " 32px" : ""}${withDelta ? " 44px" : ""}`;

function Grid({
  detail,
  grid,
  survey,
  ctx,
  prev,
}: {
  detail: ResponseDetail;
  grid: AnswerGrid;
  survey: SurveyFull | null;
  ctx: ResponseContext | null;
  prev: ResponseDetail | null;
}) {
  const { ut } = useLang();
  const dec = useDecimal();
  const withPrev = !!prev && grid.rows.some((r) => r.prev !== null);
  /* балл и сдвиг по пункту — только на порядковой шкале; у ключа «так / ні» вес вариантов нулевой */
  const scored = grid.scored;
  const withDelta = withPrev && scored;
  const cols = COLS(grid.columns.length, scored, withDelta);
  const main = mainScore(detail.scores);
  const better = main ? betterOf(main.bands.map((b) => ({ min: b.minScore, max: b.maxScore, label: b.label, severity: b.severity }))) : null;
  const prevDay = prev?.submittedAt ? day(prev.submittedAt) : null;
  const stem = survey?.instructions?.trim() && survey.instructions.trim().length <= 90 ? survey.instructions.trim() : null;
  const openHere = new Map(
    (ctx?.signals ?? []).filter((s) => s.here && s.reviewedAt === null && s.questionId).map((s) => [s.questionId!, s] as const),
  );
  const review = reviewHref(ctx?.patient?.id ?? detail.userId);
  const ordered = [...detail.answers].sort((a, b) => a.position - b.position);
  const answerOf = new Map(ordered.map((a) => [a.questionId, a] as const));
  const prevMain = prev && main ? prev.scores.find((s) => s.scaleCode === main.scaleCode) : null;
  const clinical = detail.scores.filter((s) => s.kind === "clinical");
  const inScale = grid.rows.filter((r) => r.inScale).length;
  const ring = (
    <>
      <span aria-hidden className="size-4 rounded-full shadow-[inset_0_0_0_1.5px_var(--muted)]" />
      {ut("rp.answerOn").replace("{d}", prevDay ?? "")}
    </>
  );

  const deltaCell = (delta: number | null, critical: boolean) => {
    if (delta === null) return <span className="text-right text-small font-bold text-muted">—</span>;
    const improved = better === null || delta === 0 ? null : better === "down" ? delta < 0 : delta > 0;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
    return (
      <span
        className={cx(
          "text-right text-small font-bold tabular-nums",
          improved === true ? "text-good" : improved === false && critical ? "text-risk-ink" : "text-muted",
        )}
      >
        {sign}
        {dec(Math.abs(delta))}
      </span>
    );
  };

  return (
    <div className="[--oc:58px] max-[1360px]:[--oc:48px]" role="table" aria-label={ut("rch.tabAnswers")}>
      <div
        role="row"
        className="grid items-end gap-x-2 border-t border-divider bg-panel-2 px-4 py-2.5 text-[11.5px] font-bold leading-[14px] text-muted"
        style={{ gridTemplateColumns: cols }}
      >
        <span role="columnheader">№</span>
        <span role="columnheader" className="min-w-0">
          {stem ?? ut("rp.item")}
        </span>
        {grid.columns.map((c, k) => (
          <span role="columnheader" key={k} className="hyphens-auto text-center text-[11px] leading-[13px] [overflow-wrap:anywhere]">
            {scored && c.score !== null ? <b className="block font-extrabold text-text-2">{dec(c.score)}</b> : null}
            {c.text}
          </span>
        ))}
        {scored ? (
          <span role="columnheader" className="text-right">
            {ut("rp.score")}
          </span>
        ) : null}
        {withDelta ? (
          <span role="columnheader" className="text-right">
            {ut("rp.fromDate").replace("{d}", prevDay ?? "")}
          </span>
        ) : null}
      </div>
      {grid.rows.map((r) => {
        const a = answerOf.get(r.questionId)!;
        const fc = r.critical ? firstChange(a) : null;
        const signal = openHere.get(r.questionId);
        const textOf = (id: string) => a.options.find((o) => o.id === id)?.text ?? "—";
        const delta = withDelta && r.score !== null && r.prevScore !== null ? r.score - r.prevScore : null;
        return (
          <div
            role="row"
            key={r.questionId}
            className={cx(
              "grid items-center gap-x-2 border-t border-divider px-4 py-2 text-[13px] leading-[18px]",
              r.critical && "bg-risk-tint",
            )}
            style={{ gridTemplateColumns: cols }}
          >
            <span role="cell" className={cx("font-extrabold", r.critical ? "text-risk-ink" : "text-muted")}>
              {r.number}
            </span>
            <div role="cell" className="min-w-0">
              <span className={cx(r.critical ? "font-extrabold text-risk-ink" : "text-text")}>{r.title}</span>
              {!r.inScale ? <span className="ml-1.5 text-caption text-muted">{ut("rp.notInSum")}</span> : null}
              {r.chosen !== null ? (
                <span className="sr-only">
                  {" "}
                  — {ut("rsp.chosen")}: {grid.columns[r.chosen]!.text}
                  {r.prev !== null ? `; ${ut("rp.before").replace("{d}", prevDay ?? "")}: ${grid.columns[r.prev]!.text}` : ""}
                </span>
              ) : (
                <span className="sr-only"> — {ut("cases.skipped")}</span>
              )}
              {r.critical ? (
                <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-text-2">
                  <span className="inline-flex items-center gap-1 font-bold text-risk-ink">
                    <Rx.siren size={12} />
                    {ut("cases.criticalOption")}
                  </span>
                  {fc ? (
                    <span>
                      {ut("rp.firstThen")
                        .replace("{from}", textOf(fc.firstOptionId))
                        .replace("{s}", dec(fc.afterMs / 1000, 0))}
                    </span>
                  ) : null}
                  {signal ? (
                    <Tooltip label={ut("rp.reviewHint")} kbd="R">
                      <Link
                        to={review}
                        className="rounded-[6px] px-1.5 py-0.5 font-extrabold text-risk-ink no-underline hover:bg-risk-tint-2 hover:no-underline"
                      >
                        {ut("rp.signal")}
                      </Link>
                    </Tooltip>
                  ) : null}
                </span>
              ) : null}
            </div>
            {grid.columns.map((_, k) => (
              <span role="cell" key={k} className="grid place-items-center" aria-hidden>
                {r.chosen === k ? (
                  <span
                    className={cx(
                      "grid size-[26px] place-items-center rounded-full text-[12px] font-extrabold text-onfill",
                      r.critical ? "bg-risk" : "bg-violet",
                    )}
                  >
                    {scored && r.score !== null ? dec(r.score) : <Ic.check size={13} />}
                  </span>
                ) : r.prev === k ? (
                  <span className="size-[22px] rounded-full shadow-[inset_0_0_0_1.5px_var(--muted)]" />
                ) : (
                  <span className="size-2 rounded-full bg-track" />
                )}
              </span>
            ))}
            {scored ? (
              <span role="cell" className={cx("text-right font-extrabold tabular-nums", r.critical && "text-risk-ink")}>
                {r.score !== null ? dec(r.score) : "—"}
              </span>
            ) : null}
            {withDelta ? <span role="cell">{deltaCell(delta, r.critical)}</span> : null}
          </div>
        );
      })}
      {scored && clinical.length === 1 && main ? (
        <div
          role="row"
          className="grid items-center gap-x-2 border-t border-control px-4 py-2.5 text-[13px] font-extrabold"
          style={{ gridTemplateColumns: cols }}
        >
          <span role="cell" />
          <span role="cell">{ut("rp.sumOf").replace("{n}", String(inScale))}</span>
          <span
            role="cell"
            className="flex items-center justify-center gap-1.5 text-caption font-semibold text-muted"
            style={{ gridColumn: `3 / span ${grid.columns.length}` }}
          >
            {withPrev ? ring : null}
          </span>
          <span role="cell" className="text-right tabular-nums">
            {dec(main.rawScore)}
          </span>
          {withDelta ? (
            <span role="cell">{deltaCell(prevMain ? main.rawScore - prevMain.rawScore : null, false)}</span>
          ) : null}
        </div>
      ) : withPrev ? (
        <div className="flex items-center gap-1.5 border-t border-divider px-4 py-2.5 text-caption font-semibold text-muted">{ring}</div>
      ) : null}
      {grid.extra.map((e) => (
        <div
          role="row"
          key={e.questionId}
          className={cx(
            "grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-x-2 border-t border-divider px-4 py-2.5 text-[13px] leading-[18px]",
            e.critical && "bg-risk-tint",
          )}
        >
          <span role="cell" className={cx("font-extrabold", e.critical ? "text-risk-ink" : "text-muted")}>
            {e.number}
          </span>
          <span role="cell" className="min-w-0 text-text-2">
            {e.title}
            {!e.inScale ? <span className="ml-1.5 text-caption text-muted">{ut("rp.notInSum")}</span> : null}
          </span>
          <span role="cell" className="max-w-[240px] text-right font-extrabold text-text">
            {e.answered ? (e.answer ?? "—") : <span className="font-semibold text-muted">{ut("cases.skipped")}</span>}
            {scored && e.score !== null && e.inScale ? (
              <span className="ml-1.5 font-semibold text-muted tabular-nums">{dec(e.score)}</span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Протокол списком: пункт и варианты столбиком, выбранный залит и назван словом */
function List({ items }: { items: QuestionView[] }) {
  const { ut } = useLang();
  const dec = useDecimal();
  return (
    <ol className="m-0 list-none p-0">
      {items.map((q) => (
        <li key={q.questionId} className="border-t border-divider px-4 py-3">
          <h3 className="m-0 flex gap-2 text-body font-bold text-text">
            <span className="w-[22px] shrink-0 font-extrabold text-muted">{q.number}</span>
            <span className="min-w-0">{q.title}</span>
          </h3>
          {q.options.length ? (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 pl-[30px]">
              {q.options.map((o) => (
                <li
                  key={o.id}
                  className={cx(
                    "flex min-h-8 items-center gap-3 rounded-[9px] px-2.5 py-1 text-small",
                    o.chosen
                      ? o.riskFlag
                        ? "bg-risk-tint font-extrabold text-risk-ink"
                        : "bg-violet-tint font-extrabold text-violet-ink"
                      : "text-text-2",
                  )}
                >
                  {o.chosen ? <Ic.check size={14} /> : <span aria-hidden className="size-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    {o.text}
                    {o.chosen ? <span className="sr-only"> — {ut("rsp.chosen")}</span> : null}
                    {o.riskFlag && o.chosen ? <span className="ml-2 font-bold">{ut("cases.criticalOption")}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    <span className="sr-only">{ut("cq.score")}: </span>
                    {o.score === null ? "—" : dec(o.score)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 mt-1.5 pl-[30px] text-small font-bold text-text">
              {q.answered && q.free !== null ? q.free : <span className="font-semibold text-muted">{ut("cases.skipped")}</span>}
            </p>
          )}
          {q.options.length > 0 && !q.answered ? (
            <p className="m-0 mt-1.5 pl-[30px] text-caption text-muted">{ut("cases.skipped")}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/* ─────────── сведения о прохождении ─────────── */

const SOURCE_KEY = {
  assigned: "rp.src.assigned",
  self: "rp.src.self",
  kiosk: "rp.src.kiosk",
  clinician: "rp.src.clinician",
  informant: "rp.src.informant",
  intake: "rp.src.intake",
} as const;

/**
 * «Проходження»: факты о самом заполнении — методика, когда, откуда, сколько
 * длилось, критические пункты, достоверность, кто ведёт.
 *
 * Сдвиг от прежнего замера и от старта здесь больше не повторяется: его
 * показывает «Результат», который теперь стоит первым. У методики с
 * несколькими шкалами строка «Від 8 жовт. +1,7» к тому же не называла
 * шкалу, о которой говорит.
 */
function AttemptPanel({ detail, ctx }: { detail: ResponseDetail; ctx: ResponseContext | null }) {
  const { ut } = useLang();
  const ordered = [...detail.answers].sort((a, b) => a.position - b.position);
  const critical = ordered
    .map((a, i) => ({ n: i + 1, hit: a.options.some((o) => o.riskFlag && (a.optionIds ?? []).includes(o.id)) }))
    .filter((c) => c.hit)
    .map((c) => ut("rch.itemN").replace("{n}", String(c.n)));
  const rows: [ReactNode, ReactNode][] = [
    /* экран — в разделе «Пацієнти»; к методике (описание, ключ, нормы) ведёт её название */
    [
      ut("rp.kv.method"),
      <>
        <Link to={`/surveys/${detail.survey.id}`} className="font-bold text-violet-ink">
          {detail.survey.title}
        </Link>
        , {ut("rp.versionN").replace("{n}", String(detail.survey.versionNumber))}
      </>,
    ],
    detail.submittedAt
      ? [ut("rp.kv.submitted"), <b className="font-extrabold">{dateTime(detail.submittedAt)}</b>]
      : [ut("rp.kv.started"), dateTime(detail.startedAt)],
  ];
  if (ctx?.source) rows.push([ut("rp.kv.source"), ut(SOURCE_KEY[ctx.source])]);
  if (detail.durationMs > 0) rows.push([ut("rp.kv.duration"), duration(detail.durationMs)]);
  if (critical.length) rows.push([ut("rp.kv.critical"), <b className="font-extrabold text-risk-ink">{critical.join(", ")}</b>]);
  if (ctx && !ctx.reliable) rows.push([ut("rp.kv.reliability"), <span className="font-bold text-warn">{ut("rp.unreliable")}</span>]);
  if (ctx?.patient?.lead) rows.push([ut("rp.kv.lead"), ctx.patient.lead.name]);
  const status =
    detail.status === "completed" ? (
      <Tag tone="good" icon={<Ic.check />}>
        {ut("rstatus.completed")}
      </Tag>
    ) : (
      <Tag tone={detail.status === "in_progress" ? "attention" : "plain"}>{ut(`rstatus.${detail.status}`, detail.status)}</Tag>
    );
  return (
    <Panel title={ut("rp.attempt")} icon={<Ic.clipboard />} actions={status}>
      <KV w={104} rows={rows} />
    </Panel>
  );
}

/* ─────────── заключение ─────────── */

function excerpt(text: string, n = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
}

function ConclusionSide({
  detail,
  state,
  error,
  ctx,
}: {
  detail: ResponseDetail;
  state: ConclusionState | null;
  error: string | null;
  ctx: ResponseContext | null;
}) {
  const { ut } = useLang();
  const { can } = useAuth();
  const href = `/responses/${detail.id}/conclusion`;
  const locked = signLockedBySignal(ctx?.signals ?? null);
  const head = (
    <span className="flex flex-wrap items-center gap-2">
      <b className="text-body font-extrabold text-text">
        {detail.survey.title}
        {detail.submittedAt ? `, ${day(detail.submittedAt)}` : ""}
      </b>
    </span>
  );
  let body: ReactNode;
  if (detail.status !== "completed") {
    body = <p className="m-0 text-small text-muted">{ut("rp.concl.afterSubmit")}</p>;
  } else if (!state) {
    body = error ? <p className="m-0 text-small text-muted">{ut("cn.loadFailed")}</p> : <Loading rows={2} bare />;
  } else if (!state.current) {
    body = (
      <>
        <p className="m-0 text-small text-text-2">{ut("rp.concl.none")}</p>
        {can("conclusions.write") ? (
          <div className="mt-3">
            <ButtonLink to={href} size="xs">
              <Rx.filePen />
              {ut("rsp.createConclusion")}
            </ButtonLink>
          </div>
        ) : null}
      </>
    );
  } else {
    const cur = state.current;
    const signed = cur.status === "signed";
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {head}
          {signed ? (
            <Tag tone="good" icon={<Ic.check />}>
              {ut("rp.concl.signed")}
            </Tag>
          ) : (
            <Tag icon={<Rx.filePen />}>{ut("rp.concl.draft")}</Tag>
          )}
          <span className="ml-auto text-caption text-muted">{ut("rp.versionN").replace("{n}", String(cur.version))}</span>
        </div>
        <p className="m-0 mt-2 text-small text-text-2">
          {signed
            ? ut("rp.concl.signedBy").replace("{name}", cur.authorName).replace("{at}", cur.signedAt ? dateTime(cur.signedAt) : "—")
            : ut("rp.concl.editedBy").replace("{name}", cur.authorName).replace("{at}", dateTime(cur.createdAt))}
          {cur.text.trim() ? <span className="text-text">: «{excerpt(cur.text)}»</span> : null}
        </p>
        {!signed && locked ? (
          <p className="m-0 mt-2 flex items-center gap-1.5 text-small text-text-2">
            <Ic.lock size={13} className="text-risk-ink" />
            {ut("rp.signLocked")}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <ButtonLink to={href} size="xs">
            {signed ? ut("rp.concl.open") : ut("rp.concl.continue")}
          </ButtonLink>
          {!signed && can("conclusions.sign") ? (
            locked ? (
              <Button size="xs" variant="ghost" disabled>
                <Rx.signature />
                {ut("rp.concl.sign")}
              </Button>
            ) : (
              <ButtonLink to={href} size="xs" variant="ghost">
                <Rx.signature />
                {ut("rp.concl.sign")}
              </ButtonLink>
            )
          ) : null}
        </div>
      </>
    );
  }
  return (
    <Panel title={ut("rp.conclusion")} icon={<Ic.file />}>
      {body}
    </Panel>
  );
}
