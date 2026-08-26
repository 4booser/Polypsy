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
export default function Norms() {
  const { id } = useParams<{ id: string }>();
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

      {!data.scales.length ? (
        <Empty
          title="Здесь нечего пересчитывать"
          hint="Локальные нормы применимы только к шкалам с T-баллами. У этой методики таких нет — доли и стены нормируются иначе."
        />
      ) : null}

      {data.scales.map((s) => {
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
      })}

      <div className="card">
        <p className="hint" style={{ margin: 0 }}>
          Публикация создаёт новую версию методики: собранные прохождения остаются на прежних
          нормах, происхождение каждой нормы фиксируется («локальная выборка, N=…»).
          <Link to={`/surveys/${id}/key`} style={{ marginLeft: 6 }}>Проверить ключи после публикации</Link>
        </p>
      </div>
    </>
  );
}
