import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { isAnswered, isQuestionVisible, type SurveyFull } from "@quizzy/shared";
import { api } from "../api";
import { Screen, useAction } from "../ui";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { cx } from "../ui/cx";

/**
 * Прохождение методики на телефоне: один пункт на экран.
 *
 * Не список с прокруткой, и это главное решение здесь. У PCL-5 двадцать
 * пунктов, у «большой пятёрки» пятьдесят; списком человек видит, сколько
 * ещё осталось, и на десятом начинает отмечать не глядя — а движок как раз
 * и ловит такие протоколы как недостоверные. Один пункт на экран убирает и
 * ощущение бесконечности, и промахи по соседней кнопке.
 *
 * Время на каждый пункт замеряется отдельно: по нему считается
 * достоверность, и без него протокол выглядит пройденным мгновенно.
 */

interface Answer {
  optionIds?: string[];
  number?: number;
  text?: string;
}

export default function Runner() {
  const { id } = useParams<{ id: string }>();
  const { ut } = useLang();
  const navigate = useNavigate();
  const { run, busy } = useAction();

  const res = useResource(() => api.survey(id!), [id], { enabled: !!id });
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [step, setStep] = useState(0);
  const [startedAt] = useState(() => new Date().toISOString());
  const [enteredAt, setEnteredAt] = useState(() => Date.now());
  const [times] = useState<Map<string, number>>(new Map());
  const [done, setDone] = useState<{ safetyPlan: string | null } | null>(null);

  return (
    <Screen res={res}>
      {(survey: SurveyFull) => {
        const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers as never));
        const current = visible[step];

        if (done) {
          return (
            <div className="mx-auto flex max-w-md flex-col gap-4 p-4">
              <h1 className="font-display text-page font-semibold">{ut("pw.thanks")}</h1>
              {/*
                Баллов человеку не показываем. Что именно показывать, решает
                сама методика (showResultsToPatient), а «спасибо» без цифры —
                честный ответ: интерпретирует результат специалист.
              */}
              <p className="text-muted">{ut("pw.handed")}</p>
              {done.safetyPlan ? (
                <div className="rounded-sm border border-warning bg-surface-2 p-3 text-small">
                  {done.safetyPlan}
                </div>
              ) : null}
              <Button variant="primary" onClick={() => navigate("/me/tests")}>
                {ut("pw.backToTests")}
              </Button>
            </div>
          );
        }

        if (!current) return <p className="p-4 text-muted">{ut("pw.empty")}</p>;

        const a = answers.get(current.id);
        const choices = current.options.filter((o) => o.kind === "option");
        const answered = current.type === "info" || isAnswered(current as never, a as never);
        const last = step === visible.length - 1;

        const remember = () => {
          times.set(current.id, (times.get(current.id) ?? 0) + (Date.now() - enteredAt));
          setEnteredAt(Date.now());
        };

        const set = (next: Answer) => {
          setAnswers((prev) => new Map(prev).set(current.id, { ...prev.get(current.id), ...next }));
        };

        const submit = () =>
          run(async () => {
            remember();
            const payload = visible
              .filter((q) => q.type !== "info")
              .map((q) => ({
                questionId: q.id,
                ...(answers.get(q.id) ?? {}),
                durationMs: times.get(q.id) ?? 0,
                changeCount: 0,
                visitCount: 1,
              }));
            const result = await api.submitResponse(survey.id, {
              startedAt,
              durationMs: Date.now() - new Date(startedAt).getTime(),
              answers: payload as never,
              events: [],
            });
            setDone({ safetyPlan: result.safetyPlan ?? null });
          }, ut("pw.sent"));

        return (
          <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col p-4">
            {/* полоса прогресса вместо «вопрос 7 из 20»: число впереди пугает */}
            <div className="mb-4 h-1 w-full overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full bg-primary transition-[width] duration-[var(--dur)]"
                style={{ width: `${((step + 1) / visible.length) * 100}%` }}
              />
            </div>

            <div className="flex-1">
              <p className="mb-1 text-caption text-faint">{survey.title}</p>
              <h1 className="mb-4 text-balance font-display text-section font-semibold leading-tight">
                {current.title}
              </h1>
              {current.help ? <p className="mb-4 text-small text-muted">{current.help}</p> : null}

              <div className="flex flex-col gap-2">
                {choices.length ? (
                  choices.map((o) => {
                    const picked = a?.optionIds?.includes(o.id) ?? false;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        aria-pressed={picked}
                        onClick={() =>
                          set({
                            optionIds:
                              current.type === "multiple"
                                ? picked
                                  ? (a?.optionIds ?? []).filter((x) => x !== o.id)
                                  : [...(a?.optionIds ?? []), o.id]
                                : [o.id],
                          })
                        }
                        className={cx(
                          // высота под палец, а не под мышь: экран держат в руке
                          "min-h-[52px] w-full rounded-sm border px-4 py-3 text-left text-small",
                          "transition-colors duration-[var(--dur-fast)]",
                          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                          picked
                            ? "border-primary bg-surface-3 font-medium text-text"
                            : "border-border bg-surface hover:border-border-strong",
                        )}
                      >
                        {o.text}
                      </button>
                    );
                  })
                ) : ["scale", "slider", "number"].includes(current.type) ? (
                  <input
                    type="number"
                    inputMode="numeric"
                    className="h-12 w-full rounded-sm border border-border bg-surface px-3 text-small"
                    value={a?.number ?? ""}
                    onChange={(e) =>
                      set({ number: e.target.value === "" ? undefined : Number(e.target.value) })
                    }
                  />
                ) : current.type === "info" ? null : (
                  <textarea
                    rows={4}
                    className="w-full rounded-sm border border-border bg-surface p-3 text-small"
                    value={a?.text ?? ""}
                    onChange={(e) => set({ text: e.target.value })}
                  />
                )}
              </div>
            </div>

            <div className="sticky bottom-0 flex gap-2 bg-bg pt-4">
              {step > 0 ? (
                <Button
                  variant="quiet"
                  onClick={() => {
                    remember();
                    setStep(step - 1);
                  }}
                >
                  {ut("common.back")}
                </Button>
              ) : null}
              <span className="flex-1" />
              {last ? (
                <Button
                  variant="primary"
                  disabled={busy || (current.required && !answered)}
                  onClick={submit}
                >
                  {ut("pw.finish")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={current.required && !answered}
                  onClick={() => {
                    remember();
                    setStep(step + 1);
                  }}
                >
                  {ut("common.next")}
                </Button>
              )}
            </div>
          </div>
        );
      }}
    </Screen>
  );
}
