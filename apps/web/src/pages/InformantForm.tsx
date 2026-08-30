import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { isAnswered, isQuestionVisible, type Answer, type SurveyFull } from "@quizzy/shared";
import { useLang } from "../lang";
import { Loading } from "../ui";
import { Button, Panel } from "../ui/primitives";

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

  if (state.kind === "loading") {
    return (
      <div className="join-page">
        <div className="w-full max-w-[640px]">
          <Loading rows={3} />
        </div>
      </div>
    );
  }

  if (state.kind === "gone") {
    return (
      <div className="join-page">
        <div className="w-full max-w-[640px]">
          <h1 className="m-0">{ut("inf.formGone")}</h1>
        </div>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div className="join-page">
        <div className="w-full max-w-[640px]">
          <h1 className="m-0">{ut("inf.formDone")}</h1>
        </div>
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
      {/*
        Ширина ограничена, а не отдана на волю грид-центрирования .join-page:
        без общего контейнера каждый абзац и карточка центрировались бы по
        отдельности своей собственной шириной, и длинный вопрос растягивался
        почти во весь экран, пока короткая подпись оставалась узкой строкой.
      */}
      <div className="flex w-full max-w-[640px] flex-col gap-4">
        <div>
          <h1 className="m-0">{survey.title}</h1>
          <p className="m-0 mt-1.5 text-small text-muted">
            {ut("inf.about")}: {state.about} · {ut(`inf.role.${state.role}` as never)}
          </p>
          <p className="m-0 mt-1 text-small text-muted">{ut("inf.formSub")}</p>
          {state.note ? <p className="m-0 mt-1.5 text-small text-text-2">{state.note}</p> : null}
        </div>

        {visible.map((q) =>
          q.type === "info" ? (
            <p key={q.id} className="m-0 text-small text-muted">{q.title}</p>
          ) : (
            <Panel key={q.id} className="p-5">
              <p className="m-0 text-body">
                {q.title}
                {q.required ? <span className="text-danger"> *</span> : null}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {q.options.map((o) => (
                  <Button
                    key={o.id}
                    variant={answers.get(q.id)?.optionIds?.[0] === o.id ? "primary" : "ghost"}
                    onClick={() => pick(q.id, o.id)}
                  >
                    {o.text}
                  </Button>
                ))}
              </div>
            </Panel>
          ),
        )}

        {error ? (
          <p role="alert" className="m-0 text-caption text-danger">
            {error}
          </p>
        ) : null}

        <Button
          variant="primary"
          className="w-full"
          disabled={busy || unanswered.length > 0}
          onClick={() => void submit()}
        >
          {ut("common.finish")}
        </Button>
      </div>
    </div>
  );
}
