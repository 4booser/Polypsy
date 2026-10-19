/** Где событие нажатия: на самой подложке или внутри окна */
interface PressEvent {
  target: unknown;
  currentTarget: unknown;
}

/**
 * Нажатие на подложке окна (#179) — закрывает, только если и началось, и
 * кончилось на ней.
 *
 * Подложка закрывала окно по click, не глядя, где началось нажатие. А click
 * приходит общему предку нажатия и отпускания: выделил протяжкой текст в
 * «Причина вимкнення» или «Опис групи», отпустил мышь за краем окна — click
 * на подложке, окно закрыто, набранное потеряно. Обратное тоже: нажал на
 * подложке, отпустил в окне — click опять достаётся подложке.
 *
 * Состояние — на одно окно (Modal держит свой экземпляр), без React:
 * проверяется вызовами (test/modalBackdrop.test.ts).
 */
export function backdropPress(): {
  down: (e: PressEvent) => void;
  up: (e: PressEvent) => void;
  /** Закрывать ли окно этим click */
  click: (e: PressEvent) => boolean;
} {
  let downOnBackdrop = false;
  let upOnBackdrop = false;
  return {
    down: (e) => {
      downOnBackdrop = e.target === e.currentTarget;
      upOnBackdrop = false;
    },
    up: (e) => {
      upOnBackdrop = e.target === e.currentTarget;
    },
    click: (e) => {
      const closes = downOnBackdrop && upOnBackdrop && e.target === e.currentTarget;
      downOnBackdrop = false;
      upOnBackdrop = false;
      return closes;
    },
  };
}
