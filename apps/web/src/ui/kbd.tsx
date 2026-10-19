import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * На чём стоит клавиша:
 *
 *  - `panel` — лист (умолчание): рамка control, подпись text-2;
 *  - `tip`   — плашка подсказки и сообщения: её чернила, тёмная плашка в
 *              светлой теме и светлая в тёмной;
 *  - `fill`  — залитая кнопка, фиолетовая или красная («Далі Enter»):
 *              чернила заливки в обеих темах. Клавиша плашки (`tip`) на
 *              фиолетовом в тёмной теме читалась на 2,8:1 — её тёмные
 *              чернила рассчитаны на светлую плашку;
 *  - `appbar` — тёмная полоса приложения (⌘K в поле поиска).
 */
export type KbdTone = "panel" | "tip" | "fill" | "appbar";

const kbdTone: Record<KbdTone, string> = {
  panel: "border-control bg-panel text-text-2",
  tip: "border-tip-muted bg-transparent text-tip-ink",
  fill: "border-onfill-muted bg-transparent text-onfill",
  appbar: "border-appbar-line bg-transparent text-appbar-muted",
};

/**
 * Клавиша (.kbd набора): 20 px, нижняя грань толще — читается как клавиша, а
 * не как пилюля. `tone` — поверхность под ней.
 */
export function Kbd({ children, tone = "panel", className }: { children: ReactNode; tone?: KbdTone; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-grid h-5 min-w-5 shrink-0 place-items-center rounded-[6px] border border-b-2 px-[5px]",
        "font-sans text-[10.5px] font-bold leading-none not-italic",
        kbdTone[tone],
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
