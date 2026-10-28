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

/**
 * С какого числа нумеруются варианты: клавиши быстрого ввода, цифры на плитках
 * и строка ответов целиком.
 *
 * Специалист переносит бумажный бланк, а на бланке HAM-D, HAM-A, PHQ-9, PCL-5
 * у вариантов напечатаны баллы с нуля. Нумерация с единицы заставляла
 * прибавлять единицу в уме к каждому пункту, и ошибка на единицу молча
 * ложилась в балл: у HAM-D клавиша «1» ставила 0 баллов. Поэтому методика, у
 * которой каждый пункт с выбором считает варианты подряд с нуля — в прямом
 * порядке или в обратном (у обратного пункта на бланке те же колонки), —
 * нумеруется с нуля. Остальные, как прежде, с единицы: шкалы 1–7 (CGI, BPRS),
 * неравные баллы вариантов (ASSIST) и пункты «так / ні». У последних баллы
 * тоже 1 и 0, но на бланке МЛО и Міні-мульта цифр нет, а «0 — так» перевернуло
 * бы двести привычных нажатий; поэтому с нуля — только шкалы от трёх
 * вариантов. Решение одно на всю методику, а не на пункт: в одном бланке
 * клавиши не должны менять смысл.
 */
export function keyBase(asked: readonly Question[]): 0 | 1 {
  const withChoices = asked.map(choicesOf).filter((opts) => opts.length > 0);
  if (!withChoices.length) return 1;
  const fromZero = withChoices.every((opts) => {
    const n = opts.length;
    if (n < 3) return false;
    return opts.every((o, i) => o.score === i) || opts.every((o, i) => o.score === n - 1 - i);
  });
  return fromZero ? 0 : 1;
}

/** Сколько ячеек пунктов видно в строке над вопросом: у длинной методики — окно вокруг текущего */
const CELLS = 14;

/** Что вышло из строки ответов: ответы по пунктам или почему строка не подходит целиком */
export type PastePlan =
  | { ok: true; planned: [string, Partial<Answer>][] }
  | { ok: false; error: { kind: "count"; got: number; need: number } | { kind: "bad"; at: number; value: string } };

/**
 * Строка ответов целиком — по пунктам, или отказ с причиной.
 *
 * Делители — запятая и любой пробельный знак, в том числе табуляция: строка,
 * скопированная из таблицы, приходит именно с ней, а «так работает тот, у
 * кого бланки уже сведены в таблицу». Прежде делитель искался только среди
 * запятой и пробела, и строка из таблицы резалась по знаку — табуляции
 * считались ответами, и выходило «вставлено 7 из 4». Без делителей вовсе —
 * по одному знаку на пункт («2130»).
 *
 * Номер варианта — среди вариантов-ответов (строки матрицы не в счёт) и с
 * того же числа, что цифра быстрого ввода (keyBase): строка и клавиши читают
 * бланк одинаково.
 */
export function planPaste(asked: readonly Question[], raw: string): PastePlan | null {
  const text = raw.trim();
  if (!text) return null;
  const parts = /[,\s]/.test(text) ? text.split(/[,\s]+/).filter(Boolean) : text.split("");
  if (parts.length !== asked.length) return { ok: false, error: { kind: "count", got: parts.length, need: asked.length } };

  /* сначала проверяем всю строку, потом применяем: частичная запись хуже отказа */
  const planned: [string, Partial<Answer>][] = [];
  const base = keyBase(asked);
  for (let i = 0; i < asked.length; i += 1) {
    const question = asked[i]!;
    const value = parts[i]!;
    const opts = choicesOf(question);
    if (opts.length) {
      const option = /^\d+$/.test(value) ? opts[Number(value) - base] : undefined;
      if (!option) return { ok: false, error: { kind: "bad", at: i + 1, value } };
      planned.push([question.id, { optionIds: [option.id] }]);
    } else if (["scale", "slider", "number"].includes(question.type)) {
      const n = Number(value);
      if (Number.isNaN(n)) return { ok: false, error: { kind: "bad", at: i + 1, value } };
      planned.push([question.id, { number: n }]);
    } else {
      planned.push([question.id, { text: value }]);
    }
  }
  return { ok: true, planned };
}

export function FastEntry({
  survey,
  answers,
  onSet,
  at,
  setAt,
  focusTick = 0,
  focusOnMount = true,
}: {
  survey: SurveyFull;
  answers: Map<string, Answer>;
  onSet: (questionId: string, patch: Partial<Answer>) => void;
  /** Текущий пункт — у экрана: таблица «Усі пункти» тоже переводит к пункту */
  at: number;
  setAt: (next: number | ((prev: number) => number)) => void;
  /** Растёт, когда человек снова выбрал быстрый ввод: фокус возвращается в поле, а не остаётся на кнопке */
  focusTick?: number;
  /**
   * Взять фокус сразу при появлении. false — пока не выбран пациент: первым
   * набирают его (поле «Кого обстежуємо»), а после выбора экран сам вернёт
   * фокус сюда через focusTick.
   */
  focusOnMount?: boolean;
}) {
  const { ut } = useLang();
  const asked = askedOf(survey);
  const [typed, setTyped] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  const q = asked[at];
  const choices = q ? choicesOf(q) : [];
  const base = keyBase(asked);
  const isChoice = choices.length > 0;

  /*
   * Фокус держится на поле: рука не уходит с клавиатуры. При появлении — по
   * focusOnMount; сравнение с прежним пунктом, а не флаг «уже было»: в
   * StrictMode эффект при появлении зовётся дважды.
   */
  const shownAt = useRef(at);
  useEffect(() => {
    if (shownAt.current !== at || focusOnMount) fieldRef.current?.focus();
    shownAt.current = at;
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

    if (isChoice && /^[0-9]$/.test(e.key)) {
      e.preventDefault();
      const option = choices[Number(e.key) - base];
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
    const plan = planPaste(asked, pasteText);
    if (!plan) return;
    if (!plan.ok) {
      const e = plan.error;
      setPasteError(
        e.kind === "count"
          ? ut("fast.pasteCount").replace("{got}", String(e.got)).replace("{need}", String(e.need))
          : ut("fast.pasteBadAt").replace("{n}", String(e.at)).replace("{value}", e.value),
      );
      return;
    }
    for (const [id, patch] of plan.planned) onSet(id, patch);
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
          const pickedAt = done && a?.optionIds?.length === 1 ? opts.findIndex((o) => o.id === a.optionIds![0]) : -1;
          const key = pickedAt >= 0 ? pickedAt + base : null;
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
              {done && !current ? (key !== null ? key : <Rx.listChecks size={13} />) : critical && !current ? <Rx.siren size={14} /> : i + 1}
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
                  {i + base}
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
          [isChoice ? `${base} ${choices.length - 1 + base}` : "Enter", isChoice ? ut("adx.keyAnswer") : ut("adx.keyNext")],
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
        {/* отказ строки — вслух: фокус остаётся в поле или на кнопке, и молча появившуюся строку диктор не прочтёт */}
        {pasteError ? (
          <div role="alert" className="mt-2">
            <ErrorText id="fast-paste-error">{pasteError}</ErrorText>
          </div>
        ) : null}
      </div>
    </div>
  );
}
