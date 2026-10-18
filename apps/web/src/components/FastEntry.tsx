import { useCallback, useEffect, useRef, useState } from "react";
import type { Answer, Question, SurveyFull } from "@quizzy/shared";
import { isAnswered } from "@quizzy/shared";
import { Rx } from "../pages/response/icons";
import { KbdHints, Tooltip } from "../ui";
import { cx } from "../ui/cx";
import { Button, ErrorText, Input } from "../ui/primitives";
import { useLang } from "../lang";

/**
 * Быстрый ввод бланка — клавиатурой, без мыши (Polypsy 2.0, кадр
 * methods-administer).
 *
 * Специалист переносит уже заполненный бумажный бланк. Двести пунктов МЛО
 * мышью — это двести прицельных щелчков по мелким кнопкам, и это ровно та
 * работа, где время уходит, а ошибка не видна: промахнулся по соседнему
 * варианту — и балл другой, а заметить нечем.
 *
 * Здесь цифра — это ответ, и пункт сам сменяется следующим. Двести пунктов —
 * двести нажатий, рука не покидает цифрового блока. Номер варианта на
 * плитке — это и есть клавиша. Мышью плитку тоже можно нажать.
 */

/** Варианты пункта, которые выбираются (строки матрицы — нет) */
export const choicesOf = (q: Question) => q.options.filter((o) => o.kind === "option");

/** Пункты, которые вводятся: без информационных */
export const askedOf = (survey: SurveyFull) => survey.questions.filter((q) => q.type !== "info");

/** Сколько ячеек пунктов видно в строке над вопросом: у длинной методики — окно вокруг текущего */
const CELLS = 14;

