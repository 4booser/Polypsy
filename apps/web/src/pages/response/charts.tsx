import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { RespondentDynamics, ResponseAttempt, ResponseDetail, SurveyFull } from "@quizzy/shared";
import { api } from "../../api";
import { HeatTable } from "../../charts/clinical";
import { CourseChart } from "../../charts/course";
import { courseEventsFromTimeline, courseFromDynamics, type CourseEvent } from "../../charts/courseModel";
import { useDecimal } from "../../charts/kit";
import { sortRungs, type Rung } from "../../charts/ladder";
import { day } from "../../format";
import { useLang } from "../../lang";
import { Ic, Loading, Popover } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, Select } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { attemptNav, mainScore, prevAnswers } from "./context";
import { useResponseExtras } from "./data";
import { ResponseBanner, ResponseFrame } from "./frame";
import { Rx } from "./icons";
import { answerGrid, buildContributions, buildTrends, type ScaleContribution } from "./model";
import { AnsweringPanel, ResultPanel } from "./panels";
import { ResponseTabs } from "./tabs";

/*
 * Графики одного прохождения — вкладка «Графіки» рядом с протоколом
 * (Polypsy 2.0, кадр methods-response-charts).
 *
 *   Результат        → число, ступень, сдвиг с порогом надёжной зміни, шкала
 *                      тяжести, сведения о шкале и смысл результата словами;
 *   Динаміка         → график курса (CourseChart набора) по всем сданным
 *                      попыткам этой методики этим человеком, с сессиями,
 *                      неявками и сигналами из хронологии;
 *   Форма симптомів  → ответы по пунктам за последние попытки той же версии
 *                      тепловой таблицей;
 *   Внесок пунктів   → что дал каждый пункт и что он мог дать, отметка «було»;
 *   Як відповідав    → время по пунктам с порогом «слишком быстро», смены.
 *
 * Каждый раздел — только когда ему есть что показать, и каждый ждёт своё:
 * методику той версии (ключ, порог), динамику, хронологию.
 */
