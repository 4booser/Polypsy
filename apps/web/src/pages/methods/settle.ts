import { useCallback, useEffect, useRef, useState } from "react";

/** Сколько шаг J/K по списку ждёт, прежде чем запись грузит свои данные */
export const STEP_SETTLE_MS = 600;

/**
 * Строка списка, на которой остановились (список и запись: наборы, группы
 * методик).
 *
 * Запись грузит данные со строкой журнала: назначения набора — люди и их
 * прогресс (battery.assignment_list), аналитика группы (analytics.group).
 * Шаг J/K — ещё не выбор: человек идёт по списку, и каждая строка, мимо
 * которой он прошёл, ложилась в журнал чтением. Шаг клавишей догоняет через
 * STEP_SETTLE_MS — тем же правилом, что выбор пациента в «Заповненні за
 * пацієнта», — а щелчок по строке, адрес и первый показ грузят сразу.
 *
 * `stepped()` зовётся перед сменой выбора клавишей; любая другая смена
 * выбора считается выбором и грузит запись сразу.
 */
export function useSettledSelection(id: string | null, ms = STEP_SETTLE_MS): { settled: string | null; stepped: () => void } {
  const [settled, setSettled] = useState(id);
  const viaKeys = useRef(false);
  useEffect(() => {
    if (id === settled) return;
    if (!viaKeys.current) {
      setSettled(id);
      return;
    }
    viaKeys.current = false;
    const timer = setTimeout(() => setSettled(id), ms);
    return () => clearTimeout(timer);
  }, [id, settled, ms]);
  const stepped = useCallback(() => {
    viaKeys.current = true;
  }, []);
  return { settled, stepped };
}
