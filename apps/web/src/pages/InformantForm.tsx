import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { isAnswered, isQuestionVisible, type Answer, type SurveyFull } from "@quizzy/shared";
import { useLang } from "../lang";
import { Loading } from "../ui";

/**
 * Форма для человека со стороны.
 *
 * Открывается по одноразовой ссылке, без учётной записи. Имя отвечающего не
 * спрашивается и не хранится: оценка командира не должна превращаться в личное
 * дело того, кто её дал, — обещание анонимности здесь единственное, что делает
 * такую оценку честной.
 *
 * Результаты не показываются. Информант не адресат интерпретации: он сообщает
 * наблюдение, а что оно значит — решает специалист.
 */
type State =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "form"; survey: SurveyFull; about: string; role: string; note: string | null }
  | { kind: "done" };

export default function InformantForm() {
  const { token } = useParams<{ token: string }>();
  const { ut } = useLang();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    fetch(`/api/informants/form/${token}`)
      .then((r) => r.json())
      .then((body) => {
        if (!body.valid) return setState({ kind: "gone" });
        setState({ kind: "form", survey: body.survey, about: body.about, role: body.role, note: body.note });
      })
      .catch(() => setState({ kind: "gone" }));
  }, [token]);

  if (state.kind === "loading") return <div style={{ padding: 40 }}><Loading rows={3} /></div>;

  if (state.kind === "gone") {
    return (
      <div className="join-page">
        <h1>{ut("inf.formGone")}</h1>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div className="join-page">
        <h1>{ut("inf.formDone")}</h1>
      </div>
    );
  }

  const { survey } = state;
  const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers));
  const unanswered = visible.filter(
    (q) => q.type !== "info" && q.required && !isAnswered(q, answers.get(q.id)),
  );

  const pick = (questionId: string, optionId: string) =>
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(questionId, { questionId, optionIds: [optionId] });
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/informants/form/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: [...answers.values()].map((a) => ({
            ...a,
            durationMs: 0,
            changeCount: 0,
            visitCount: 1,
          })),
          startedAt,
          durationMs: Date.now() - new Date(startedAt).getTime(),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState({ kind: "done" });
    } catch {
      setError(ut("common.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="join-page">
      <h1>{survey.title}</h1>
      <p className="hint">
        {ut("inf.about")}: {state.about} · {ut(`inf.role.${state.role}` as never)}
      </p>
      <p className="hint">{ut("inf.formSub")}</p>
      {state.note ? <p className="muted">{state.note}</p> : null}

      {visible.map((q) =>
        q.type === "info" ? (
          <p key={q.id} className="muted">{q.title}</p>
        ) : (
          <div key={q.id} className="card">
            <p style={{ marginTop: 0 }}>
              {q.title}
              {q.required ? <span style={{ color: "var(--sev-severe)" }}> *</span> : null}
            </p>
            <div className="row tight" style={{ flexWrap: "wrap" }}>
              {q.options.map((o) => (
                <button
                  key={o.id}
                  className={answers.get(q.id)?.optionIds?.[0] === o.id ? "primary" : ""}
                  onClick={() => pick(q.id, o.id)}
                >
                  {o.text}
                </button>
              ))}
            </div>
          </div>
        ),
      )}

      {error ? <p className="error">{error}</p> : null}

      <button className="primary" disabled={busy || unanswered.length > 0} onClick={() => void submit()}>
        {ut("common.finish")}
      </button>
    </div>
  );
}
