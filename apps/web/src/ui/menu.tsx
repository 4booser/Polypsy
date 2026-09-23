import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { isTopLayer, useFocusTrap } from "./index";
import { cx } from "./cx";
import { Button, type ButtonProps } from "./primitives";

/*
 * Всплывающее меню за глифом: «+» над списком, «⋯» в строке, «▾» у крошки,
 * шестерёнка у заголовка карточки и над структурой модели.
 *
 * Написано в каталоге тестов (SurveyList.tsx, волна 3), и три экрана волны 4
 * — карточки людей, аналитика, группы — принесли по своей копии той же
 * ловушки фокуса с обходом стрелками. Так и появляются два меню, из которых
 * одно закрывается по Esc, а другое нет; поэтому здесь одно на всех, а
 * экраны отличаются только тем, что кладут внутрь.
 *
 * Меню на кадрах двух видов, и это не два компонента, а один параметр
 * `align`:
 *  - «left» — меню списка (f11: «+», «⋯», «▾» у крошки): плашка с рамкой
 *    шириной от 220, пункты 13/400 у левого края, как в бургере шапки;
 *  - «right» — меню карточки (f15, f33, f38: шестерёнка справа от
 *    заголовка): белая плашка с тенью от 165, пункты 15/400 прижаты к
 *    правому краю, к самой шестерёнке.
 * Выравнивание — параметром, а не вторым классом снаружи: `text-left` и
 * `text-right` в одной строке классов спорят, и кто из них победит, решает
 * порядок в собранном CSS, а не в разметке. По той же причине цвет пункта —
 * тоном (`tone`), а не наложением «опасного» класса поверх обычного: два
 * `text-*` в одной строке — тот же спор.
 *
 * Что обещает клавиатуре и диктору: role="menu" с aria-expanded и
 * aria-controls на глифе (ссылка на меню — только пока оно есть: idref в
 * пустоту — ошибка ARIA), фокус на первом пункте, стрелки, Home, End, Esc,
 * Tab по кругу (общая ловушка useFocusTrap), возврат фокуса на глиф при
 * закрытии, область нажатия 44 (Button size="glyph"). Подложка отвечает на
 * нажатие мимо меню — без неё щелчок «закрыть» попадал бы в ссылку строки
 * под меню.
 */

export type MenuAlign = "left" | "right";
export type MenuTone = "normal" | "danger" | "disabled";

/*
 * Пункт меню — обычная строка, а не Button: кнопка макета полужирная и
 * залитая, и шесть таких подряд в столбик читались бы как шесть главных
 * действий. `border-0 bg-transparent min-h-0` гасят правила наследия для
 * <button>. Недоступный пункт остаётся в меню и принимает фокус (см.
 * ActionMenu): атрибут disabled вынул бы его из обхода стрелками, и стрелки,
 * дойдя до него, застревали бы на соседе.
 */
export function menuItemClass(align: MenuAlign = "left", tone: MenuTone = "normal"): string {
  return cx(
    "flex w-full items-center rounded-[4px] border-0 bg-transparent font-normal no-underline",
    "h-auto min-h-0 transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
    align === "right"
      ? "justify-end px-[16px] py-[6px] text-right text-[15px] leading-[20px]"
      : "gap-2 px-3 py-2 text-left text-[13px] leading-[19px]",
    tone === "disabled"
      ? "cursor-not-allowed text-faint"
      : tone === "danger"
        ? "text-danger hover:bg-danger-soft hover:text-danger hover:no-underline"
        : cx(
            align === "right" ? "text-text-2" : "text-text",
            "hover:bg-primary-soft hover:text-primary hover:no-underline",
          ),
  );
}

/** Пункт меню списка — самый частый случай, чтобы не писать вызов в каждой строке */
export const menuItem = menuItemClass("left");

/*
 * Плашка. У меню карточки тень — токен, а не число: в тёмной теме плашка
 * белой не будет. `items-stretch` растягивает пункты на всю ширину, чтобы
 * область нажатия не кончалась на тексте.
 */
function plateClass(align: MenuAlign): string {
  return cx(
    "absolute right-0 z-50 flex flex-col items-stretch outline-none",
    align === "right"
      ? "top-[calc(100%+8px)] min-w-[165px] rounded-[5px] bg-[var(--bg)] py-[8px] shadow-pop"
      : "top-[calc(100%+6px)] min-w-[220px] gap-0.5 rounded-md border border-border bg-surface p-1 shadow-panel",
  );
}

/**
 * Глиф, раскрывающий меню; содержимое — через функцию, чтобы пункт мог
 * закрыть меню сам, а между пунктами могла стоять черта (<hr>).
 *
 * Ловушка фокуса — общая (useFocusTrap): она же уводит фокус внутрь и
 * возвращает его на глиф при закрытии, поэтому окно, открытое из пункта
 * меню, запоминает «открывшим» именно глиф, а не исчезнувший пункт.
 */
export function MenuButton({
  label,
  glyph,
  align = "left",
  className,
  triggerClassName,
  triggerSize = "glyph",
  children,
}: {
  /** Имя меню для диктора: у глифа подписи нет */
  label: string;
  glyph: ReactNode;
  align?: MenuAlign;
  className?: string;
  /*
   * Раскрывающий элемент — не всегда глиф в квадрате 27. На кадрах
   * f23_1/f24_1 меню языка раскрывает короткая надпись «Укр» без рамки, и
   * втиснуть её в `size="glyph"` нельзя: квадрат 27 обрежет слово. Поэтому
   * размер и классы кнопки — параметры с макетным умолчанием, а не зашитые
   * значения. Альтернатива — второй компонент рядом — принесла бы вторую
   * копию ловушки фокуса и обхода стрелками, ради чего этот файл и написан.
   */
  triggerClassName?: string;
  triggerSize?: ButtonProps["size"];
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
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
        size={triggerSize}
        variant="ghost"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {glyph}
      </Button>
      {open ? (
        <>
          <div aria-hidden onClick={close} className="fixed inset-0 z-40" />
          <div ref={ref} id={id} role="menu" aria-label={label} tabIndex={-1} className={plateClass(align)}>
            {children(close)}
          </div>
        </>
      ) : null}
    </div>
  );
}

/*
 * Меню карточки, заданное списком, а не разметкой: у шестерёнки карточки
 * пункты — всегда переход или действие, без черт и вложенных списков, и
 * описать их данными короче и однороднее, чем повторять <button
 * role="menuitem"> в каждой карточке.
 *
 * Пункт бывает ссылкой (переход) или действием (кнопка) — и то и другое с
 * role="menuitem", чтобы диктор видел одно меню, а не ссылки вперемешку с
 * кнопками. Недоступный пункт остаётся в меню с aria-disabled, а не
 * пропадает: на кадре все пункты нарисованы всегда, и человек, не нашедший
 * «Редагувати» в чужой карточке, решил бы, что меню сломано.
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

export function ActionMenu({
  label,
  glyph,
  entries,
  className,
}: {
  label: string;
  glyph: ReactNode;
  entries: MenuEntry[];
  className?: string;
}) {
  return (
    <MenuButton label={label} glyph={glyph} align="right" className={className}>
      {(close) =>
        entries.map((it) => {
          const disabled = !!it.disabled;
          const cls = menuItemClass("right", disabled ? "disabled" : it.danger ? "danger" : "normal");
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
        })
      }
    </MenuButton>
  );
}
