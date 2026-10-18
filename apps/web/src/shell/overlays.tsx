import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { useLang } from "../lang";
import { backdropPress, isTopLayer, useFocusTrap } from "../ui";
import { cx } from "../ui/cx";
import { ShellIcon, type IconName } from "./icons";
import { Kbd, Tip } from "./Tip";

/*
 * Два слоя оболочки — всплывающая карточка и боковой ящик.
 *
 * Маленькие и свои, пока набор (ui/*) не дал общих Popover и Drawer: их
 * заменят слои набора целиком, и поведение здесь то же, что обещает набор
 * (§2 KIT.md): Esc закрывает верхний слой, фокус заперт внутри и
 * возвращается тому, кто открыл, нажатие мимо закрывает.
 *
 * Ловушка фокуса, стопка слоёв и правило подложки — общие (ui/index.tsx):
 * своя копия этой логики здесь была бы третьей в проекте, а расхождение
 * между копиями как раз так и появляется.
 */

function useEscape(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* только верхний слой: палитра поверх ящика не должна гасить оба */
      if (e.key === "Escape" && isTopLayer(ref)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, ref]);
}

/**
 * Всплывающая карточка у кнопки: учётная запись, полное имя, длинная
 * подпись. Стоит под кнопкой, прижатая к её правому краю; обёртка кнопки
 * обязана быть `relative`.
 *
 * Нажатие мимо закрывает её, кроме нажатия по самой кнопке: та закроет
 * карточку своим переключением, и двойное закрытие открывало бы её снова.
 */
export function ShellPopover({
  label,
  onClose,
  trigger,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  trigger: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const ref = useFocusTrap<HTMLDivElement>();
  useEscape(ref, onClose);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || trigger.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose, ref, trigger]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={cx(
        "absolute right-0 top-[calc(100%+6px)] z-50 flex flex-col outline-none",
        "rounded-panel border border-border bg-panel text-text shadow-pop",
        "animate-[rise_var(--dur)_var(--ease)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Боковой ящик: центр событий и справка справа, все разделы слева (узкое
 * окно), помощь в кабинете пациента справа.
 *
 * Справа ящик висит под полосой приложения, как в наборе (.drawer: 10 от
 * полосы, 18 скругления у свободного края), и страницу не затемняет —
 * человек видит, откуда пришёл. Слева на узком окне, наоборот, ложится на
 * затемнение: там он закрывает почти всё стекло, и читать сквозь него нечего.
 */
export function ShellDrawer({
  side,
  label,
  onClose,
  scrim,
  under = 56,
  className,
  children,
}: {
  side: "left" | "right";
  label: string;
  onClose: () => void;
  /** Затемнить страницу под ящиком */
  scrim?: boolean;
  /** Высота того, что стоит над ящиком: полоса приложения консоли (56) или ничего (0) */
  under?: 0 | 56;
  className?: string;
  children: ReactNode;
}) {
  const ref = useFocusTrap<HTMLDivElement>();
  useEscape(ref, onClose);
  /* подложка — тем же правилом, что Modal (#200, #179): нажатие начато и закончено на ней */
  const [press] = useState(backdropPress);
  return (
    <>
      <div
        aria-hidden
        onPointerDown={press.down}
        onPointerUp={press.up}
        onClick={(e) => {
          if (press.click(e)) onClose();
        }}
        className={cx("fixed inset-0 z-[55]", scrim && "bg-scrim animate-[fade_var(--dur)_var(--ease)]")}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cx(
          "fixed z-[56] flex flex-col overflow-hidden bg-panel text-text outline-none",
          side === "right"
            ? cx(
                "right-0 w-[min(440px,100vw)] rounded-l-drawer border border-r-0 border-border shadow-drawer",
                "animate-[slide-in_var(--dur-slow)_var(--ease)]",
                under === 56 ? "bottom-[10px] top-[66px] max-[600px]:bottom-0 max-[600px]:top-[56px] max-[600px]:rounded-none" : "inset-y-0",
              )
            : cx(
                "bottom-0 left-0 w-[min(320px,calc(100vw-48px))] border-r border-border shadow-pop",
                under === 56 ? "top-[56px]" : "top-0",
                "animate-[fade_var(--dur)_var(--ease)]",
              ),
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}

/**
 * Шапка ящика по набору (.dh): значок в плашке, заголовок 18/800, подпись,
 * крестик с подсказкой «Esc».
 */
export function DrawerHead({
  icon,
  title,
  sub,
  onClose,
  tone = "violet",
}: {
  icon: IconName;
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  tone?: "violet" | "risk";
}) {
  const { ut } = useLang();
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-divider py-[14px] pl-[18px] pr-3">
      <span
        aria-hidden
        className={cx(
          "grid size-10 shrink-0 place-items-center rounded-[12px]",
          tone === "risk" ? "bg-risk-tint text-risk-ink" : "bg-violet-tint text-violet-ink",
        )}
      >
        <ShellIcon name={icon} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="m-0 truncate text-[18px] font-extrabold leading-6 tracking-[-0.02em] text-text">{title}</h2>
        {sub ? <p className="m-0 truncate text-[12.5px] leading-[17px] text-muted">{sub}</p> : null}
      </div>
      <Tip text={ut("shell.close")} kbd="Esc" side="bottom">
        {(tip) => (
          <button
            type="button"
            onClick={onClose}
            aria-label={ut("shell.close")}
            {...tip}
            className={cx(
              "grid size-9 min-h-0 shrink-0 place-items-center rounded-control border-0 bg-sunk p-0 text-text-2",
              "transition-colors duration-[var(--dur-fast)] hover:bg-sunk-2 hover:text-text",
            )}
          >
            <ShellIcon name="x" size={17} />
          </button>
        )}
      </Tip>
    </header>
  );
}

export { Kbd };
