import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Answer, SurveyFull } from "@quizzy/shared";
import { isAnswered, isQuestionVisible } from "@quizzy/shared";
import { api, type Patient } from "../api";
import { SeverityTag } from "../charts/advanced";

/**
 * Заполнение методики специалистом за пациента.
 *
 * Все пункты на одной странице: клиницист работает не как респондент, он
 * переносит уже собранные сведения, и постраничный мастер тут только мешает.
 */
export default function Administer() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [survey, setSurvey] = useState<SurveyFull | null>(null);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [subject, setSubject] = useState("");
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.submitFor>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useMemo(() => new Date().toISOString(), []);

  useEffect(() => {
    if (!id) return;
    Promise.all([api.survey(id), api.patients()])
      .then(([s, p]) => {
        setSurvey(s);
        setPatients(p);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!survey) return <p className="muted">Загрузка…</p>;

  const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers));
  const unanswered = visible.filter((q) => q.required && q.type !== "info" && !isAnswered(q, answers.get(q.id)));

  function set(questionId: string, patch: Partial<Answer>) {
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(questionId, { ...next.get(questionId), ...patch, questionId });
      return next;
    });
  }

  async function submit() {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.submitFor(id, {
        onBehalfOf: subject,
        startedAt: started,
        durationMs: Date.now() - new Date(started).getTime(),
        status: "completed",
        events: [],
        answers: [...answers.values()],
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const scores = result.scores as {
      scaleCode: string;
      scaleTitle: string;
      rawScore: number;
      value: number;
      band: { label: string; severity: "none" | "mild" | "moderate" | "severe"; recommendation: string | null } | null;
    }[];
    return (
      <>
        <h1>Обследование сохранено</h1>
        <p className="sub">{survey.title}</p>
        {!result.reliable ? (
          <div className="card" style={{ borderColor: "var(--sev-severe)" }}>
            <strong>Профиль признан ненадёжным</strong>
            {result.warnings.map((w, i) => (
              <p key={i} className="hint" style={{ marginBottom: 0 }}>{w}</p>
            ))}
          </div>
        ) : null}
        <div className="card scroll-x">
          <table>
            <thead><tr><th>Шкала</th><th className="num">Сырой</th><th className="num">Значение</th><th>Интерпретация</th><th>Рекомендация</th></tr></thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.scaleCode}>
                  <td>{s.scaleTitle}</td>
                  <td className="num">{s.rawScore}</td>
                  <td className="num">{s.value}</td>
                  <td>{s.band ? <SeverityTag severity={s.band.severity} label={s.band.label} /> : "—"}</td>
                  <td className="muted">{s.band?.recommendation ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="primary" onClick={() => navigate(`/surveys/${survey.id}`)}>К аналитике методики</button>
      </>
    );
  }

  return (
    <>
      <h1>{survey.title}</h1>
      <p className="sub">Заполнение специалистом · {visible.filter((q) => q.type !== "info").length} пунктов</p>

      <div className="card">
        <div className="field" style={{ maxWidth: 460, marginBottom: 0 }}>
          <label>Кого обследуем</label>
          <select value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">— выберите пациента —</option>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>{p.fullName} · {p.email}</option>
            ))}
          </select>
        </div>
        {survey.instructions ? <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>{survey.instructions}</p> : null}
      </div>

      {visible.map((q, i) => {
        if (q.type === "info") {
          return (
            <div className="card" key={q.id}>
              <strong>{q.title}</strong>
              {q.help ? <p className="hint">{q.help}</p> : null}
            </div>
          );
        }
        const a = answers.get(q.id);
        const choices = q.options.filter((o) => o.kind === "option");
        return (
          <div className="card" key={q.id}>
            <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
              <span className="muted" style={{ minWidth: 28 }}>{i + 1}.</span>
              <div style={{ flex: 1 }}>
                <div>{q.title}</div>
                {q.help ? <p className="hint" style={{ marginBottom: 6 }}>{q.help}</p> : null}
                <div className="row" style={{ marginTop: 6 }}>
                  {choices.length ? (
                    choices.map((o) => (
                      <button
                        key={o.id}
                        className={`chip ${a?.optionIds?.includes(o.id) ? "active" : ""}`}
                        onClick={() =>
                          set(q.id, {
                            optionIds: q.type === "multiple"
                              ? (a?.optionIds ?? []).includes(o.id)
                                ? (a?.optionIds ?? []).filter((x) => x !== o.id)
                                : [...(a?.optionIds ?? []), o.id]
                              : [o.id],
                          })
                        }
                      >
                        {o.text}
                        {o.riskFlag ? " ⚠" : ""}
                      </button>
                    ))
                  ) : ["scale", "slider", "number"].includes(q.type) ? (
                    <input
                      type="number"
                      style={{ width: 160 }}
                      value={a?.number ?? ""}
                      onChange={(e) => set(q.id, { number: e.target.value === "" ? undefined : Number(e.target.value) })}
                    />
                  ) : (
                    <input
                      style={{ maxWidth: 520 }}
                      value={a?.text ?? ""}
                      onChange={(e) => set(q.id, { text: e.target.value })}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <button className="primary" onClick={submit} disabled={!subject || unanswered.length > 0 || busy}>
          {busy ? "Сохранение…" : "Сохранить обследование"}
        </button>
        {unanswered.length ? <span className="muted">не заполнено обязательных: {unanswered.length}</span> : null}
        {!subject ? <span className="muted">выберите пациента</span> : null}
      </div>
    </>
  );
}
