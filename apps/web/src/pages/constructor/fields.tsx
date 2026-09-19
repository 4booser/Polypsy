import { createContext, useContext, type ReactNode } from "react";
import type { Lang } from "@quizzy/shared";
import { Field, Input, Textarea } from "../../ui/primitives";

/*
 * Язык, на котором сейчас правится текст теста.
 *
 * Прежде каждое поле было сдвоенным: слева украинский, справа русский. Макет
 * рисует одно поле и переключатель «Укр ▾» справа от вкладок — язык выбирают
 * один раз, а не в каждом поле. Хранение не изменилось: jsonb {uk, ru}, и
 * переключатель лишь решает, какой из двух ключей показывает поле. Второй
 * язык при этом не теряется — он ждёт своей очереди за переключателем, о чём
 * под ним написано.
 *
 * Контекст, а не проп через десять уровней: переключатель один на экран, а
 * полей — десятки, и пропс забыли бы на первом же новом поле.
 */
const EditLang = createContext<Lang>("uk");
export const EditLangProvider = EditLang.Provider;
export const useEditLang = () => useContext(EditLang);

/**
 * Текстовое поле теста на языке правки.
 *
 * Подпись видна плейсхолдером и остаётся именем поля для диктора — это делает
 * Field сам (см. пояснение к нему в primitives.tsx). Своего плейсхолдера здесь
 * нет намеренно: два разных текста — подпись и подсказка — на одном поле были
 * бы двумя именами.
 */
export function Loc({
  label,
  value,
  onChange,
  multiline,
  rows,
  hint,
  className,
}: {
  label: string;
  value: Record<string, string> | null | undefined;
  onChange: (v: Record<string, string>) => void;
  multiline?: boolean;
  rows?: number;
  hint?: ReactNode;
  className?: string;
}) {
  const lang = useEditLang();
  const v = value ?? {};
  const current = v[lang] ?? "";
  const set = (text: string) => onChange({ ...v, [lang]: text });
  return (
    <Field label={label} hint={hint} className={className}>
      {multiline ? (
        <Textarea value={current} rows={rows ?? 4} onChange={(e) => set(e.target.value)} />
      ) : (
        <Input value={current} onChange={(e) => set(e.target.value)} />
      )}
    </Field>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="size-4 shrink-0" />
      <span className="text-small text-text">{label}</span>
    </label>
  );
}
