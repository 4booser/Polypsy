import type { ReactNode } from "react";
import { cx } from "../../../ui/cx";

/*
 * Общие детали раздела «Люди й безпека»: раздел с линией, флажок строки,
 * загрузка файла из памяти.
 *
 * Раздел — тот же, что в карточке пациента (patientCard/PatientCard.tsx,
 * Section): заголовок 20/700 фиолетовым над линией 2px. Своей копией, а не
 * импортом: там он не экспортирован, и тянуть внутренности карточки в
 * техпанель ради шести строк разметки незачем.
 */

export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("border-t-2 border-primary-rule pb-[16px] pt-[24px]", className)}>
      <div className="mb-[14px] flex min-h-[27px] flex-wrap items-center justify-between gap-x-[24px] gap-y-[8px]">
        <h2 className="m-0 text-[20px] font-bold leading-[24px] text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Флажок строки: квадрат 22 в зоне нажатия 44, отмеченный — заливкой
 * primary внутри, как у выбора людей в группах (patientGroups/PersonGrid.tsx).
 *
 * Размер — с «!»: у наследия стоит `input[type=checkbox] { width: auto }`
 * селектором с атрибутом, и он сильнее одного класса.
 */
export function RowCheck({
  checked,
  mixed,
  onChange,
  label,
}: {
  checked: boolean;
  mixed?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="grid size-[44px] shrink-0 cursor-pointer place-items-center print:hidden">
      <input
        type="checkbox"
        checked={checked}
        aria-checked={mixed ? "mixed" : checked}
        onChange={onChange}
        aria-label={label}
        className={cx(
          "m-0 grid min-h-0 size-[22px]! appearance-none place-items-center rounded-[4px] border-2 border-border bg-[var(--bg)] p-0",
          "before:rounded-[2px] before:content-['']",
          mixed ? "before:h-[3px] before:w-[10px] before:bg-primary" : "before:size-[12px] checked:before:bg-primary",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2",
        )}
      />
    </label>
  );
}

/** Отдать текст файлом — из памяти, без похода на сервер (пароли, отчёт) */
export function saveText(text: string, name: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Строка-сообщение «пусто» — 13 серым, как у остальных списков техпанели */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 py-[16px] text-[13px] text-muted">{children}</p>;
}
