import { useId, type KeyboardEvent, type ReactNode } from "react";
import type { Answer, Question } from "@quizzy/shared";
import { useLang } from "../lang";
import { Ic, Kbd } from "../ui";
import { cx } from "../ui/cx";
import { Input, Textarea } from "../ui/primitives";

/**
 * Поля ответа в прохождении кабинета — язык телефона «Виразної»
 * (vivid_pt_survey, pt-runner-question / matrix / types): большие плитки
 * 64 px, выбранное отмечено не только цветом, но и галочкой и жирным,
 * клавиши 1–9 подписаны прямо на плитке.
 *
 * Матрица, ранжирование и дата (#168): форма ответа — та же, что собирает
 * мобилка (apps/mobile/src/components/QuestionInput.tsx) и ждёт сервер:
 * matrix — { id строки: id столбца }, ranking — id вариантов по порядку,
 * date — ГГГГ-ММ-ДД. Балл считает общий движок (packages/shared/src/
 * scoring.ts) по этой форме, поэтому он и совпадает с мобилкой.
 */

/** Ответ на пункт прохождения — та часть Answer, которую набирает человек */
export type RunnerAnswer = Pick<Answer, "optionIds" | "number" | "text" | "date" | "matrix" | "ranking">;

/** Матрица: в строке выбран один столбец — как onChange мобилки */
export function pickMatrix(prev: RunnerAnswer | undefined, rowId: string, optionId: string): RunnerAnswer {
  return { matrix: { ...(prev?.matrix ?? {}), [rowId]: optionId } };
}

/** Ранжирование: нажатый вариант встаёт следующим по порядку, нажатый ещё раз — снимается */
export function toggleRank(prev: RunnerAnswer | undefined, optionId: string): RunnerAnswer {
  const order = prev?.ranking ?? [];
  return { ranking: order.includes(optionId) ? order.filter((id) => id !== optionId) : [...order, optionId] };
}

/** Дата — значение поля даты (ГГГГ-ММ-ДД); стёртое поле — ответа нет */
export function pickDate(value: string): RunnerAnswer {
  return { date: value || undefined };
}

/** Вариант по клавише 1–9: одиночный выбор — заменяет, множественный — переключает */
export function pickChoice(question: Pick<Question, "type">, prev: RunnerAnswer | undefined, optionId: string): RunnerAnswer {
  if (question.type !== "multiple") return { optionIds: [optionId] };
  const ids = prev?.optionIds ?? [];
  return { optionIds: ids.includes(optionId) ? ids.filter((x) => x !== optionId) : [...ids, optionId] };
}

interface InputProps {
  question: Question;
  answer: RunnerAnswer | undefined;
  onChange: (next: RunnerAnswer) => void;
  /** Язык текста методики, если он не язык интерфейса (Runner, contentLangNotice) */
  partLang?: string;
}

/* ─────────── плитка ответа ─────────── */

const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Плитка варианта (m-opt): выбранная — тонированная с кольцом 2, невыбранная — лист с ободом */
export function tileClass(picked: boolean, extra?: string): string {
  return cx(
    "flex w-full items-center gap-3.5 rounded-[16px] text-left text-text",
    "transition-[background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease)]",
    focusRing,
    picked
      ? "bg-violet-tint shadow-[inset_0_0_0_2px_var(--vring)]"
      : "bg-panel shadow-[inset_0_0_0_1px_var(--border),var(--shadow-panel)] hover:bg-panel-2 hover:shadow-[inset_0_0_0_1px_var(--ctl)]",
    extra,
  );
}

/**
 * Отметка выбора: круг (один ответ) или квадрат (несколько) — с галочкой, а
 * не только цветом: выбранное должно читаться и тем, кто цвет не различает.
 */
