import { useMemo, useState } from "react";
import { t, type PatientGroupSurvey, type ScaleAnalytics, type SurveyAnalytics } from "@quizzy/shared";
import { api } from "../../api";
import { BandTrend, ShareBar } from "../../charts/clinical";
import { useLang } from "../../lang";
import { Loading } from "../../ui";
import { Panel } from "../../ui/layout";
import { Segmented, SeverityTag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { Pi } from "./icons";
import { fill, shortDate, surveyCode } from "./model";

/*
 * «Стан групи» — как группа идёт по шкале её методики.
 *
 * Источник — аналитика методики со срезом по группе
 * (GET /api/analytics/surveys/:id?patientGroup=…): среднее итоговое значение
 * шкалы по неделям (scaleTimeline) и сколько прохождений группы легло в каждую
 * полосу. Неделя с числом прохождений ниже порога малых ячеек приходит без
 * среднего — точки на графике у неё нет, а не ноль: ноль на лестнице тяжести
 * читался бы как «всем хорошо».
 *
 * Средних «за месяц» и «надёжного улучшения у N из M» макета здесь нет:
 * аналитика считает неделями и по прохождениям, а не по людям, и выдумывать
 * помесячную разбивку или достоверность сдвига по группе экран не будет.
 *
 * Панель видна только с правом analytics.read (решает экран): без него
 * маршрут ответил бы отказом в журнал доступа.
 */

/** Содержательная шкала с полосами — та, по которой есть что рисовать на лестнице */
function mainScale(a: SurveyAnalytics): ScaleAnalytics | null {
  const content = a.scales.filter((s) => s.kind !== "validity");
  return content.find((s) => s.bands.length > 0) ?? content[0] ?? null;
}

export function GroupState({ groupId, surveys }: { groupId: string; surveys: PatientGroupSurvey[] }) {
  const { ut, lang } = useLang();
  const [pick, setPick] = useState(surveys[0]?.surveyId ?? "");
  const surveyId = surveys.some((s) => s.surveyId === pick) ? pick : (surveys[0]?.surveyId ?? "");
  const res = useResource(() => api.analytics(surveyId, undefined, { patientGroup: groupId }), [surveyId, groupId], {
    enabled: !!surveyId,
  });
  const a = res.data;
  const scale = a ? mainScale(a) : null;

  const series = useMemo(() => {
    if (!a || !scale) return [];
    const weeks = a.scaleTimeline.find((s) => s.scaleId === scale.scaleId)?.weeks ?? [];
    return weeks
      .filter((w): w is { week: string; n: number; mean: number } => w.mean !== null)
      .map((w) => {
        const band = scale.bands.find((b) => w.mean >= b.min && w.mean <= b.max) ?? null;
        return {
          key: w.week,
          t: new Date(w.week).getTime(),
          label: shortDate(w.week),
          value: Math.round(w.mean * 10) / 10,
          band: band ? { label: band.label, severity: band.severity } : null,
        };
      });
  }, [a, scale]);

  const code = (s: PatientGroupSurvey) => surveyCode(t(s.title, lang));
  const last = series[series.length - 1];
  const first = series[0];
  const delta = last && first && series.length > 1 ? Math.round((last.value - first.value) * 10) / 10 : null;

  return (
    <Panel
      title={ut("pg2.state")}
      icon={<Pi.chartLine />}
      sub={scale ? fill(ut("pg2.stateSub"), { code: scale.title || scale.code }) : undefined}
      actions={
        surveys.length > 1 ? (
          <Segmented
            label={ut("pg.test")}
            items={surveys.slice(0, 4).map((s) => ({ key: s.surveyId, label: code(s) }))}
            value={surveyId}
            onChange={setPick}
          />
        ) : null
      }
    >
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} bare />
      ) : !a ? (
        <Loading rows={4} bare />
      ) : !scale || series.length === 0 ? (
        <p className="m-0 py-6 text-small text-muted">{ut("pg2.stateEmpty")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-stat font-extrabold leading-none tracking-[-0.03em] tabular-nums text-text">{last!.value}</span>
            <span className="text-small text-muted">
              {fill(ut("pg2.stateOf"), { max: scale.maxPossible })}
            </span>
            {last!.band ? (
              <SeverityTag level={last!.band.severity} small>
                {last!.band.label}
              </SeverityTag>
            ) : null}
            {delta !== null ? (
              <span className="ml-auto flex items-baseline gap-1.5 text-small text-muted">
                <b className="text-[14px] font-extrabold tabular-nums text-text">
                  {delta > 0 ? `+${delta}` : String(delta).replace("-", "−")}
                </b>
                {fill(ut("pg2.stateSince"), { date: first!.label })}
              </span>
            ) : null}
          </div>
          <div className="mt-3">
            <BandTrend
              points={series}
              rungs={scale.bands.map((b) => ({ min: b.min, max: b.max, label: b.label, severity: b.severity }))}
              max={scale.maxPossible}
              height={220}
              label={fill(ut("pg2.stateSub"), { code: scale.title || scale.code })}
            />
          </div>
          {scale.bands.length ? (
            <div className="mt-4 border-t border-divider pt-3">
              <span className="mb-2 block text-caption font-bold text-muted">
                {fill(ut("pg2.stateBands"), { n: a.completed })}
              </span>
              <ShareBar
                label={ut("pg2.stateBandsLabel")}
                parts={scale.bands.map((b) => ({ key: b.label, label: b.label, value: b.count, severity: b.severity }))}
              />
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
