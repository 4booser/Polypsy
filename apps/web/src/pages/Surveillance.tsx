import { useEffect, useState } from "react";
import { api } from "../api";
import { Chart } from "../charts";
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
              <strong>{s.unit ?? "вся выборка"}</strong> · неделя {s.week}:{" "}
              {Math.round(s.p * 100)}% высокого риска ({s.x} из {s.n})
              {s.beyondLimits ? " — выше контрольного предела" : ""}
              {s.runSignal ? " — устойчивый сдвиг (8 недель по одну сторону)" : ""}
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
          hint={`центр ${Math.round(s.center * 100)}% · недели с n<${data.minWeekN} без сигналов`}
        >
          <PBars series={s} />
        </Chart>
      ))}
    </Page>
  );
}

function PBars({ series }: { series: NonNullable<Awaited<ReturnType<typeof api.surveillance>>>["series"][number] }) {
  const max = Math.max(...series.weeks.map((w) => w.ucl), 0.05);
  return (
    <div className="flex h-[140px] items-end gap-1">
      {series.weeks.map((w) => {
        const alarm = w.beyondLimits || w.runSignal;
        return (
          <div
            key={w.week}
            className="flex flex-1 flex-col items-center gap-0.5"
            title={`${w.week}: ${w.x} из ${w.n} (${Math.round(w.p * 100)}%), предел ${Math.round(w.ucl * 100)}%`}
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
            <span className="text-[9px] text-muted">{w.week.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