export function Mark({ picked, square, size = 26 }: { picked: boolean; square?: boolean; size?: 24 | 26 }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center transition-colors duration-[var(--dur-fast)]",
        size === 26 ? "size-[26px]" : "size-6",
        square ? "rounded-[7px]" : "rounded-full",
        picked ? "bg-violet text-onfill" : "bg-panel text-transparent shadow-[inset_0_0_0_2px_var(--ctl)]",
      )}
    >
      <Ic.check size={16} />
    </span>
  );
}

/**
 * Варианты ответа плитками: один — радиогруппа (стрелки двигают выбор), несколько —
 * кнопки-переключатели. На плитке — её клавиша (1–9): ею и выбирают.
 */
export function ChoiceInput({
  question,
  answer,
  onChange,
  partLang,
  labelledBy,
  describedBy,
}: InputProps & { labelledBy: string; describedBy?: string }) {
  const choices = question.options.filter((o) => o.kind === "option");
  const multiple = question.type === "multiple";
  const picked = (id: string) => answer?.optionIds?.includes(id) ?? false;
  /* одна остановка Tab на группу: на выбранном варианте или, пока выбора нет, на первом */
  const focusId = choices.find((o) => picked(o.id))?.id ?? choices[0]?.id;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (multiple) return;
    const keys: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    const step = keys[e.key];
    if (!step) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-opt]")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, (at < 0 ? -1 : at) + step))];
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.click();
  };

  return (
    <div
      role={multiple ? "group" : "radiogroup"}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onKeyDown={onKey}
      className="flex flex-col gap-2.5"
    >
      {choices.map((o, i) => {
        const on = picked(o.id);
        const common = {
          type: "button" as const,
          "data-opt": true,
          onClick: () => onChange(pickChoice(question, answer, o.id)),
          className: tileClass(on, "min-h-16 py-3 pl-4 pr-[18px]"),
        };
        const body = (
          <>
            <Mark picked={on} square={multiple} />
            <span
              lang={partLang}
              className={cx("min-w-0 flex-1 text-[17px] leading-[22px]", on ? "font-extrabold text-violet-ink" : "font-bold")}
            >
              {o.text}
            </span>
            {i < 9 ? (
              <Kbd className={cx("max-[760px]:hidden", on && "border-violet-line text-violet-ink")}>{String(i + 1)}</Kbd>
            ) : null}
          </>
        );
        return multiple ? (
          <button key={o.id} {...common} aria-pressed={on}>
            {body}
          </button>
        ) : (
          <button key={o.id} {...common} role="radio" aria-checked={on} tabIndex={o.id === focusId ? 0 : -1}>
            {body}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────── матрица ─────────── */

/**
 * Матрица: на широком экране — таблица (строка — один ответ, столбцы —
 * варианты), на телефоне — подпись строки и под ней варианты в две колонки:
 * «більше половини днів» в ряд не помещается. Строка — радиогруппа со
 * стрелками; подписи столбцов на широком экране — в шапке, а у ячейки
 * остаются именем для диктора.
 *
 * `active` — строка, куда идут клавиши 1–9 (Runner): последняя тронутая или
 * первая без ответа. `flagMissing` — подсветить строки без ответа: человек
 * уже начал отвечать, и пропущенная строка не должна потеряться.
 */
export function MatrixInput({
  question,
  answer,
  onChange,
  partLang,
  flagMissing,
  onRowFocus,
}: InputProps & { flagMissing?: boolean; onRowFocus?: (rowId: string) => void }) {
  const { ut } = useLang();
  const base = useId();
  const rows = question.options.filter((o) => o.kind === "row");
  const columns = question.options.filter((o) => o.kind === "option");
  const grid = "min-[760px]:grid-cols-[minmax(0,1fr)_repeat(var(--cols),minmax(76px,132px))]";

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    const step = keys[e.key];
    if (!step) return;
    const cells = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-cell]")];
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    const next = cells[Math.min(cells.length - 1, Math.max(0, (at < 0 ? -1 : at) + step))];
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.click();
  };

  return (
    <div
      style={{ ["--cols" as string]: String(columns.length) }}
      className="rounded-panel border border-border bg-panel pb-2.5 pt-1.5 shadow-panel max-[760px]:border-0 max-[760px]:bg-transparent max-[760px]:p-0 max-[760px]:shadow-none"
    >
      <div aria-hidden className={cx("hidden items-center gap-2 border-b border-divider px-4 pb-3 pt-2 min-[760px]:grid", grid)}>
        <span />
        {columns.map((c) => (
          <span key={c.id} lang={partLang} className="text-center text-[14px] font-bold leading-[18px] text-text-2">
            {c.text}
          </span>
        ))}
      </div>
      {rows.map((row) => {
        const chosen = answer?.matrix?.[row.id];
        const missing = !!flagMissing && !chosen;
        const focusId = chosen ?? columns[0]?.id;
        return (
          <div
            key={row.id}
            role="radiogroup"
            aria-labelledby={`${base}-${row.id}`}
            data-row={row.id}
            onKeyDown={onKey}
            onFocus={() => onRowFocus?.(row.id)}
            className={cx(
              "mx-1.5 mt-1 grid items-center gap-2 rounded-[14px] py-1.5 pl-4 pr-2.5 max-[760px]:mx-0 max-[760px]:mt-4 max-[760px]:grid-cols-2 max-[760px]:px-0",
              grid,
              missing && "bg-warn-tint max-[760px]:px-2.5 max-[760px]:py-2.5",
            )}
          >
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 max-[760px]:col-span-2">
              <span id={`${base}-${row.id}`} lang={partLang} className="text-[17px] font-bold leading-6 text-text">
                {row.text}
              </span>
              {missing ? (
                <span className="inline-flex h-6 items-center rounded-pill bg-warn-tint-2 px-[9px] text-[11.5px] font-bold text-warn">
                  {ut("ptw.noAnswerYet")}
                </span>
              ) : null}
            </span>
            {columns.map((c) => {
              const on = chosen === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={c.id === focusId ? 0 : -1}
                  data-cell
                  onClick={() => {
                    onRowFocus?.(row.id);
                    onChange(pickMatrix(answer, row.id, c.id));
                  }}
                  className={tileClass(
                    on,
                    cx(
                      "min-h-14 justify-center rounded-[14px] px-2 max-[760px]:justify-start max-[760px]:px-3 max-[760px]:py-2",
                      missing && !on && "shadow-[inset_0_0_0_1px_var(--warnline)]",
                    ),
                  )}
                >
                  <Mark picked={on} />
                  <span
                    lang={partLang}
                    className={cx(
                      "min-w-0 flex-1 text-left text-[15px] leading-5 min-[760px]:sr-only",
                      on ? "font-extrabold text-violet-ink" : "font-semibold",
                    )}
                  >
                    {c.text}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ─────────── ранжирование ─────────── */

/**
 * Ранжирование нажатиями по порядку, как в мобилке: нажатый вариант получает
 * следующее место, нажатый ещё раз — снимается. Варианты стоят на своих
 * местах, номер места — в круге: список не прыгает под пальцем.
 * Перетаскивания нет: пальцем на телефоне оно промахивается, а диктору
 * недоступно вовсе.
 */
export function RankingInput({ question, answer, onChange, partLang }: InputProps) {
  const { ut } = useLang();
  const choices = question.options.filter((o) => o.kind === "option");
  const order = answer?.ranking ?? [];
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 mb-1 text-[15px] leading-[22px] text-text-2">{ut("mqi.rankHint")}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {choices.map((option) => {
          const place = order.indexOf(option.id);
          const on = place >= 0;
          return (
            <li key={option.id}>
              <button
                type="button"
                aria-label={
                  on
                    ? ut("qi.removeHint").replace("{n}", String(place + 1)).replace("{text}", option.text)
                    : ut("qi.placeHint").replace("{text}", option.text).replace("{n}", String(order.length + 1))
                }
                onClick={() => onChange(toggleRank(answer, option.id))}
                className={tileClass(on, "min-h-14 px-4 py-2.5")}
              >
                <span
                  aria-hidden
                  className={cx(
                    "grid size-7 shrink-0 place-items-center rounded-full text-[14px] font-extrabold tabular-nums",
                    on ? "bg-violet text-onfill" : "bg-panel shadow-[inset_0_0_0_2px_var(--ctl)]",
                  )}
                >
                  {on ? place + 1 : null}
                </span>
                <span
                  lang={partLang}
                  className={cx("min-w-0 flex-1 text-[16px] leading-[22px]", on ? "font-extrabold text-violet-ink" : "font-bold")}
                >
                  {option.text}
                </span>
                {on ? (
                  <span aria-hidden className="shrink-0 text-[14px] font-semibold text-muted">
                    {ut("qi.remove")}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ─────────── шкала ─────────── */

/**
 * Сколько делений шкалы ещё рисуется кнопками. Шкала 0–10 — одиннадцать
 * кнопок, 0–20 — двадцать одна: два-три ряда под палец. Аналоговая шкала
 * 0–100 кнопками — уже стена из сотни мишеней; ей — числовое поле.
 */
export const SCALE_BUTTONS_MAX = 21;

/**
 * Деления шкалы и ползунка: от minValue до maxValue с шагом step, по тем же
 * умолчаниям, что у мобилки (QuestionInput, case "scale": 0, 10, 1). Счёт —
 * от начала, а не прибавлением шага: 0.1 + 0.1 + 0.1 в плавающей точке не
 * доходит до 0.3 ровно, и последнее деление терялось бы. Деления сверх
 * SCALE_BUTTONS_MAX не считаются: их всё равно не нарисовать кнопками.
 */
export function scalePoints(question: Pick<Question, "minValue" | "maxValue" | "step">): number[] {
  const min = question.minValue ?? 0;
  const max = question.maxValue ?? 10;
  const step = question.step && question.step > 0 ? question.step : 1;
  const points: number[] = [];
  for (let i = 0; min + i * step <= max + 1e-9 && points.length <= SCALE_BUTTONS_MAX; i++) {
    points.push(Math.round((min + i * step) * 100) / 100);
  }
  return points;
}

/** Подпись конца шкалы: «0 — Дуже погано». Число рядом со словом: ряд делений на телефоне переносится, и слово под краем уже не стоит у своей кнопки */
export function scaleEndLabel(value: number, label: string | null): string | null {
  return label?.trim() ? `${value} — ${label.trim()}` : null;
}

/**
 * Шкала и ползунок (#170).
 *
 * Деления — кнопками в ряд (sc11 «Виразної»), подписи концов — под ними, с
 * числом: у шкалы сна с обратным ключом 0–10 «Дуже погано…Відмінно» человек
 * должен видеть, где «хорошо». Шкала, у которой делений больше, чем
 * помещается кнопками, — полем с границами и видимым «від 0 до 100».
 */
export function ScaleInput({
  question,
  answer,
  onChange,
  partLang,
  labelledBy,
  describedBy,
}: InputProps & { labelledBy: string; describedBy?: string }) {
  const { ut } = useLang();
  const hintId = useId();
  const min = question.minValue ?? 0;
  const max = question.maxValue ?? 10;
  const points = scalePoints(question);
  const low = scaleEndLabel(min, question.minLabel);
  const high = scaleEndLabel(max, question.maxLabel);
  const ends =
    low || high ? (
      <div className="flex justify-between gap-3 text-[14px] font-semibold leading-5 text-text-2">
        <span lang={partLang}>{low}</span>
        <span lang={partLang} className="text-right">
          {high}
        </span>
      </div>
    ) : null;

  if (points.length > SCALE_BUTTONS_MAX) {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={question.step ?? undefined}
            aria-labelledby={labelledBy}
            aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
            className="h-12! w-[180px] rounded-[12px]! text-[18px]! font-extrabold tabular-nums"
            value={answer?.number ?? ""}
            onChange={(e) => onChange({ number: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
          <p id={hintId} className="m-0 text-[15px] leading-[22px] text-text-2">
            {ut("qi.rangeHint").replace("{min}", String(min)).replace("{max}", String(max))}
          </p>
        </div>
        {ends}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="group"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className="grid grid-cols-[repeat(auto-fit,minmax(44px,1fr))] gap-1.5"
      >
        {points.map((point) => {
          const picked = answer?.number === point;
          /* диктору — слово конца вместе с числом, а голое «7» — «7 з 10», как в мобилке */
          const label =
            (point === min ? low : null) ??
            (point === max ? high : null) ??
            ut("qi.pointOf").replace("{n}", String(point)).replace("{max}", String(max));
          return (
            <button
              key={point}
              type="button"
              aria-pressed={picked}
              aria-label={label}
              onClick={() => onChange({ number: point })}
              className={cx(
                "grid h-[52px] place-items-center rounded-[12px] text-[17px] font-extrabold tabular-nums",
                "transition-[background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease)]",
                focusRing,
                picked
                  ? "bg-violet text-onfill shadow-primary"
                  : "bg-panel text-text-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-panel-2 hover:shadow-[inset_0_0_0_1px_var(--ctl)]",
              )}
            >
              {point}
            </button>
          );
        })}
      </div>
      {ends}
    </div>
  );
}

/* ─────────── число, дата, текст ─────────── */

/** Число: поле под палец; имя поля — сам вопрос (aria-labelledby) */
export function NumberInput({
  answer,
  onChange,
  labelledBy,
  describedBy,
  question,
}: Pick<InputProps, "answer" | "onChange" | "question"> & { labelledBy: string; describedBy?: string }) {
  const { ut } = useLang();
  const hasRange = question.minValue !== null && question.minValue !== undefined && question.maxValue !== null && question.maxValue !== undefined;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        type="number"
        inputMode="decimal"
        min={question.minValue ?? undefined}
        max={question.maxValue ?? undefined}
        step={question.step ?? undefined}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className="h-12! w-[200px] rounded-[12px]! text-[18px]! font-extrabold tabular-nums"
        value={answer?.number ?? ""}
        onChange={(e) => onChange({ number: e.target.value === "" ? undefined : Number(e.target.value) })}
      />
      {hasRange ? (
        <span className="text-[15px] leading-[22px] text-text-2">
          {ut("qi.rangeHint").replace("{min}", String(question.minValue)).replace("{max}", String(question.maxValue))}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Дата — полем даты браузера: значение у него всегда ГГГГ-ММ-ДД, ровно то,
 * что мобилка просит набрать руками, а сервер разбирает (validateAnswerShape).
 * Имя поля — сам вопрос, как у числа и текста в Runner.
 */
export function DateInput({
  answer,
  onChange,
  labelledBy,
  describedBy,
}: Omit<InputProps, "question" | "partLang"> & { labelledBy: string; describedBy?: string }) {
  return (
    <Input
      type="date"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="h-12! w-[240px] max-w-full rounded-[12px]! text-[16px]!"
      value={answer?.date ?? ""}
      onChange={(e) => onChange(pickDate(e.target.value))}
    />
  );
}

/** Текст своими словами; имя поля — сам вопрос */
export function TextInput({
  answer,
  onChange,
  labelledBy,
  describedBy,
}: Omit<InputProps, "question" | "partLang"> & { labelledBy: string; describedBy?: string }) {
  return (
    <Textarea
      rows={4}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="rounded-[12px]! text-[16px]! leading-6"
      value={answer?.text ?? ""}
      onChange={(e) => onChange({ text: e.target.value })}
    />
  );
}

/** Информационный пункт: ответа нет, только пояснение того, что будет дальше */
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-panel bg-info-tint px-[18px] py-4 text-[17px] leading-[26px] text-text">
      <Ic.info size={20} className="mt-[3px] shrink-0 text-info" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
