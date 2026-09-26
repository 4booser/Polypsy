import type { ReactNode } from "react";
import { cx } from "../../../ui/cx";
import type { CheckDay, CheckDayState } from "./model";

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

/* ─────────── сверки по дням (волна 11) ─────────── */

/*
 * Метка дня — формой и цветом сразу: цела — фиолетовый круг, разрыв —
 * ромб цветом поломки (danger, как Verdict о разрыве выше), не сверяли —
 * короткая черта цветом сетки. Форма читается и без цвета — в печати и
 * при любом виде дальтонизма.
 */
const STRIP_MARK: Record<CheckDayState, string> = {
  ok: "size-[8px] rounded-full bg-primary",
  broken: "size-[9px] rotate-45 bg-danger",
  none: "h-[2px] w-[8px] rounded-full bg-[var(--grid)]",
};

export function StripMark({ state }: { state: CheckDayState }) {
  return <span aria-hidden className={cx("inline-block shrink-0", STRIP_MARK[state])} />;
}

/**
 * Полоса дней: по клетке на день окна, в клетке — итог сверок того дня.
 *
 * Не столбцы и не линия: у сверки нет величины, есть «цела / разрыв / не
 * сверяли», и высота столбца тут означала бы число нажатий кнопки — не то,
 * о чём спрашивают. Подпись для диктора — счёт дней по итогам и края
 * окна; у клетки — подсказка с датой и словом, а под полосой — легенда
 * словами с тем же счётом.
 */
export function CheckStrip({
  days,
  label,
  words,
  dayLabel,
}: {
  days: readonly CheckDay[];
  label: string;
  words: Record<CheckDayState, string>;
  dayLabel: (key: string) => string;
}) {
  if (!days.length) return null;
  const count = (s: CheckDayState) => days.filter((d) => d.state === s).length;
  const order: CheckDayState[] = ["ok", "broken", "none"];
  const first = dayLabel(days[0]!.key);
  const last = dayLabel(days.at(-1)!.key);
  return (
    <div>
      <ol
        role="img"
        aria-label={`${label}: ${first} — ${last}; ${order.map((s) => `${words[s]} ${count(s)}`).join(", ")}`}
        className="m-0 flex list-none gap-[2px] border-b border-hairline p-0"
      >
        {days.map((d) => (
          <li
            key={d.key}
            title={`${dayLabel(d.key)}: ${words[d.state]}${d.ok + d.broken > 1 ? ` · ${d.ok + d.broken}` : ""}`}
            className="flex h-[28px] min-w-0 flex-1 items-center justify-center"
          >
            <StripMark state={d.state} />
          </li>
        ))}
      </ol>
      <div className="mt-[4px] flex justify-between font-mono text-[11px] text-muted tabular-nums">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <ul className="m-0 mt-[8px] flex list-none flex-wrap gap-x-[18px] gap-y-[4px] p-0 text-[13px] leading-[18px]">
        {order.map((s) => (
          <li key={s} className={cx("flex items-center gap-[6px]", s === "broken" && count(s) ? "font-bold text-danger" : "text-text-2")}>
            <StripMark state={s} />
            {words[s]}
            <span className="font-mono text-muted tabular-nums">{count(s)}</span>
          </li>
        ))}
      </ul>
    </div>
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
