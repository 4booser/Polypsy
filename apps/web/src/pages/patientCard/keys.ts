import { useEffect, useRef } from "react";

/**
 * Клавиши экрана по физической клавише (KeyboardEvent.code), а не по знаку.
 *
 * Консоль открывают на украинской раскладке: там R — «к», J — «о», а «[» —
 * «х», и useHotkeys набора (по e.key) молчал бы ровно у тех, кто печатает
 * нотатки по-украински. Правила те же: не в поле ввода, не с модификатором.
 * Ключи карты — коды: KeyR, KeyJ, BracketLeft, Digit1.
 */
export function useCodeKeys(map: Record<string, () => void>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      /* слой поверх (окно, палитра) — его клавиши, не экрана */
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
