import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { cx } from "./cx";
import { Kbd } from "./kbd";

/*
 * Сведения по требованию (.pop и .tip набора): имя, число, пилюля, точка
 * графика показывают подробности на наведении И на фокусе. Клавиатура — не
 * гость второго сорта: Tab на триггер открывает поповер, следующий Tab
 * уходит в его кнопки, Esc закрывает и возвращает фокус на триггер.
 *
 * Поповер стоит в разметке сразу за триггером (не в портале): так порядок
 * обхода Tab естественный — из триггера прямо в действия поповера, — и
 * ловить фокус вручную не нужно. Место на экране — position: fixed по
 * расчёту placePopover: сторона по просьбе, переворот, если не помещается,
 * и прижатие к краю окна. Поэтому поповер не кладут внутрь <p> и элементов
 * с transform: у первого — недопустимая вложенность, у второго fixed
 * считается от него.
 */

export type PopSide = "top" | "bottom" | "left" | "right";
export type PopAlign = "start" | "center" | "end";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Где поставить всплывающий слой.
 *
 * Чистая функция: прямоугольник триггера, размер слоя и окна — на входе,
 * координаты и итоговая сторона — на выходе. Сторона переворачивается, если
 * на просимой слой не помещается, а на противоположной места больше; по
 * второй оси слой прижимается к окну с полем `margin`.
 */
export function placePopover({
  trigger,
  pop,
  viewport,
  side = "bottom",
  align = "start",
  gap = 8,
  margin = 8,
}: {
  trigger: Box;
  pop: { width: number; height: number };
  viewport: { width: number; height: number };
  side?: PopSide;
  align?: PopAlign;
  gap?: number;
  margin?: number;
}): { top: number; left: number; side: PopSide } {
  const room: Record<PopSide, number> = {
    top: trigger.top - margin,
    bottom: viewport.height - (trigger.top + trigger.height) - margin,
    left: trigger.left - margin,
    right: viewport.width - (trigger.left + trigger.width) - margin,
  };
  const opposite: Record<PopSide, PopSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const need = side === "top" || side === "bottom" ? pop.height + gap : pop.width + gap;
  let final = side;
  if (room[side] < need && room[opposite[side]] > room[side]) final = opposite[side];

  let top: number;
  let left: number;
  if (final === "top" || final === "bottom") {
    top = final === "bottom" ? trigger.top + trigger.height + gap : trigger.top - gap - pop.height;
    left =
      align === "start"
        ? trigger.left
        : align === "end"
          ? trigger.left + trigger.width - pop.width
          : trigger.left + trigger.width / 2 - pop.width / 2;
  } else {
    left = final === "right" ? trigger.left + trigger.width + gap : trigger.left - gap - pop.width;
    top =
      align === "start"
        ? trigger.top
        : align === "end"
          ? trigger.top + trigger.height - pop.height
          : trigger.top + trigger.height / 2 - pop.height / 2;
  }
  const clamp = (v: number, size: number, max: number) => Math.max(margin, Math.min(v, max - size - margin));
  return {
    top: Math.round(clamp(top, pop.height, viewport.height)),
    left: Math.round(clamp(left, pop.width, viewport.width)),
    side: final,
  };
}

/** Триггер с фокусом: кнопка или ссылка получают aria-expanded, прочие — tabIndex и aria-describedby */
function isActionable(el: ReactElement): boolean {
  const props = el.props as { role?: string; href?: string };
  return el.type === "button" || el.type === "a" || props.role === "button";
}

interface FloatingOptions {
  side: PopSide;
  align: PopAlign;
  gap: number;
}

