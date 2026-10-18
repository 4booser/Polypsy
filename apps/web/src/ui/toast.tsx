import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { Ic } from "./icons";
import { Kbd } from "./kbd";

/*
 * Всплывающие сообщения (.toast набора): тёмная плашка 48 внизу слева, значок,
 * текст и, если нужно, одно действие — «Повернутися» к сохранённой чернетке.
 *
 * Место — внизу слева, за рельсой: справа живёт ящик действий, и сообщение о
 * его же черновике не должно ложиться на него. Отступ слева — крючок рамки
 * --toast-left (по умолчанию 100 px: рельса 80 + 20); оболочка без рельсы
 * ставит своё. На узком экране плашка встаёт по ширине снизу.
 */

export type ToastKind = "ok" | "err" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Подсказка клавиши у действия: «R» */
  kbd?: string;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Свой значок вместо значка вида */
  icon?: ReactNode;
}

type Item = { id: number; text: string; kind: ToastKind } & ToastOptions;

type Push = (text: string, kind?: ToastKind, options?: ToastOptions) => void;

const ToastCtx = createContext<Push>(() => {});

/** Сколько живёт сообщение: подтверждение — 4,2 с, отказ — 6,5, с действием — 8 */
export function toastLifetime(kind: ToastKind, withAction: boolean): number {
  if (withAction) return 8000;
  return kind === "err" ? 6500 : 4200;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);

  const drop = useCallback((id: number) => setItems((v) => v.filter((t) => t.id !== id)), []);

  const push = useCallback<Push>((text, kind = "info", options) => {
    const id = Date.now() + Math.random();
    setItems((v) => [...v, { id, text, kind, ...options }]);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/*
        Живая область: плашки — единственный канал подтверждений и отказов во
        всём приложении, и без неё диктор их не произносит. Отказы —
        настойчиво (assertive), подтверждения — вежливо, в паузе. role="alert"
        не ставится на постоянный контейнер: он пуст почти всё время, и
        постоянный пустой alert — ложное объявление. Класс `toasts` — опора
        для проверок.
      */}
      <div
        className={cx(
          "toasts pointer-events-none fixed bottom-5 z-[70] flex max-w-[min(560px,calc(100vw-32px))] flex-col items-start gap-2",
          "left-[var(--toast-left,100px)] max-[760px]:left-4 max-[760px]:right-4",
        )}
      >
        <div aria-live="assertive" className="flex flex-col items-start gap-2">
          {items
            .filter((t) => t.kind === "err")
            .map((t) => (
              <ToastPlate key={t.id} item={t} onDone={drop} />
            ))}
        </div>
        <div aria-live="polite" className="flex flex-col items-start gap-2">
          {items
            .filter((t) => t.kind !== "err")
            .map((t) => (
              <ToastPlate key={t.id} item={t} onDone={drop} />
            ))}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}

/**
 * Одна плашка. Время жизни ставится на паузу, пока на плашке мышь или фокус:
 * сообщение с действием не должно исчезнуть из-под руки.
 */
function ToastPlate({ item, onDone }: { item: Item; onDone: (id: number) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onDone(item.id), toastLifetime(item.kind, !!item.action));
  }, [item.id, item.kind, item.action, onDone]);
  const pause = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => {
    start();
    return pause;
  }, [start]);

  const icon =
    item.icon ??
    (item.kind === "err" ? <Ic.circleAlert /> : item.kind === "ok" ? <Ic.circleCheck /> : <Ic.cloudCheck />);

  return (
    <div
      data-kind={item.kind}
      className={cx(
        "toast pointer-events-auto flex min-h-12 items-center gap-2.5 rounded-panel bg-tip py-2 pl-4 pr-2",
        "text-[13px] font-semibold leading-[18px] text-tip-ink shadow-pop",
        "animate-[kit-rise_var(--dur)_var(--ease)]",
        !item.action && "pr-4",
      )}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
    >
      <span
        aria-hidden
        className={cx(
          "inline-flex shrink-0 [&>svg]:size-4",
          item.kind === "err" ? "text-tip-risk" : item.kind === "ok" ? "text-tip-good" : "text-tip-violet",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">{item.text}</span>
      {item.action ? (
        <button
          type="button"
          onClick={() => {
            item.action!.onClick();
            onDone(item.id);
          }}
          className={cx(
            "ml-1 inline-flex h-[34px] min-h-0 shrink-0 cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-3",
            "text-[13px] font-bold text-tip-ink hover:bg-tip-ink/15",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tip-ink",
          )}
        >
          {item.action.label}
          {item.action.kbd ? <Kbd onTip>{item.action.kbd}</Kbd> : null}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Показать сообщение: `toast(текст, вид?, { action? })`.
 * Вид: "ok" — сделано, "err" — отказ (объявляется настойчиво), "info" — сведения.
 */
export const useToast = () => useContext(ToastCtx);
