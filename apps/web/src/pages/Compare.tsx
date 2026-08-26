import { useEffect, useState } from "react";
import type { CohortBy, ComparisonResult, CorrelationMatrix, SurveyListItem } from "@quizzy/shared";
import { api } from "../api";
import { Chart } from "../charts";
import { SERIES, severityColor } from "../format";
import { Empty, Loading, PageHead } from "../ui";

const BY_LABEL: [CohortBy, string][] = [
  ["unit", "Подразделение"],
  ["sex", "Пол"],
  ["ageGroup", "Возраст"],
  ["rank", "Звание"],
  ["month", "Месяц"],
];

/**
 * Сравнение когорт и связи между субшкалами.
 *
 * Обе картины отвечают на вопросы, которых нет в аналитике одной методики:
 * «отличается ли отделение от отделения» и «что с чем связано».
 */
export default function Compare() {
  const [surveys, setSurveys] = useState<SurveyListItem[]>([]);
  const [surveyId, setSurveyId] = useState("");
  const [by, setBy] = useState<CohortBy>("unit");
  const [data, setData] = useState<ComparisonResult | null>(null);
  const [corr, setCorr] = useState<CorrelationMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .surveys()
      .then((s) => {
        const withData = s.filter((x) => x.responseCount > 0);
        setSurveys(withData);
        if (withData[0]) setSurveyId(withData[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!surveyId) return;
    setData(null);
    setCorr(null);
    Promise.all([api.compare(surveyId, by), api.correlations(surveyId)])
      .then(([c, m]) => {
        setData(c);
        setCorr(m);
      })
      .catch((e) => setError(e.message));
  }, [surveyId, by]);

  return (
    <>
      <PageHead
        title="Сравнение"
        sub="Когорты по паспортной части и связи между субшкалами"
        actions={
          <>
            <select value={surveyId} onChange={(e) => setSurveyId(e.target.value)} style={{ width: 300 }}>
              {surveys.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
            <div className="row tight">
              {BY_LABEL.map(([v, label]) => (
                <button key={v} className={`chip ${by === v ? "active" : ""}`} onClick={() => setBy(v)}>
                  {label}
                </button>
              ))}
            </div>
          </>
        }
      />

      {error ? <p className="error">{error}</p> : null}
      {!data ? <Loading /> : null}

      {data && data.scales.every((s) => s.cohorts.length === 0) ? (
        <Empty
          title="Сравнивать нечего"
          hint={`Ни одна когорта по признаку «${BY_LABEL.find(([v]) => v === by)?.[1]}» не набрала трёх прохождений. Возможно, поле не заполнено у пациентов.`}
        />
      ) : null}

      {data?.unclassified ? (
        <div className="card">
          <p style={{ margin: 0 }} className="muted">
            {data.unclassified} прохождений не попало ни в одну когорту: соответствующее поле
            паспортной части не заполнено. Они не учтены — растворять их в «прочих» значило бы
            искажать сравнение.
          </p>
        </div>
      ) : null}

      {data?.scales.map((scale) => {
        if (!scale.cohorts.length) return null;
        const flip = standardizationFlips(scale.cohorts);
        return (
          <Chart key={scale.scaleId} title={scale.title} hint={scaleHint(scale)}>
            {flip ? (
              <p className="hint warn" style={{ marginTop: 0 }}>
                Стандартизация по полу и возрасту меняет порядок групп: сырая разница
                объяснялась структурой когорт, а не состоянием. Сравнивайте
                стандартизованные доли.
              </p>
            ) : null}
            <CohortBars scale={scale} />
          </Chart>
        );
      })}

      {corr && corr.codes.length >= 2 ? (
        <Chart
          title="Связи между субшкалами"
          hint={`Коэффициент Пирсона. Считается только там, где есть оба балла, и не считается при выборке меньше ${corr.minSample}`}
        >
          <CorrelationGrid matrix={corr} />
        </Chart>
      ) : null}
    </>
  );
}

/**
 * Границы оси зависят от единиц: доля живёт в 0–1, T-балл около 100, стен 1–10.
 * Ставить сырой максимум под нормализованное значение — рисовать пустые полоски.
 */
function axis(scale: ComparisonResult["scales"][number]): { top: number; fmt: (v: number) => string } {
  const observed = Math.max(...scale.cohorts.map((c) => c.max), 0);
  switch (scale.normalization) {
    case "ratio":
      return { top: 1, fmt: (v) => `${Math.round(v * 100)}%` };
    case "tscore":
      return { top: Math.max(80, Math.ceil(observed / 10) * 10), fmt: (v) => `${v} T` };
    case "sten":
      return { top: 10, fmt: (v) => `${v} ст.` };
    default:
      return { top: Math.max(scale.maxScore, observed, 1), fmt: (v) => String(v) };
  }
}

function scaleHint(scale: ComparisonResult["scales"][number]): string {
  switch (scale.normalization) {
    case "ratio":
      return `Доля от максимума (сырой максимум ${scale.maxScore}). Полоса — размах, заливка — среднее`;
    case "tscore":
      return "T-баллы по нормам пола и возраста. Полоса — размах, заливка — среднее";
    case "sten":
      return "Стены 1–10. Полоса — размах, заливка — среднее";
    default:
      return `Сырой балл, максимум ${scale.maxScore}. Полоса — размах, заливка — среднее`;
  }
}

function CohortBars({ scale }: { scale: ComparisonResult["scales"][number] }) {
  const { top, fmt } = axis(scale);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {scale.cohorts.map((c) => (
        <div key={c.cohort}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 5 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>
              {c.cohort} <span className="muted">· n={c.n}</span>
            </span>
            <span className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              среднее {fmt(c.mean)} · σ {c.sd} · риск {Math.round(c.rawRiskShare * 100)}%
              {c.stdRiskShare !== null ? (
                <> · станд. {Math.round(c.stdRiskShare * 100)}%</>
              ) : null}
            </span>
          </div>
          {/* столбик среднего с усом межквартильного разброса */}
          <div style={{ position: "relative", height: 12, background: "var(--grid)", borderRadius: 6 }}>
            <div
              style={{
                position: "absolute",
                left: `${(c.min / top) * 100}%`,
                width: `${Math.max(1, ((c.max - c.min) / top) * 100)}%`,
                height: 12,
                background: "var(--surface-3)",
                borderRadius: 6,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                width: `${Math.max(1.5, (c.mean / top) * 100)}%`,
                height: 12,
                background: SERIES[0],
                borderRadius: 6,
                opacity: 0.9,
              }}
            />
          </div>
          {c.bands.length ? (
            <div className="row tight" style={{ marginTop: 6 }}>
              {c.bands.map((b) => (
                <span key={b.label} className="chip static" style={{ fontSize: 11 }}>
                  <i className="dot" style={{ background: severityColor[b.severity] }} />
                  {b.label} · {b.percent}%
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CorrelationGrid({ matrix }: { matrix: CorrelationMatrix }) {
  const value = (a: string, b: string) => {
    if (a === b) return { r: 1, n: -1 };
    const p = matrix.pairs.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    return p ? { r: p.r, n: p.n } : null;
  };

  /* Расходящаяся шкала: два полюса и нейтральная середина — знак здесь и есть содержание */
  const color = (r: number) => {
    const strength = Math.min(1, Math.abs(r));
    const hue = r >= 0 ? "var(--s1)" : "var(--sev-severe)";
    return `color-mix(in srgb, ${hue} ${Math.round(strength * 82)}%, transparent)`;
  };

  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th />
            {matrix.codes.map((c) => (
              <th key={c} className="num" title={matrix.titles[c]}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.codes.map((a) => (
            <tr key={a}>
              <td style={{ fontWeight: 600, whiteSpace: "nowrap" }} title={matrix.titles[a]}>
                {a} <span className="muted" style={{ fontWeight: 400 }}>{matrix.titles[a]?.slice(0, 26)}</span>
              </td>
              {matrix.codes.map((b) => {
                const v = value(a, b);
                if (!v) return <td key={b} className="num muted">—</td>;
                if (v.n === -1)
                  return (
                    <td key={b} className="num muted" style={{ background: "var(--surface-2)" }}>
                      1
                    </td>
                  );
                const weak = v.n < matrix.minSample;
                return (
                  <td
                    key={b}
                    className="num"
                    title={`n = ${v.n}`}
                    style={{
                      background: weak ? "transparent" : color(v.r),
                      fontWeight: Math.abs(v.r) > 0.5 ? 700 : 400,
                      color: weak ? "var(--muted)" : undefined,
                    }}
                  >
                    {weak ? "мало" : v.r.toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="legend">
        <span><i className="dot" style={{ background: "var(--s1)" }} /> прямая связь</span>
        <span><i className="dot" style={{ background: "var(--sev-severe)" }} /> обратная связь</span>
        <span className="muted">насыщенность — сила связи, число продублировано</span>
      </div>
    </div>
  );
}

/** Стандартизация перевернула ранжирование хотя бы одной пары когорт */
function standardizationFlips(
  cohorts: { rawRiskShare: number; stdRiskShare: number | null }[],
): boolean {
  const usable = cohorts.filter((c) => c.stdRiskShare !== null);
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const rawOrder = Math.sign(usable[i]!.rawRiskShare - usable[j]!.rawRiskShare);
      const stdOrder = Math.sign(usable[i]!.stdRiskShare! - usable[j]!.stdRiskShare!);
      if (rawOrder !== 0 && stdOrder !== 0 && rawOrder !== stdOrder) return true;
    }
  }
  return false;
}
