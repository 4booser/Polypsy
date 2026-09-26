import { useEffect, useId, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { contentLangNotice, isAnswered, isQuestionVisible, type SurveyFull } from "@quizzy/shared";
import { api } from "../api";
import { Screen, useAction } from "../ui";
import { Button, Input, Textarea, TouchArea } from "../ui/primitives";
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
  const { ut, lang } = useLang();
  const navigate = useNavigate();
  const { run, busy } = useAction();

  const res = useResource(() => api.survey(id!), [id], { enabled: !!id });
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [step, setStep] = useState(0);
  const [startedAt] = useState(() => new Date().toISOString());
  const [enteredAt, setEnteredAt] = useState(() => Date.now());
  const [times] = useState<Map<string, number>>(new Map());
  const [done, setDone] = useState<{ safetyPlan: string | null } | null>(null);

  /*
   * Фокус переезжает на заголовок нового пункта.
   *
   * Было так: нажал «Дальше» с клавиатуры — вопрос сменился, а фокус упал в
   * body, потому что нажатая кнопка на мгновение пропадает из разметки.
   * Дальше человек начинает табуляцию с начала документа. На каждом из
   * сорока пяти пунктов СР-45. У МЛО пунктов двести.
   *
   * Диктору при этом не сообщалось ничего: живых областей на экране нет,
   * страница та же, разметка сменилась молча — человек слышит тишину и не
   * знает, случилось ли что-нибудь вообще.
   *
   * Перевод фокуса решает обе задачи разом: заголовок произносится вслух
   * (вместе с номером пункта — см. ниже), а табуляция продолжается с него,
   * то есть следующий Tab попадает на первый вариант ответа.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loaded = res.data !== null;
  useEffect(() => {
    headingRef.current?.focus();
  }, [step, loaded]);

  /* id заголовка: им называются поля ввода, у которых своей подписи нет */
  const titleId = useId();
  const helpId = useId();

  return (
    /*
      Прохождение живёт вне оболочки кабинета (свой маршрут, без нижних
      вкладок), поэтому зону пальца объявляет само. `contents` — чтобы
      обёртка не вмешивалась в раскладку: она нужна ради правила, а не ради
      коробки. Внутрь попадает и состояние загрузки Screen — у него своя
      кнопка «Повторить», и она такая же мишень.
    */
    <TouchArea className="contents">
      <Screen res={res}>
      {(survey: SurveyFull) => {
        const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers as never));
        const current = visible[step];
        /*
         * Английский интерфейс, а пункты — на украинском (английского текста
         * у методик нет, см. CONTENT_LANGS). Одной строкой под названием на
         * первом пункте: дальше человек уже знает, а повтор на каждом из
         * сорока пяти пунктов стал бы шумом.
         *
         * Тот же язык — атрибутом lang на тексте методики: страница
         * объявлена английской, и диктор читал бы украинские пункты
         * английским голосом, то есть неразборчиво (WCAG 3.1.2).
         */
        const foreign = contentLangNotice(lang, survey.contentLang);
        const partLang = foreign ?? undefined;

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
                  className="w-full"
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

        /*
         * «Вопрос 7 из 20» — словами и только для диктора.
         *
         * Информационные пункты не нумеруются вопросами: у них нет ответа, и
         * назвать такой пункт вопросом значило бы соврать. Так же считает
         * мобильное приложение — строки те же самые.
         */
        const position =
          current.type === "info"
            ? ut("runner.info")
            : `${ut("runner.question")} ${step + 1} ${ut("common.of")} ${visible.length}`;

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
                /* размер мишени задаёт зона (44×44), здесь только вид значка внутри неё */
                className="grid shrink-0 place-items-center rounded-md text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-[var(--focus)] [&>svg]:size-[18px]"
              >
                <IconClose />
              </button>
              {/*
                Полоса названа ролью и значением.

                Для зрячего это по-прежнему просто полоса без числа — решение
                выше остаётся в силе. Но диктор полосу не видит вовсе: до
                этого он не сообщал о продвижении ничего, и человек отвечал
                на сорок пять пунктов вслепую, не зная, идёт ли он к концу.
                aria-valuetext даёт ему то самое «пункт 7 из 20», которое на
                экране показывать не хотим, — числом, не пугающим никого,
                кроме того, кто его спросил.
              */}
              <div
                role="progressbar"
                aria-label={ut("pw.progress")}
                aria-valuemin={0}
                aria-valuemax={visible.length}
                aria-valuenow={step + 1}
                aria-valuetext={position}
                className="h-1 flex-1 overflow-hidden rounded-full bg-primary-soft"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-[var(--dur)]"
                  style={{ width: `${((step + 1) / visible.length) * 100}%` }}
                />
              </div>
            </div>

            <div className="flex-1">
              <p lang={partLang} className="mb-2 text-caption text-muted">
                {survey.title}
              </p>
              {foreign && step === 0 ? (
                <p className="mb-3 text-caption text-muted">{ut(`contentLang.${foreign}`)}</p>
              ) : null}
              {/*
                tabIndex={-1} — чтобы сюда можно было увести фокус после смены
                пункта. Мышью на заголовок не попасть: -1 убирает его из
                табуляции, оставляя доступным программно.
              */}
              <h1
                ref={headingRef}
                id={titleId}
                tabIndex={-1}
                className="mb-6 text-balance rounded-sm font-display text-[21px] font-medium leading-[1.3] tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              >
                <span className="sr-only">{position}. </span>
                <span lang={partLang}>{current.title}</span>
              </h1>
              {current.help ? (
                <p id={helpId} lang={partLang} className="mb-4 text-small text-muted">
                  {current.help}
                </p>
              ) : null}

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
                        <span lang={partLang}>{o.text}</span>
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
                  /*
                    Имя поля — сам вопрос, через aria-labelledby.

                    Field здесь не подходит: его подпись видна, а вопрос уже
                    напечатан заголовком во весь экран — вторая копия того же
                    текста под ним читалась бы как ошибка. Поэтому поле
                    ссылается на заголовок. Без этой ссылки диктор произносил
                    «поле ввода» и человек не знал, что туда писать, — на
                    экране, который весь состоит из одного вопроса.
                  */
                  <Input
                    type="number"
                    inputMode="numeric"
                    aria-labelledby={titleId}
                    aria-describedby={current.help ? helpId : undefined}
                    className="h-12"
                    value={a?.number ?? ""}
                    onChange={(e) =>
                      set({ number: e.target.value === "" ? undefined : Number(e.target.value) })
                    }
                  />
                ) : current.type === "info" ? null : (
                  <Textarea
                    rows={4}
                    aria-labelledby={titleId}
                    aria-describedby={current.help ? helpId : undefined}
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
    </TouchArea>
  );
}
