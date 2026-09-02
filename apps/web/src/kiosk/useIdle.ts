import { useEffect, useRef, useState } from "react";
import { secondsLeft, start, stay, tick, touch, type IdleConfig, type IdleState } from "./idleMachine";

/**
 * Сторож бездействия для планшета без оператора.
 *
 * Планшет в коридоре отличается от киоска на столе оператора ровно этим:
 * между двумя людьми никто не нажимает кнопку. Пока такого сторожа нет,
 * возможны две вещи, и обе плохи по-настоящему.
 *
 * Первая: человек отошёл посреди методики, следующий сел и продолжил его
 * прохождение — ответы двух разных людей попадают в одну карту. Заметить
 * это потом нельзя ничем: в карте лежит одно связное прохождение.
 *
 * Вторая: экран завершения висит, пока кто-нибудь его не сменит. А на нём
 * может стоять план безопасности — он показывается только тогда, когда
 * сработала тревога риска. То есть самое чувствительное, что вообще
 * показывает планшет, остаётся висеть в коридоре дольше всего.
 *
 * Решения живут в `idleMachine`, здесь только подключение к React и к
 * настоящим часам: проверять их порознь дешевле, чем вместе.
 */
export interface IdleWatch {
  /** Идёт обратный отсчёт: показывать предупреждение */
  warning: boolean;
  /** Сколько секунд осталось до сброса */
  secondsLeft: number;
  /** «Я здесь» — снять предупреждение и начать отсчёт заново */
  stay: () => void;
}

export function useIdle({
  active,
  idleMs,
  graceMs,
  onReset,
}: {
  active: boolean;
  idleMs: number;
  graceMs: number;
  onReset: () => void;
}): IdleWatch {
  const cfg: IdleConfig = { idleMs, graceMs };
  const [state, setState] = useState<IdleState>(() => start(active, Date.now(), cfg));
  const [left, setLeft] = useState(0);

  /*
   * Обработчик держится в ref, а не попадает в зависимости эффекта.
   *
   * Иначе каждая отрисовка родителя пересоздаёт функцию, эффект
   * перезапускается, отсчёт начинается заново — и сторож не срабатывает
   * никогда, притом выглядит рабочим.
   */
  const reset = useRef(onReset);
  reset.current = onReset;

  useEffect(() => {
    setState(start(active, Date.now(), { idleMs, graceMs }));
  }, [active, idleMs, graceMs]);

  useEffect(() => {
    if (state.mode === "off") return;
    const id = setInterval(() => {
      const now = Date.now();
      setLeft(secondsLeft(state, now));
      const next = tick(state, now, { idleMs, graceMs });
      if (next.state !== state) setState(next.state);
      if (next.reset) reset.current();
    }, 250);
    return () => clearInterval(id);
  }, [state, idleMs, graceMs]);

  // любое касание продлевает жизнь, но только в режиме ожидания:
  // машина сама решает, что во время предупреждения касание ничего не значит
  useEffect(() => {
    if (state.mode !== "waiting") return;
    const bump = () => setState((s) => touch(s, Date.now(), { idleMs, graceMs }));
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const e of events) window.addEventListener(e, bump, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, bump);
    };
  }, [state.mode, idleMs, graceMs]);

  return {
    warning: state.mode === "warning",
    secondsLeft: left,
    stay: () => setState((s) => stay(s, Date.now(), { idleMs, graceMs })),
  };
}