export function FastEntry({
  survey,
  answers,
  onSet,
  at,
  setAt,
  focusTick = 0,
}: {
  survey: SurveyFull;
  answers: Map<string, Answer>;
  onSet: (questionId: string, patch: Partial<Answer>) => void;
  /** Текущий пункт — у экрана: таблица «Усі пункти» тоже переводит к пункту */
  at: number;
  setAt: (next: number | ((prev: number) => number)) => void;
  /** Растёт, когда человек снова выбрал быстрый ввод: фокус возвращается в поле, а не остаётся на кнопке */
  focusTick?: number;
}) {
  const { ut } = useLang();
  const asked = askedOf(survey);
  const [typed, setTyped] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  const q = asked[at];
  const choices = q ? choicesOf(q) : [];
  const isChoice = choices.length > 0;

  /* фокус держится на поле: рука не уходит с клавиатуры */
  useEffect(() => {
    fieldRef.current?.focus();
    setTyped("");
  }, [at]);
  useEffect(() => {
    if (focusTick) fieldRef.current?.focus();
  }, [focusTick]);

  const advance = useCallback(() => {
    setAt((i) => Math.min(asked.length - 1, i + 1));
  }, [asked.length, setAt]);

  const pick = (question: Question, optionId: string) => {
    const before = answers.get(question.id)?.optionIds ?? [];
    onSet(question.id, {
      optionIds:
        question.type === "multiple"
          ? before.includes(optionId)
            ? before.filter((x) => x !== optionId)
            : [...before, optionId]
          : [optionId],
    });
    /* множественный выбор не уводит фокус: там ответов несколько */
    if (question.type !== "multiple") advance();
  };

  const applyTyped = () => {
    if (!q || !typed.trim()) return;
    if (["scale", "slider", "number"].includes(q.type)) {
      onSet(q.id, { number: Number(typed) });
    } else {
      onSet(q.id, { text: typed });
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!q) return;

    if (e.key === "Backspace" && !typed) {
      e.preventDefault();
      setAt((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      if (!isChoice && typed.trim()) applyTyped();
      advance();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt((i) => Math.max(0, i - 1));
      return;
    }

    if (isChoice && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const option = choices[Number(e.key) - 1];
      /*
       * Несуществующий вариант не выбирается молча. Нажать «5» там, где
       * вариантов четыре, — обычная опечатка при переносе бланка, и
       * проглотить её значит записать не тот балл.
       */
      if (!option) return;
      pick(q, option.id);
    }
  };

  /**
   * Вставка строки ответов целиком.
   *
   * Так работает тот, у кого бланки уже сведены в таблицу. Строка либо
   * подходит целиком, либо не применяется вовсе: заполнить половину и
   * оставить человека разбираться, где обрыв, хуже, чем не заполнить ничего.
   */
  const applyPaste = () => {
    setPasteError(null);
    const raw = pasteText.trim();
    if (!raw) return;
    const parts = raw.includes(",") || raw.includes(" ") ? raw.split(/[,\s]+/).filter(Boolean) : raw.split("");

    if (parts.length !== asked.length) {
      setPasteError(ut("fast.pasteCount").replace("{got}", String(parts.length)).replace("{need}", String(asked.length)));
      return;
    }

    /* сначала проверяем всю строку, потом применяем: частичная запись хуже отказа */
    const planned: [string, Partial<Answer>][] = [];
    for (let i = 0; i < asked.length; i += 1) {
      const question = asked[i]!;
      const value = parts[i]!;
      const opts = choicesOf(question);
      if (opts.length) {
        const idx = Number(value) - 1;
        const option = opts[idx];
        if (!Number.isInteger(idx) || !option) {
          setPasteError(ut("fast.pasteBadAt").replace("{n}", String(i + 1)).replace("{value}", value));
          return;
        }
        planned.push([question.id, { optionIds: [option.id] }]);
      } else if (["scale", "slider", "number"].includes(question.type)) {
        const n = Number(value);
        if (Number.isNaN(n)) {
          setPasteError(ut("fast.pasteBadAt").replace("{n}", String(i + 1)).replace("{value}", value));
          return;
        }
        planned.push([question.id, { number: n }]);
      } else {
        planned.push([question.id, { text: value }]);
      }
    }
    for (const [id, patch] of planned) onSet(id, patch);
    setPasteText("");
  };

  if (!q) return null;

  const from = asked.length <= CELLS ? 0 : Math.max(0, Math.min(at - Math.floor(CELLS / 3), asked.length - CELLS));
  const shown = asked.slice(from, from + CELLS);
  const picked = answers.get(q.id)?.optionIds ?? [];

  return (
    <div className="flex flex-col">
      <ol className="m-0 flex list-none gap-1.5 p-0" aria-label={ut("adx.items")}>
        {shown.map((item, k) => {
          const i = from + k;
          const a = answers.get(item.id);
          const done = isAnswered(item, a);
          const opts = choicesOf(item);
          const key = done && a?.optionIds?.length === 1 ? opts.findIndex((o) => o.id === a.optionIds![0]) + 1 : null;
          const critical = opts.some((o) => o.riskFlag);
          /* критический вариант выбран — ячейка красным: это риск для человека, а не оформление */
          const risky = done && opts.some((o) => o.riskFlag && (a?.optionIds ?? []).includes(o.id));
          const current = i === at;
          const body = (
            <button
              type="button"
              aria-current={current ? "step" : undefined}
              aria-label={ut("adx.goItem").replace("{n}", String(i + 1))}
              onClick={() => setAt(i)}
              className={cx(
                "grid h-[34px] w-full min-w-[30px] cursor-pointer place-items-center rounded-[9px] border-0 text-[13px] font-extrabold leading-none tabular-nums",
                current
                  ? "bg-panel text-violet-ink shadow-[inset_0_0_0_2px_var(--v)]"
                  : risky
                    ? "bg-risk-tint text-risk-ink shadow-[inset_0_0_0_1px_var(--riskline)]"
                    : done
                      ? "bg-violet-tint text-violet-ink"
                      : critical
                        ? "bg-sunk text-risk-ink shadow-[inset_0_0_0_1px_var(--riskline)]"
                        : "bg-sunk text-muted hover:bg-sunk-2",
              )}
            >
              {done && !current ? (key && key > 0 ? key : <Rx.listChecks size={13} />) : critical && !current ? <Rx.siren size={14} /> : i + 1}
            </button>
          );
          return (
            <li key={item.id} className="min-w-0 flex-1">
              {critical ? <Tooltip label={ut("adx.criticalItem").replace("{n}", String(i + 1))}>{body}</Tooltip> : body}
            </li>
          );
        })}
      </ol>

      {q.help ? <p className="m-0 mt-3.5 text-small text-muted">{q.help}</p> : null}
      <p className="m-0 mt-2 text-[20px] font-extrabold leading-7 tracking-[-0.015em] text-text [text-wrap:balance]">{q.title}</p>

      {/*
        Варианты пронумерованы, и номер — это клавиша. Номер стоит перед
        текстом, а не после: глаз ищет цифру, палец уже на ней.
      */}
      {isChoice ? (
        <div role="group" aria-label={ut("adx.answerTo").replace("{n}", String(at + 1))} className="mt-3.5 grid grid-cols-2 gap-2 max-[700px]:grid-cols-1">
          {choices.map((o, i) => {
            const on = picked.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                aria-pressed={on}
                onClick={() => pick(q, o.id)}
                className={cx(
                  "flex min-h-[52px] cursor-pointer items-center gap-3 whitespace-normal rounded-[12px] border-0 py-2 pl-3 pr-3.5 text-left text-[14px] font-bold leading-[18px] transition-colors duration-[var(--dur-fast)]",
                  on ? "bg-violet-tint text-violet-ink shadow-[inset_0_0_0_1.5px_var(--v)]" : "bg-sunk text-text hover:bg-sunk-2",
                  o.riskFlag && !on && "text-text",
                )}
              >
                <span
                  className={cx(
                    "grid size-7 shrink-0 place-items-center rounded-[8px] text-[14px] font-extrabold",
                    on ? "bg-violet text-onfill" : "bg-panel text-text-2 shadow-[inset_0_0_0_1px_var(--ctl)]",
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  {o.text}
                  {o.riskFlag ? (
                    <span className="ml-1.5 inline-flex translate-y-0.5 text-risk-ink">
                      <Rx.siren size={13} />
                      <span className="sr-only">{ut("mark.critical")}</span>
                    </span>
                  ) : null}
                </span>
                {o.score !== null && o.score !== undefined ? (
                  <small className="shrink-0 text-caption font-semibold text-muted">{ut("adx.points").replace("{n}", String(o.score))}</small>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Input
          ref={fieldRef}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={onKey}
          placeholder={isChoice ? ut("fast.hint") : ut("fast.typeValue")}
          aria-label={ut("fast.mode")}
          className="min-w-[220px] flex-1"
        />
      </div>
      <KbdHints
        className="mt-2.5"
        keys={[
          [isChoice ? `1 ${choices.length}` : "Enter", isChoice ? ut("adx.keyAnswer") : ut("adx.keyNext")],
          ["Backspace", ut("adx.keyBack")],
          ["↑ ↓", ut("adx.keyMove")],
        ]}
      />

      <div className="-mx-4 -mb-4 mt-4 rounded-b-panel border-t border-divider bg-panel-2 px-4 pb-4 pt-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <label className="whitespace-nowrap text-small font-extrabold text-text" htmlFor="fast-paste">
            {ut("fast.paste")}
          </label>
          <Input
            id="fast-paste"
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              setPasteError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyPaste();
              }
            }}
            placeholder={ut("fast.pasteHint")}
            aria-invalid={pasteError ? true : undefined}
            aria-describedby={pasteError ? "fast-paste-error" : undefined}
            className="min-w-[200px] flex-1"
          />
          <Button size="xs" disabled={!pasteText.trim()} onClick={applyPaste}>
            {ut("fast.pasteApply")}
          </Button>
        </div>
        {pasteError ? (
          <ErrorText id="fast-paste-error" className="mt-2">
            {pasteError}
          </ErrorText>
        ) : null}
      </div>
    </div>
  );
}
