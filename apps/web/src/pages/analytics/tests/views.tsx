import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { QuestionAnalytics, ScaleAnalytics, SurveyAnalytics, SurveyResponse } from "@quizzy/shared";
import { api, openInTab, type AnalyticsSlice } from "../../../api";
import { LineChart } from "../../../charts";
import { BandTrend, Figure, HBars, ScaleProfile, SeverityMeter, ShareBar, TimeColumns } from "../../../charts/clinical";
import { DataTable as ChartTable, ViewSwitch } from "../../../charts/kit";
import { rungOf, type Rung } from "../../../charts/ladder";
import { DataQualityPanel } from "../../../components/DataQualityPanel";
import { ItemHeatmap } from "../../../components/ItemHeatmap";
import { day, duration, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Avatar, Callout, DataTable, type Column, Loading, PersonCell, TextAction, useAction } from "../../../ui";
import { SortMenu } from "../../../ui/filters";
import { Ic } from "../../../ui/icons";
import { IconTile, Panel } from "../../../ui/layout";
import { ActionMenu } from "../../../ui/menu";
import { Button, ButtonLink, NoData, Segmented, SeverityTag, Tag } from "../../../ui/primitives";
import { usePagedResource, useResource } from "../../../useResource";
import { AIc } from "../icons";
import {
  SMALL_CELL,
  SORTS,
  alphaLevel,
  bucketSummary,
  chartsHref,
  dayText,
  fill,
  heavyShare,
  kyivDay,
  lossRows,
  mainScale,
  medianPoints,
  numText,
  numericBars,
  optionParts,
  partialKey,
  protocolHref,
  sortQuestions,
  timeBuckets,
  tooFastRows,
  weekPoints,
  type QuestionSort,
  type View,
} from "./model";

/*
 * Виды «Аналітики тестів» при срезе «Усі пацієнти» (analytics-tests).
 *
 * «Огляд» — панели: прохождения по неделям и общий балл по полосам, где
 * теряют людей и качество данных, последние прохождения. Остальные виды —
 * то же по одному вопросу подробно: шкалы, пункты, время, качество, все
 * прохождения. Графики — только из общего набора (charts/clinical, charts/
 * index): одна форма на один вопрос, и тот же вопрос на прохождении, в
 * карточке и здесь выглядит одинаково.
 */

/** Ячейки простых таблиц этого экрана — токенами набора */
export const TH = "border-b border-divider py-2 pr-4 text-left align-bottom text-caption font-bold text-muted";
export const TD = "border-b border-divider py-2 pr-4 align-top text-small text-text-2";
export const NUM = "text-right tabular-nums";

/** Лестница полос шкалы — в той форме, которую понимают линейка и динамика */
export function rungsOf(scale: Pick<ScaleAnalytics, "bands">): Rung[] {
  return scale.bands.map((b) => ({ min: b.min, max: b.max, label: b.label, severity: b.severity }));
}

/** Число с разрядами по языку страницы: «1 096» */
export function nf(n: number): string {
  return n.toLocaleString(locale());
}

/** «08.10, 14:12» — дата и время строки списка: коротко, без года и названия месяца */
export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * Строка словаря с числами жирным: «Середнє {mean}, медіана {median}» →
 * «Середнє **10,8**, медіана **10**». Подстановки — числа и короткие
 * значения; жирным их печатает дизайн-система, чтобы глаз находил число в
 * строке, не читая её.
 */
