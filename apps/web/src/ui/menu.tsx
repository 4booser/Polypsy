import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { isTopLayer, useFocusTrap } from "./index";
import { cx } from "./cx";
import { Button } from "./primitives";

/*
 * Меню за глифом: шестерёнка у заголовка карточки, «+» над списком.
 *
 * Тот же приём, что у MenuButton в каталоге тестов (SurveyList.tsx) и у
 * DocumentMenu в заключении (Conclusion.tsx): глиф с областью нажатия 44,
 * подложка на нажатие мимо, ловушка фокуса, стрелки и Esc. Здесь он
 * вынесен в общий модуль, потому что карточки людей — третье место с той
 * же шестерёнкой, а третья копия одного меню — это три места, где однажды
 * разойдётся поведение клавиатуры. Два прежних меню остаются на месте: их
 * экраны проверены и сданы, и переводить их сюда стоит вместе с их
 * следующей правкой, а не поверх чужой готовой работы.
 *
 * Пункт бывает ссылкой (переход) или действием (кнопка) — и то и другое с
 * role="menuitem", чтобы диктор видел одно меню, а не ссылки вперемешку с
 * кнопками. Недоступный пункт остаётся в меню с aria-disabled, а не
 * пропадает: на кадре все три пункта нарисованы всегда, и человек, не
 * нашедший «Редагувати» в чужой карточке, решил бы, что меню сломано.
 * Почему aria-disabled, а не атрибут disabled: отключённая кнопка не
 * принимает фокус, и стрелки, дойдя до неё, застревали бы на соседе.
 */

export interface MenuEntry {
  label: string;
  /** Ссылка — переход; без неё пункт — действие */
  to?: string;
  onSelect?: () => void;
  /** Пункт есть, но сейчас недоступен; подсказка объясняет почему */
  disabled?: boolean;
  hint?: string;
  danger?: boolean;
}

/*
 * Пункт меню — строка 15/400 у правого края, как нарисовано на кадрах
 * карточек (шестерёнка стоит справа, и список пунктов прижат к ней).
 * `border-0 bg-transparent min-h-0` гасят правила наследия для <button>.
 */
const itemClass = (disabled: boolean, danger: boolean) =>
  cx(
    "flex w-full items-center justify-end rounded-[4px] border-0 bg-transparent px-[16px] py-[6px]",
    "h-auto min-h-0 text-right text-[15px] leading-[20px] font-normal no-underline",
    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
    disabled
      ? "cursor-not-allowed text-faint"
      : danger
        ? "text-danger hover:bg-danger-soft hover:text-danger"
        : "text-text-2 hover:bg-primary-soft hover:text-primary hover:no-underline",
  );

export function ActionMenu({
  label,
  glyph,
  entries,
  className,
}: {
  /** Имя меню для диктора: у глифа подписи нет */
  label: string;
  glyph: ReactNode;
  entries: MenuEntry[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useFocusTrap<HTMLDivElement>(open);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    /*
     * Открытое меню стоит на первом пункте, а не на пустом контейнере:
     * ловушка фокуса переносит фокус на контейнер, и диктор объявлял бы
     * «меню» без пункта под курсором.
     */
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      /* только верхний слой: окно поверх меню не должно гасить оба */
      if (!isTopLayer(ref)) return;
      if (e.key === "Escape") {
        close();
        return;
      }
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
            /*
              Белая плашка с тенью, как на кадре; тень — токен, а не число:
              в тёмной теме плашка белой не будет.
            */
            className={cx(
              "absolute right-0 top-[calc(100%+8px)] z-50 flex min-w-[165px] flex-col items-stretch",
              "rounded-[5px] bg-[var(--bg)] py-[8px] shadow-pop outline-none",
            )}
          >
            {entries.map((it) => {
              const disabled = !!it.disabled;
              const cls = itemClass(disabled, !!it.danger);
              if (it.to && !disabled) {
                return (
                  <Link key={it.label} role="menuitem" to={it.to} className={cls} onClick={close}>
                    {it.label}
                  </Link>
                );
              }
              return (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  aria-disabled={disabled || undefined}
                  title={disabled ? it.hint : undefined}
                  className={cls}
                  onClick={() => {
                    if (disabled) return;
                    close();
                    it.onSelect?.();
                  }}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
