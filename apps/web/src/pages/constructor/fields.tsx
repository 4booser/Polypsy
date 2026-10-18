import { createContext, useContext, type ReactNode } from "react";
import type { ContentLang } from "@quizzy/shared";
import { useLang } from "../../lang";
import { Field, Input, Segmented, Switch, Textarea } from "../../ui/primitives";

/*
 * Язык, на котором сейчас правится текст теста.
 *
 * Поле одно, а не пара «украинский | русский»: язык выбирают один раз на
 * экран, а хранение остаётся парой jsonb {uk, ru} — переключатель лишь
 * решает, какой из двух ключей показывает каждое поле. Второй язык не
 * теряется, он ждёт за переключателем.
 *
 * Контекст, а не проп через десять уровней: полей — десятки, и проп забыли
 * бы на первом же новом. Переключатель стоит в нескольких местах экрана (в
 * «Основному», в раскрытом пункте — так на макете methods-constructor), и
 * все они правят одно и то же состояние экрана.
 *
 * Язык СОДЕРЖИМОГО, а не интерфейса: английского текста у методик нет
 * намеренно (CONTENT_LANGS в shared/types.ts), и поле, которое правило бы
 * ключ en, писало бы в пустоту — схема записи его отбрасывает.
 */
const EditLang = createContext<ContentLang>("uk");
const SetEditLang = createContext<((l: ContentLang) => void) | null>(null);

export function EditLangProvider({
  value,
  onChange,
  children,
}: {
  value: ContentLang;
  onChange?: (l: ContentLang) => void;
  children: ReactNode;
}) {
  return (
    <EditLang.Provider value={value}>
      <SetEditLang.Provider value={onChange ?? null}>{children}</SetEditLang.Provider>
    </EditLang.Provider>
  );
}
export const useEditLang = () => useContext(EditLang);

/**
 * Переключатель языка текста: «Українська | Російська» сегментами (макет
 * methods-constructor). Имя группы для диктора — «Мова тексту тесту»: по нему
 * его находит и смоук (e2e/helpers.ts, setEditLang).
 */
export function EditLangSwitch({ className }: { className?: string }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const set = useContext(SetEditLang);
  if (!set) return null;
  return (
    <Segmented
      label={ut("cn.editLang")}
      value={lang}
      onChange={set}
      className={className}
      items={[
        { key: "uk", label: ut("ce.langUk") },
        { key: "ru", label: ut("ce.langRu") },
      ]}
    />
  );
}

/**
 * Текстовое поле теста на языке правки.
 *
 * Подпись — видимая подпись набора над полем (12/700); `inline` прячет её в
 * плейсхолдер для поля в строке таблицы. Своего плейсхолдера здесь нет
 * намеренно: два разных текста — подпись и подсказка — на одном поле были бы
 * двумя именами.
 */
export function Loc({
  label,
  value,
  onChange,
  multiline,
  rows,
  hint,
  className,
  inline,
  inputClassName,
  id,
}: {
  label: string;
  value: Record<string, string> | null | undefined;
  onChange: (v: Record<string, string>) => void;
  multiline?: boolean;
  rows?: number;
  hint?: ReactNode;
  className?: string;
  inline?: boolean;
  inputClassName?: string;
  id?: string;
}) {
  const lang = useEditLang();
  const v = value ?? {};
  const current = v[lang] ?? "";
  const set = (text: string) => onChange({ ...v, [lang]: text });
  return (
    <Field label={label} hint={hint} className={className} inline={inline}>
      {multiline ? (
        <Textarea id={id} value={current} rows={rows ?? 4} onChange={(e) => set(e.target.value)} className={inputClassName} />
      ) : (
        <Input id={id} value={current} onChange={(e) => set(e.target.value)} className={inputClassName} />
      )}
    </Field>
  );
}

/** Переключатель настройки (role=switch набора) с подписью и пояснением */
export function Toggle({
  label,
  sub,
  value,
  onChange,
}: {
  label: string;
  sub?: ReactNode;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return <Switch checked={value} onChange={onChange} label={label} sub={sub} className="py-1.5" />;
}
