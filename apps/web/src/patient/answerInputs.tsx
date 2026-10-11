import { useId } from "react";
import type { Answer, Question } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { Input } from "../ui/primitives";
import { IconCheck } from "./icons";

/**
 * Матрица, ранжирование и дата в прохождении кабинета (#168).
 *
 * Runner знал три ветки: варианты — кнопками, шкала и число — числом, всё
 * прочее — текстом. Матрица рисовалась строкой кнопок без строк и
 * складывала ответ в optionIds; isAnswered ждёт answer.matrix, и «Далі» на
 * обязательной матрице не включалось никогда — демо-методика «Скрининг
 * эмоционального состояния» запиралась на первом пункте. Ранжирование и
 * дата тоже не считались отвеченными, а у необязательной матрицы балл
 * пропадал.
 *
 * Форма ответа — та же, что собирает мобилка (apps/mobile/src/components/
 * QuestionInput.tsx) и ждёт сервер: matrix — { id строки: id столбца },
 * ranking — id вариантов по порядку, date — ГГГГ-ММ-ДД. Балл считает общий
 * движок (packages/shared/src/scoring.ts) по этой форме, поэтому он и
 * совпадает с мобилкой.
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

interface InputProps {
  question: Question;
  answer: RunnerAnswer | undefined;
  onChange: (next: RunnerAnswer) => void;
  /** Язык текста методики, если он не язык интерфейса (Runner, contentLangNotice) */
  partLang?: string;
}

/* вид кнопки варианта — тот же, что у вариантов одиночного выбора в Runner */
const choiceClass = (picked: boolean) =>
  cx(
    "flex min-h-[48px] w-full items-center justify-between gap-2 rounded-[10px] border px-3 py-2 text-left",
    "transition-colors duration-[var(--dur-fast)]",
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
    picked ? "border-primary bg-primary-soft font-medium text-text" : "border-hairline bg-surface-2 hover:border-border-strong",
  );

/** Отметка, а не только цвет: выбранное должно читаться и тем, кто цвет не различает */
function Picked() {
  return (
    <span aria-hidden className="shrink-0 text-primary [&>svg]:size-4">
      <IconCheck />
    </span>
  );
}

/**
 * Матрица: строка — подпись группы, под ней столбцы кнопками в две колонки.
 * Столбцы матрицы — длинные «більше половини днів», и в ряд на телефоне они
 * не помещаются; две колонки читаются без переноса через слово.
 */
export function MatrixInput({ question, answer, onChange, partLang }: InputProps) {
  const base = useId();
  const rows = question.options.filter((o) => o.kind === "row");
  const columns = question.options.filter((o) => o.kind === "option");
  return (
    <div className="flex flex-col gap-5">
      {rows.map((row) => (
        <div key={row.id} role="group" aria-labelledby={`${base}-${row.id}`} className="flex flex-col gap-2">
          <p id={`${base}-${row.id}`} lang={partLang} className="m-0 text-body font-medium">
            {row.text}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {columns.map((o) => {
              const picked = answer?.matrix?.[row.id] === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={picked}
                  onClick={() => onChange(pickMatrix(answer, row.id, o.id))}
                  className={cx(choiceClass(picked), "text-small")}
                >
                  <span lang={partLang}>{o.text}</span>
                  {picked ? <Picked /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Ранжирование нажатиями по порядку, как в мобилке: наверху — уже
 * расставленные с номером места (нажатие снимает), ниже — оставшиеся.
 * Перетаскивания нет: пальцем на телефоне оно промахивается, а диктору
 * недоступно вовсе.
 */
export function RankingInput({ question, answer, onChange, partLang }: InputProps) {
  const { ut } = useLang();
  const choices = question.options.filter((o) => o.kind === "option");
  const order = answer?.ranking ?? [];
  const rest = choices.filter((o) => !order.includes(o.id));
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 mb-1 text-small text-muted">{ut("mqi.rankHint")}</p>
      {order.length ? (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {order.map((id, index) => {
            const option = choices.find((o) => o.id === id);
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-label={ut("qi.removeHint").replace("{n}", String(index + 1)).replace("{text}", option?.text ?? "")}
                  onClick={() => onChange(toggleRank(answer, id))}
                  className={choiceClass(true)}
                >
                  <span className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="grid size-6 shrink-0 place-items-center rounded-full bg-primary font-mono text-caption font-semibold tabular-nums text-primary-text"
                    >
                      {index + 1}
                    </span>
                    <span lang={partLang}>{option?.text}</span>
                  </span>
                  <span aria-hidden className="shrink-0 text-caption font-normal text-muted">
                    {ut("qi.remove")}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {rest.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-label={ut("qi.placeHint").replace("{text}", option.text).replace("{n}", String(order.length + 1))}
          onClick={() => onChange(toggleRank(answer, option.id))}
          className={choiceClass(false)}
        >
          <span lang={partLang}>{option.text}</span>
        </button>
      ))}
    </div>
  );
}

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
 * Было голое числовое поле: ни диапазона, ни подписей концов. У шкалы сна
 * с обратным ключом 0–10 «Дуже погано…Відмінно» человек не знал, где
 * «хорошо», — и ответ в обратную сторону инвертировал балл. Мобилка
 * показывала и деления, и подписи; теперь и кабинет: деления — кнопками
 * (как варианты ответа), подписи концов — под ними, с числом. Шкала, у
 * которой делений больше, чем помещается кнопками, — полем с границами и
 * видимым «від 0 до 100».
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
      <div className="flex justify-between gap-3 text-small text-muted">
        <span lang={partLang}>{low}</span>
        <span lang={partLang} className="text-right">
          {high}
        </span>
      </div>
    ) : null;

  if (points.length > SCALE_BUTTONS_MAX) {
    return (
      <div className="flex flex-col gap-2">
        <Input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={question.step ?? undefined}
          aria-labelledby={labelledBy}
          aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
          className="h-12"
          value={answer?.number ?? ""}
          onChange={(e) => onChange({ number: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
        <p id={hintId} className="m-0 text-small text-muted">
          {ut("qi.rangeHint").replace("{min}", String(min)).replace("{max}", String(max))}
        </p>
        {ends}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-labelledby={labelledBy} aria-describedby={describedBy} className="grid grid-cols-[repeat(auto-fit,minmax(44px,1fr))] gap-2">
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
                "grid min-h-[48px] place-items-center rounded-[10px] border font-mono text-body tabular-nums",
                "transition-colors duration-[var(--dur-fast)]",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                picked
                  ? "border-primary bg-primary font-semibold text-primary-text"
                  : "border-hairline bg-surface-2 hover:border-border-strong",
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
      className="h-12"
      value={answer?.date ?? ""}
      onChange={(e) => onChange(pickDate(e.target.value))}
    />
  );
}
