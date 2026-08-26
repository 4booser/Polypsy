import { useEffect, useState } from "react";
import { api, type ConclusionState } from "../api";
import { day } from "../format";
import { useAction } from "../ui";

/**
 * Заключение специалиста поверх автоматической интерпретации.
 *
 * Черновик правится свободно; подпись фиксирует версию навсегда — дальше
 * только новая версия поверх. В печатный отчёт попадает только подписанное:
 * рабочий текст не должен утекать в документ, который подошьют в дело.
 */
export function ConclusionEditor({ responseId }: { responseId: string }) {
  const [state, setState] = useState<ConclusionState | null>(null);
  const [text, setText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const run = useAction();

  useEffect(() => {
    api
      .conclusion(responseId)
      .then((s) => {
        setState(s);
        setText(s.current?.status === "draft" ? s.current.text : "");
      })
      .catch(() => setState({ current: null, versions: [] }));
  }, [responseId]);

  if (!state) return <p className="muted">Загрузка…</p>;

  const signed = state.versions.find((v) => v.status === "signed");
  const draft = state.current?.status === "draft" ? state.current : null;

  return (
    <div className="nested">
      <h3>Заключение специалиста</h3>

      {signed && !draft ? (
        <div className="conclusion-view">
          <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{state.current!.text}</p>
          <p className="hint">
            Подписано: {state.current!.authorName}, {day(state.current!.signedAt!)} · версия{" "}
            {state.current!.version}. Правка создаст новую версию — подписанный текст неизменен.
          </p>
        </div>
      ) : null}

      <textarea
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          signed
            ? "Новый текст поверх подписанной версии…"
            : "Клиническая интерпретация, рекомендации, назначения…"
        }
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button
          disabled={!text.trim()}
          onClick={() =>
            run(async () => {
              setState(await api.saveConclusion(responseId, text));
            }, "Черновик сохранён")
          }
        >
          Сохранить черновик
        </button>
        <button
          className="primary"
          disabled={!draft && !text.trim()}
          onClick={() =>
            run(async () => {
              // подпись всегда фиксирует последний сохранённый текст
              if (text.trim() && text !== draft?.text) await api.saveConclusion(responseId, text);
              const s = await api.signConclusion(responseId);
              setState(s);
              setText("");
            }, "Заключение подписано — теперь оно в печатном отчёте")
          }
        >
          Подписать
        </button>
        {state.versions.length > 1 ? (
          <button onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Скрыть историю" : `История (${state.versions.length})`}
          </button>
        ) : null}
      </div>
      <p className="hint">
        В печатный отчёт попадает только подписанная версия. Черновик виден только персоналу.
      </p>

      {showHistory
        ? state.versions.map((v) => (
            <div key={v.id} className="conclusion-view" style={{ marginTop: 8 }}>
              <p style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>{v.text}</p>
              <p className="hint">
                Версия {v.version} · {v.status === "signed" ? `подписана ${day(v.signedAt!)}` : "черновик"} ·{" "}
                {v.authorName}
              </p>
            </div>
          ))
        : null}
    </div>
  );
}