export function rich(template: string, vars: Record<string, ReactNode>): ReactNode {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m && m[1]! in vars) {
      return (
        <b key={i} className="font-extrabold text-text">
          {vars[m[1]!]}
        </b>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** Первая буква фразы — заглавная: строка словаря написана для середины предложения */
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Переход «Шкали ↗» в шапке панели обзора: тот же экран, другой вид */
function ToView({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <TextAction onClick={onClick}>
      {label}
      <AIc.arrowUpRight size={14} />
    </TextAction>
  );
}

/* ─────────── огляд ─────────── */

export function OverviewView({ data, slice, onView }: { data: SurveyAnalytics; slice: AnalyticsSlice; onView: (v: View) => void }) {
  const { ut } = useLang();
  const scale = mainScale(data.scales);
  const total = data.questions.filter((q) => q.type !== "info").length;

  return (
    <div className="flex flex-col gap-4">
      {/*
        «Зараз проходять» — сведения, а не сигнал: человек, спокойно
        отвечающий на вопросы, внимания не требует, поэтому заметка тихая.
      */}
      {data.inProgressNow.length ? (
        <Callout kind="neutral" role="status" icon={<AIc.penLine />}>
          <b className="font-extrabold text-text">
            {ut("an.inProgressNow")} {data.inProgressNow.length}
          </b>{" "}
          —{" "}
          {data.inProgressNow
            .map((p) => `${p.userName ?? ut("an.anon")}, ${fill(ut("ant.answeredOf"), { n: p.answered, of: total })}`)
            .join("; ")}
          . {capital(ut("an.draftsAutosaved"))}.
        </Callout>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_420px] items-stretch gap-4 max-[1280px]:grid-cols-[minmax(0,1fr)_380px] max-[1100px]:grid-cols-1">
        <WeeklyPanel data={data} />
        {scale ? <BandsPanel scale={scale} onView={() => onView("scales")} /> : null}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_420px] items-stretch gap-4 max-[1280px]:grid-cols-[minmax(0,1fr)_380px] max-[1100px]:grid-cols-1">
        <DropoffPanel data={data} onView={() => onView("questions")} />
        <QualitySummary data={data} onView={() => onView("quality")} />
      </div>
      <RecentPanel data={data} slice={slice} onView={() => onView("responses")} />
    </div>
  );
}

/**
 * «Проходження за тижнями» (или за днями): столбцы с нулями там, где никого
 * не было, идущая неделя — светлее. Под графиком — сводка словами: среднее
 * по полным корзинам и самая полная.
 */
function WeeklyPanel({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const [asTable, setAsTable] = useState(false);
  const { mode, buckets } = useMemo(() => timeBuckets(data.timeline), [data.timeline]);
  const today = kyivDay();
  const partial = partialKey(buckets, mode, today);
  const sum = bucketSummary(buckets, partial);
  const title = ut(mode === "week" ? "ant.byWeek" : "ant.byDay");
  const label = (date: string) => dayText(date).slice(0, 5);

  return (
    <Panel
      title={title}
      icon={<AIc.chartColumn />}
      sub={mode === "week" ? ut("ant.weeklySub") : undefined}
      actions={buckets.length ? <ViewSwitch table={asTable} onTable={setAsTable} /> : null}
    >
      {!buckets.length ? (
        <NoData />
      ) : asTable ? (
        <div className="max-h-[300px] overflow-auto">
          <ChartTable
            caption={title}
            table={{
              head: [ut(mode === "week" ? "ant.colWeek" : "ant.colDay"), ut("an.responses")],
              rows: [...buckets].reverse().map((b) => [dayText(b.date), nf(b.value)]),
            }}
          />
        </div>
      ) : (
        <TimeColumns
          label={title}
          height={280}
          columns={buckets.map((b) => ({
            key: b.key,
            label: label(b.date),
            tip: mode === "week" ? fill(ut("ant.weekOf"), { date: dayText(b.date) }) : dayText(b.date),
            value: b.value,
            partial: b.key === partial,
          }))}
        />
      )}
      {sum ? (
        <p className="m-0 mt-2 text-small leading-[19px] text-text-2">
          {rich(ut(mode === "week" ? "ant.weekAvg" : "ant.dayAvg"), {
            n: sum.full,
            avg: nf(Math.round(sum.avg)),
            max: nf(sum.top.value),
            date: label(sum.top.date),
          })}
          {partial ? ` ${fill(ut(mode === "week" ? "ant.weekPartial" : "ant.dayPartial"), { date: label(partial) })}` : null}
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * «Загальний бал за смугами»: сколько завершённых прохождений легло в каждую
 * полосу, доля «помірна й важче», среднее с квартилями, медиана на лестнице
 * тяжести, порог похибки и надёжность. Ниже порога малых чисел — словами
 * «замало даних», не числами.
 */
function BandsPanel({ scale: s, onView }: { scale: ScaleAnalytics; onView: () => void }) {
  const { ut } = useLang();
  const rungs = rungsOf(s);
  const n = s.shape?.n ?? 0;
  const enough = n >= SMALL_CELL;
  const heavy = heavyShare(s.bands);
  const hit = enough ? rungOf(rungs, s.median) : null;
  return (
    <Panel
      title={fill(ut("ant.bandsOf"), { title: s.title })}
      icon={<AIc.chartBar />}
      sub={fill(ut("ant.scaleCode"), { code: s.code })}
      actions={<ToView label={ut("an.tabScales")} onClick={onView} />}
    >
      <HBars
        items={s.bands.map((b) => ({
          key: `${b.label}-${b.min}`,
          label: b.label,
          value: b.count,
          text: nf(b.count),
        }))}
      />
      {heavy && enough ? (
        <p className="m-0 mt-2 text-small text-text-2">
          {rich(ut("ant.heavyShare"), {
            band: heavy.label,
            p: `${numText((heavy.count / heavy.total) * 100, 0)} %`,
            k: nf(heavy.count),
            n: nf(heavy.total),
          })}
        </p>
      ) : null}
      <p className="m-0 mt-3 text-small text-text-2">
        {enough
          ? rich(ut("ant.statsLine"), {
              mean: numText(s.average, 1),
              median: numText(s.median),
              q1: numText(s.p25),
              q3: numText(s.p75),
              min: numText(s.min),
              max: numText(s.max),
              top: numText(s.maxPossible),
            })
          : ut("ant.tooFew")}
      </p>
      {enough && rungs.length ? (
        <>
          <span className="mb-2 mt-3 block text-caption font-bold text-muted">{ut("ant.medianLadder")}</span>
          {/* поля по краям: слово ступени у края шкалы шире своего места и иначе уходит за край панели */}
          <div className="px-5">
            <SeverityMeter rungs={rungs} value={s.median} label={`${s.title}: ${numText(s.median)}${hit ? ` — ${hit.label}` : ""}`} />
          </div>
        </>
      ) : null}
      <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0 text-small text-text-2">
        {enough && s.measurement ? (
          <li className="flex items-start gap-2">
            <AIc.ruler size={14} className="mt-0.5 text-muted" />
            <span>{rich(ut("ant.mdc"), { n: numText(s.measurement.mdc95, 1) })}</span>
          </li>
        ) : null}
        <ReliabilityLine scale={s} />
      </ul>
    </Panel>
  );
}

/** Надёжность одной строкой: слово, α, пунктов и проходжень */
function ReliabilityLine({ scale: s }: { scale: ScaleAnalytics }) {
  const { ut } = useLang();
  const r = s.reliability;
  if (!r) {
    return (
      <li className="flex items-start gap-2">
        <Ic.info size={14} className="mt-0.5 text-muted" />
        <span>{ut("an.noReliability")}</span>
      </li>
    );
  }
  const level = alphaLevel(r.alpha);
  const word = level === "high" ? ut("ant.alphaHigh") : level === "ok" ? ut("ant.alphaOk") : ut("ant.alphaLow");
  return (
    <li className="flex items-start gap-2">
      {/* низкая согласованность — повод посмотреть на пункты, то есть «требует внимания» */}
      {level === "low" ? <Ic.alert size={14} className="mt-0.5 text-warn" /> : <Ic.circleCheck size={14} className="mt-0.5 text-good" />}
      <span>
        <span className={level === "low" ? "font-bold text-warn" : undefined}>{word}</span>
        {": "}
        {rich(ut("ant.alphaBasis"), { alpha: numText(r.alpha), items: r.itemCount, n: r.sampleN ?? "—" })}
      </span>
    </li>
  );
}

/** «Де переривають заповнення»: пункты, после которых прерывали, — с итогом словами */
function DropoffPanel({ data, onView }: { data: SurveyAnalytics; onView: () => void }) {
  const { ut } = useLang();
  const losses = useMemo(() => lossRows(data.dropOff), [data.dropOff]);
  return (
    <Panel title={ut("an.dropOff")} icon={<AIc.chartBarDecreasing />} actions={<ToView label={ut("an.tabQuestions")} onClick={onView} />}>
      <p className="m-0 mb-3 text-small leading-[19px] text-text-2">
        {ut("ant.dropOffCaption")}.{" "}
        {data.started
          ? rich(ut("ant.dropOffTotal"), { a: nf(data.abandoned), s: nf(data.started), r: `${numText(data.completionRate, 1)} %` })
          : null}
        {losses.cut ? ` ${fill(ut("ant.dropOffMore"), { n: losses.rows.length })}.` : null}
      </p>
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
        <p className="m-0 text-small text-muted">{ut("ant.noDropOff")}</p>
      )}
    </Panel>
  );
}

/** Строка сводки качества: квадрат значка, жирное начало, число справа и пояснение */
function QualityRow({ icon, tone, title, value, children }: { icon: ReactNode; tone: "warn" | "neutral"; title: string; value: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 border-t border-divider py-3 first:border-t-0 first:pt-0.5">
      <IconTile icon={icon} tone={tone} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2.5">
          <b className="min-w-0 text-body font-extrabold text-text">{title}</b>
          <span className="ml-auto whitespace-nowrap text-body font-extrabold text-text">{value}</span>
        </div>
        <p className="m-0 mt-0.5 text-small leading-[18px] text-text-2">{children}</p>
      </div>
    </li>
  );
}

const SEX_KEY = { male: "dq.men", female: "dq.women" } as const;

/**
 * «Якість даних» на обзоре — четыре строки сводки: небрежное заполнение
 * (по срезу экрана), доходимость по группам, дрейф и повторяемость (по
 * всей истории методики — так их считает сервер). Подробно — вид «Якість».
 */
function QualitySummary({ data, onView }: { data: SurveyAnalytics; onView: () => void }) {
  const { ut } = useLang();
  const dq = useResource(() => api.dataQuality(data.surveyId), [data.surveyId]);
  const q = dq.data;
  const worst = q?.strata
    .filter((s) => !s.suppressed && s.completionRate !== undefined)
    .sort((a, b) => (a.completionRate ?? 100) - (b.completionRate ?? 100))[0];
  const drift = q?.drift.length ? q.drift.reduce((a, b) => (b.psi > a.psi ? b : a)) : null;
  const retest = q?.retest.find((r) => r.icc !== null) ?? null;
  const sexOf = (sex: string) => (sex in SEX_KEY ? ut(SEX_KEY[sex as keyof typeof SEX_KEY]) : sex);

  return (
    <Panel title={ut("ant.qualityTitle")} icon={<Ic.shieldCheck />} actions={<ToView label={ut("an.tabQuality")} onClick={onView} />}>
      <ul className="m-0 list-none p-0">
        <QualityRow
          icon={<AIc.flag />}
          tone={data.quality.length ? "warn" : "neutral"}
          title={ut("an.carelessTitle")}
          value={fill(ut("kit.ofTotal"), { n: nf(data.quality.length), total: nf(data.completed) })}
        >
          {fill(ut("ant.fastThreshold"), { s: numText(data.tooFastThresholdMs / 1000, 1) })} {ut("an.flagHint")}
        </QualityRow>
        {dq.error ? null : !q ? (
          <li className="py-3">
            <Loading bare rows={2} />
          </li>
        ) : (
          <>
            <QualityRow
              icon={<AIc.usersRound />}
              tone={worst && (worst.completionRate ?? 100) < 80 ? "warn" : "neutral"}
              title={ut("dq.completionTitle")}
              value={worst ? `${sexOf(worst.sex)} ${worst.band}: ${numText(worst.completionRate, 1)} %` : "—"}
            >
              {worst && (worst.completionRate ?? 100) < 80 ? `${ut("dq.underrepresented")} ` : ""}
              {fill(ut("ant.groupsHidden"), { n: q.smallCellFloor })}
            </QualityRow>
            {drift ? (
              <QualityRow icon={<AIc.waves />} tone={drift.psi > 0.2 ? "warn" : "neutral"} title={ut("dq.driftTitle")} value={`PSI ${numText(drift.psi)}`}>
                {drift.code}: {drift.verdict}
              </QualityRow>
            ) : null}
            <QualityRow icon={<AIc.repeat />} tone="neutral" title={ut("dq.repeatTitle")} value={retest ? `ICC ${numText(retest.icc)}` : "—"}>
              {retest
                ? fill(ut("ant.retestPairs"), { n: retest.pairs, min: q.retestWindow.minDays, max: q.retestWindow.maxDays })
                : fill(ut("ant.retestNone"), { n: q.retestWindow.minPairs })}
            </QualityRow>
          </>
        )}
      </ul>
    </Panel>
  );
}

/** Сколько строк в «Останні проходження» обзора — остальное во вкладке «Проходження» */
const RECENT = 6;

type StatusPick = "all" | "completed" | "abandoned";

/** «Останні проходження»: шесть последних строк среза с отбором по состоянию */
function RecentPanel({ data, slice, onView }: { data: SurveyAnalytics; slice: AnalyticsSlice; onView: () => void }) {
  const { ut } = useLang();
  const [status, setStatus] = useState<StatusPick>("all");
  const pages = useResponsePages(data.surveyId, { ...slice, versionId: data.versionId ?? undefined });
  const rows = pages.rows.filter((r) => status === "all" || r.status === status).slice(0, RECENT);
  return (
    <Panel
      title={ut("ant.recentTitle")}
      icon={<Ic.list />}
      count={data.completed}
      flush
      actions={
        <>
          <Segmented
            label={ut("ant.statusPick")}
            value={status}
            onChange={setStatus}
            items={[
              { key: "all", label: ut("ant.stAll") },
              { key: "completed", label: ut("ant.stDone") },
              { key: "abandoned", label: ut("ant.stAbandoned") },
            ]}
          />
          <ToView label={ut("ant.allResponses")} onClick={onView} />
        </>
      }
    >
      <ResponsesTable pages={{ ...pages, rows, hasMore: false }} surveyId={data.surveyId} />
    </Panel>
  );
}

/* ─────────── шкали ─────────── */

/**
 * «Загальний стан за шкалами»: сначала профиль медиан всех содержательных
 * шкал — одним взглядом, где на лестнице тяжести стоит отделение, — потом
 * панель на каждую шкалу: из чего состоит целое (доли полос), числа строкой
 * и ход среднего по неделям на фоне той же лестницы.
 *
 * Шкалы достоверности идут последними и с пометкой: их полоса говорит о
 * заполнении, а не о человеке.
 */
export function ScalesView({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const ordered = [...data.scales].sort((a, b) => Number(a.kind === "validity") - Number(b.kind === "validity"));
  const clinical = ordered.filter((s) => s.kind !== "validity");

  if (!data.scales.length) return <NoData />;

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[80ch] text-small text-text-2">
        {ut("ant.scalesHint")}
        {data.unreliableCount ? (
          <>
            {" "}
            {ut("stats.unreliableScales")} <b className="font-extrabold text-text">{data.unreliableCount}</b>. {ut("stats.unreliableScalesTail")}
          </>
        ) : null}
      </p>
      {clinical.length > 1 ? (
        <Panel title={ut("ant.profileTitle")} icon={<AIc.chartBar />} hint={ut("ant.profileCaption")}>
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
        </Panel>
      ) : null}
      {ordered.map((s) => (
        <ScaleBlock key={s.scaleId} scale={s} weeks={data.scaleTimeline.find((t) => t.scaleId === s.scaleId)?.weeks ?? []} />
      ))}
    </div>
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
    <Panel
      title={s.title}
      icon={<AIc.chartBar />}
      tone={s.kind === "validity" ? "neutral" : "violet"}
      sub={fill(ut("ant.scaleCode"), { code: s.code })}
      hint={s.kind === "validity" ? ut("ant.validity") : undefined}
    >
      <div className="grid grid-cols-2 gap-x-10 gap-y-6 max-[1180px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-3">
          {s.bands.length === 0 ? (
            <p className="m-0 text-small text-muted">{ut("an.noInterpretiveNorms")}</p>
          ) : counted === 0 ? (
            <p className="m-0 text-small text-muted">{ut("ant.bandsEmpty")}</p>
          ) : (
            <ShareBar
              label={s.title}
              parts={s.bands.map((b) => ({ key: `${b.label}-${b.min}`, label: b.label, value: b.count, severity: b.severity }))}
            />
          )}
          <p className="m-0 text-small text-text-2">
            {enough
              ? rich(ut("ant.statsLine"), {
                  mean: numText(s.average, 1),
                  median: numText(s.median),
                  q1: numText(s.p25),
                  q3: numText(s.p75),
                  min: numText(s.min),
                  max: numText(s.max),
                  top: numText(s.maxPossible),
                })
              : ut("ant.tooFew")}
          </p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-small text-text-2">
            {enough && s.measurement ? (
              <li className="flex items-start gap-2">
                <AIc.ruler size={14} className="mt-0.5 text-muted" />
                <span>{rich(ut("ant.mdc"), { n: numText(s.measurement.mdc95, 1) })}</span>
              </li>
            ) : null}
            {fc?.ceilingProblem ? (
              <li className="flex items-start gap-2 text-warn">
                <Ic.alert size={14} className="mt-0.5" />
                <span>{fill(ut("ant.ceiling"), { n: numText(fc.ceilingPercent, 0) })}</span>
              </li>
            ) : null}
            {fc?.floorProblem ? (
              <li className="flex items-start gap-2 text-warn">
                <Ic.alert size={14} className="mt-0.5" />
                <span>{fill(ut("ant.floor"), { n: numText(fc.floorPercent, 0) })}</span>
              </li>
            ) : null}
            <ReliabilityLine scale={s} />
          </ul>
          <ItemsTable scale={s} />
        </div>

        <Figure title={ut("ant.weekly")} caption={fill(ut("ant.weeklyHint"), { n: SMALL_CELL })}>
          {trend.enough ? (
            <BandTrend
              label={`${s.title}: ${ut("ant.weekly")}`}
              rungs={rungs}
              max={rungs.length ? null : s.maxPossible}
              height={220}
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
            <p className="m-0 text-small text-muted">{fill(ut("ant.weeklyTooFew"), { n: SMALL_CELL })}</p>
          )}
        </Figure>
      </div>
    </Panel>
  );
}

/**
 * Таблица пунктов шкалы — раскрытием: она нужна тому, кто правит методику,
 * а не тому, кто смотрит на состояние.
 */
function ItemsTable({ scale: s }: { scale: ScaleAnalytics }) {
  const { ut } = useLang();
  const r = s.reliability;
  if (!r) return null;
  return (
    <details>
      <summary className="cursor-pointer text-small font-bold text-violet-ink">{ut("ant.itemsTable")}</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" className={TH}>
                {ut("an.item")}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {ut("an.link")}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {ut("an.alphaWithout")}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {ut("an.variance")}
              </th>
            </tr>
          </thead>
          <tbody>
            {r.items.map((it) => (
              <tr key={it.questionId}>
                <td className={`${TD} max-w-[320px]`}>{it.title}</td>
                <td className={`${TD} ${NUM}`}>{numText(it.itemTotalCorrelation)}</td>
                {/* альфа без пункта выше общей — пункт мешает шкале: на него стоит посмотреть */}
                <td className={`${TD} ${NUM} ${it.alphaIfDeleted !== null && it.alphaIfDeleted > r.alpha ? "font-bold text-warn" : ""}`}>
                  {numText(it.alphaIfDeleted)}
                </td>
                <td className={`${TD} ${NUM}`}>{numText(it.variance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
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
    <Panel
      title={ut("an.tabQuestions")}
      icon={<AIc.listOrdered />}
      count={sorted.length}
      flush
      actions={
        <SortMenu
          label={ut("ant.sortBy")}
          options={SORTS.map((s) => ({ key: s, label: ut(SORT_KEY[s]) }))}
          value={sort}
          onChange={(k) => onSort(k as QuestionSort)}
        />
      }
    >
      <ol className="m-0 list-none border-t border-divider p-0">
        {sorted.slice(0, limit).map((q) => (
          <QuestionRow key={q.questionId} q={q} />
        ))}
      </ol>
      {sorted.length > limit ? (
        <div className="border-t border-divider px-4 py-3">
          <Button size="xs" onClick={() => setLimit((l) => l + QUESTIONS_PAGE)}>
            {ut("ui.loadMore")}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

function QuestionRow({ q }: { q: QuestionAnalytics }) {
  const { ut } = useLang();
  let body: ReactNode = null;

  if (q.answered === 0) {
    body = <p className="m-0 text-small text-muted">{ut("ant.noAnswers")}</p>;
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
        <p className="m-0 mt-1.5 text-caption text-muted">
          {rich(ut("ant.numericLine"), {
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
    <li className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 border-b border-divider px-4 py-3.5 last:border-b-0">
      <span className="text-[15px] font-extrabold leading-5 tabular-nums text-muted">{q.position + 1}</span>
      <div className="min-w-0">
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body font-bold leading-5 text-text">
          <span className="min-w-0">{q.title}</span>
          <Tag tone="plain">{ut(`qt.${q.type}`, q.type)}</Tag>
        </p>
        {body ? <div className="mt-2.5 max-w-[760px]">{body}</div> : null}
        <p className="m-0 mt-2 text-caption leading-4 text-muted">
          {rich(ut("ant.questionLine"), {
            n: nf(q.answered),
            skip: `${numText(q.skipRate, 1)} %`,
            changed: `${numText(q.changedShare, 1)} %`,
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
      <summary className="cursor-pointer text-small font-bold text-violet-ink">{fill(ut("ant.showTexts"), { n: texts.length })}</summary>
      <Callout kind="warn" className="mt-2">
        {ut("ant.freeTextNote")}
      </Callout>
      <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        {texts.slice(0, TEXTS_SHOWN).map((t, i) => (
          <li key={i} className="rounded-[8px] bg-sunk px-2.5 py-1.5 text-small leading-[18px] text-text-2">
            {t}
          </li>
        ))}
      </ul>
      {texts.length > TEXTS_SHOWN ? <p className="m-0 mt-1.5 text-caption text-muted">{fill(ut("ant.textsCut"), { n: TEXTS_SHOWN })}</p> : null}
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
    <div className="flex flex-col gap-4">
      <Panel title={ut("an.timePerQuestion")} icon={<Ic.timer />} hint={ut("an.spreadNotMean")}>
        {/*
          Линия медианы с полосой межквартильного размаха, а не ряд ящиков:
          спрашивают здесь, где по ходу методики люди начинают задумываться,
          и ряд из пятидесяти ящиков этого не показывает.
        */}
        <LineChart
          unit={` ${ut("an.secAbbr")}`}
          series={[{ label: ut("an.medianTime"), points: medianPoints(data.questions, ut("an.questionAbbr")) }]}
        />
      </Panel>
      <div className="grid grid-cols-2 items-stretch gap-4 max-[1180px]:grid-cols-1">
        <Panel title={ut("ant.tooFastTitle")} icon={<AIc.flag />} hint={fill(ut("ant.tooFastCaption"), { n: seconds })}>
          {fast.length ? (
            <HBars
              max={100}
              items={fast.map((q) => ({
                key: q.questionId,
                label: `${q.position + 1}. ${q.title}`,
                value: q.tooFastShare,
                text: `${numText(q.tooFastShare, 1)} %`,
                attention: true,
              }))}
            />
          ) : (
            <p className="m-0 text-small text-muted">{ut("ant.noFast")}</p>
          )}
        </Panel>
        <Panel title={ut("ant.durationTitle")} icon={<AIc.chartBar />} hint={ut("ant.durationCaption")}>
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
        </Panel>
      </div>
    </div>
  );
}

/* ─────────── якість ─────────── */

type QualityRowData = SurveyAnalytics["quality"][number];

export function QualityView({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const sid = data.surveyId;
  const columns: Column<QualityRowData>[] = [
    {
      key: "who",
      header: ut("an.respondent"),
      required: true,
      sort: (q) => q.respondent ?? "",
      render: (q) => (
        <Link className="font-bold text-text no-underline hover:text-violet-ink hover:underline" to={chartsHref(sid, q.responseId)}>
          {q.respondent ?? ut("an.anonCap")}
        </Link>
      ),
    },
    { key: "date", header: ut("ant.colDate"), required: true, sort: (q) => q.submittedAt ?? "", render: (q) => (q.submittedAt ? day(q.submittedAt) : "—") },
    { key: "time", header: ut("an.time"), num: true, required: true, sort: (q) => q.durationMs, render: (q) => duration(q.durationMs) },
    { key: "fast", header: ut("an.fast"), num: true, required: true, sort: (q) => q.tooFastShare, render: (q) => `${numText(q.tooFastShare, 1)} %` },
    { key: "run", header: ut("an.streak"), num: true, required: true, sort: (q) => q.longestStraightLine, render: (q) => q.longestStraightLine },
    { key: "why", header: ut("an.reasons"), required: true, render: (q) => <span className="text-text-2">{q.reasons.join("; ")}</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={ut("an.carelessTitle")}
        icon={<AIc.flag />}
        tone={data.quality.length ? "warn" : "violet"}
        count={data.quality.length}
        hint={
          <>
            {rich(ut("ant.flaggedLine"), { n: nf(data.quality.length), of: nf(data.completed), s: numText(data.tooFastThresholdMs / 1000, 1) })}{" "}
            {ut("an.flagHint")}
          </>
        }
        flush
      >
        {data.quality.length ? (
          <DataTable
            rows={data.quality}
            columns={columns}
            rowKey={(q) => q.responseId}
            label={ut("an.carelessTitle")}
            onRowClick={(q) => navigate(chartsHref(sid, q.responseId))}
            sticky={false}
            dense
          />
        ) : (
          <p className="m-0 px-4 pb-4 text-small text-muted">{ut("an.noSuspicious")}</p>
        )}
      </Panel>

      {/*
        Карта пунктов — выше сводных таблиц: небрежное заполнение выдаёт
        себя формой, а не средним, и полоса одинаковых ответов от сорокового
        пункта до конца видна только здесь.
      */}
      <Panel title={ut("qh.title")} icon={<AIc.table2 />}>
        <ItemHeatmap surveyId={sid} />
      </Panel>

      <Panel title={ut("ant.qualityTitle")} icon={<Ic.shieldCheck />}>
        <DataQualityPanel surveyId={sid} />
      </Panel>
    </div>
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
 * Через usePagedResource: страницы лежат под ключом среза вместе и
 * перечитываются вместе — после «перечитати» первая страница не приходит
 * свежей при прежних дописанных.
 */
export function useResponsePages(surveyId: string, slice: AnalyticsSlice & { versionId?: string }): ResponsePages {
  const key = JSON.stringify([surveyId, slice]);
  const pages = usePagedResource<SurveyResponse>(
    (cursor) =>
      api
        .responses(surveyId, cursor, slice)
        .then((p) => ({ items: p.rows, nextCursor: p.hasMore ? p.nextBefore : null })),
    [key],
  );
  return {
    rows: pages.items ?? [],
    hasMore: pages.hasMore,
    loading: !pages.items && !pages.error,
    error: pages.error,
    reload: pages.reload,
    busy: pages.loadingMore,
    loadMore: pages.loadMore,
  };
}

/** Сколько баллов шкал стоит в строке; остальное — «і ще N» и на графиках прохождения */
const SCORES_SHOWN = 3;

/** Баллы строки: значение, «/макс» у сырого балла и слово полосы; у незавершённого — состояние */
export function ScoresCell({ r }: { r: SurveyResponse }) {
  const { ut } = useLang();
  if (r.status !== "completed") {
    return (
      <Tag tone={r.status === "abandoned" ? "attention" : "info"} icon={r.status === "abandoned" ? <AIc.circleDot /> : <Ic.timer />}>
        {ut(`rstatus.${r.status}`, r.status)}
      </Tag>
    );
  }
  const scores = r.scores.slice(0, SCORES_SHOWN);
  const many = r.scores.length > 1;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {scores.map((s) => (
        <span key={s.scaleId} className="inline-flex items-center gap-1.5" title={s.scaleTitle}>
          {many ? <span className="text-caption font-semibold text-muted">{s.scaleCode}</span> : null}
          <b className="text-body font-extrabold tabular-nums text-text">{numText(s.value)}</b>
          {s.normalization === "raw" ? <span className="text-caption text-muted">/{numText(s.maxScore)}</span> : null}
          {s.band ? (
            <SeverityTag small level={s.band.severity}>
              {s.band.label}
            </SeverityTag>
          ) : null}
        </span>
      ))}
      {r.scores.length > SCORES_SHOWN ? (
        <span className="text-caption text-muted">
          {ut("ui.andMore")} {r.scores.length - SCORES_SHOWN}
        </span>
      ) : null}
    </span>
  );
}

/** Действия строки прохождения: графики и протокол значками, остальное в «⋯» */
export function ResponseActions({ surveyId, r }: { surveyId: string; r: SurveyResponse }) {
  const { ut } = useLang();
  const { run } = useAction();
  const charts = chartsHref(surveyId, r.id);
  return (
    <>
      <ButtonLink to={charts} variant="quiet" size="icon-sm" aria-label={ut("ant.openCharts")} title={ut("ant.openCharts")}>
        <Ic.chart size={15} />
      </ButtonLink>
      <ButtonLink to={protocolHref(surveyId, r.id)} variant="quiet" size="icon-sm" aria-label={ut("ant.openProtocol")} title={ut("ant.openProtocol")}>
        <Ic.file size={15} />
      </ButtonLink>
      <ActionMenu
        label={ut("ant.rowActions")}
        triggerSize="icon-sm"
        plateClassName="min-w-[220px]"
        entries={[
          { label: ut("ant.openCharts"), to: charts, icon: <Ic.chart size={15} /> },
          { label: ut("ant.openProtocol"), to: protocolHref(surveyId, r.id), icon: <Ic.file size={15} /> },
          { label: ut("an.conclusion"), to: `/responses/${r.id}/conclusion`, icon: <AIc.filePen size={15} /> },
          { label: ut("an.print"), onSelect: () => void run(() => openInTab(api.reportUrl(r.id))), icon: <AIc.printer size={15} /> },
        ]}
      />
    </>
  );
}

/**
 * Прохождения таблицей набора: человек (на его карточку), дата (на графики
 * прохождения), время, баллы со словом полосы, версия. Строка открывает
 * графики; протокол, заключение и печать — в действиях строки.
 */
export function ResponsesTable({ pages, surveyId, showName = true }: { pages: ResponsePages; surveyId: string; showName?: boolean }) {
  const { ut } = useLang();
  const navigate = useNavigate();

  if (pages.error && !pages.rows.length) return <Loading bare error={pages.error} onRetry={pages.reload} />;
  if (pages.loading) return <Loading bare rows={4} />;
  if (!pages.rows.length) return <p className="m-0 px-4 pb-4 pt-1 text-small text-muted">{ut("ant.noResponses")}</p>;

  const columns: Column<SurveyResponse>[] = [
    ...(showName
      ? [
          {
            key: "who",
            header: ut("ant.colPatient"),
            required: true,
            width: 280,
            render: (r: SurveyResponse) =>
              r.userId ? (
                <PersonCell name={r.userName ?? ut("an.anonCap")} avatar={<Avatar name={r.userName ?? "—"} size={28} />} to={`/patients/${r.userId}`} />
              ) : (
                <PersonCell name={ut("an.anonCap")} avatar={<Avatar name="—" size={28} tone="neutral" />} />
              ),
          },
        ]
      : []),
    {
      key: "date",
      header: ut("ant.colDate"),
      required: true,
      width: 130,
      render: (r) => (
        <Link to={chartsHref(surveyId, r.id)} className="whitespace-nowrap font-bold text-violet-ink no-underline hover:underline">
          {shortDateTime(r.submittedAt ?? r.startedAt)}
        </Link>
      ),
    },
    { key: "time", header: ut("an.time"), required: true, width: 100, render: (r) => <span className="whitespace-nowrap text-text-2">{duration(r.durationMs)}</span> },
    { key: "scores", header: ut("an.scores"), required: true, render: (r) => <ScoresCell r={r} /> },
  ];
  /* версия — только когда сервер её прислал: пустая колонка читается как «версии нет» */
  if (pages.rows.some((r) => r.versionNumber)) {
    columns.push({
      key: "ver",
      header: ut("an.version"),
      required: true,
      width: 80,
      render: (r) => (r.versionNumber ? <span className="text-text-2">{fill(ut("ant.verShort"), { n: r.versionNumber })}</span> : null),
    });
  }

  return (
    <>
      <DataTable
        rows={pages.rows}
        columns={columns}
        rowKey={(r) => r.id}
        label={ut("an.tabResponses")}
        onRowClick={(r) => navigate(chartsHref(surveyId, r.id))}
        rowActions={(r) => <ResponseActions surveyId={surveyId} r={r} />}
        sticky={false}
      />
      {/* отказ дозагрузки — под списком, а не вместо него: показанные строки верны */}
      {pages.error ? <p className="m-0 px-4 py-2 text-small font-bold text-risk-ink">{pages.error}</p> : null}
      {pages.hasMore ? (
        <div className="border-t border-divider px-4 py-3">
          <Button size="xs" disabled={pages.busy} onClick={pages.loadMore}>
            {pages.busy ? ut("ui.loadingMore") : ut("ui.loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Вид «Проходження»: все прохождения среза той же версии, что и графики, — страницами по 50 */
export function ResponsesView({ data, slice }: { data: SurveyAnalytics; slice: AnalyticsSlice }) {
  const { ut } = useLang();
  const pages = useResponsePages(data.surveyId, { ...slice, versionId: data.versionId ?? undefined });
  return (
    <Panel title={ut("an.tabResponses")} icon={<Ic.list />} count={data.started} flush>
      <ResponsesTable pages={pages} surveyId={data.surveyId} />
    </Panel>
  );
}
