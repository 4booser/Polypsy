import { describe, expect, test } from "bun:test";
import { secondsLeft, start, stay, tick, touch } from "../src/kiosk/idleMachine";

/**
 * Сторож бездействия планшета в коридоре.
 *
 * Проверяется не «таймер тикает», а решения, ради которых сторож написан:
 * оставленное посреди прохождение не достаётся следующему человеку, а
 * экран завершения не висит с планом безопасности. Часы внешние — иначе
 * проверка полутора минут заняла бы полторы минуты.
 */
const WHILE_RUNNING = { idleMs: 90_000, graceMs: 20_000 };
const AFTER_FINISH = { idleMs: 45_000, graceMs: 0 };

describe("планшет без оператора", () => {
  test("касание экрана продлевает жизнь", () => {
    let s = start(true, 0, WHILE_RUNNING);
    s = touch(s, 80_000, WHILE_RUNNING);
    // человек ответил на вопрос на восьмидесятой секунде — отсчёт с нуля
    expect(tick(s, 100_000, WHILE_RUNNING).state.mode).toBe("waiting");
  });

  test("тишина посреди прохождения спрашивает, а не сбрасывает молча", () => {
    /*
     * Человек мог задуматься над вопросом, и сбросить его ответы без
     * предупреждения было бы хамством.
     */
    const s = start(true, 0, WHILE_RUNNING);
    const after = tick(s, 90_001, WHILE_RUNNING);
    expect(after.reset).toBe(false);
    expect(after.state.mode).toBe("warning");
    expect(secondsLeft(after.state, 90_001)).toBe(20);
  });

  test("во время предупреждения задетый локтем экран ничего не продлевает", () => {
    /*
     * Планшет лежит в коридоре, его задевают сумкой. Если бы касание
     * снимало отсчёт, чужое прохождение продлевалось бы само собой — и
     * защита существовала бы только на бумаге.
     */
    const warned = tick(start(true, 0, WHILE_RUNNING), 90_001, WHILE_RUNNING).state;
    expect(touch(warned, 95_000, WHILE_RUNNING)).toEqual(warned);
    expect(tick(warned, 111_000, WHILE_RUNNING).reset).toBe(true);
  });

  test("осознанное «продолжить» возвращает к ожиданию", () => {
    const warned = tick(start(true, 0, WHILE_RUNNING), 90_001, WHILE_RUNNING).state;
    const back = stay(warned, 95_000, WHILE_RUNNING);
    expect(back.mode).toBe("waiting");
    expect(tick(back, 120_000, WHILE_RUNNING).reset).toBe(false);
  });

  test("без отклика прохождение всё-таки сбрасывается", () => {
    /*
     * Это и есть защита: иначе следующий человек садится и продолжает
     * чужое прохождение, а ответы двух людей ложатся в одну карту одним
     * связным прохождением — заметить потом нельзя ничем.
     */
    const warned = tick(start(true, 0, WHILE_RUNNING), 90_001, WHILE_RUNNING).state;
    const out = tick(warned, 110_002, WHILE_RUNNING);
    expect(out.reset).toBe(true);
    expect(out.state.mode).toBe("off");
  });

  test("экран завершения возвращается к началу без вопросов", () => {
    // спрашивать «вы ещё здесь» у пустого стула незачем, а на экране может
    // стоять план безопасности — он показывается только при сработавшей тревоге
    const out = tick(start(true, 0, AFTER_FINISH), 45_001, AFTER_FINISH);
    expect(out.reset).toBe(true);
    expect(out.state.mode).toBe("off");
  });

  test("выключенный сторож не срабатывает никогда", () => {
    // сторож живёт всё время, а сбрасывать обязан только на нужных экранах
    const s = start(false, 0, WHILE_RUNNING);
    expect(tick(s, 10_000_000, WHILE_RUNNING).reset).toBe(false);
  });
});
