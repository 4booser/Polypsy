import { useEffect, useState } from "react";
import type { RiskAlert } from "@quizzy/shared";
import { api } from "../api";
import { dateTime, severityColor } from "../format";
import { useUrlState } from "../ui";

const OUTCOME_LABEL: Record<string, string> = {
  confirmed: "риск подтверждён",
  not_confirmed: "не подтверждён",
  needs_followup: "требует наблюдения",
};

export default function Alerts() {
  const [rows, setRows] = useState<RiskAlert[] | null>(null);
  // «покажи мне разобранные тревоги» — ссылкой, а не пересказом
  const [allParam, setAll] = useUrlState("all");
  const all = allParam === "1";
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function ack(id: string, outcome: "confirmed" | "not_confirmed" | "needs_followup") {
    await api.acknowledgeAlert(id, notes[id]?.trim() || undefined, outcome).catch(() => null);
    await load(all);
  }
  const [error, setError] = useState<string | null>(null);

  async function load(showAll: boolean) {
    setRows(await api.alerts(showAll));
  }
  useEffect(() => {
    load(all).catch((e) => setError(e.message));
  }, [all]);

  if (!rows) return <p className="muted">{error ?? "Загрузка…"}</p>;

  return (
    <>
      <h1>Тревоги</h1>
      <p className="sub">
        Поднимаются сразу при сохранении ответа, в том числе на незавершённом прохождении
      </p>

      <div className="tabs" style={{ maxWidth: 320 }}>
        <button className={!all ? "active" : ""} onClick={() => setAll("")}>Неразобранные</button>
        <button className={all ? "active" : ""} onClick={() => setAll("1")}>Все</button>
      </div>

      {rows.length === 0 ? <p className="muted">Тревог нет</p> : null}

      {rows.map((a) => (
        <div className="card" key={a.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <i className="dot" style={{ background: a.severity === "severe" ? severityColor.severe : severityColor.moderate }} />
              <strong>{a.severity === "severe" ? "Срочно" : "Внимание"}</strong>
              <span className="muted">· {a.respondent ?? "Аноним"} · {a.surveyTitle}</span>
            </div>
            <span className="muted">{dateTime(a.at)}</span>
          </div>
          <p style={{ margin: "8px 0 4px" }}>{a.label}</p>
          <p className="hint" style={{ marginBottom: 10 }}>{a.questionTitle}</p>

          {a.acknowledgedAt ? (
            <p className="muted" style={{ margin: 0 }}>
              Разобрано: {a.acknowledgedByName ?? "—"}, {dateTime(a.acknowledgedAt)}
              {a.outcome ? ` · ${OUTCOME_LABEL[a.outcome]}` : ""}
              {a.note ? ` — ${a.note}` : ""}
            </p>
          ) : (
            <>
              <div className="row">
                <input
                  placeholder="Что предпринято"
                  value={notes[a.id] ?? ""}
                  onChange={(e) => setNotes((p) => ({ ...p, [a.id]: e.target.value }))}
                  style={{ flex: 1, minWidth: 260 }}
                />
              </div>
              {/* исход — не бюрократия: по нему система калибрует пороги
                  и считает PPV скрининга. Три кнопки вместо формы. */}
              <div className="row tight" style={{ marginTop: 8 }}>
                <button
                  className="primary"
                  onClick={() => ack(a.id, "confirmed")}
                >
                  Риск подтверждён
                </button>
                <button onClick={() => ack(a.id, "needs_followup")}>Требует наблюдения</button>
                <button onClick={() => ack(a.id, "not_confirmed")}>Не подтверждён</button>
              </div>
            </>
          )}
        </div>
      ))}
    </>
  );
}
