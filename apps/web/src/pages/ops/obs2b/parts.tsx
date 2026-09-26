import type { ReactNode } from "react";
import { cx } from "../../../ui/cx";

/**
 * Набор переключателей «несколько из нескольких»: каналы правила.
 *
 * Тот же силуэт, что у переключателя периода (dashboard/parts.tsx,
 * PeriodSwitch) — нажатая кнопка залита сиреневым, отжатая прозрачна, — но
 * каждая кнопка живёт сама по себе: Telegram и почта выбираются вместе.
 * Не галочки: у галочки макета квадрат задаётся стилем (см. PersonGrid), а
 * здесь две кнопки рядом с полями, и нажатая кнопка читается раньше
 * квадрата.
 */
export function ToggleSet<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-[4px]">
      {options.map(([v, text]) => {
        const on = value.includes(v);
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(v)}
            className={cx(
              "h-[36px] rounded-[5px] border-0 px-[12px] text-[15px] font-bold leading-none",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
              on ? "bg-primary-soft text-primary" : "bg-transparent text-primary-dim hover:text-primary",
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

/** Подпись колонки над полем формы — видимая: в поле с числом плейсхолдер не виден */
export const FIELD_LABEL = "mb-[4px] block text-[13px] font-bold leading-[16px] text-muted";

/** Строка «подпись: значение» в мета-строке записи */
export function Meta({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("min-w-0 text-[13px] leading-[18px] text-muted", className)}>{children}</span>;
}
