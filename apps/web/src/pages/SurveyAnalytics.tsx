import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Battery, Severity as BandSeverity, SurveyAnalytics, SurveyFull } from "@quizzy/shared";
import { api } from "../api";
import { BandTrend, HBars, SeverityMeter, ShareBar, TimeColumns } from "../charts/clinical";
import { duration } from "../format";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Screen } from "../ui";
import { cx } from "../ui/cx";
import { Ic } from "../ui/icons";
import { Panel, SideLayout } from "../ui/layout";
import { Popover } from "../ui/Popover";
import { KV, TextAction } from "../ui/records";
import { ButtonLink, Segmented, SeverityTag, Tag, type Severity } from "../ui/primitives";
import { Callout, Empty } from "../ui/states";
import { useResource } from "../useResource";
import { testsHref } from "./analytics/tests/model";
import { Mi } from "./methods/icons";
import { MethodPage } from "./methods/MethodPage";
import { fixedIn, shortDate, shortDateTime, splitCode, topLosses, weeklyCounts } from "./methods/model";
import { num, useCount } from "./methods/useCount";

/*
 * Огляд методики — UI 3, «Виразна» (methods-method), адрес /surveys/:id.
 *
 * Раньше адрес перенаправлял во вкладку «Тести» аналитики. Обзор собран из
 * того, что сервер уже отдаёт (api.analytics — за весь час, без среза; наборы
 * — api.batteries), и стоит в той же рамке методики, что «Доступ» и
 * «Норми»; полная аналитика со срезами (пациент, группа, период, версия) —
 * по-прежнему во вкладке «Тести», куда ведут «Шкали … Проходження» и
 * «Детальна аналітика».
 *
 * Чего на обзоре нет из макета, потому что этого нет в данных: «перше й
 * останнє проходження» рядом с «усіма» (сервер не отдаёт распределение по
 * первым и последним замерам), панель «Критичний пункт» (сигналы и время
 * разбора по методике сервер не считает), правила аналитики в «Де
 * використовується» (их список не связан с методикой).
 */

export default function SurveyOverview() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const res = useResource(
    async () => {
      const [survey, analytics, groups, folders, batteries] = await Promise.all([
        api.survey(id!),
        api.analytics(id!).catch(() => null),
        api.groups().catch(() => null),
        api.surveyFolders().catch(() => null),
        api.batteries().catch(() => null),
      ]);
      return { survey, analytics, groups, folders, batteries };
    },
    [id],
    { enabled: !!id },
  );
  return (
    <Screen res={res}>
      {({ survey, analytics, groups, folders, batteries }) => (
        <MethodPage
          survey={survey}
          groups={groups}
          folders={folders}
          tab="overview"
          counts={{
            responses: analytics?.completed ?? null,
            quality: analytics ? analytics.quality.filter((q) => q.flagged).length || null : null,
          }}
          responseCount={analytics?.completed ?? null}
          leadAction={
            !survey.archivedAt && survey.status === "published" ? (
              <ButtonLink to={`/surveys/${survey.id}/administer`} variant="secondary">
                <Ic.keyboard size={15} />
                {ut("mc.menuAdminister")}
              </ButtonLink>
            ) : null
          }
        >
          <Overview survey={survey} data={analytics} batteries={batteries} />
        </MethodPage>
      )}
    </Screen>
  );
}

const BAND_LEVEL: Record<BandSeverity, Severity> = { none: "none", mild: "mild", moderate: "moderate", severe: "severe" };