/** Общая механика поповера и подсказки: открыть, закрыть, поставить на место */
function useFloating(open: boolean, { side, align, gap }: FloatingOptions) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const popRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; side: PopSide } | null>(null);

  const measure = useCallback(() => {
    const t = triggerRef.current;
    const p = popRef.current;
    if (!t || !p) return;
    const r = t.getBoundingClientRect();
    setPos(
      placePopover({
        trigger: { top: r.top, left: r.left, width: r.width, height: r.height },
        pop: { width: p.offsetWidth, height: p.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        side,
        align,
        gap,
      }),
    );
  }, [side, align, gap]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  const style: CSSProperties = pos
    ? { position: "fixed", top: pos.top, left: pos.left }
    : /* первый кадр: слой уже в разметке для замера, но на экране его ещё нет */
      { position: "fixed", top: 0, left: 0, visibility: "hidden" };
  return { triggerRef, popRef, style, side: pos?.side ?? side };
}

/** Слить свой ref с ref ребёнка (React 19: ref — обычное свойство) */
function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (node: T | null) => {
    for (const r of refs) {
      if (typeof r === "function") r(node);
      else if (r && typeof r === "object") (r as { current: T | null }).current = node;
    }
  };
}

/**
 * Поповер на наведении и фокусе.
 *
 * ```tsx
 * <Popover title="Сигнал ризику № 214" note="о 14:12" content={<p>…</p>} actions={<Button size="xs">Розібрати</Button>}>
 *   <button type="button" className="…">Сигнал № 214</button>
 * </Popover>
 * ```
 *
 * Ребёнок — один элемент: кнопка, ссылка или любой узел (ему поставят
 * tabIndex=0). У кнопки и ссылки поповер объявлен через aria-expanded и
 * aria-controls, у прочих — aria-describedby: содержимое читается описанием.
 */
export function Popover({
  children,
  content,
  title,
  note,
  actions,
  side = "bottom",
  align = "start",
  width = 340,
  open: openProp,
  onOpenChange,
  label,
  delay = 120,
}: {
  children: ReactElement;
  /** Тело поповера: абзацы, таблица .pkt-вида, что угодно */
  content?: ReactNode;
  /** Заголовок 13.5/800 */
  title?: ReactNode;
  /** Приглушённая пометка справа в заголовке: «о 14:12» */
  note?: ReactNode;
  /** Строка действий внизу: кнопки 32 */
  actions?: ReactNode;
  side?: PopSide;
  align?: PopAlign;
  /** Наибольшая ширина */
  width?: number;
  /** Управляемое открытие (для точки графика, которую ведёт сам график) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Имя слоя для диктора, если заголовка нет */
  label?: string;
  /** Задержка открытия на наведении, мс */
  delay?: number;
}) {
  const id = useId();
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = useCallback(
    (v: boolean) => {
      if (openProp === undefined) setOwn(v);
      onOpenChange?.(v);
    },
    [openProp, onOpenChange],
  );
  const { triggerRef, popRef, style } = useFloating(open, { side, align, gap: 8 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const show = (wait: number) => {
    clear();
    if (wait <= 0) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), wait);
  };
  const hide = (wait: number) => {
    clear();
    if (wait <= 0) setOpen(false);
    else timer.current = setTimeout(() => setOpen(false), wait);
  };

  /* фокус ушёл и не в поповер, и не на триггер — закрыть */
  const onBlurAny = (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (triggerRef.current?.contains(next) || popRef.current?.contains(next))) return;
    hide(0);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      hide(0);
      triggerRef.current?.focus();
    }
  };

  if (!isValidElement(children)) return children;
  const child = children as ReactElement<Record<string, unknown> & { ref?: Ref<HTMLElement> }>;
  const actionable = isActionable(child);
  const childProps = child.props;
  const call = (name: string, e: unknown) => (childProps[name] as ((ev: unknown) => void) | undefined)?.(e);

  const trigger = cloneElement(child, {
    ref: mergeRefs(child.props.ref, (n: HTMLElement | null) => {
      triggerRef.current = n;
    }),
    tabIndex: actionable ? childProps.tabIndex : (childProps.tabIndex ?? 0),
    ...(actionable
      ? { "aria-expanded": open, "aria-controls": open ? id : undefined }
      : { "aria-describedby": open ? id : (childProps["aria-describedby"] as string | undefined) }),
    onMouseEnter: (e: unknown) => {
      call("onMouseEnter", e);
      show(delay);
    },
    onMouseLeave: (e: unknown) => {
      call("onMouseLeave", e);
      hide(150);
    },
    onFocus: (e: unknown) => {
      call("onFocus", e);
      show(0);
    },
    onBlur: (e: FocusEvent) => {
      call("onBlur", e);
      onBlurAny(e);
    },
    onKeyDown: (e: KeyboardEvent) => {
      call("onKeyDown", e);
      onKey(e);
    },
  });

  return (
    <>
      {trigger}
      {open ? (
        <span
          ref={(n) => {
            popRef.current = n;
          }}
          id={id}
          role={actionable ? "dialog" : "tooltip"}
          aria-label={actionable && !title ? label : undefined}
          aria-labelledby={actionable && title ? `${id}-t` : undefined}
          data-popover
          style={{ ...style, maxWidth: width }}
          onMouseEnter={() => clear()}
          onMouseLeave={() => hide(150)}
          onBlur={onBlurAny}
          onKeyDown={onKey}
          className={cx(
            "z-[80] block w-max rounded-panel border border-border bg-panel px-3.5 pb-[13px] pt-3 text-left",
            "text-small font-medium text-text-2 shadow-pop",
            "animate-[kit-rise_var(--dur-fast)_var(--ease)]",
          )}
        >
          {title ? (
            <span className="flex items-center gap-2">
              <b id={`${id}-t`} className="text-body font-extrabold text-text">
                {title}
              </b>
              {note ? <span className="ml-auto whitespace-nowrap text-caption font-semibold text-muted">{note}</span> : null}
            </span>
          ) : null}
          {content ? <span className={cx("block", title ? "mt-[5px]" : null)}>{content}</span> : null}
          {actions ? <span className="mt-3 flex flex-wrap items-center gap-2">{actions}</span> : null}
        </span>
      ) : null}
    </>
  );
}

