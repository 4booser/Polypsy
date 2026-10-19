import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { backdropPress } from "../ui/backdrop";
import { isTopLayer, useFocusTrap } from "../ui/focus";
import { cx } from "../ui/cx";

/*
 * Ящик слева — меню «Ще розділи» на узком окне.
 *
 * Свой, потому что ящик набора (ui/Drawer) — только справа, под полосой
 * приложения, с шапкой и подвалом вида; а меню разделов — список во всю
 * высоту слева, у кнопки, которая его открыла. Поведение то же, что обещает
 * набор (§2 KIT.md): Esc закрывает верхний слой, фокус заперт внутри и
 * возвращается тому, кто открыл, нажатие мимо закрывает. Ловушка фокуса,
 * стопка слоёв и правило подложки — общие (ui/focus.ts, ui/index.tsx).
 *
 * Если набор заведёт ящик слева (`side="left"` у Drawer), этот файл уходит
 * целиком.
 */

function useEscape(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* только верхний слой: палитра поверх меню не должна гасить оба */
      if (e.key === "Escape" && isTopLayer(ref)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, ref]);
}

/**
 * Ящик слева на затемнении, под полосой приложения: он закрывает почти всё
 * стекло, и читать сквозь него нечего.
 */
export function ShellDrawer({
  label,
  onClose,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
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
        className="fixed inset-0 z-[55] animate-[kit-fade_var(--dur)_var(--ease)] bg-scrim"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cx(
          "fixed bottom-0 left-0 top-[var(--ah,56px)] z-[56] flex w-[min(320px,calc(100vw-48px))] flex-col overflow-hidden",
          "border-r border-border bg-panel text-text shadow-pop outline-none animate-[kit-fade_var(--dur)_var(--ease)]",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
