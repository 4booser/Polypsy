import { useCallback, useEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/*
 * Подсказка оболочки — тёмная плашка набора (.tip): полное имя раздела у
 * значка рельсы, клавиша рядом со словом.
 *
 * Маленькая и своя, пока набор (ui/*) не дал общей Tooltip: её заменит
 * подсказка набора целиком. Только для глаза (aria-hidden): у того, к чему
 * она прицеплена, полное имя уже есть в aria-label, и диктор прочёл бы его
 * дважды.
 *
 * Плашка рисуется в body, а не рядом с целью: рельса прокручивается внутри
 * себя, и плашка внутри неё обрезалась бы краем.
 */

export interface TipTargetProps {
  onMouseEnter: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

export function Tip({
  text,
  kbd,
  side = "right",
  disabled,
  children,
}: {
  text: string;
  /** Клавиша, которая делает то же самое */
  kbd?: string;
  side?: "right" | "bottom";
  /** Подсказка не нужна, когда полное имя и так видно рядом */
  disabled?: boolean;
  children: (props: TipTargetProps) => ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const place = useCallback(
    (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setAt(side === "right" ? { x: r.right + 8, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: r.bottom + 8 });
    },
    [side],
  );

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setAt(null);
  }, []);

  useEffect(() => hide, [hide]);
  useEffect(() => {
    if (!at) return;
    /* прокрутка уводит цель из-под плашки — плашка уходит вместе с ней */
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [at, hide]);

  const props: TipTargetProps = {
    onMouseEnter: (e) => {
      if (disabled) return;
      const el = e.currentTarget;
      if (timer.current) clearTimeout(timer.current);
      /* короткая задержка: проводя мышью по рельсе, человек не должен видеть мелькание */
      timer.current = setTimeout(() => place(el), 250);
    },
    onMouseLeave: hide,
    onFocus: (e) => {
      if (disabled) return;
      if (e.currentTarget.matches(":focus-visible")) place(e.currentTarget);
    },
    onBlur: hide,
  };

  return (
    <>
      {children(props)}
      {at && !disabled
        ? createPortal(
            <div
              aria-hidden
              data-shell-tip=""
              className={
                "pointer-events-none fixed z-[90] flex h-[30px] items-center gap-2 whitespace-nowrap rounded-[9px] " +
                "bg-tip pl-[11px] pr-[11px] text-[12.5px] font-semibold leading-none text-tip-ink shadow-pop " +
                (side === "right" ? "-translate-y-1/2" : "-translate-x-1/2")
              }
              style={{ left: at.x, top: at.y }}
            >
              <span>{text}</span>
              {kbd ? <Kbd tone="tip">{kbd}</Kbd> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Клавиша — подпись набора (.kbd): рамка с утолщённым низом.
 *
 * `tone` — на какой поверхности стоит: на листе, на тёмной полосе приложения
 * или в тёмной подсказке. Цвета разные, потому что рамку и подпись должно
 * быть видно на каждой из трёх.
 */
export function Kbd({ children, tone = "panel" }: { children: ReactNode; tone?: "panel" | "appbar" | "tip" }) {
  return (
    <kbd
      className={
        "inline-grid h-[20px] min-w-[20px] shrink-0 place-items-center rounded-[6px] border border-b-2 px-[5px] " +
        "font-sans text-[10.5px] font-bold not-italic leading-none " +
        (tone === "appbar"
          ? "border-appbar-line bg-transparent text-appbar-muted"
          : tone === "tip"
            ? "border-tip-muted bg-transparent text-tip-ink"
            : "border-control bg-panel text-text-2")
      }
    >
      {children}
    </kbd>
  );
}
