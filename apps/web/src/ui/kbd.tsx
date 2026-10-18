import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Клавиша (.kbd набора): 20 px, нижняя грань толще — читается как клавиша, а
 * не как пилюля. `onTip` — на тёмной плашке подсказки или сообщения.
 */
export function Kbd({ children, onTip, className }: { children: ReactNode; onTip?: boolean; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-grid h-5 min-w-5 shrink-0 place-items-center rounded-[6px] border border-b-2 px-[5px]",
        "font-sans text-[10.5px] font-bold leading-none not-italic",
        onTip ? "border-tip-muted bg-transparent text-tip-ink" : "border-control bg-panel text-text-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Подсказка: [клавиши через пробел, что делают] — «J K» → две клавиши */
export type KbdHint = [string, ReactNode];

/**
 * Полоса подсказок клавиш (.kh набора): «J K рядки, / пошук, Esc закрити».
 *
 * Однобуквенная подсказка обязана быть рабочей клавишей: подсказка о
 * клавише, которая ничего не делает, хуже её отсутствия. `bar` — полоса под
 * таблицей или списком (поле и линия сверху). Скрывается на узком экране:
 * там клавиатуры обычно нет.
 */
export function KbdHints({
  keys,
  bar,
  className,
  label,
}: {
  keys: KbdHint[];
  bar?: boolean;
  className?: string;
  /** Подпись для диктора; без неё полоса — оформление (aria-hidden) */
  label?: string;
}) {
  return (
    <div
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "note" : undefined}
      className={cx(
        "flex flex-wrap items-center gap-x-4 gap-y-2 whitespace-nowrap text-caption text-muted max-[760px]:hidden",
        bar && "border-t border-divider px-4 pb-3 pt-2.5",
        className,
      )}
    >
      {keys.map(([k, what]) => (
        <span key={k} className="inline-flex items-center gap-1">
          {k.split(" ").map((one) => (
            <Kbd key={one}>{one}</Kbd>
          ))}
          <span className="ml-0.5">{what}</span>
        </span>
      ))}
    </div>
  );
}
