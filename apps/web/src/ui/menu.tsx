import { useCallback, useEffect, useState, type ReactNode } from "react";
import { isTopLayer, useFocusTrap } from "./index";
import { cx } from "./cx";
import { Button } from "./primitives";

/*
 * Всплывающее меню за глифом: «+» над списком, «⋯» в строке, «▾» у крошки,
 * шестерёнка над структурой модели.
 *
 * Жило в каталоге тестов (SurveyList.tsx), где и было написано; раздел
 * аналитики повторяет тот же приём для шестерёнки, и вторая копия ловушки
 * фокуса с обходом стрелками разошлась бы с первой при следующей правке —
 * так и появляются два меню, из которых одно закрывается по Esc, а другое
 * нет. Поэтому здесь, одно на всех.
 */

/*
 * Пункт меню — обычная строка 13/400, а не Button: кнопка макета полужирная
 * и залитая, и шесть таких подряд в столбик читались бы как шесть главных
 * действий. Строка меню — как в бургере шапки (Topbar.tsx, rowClass).
 * `border-0 bg-transparent min-h-0` гасят правила наследия для <button>.
 *
 * Выравнивание — параметром, а не вторым классом снаружи: `text-left` и
 * `text-right` в одной строке классов спорят, и кто из них победит, решает
 * порядок в собранном CSS, а не в разметке. На кадрах меню бывает и левым
 * (f11, каталог), и правым (f15, f38 — пункты прижаты к правому краю).
 */
export function menuItemClass(align: "left" | "right" = "left"): string {
  return cx(
    "flex w-full items-center gap-2 rounded-[4px] border-0 bg-transparent px-3 py-2",
    align === "right" ? "justify-end text-right" : "text-left",
    "h-auto min-h-0 text-[13px] leading-[19px] font-normal text-text no-underline",
    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
    "hover:bg-primary-soft hover:text-primary hover:no-underline",
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
  );
}

export const menuItem = menuItemClass("left");
export const dangerItem = "text-danger hover:bg-danger-soft hover:text-danger";

/**
 * Глиф, раскрывающий меню.
 *
 * Ловушка фокуса — общая (useFocusTrap): она же уводит фокус внутрь и
 * возвращает его на глиф при закрытии, поэтому окно, открытое из пункта
 * меню, запоминает «открывшим» именно глиф, а не исчезнувший пункт.
 * Подложка отвечает на нажатие мимо меню — без неё щелчок «закрыть»
 * попадал бы в ссылку строки под меню.
 */
export function MenuButton({
  label,
  glyph,
  className,
  children,
}: {
  label: string;
  glyph: ReactNode;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useFocusTrap<HTMLDivElement>(open);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    /*
     * Открытое меню стоит на первом пункте, а не на пустом контейнере:
     * ловушка фокуса переносит фокус на контейнер, и диктор объявлял бы
     * «меню» без пункта под курсором. Ловушка сама пункт не выбирает — она
     * общая на все слои и не знает, что внутри меню.
     */
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      /* только верхний слой: окно поверх меню не должно гасить оба и не должно листать меню под собой */
      if (!isTopLayer(ref)) return;
      if (e.key === "Escape") {
        close();
        return;
      }
      /*
       * Стрелки, Home и End — то, что role="menu" обещает клавиатуре. Ловушка
       * заворачивает Tab по кругу, но человек, услышавший «меню», жмёт стрелку
       * вниз — и до этого обработчика на стрелку не отвечал никто.
       */
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : e.key === "ArrowDown"
              ? (at + 1) % items.length
              : at <= 0
                ? items.length - 1
                : at - 1;
      items[next]?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close, ref]);

  return (
    <div className={cx("relative inline-flex", className)}>
      <Button
        size="glyph"
        variant="ghost"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {glyph}
      </Button>
      {open ? (
        <>
          <div aria-hidden onClick={close} className="fixed inset-0 z-40" />
          <div
            ref={ref}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            className={cx(
              "absolute right-0 top-[calc(100%+6px)] z-50 flex min-w-[220px] flex-col gap-0.5",
              "rounded-md border border-border bg-surface p-1 shadow-panel outline-none",
            )}
          >
            {children(close)}
          </div>
        </>
      ) : null}
    </div>
  );
}
