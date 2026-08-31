import { useState } from "react";
import type { CohortBy, ComparisonResult, CorrelationMatrix, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useResource } from "../useResource";
import { Chart } from "../charts";
import { SERIES } from "../format";
import { Empty, Loading } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Select, SeverityTag } from "../ui/primitives";
import { useLang } from "../lang";

// ключи, а не подписи: карта вне компонента, язык — при отрисовке
const BY_KEY: [CohortBy, UiKey][] = [
  ["unit", "cmp.unit"],
  ["sex", "cmp.sex"],
  ["ageGroup", "cmp.age"],
  ["rank", "cmp.rank"],
  ["month", "cmp.month"],
];

/**
 * Сравнение когорт и связи между субшкалами.
 *
 * Обе картины отвечают на вопросы, которых нет в аналитике одной методики:
 * «отличается ли отделение от отделения» и «что с чем связано».
 */
export default function Compare() {
  const { ut } = useLang();
  const [chosen, setChosen] = useState("");
  const [by, setBy] = useState<CohortBy>("unit");

  const list = useResource(async () => (await api.surveys()).filter((x) => x.responseCount > 0), []);
  const surveys = list.data ?? [];
  // выбор по умолчанию — первая методика с данными; явный выбор его перебивает
  const surveyId = chosen || surveys[0]?.id || "";

  const res = useResource(
    async () => {
      const [data, corr] = await Promise.all([api.compare(surveyId, by), api.correlations(surveyId)]);
      return { data, corr };
    },
    [surveyId, by],
    { enabled: !!surveyId },
  );
  const { data, corr } = res.data ?? { data: null, corr: null };
  const error = list.error ?? res.error;

  return (
    <Page
      title={ut("cmp.title")}
      sub={ut("cmp.sub")}
      toolbar={
        <div className="flex flex-wrap items-center gap-3">
          <Select value={surveyId} onChange={(e) => setChosen(e.target.value)} className="max-w-[300px]">
            {surveys.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </Select>
          <div className="flex flex-wrap gap-2">
            {BY_KEY.map(([v, lab]) => (
              <button key={v} className={`chip${by === v ? " active" : ""}`} onClick={() => setBy(v)}>
                {ut(lab)}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {error ? <p className="text-danger">{error}</p> : null}

      {/*
        Скелет — только пока действительно грузим.
        Раньше стояло `!data`, а data остаётся пустым и когда сравнивать
        нечего: у методик нет ни одного завершённого прохождения, выбирать не
        из чего, запрос не уходит вовсе. Экран показывал скелет вечно — то
        есть говорил «подождите» там, где надо было сказать «нечего
        сравнивать», и человек ждал.
      */}
      {list.loading || res.loading ? <Loading /> : null}
      {!list.loading && !surveyId ? (
        <Empty title={ut("cmp.nothing")} hint={ut("cmp.noData")} />
      ) : null}

      {data && data.scales.every((s) => s.cohorts.length === 0) ? (
        <Empty
          title={ut("cmp.nothing")}
          hint={`${ut("cmp.noCohortsBefore")} «${ut(BY_KEY.find(([v]) => v === by)![1])}» ${ut("cmp.noCohortsAfter")}`}
        />
      ) : null}

      {data?.unclassified ? (
        <Panel className="mb-4">
          <p className="m-0 text-muted">
            {data.unclassified} {ut("cmp.unclassifiedHint")}
          </p>
        </Panel>
      ) : null}

      {data?.scales.map((scale) => {
        if (!scale.cohorts.length) return null;
        const flip = standardizationFlips(scale.cohorts);
        return (
          <Chart key={scale.scaleId} title={scale.title} hint={scaleHint(scale, ut)}>
            {flip ? (
              <p className="hint warn">{ut("cmp.standardizationFlipWarning")}</p>
            ) : null}
            <CohortBars scale={scale} />
          </Chart>
        );
      })}

      {corr && corr.codes.length >= 2 ? (
        <Chart
          title={ut("cmp.links")}
          hint={`${ut("cmp.pearsonHint")} ${corr.minSample}`}
        >
          <CorrelationGrid matrix={corr} />
        </Chart>
      ) : null}
    </Page>
  );
}

/**
 * Границы оси зависят от единиц: доля живёт в 0–1, T-балл около 100, стен 1–10.
 * Ставить сырой максимум под нормализованное значение — рисовать пустые полоски.
 */
/* переводчик аргументом: функция чистая и живёт вне компонента */
function axis(
  scale: ComparisonResult["scales"][number],
  ut: (k: UiKey) => string,
): { top: number; fmt: (v: number) => string } {
  const observed = Math.max(...scale.cohorts.map((c) => c.max), 0);
  switch (scale.normalization) {
    case "ratio":
      return { top: 1, fmt: (v) => `${Math.round(v * 100)}%` };
    case "tscore":
      return { top: Math.max(80, Math.ceil(observed / 10) * 10), fmt: (v) => `${v} T` };
    case "sten":
      return { top: 10, fmt: (v) => `${v} ${ut("cmp.stenShort")}` };
    default:
      return { top: Math.max(scale.maxScore, observed, 1), fmt: (v) => String(v) };
  }
}

// переводчик аргументом: функция чистая и живёт вне компонента
function scaleHint(scale: ComparisonResult["scales"][number], ut: (k: UiKey) => string): string {
  const tail = ut("cmp.barsHint");
  switch (scale.normalization) {
    case "ratio":
      return `${ut("cmp.ratioHint")} (${ut("cmp.rawMax")} ${scale.maxScore}). ${tail}`;
    case "tscore":
      return `${ut("cmp.tscoreHint")} ${tail}`;
    case "sten":
      return `${ut("cmp.stenHint")} ${tail}`;
    default:
      return `${ut("cmp.rawHint")} ${scale.maxScore}. ${tail}`;
  }
}

function CohortBars({ scale }: { scale: ComparisonResult["scales"][number] }) {
  const { ut } = useLang();
  const { top, fmt } = axis(scale, ut);
  return (
    <div className="grid gap-3.5">
      {scale.cohorts.map((c) => (
        <div key={c.cohort}>
          <div className="mb-[5px] flex items-center justify-between gap-3">
            <span className="text-small font-medium">
              {c.cohort} <span className="text-muted">· n={c.n}</span>
            </span>
            <span className="text-caption tabular-nums text-muted">
              {ut("cmp.mean")} {fmt(c.mean)} · σ {c.sd} · {ut("cmp.risk")} {Math.round(c.rawRiskShare * 100)}%
              {c.stdRiskShare !== null ? (
                <> · {ut("cmp.standardizedAbbr")} {Math.round(c.stdRiskShare * 100)}%</>
              ) : null}
            </span>
          </div>
          {/* столбик среднего с усом межквартильного разброса */}
          <div className="relative h-3 rounded-md bg-[var(--grid)]">
            <div
              className="absolute h-3 rounded-md bg-surface-3"
              style={{
                left: `${(c.min / top) * 100}%`,
                width: `${Math.max(1, ((c.max - c.min) / top) * 100)}%`,
              }}
            />
            <div
              className="absolute left-0 h-3 rounded-md opacity-90"
              style={{ width: `${Math.max(1.5, (c.mean / top) * 100)}%`, background: SERIES[0] }}
            />
          </div>
          {c.bands.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {c.bands.map((b) => (
                <SeverityTag key={b.label} level={b.severity}>
                  {b.label} · {b.percent}%
                </SeverityTag>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CorrelationGrid({ matrix }: { matrix: CorrelationMatrix }) {
  const { ut } = useLang();
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
              <td className="whitespace-nowrap font-semibold" title={matrix.titles[a]}>
                {a} <span className="font-normal text-muted">{matrix.titles[a]?.slice(0, 26)}</span>
              </td>
              {matrix.codes.map((b) => {
                const v = value(a, b);
                if (!v) return <td key={b} className="num text-muted">—</td>;
                if (v.n === -1)
                  return (
                    <td key={b} className="num bg-surface-2 text-muted">
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
                    {weak ? ut("cmp.tooFewSample") : v.r.toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="legend">
        <span><i className="dot" style={{ background: "var(--s1)" }} /> {ut("chart.corrDirect")}</span>
        <span><i className="dot" style={{ background: "var(--sev-severe)" }} /> {ut("chart.corrInverse")}</span>
        <span className="text-muted">{ut("chart.corrHint")}</span>
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
