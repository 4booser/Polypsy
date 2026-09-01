import { useCallback, useEffect, useRef, useState } from "react";
import type { Answer, SurveyFull } from "@quizzy/shared";
import { Button, Input, Num } from "../ui/primitives";
import { useLang } from "../lang";

/**
 * Быстрый ввод бланка — клавиатурой, без мыши.
 *
 * Специалист переносит уже заполненный бумажный бланк. Двести пунктов МЛО
 * мышью — это двести прицельных щелчков по мелким кнопкам, и это ровно та
 * работа, где время уходит, а ошибка не видна: промахнулся по соседнему
 * варианту — и балл другой, а заметить нечем.
 *
 * Здесь цифра — это ответ, и фокус сам уходит на следующий пункт. Двести
 * пунктов — двести нажатий, рука не покидает цифрового блока.
 */
export function FastEntry({
  survey,
  answers,
  onSet,
}: {
  survey: SurveyFull;
  answers: Map<string, Answer>;
  onSet: (questionId: string, patch: Partial<Answer>) => void;
}) {
  const { ut } = useLang();
  const asked = survey.questions.filter((q) => q.type !== "info");
  const [at, setAt] = useState(0);
  const [typed, setTyped] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  const q = asked[at];
  const choices = q?.options.filter((o) => o.kind === "option") ?? [];
  const isChoice = choices.length > 0;

  /* фокус держится на поле: рука не уходит с клавиатуры */
  useEffect(() => {
    fieldRef.current?.focus();
    setTyped("");
  }, [at]);

  const advance = useCallback(() => {
    setAt((i) => Math.min(asked.length - 1, i + 1));
  }, [asked.length]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!q) return;

    if (e.key === "Backspace" && !typed) {
      e.preventDefault();
      setAt((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      if (!isChoice && typed.trim()) {
        applyTyped();
      }
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
      const idx = Number(e.key) - 1;
      const option = choices[idx];
      /*
       * Несуществующий вариант не выбирается молча. Нажать «5» там, где
       * вариантов четыре, — обычная опечатка при переносе бланка, и
       * проглотить её значит записать не тот балл.
       */
      if (!option) return;
      onSet(q.id, {
        optionIds:
          q.type === "multiple"
            ? (answers.get(q.id)?.optionIds ?? []).includes(option.id)
              ? (answers.get(q.id)?.optionIds ?? []).filter((x) => x !== option.id)
              : [...(answers.get(q.id)?.optionIds ?? []), option.id]
            : [option.id],
      });
      /* множественный выбор не уводит фокус: там ответов несколько */
      if (q.type !== "multiple") advance();
    }
  };

  const applyTyped = () => {
    if (!q || !typed.trim()) return;
    if (["scale", "slider", "number"].includes(q.type)) {
      onSet(q.id, { number: Number(typed) });
    } else {
      onSet(q.id, { text: typed });
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
    const parts = raw.includes(",") || raw.includes(" ")
      ? raw.split(/[,\s]+/).filter(Boolean)
      : raw.split("");

    if (parts.length !== asked.length) {
      setPasteError(
        ut("fast.pasteCount")
          .replace("{got}", String(parts.length))
          .replace("{need}", String(asked.length)),
      );
      return;
    }

    /* сначала проверяем всю строку, потом применяем: частичная запись хуже отказа */
    const planned: [string, Partial<Answer>][] = [];
    for (let i = 0; i < asked.length; i += 1) {
      const question = asked[i]!;
      const value = parts[i]!;
      const opts = question.options.filter((o) => o.kind === "option");
      if (opts.length) {
        const idx = Number(value) - 1;
        const option = opts[idx];
        if (!Number.isInteger(idx) || !option) {
          setPasteError(
            ut("fast.pasteBadAt").replace("{n}", String(i + 1)).replace("{value}", value),
          );
          return;
        }
        planned.push([question.id, { optionIds: [option.id] }]);
      } else if (["scale", "slider", "number"].includes(question.type)) {
        const n = Number(value);
        if (Number.isNaN(n)) {
          setPasteError(
            ut("fast.pasteBadAt").replace("{n}", String(i + 1)).replace("{value}", value),
          );
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

  const left = asked.filter((x) => {
    const a = answers.get(x.id);
    return !a || (!a.optionIds?.length && a.number === undefined && !a.text);
  }).length;

  if (!q) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2 text-caption text-muted">
        <span>
          {ut("fast.item")} <Num>{at + 1}</Num> {ut("fast.of")} <Num>{asked.length}</Num>
        </span>
        <span className="ml-auto">
          {left === 0 ? ut("fast.done") : `${ut("fast.left")} ${left}`}
        </span>
      </div>

      <p className="text-body">{q.title}</p>

      {/*
        Варианты пронумерованы, и номер — это клавиша. Номер стоит перед
        текстом, а не после: глаз ищет цифру, палец уже на ней.
      */}
      {isChoice ? (
        <div className="flex flex-wrap gap-2">
          {choices.map((o, i) => {
            const picked = answers.get(q.id)?.optionIds?.includes(o.id);
            return (
              <span
                key={o.id}
                className={`rounded-sm border px-2 py-1 text-caption ${
                  picked ? "border-primary text-primary" : "border-hairline text-muted"
                }`}
              >
                <Num className="mr-1.5">{i + 1}</Num>
                {o.text}
              </span>
            );
          })}
        </div>
      ) : null}

      <Input
        ref={fieldRef}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={onKey}
        placeholder={isChoice ? ut("fast.hint") : ut("fast.typeValue")}
        aria-label={ut("fast.mode")}
      />

      <div className="flex flex-col gap-2 rounded-md border border-hairline p-2">
        <label className="text-caption text-muted" htmlFor="fast-paste">
          {ut("fast.paste")}
        </label>
        <Input
          id="fast-paste"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={ut("fast.pasteHint")}
        />
        {pasteError ? <p className="text-caption text-bad">{pasteError}</p> : null}
        <Button size="sm" variant="ghost" onClick={applyPaste}>
          {ut("fast.pasteApply")}
        </Button>
      </div>
    </div>
  );
}
