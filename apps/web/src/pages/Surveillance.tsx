import { useEffect, useState } from "react";
import type { SurveyListItem } from "@quizzy/shared";
import { api } from "../api";
import { Chart } from "../charts";
import { Loading, PageHead } from "../ui";

/**
 * Эпиднадзор: p-карты доли высокого риска по неделям и подразделениям.
 *
 * Читается как контрольная карта производства: точка выше верхнего предела —
 * всплеск, серия из 8 точек над центром — устойчивый сдвиг. Оба сигнала
 * подсвечены; недели с горсткой прохождений сигналов не дают — карта из
 * шума хуже её отсутствия.
 */
export default function Surveillance() {
  const [surveys, setSurveys] = useState<SurveyListItem[]>([]);
  const [surveyId, setSurveyId] = useState("");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.surveillance>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.surveys().then((rows) => {
      const withData = rows.filter((r) => r.responseCount >= 10 && !r.isDemo);
      const pick = withData.length ? withData : rows.filter((r) => r.responseCount >= 10);
      setSurveys(pick);
      if (pick[0]) setSurveyId(pick[0].id);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!surveyId) return;
    setData(null);
    api.surveillance(surveyId).then(setData).catch((e) => setError(e.message));
  }, [surveyId]);

  const signals = data?.series.flatMap((s) =>
    s.weeks.filter((w) => w.beyondLimits || w.runSignal).map((w) => ({ unit: s.unit, ...w })),
  ) ?? [];

  return (
    <>
      <PageHead
        title="Надзор"
        sub="Контрольные карты: доля прохождений с высоким риском по неделям"
        actions={
          <select value={surveyId} onChange={(e) => setSurveyId(e.target.value)} style={{ width: 300 }}>
            {surveys.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        }
      />

      {error ? <p className="error">{error}</p> : null}
      {!data && !error ? <Loading /> : null}

      {signals.length ? (
        <div className="card" style={{ borderColor: "var(--sev-severe)" }}>
          <h2>Сигналы: {signals.length}</h2>
          {signals.slice(0, 6).map((s, i) => (
            <p key={i} style={{ margin: "4px 0", fontSize: 13 }}>
              <strong>{s.unit ?? "вся выборка"}</strong> · неделя {s.week}:{" "}
              {Math.round(s.p * 100)}% высокого риска ({s.x} из {s.n})
              {s.beyondLimits ? " — выше контрольного предела" : ""}
              {s.runSignal ? " — устойчивый сдвиг (8 недель по одну сторону)" : ""}
            </p>
          ))}
        </div>
      ) : data ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>Сигналов нет — доли в пределах ожидаемого разброса.</p></div>
      ) : null}

      {data?.series.map((s) => (
        <Chart
          key={s.unit ?? "__all__"}
          title={s.unit ?? "Вся выборка"}
          hint={`центр ${Math.round(s.center * 100)}% · недели с n<${data.minWeekN} без сигналов`}
        >
          <PBars series={s} />
        </Chart>
      ))}
    </>
  );
}

function PBars({ series }: { series: NonNullable<Awaited<ReturnType<typeof api.surveillance>>>["series"][number] }) {
  const max = Math.max(...series.weeks.map((w) => w.ucl), 0.05);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 140 }}>
      {series.weeks.map((w) => {
        const alarm = w.beyondLimits || w.runSignal;
        return (
          <div key={w.week} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}
            title={`${w.week}: ${w.x} из ${w.n} (${Math.round(w.p * 100)}%), предел ${Math.round(w.ucl * 100)}%`}>
            <div style={{ position: "relative", width: "100%", maxWidth: 26, height: 110, background: "var(--surface-2)", borderRadius: 4 }}>
              {/* контрольный предел недели */}
              <i style={{ position: "absolute", left: 0, right: 0, bottom: `${(w.ucl / max) * 100}%`, borderTop: "2px dashed var(--sev-mild)", display: "block" }} />
              <i style={{
                position: "absolute", left: 2, right: 2, bottom: 0,
                height: `${Math.max(2, (w.p / max) * 100)}%`,
                background: alarm ? "var(--sev-severe)" : "var(--s1)",
                borderRadius: 3, display: "block",
              }} />
            </div>
            <span className="muted" style={{ fontSize: 9 }}>{w.week.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
