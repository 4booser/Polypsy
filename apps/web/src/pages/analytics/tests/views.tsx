import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { QuestionAnalytics, ScaleAnalytics, SurveyAnalytics, SurveyResponse } from "@quizzy/shared";
import { api, openInTab, type AnalyticsSlice } from "../../../api";
import { LineChart } from "../../../charts";
import { BandTrend, Figure, HBars, Kpi, ScaleProfile, ShareBar, TimeColumns } from "../../../charts/clinical";
import { rungOf, type Rung } from "../../../charts/ladder";
import { DataQualityPanel } from "../../../components/DataQualityPanel";
import { ItemHeatmap } from "../../../components/ItemHeatmap";
import { dateTime, day, duration } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { IconDots } from "../../../ui/glyphs";
import { ActionMenu } from "../../../ui/menu";
import { Button, NoData, SeverityTag } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { FillSelect } from "./fields";
import {
  SMALL_CELL,
  SORTS,
  alphaLevel,
  chartsHref,
  fill,
  lossRows,
  medianPoints,
  numText,
  numericBars,
  optionParts,
  protocolHref,
  sortQuestions,
  timeBuckets,
  tooFastRows,
  weekPoints,
  type QuestionSort,
} from "./model";

/*
 * Виды вкладки «Тести» при срезе «Усі пацієнти».
 *
 * Шесть видов вкладками, а не шесть разделов одним свитком: у методики на
 * семьдесят пунктов свиток «шкалы + все пункты + время + качество» уходит на
 * три десятка экранов, и до качества протоколов не долистывает никто. Внутри
 * вида — разделы с линией 2px (RuleSection), как на карточке пациента.
 *
 * Все формы — из общего набора charts/clinical.tsx: одна форма на один
 * вопрос, и тот же вопрос на прохождении, сводке и здесь выглядит одинаково.
 */

/** Подпись колонки строки-списка: 13/700 серым, как на карточке пациента */
const CAPTION = "text-[13px] font-bold leading-[16px] text-muted";

/** Ячейки таблиц этого экрана: утилитами, без голых <table> наследия */
export const TH = "border-b border-hairline py-[8px] pr-[16px] text-left align-bottom text-[13px] font-bold leading-[16px] text-muted";
export const TD = "border-b border-hairline py-[8px] pr-[16px] align-top text-[13px] leading-[18px] text-text-2";
export const NUM = "text-right font-mono tabular-nums";

/** Лестница полос шкалы — в той форме, которую понимают линейка и динамика */
export function rungsOf(scale: Pick<ScaleAnalytics, "bands">): Rung[] {
  return scale.bands.map((b) => ({ min: b.min, max: b.max, label: b.label, severity: b.severity }));
}

/* ─────────── огляд ─────────── */

