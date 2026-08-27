import { api } from "../api";
import { Loading } from "../ui";
import { useResource } from "../useResource";

const FACTOR_LABEL: Record<string, string> = {
  sex: "пол",
  age: "возраст",
  lang: "язык предъявления",
};

const CLASS_HINT: Record<string, string> = {
  A: "работает одинаково",
  B: "умеренное различие",
  C: "выраженное различие — разобрать формулировку",
};

/**
 * DIF: работает ли пункт одинаково у людей с ОДИНАКОВЫМ уровнем черты, но
 * разного пола, возраста или языка предъявления.
 *
 * Класс C — не приговор пункту: это указание сесть с формулировкой и решить,
 * различие содержательное («мужчины реже признают слёзы») или переводческое.
 * Автоматически из ключа ничего не выбрасывается.
 */
export function DifPanel({ surveyId }: { surveyId: string }) {
  // через useResource: смена методики не должна оставлять ответ по прежней
  const res = useResource(() => api.dif(surveyId), [surveyId]);
  const { data, error } = res;

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading />;

  const flagged = data.scales.flatMap((s) =>
    s.items.flatMap((i) =>
      i.entries
        .filter((e) => e.result && e.result.etsClass !== "A")
        .map((e) => ({ scale: s.code, position: i.position, title: i.title, ...e })),
    ),
  );

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Дифференциальное функционирование пунктов</h2>
          <span className="hint">выборка {data.sample}</span>
        </div>
        <p className="hint">
          Метод Mantel–Haenszel: сравниваются люди с одинаковым суммарным баллом. Группы меньше{" "}
          {data.minGroup} наблюдений не считаются вовсе; от {data.minGroup} до {data.solidGroup} —
          помечены как предварительные (мягкий критерий значимости). Различие в пункте — повод
          разобрать формулировку, а не выбросить пункт.
        </p>
        {flagged.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {data.scales.length
              ? "Пунктов с различиями не найдено — все класса A."
              : "Данных пока недостаточно: нужны две группы по " + data.minGroup + " прохождений."}
          </p>
        ) : null}
      </div>

      {flagged.length ? (
        <div className="card scroll-x">
          <h2>Пункты с различиями: {flagged.length}</h2>
          <table>
            <thead>
              <tr>
                <th className="num">№</th>
                <th>Пункт</th>
                <th>Шкала</th>
                <th>Фактор</th>
                <th>Группы (n)</th>
                <th className="num">ΔMH</th>
                <th>Класс</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((f, i) => (
                <tr key={i}>
                  <td className="num">{f.position}</td>
                  <td style={{ maxWidth: 320 }}>{f.title}</td>
                  <td className="muted">{f.scale}</td>
                  <td className="muted">{FACTOR_LABEL[f.factor]}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {f.reference} ({f.refN}) ↔ {f.focal} ({f.focalN})
                    {f.preliminary ? " · предварительно" : ""}
                  </td>
                  <td className="num">{f.result!.deltaMH}</td>
                  <td>
                    <span
                      className="chip static"
                      style={{ color: f.result!.etsClass === "C" ? "var(--sev-severe)" : "var(--sev-mild)" }}
                      title={CLASS_HINT[f.result!.etsClass]}
                    >
                      {f.result!.etsClass}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            ΔMH в дельта-единицах ETS: |Δ| &lt; 1 — класс A, 1–1.5 — B, &gt; 1.5 — C. Знак
            показывает, какая группа чаще отвечает по ключу при равном уровне черты.
          </p>
        </div>
      ) : null}

      {data.reliability.length ? (
        <div className="card scroll-x">
          <h2>Надёжность по группам</h2>
          <p className="hint">
            Альфа Кронбаха отдельно у мужчин и женщин. Расхождение больше 0.10 означает, что
            шкала измеряет одну группу точнее другой — сравнивать их баллы нужно осторожнее.
          </p>
          <table>
            <thead>
              <tr><th>Шкала</th><th>Группа</th><th className="num">n</th><th className="num">α</th><th className="num">Расхождение</th></tr>
            </thead>
            <tbody>
              {data.reliability.map((s) =>
                s.groups.map((g, gi) => (
                  <tr key={`${s.code}-${g.group}`}>
                    {gi === 0 ? <td rowSpan={s.groups.length}>{s.code} — {s.title}</td> : null}
                    <td className="muted">{g.group}</td>
                    <td className="num">{g.n}</td>
                    <td className="num">{g.alpha ?? "—"}</td>
                    {gi === 0 ? (
                      <td className="num" rowSpan={s.groups.length}>
                        {s.alphaSpread === null ? (
                          "—"
                        ) : (
                          <span style={{ color: s.alphaSpread > 0.1 ? "var(--sev-mild)" : undefined }}>
                            {s.alphaSpread}
                          </span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
