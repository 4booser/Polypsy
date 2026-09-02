/**
 * Сердцевина сторожа бездействия — без React и без настоящих часов.
 *
 * Вынесена отдельно по той же причине, что и гонка запросов в useResource:
 * проверять React-хук в этом проекте нечем, а проверять здесь нужно не
 * «таймер тикает», а решения — когда предупредить, когда сбросить и что
 * считать признаком жизни. Хук остаётся тонкой обёрткой над этим.
 */
export type IdleMode = "off" | "waiting" | "warning";

export interface IdleState {
  mode: IdleMode;
  /** Когда истекает текущее ожидание, в миллисекундах шкалы `now` */
  deadline: number;
}

export interface IdleConfig {
  /** Тишина до предупреждения */
  idleMs: number;
  /** Отклик после предупреждения; 0 — сбрасывать сразу, ни о чём не спрашивая */
  graceMs: number;
}

export function start(active: boolean, now: number, cfg: IdleConfig): IdleState {
  return active ? { mode: "waiting", deadline: now + cfg.idleMs } : { mode: "off", deadline: 0 };
}

/**
 * Касание экрана.
 *
 * Продлевает жизнь только в режиме ожидания. Во время предупреждения оно
 * намеренно ничего не значит: планшет лежит в коридоре, его задевают
 * локтем и сумкой, и «продолжить» должно быть осознанным нажатием, а не
 * случайным касанием — иначе чужое прохождение продлевается само собой.
 */
export function touch(state: IdleState, now: number, cfg: IdleConfig): IdleState {
  if (state.mode !== "waiting") return state;
  return { mode: "waiting", deadline: now + cfg.idleMs };
}

/** Осознанное «я здесь»: снимает предупреждение и начинает отсчёт заново */
export function stay(state: IdleState, now: number, cfg: IdleConfig): IdleState {
  if (state.mode === "off") return state;
  return { mode: "waiting", deadline: now + cfg.idleMs };
}

export type IdleTick =
  | { state: IdleState; reset: false }
  | { state: IdleState; reset: true };

/** Что произошло к моменту `now` */
export function tick(state: IdleState, now: number, cfg: IdleConfig): IdleTick {
  if (state.mode === "off" || now < state.deadline) return { state, reset: false };

  if (state.mode === "waiting") {
    // без отклика вовсе — сбрасываем сразу: спрашивать «вы ещё здесь» у
    // пустого стула незачем, а на экране может стоять план безопасности
    if (cfg.graceMs === 0) return { state: { mode: "off", deadline: 0 }, reset: true };
    return { state: { mode: "warning", deadline: now + cfg.graceMs }, reset: false };
  }

  return { state: { mode: "off", deadline: 0 }, reset: true };
}

/** Сколько секунд осталось показать человеку */
export function secondsLeft(state: IdleState, now: number): number {
  return Math.max(0, Math.ceil((state.deadline - now) / 1000));
}