export default function ResponseCharts() {
  const { ut } = useLang();
  const { id: surveyId, rid } = useParams<{ id: string; rid: string }>();
  const res = useResource(() => api.responseDetail(rid!), [rid], { enabled: !!rid, keep: false });
  const detail = res.data && res.data.id === rid ? res.data : null;
  const x = useResponseExtras(detail, { prev: true, dynamics: true });

  if (!detail) return <Loading rows={8} error={res.error} onRetry={res.reload} />;
  if (surveyId && detail.survey.id !== surveyId) {
    return <Navigate to={`/surveys/${detail.survey.id}/responses/${detail.id}/charts`} replace />;
  }
  const ctx = x.ctx.data;
  const main = mainScore(detail.scores);
  const nav = ctx && detail.userId ? attemptNav(ctx.attempts, detail.id, main?.scaleCode ?? null) : null;

  return (
    <ResponseFrame banner={<ResponseBanner detail={detail} ctx={ctx} conclusion={x.conclusion.data} place="charts" />}>
      <ResponseTabs surveyId={detail.survey.id} responseId={detail.id} nav={nav} charts />
      <div className="flex flex-col gap-4">
        <ResultPanel detail={detail} dynamics={x.dynamics} ctx={ctx} variant="charts" />
        <div className="grid items-start gap-4 grid-cols-2 max-[1200px]:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-4">
            {x.wantsDynamics ? (
              x.dynamicsLoading ? (
                <Panel title={ut("rch.dynamics")} icon={<Ic.chart />}>
                  <Loading rows={3} bare />
                </Panel>
              ) : x.dynamics ? (
                <DynamicsPanel detail={detail} dyn={x.dynamics} />
              ) : null
            ) : null}
            {detail.scores.length ? (
              <ContributionPanel detail={detail} survey={x.survey} loading={x.surveyLoading} prev={x.prev} />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <ShapePanel detail={detail} survey={x.survey} attempts={ctx?.attempts ?? []} />
            <AnsweringPanel detail={detail} survey={x.survey} surveyLoading={x.surveyLoading} variant="charts" />
          </div>
        </div>
      </div>
    </ResponseFrame>
  );
}

/* ─────────── динамика ─────────── */

/** Лестница полос шкалы — той версии, которую проходили в ЭТОТ раз (у динамики своих полос нет) */
function rungsFor(detail: ResponseDetail, code: string): Rung[] {
  const sc = detail.scores.find((s) => s.scaleCode === code);
  return sortRungs((sc?.bands ?? []).map((b) => ({ min: b.minScore, max: b.maxScore, label: b.label, severity: b.severity })));
}

/**
 * «Динаміка»: график курса набора по всем сданным попыткам методики, со
 * «сьогодні», сессиями, неявками и сигналами из хронологии человека. Шкал
 * несколько — выбор шкалы в шапке панели; график один, как на карточке.
 */
export function DynamicsPanel({ detail, dyn }: { detail: ResponseDetail; dyn: RespondentDynamics }) {
  const series = buildTrends(detail, dyn).kind === "series";
  const timeline = useResource(
    () => api.timeline(detail.userId!).then((items) => ({ items }), () => ({ items: [] })),
    [detail.userId],
    { enabled: !!detail.userId && series, keep: false },
  );
  return <DynamicsBody detail={detail} dyn={dyn} events={courseEventsFromTimeline(timeline.data?.items ?? [])} />;
}

/** Тело «Динаміки» без загрузок: хронология (сессии, неявки, сигналы) приходит готовыми событиями */
export function DynamicsBody({ detail, dyn, events }: { detail: ResponseDetail; dyn: RespondentDynamics; events: CourseEvent[] }) {
  const { ut } = useLang();
  const view = buildTrends(detail, dyn);
  const entry = dyn.surveys.find((s) => s.surveyId === detail.survey.id);
  const scales = (entry?.scales ?? []).filter((s) => s.points.length > 0);
  const main = mainScore(detail.scores);
  const [picked, setPicked] = useState<string | null>(null);
  if (view.kind === "single" || !scales.length) {
    return (
      <Panel title={ut("rch.dynamics")} icon={<Ic.chart />}>
        <p className="m-0 text-small text-muted">{ut("rch.single")}</p>
      </Panel>
    );
  }
  const code = picked ?? (scales.some((s) => s.code === main?.scaleCode) ? main!.scaleCode : scales[0]!.code);
  const scale = scales.find((s) => s.code === code) ?? scales[0]!;
  const data = courseFromDynamics(scale, rungsFor(detail, scale.code));
  const notes = [
    !view.focusInSeries ? ut("rch.notInSeries") : null,
    view.scales.some((s) => s.mixedVersions) ? ut("rch.mixedVersions") : null,
  ].filter((n): n is string => !!n);
  return (
    <Panel
      title={ut("rch.dynamics")}
      icon={<Ic.chart />}
      sub={ut("rp.dynSub").replace("{n}", String(scale.points.length))}
      flush
      actions={
        scales.length > 1 ? (
          <Select aria-label={ut("rch.pickScale")} value={scale.code} onChange={(e) => setPicked(e.target.value)} className="w-[220px] max-w-full">
            {scales.map((s) => (
              <option key={s.code} value={s.code}>
                {s.title}
              </option>
            ))}
          </Select>
        ) : null
      }
    >
      <div className="px-4 pb-4 pt-1">
        <CourseChart title={scale.title} {...data} events={events} />
      </div>
      {notes.length ? (
        <div className="flex flex-col gap-1 px-4 pb-2">
          {notes.map((n) => (
            <p key={n} className="m-0 text-caption text-muted">
              {n}
            </p>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

/* ─────────── вклад пунктов ─────────── */

const TOP_ITEMS = 10;

/**
 * «Внесок пунктів»: что дал каждый пункт шкале — функцией движка по ключу
 * той версии — и что мог дать. Полоса делится на ступени, когда пункт даёт
 * целые баллы до шести; отметка — вклад того же пункта в прежней попытке.
 * Порядок — по вкладу или по номеру.
 */
export function ContributionPanel({
  detail,
  survey,
  loading,
  prev,
}: {
  detail: ResponseDetail;
  survey: SurveyFull | null;
  loading: boolean;
  prev: ResponseDetail | null;
}) {
  const { ut } = useLang();
  const [byNumber, setByNumber] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const panel = (body: React.ReactNode, actions?: React.ReactNode, sub?: string) => (
    <Panel title={ut("rch.contribution")} icon={<Rx.bars />} sub={sub} actions={actions}>
      {body}
    </Panel>
  );
  if (loading) return panel(<Loading rows={3} bare />);
  if (!survey) return panel(<p className="m-0 text-small text-muted">{ut("rch.versionMissing")}</p>);
  const view = buildContributions(detail, survey, prev);
  if (view.stale) return panel(<p className="m-0 text-small text-muted">{ut("rsp.staleVersion")}</p>);
  const withItems = view.scales.filter((s) => s.items.length || s.unanswered);
  if (!withItems.length) return null;
  const main = mainScore(detail.scores);
  const s = withItems.find((x) => x.scaleId === picked) ?? withItems.find((x) => x.scaleId === main?.scaleId) ?? withItems[0]!;
  const items = byNumber ? [...s.items].sort((a, b) => a.number - b.number) : s.items;
  const shown = open ? items : items.slice(0, TOP_ITEMS);
  const hidden = items.length - TOP_ITEMS;
  const actions = (
    <>
      {withItems.length > 1 ? (
        <Select aria-label={ut("rch.pickScale")} value={s.scaleId} onChange={(e) => setPicked(e.target.value)} className="w-[180px] max-w-full">
          {withItems.map((x) => (
            <option key={x.scaleId} value={x.scaleId}>
              {x.title}
            </option>
          ))}
        </Select>
      ) : null}
      <Button variant="ghost" size="xs" icon={<Ic.sortDesc />} aria-pressed={!byNumber} onClick={() => setByNumber((v) => !v)}>
        {byNumber ? ut("rp.byNumber") : ut("rp.byContribution")}
      </Button>
    </>
  );
  return panel(
    <>
      {s.items.length ? (
        <ContributionRows s={s} items={shown} prevDay={prev?.submittedAt ? day(prev.submittedAt) : null} />
      ) : (
        <p className="m-0 text-small text-muted">{ut("rch.noContribution")}</p>
      )}
      {hidden > 0 ? (
        <Button variant="quiet" size="xs" className="mt-2" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? ut("rch.less") : ut("rch.more").replace("{n}", String(hidden))}
        </Button>
      ) : null}
      <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-caption font-semibold text-text-2">
        {prev && s.items.some((i) => i.prev !== null) ? (
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-0.5 rounded-[1px] bg-text" />
            {ut("rp.prevMark").replace("{d}", day(prev.submittedAt ?? prev.startedAt))}
          </li>
        ) : null}
        <li>{ut("rp.barMeaning")}</li>
        {s.unanswered ? <li className="text-muted">{ut("rch.unanswered").replace("{n}", String(s.unanswered)).replace("{m}", String(s.size))}</li> : null}
      </ul>
    </>,
    actions,
    ut("rp.byKey").replace("{n}", String(detail.survey.versionNumber)),
  );
}

function ContributionRows({ s, items, prevDay }: { s: ScaleContribution; items: ScaleContribution["items"]; prevDay: string | null }) {
  const { ut } = useLang();
  const dec = useDecimal();
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {items.map((i) => {
        const steps = Number.isInteger(i.max) && i.max > 0 && i.max <= 6 ? i.max : 0;
        const share = s.top > 0 ? i.value / s.top : 0;
        const room = s.top > 0 ? i.max / s.top : 1;
        return (
          <li key={i.questionId}>
            <Popover
              title={`${i.number}. ${i.title}`}
              note={ut("rp.ofMax").replace("{v}", dec(i.value)).replace("{m}", dec(i.max))}
              content={
                <>
                  {i.critical ? <p className="m-0 font-bold text-risk-ink">{ut("cases.criticalOption")}</p> : null}
                  {i.prev !== null && prevDay ? <p className="m-0 text-muted">{ut("rp.wasOn").replace("{d}", prevDay).replace("{v}", dec(i.prev))}</p> : null}
                </>
              }
            >
              <div
                tabIndex={0}
                className="grid min-h-[30px] cursor-default grid-cols-[22px_minmax(0,168px)_minmax(0,1fr)_28px] items-center gap-x-2.5 rounded-[6px] text-small outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] max-[700px]:grid-cols-[22px_minmax(0,1fr)_96px_28px]"
              >
                <span className={cx("font-extrabold", i.critical ? "text-risk-ink" : "text-muted")}>{i.number}</span>
                <span className={cx("truncate font-semibold", i.critical ? "text-risk-ink" : "text-text-2")}>{i.title}</span>
                <span className="relative block h-2.5" style={{ width: `${Math.max(8, room * 100)}%` }} aria-hidden>
                  {steps ? (
                    <span className="flex h-full gap-[3px]">
                      {Array.from({ length: steps }, (_, k) => (
                        <i key={k} className={cx("flex-1 rounded-[3px]", k < i.value ? (i.critical ? "bg-risk" : "bg-series") : "bg-track")} />
                      ))}
                    </span>
                  ) : (
                    <span className="block h-full overflow-hidden rounded-[3px] bg-track">
                      <i className={cx("block h-full rounded-[3px]", i.critical ? "bg-risk" : "bg-series")} style={{ width: `${(share / Math.max(room, 1e-9)) * 100}%` }} />
                    </span>
                  )}
                  {i.prev !== null && i.max > 0 ? (
                    <span className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 rounded-[1px] bg-text" style={{ left: `${(i.prev / i.max) * 100}%` }} />
                  ) : null}
                </span>
                <span className={cx("text-right font-extrabold tabular-nums", i.critical && "text-risk-ink")}>{dec(i.value)}</span>
              </div>
            </Popover>
          </li>
        );
      })}
    </ul>
  );
}

/* ─────────── форма симптомов ─────────── */

const SHAPE_ATTEMPTS = 4;

/**
 * «Форма симптомів»: ответы по пунктам за последние попытки той же версии —
 * тепловой таблицей набора. Пункты — те, что стоят в сетке протокола (общий
 * набор вариантов): у них «2» в одном столбце значит то же, что «2» в
 * другом. Критический пункт с ненулевым ответом — красным.
 */
export function ShapePanel({
  detail,
  survey,
  attempts,
}: {
  detail: ResponseDetail;
  survey: SurveyFull | null;
  attempts: readonly ResponseAttempt[];
}) {
  const { ut } = useLang();
  const at = attempts.findIndex((a) => a.id === detail.id);
  const same = at < 0 ? [] : attempts.slice(0, at).filter((a) => a.versionNumber === attempts[at]!.versionNumber);
  const earlier = same.slice(-(SHAPE_ATTEMPTS - 1));
  const ids = earlier.map((a) => a.id);
  const others = useResource(
    () =>
      Promise.all(ids.map((id) => api.responseDetail(id).then((d): ResponseDetail | null => d, () => null))).then((list) => ({
        list: list.filter((d): d is ResponseDetail => d !== null),
      })),
    [ids.join(",")],
    { enabled: ids.length > 0, keep: false },
  );
  const grid = answerGrid(detail, survey, prevAnswers(null));
  if (!grid || !grid.rows.length) return null;
  if (ids.length && !others.data) {
    return (
      <Panel title={ut("rp.shape")} icon={<Rx.grid />}>
        <Loading rows={3} bare />
      </Panel>
    );
  }
  const series = [...(others.data?.list ?? []), detail];
  const byAttempt = series.map((d) => new Map(d.answers.map((a) => [a.questionId, a] as const)));
  const critical = new Set(detail.answers.filter((a) => a.options.some((o) => o.riskFlag)).map((a) => a.questionId));
  const max = Math.max(1, ...grid.columns.map((c) => c.score ?? 0), ...grid.rows.map((r) => r.score ?? 0));
  const legend = grid.columns.every((c) => c.score !== null)
    ? grid.columns.map((c) => ({ value: c.score!, label: c.text.toLowerCase() }))
    : undefined;
  return (
    <Panel
      title={ut("rp.shape")}
      icon={<Rx.grid />}
      sub={series.length > 1 ? ut("rp.shapeSub").replace("{n}", String(series.length)) : undefined}
    >
      <HeatTable
        caption={ut("rp.shape")}
        columns={series.map((d) => day(d.submittedAt ?? d.startedAt))}
        max={max}
        legend={legend}
        rows={grid.rows.map((r) => ({
          key: r.questionId,
          label: (
            <span className="block max-w-[260px] truncate max-[700px]:max-w-[150px]">
              {r.number}. {r.title}
            </span>
          ),
          critical: critical.has(r.questionId),
          cells: byAttempt.map((m) => {
            const a = m.get(r.questionId);
            return a && a.answered && a.score !== null ? a.score : null;
          }),
        }))}
      />
    </Panel>
  );
}
