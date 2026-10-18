import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { isTopLayer, useFocusTrap } from "./focus";
import { cx } from "./cx";
import { Ic } from "./icons";
import { Kbd } from "./kbd";
import { useLang } from "../lang";
import { Button, type ButtonProps } from "./primitives";

/*
 * Всплывающее меню (.menu / .mi набора): «⋯» в строке, «+» над списком,
 * шестерёнка у заголовка карточки.
 *
 * Одно на все экраны: ловушка фокуса, стрелки, Home, End, Esc, возврат фокуса
 * открывшему. Плашка — лист 14 с ободом и тенью всплывающего слоя, пункты
 * 36 px, 13/600, значок приглушённым слева, клавиша или пометка справа.
 *
 * `align` решает только, к какому краю глифа прижата плашка: `left` и
 * `right` — к правому (меню раскрывается влево, внутрь колонки), `right-out`
 * — к левому (раскрывается вправо, за колонку формы). Вид пунктов один.
 *
 * Что обещает клавиатуре и диктору: role="menu" с aria-expanded и
 * aria-controls на глифе (ссылка на меню — только пока оно есть: idref в
 * пустоту — ошибка ARIA), фокус на первом пункте, Tab по кругу (общая
 * ловушка useFocusTrap). Подложка отвечает на нажатие мимо меню — без неё
 * щелчок «закрыть» попадал бы в ссылку строки под меню.
 */

export type MenuAlign = "left" | "right" | "right-out";
export type MenuTone = "normal" | "danger" | "disabled";

/** Прежний кегль пункта (15 / 17): принимается, пункт набора один — 13 */
export type MenuItemSize = 15 | 17;

/**
 * Классы пункта меню.
 *
 * Цвет — тоном, а не наложением класса поверх обычного: два `text-*` в одной
 * строке спорят, и победителя решает порядок в собранном CSS. `danger`
 * (удалить, отозвать) — обычными чернилами: красный в наборе отдан риску
 * для человека, разрушительное держится на подтверждении.
 */
export function menuItemClass(_align: MenuAlign = "left", tone: MenuTone = "normal", _size: MenuItemSize = 15): string {
  return cx(
    "flex h-9 min-h-0 w-full cursor-pointer items-center gap-2.5 rounded-[9px] border-0 bg-transparent px-2.5",
    "whitespace-nowrap text-left text-[13px] font-semibold leading-none no-underline",
    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
    "outline-none focus-visible:bg-sunk [&>svg]:size-4 [&>svg]:shrink-0",
    tone === "disabled"
      ? "cursor-not-allowed text-muted opacity-60 [&>svg]:text-muted"
      : "text-text hover:bg-sunk hover:no-underline [&>svg]:text-muted",
  );
}

/** Пункт меню списка — по умолчанию */
export const menuItem = menuItemClass("left");

/** Плашка меню: вид один, `align` решает только сторону */
function plateClass(align: MenuAlign, plateClassName?: string): string {
  return cx(
    "absolute z-50 flex min-w-[232px] max-w-[340px] flex-col items-stretch rounded-panel border border-border bg-panel p-1.5 shadow-pop outline-none",
    "animate-[kit-rise_var(--dur)_var(--ease)]",
    align === "right-out" ? "left-0 top-[calc(100%+6px)]" : "right-0 top-[calc(100%+6px)]",
    plateClassName,
  );
}

/** Свойства, которые своя кнопка-переключатель обязана взять у меню */
export interface MenuTriggerProps {
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
}

const ITEM = '[role^="menuitem"]';

export function MenuButton({
  label,
  glyph,
  align = "left",
  className,
  plateClassName,
  triggerClassName,
  triggerSize = "glyph",
  trigger,
  children,
}: {
  label: string;
  glyph?: ReactNode;
  align?: MenuAlign;
  className?: string;
  /** Ширина плашки, если умолчание (от 232) не годится */
  plateClassName?: string;
  triggerClassName?: string;
  triggerSize?: ButtonProps["size"];
  /** Своя кнопка вместо глифа: пункт бургера, «Укр» в полосе */
  trigger?: (props: MenuTriggerProps) => ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useFocusTrap<HTMLDivElement>(open);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>(ITEM)?.focus();
    const onKey = (e: KeyboardEvent) => {
      /* меню поверх меню или под палитрой: клавиши — верхнему слою */
      if (!isTopLayer(ref)) return;
      if (e.key === "Escape") {
        close();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);
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
      {trigger ? (
        trigger({
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-controls": open ? id : undefined,
          onClick: () => setOpen((v) => !v),
        })
      ) : (
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
      )}
      {open ? (
        <>
          <div aria-hidden onClick={close} className="fixed inset-0 z-40" />
          <div ref={ref} id={id} role="menu" aria-label={label} tabIndex={-1} className={plateClass(align, plateClassName)}>
            {children(close)}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Пункт меню с действием: переход или кнопка */
export interface MenuEntry {
  key?: string;
  label: string;
  to?: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Почему недоступно — подсказкой на пункте */
  hint?: string;
  /** Разрушительное: подтверждается на месте, выглядит обычным пунктом */
  danger?: boolean;
  /** Значок слева, приглушённым */
  icon?: ReactNode;
  /** Клавиша справа («C») */
  kbd?: string;
  /** Черта перед пунктом: отделяет группу */
  ruled?: boolean;
}

/** Разделитель между группами пунктов */
export function MenuSeparator() {
  return <div role="separator" className="mx-1 my-1.5 h-px bg-divider" />;
}

/** Подпись группы пунктов: «Дії з пацієнтом» */
export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-caption font-bold text-muted">{children}</div>;
}

/** Меню действий за глифом: список переходов и команд */
export function ActionMenu({
  label,
  glyph,
  entries,
  className,
  plateClassName,
  itemSize,
  triggerSize,
  triggerClassName,
  align = "right",
}: {
  /** Имя меню для диктора; по умолчанию «Ще дії» */
  label?: string;
  /** Знак на кнопке; по умолчанию «⋯» */
  glyph?: ReactNode;
  entries: MenuEntry[];
  className?: string;
  plateClassName?: string;
  itemSize?: MenuItemSize;
  triggerSize?: ButtonProps["size"];
  triggerClassName?: string;
  align?: MenuAlign;
}) {
  const { ut } = useLang();
  return (
    <MenuButton
      label={label ?? ut("kit.moreActions")}
      glyph={glyph ?? <Ic.ellipsis size={18} />}
      align={align}
      className={className}
      plateClassName={plateClassName}
      triggerSize={triggerSize}
      triggerClassName={triggerClassName}
    >
      {(close) =>
        entries.map((it) => {
          const disabled = !!it.disabled;
          const cls = menuItemClass("right", disabled ? "disabled" : it.danger ? "danger" : "normal", itemSize);
          const inner = (
            <>
              {it.icon}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.kbd ? <Kbd className="ml-auto">{it.kbd}</Kbd> : null}
            </>
          );
          const rule = it.ruled ? <MenuSeparator key={`${it.key ?? it.label}-rule`} /> : null;
          if (it.to && !disabled) {
            return [
              rule,
              <Link key={it.key ?? it.label} role="menuitem" to={it.to} className={cls} onClick={close}>
                {inner}
              </Link>,
            ];
          }
          return [
            rule,
            <button
              key={it.key ?? it.label}
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
              {inner}
            </button>,
          ];
        })
      }
    </MenuButton>
  );
}
