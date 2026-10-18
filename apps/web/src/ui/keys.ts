import { useEffect, useRef } from "react";

/**
 * Горячие клавиши экрана.
 *
 * Разбор трёхсот случаев мышью — это лишний час работы каждый день.
 * Клавиши не срабатывают, пока курсор в поле ввода: иначе набор комментария
 * «н» превращался бы в «не подтверждён».
 *
 * Сочетания с модификаторами тоже пропускаем: Cmd+K и Ctrl+F принадлежат
 * браузеру, и перехватывать их без крайней нужды — способ разозлить человека.
 */
export function useHotkeys(map: Record<string, () => void>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        // Esc работает и в поле: он про «уйти отсюда», а не про действие
        if (e.key !== "Escape") return;
      }
      const handler = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
