import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { isAnswered, isQuestionVisible, type SurveyFull } from "@quizzy/shared";
import { api } from "../api";
import { Screen, useAction } from "../ui";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { IconCheck, IconClose } from "./icons";
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
            /*
              Экран благодарности занимает высоту целиком и держит содержимое
              по центру, а действия — внизу.
              Это последнее, что человек видит, закончив отвечать про своё
              состояние: короткий текст в пустоте читается спокойнее, чем
              список, прижатый к верхнему краю.
            */
            <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col px-6 pb-[max(env(safe-area-inset-bottom),12px)] pt-16">
              <div className="flex flex-1 flex-col items-start justify-center gap-4">
                <span
                  aria-hidden
                  className="grid size-[52px] place-items-center rounded-full border border-primary text-primary shadow-[0_0_24px_color-mix(in_srgb,var(--primary)_40%,transparent)] [&>svg]:size-6"
                >
                  <IconCheck />
                </span>
                <h1 className="m-0 font-display text-page font-medium leading-[1.1] tracking-tight">
                  {ut("pw.thanks")}
                </h1>
                {/*
                  Баллов человеку не показываем. Что именно показывать, решает
                  сама методика (showResultsToPatient), а «спасибо» без цифры —
                  честный ответ: интерпретирует результат специалист.
                */}
                <p className="m-0 max-w-[30ch] text-muted">{ut("pw.handed")}</p>
                {done.safetyPlan ? (
                  <div className="w-full rounded-xl border border-warning bg-surface-2 p-3.5 text-small">
                    {done.safetyPlan}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-2.5 pt-4">
                <Button
                  variant="primary"
                  className="min-h-[48px] w-full"
                  onClick={() => navigate("/me/tests")}
                >
                  {ut("pw.backToTests")}
                </Button>
                <Button
                  variant="quiet"
                  className="min-h-[44px] w-full"
                  onClick={() => navigate("/me")}
                >
                  {ut("pt.home")}
                </Button>
              </div>
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
            {/*
              Полоса прогресса вместо «вопрос 7 из 20»: число впереди пугает.
              Рядом — выход. До него уйти с методики можно было только кнопкой
              «назад» в браузере: человек, открывший её случайно или
              передумавший, оставался внутри, и это читается как принуждение —
              последнее, что уместно в психологическом отделе.
            */}
            <div className="mb-5 flex items-center gap-3">
              <button
                type="button"
                aria-label={ut("pw.leave")}
                onClick={() => navigate("/me/tests")}
                className="grid size-8 shrink-0 place-items-center rounded-md text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-[var(--focus)] [&>svg]:size-[18px]"
              >
                <IconClose />
              </button>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-primary-soft">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-[var(--dur)]"
                  style={{ width: `${((step + 1) / visible.length) * 100}%` }}
                />
              </div>
            </div>

            <div className="flex-1">
              <p className="mb-2 text-caption text-muted">{survey.title}</p>
              <h1 className="mb-6 text-balance font-display text-[21px] font-medium leading-[1.3] tracking-tight">
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
                          "flex min-h-[52px] w-full items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left text-body",
                          "transition-colors duration-[var(--dur-fast)]",
                          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                          picked
                            ? "border-primary bg-primary-soft font-medium text-text"
                            : "border-hairline bg-surface-2 hover:border-border-strong",
                        )}
                      >
                        <span>{o.text}</span>
                        {/*
                          Отметка, а не только цвет: выбранный вариант должен
                          читаться и тем, кто цвет не различает.
                        */}
                        {picked ? (
                          <span aria-hidden className="shrink-0 text-primary [&>svg]:size-4">
                            <IconCheck />
                          </span>
                        ) : null}
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

            <div className="sticky bottom-0 flex items-stretch gap-2.5 bg-bg pb-[max(env(safe-area-inset-bottom),8px)] pt-4">
              {step > 0 ? (
                <Button
                  variant="quiet"
                  className="min-h-[48px] px-5"
                  onClick={() => {
                    remember();
                    setStep(step - 1);
                  }}
                >
                  {ut("common.back")}
                </Button>
              ) : null}
              {last ? (
                <Button
                  variant="primary"
                  className="min-h-[48px] flex-1"
                  disabled={busy || (current.required && !answered)}
                  onClick={submit}
                >
                  {ut("pw.finish")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  className="min-h-[48px] flex-1"
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
