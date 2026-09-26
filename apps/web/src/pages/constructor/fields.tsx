import { createContext, useContext, type ReactNode } from "react";
import type { ContentLang } from "@quizzy/shared";
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
/*
 * Язык СОДЕРЖИМОГО, а не интерфейса: английского текста у методик нет
 * намеренно (CONTENT_LANGS в shared/types.ts), и поле, которое правило бы
 * ключ en, писало бы в пустоту — схема записи его отбрасывает.
 */
const EditLang = createContext<ContentLang>("uk");
export const EditLangProvider = EditLang.Provider;
export const useEditLang = () => useContext(EditLang);

/**
 * Текстовое поле теста на языке правки.
 *
 * Подпись видна плейсхолдером и остаётся именем поля для диктора — это делает
 * Field сам (см. пояснение к нему в primitives.tsx). Своего плейсхолдера здесь
 * нет намеренно: два разных текста — подпись и подсказка — на одном поле были
 * бы двумя именами.
 *
 * `above` — второй случай, и он с кадра: «Назва тесту» и «Опис тесту» на
 * f23_1/f24_1 набраны ВИДИМОЙ подписью 18/700 фиолетовым НАД пустым полем, а
 * поле под ней пустое. Тогда подпись перестаёт быть скрытой, а плейсхолдера
 * внутри поля нет: тот же текст дважды — один раз глазу над полем, другой раз
 * внутри — читался бы как два разных поля.
 */
export function Loc({
  label,
  above,
  value,
  onChange,
  multiline,
  rows,
  hint,
  className,
}: {
  label: string;
  /** Печатать подпись видимой строкой над полем (кадры f23_1, f24_1) */
  above?: boolean;
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
  const field = multiline ? (
    <Textarea value={current} rows={rows ?? 4} onChange={(e) => set(e.target.value)} />
  ) : (
    <Input value={current} onChange={(e) => set(e.target.value)} />
  );
  if (!above) {
    return (
      <Field label={label} hint={hint} className={className}>
        {field}
      </Field>
    );
  }
  /*
   * Видимая подпись — та же подпись Field, только не скрытая: она по-прежнему
   * оборачивает поле и по-прежнему его называет. Заводить рядом отдельный
   * заголовок и связывать его с полем через aria-labelledby значило бы
   * назвать поле дважды тем же словом.
   */
  return (
    <Field label={label} hint={hint} className={className} labelClassName="mb-[14px] block text-[18px] font-bold leading-tight text-primary">
      {field}
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
