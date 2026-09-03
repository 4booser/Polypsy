import { useEffect, useState } from "react";
import { api } from "../api";
import { Chart } from "../charts";
import { day } from "../format";
import { Loading } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Select } from "../ui/primitives";
import { useResource } from "../useResource";
import { useLang } from "../lang";

/**
 * Эпиднадзор: p-карты доли высокого риска по неделям и подразделениям.
 *
 * Читается как контрольная карта производства: точка выше верхнего предела —
 * всплеск, серия из 8 точек над центром — устойчивый сдвиг. Оба сигнала
 * подсвечены; недели с горсткой прохождений сигналов не дают — карта из
 * шума хуже её отсутствия.
 */
export default function Surveillance() {
  const { ut } = useLang();
  const [surveyId, setSurveyId] = useState("");

  /*
   * Список методик — тоже через хук. Отбираем те, где данных хватает на
   * контрольную карту: карта из горстки точек хуже её отсутствия.
   */
  const list = useResource(async () => {
    const rows = await api.surveys();
    const withData = rows.filter((r) => r.responseCount >= 10 && !r.isDemo);
    return withData.length ? withData : rows.filter((r) => r.responseCount >= 10);
  }, []);
  const surveys = list.data ?? [];

  useEffect(() => {
    if (!surveyId && surveys[0]) setSurveyId(surveys[0].id);
  }, [surveys, surveyId]);
  /*
   * Через useResource: раньше data сбрасывалась вручную перед запросом —
   * экран моргал пустотой, а ответ по прежней методике всё равно мог
   * прийти позже и подставить чужие данные.
   */
  const res = useResource(() => api.surveillance(surveyId!), [surveyId], { enabled: !!surveyId });
  const { data } = res;
  const error = res.error ?? list.error;

  const signals = data?.series.flatMap((s) =>
    s.weeks.filter((w) => w.beyondLimits || w.runSignal).map((w) => ({ unit: s.unit, ...w })),
  ) ?? [];

  return (
    <Page
      title={ut("sv.title")}
      sub={ut("sv.sub")}
      toolbar={
        <Select value={surveyId} onChange={(e) => setSurveyId(e.target.value)} className="max-w-[300px]">
          {surveys.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </Select>
      }
    >
      {error ? <p className="text-danger">{error}</p> : null}
      {!data && !error ? <Loading /> : null}

      {signals.length ? (
        <Panel title={`${ut("sv.signals")}: ${signals.length}`} className="mb-4 border border-[var(--sev-severe)]">
          {signals.slice(0, 6).map((s, i) => (
            <p key={i} className="my-1 text-small">
              <strong>{s.unit ?? ut("sv.wholeSample")}</strong> · {ut("sv.week")} {s.week}:{" "}
              {Math.round(s.p * 100)}% {ut("sv.highRiskPct")} ({s.x} {ut("an.of")} {s.n})
              {s.beyondLimits ? ` ${ut("sv.beyondLimit")}` : ""}
              {s.runSignal ? ` ${ut("sv.runSignalNote")}` : ""}
            </p>
          ))}
        </Panel>
      ) : data ? (
        <Panel className="mb-4">
          <p className="m-0 text-muted">{ut("sv.noSignals")}</p>
        </Panel>
      ) : null}

      {data?.series.map((s) => (
        <Chart
          key={s.unit ?? "__all__"}
          title={s.unit ?? ut("sv.wholeSample")}
          hint={`${ut("sv.center")} ${Math.round(s.center * 100)}% · ${ut("sv.weeksBelowN")}${data.minWeekN} ${ut("sv.noSignalsSuffix")}`}
        >
          <PBars series={s} />
        </Chart>
      ))}
    </Page>
  );
}

function PBars({ series }: { series: NonNullable<Awaited<ReturnType<typeof api.surveillance>>>["series"][number] }) {
  const { ut } = useLang();

  /*
   * Контрольная карта по одной неделе — не карта.
   *
   * Смысл карты в том, чтобы видеть, выходит ли доля за свои пределы со
   * временем. По одной точке этого не видно ни при каких обстоятельствах, а
   * столбик посреди пустого поля выглядит как полноценный график и
   * приглашает делать выводы. Пишем число словами и говорим, чего не хватает.
   */
  if (series.weeks.length < 2) {
    const only = series.weeks[0];
    return (
      <p className="m-0 py-6 text-caption text-muted">
        {only
          ? `${Math.round(only.p * 100)}% (${only.x} ${ut("an.of")} ${only.n}) · ${ut("sv.needMoreWeeks")}`
          : ut("sv.noWeeks")}
      </p>
    );
  }

  const max = Math.max(...series.weeks.map((w) => w.ucl), 0.05);
  return (
    <div className="flex h-[140px] items-end gap-1">
      {series.weeks.map((w) => {
        const alarm = w.beyondLimits || w.runSignal;
        return (
          <div
            key={w.week}
            className="flex flex-1 flex-col items-center gap-0.5"
            title={`${w.week}: ${w.x} ${ut("an.of")} ${w.n} (${Math.round(w.p * 100)}%), ${ut("sv.limitLabel")} ${Math.round(w.ucl * 100)}%`}
          >
            <div className="relative h-[110px] w-full max-w-[26px] rounded bg-surface-2">
              {/* контрольный предел недели */}
              <i
                className="absolute inset-x-0 block border-t-2 border-dashed border-[var(--sev-mild)]"
                style={{ bottom: `${(w.ucl / max) * 100}%` }}
              />
              <i
                className="absolute bottom-0 left-0.5 right-0.5 block rounded-[3px]"
                style={{
                  height: `${Math.max(2, (w.p / max) * 100)}%`,
                  background: alarm ? "var(--sev-severe)" : "var(--s1)",
                }}
              />
            </div>
            <span className="text-[9px] text-muted">{day(`${w.week}T00:00:00`)}</span>
          </div>
        );
      })}
    </div>
  );
}
