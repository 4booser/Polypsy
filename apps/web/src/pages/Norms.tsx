import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { Empty, Loading, PageHead, useAction } from "../ui";

const SEX_LABEL: Record<string, string> = { male: "мужчины", female: "женщины", all: "вся выборка" };

/**
 * Локальные нормы: пересчёт M/SD по фактической выборке учреждения.
 *
 * Нормы пособий сняты с мирной популяции; на военной выборке они плывут.
 * Публикация создаёт новую версию методики — уже собранные прохождения
 * остаются на прежних нормах своей версии, а происхождение каждой нормы
 * («пособие» или «локальная выборка, N=…») печатается в подсказках и SPSS.
 */
type NormsTab = "table" | "curves";

export default function Norms() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<NormsTab>("table");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.normCandidates>> | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const run = useAction();

  const reload = () => {
    if (!id) return;
    api.normCandidates(id).then(setData).catch((e) => setError(e.message));
  };
  useEffect(reload, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading />;

  const publishableCodes = data.scales
    .filter((s) => s.candidate.some((g) => g.sex !== null && g.publishable))
    .map((s) => s.code);

  return (
    <>
      <PageHead
        title="Локальные нормы"
        crumbs={<Link to={`/surveys/${id}`}>← Аналитика методики</Link>}
        sub="M и SD по фактической выборке учреждения против норм пособия"
        actions={
          picked.size ? (
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  await api.applyNorms(id!, [...picked]);
                  setPicked(new Set());
                  reload();
                }, "Локальные нормы опубликованы новой версией")
              }
            >
              Опубликовать для {picked.size} шкал
            </button>
          ) : undefined
        }
      />

      <div className="tabs" style={{ maxWidth: 420 }}>
        <button className={tab === "table" ? "active" : ""} onClick={() => setTab("table")}>
          Пособие против выборки
        </button>
        <button className={tab === "curves" ? "active" : ""} onClick={() => setTab("curves")}>
          Возрастные кривые
        </button>
      </div>

      {tab === "curves" ? <AgeCurves surveyId={id!} /> : null}

      {tab === "table" && !data.scales.length ? (
        <Empty
          title="Здесь нечего пересчитывать"
          hint="Локальные нормы применимы только к шкалам с T-баллами. У этой методики таких нет — доли и стены нормируются иначе."
        />
      ) : null}

      {tab === "table" ? data.scales.map((s) => {
        const canPublish = publishableCodes.includes(s.code);
        return (
          <div className="card" key={s.code}>
            <div className="card-head">
              <h2>
                {s.code} — {s.title}
              </h2>
              {canPublish ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={picked.has(s.code)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(s.code);
                      else next.delete(s.code);
                      setPicked(next);
                    }}
                  />
                  перевести на локальные
                </label>
              ) : (
                <span className="hint">выборка меньше {data.minGroup} — публиковать рано</span>
              )}
            </div>
            <table>
              <thead>
                <tr>
                  <th>Группа</th>
                  <th className="num">Норма сейчас (M / SD)</th>
                  <th>Источник</th>
                  <th className="num">Кандидат (M / SD)</th>
                  <th className="num">N</th>
                  <th className="num">Сдвиг среднего T</th>
                </tr>
              </thead>
              <tbody>
                {(["male", "female"] as const).map((sex) => {
                  const cur = s.current.find((n) => n.sex === sex);
                  const cand = s.candidate.find((g) => g.sex === sex);
                  if (!cur && !cand) return null;
                  // средний T выборки под текущей нормой: 50 + 10(Mк − Mтек)/SDтек
                  const shift =
                    cur && cand && cur.sd > 0
                      ? Math.round((50 + (10 * (cand.mean - cur.mean)) / cur.sd - 50) * 10) / 10
                      : null;
                  return (
                    <tr key={sex}>
                      <td>{SEX_LABEL[sex]}</td>
                      <td className="num">{cur ? `${cur.mean} / ${cur.sd}` : "—"}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{cur?.source ?? "—"}</td>
                      <td className="num">
                        {cand ? `${cand.mean} / ${cand.sd}` : <span className="muted">мало данных</span>}
                      </td>
                      <td className="num">{cand?.n ?? "—"}</td>
                      <td className="num">
                        {shift === null ? (
                          "—"
                        ) : (
                          <span style={{ color: Math.abs(shift) >= 5 ? "var(--sev-mild)" : undefined }}>
                            {shift > 0 ? "+" : ""}
                            {shift} T
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="hint">
              «Сдвиг среднего T» — насколько средний человек выборки отклоняется от нормы пособия.
              Больше ±5 T — выборка систематически отличается от нормировочной популяции, и
              локальные нормы имеют смысл.
            </p>
          </div>
        );
      }) : null}

      {tab === "table" ? (
      <div className="card">
        <p className="hint" style={{ margin: 0 }}>
          Публикация создаёт новую версию методики: собранные прохождения остаются на прежних
          нормах, происхождение каждой нормы фиксируется («локальная выборка, N=…»).
          <Link to={`/surveys/${id}/key`} style={{ marginLeft: 6 }}>Проверить ключи после публикации</Link>
        </p>
      </div>
      ) : null}
    </>
  );
}

/**
 * Возрастные перцентильные кривые (5.3): формат карт роста — P10…P90 против
 * возраста, отдельно по полу. Ширина скользящего окна показывается честно:
 * там, где данных мало, окно шире, и кривая грубее.
 */
function AgeCurves({ surveyId }: { surveyId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.ageCurves>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.ageCurves(surveyId).then(setData).catch((e) => setError(e.message));
  }, [surveyId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading />;
  if (!data.scales.length) {
    return (
      <Empty
        title="Кривых пока нет"
        hint={`Для кривой нужно минимум ${data.minWindow} прохождений одного пола с указанным возрастом. Накопится — появятся.`}
      />
    );
  }

  return (
    <>
      {data.scales.map((scale) => (
        <div className="card" key={scale.code}>
          <div className="card-head">
            <h2>{scale.code} — {scale.title}</h2>
            <span className="hint">{scale.normalization === "tscore" ? "T-баллы" : scale.normalization}</span>
          </div>
          <div className="grid cols-2">
            {scale.bySex.filter((b) => b.enough).map((b) => (
              <div key={b.sex}>
                <p className="hint" style={{ marginTop: 0 }}>
                  {b.sex === "male" ? "Мужчины" : "Женщины"} · окно ±{b.points[0]?.halfWidth ?? "?"} лет
                </p>
                <CurveTable points={b.points} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function CurveTable({ points }: { points: { age: number; n: number; halfWidth: number; percentiles: { q: number; value: number }[] }[] }) {
  // показываем опорные возрасты: сплошная таблица по каждому году нечитаема
  const step = Math.max(1, Math.floor(points.length / 8));
  const shown = points.filter((_, i) => i % step === 0);
  return (
    <table>
      <thead>
        <tr>
          <th className="num">Возраст</th>
          {shown[0]?.percentiles.map((p) => (
            <th key={p.q} className="num">P{Math.round(p.q * 100)}</th>
          ))}
          <th className="num">n</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((pt) => (
          <tr key={pt.age}>
            <td className="num">{pt.age}</td>
            {pt.percentiles.map((p) => (
              <td key={p.q} className="num">{p.value}</td>
            ))}
            <td className="num muted">{pt.n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
