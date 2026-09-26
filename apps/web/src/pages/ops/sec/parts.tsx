import type { ReactNode } from "react";
import { cx } from "../../../ui/cx";

/*
 * Общие куски трёх разделов безопасности техпанели. Таблицы — утилитами, как
 * в аналитике методики (analytics/tests/views.tsx): волосяная линия #cccccc
 * под строкой, подпись колонки 13/700 серым, числа моноширинные.
 */
export const TH =
  "border-b border-hairline py-[8px] pr-[16px] text-left align-bottom text-[13px] font-bold leading-[16px] text-muted";
export const TD = "border-b border-hairline py-[8px] pr-[16px] align-top text-[13px] leading-[18px] text-text-2";
export const NUM = "text-right font-mono tabular-nums";

/** Подпись колонки строки: 13/700 серым, как на карточке пациента */
export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("text-[13px] font-bold leading-[16px] text-muted", className)}>{children}</div>;
}

/** Пояснение раздела: 13/400, ширина строки — для чтения, а не во всю колонку */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("m-0 max-w-[760px] text-[13px] leading-[18px] text-muted", className)}>{children}</p>;
}

/**
 * Итог проверки словами. Тон — текстом и начертанием, не заливкой:
 * danger — поломка (потеря данных, политики не действуют, разрыв цепочки),
 * attention — янтарный «требует внимания» (и больше ничего), plain — норма.
 */
export function Verdict({
  tone,
  children,
  className,
}: {
  tone: "plain" | "attention" | "danger";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "plain" ? undefined : "alert"}
      className={cx(
        "m-0 max-w-[760px] text-[15px] leading-[21px]",
        tone === "danger" ? "font-bold text-danger" : tone === "attention" ? "text-accent" : "text-text",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Команды для сервера: моноширинный блок в заливке плашки, с прокруткой внутри */
export function Commands({ children }: { children: string }) {
  return (
    <pre className="m-0 mt-[8px] overflow-x-auto whitespace-pre rounded-[5px] bg-primary-soft px-[12px] py-[10px] font-mono text-[13px] leading-[19px] text-text">
      {children}
    </pre>
  );
}
