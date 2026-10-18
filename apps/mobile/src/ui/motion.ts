import { useEffect, useState } from "react";
import { AccessibilityInfo, Easing, Platform } from "react-native";

/** Кривая набора: быстрый старт, мягкая посадка (cubic-bezier(.16,1,.3,1)) */
export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);

/** Анимация на нативном потоке — кроме веба, где нативного драйвера нет */
export const NATIVE_DRIVER = Platform.OS !== "web";

/**
 * Включено ли «уменьшение движения». Тогда лист и сообщение появляются без
 * выезда: часть обследуемых приходит после контузии, и движение по экрану
 * для них — не украшение, а помеха.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) setReduced(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
