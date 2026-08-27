import { useState } from "react";
import { BulkPaste } from "./BulkPaste";
import { Loc, Toggle } from "./fields";
import { TYPES, newUid, type Draft, type DraftQuestion } from "./model";

export function Questions({ draft, setDraft }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const [bulk, setBulk] = useState(false);
  const upd = (i: number, q: Partial<DraftQuestion>) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((x, k) => (k === i ? { ...x, ...q } : x)) }));

  const move = (i: number, delta: number) =>
    setDraft((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.questions.length) return d;
      const next = [...d.questions];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...d, questions: next };
    });

  const duplicate = (i: number) =>
    setDraft((d) => {
      const copy = structuredClone(d.questions[i]!);
      const next = [...d.questions];
      next.splice(i + 1, 0, copy);
      return { ...d, questions: next };
    });

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="hint" style={{ margin: 0 }}>
            Номера пунктов — это то, на что ссылаются ключи шкал. Перестановка вопросов
            сдвигает ключи, поэтому меняйте порядок до того, как зададите ключ.
          </p>
          <div className="row tight">
            <button onClick={() => setBulk(true)}>Вставить пункты из текста</button>
            <button
              className="primary"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  questions: [
                    ...d.questions,
                    {
                      uid: newUid(),
                      type: "yesno",
                      title: { uk: "", ru: "" },
                      required: true,
                      options: [
                        { text: { uk: "Так", ru: "Да" }, keyCode: "yes" },
                        { text: { uk: "Ні", ru: "Нет" }, keyCode: "no" },
                      ],
                    },
                  ],
                }))
              }
            >
              Добавить вопрос
            </button>
          </div>
        </div>
      </div>

      {bulk ? (
        <BulkPaste
          onClose={() => setBulk(false)}
          onAppend={(questions) => setDraft((d) => ({ ...d, questions: [...d.questions, ...questions] }))}
        />
      ) : null}

      {draft.questions.length === 0 && !bulk ? (
        <p className="muted">Вопросов пока нет</p>
      ) : null}

      {draft.questions.map((q, i) => (
        <div className="card" key={q.uid}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Пункт {i + 1}</strong>
            <div className="row">
              <select value={q.type} onChange={(e) => upd(i, { type: e.target.value })} style={{ width: 180 }}>
                {TYPES.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Выше" title="Сдвинуть выше">↑</button>
              <button onClick={() => move(i, 1)} disabled={i === draft.questions.length - 1} aria-label="Ниже" title="Сдвинуть ниже">↓</button>
              <button onClick={() => duplicate(i)} title="Дублировать пункт">⧉</button>
              <button className="danger" onClick={() => setDraft((d) => ({ ...d, questions: d.questions.filter((_, k) => k !== i) }))}>
                Удалить
              </button>
            </div>
          </div>
          <Loc label="Текст пункта" value={q.title} onChange={(v) => upd(i, { title: v })} multiline />
          <Toggle label="Обязательный" value={q.required} onChange={(v) => upd(i, { required: v })} />

          {q.options.length ? (
            <table>
              <thead>
                <tr><th>Вариант (uk / ru)</th><th className="num">Балл</th><th>Код ключа</th><th>Тревога</th></tr>
              </thead>
              <tbody>
                {q.options.map((o, oi) => (
                  <tr key={oi}>
                    <td>
                      <div className="row">
                        <input
                          value={o.text.uk ?? ""}
                          onChange={(e) =>
                            upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, text: { ...x.text, uk: e.target.value } } : x)) })
                          }
                        />
                        <input
                          value={o.text.ru ?? ""}
                          onChange={(e) =>
                            upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, text: { ...x.text, ru: e.target.value } } : x)) })
                          }
                        />
                      </div>
                    </td>
                    <td className="num" style={{ width: 90 }}>
                      <input
                        type="number"
                        value={o.score ?? 0}
                        onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, score: Number(e.target.value) } : x)) })}
                      />
                    </td>
                    <td style={{ width: 110 }}>
                      <input
                        value={o.keyCode ?? ""}
                        placeholder="yes / no"
                        onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, keyCode: e.target.value || null } : x)) })}
                      />
                    </td>
                    <td style={{ width: 130 }}>
                      <label className="row" style={{ gap: 6, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={!!o.riskFlag}
                          style={{ width: 16 }}
                          onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, riskFlag: e.target.checked } : x)) })}
                        />
                        <span style={{ fontSize: 12 }}>критический</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <button
            style={{ marginTop: 8 }}
            onClick={() => upd(i, { options: [...q.options, { text: { uk: "", ru: "" }, score: 0 }] })}
          >
            Добавить вариант
          </button>
        </div>
      ))}
    </>
  );
}

