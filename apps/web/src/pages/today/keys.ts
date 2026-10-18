import { useEffect, useRef } from "react";

/**
 * Клавиши экрана по физической клавише (KeyboardEvent.code), а не по букве.
 *
 * В отделении раскладка почти всегда кириллическая: «J» на ней — «о», и
 * клавиши, привязанные к букве, молча не работали бы у половины людей. Так
 * же поступает таблица набора (DataTable: KeyJ, KeyK, KeyX).
 *
 * Не срабатывает в полях ввода и с модификаторами — Cmd+K и Ctrl+F
 * принадлежат браузеру и палитре.
 */
export function useCodeKeys(map: Record<string, (() => void) | undefined>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      /* поверх экрана открыт диалог или ящик — клавиши принадлежат ему */
      if (document.querySelector('[aria-modal="true"]')) return;
      const handler = ref.current[e.code];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