/**
 * Подсказка (.tip набора): тёмная плашка 30 px с подписью и клавишей.
 *
 * Только подпись, без действий: всё, что нажимают, — в Popover. Появляется
 * на наведении (300 мс) и на фокусе, Esc убирает. Триггер получает
 * aria-describedby, пока подсказка на экране.
 */
export function Tooltip({
  children,
  label,
  kbd,
  side = "top",
  align = "center",
  delay = 300,
}: {
  children: ReactElement;
  label: ReactNode;
  /** Клавиша, которая делает то же самое: «R», «Esc» */
  kbd?: string;
  side?: PopSide;
  align?: PopAlign;
  delay?: number;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const { triggerRef, popRef, style } = useFloating(open, { side, align, gap: 6 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => clear, []);

  if (!isValidElement(children)) return children;
  const child = children as ReactElement<Record<string, unknown> & { ref?: Ref<HTMLElement> }>;
  const childProps = child.props;
  const call = (name: string, e: unknown) => (childProps[name] as ((ev: unknown) => void) | undefined)?.(e);

  const trigger = cloneElement(child, {
    ref: mergeRefs(child.props.ref, (n: HTMLElement | null) => {
      triggerRef.current = n;
    }),
    "aria-describedby": open ? id : (childProps["aria-describedby"] as string | undefined),
    onMouseEnter: (e: unknown) => {
      call("onMouseEnter", e);
      clear();
      timer.current = setTimeout(() => setOpen(true), delay);
    },
    onMouseLeave: (e: unknown) => {
      call("onMouseLeave", e);
      clear();
      setOpen(false);
    },
    onFocus: (e: unknown) => {
      call("onFocus", e);
      clear();
      setOpen(true);
    },
    onBlur: (e: unknown) => {
      call("onBlur", e);
      clear();
      setOpen(false);
    },
    onKeyDown: (e: KeyboardEvent) => {
      call("onKeyDown", e);
      if (e.key === "Escape" && open) setOpen(false);
    },
  });

  return (
    <>
      {trigger}
      {open ? (
        <span
          ref={(n) => {
            popRef.current = n;
          }}
          id={id}
          role="tooltip"
          style={style}
          className={cx(
            "pointer-events-none z-[90] flex h-[30px] w-max items-center gap-2 whitespace-nowrap rounded-[9px] bg-tip pl-[11px]",
            kbd ? "pr-2" : "pr-[11px]",
            "text-small font-semibold leading-none text-tip-ink",
          )}
        >
          {label}
          {kbd ? <Kbd onTip>{kbd}</Kbd> : null}
        </span>
      ) : null}
    </>
  );
}