export function OverviewView({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const { mode, buckets } = useMemo(() => timeBuckets(data.timeline), [data.timeline]);
  const losses = useMemo(() => lossRows(data.dropOff), [data.dropOff]);

  return (
    <>
      {/*
        Четыре числа, которые читают первыми. Доходимость и медиана времени
        при пустом срезе — прочерк, а не «0%» и не «0 с»: ноль здесь был бы
        результатом, которого нет.
      */}
      <div className="grid grid-cols-4 gap-[16px] max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
        <Kpi label={ut("an.responses")} value={data.completed} hint={`${ut("an.started")} ${data.started}`} />
        <Kpi label={ut("ant.kpiPatients")} value={data.respondentCount} hint={ut("ant.kpiPatientsHint")} />
        <Kpi
          label={ut("an.completion")}
          value={data.started ? `${numText(data.completionRate, 1)}%` : null}
          hint={`${ut("an.abandoned")} ${data.abandoned}`}
        />
        <Kpi label={ut("an.medianTime")} value={data.medianDurationMs > 0 ? duration(data.medianDurationMs) : null} />
      </div>

      {/*
        «Зараз проходять» — сведения, а не сигнал: человек, спокойно
        отвечающий на вопросы, внимания не требует, поэтому строка тихая,
        без янтаря.
      */}
      {data.inProgressNow.length ? (
        <p className="m-0 mt-[14px] text-[13px] leading-[18px] text-muted">
          <span className="font-bold text-text">
            {ut("an.inProgressNow")} {data.inProgressNow.length}
          </span>{" "}
          — {data.inProgressNow.map((p) => `${p.userName ?? ut("an.anon")} (${p.answered} ${ut("an.answeredAbbr")})`).join(", ")} ·{" "}
          {ut("an.draftsAutosaved")}
        </p>
      ) : null}

      <RuleSection title={ut(mode === "week" ? "ant.byWeek" : "ant.byDay")} className="mt-[28px]">
        <TimeColumns
          label={ut(mode === "week" ? "ant.byWeek" : "ant.byDay")}
          columns={buckets.map((b) => ({ key: b.key, label: day(b.date), value: b.value }))}
        />
      </RuleSection>

      <RuleSection
        title={ut("an.dropOff")}
        hint={losses.cut ? `${ut("ant.dropOffCaption")}. ${fill(ut("ant.dropOffMore"), { n: losses.rows.length })}` : ut("ant.dropOffCaption")}
      >
        {losses.rows.length ? (
          <HBars
            items={losses.rows.map((r) => ({
              key: r.key,
              label: `${r.position + 1}. ${r.title}`,
              value: r.lost,
              text: fill(ut("ant.lostN"), { n: r.lost }),
            }))}
          />
        ) : (
          <p className="m-0 text-[13px] text-muted">{ut("ant.noDropOff")}</p>
        )}
      </RuleSection>
    </>
  );
}

/* ─────────── шкали ─────────── */

/**
 * «Загальний стан за шкалами»: сначала профиль медиан всех содержательных
 * шкал — одним взглядом, где на лестнице тяжести стоит отделение, — потом
 * раздел на каждую шкалу: из чего состоит целое (доли полос), числа строкой
 * и ход среднего по неделям на фоне той же лестницы.
 *
 * Шкалы достоверности идут последними и с пометкой: их полоса говорит о
 * заполнении, а не о человеке, и в общей картине состояния они стоять
 * наравне с депрессией не должны.
 */
export function ScalesView({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const ordered = [...data.scales].sort((a, b) => Number(a.kind === "validity") - Number(b.kind === "validity"));
  const clinical = ordered.filter((s) => s.kind !== "validity");

  if (!data.scales.length) return <NoData />;

  return (
    <>
      <p className="m-0 mb-[8px] max-w-[760px] text-[13px] leading-[18px] text-muted">{ut("ant.scalesHint")}</p>
      {clinical.length > 1 ? (
        <RuleSection title={ut("ant.profileTitle")} hint={ut("ant.profileCaption")}>
          <ScaleProfile
            rows={clinical.map((s) => {
              const rungs = rungsOf(s);
              const enough = (s.shape?.n ?? 0) >= SMALL_CELL;
              const value = enough ? s.median : null;
              const hit = value === null ? null : rungOf(rungs, value);
              return {
                key: s.scaleId,
                title: s.title,
                rungs,
                value,
                max: rungs.length ? null : s.maxPossible,
                valueText: enough ? numText(s.median) : ut("ant.tooFew"),
                band: hit ? { label: hit.label, severity: hit.severity } : null,
              };
            })}
          />
        </RuleSection>
      ) : null}
      {ordered.map((s) => (
        <ScaleBlock key={s.scaleId} scale={s} weeks={data.scaleTimeline.find((t) => t.scaleId === s.scaleId)?.weeks ?? []} />
      ))}
    </>
  );
}

function ScaleBlock({ scale: s, weeks }: { scale: ScaleAnalytics; weeks: SurveyAnalytics["scaleTimeline"][number]["weeks"] }) {
  const { ut } = useLang();
  const rungs = rungsOf(s);
  const n = s.shape?.n ?? 0;
  const enough = n >= SMALL_CELL;
  const counted = s.bands.reduce((sum, b) => sum + b.count, 0);
  const trend = weekPoints(weeks);
  const fc = s.floorCeiling;

  return (
    <RuleSection
      title={s.title}
      actions={<span className="font-mono text-[13px] text-muted">{s.code}</span>}
      hint={s.kind === "validity" ? ut("ant.validity") : undefined}
    >
      <div className="grid grid-cols-2 gap-x-[45px] gap-y-[24px] max-[900px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-[12px]">
          {s.bands.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">{ut("an.noInterpretiveNorms")}</p>
          ) : counted === 0 ? (
            <p className="m-0 text-[13px] text-muted">{ut("ant.bandsEmpty")}</p>
          ) : (
            <ShareBar
              label={s.title}
              parts={s.bands.map((b) => ({ key: `${b.label}-${b.min}`, label: b.label, value: b.count, severity: b.severity }))}
            />
          )}
          <p className="m-0 font-mono text-[13px] leading-[18px] text-text-2 tabular-nums">
            {enough
              ? fill(ut("ant.statsLine"), {
                  mean: numText(s.average),
                  median: numText(s.median),
                  q1: numText(s.p25),
                  q3: numText(s.p75),
                  min: numText(s.min),
                  max: numText(s.max),
                  top: numText(s.maxPossible),
                })
              : ut("ant.tooFew")}
          </p>
          {enough && s.measurement ? (
            <p className="m-0 text-[13px] leading-[18px] text-muted">{fill(ut("ant.mdc"), { n: numText(s.measurement.mdc95, 1) })}</p>
          ) : null}
          {fc?.ceilingProblem ? (
            <p className="m-0 text-[13px] leading-[18px] text-muted">{fill(ut("ant.ceiling"), { n: numText(fc.ceilingPercent, 0) })}</p>
          ) : null}
          {fc?.floorProblem ? (
            <p className="m-0 text-[13px] leading-[18px] text-muted">{fill(ut("ant.floor"), { n: numText(fc.floorPercent, 0) })}</p>
          ) : null}
          <Reliability scale={s} />
        </div>

        <Figure title={ut("ant.weekly")} caption={fill(ut("ant.weeklyHint"), { n: SMALL_CELL })}>
          {trend.enough ? (
            <BandTrend
              label={`${s.title}: ${ut("ant.weekly")}`}
              rungs={rungs}
              max={rungs.length ? null : s.maxPossible}
              height={200}
              points={trend.points.map((p) => {
                const hit = rungOf(rungs, p.value);
                return {
                  key: p.key,
                  t: p.t,
                  label: day(p.week),
                  value: p.value,
                  band: hit ? { label: hit.label, severity: hit.severity } : null,
                };
              })}
            />
          ) : (
            <p className="m-0 text-[13px] leading-[18px] text-muted">{fill(ut("ant.weeklyTooFew"), { n: SMALL_CELL })}</p>
          )}
        </Figure>
      </div>
    </RuleSection>
  );
}

/**
 * Надёжность словами: «висока узгодженість» читается без справочника, α —
 * рядом мелко для того, кто справочник знает. Таблица пунктов — раскрытием:
 * она нужна тому, кто правит методику, а не тому, кто смотрит на состояние.
 */
function Reliability({ scale: s }: { scale: ScaleAnalytics }) {
  const { ut } = useLang();
  const r = s.reliability;
  if (!r) return <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("an.noReliability")}</p>;
  const level = alphaLevel(r.alpha);
  const word = level === "high" ? ut("ant.alphaHigh") : level === "ok" ? ut("ant.alphaOk") : ut("ant.alphaLow");
  return (
    <div className="min-w-0">
      <p className="m-0 text-[13px] leading-[18px]">
        {/* низкая согласованность — повод посмотреть на пункты, то есть «требует внимания» */}
        <span className={cx("font-bold", level === "low" ? "text-accent" : "text-text")}>{word}</span>{" "}
        <span className="font-mono text-muted tabular-nums">
          {fill(ut("ant.alphaBasis"), { alpha: numText(r.alpha), items: r.itemCount, n: r.sampleN ?? "—" })}
        </span>
      </p>
      <details className="mt-[6px]">
        <summary className="cursor-pointer text-[13px] font-bold text-primary">{ut("ant.itemsTable")}</summary>
        <div className="mt-[8px] overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={TH}>{ut("an.item")}</th>
                <th scope="col" className={cx(TH, "text-right")}>{ut("an.link")}</th>
                <th scope="col" className={cx(TH, "text-right")}>{ut("an.alphaWithout")}</th>
                <th scope="col" className={cx(TH, "text-right")}>{ut("an.variance")}</th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((it) => (
                <tr key={it.questionId}>
                  <td className={cx(TD, "max-w-[320px]")}>{it.title}</td>
                  <td className={cx(TD, NUM)}>{numText(it.itemTotalCorrelation)}</td>
                  {/* альфа без пункта выше общей — пункт мешает шкале: на него стоит посмотреть */}
                  <td className={cx(TD, NUM, it.alphaIfDeleted !== null && it.alphaIfDeleted > r.alpha && "font-bold text-accent")}>
                    {numText(it.alphaIfDeleted)}
                  </td>
                  <td className={cx(TD, NUM)}>{numText(it.variance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/* ─────────── питання ─────────── */

const SORT_KEY: Record<QuestionSort, "ant.sortNumber" | "ant.sortSkips" | "ant.sortChanges" | "ant.sortTime"> = {
  number: "ant.sortNumber",
  skips: "ant.sortSkips",
  changes: "ant.sortChanges",
  time: "ant.sortTime",
};

/** Сколько пунктов рисуется сразу: у Міні-мульта их 71, у СМИЛ — 377 */
const QUESTIONS_PAGE = 40;

export function QuestionsView({
  data,
  sort,
  onSort,
}: {
  data: SurveyAnalytics;
  sort: QuestionSort;
  onSort: (s: QuestionSort) => void;
}) {
  const { ut } = useLang();
  const [limit, setLimit] = useState(QUESTIONS_PAGE);
  const sorted = useMemo(() => sortQuestions(data.questions, sort), [data.questions, sort]);
  if (!sorted.length) return <NoData />;

  return (
    <>
      <div className="mb-[8px] flex justify-end">
        <FillSelect label={ut("ant.sortBy")} value={sort} onChange={(v) => onSort(v as QuestionSort)} className="w-[260px] max-[520px]:w-full">
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {ut(SORT_KEY[s])}
            </option>
          ))}
        </FillSelect>
      </div>
      <ol className="m-0 list-none border-t-2 border-primary-rule p-0">
        {sorted.slice(0, limit).map((q) => (
          <QuestionRow key={q.questionId} q={q} />
        ))}
      </ol>
      {sorted.length > limit ? (
        <Button variant="ghost" className="mt-[16px]" onClick={() => setLimit((l) => l + QUESTIONS_PAGE)}>
          {ut("ui.loadMore")}
        </Button>
      ) : null}
    </>
  );
}

function QuestionRow({ q }: { q: QuestionAnalytics }) {
  const { ut } = useLang();
  let body: ReactNode = null;

  if (q.answered === 0) {
    body = <p className="m-0 text-[13px] text-muted">{ut("ant.noAnswers")}</p>;
  } else if (q.type === "ranking" && q.options?.length) {
    body = (
      <HBars
        max={q.options.length}
        items={q.options.map((o) => ({
          key: o.optionId,
          label: o.text,
          value: o.avgRank ?? null,
          text: o.avgRank !== undefined ? fill(ut("ant.avgRank"), { n: numText(o.avgRank, 1) }) : undefined,
        }))}
      />
    );
  } else if (q.options?.length) {
    body = <ShareBar label={q.title} parts={optionParts(q)} />;
  } else if (q.numeric) {
    body = (
      <>
        <HBars items={numericBars(q.numeric.distribution)} />
        <p className="m-0 mt-[6px] font-mono text-[12px] text-muted tabular-nums">
          {fill(ut("ant.numericLine"), {
            mean: numText(q.numeric.average),
            median: numText(q.numeric.median),
            min: numText(q.numeric.min),
            max: numText(q.numeric.max),
          })}
        </p>
      </>
    );
  } else if (q.texts?.length) {
    body = <FreeTexts texts={q.texts} />;
  }

  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-[12px] border-b border-hairline py-[14px]">
      <span className="font-mono text-[15px] font-bold leading-[19px] text-muted tabular-nums">{q.position + 1}</span>
      <div className="min-w-0">
        <p className="m-0 text-[15px] font-bold leading-[19px] text-text">
          {q.title}
          <span className="ml-[8px] text-[11px] font-normal text-muted">{ut(`qt.${q.type}`, q.type)}</span>
        </p>
        {body ? <div className="mt-[10px] max-w-[760px]">{body}</div> : null}
        <p className="m-0 mt-[8px] font-mono text-[12px] leading-[16px] text-muted tabular-nums">
          {fill(ut("ant.questionLine"), {
            n: q.answered,
            skip: numText(q.skipRate, 1),
            changed: numText(q.changedShare, 1),
            time: q.medianDurationMs > 0 ? duration(q.medianDurationMs) : "—",
          })}
        </p>
      </div>
    </li>
  );
}

/** Сколько свободных ответов печатается в раскрытии — остальное в выгрузке */
const TEXTS_SHOWN = 40;

/**
 * Свободные ответы — раскрытием и с оговоркой. Человек пишет в поле «что
 * беспокоит» имена, части, диагнозы; на экране, который открывают при
 * коллегах, это должно быть действием, а не тем, что стоит на виду.
 */
function FreeTexts({ texts }: { texts: string[] }) {
  const { ut } = useLang();
  return (
    <details>
      <summary className="cursor-pointer text-[13px] font-bold text-primary">{fill(ut("ant.showTexts"), { n: texts.length })}</summary>
      <p className="m-0 mt-[8px] text-[13px] leading-[18px] text-muted">{ut("ant.freeTextNote")}</p>
      <ul className="m-0 mt-[8px] flex list-none flex-col gap-[6px] p-0">
        {texts.slice(0, TEXTS_SHOWN).map((t, i) => (
          <li key={i} className="border-l-2 border-hairline pl-[10px] text-[13px] leading-[18px] text-text-2">
            {t}
          </li>
        ))}
      </ul>
      {texts.length > TEXTS_SHOWN ? (
        <p className="m-0 mt-[6px] text-[12px] text-muted">{fill(ut("ant.textsCut"), { n: TEXTS_SHOWN })}</p>
      ) : null}
    </details>
  );
}

/* ─────────── час ─────────── */

/** Подпись корзины длительности: «0–1 мин», «5 мин і довше» */
function binLabel(b: SurveyAnalytics["durationBins"][number], andLonger: string): string {
  const from = b.fromMs > 0 ? duration(b.fromMs) : "0";
  return b.toMs === null ? fill(andLonger, { n: from }) : `${from} – ${duration(b.toMs)}`;
}

export function TimeView({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const fast = tooFastRows(data.questions);
  const seconds = numText(data.tooFastThresholdMs / 1000, 1);

  return (
    <>
      <RuleSection title={ut("an.timePerQuestion")} hint={ut("an.spreadNotMean")}>
        {/*
          Линия медианы с полосой межквартильного размаха, а не ряд ящиков:
          спрашивают здесь, где по ходу методики люди начинают задумываться,
          и ряд из пятидесяти ящиков этого не показывает — глаз не проводит
          между ними линии.
        */}
        <LineChart
          unit={` ${ut("an.secAbbr")}`}
          series={[{ label: ut("an.medianTime"), points: medianPoints(data.questions, ut("an.questionAbbr")) }]}
        />
      </RuleSection>

      <RuleSection title={ut("ant.tooFastTitle")} hint={fill(ut("ant.tooFastCaption"), { n: seconds })}>
        {fast.length ? (
          <HBars
            max={100}
            items={fast.map((q) => ({
              key: q.questionId,
              label: `${q.position + 1}. ${q.title}`,
              value: q.tooFastShare,
              text: `${numText(q.tooFastShare, 1)}%`,
            }))}
          />
        ) : (
          <p className="m-0 text-[13px] text-muted">{ut("ant.noFast")}</p>
        )}
      </RuleSection>

      <RuleSection title={ut("ant.durationTitle")} hint={ut("ant.durationCaption")}>
        {data.durationBins.length ? (
          <HBars
            items={data.durationBins.map((b) => ({
              key: String(b.fromMs),
              label: binLabel(b, ut("ant.andLonger")),
              value: b.count,
            }))}
          />
        ) : (
          <NoData />
        )}
      </RuleSection>
    </>
  );
}

/* ─────────── якість ─────────── */

export function QualityView({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const sid = data.surveyId;
  return (
    <>
      <RuleSection title={ut("an.carelessTitle")}>
        <p className="m-0 mb-[14px] max-w-[760px] text-[13px] leading-[18px] text-muted">
          {fill(ut("ant.flaggedLine"), {
            n: data.quality.length,
            of: data.completed,
            s: numText(data.tooFastThresholdMs / 1000, 1),
          })}{" "}
          {ut("an.flagHint")}
        </p>
        {data.quality.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={TH}>{ut("an.respondent")}</th>
                  <th scope="col" className={TH}>{ut("ant.colDate")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("an.time")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("an.fast")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("an.streak")}</th>
                  <th scope="col" className={TH}>{ut("an.reasons")}</th>
                </tr>
              </thead>
              <tbody>
                {data.quality.map((q) => (
                  <tr key={q.responseId} className="hover:bg-primary-tint">
                    <td className={cx(TD, "font-bold")}>
                      <Link className="text-primary no-underline hover:underline" to={chartsHref(sid, q.responseId)}>
                        {q.respondent ?? ut("an.anonCap")}
                      </Link>
                    </td>
                    <td className={cx(TD, "whitespace-nowrap text-muted")}>{q.submittedAt ? day(q.submittedAt) : "—"}</td>
                    <td className={cx(TD, NUM)}>{duration(q.durationMs)}</td>
                    <td className={cx(TD, NUM)}>{numText(q.tooFastShare, 1)}%</td>
                    <td className={cx(TD, NUM)}>{q.longestStraightLine}</td>
                    <td className={cx(TD, "text-muted")}>{q.reasons.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 text-[13px] text-muted">{ut("an.noSuspicious")}</p>
        )}
      </RuleSection>

      {/*
        Карта пунктов — выше сводных таблиц: небрежное заполнение выдаёт
        себя формой, а не средним, и полоса одинаковых ответов от сорокового
        пункта до конца видна только здесь.
      */}
      <RuleSection title={ut("qh.title")}>
        <ItemHeatmap surveyId={sid} />
      </RuleSection>

      <DataQualityPanel surveyId={sid} />
    </>
  );
}

/* ─────────── проходження ─────────── */

export interface ResponsePages {
  rows: SurveyResponse[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
  loadMore: () => void;
  busy: boolean;
}

/**
 * Страницы списка прохождений под срезом экрана.
 *
 * Первая страница — через useResource (смена среза не даёт старому ответу
 * затереть новый), следующие — дописываются к ней по курсору и забываются
 * при смене среза: ключ среза хранится вместе с дописанным.
 */
export function useResponsePages(surveyId: string, slice: AnalyticsSlice & { versionId?: string }): ResponsePages {
  const key = JSON.stringify([surveyId, slice]);
  const first = useResource(() => api.responses(surveyId, null, slice), [key]);
  const [more, setMore] = useState<{ key: string; rows: SurveyResponse[]; next: string | null } | null>(null);
  const { run, busy } = useAction();
  const mine = more?.key === key ? more : null;
  const next = mine ? mine.next : first.data?.hasMore ? first.data.nextBefore : null;
  return {
    rows: [...(first.data?.rows ?? []), ...(mine?.rows ?? [])],
    hasMore: !!next,
    loading: !first.data && !first.error,
    error: first.error,
    reload: first.reload,
    busy,
    loadMore: () =>
      void run(async () => {
        const page = await api.responses(surveyId, next, slice);
        setMore((prev) => ({
          key,
          rows: [...(prev?.key === key ? prev.rows : []), ...page.rows],
          next: page.hasMore ? page.nextBefore : null,
        }));
      }),
  };
}

/** Сколько баллов шкал стоит в строке; остальное — «і ще N» и на графиках прохождения */
const SCORES_SHOWN = 6;

/**
 * Список прохождений строками — как список пациентов: имя 17/700 ведёт на
 * карточку человека, дата — на графики прохождения, баллы шкал с меткой
 * тяжести (цвет + форма точки + слово). Остальные двери — протокол,
 * заключение, печать — в «⋯» строки.
 */
export function ResponsesList({ pages, surveyId, showName = true }: { pages: ResponsePages; surveyId: string; showName?: boolean }) {
  const { ut } = useLang();
  const { run } = useAction();

  if (pages.error && !pages.rows.length) return <Loading error={pages.error} onRetry={pages.reload} />;
  if (pages.loading) return <Loading rows={4} />;
  if (!pages.rows.length) return <p className="m-0 py-[13px] text-[13px] text-muted">{ut("ant.noResponses")}</p>;

  const cols = showName
    ? "grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_88px_minmax(0,2.4fr)_27px]"
    : "grid-cols-[minmax(0,1fr)_88px_minmax(0,2.8fr)_27px]";

  return (
    <>
      <div className={cx("grid items-end gap-x-[24px] border-b border-hairline pb-[8px] max-[900px]:hidden", cols)}>
        {showName ? <span className={CAPTION}>{ut("ant.colPatient")}</span> : null}
        <span className={CAPTION}>{ut("ant.colDate")}</span>
        <span className={cx(CAPTION, "text-right")}>{ut("an.time")}</span>
        <span className={CAPTION}>{ut("an.scores")}</span>
        <span />
      </div>
      <ul className="m-0 list-none p-0">
        {pages.rows.map((r) => {
          const charts = chartsHref(surveyId, r.id);
          const scores = r.scores.slice(0, SCORES_SHOWN);
          return (
            <li
              key={r.id}
              className={cx(
                "grid items-start gap-x-[24px] gap-y-[6px] border-b border-hairline py-[12px]",
                "has-[a:hover]:bg-primary-tint has-[a:focus-visible]:bg-primary-tint",
                "max-[900px]:grid-cols-1",
                cols,
              )}
            >
              {showName ? (
                r.userId ? (
                  <Link
                    to={`/patients/${r.userId}`}
                    className="min-w-0 truncate text-[17px] font-bold leading-[20px] text-primary no-underline hover:no-underline"
                  >
                    {r.userName ?? ut("an.anonCap")}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-[17px] font-bold leading-[20px] text-primary">{r.userName ?? ut("an.anonCap")}</span>
                )
              ) : null}
              <Link to={charts} className="text-[13px] leading-[20px] text-text-2 no-underline hover:underline">
                {dateTime(r.submittedAt ?? r.startedAt)}
              </Link>
              <span className="text-right font-mono text-[13px] leading-[20px] text-text tabular-nums max-[900px]:text-left">
                {duration(r.durationMs)}
              </span>
              <div className="flex min-w-0 flex-wrap gap-x-[16px] gap-y-[6px]">
                {r.status !== "completed" ? (
                  <span className="text-[13px] leading-[20px] text-muted">{ut(`rstatus.${r.status}`, r.status)}</span>
                ) : (
                  <>
                    {scores.map((s) => (
                      <span key={s.scaleId} className="inline-flex min-w-0 items-center gap-[6px] text-[13px] leading-[20px]">
                        <span className="truncate text-text-2">{s.scaleTitle}</span>
                        <span className="font-mono text-text tabular-nums">{numText(s.value)}</span>
                        {s.band ? <SeverityTag level={s.band.severity}>{s.band.label}</SeverityTag> : null}
                      </span>
                    ))}
                    {r.scores.length > SCORES_SHOWN ? (
                      <span className="text-[13px] leading-[20px] text-muted">
                        {ut("ui.andMore")} {r.scores.length - SCORES_SHOWN}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
              <ActionMenu
                label={ut("ant.rowActions")}
                glyph={<IconDots />}
                entries={[
                  { label: ut("ant.openCharts"), to: charts },
                  { label: ut("ant.openProtocol"), to: protocolHref(surveyId, r.id) },
                  { label: ut("an.conclusion"), to: `/responses/${r.id}/conclusion` },
                  { label: ut("an.print"), onSelect: () => void run(() => openInTab(api.reportUrl(r.id))) },
                ]}
                plateClassName="min-w-[220px]"
              />
            </li>
          );
        })}
      </ul>
      {pages.hasMore ? (
        <Button variant="ghost" className="mt-[16px]" disabled={pages.busy} onClick={pages.loadMore}>
          {pages.busy ? ut("ui.loadingMore") : ut("ui.loadMore")}
        </Button>
      ) : null}
    </>
  );
}
