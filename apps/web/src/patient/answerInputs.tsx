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