function Overview({ survey, data, batteries }: { survey: SurveyFull; data: SurveyAnalytics | null; batteries: Battery[] | null }) {
  const { ut } = useLang();
  const { fmt1, fmt2 } = useFmt();
  const count = useCount();
  const clinical = useMemo(() => (data?.scales ?? []).filter((s) => s.kind === "clinical"), [data]);
  const [scaleId, setScaleId] = useState<string | null>(null);
  const scale = clinical.find((s) => s.scaleId === scaleId) ?? clinical[0] ?? null;
  const fullScale = scale ? survey.scales.find((s) => s.code === scale.code) : survey.scales.find((s) => s.kind === "clinical");
  const usedIn = (batteries ?? []).filter((b) => b.items.some((i) => i.surveyId === survey.id));

  const side = (
    <>
      <AboutPanel survey={survey} data={data} />
      {fullScale && fullScale.bands.length ? <BandsPanel survey={survey} scale={fullScale} current={scale ? bandOf(scale, scale.median) : null} /> : null}
      {data && data.versions.length ? <VersionsPanel survey={survey} data={data} /> : null}
    </>
  );

  if (!data) {
    return (
      <SideLayout side={side}>
        <Panel>
          <Empty title={ut("mc.ovNoAnalytics")} hint={ut("mc.ovNoAnalyticsHint")} />
        </Panel>
      </SideLayout>
    );
  }

  const weeks = weeklyCounts(data.timeline, 14);
  const trend = scale ? (data.scaleTimeline.find((t) => t.scaleId === scale.scaleId)?.weeks ?? []) : [];
  /* средний балл — в том же окне 14 недель, что и столбцы: два графика рядом читаются как одна ось времени */
  const firstWeek = weeks[0]?.week ?? "";
  const trendPoints = trend
    .filter((w) => w.mean !== null && w.week.slice(0, 10) >= firstWeek)
    .map((w) => ({ key: w.week, t: new Date(`${w.week.slice(0, 10)}T00:00:00`).getTime(), label: shortDate(w.week), value: w.mean! }));
  const rungs = scale ? scale.bands.map((b) => ({ min: b.min, max: b.max, label: b.label, severity: b.severity })) : [];
  const losses = topLosses(data.dropOff, 5);
  const lostTotal = Math.max(0, data.started - data.completed);

  return (
    <SideLayout side={side}>
      <div className="flex flex-wrap items-center gap-2">
        {clinical.length > 1 ? (
          <Segmented
            label={ut("mc.nmScale")}
            value={scale?.scaleId ?? ""}
            onChange={(k) => setScaleId(k)}
            items={clinical.slice(0, 6).map((s) => ({ key: s.scaleId, label: s.code }))}
          />
        ) : null}
        <span className="text-small text-muted">{ut("mc.ovAllTime")}</span>
        <span className="ml-auto flex items-center gap-3">
          {data.inProgressNow.length ? (
            <Popover
              title={ut("an.inProgressNow")}
              note={String(data.inProgressNow.length)}
              content={
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small">
                  {data.inProgressNow.map((p, i) => (
                    <li key={i}>
                      <b className="text-text">{p.userName ?? ut("an.anon")}</b>{" "}
                      <span className="text-muted">{`${p.answered} ${ut("an.answeredAbbr")}, ${shortDateTime(p.startedAt)}`}</span>
                    </li>
                  ))}
                </ul>
              }
            >
              <span tabIndex={0} className="inline-flex items-center gap-1.5 text-small font-semibold text-text-2">
                <Mi.radio size={15} className="text-good" />
                {`${ut("an.inProgressNow")} ${data.inProgressNow.length}`}
              </span>
            </Popover>
          ) : null}
          <TextAction to={testsHref(survey.id)}>{ut("mc.ovDetails")}</TextAction>
        </span>
      </div>

      {scale ? (
        <Panel title={ut("mc.ovState")} icon={<Mi.barsStacked />} sub={ut("mc.ovStateSub")}>
          {scale.bands.some((b) => b.count > 0) ? (
            <ShareBar
              label={`${scale.code}, ${scale.title}`}
              parts={scale.bands.map((b, i) => ({ key: `${i}`, label: b.label, value: b.count, severity: b.severity }))}
            />
          ) : (
            <p className="m-0 text-small text-muted">{ut("ant.bandsEmpty")}</p>
          )}
          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-6 border-t border-divider pt-4 max-[1180px]:grid-cols-1">
            <div className="min-w-0">
              <b className="mb-2 block text-small font-extrabold text-text">{ut("mc.ovMedianOn")}</b>
              <SeverityMeter
                rungs={rungs}
                value={scale.median}
                max={scale.maxPossible}
                label={`${scale.code}: ${fmt1(scale.median)}`}
              />
            </div>
            <KV
              w={110}
              rows={[
                [ut("mc.ovMean"), <b key="m">{fmt1(scale.average)}</b>],
                [
                  ut("mc.ovMedian"),
                  <span key="md" className="inline-flex items-center gap-2">
                    <b>{fmt1(scale.median)}</b>
                    {bandOf(scale, scale.median) ? (
                      <SeverityTag small level={BAND_LEVEL[bandOf(scale, scale.median)!.severity]}>
                        {bandOf(scale, scale.median)!.label}
                      </SeverityTag>
                    ) : null}
                  </span>,
                ],
                [ut("mc.ovQuartiles"), <b key="q">{`${fmt1(scale.p25)}–${fmt1(scale.p75)}`}</b>],
                ...(scale.measurement
                  ? ([[ut("mc.ovError"), ut("mc.ovErrorText").replace("{n}", fmt1(scale.measurement.mdc95))]] as [string, string][])
                  : []),
              ]}
            />
          </div>
          {scale.reliability ? (
            <div className="mt-4">
              <Callout
                kind="neutral"
                icon={<Mi.sigma size={16} />}
                title={ut(scale.reliability.alpha >= 0.8 ? "ant.alphaHigh" : scale.reliability.alpha >= 0.7 ? "ant.alphaOk" : "ant.alphaLow")}
                actions={<TextAction to={testsHref(survey.id, { view: "scales" })}>{ut("ant.itemsTable")}</TextAction>}
              >
                {ut("mc.ovAlpha")
                  .replace("{alpha}", fmt2(scale.reliability.alpha))
                  .replace("{items}", num(scale.reliability.itemCount))
                  .replace("{n}", num(scale.reliability.sampleN))}
                {scale.floorCeiling && scale.floorCeiling.floorPercent !== null && scale.floorCeiling.ceilingPercent !== null
                  ? ` ${ut("mc.ovFloorCeiling").replace("{floor}", fmt1(scale.floorCeiling.floorPercent)).replace("{ceiling}", fmt1(scale.floorCeiling.ceilingPercent))}`
                  : ""}
              </Callout>
            </div>
          ) : null}
        </Panel>
      ) : null}

      <Panel title={ut("mc.ovWeeks")} icon={<Ic.chart />} sub={ut("mc.ovWeeksSub")}>
        <p className="m-0 text-small text-text-2">
          {ut("mc.ovWeeksText")
            .replace("{completed}", num(data.completed))
            .replace("{started}", num(data.started))
            .replace("{people}", count(data.respondentCount, "people"))}
        </p>
        <div className={cx("mt-3 grid gap-5", trendPoints.length > 1 && scale ? "grid-cols-2 max-[1180px]:grid-cols-1" : "grid-cols-1")}>
          <div className="min-w-0">
            <b className="mb-1 block text-small font-extrabold text-text">{ut("mc.ovPerWeek")}</b>
            <TimeColumns
              label={ut("mc.ovPerWeek")}
              height={200}
              columns={weeks.map((w) => ({ key: w.week, label: shortDate(w.week), value: w.count, partial: w.partial, tip: ut("mc.ovWeekOf").replace("{date}", shortDate(w.week)) }))}
            />
          </div>
          {trendPoints.length > 1 && scale ? (
            <div className="min-w-0">
              <b className="mb-1 block text-small font-extrabold text-text">{ut("mc.ovMeanWeekly")}</b>
              <BandTrend points={trendPoints} rungs={rungs} max={scale.maxPossible} sem={scale.measurement?.sem ?? null} height={200} label={ut("mc.ovMeanWeekly")} />
            </div>
          ) : null}
        </div>
        <p className="m-0 mt-2 text-small text-muted">{ut("mc.ovWeeksNote")}</p>
      </Panel>

      <Panel
        title={ut("an.dropOff")}
        icon={<Mi.route />}
        sub={ut("mc.ovLostSub")}
        actions={<TextAction to={testsHref(survey.id, { view: "questions" })}>{ut("mc.tabItems")}</TextAction>}
      >
        <p className="m-0 mb-3 text-small text-text-2">
          {ut("mc.ovLostText")
            .replace("{rate}", fmt1(data.completionRate))
            .replace("{lost}", num(lostTotal))
            .replace("{started}", num(data.started))}
        </p>
        {losses.length ? (
          <HBars
            items={losses.map((r, i) => ({
              key: r.questionId,
              label: `${r.position + 1}. ${r.title}`,
              value: r.lost,
              text: count(r.lost, "people"),
              strong: i === 0,
            }))}
          />
        ) : (
          <p className="m-0 text-small text-muted">{ut("ant.noDropOff")}</p>
        )}
      </Panel>

      {usedIn.length ? (
        <Panel title={ut("mc.ovUsedIn")} icon={<Ic.layers />} sub={ut("mc.ovUsedInSub")}>
          <ul className="m-0 list-none p-0">
            {usedIn.map((b) => (
              <li key={b.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-divider py-2 first:border-t-0 first:pt-0">
                <span className="grid size-7 place-items-center rounded-[9px] bg-sunk text-muted">
                  <Ic.layers size={15} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <Link to={`/batteries?id=${b.id}`} className="truncate text-body text-text no-underline hover:underline">
                    {`«${b.title}»`}
                  </Link>
                  <small className="text-caption text-muted">{b.archived ? ut("bat.archived") : ut("mc.ovActiveAssignments")}</small>
                </span>
                <b className="text-body font-extrabold tabular-nums text-text">{num(b.activeAssignments)}</b>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </SideLayout>
  );
}

/* дробные — на языке экрана (fixedIn): одна цифра без хвостовых нулей, альфа — две */
function useFmt() {
  const { lang } = useLang();
  return { fmt1: (v: number) => fixedIn(lang, v, 1, false), fmt2: (v: number) => fixedIn(lang, v, 2) };
}

/** Полоса, в которую попадает значение */
function bandOf(scale: SurveyAnalytics["scales"][number], v: number) {
  return scale.bands.find((b) => v >= b.min && v <= b.max) ?? null;
}

function AboutPanel({ survey, data }: { survey: SurveyFull; data: SurveyAnalytics | null }) {
  const { ut } = useLang();
  const { fmt1 } = useFmt();
  const count = useCount();
  const rows: [string, string][] = [
    [ut("mc.peekWho"), survey.administration === "clinician" ? ut("bt.byClinician") : ut("mc.bySelf")],
    [ut("mc.peekVisibility"), survey.visibility === "restricted" ? ut("mc.visRestricted") : ut("mc.visPublic")],
    [ut("mc.ovScoring"), survey.scoringEnabled ? count(survey.scales.length, "scales") : ut("cat.scoringOff")],
    [ut("mc.ovTimeLimit"), survey.timeLimitSec ? duration(survey.timeLimitSec * 1000) : ut("mc.ovNone")],
  ];
  if (data && data.medianDurationMs > 0) rows.push([ut("an.medianTime"), duration(data.medianDurationMs)]);
  if (data) rows.push([ut("mc.ovTooFast"), ut("mc.ovTooFastText").replace("{s}", fmt1(data.tooFastThresholdMs / 1000))]);
  rows.push([
    ut("mc.ovEscalation"),
    survey.alertEscalateMinutes ? ut("mc.ovEscalationText").replace("{n}", String(survey.alertEscalateMinutes)) : ut("mc.ovNone"),
  ]);
  rows.push([ut("mc.ovRetake"), survey.allowRetake ? ut("mc.ovYes") : ut("mc.ovNo")]);
  rows.push([ut("mc.ovPatientSees"), survey.showResultsToPatient ? ut("mc.ovOwnDynamics") : ut("mc.ovNothing")]);
  return (
    <Panel
      title={ut("mc.ovAbout")}
      icon={<Ic.info />}
      actions={<TextAction to={`/constructor/${survey.id}`}>{ut("mc.ovSettings")}</TextAction>}
    >
      {survey.description ? <p className="m-0 mb-3 text-body text-text-2">{survey.description}</p> : null}
      <div className={cx(survey.description && "border-t border-divider pt-3")}>
        <KV w={128} rows={rows} />
      </div>
    </Panel>
  );
}

function BandsPanel({
  survey,
  scale,
  current,
}: {
  survey: SurveyFull;
  scale: SurveyFull["scales"][number];
  current: { label: string } | null;
}) {
  const { ut } = useLang();
  const bands = [...scale.bands].sort((a, b) => a.minScore - b.minScore);
  return (
    <Panel
      title={ut("mc.ovBands")}
      icon={<ShellIcon name="ruler" />}
      sub={survey.scales.length > 1 ? scale.code : undefined}
      actions={<TextAction to={`/constructor/${survey.id}`}>{ut("cl.editAction")}</TextAction>}
    >
      <ul className="m-0 list-none p-0">
        {bands.map((b) => {
          const on = current?.label === b.label;
          return (
            <li
              key={b.id}
              className={cx(
                "grid grid-cols-[52px_minmax(0,1fr)] items-start gap-x-2.5 border-t border-divider py-2.5 first:border-t-0 first:pt-0.5",
                on && "-mx-2.5 rounded-[12px] border-transparent bg-violet-tint px-2.5 first:pt-2.5",
              )}
            >
              <span className="text-small font-extrabold leading-6 tabular-nums text-text-2">{`${b.minScore}–${b.maxScore}`}</span>
              <span className="min-w-0">
                <SeverityTag small level={BAND_LEVEL[b.severity]}>
                  {b.label}
                </SeverityTag>
                {b.recommendation || b.description ? (
                  <p className="m-0 mt-1 text-caption text-text-2">{b.recommendation ?? b.description}</p>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {current ? <p className="m-0 mt-2 text-caption text-muted">{ut("mc.ovBandsNote")}</p> : null}
    </Panel>
  );
}

function VersionsPanel({ survey, data }: { survey: SurveyFull; data: SurveyAnalytics }) {
  const { ut } = useLang();
  const versions = [...data.versions].sort((a, b) => b.version - a.version);
  const { code, name } = splitCode(survey.title);
  return (
    <Panel
      title={ut("mc.ovVersions")}
      icon={<Mi.gitBranch />}
      actions={versions.length > 1 ? <TextAction to={testsHref(survey.id)}>{ut("mc.ovCompare")}</TextAction> : undefined}
    >
      <ul className="m-0 list-none p-0" aria-label={code ?? name}>
        {versions.map((v) => (
          <li key={v.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-divider py-2 first:border-t-0 first:pt-0">
            <span
              className={cx(
                "grid size-7 place-items-center rounded-[9px] text-caption font-extrabold",
                v.version === survey.versionNumber ? "bg-violet text-onfill" : "bg-sunk text-text-2",
              )}
            >
              {v.version}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2">
                {ut("ant.versionN").replace("{n}", String(v.version))}
                {v.version === survey.versionNumber ? <Tag tone="good">{ut("mc.ovCurrent")}</Tag> : null}
              </span>
              {v.note ? <small className="truncate text-caption text-muted">{v.note}</small> : null}
            </span>
            <span className="whitespace-nowrap text-small text-muted">
              <b className="font-extrabold tabular-nums text-text">{num(v.responseCount)}</b> {ut("mc.ovResp")}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
