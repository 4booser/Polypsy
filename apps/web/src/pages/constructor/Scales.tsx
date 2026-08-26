import { Loc } from "./fields";
import { parseItems, type Draft, type DraftScale } from "./model";

export function Scales({ draft, setDraft }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const upd = (i: number, s: Partial<DraftScale>) =>
    setDraft((d) => ({ ...d, scales: d.scales.map((x, k) => (k === i ? { ...x, ...s } : x)) }));

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="hint" style={{ margin: 0 }}>
            Ключ задаётся номерами пунктов через запятую — так же, как он напечатан в пособии
          </p>
          <button
            className="primary"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                scales: [
                  ...d.scales,
                  {
                    code: "",
                    title: { uk: "", ru: "" },
                    kind: "clinical",
                    normalization: "raw",
                    key: [],
                    corrections: [],
                    norms: [],
                    stenTable: [],
                    bands: [],
                  },
                ],
              }))
            }
          >
            Добавить шкалу
          </button>
        </div>
      </div>

      {draft.scales.map((s, i) => (
        <div className="card" key={i}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{s.code || "новая шкала"}</strong>
            <button className="danger" onClick={() => setDraft((d) => ({ ...d, scales: d.scales.filter((_, k) => k !== i) }))}>
              Удалить
            </button>
          </div>

          <div className="row">
            <div className="field" style={{ width: 140 }}>
              <label>Код</label>
              <input value={s.code} onChange={(e) => upd(i, { code: e.target.value })} placeholder="Sr" />
            </div>
            <div className="field" style={{ width: 170 }}>
              <label>Роль</label>
              <select value={s.kind} onChange={(e) => upd(i, { kind: e.target.value as DraftScale["kind"] })}>
                <option value="clinical">Содержательная</option>
                <option value="validity">Достоверности</option>
              </select>
            </div>
            <div className="field" style={{ width: 190 }}>
              <label>Нормирование</label>
              <select
                value={s.normalization}
                onChange={(e) => upd(i, { normalization: e.target.value as DraftScale["normalization"] })}
              >
                <option value="raw">Сырой балл</option>
                <option value="ratio">Доля от максимума</option>
                <option value="tscore">T-баллы</option>
                <option value="sten">Стены</option>
              </select>
            </div>
            {s.normalization === "ratio" ? (
              <div className="field" style={{ width: 150 }}>
                <label>Знаменатель</label>
                <input
                  type="number"
                  value={s.ratioDenominator ?? ""}
                  onChange={(e) => upd(i, { ratioDenominator: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
            ) : null}
          </div>

          <Loc label="Название шкалы" value={s.title} onChange={(v) => upd(i, { title: v })} />

          {s.kind === "validity" ? (
            <div className="row">
              <div className="field" style={{ width: 150 }}>
                <label>Порог</label>
                <input
                  type="number"
                  step="0.01"
                  value={s.validityThreshold ?? ""}
                  onChange={(e) => upd(i, { validityThreshold: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
              <div className="field" style={{ width: 180 }}>
                <label>Нарушается</label>
                <select
                  value={s.validityDirection ?? "above"}
                  onChange={(e) => upd(i, { validityDirection: e.target.value as "above" | "below" })}
                >
                  <option value="above">выше порога</option>
                  <option value="below">ниже порога</option>
                </select>
              </div>
            </div>
          ) : null}

          <div className="field">
            <label>Ключ: номера пунктов с ответом «Да»</label>
            <input
              value={s.key.filter((k) => k.matchKey === "yes").map((k) => k.item).join(", ")}
              placeholder="1, 2, 3, 5, 7"
              onChange={(e) =>
                upd(i, {
                  key: [
                    ...parseItems(e.target.value).map((item) => ({ item, matchKey: "yes" })),
                    ...s.key.filter((k) => k.matchKey !== "yes"),
                  ],
                })
              }
            />
          </div>
          <div className="field">
            <label>Ключ: номера пунктов с ответом «Нет»</label>
            <input
              value={s.key.filter((k) => k.matchKey === "no").map((k) => k.item).join(", ")}
              placeholder="4, 6, 8"
              onChange={(e) =>
                upd(i, {
                  key: [
                    ...s.key.filter((k) => k.matchKey !== "no"),
                    ...parseItems(e.target.value).map((item) => ({ item, matchKey: "no" })),
                  ],
                })
              }
            />
          </div>

          <p className="hint" style={{ marginBottom: 4 }}>
            В ключе {s.key.length} пунктов
            {s.corrections.length ? ` · поправки: ${s.corrections.map((c) => `${c.from}×${c.coefficient}`).join(", ")}` : ""}
            {s.norms.length ? ` · норм: ${s.norms.length}` : ""}
            {s.stenTable.length ? ` · строк стенов: ${s.stenTable.length}` : ""}
          </p>
          <p className="hint">
            Поправки, нормы по полу и таблицы стенов задаются во вкладке «JSON» — в форме
            они занимали бы больше места, чем экономят
          </p>

          <h2 style={{ fontSize: 14, marginTop: 14 }}>Интерпретационные нормы</h2>
          <table>
            <thead>
              <tr><th className="num">От</th><th className="num">До</th><th>Вывод (uk / ru)</th><th>Выраженность</th><th className="num">Оценка</th><th /></tr>
            </thead>
            <tbody>
              {s.bands.map((b, bi) => (
                <tr key={bi}>
                  <td className="num" style={{ width: 80 }}>
                    <input type="number" step="0.01" value={b.minScore}
                      onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, minScore: Number(e.target.value) } : x)) })} />
                  </td>
                  <td className="num" style={{ width: 80 }}>
                    <input type="number" step="0.01" value={b.maxScore}
                      onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, maxScore: Number(e.target.value) } : x)) })} />
                  </td>
                  <td>
                    <div className="row">
                      <input value={b.label.uk ?? ""} placeholder="українською"
                        onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, label: { ...x.label, uk: e.target.value } } : x)) })} />
                      <input value={b.label.ru ?? ""} placeholder="по-русски"
                        onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, label: { ...x.label, ru: e.target.value } } : x)) })} />
                    </div>
                  </td>
                  <td style={{ width: 150 }}>
                    <select value={b.severity}
                      onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, severity: e.target.value as DraftScale["bands"][number]["severity"] } : x)) })}>
                      <option value="none">Норма</option>
                      <option value="mild">Лёгкая</option>
                      <option value="moderate">Умеренная</option>
                      <option value="severe">Выраженная</option>
                    </select>
                  </td>
                  <td className="num" style={{ width: 80 }}>
                    <input type="number" value={b.grade ?? ""}
                      onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, grade: e.target.value ? Number(e.target.value) : null } : x)) })} />
                  </td>
                  <td style={{ width: 40 }}>
                    <button className="danger" onClick={() => upd(i, { bands: s.bands.filter((_, k) => k !== bi) })}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            style={{ marginTop: 8 }}
            onClick={() => upd(i, { bands: [...s.bands, { minScore: 0, maxScore: 0, label: { uk: "", ru: "" }, severity: "none" }] })}
          >
            Добавить норму
          </button>
        </div>
      ))}
    </>
  );
}

/** «1, 2, 3, 5-7» → [1,2,3,5,6,7] */
