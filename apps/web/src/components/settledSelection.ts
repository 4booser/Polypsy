import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Выбор строки, на котором остановились (волна 26, клинический разбор).
 *
 * Список и запись рядом (очередь случаев, колонка «Мої пацієнти», «Хто це»
 * реестра): запись человека — чтение, которое сервер пишет в журнал
 * (сводка, основание сигнала, карточка, хронология). Шаг клавишами J/K —
 * ещё не выбор: человек идёт по списку, и каждая строка, мимо которой он
 * прошёл, ложилась бы в журнал как прочитанная. Поэтому запись грузится,
 * когда курсор простоял SETTLE_MS; нажатие мышью — выбор сразу. То же
 * правило заказчик принял для подготовки к сессии на «Сьогодні».
 */

/** Сколько курсор стоит на строке, прежде чем её запись читается */
export const SETTLE_MS = 600;

/** Как выбрали: клавишей (шаг по списку) или мышью (выбор сразу) */
export type Via = "key" | "click";

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const REAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Ядро без React — ради проверки на подставных часах
 * (test/settledSelection.test.ts): выбор мышью отдаётся сразу, шаг
 * клавишей — когда за ним SETTLE_MS не было следующего.
 */
export function settler<T>(onSettle: (v: T) => void, ms = SETTLE_MS, timers: Timers = REAL_TIMERS) {
  let pending: unknown = null;
  let last: T | undefined;
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  return {
    select(v: T, via: Via) {
      last = v;
      cancel();
      if (via === "click") {
        onSettle(v);
        return;
      }
      pending = timers.set(() => {
        pending = null;
        onSettle(last as T);
      }, ms);
    },
    cancel,
  };
}

/**
 * Значение, на котором остановились: пришло мышью (`via: "click"`) — оно
 * сразу; шагом клавишей — когда SETTLE_MS не было следующего. Для экрана,
 * у которого выбор живёт в чужом состоянии (ящик «Хто це» реестра), а
 * известно лишь, чем его сменили.
 */
export function useSettledValue<T>(value: T, via: Via, ms = SETTLE_MS): T {
  const [settled, setSettled] = useState<T>(value);
  useEffect(() => {
    if (via === "click") {
      setSettled(() => value);
      return;
    }
    const t = setTimeout(() => setSettled(() => value), ms);
    return () => clearTimeout(t);
  }, [value, via, ms]);
  return via === "click" ? value : settled;
}

/**
 * Выбор в списке: `current` — что подсвечено (меняется сразу), `settled` —
 * чью запись читать. От мыши они равны сразу, от клавиш `settled` догоняет
 * `current`, когда курсор остановился.
 */
export function useSettledSelection<T>(initial: T, ms = SETTLE_MS) {
  const [current, setCurrent] = useState<T>(initial);
  const [settled, setSettled] = useState<T>(initial);
  const core = useRef<ReturnType<typeof settler<T>> | null>(null);
  core.current ??= settler<T>((v) => setSettled(() => v), ms);
  useEffect(() => () => core.current?.cancel(), []);
  const select = useCallback((v: T, via: Via) => {
    setCurrent(() => v);
    core.current!.select(v, via);
  }, []);
  return { current, settled, select, isSettled: Object.is(current, settled) };
}
