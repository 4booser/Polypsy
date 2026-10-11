import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ui from "../src/ui";

/**
 * Окно не закрывается, если отпустить мышь на подложке (#179).
 *
 * Подложка закрывала окно по click, не глядя, где началось нажатие. А click
 * достаётся общему предку нажатия и отпускания: выделил протяжкой текст в
 * «Причина вимкнення», «Опис групи» или комментарии разбора, отпустил за
 * краем окна — окно закрыто, набранное потеряно. Окно «Тимчасовий пароль»
 * показывается единожды и закрывалось промахом — сброс приходилось
 * повторять, снова обрывая сессии человека.
 *
 * Модель событий браузера здесь та же: target — где событие случилось,
 * currentTarget — подложка (на ней висят обработчики).
 */

const backdrop = { el: "backdrop" };
const field = { el: "textarea в окне" };
const dialog = { el: "окно" };
const on = (target: object) => ({ target, currentTarget: backdrop });

type Press = { down: (e: object) => void; up: (e: object) => void; click: (e: object) => boolean };
const backdropPress = (ui as { backdropPress?: () => Press }).backdropPress;

/** Нажатие от начала до click: где нажали, где отпустили, кому достался click */
function press(down: object, up: object, click: object = backdrop): boolean {
  expect(backdropPress).toBeFunction();
  const p = backdropPress!();
  p.down(on(down));
  p.up(on(up));
  return p.click(on(click));
}

describe("подложка закрывает окно только нажатием, начатым и законченным на ней", () => {
  test("протяжка из поля за край окна — окно остаётся", () => {
    // click достаётся общему предку — подложке
    expect(press(field, backdrop)).toBe(false);
  });

  test("нажал на подложке, отпустил в окне — окно остаётся", () => {
    expect(press(backdrop, dialog)).toBe(false);
  });

  test("положительный контроль: нажал и отпустил на подложке — окно закрывается", () => {
    expect(press(backdrop, backdrop)).toBe(true);
  });

  test("click внутри окна подложку не касается; прежнее нажатие не переносится на следующий click", () => {
    expect(press(dialog, dialog, dialog)).toBe(false);
    const p = backdropPress!();
    p.down(on(backdrop));
    p.up(on(backdrop));
    expect(p.click(on(backdrop))).toBe(true);
    expect(p.click(on(backdrop)), "click без нового нажатия").toBe(false);
  });
});

describe("общее окно и окна одноразового секрета", () => {
  const src = (f: string) => readFileSync(resolve(import.meta.dir, "../src", f), "utf8");

  test("Modal решает по нажатию целиком, а окно секрета подложкой не закрывает", () => {
    const modal = src("ui/index.tsx");
    expect(modal.includes('<div className="modal-backdrop" onClick={onClose}>'), "подложка закрывает по любому click").toBe(false);
    for (const line of ["onPointerDown={press.down}", "onPointerUp={press.up}", "if (press.click(e) && !secret) onClose();"]) {
      expect(modal.includes(line), line).toBe(true);
    }
  });

  test("временный пароль после сброса и после заведения, пароли импорта — окна секрета", () => {
    const users = src("pages/ops/Users.tsx");
    const tools = src("pages/ops/people2/UserTools.tsx");
    for (const [text, line] of [
      [users, '<Modal title={ut("ops.users.tempPassword")} onClose={done} secret>'],
      [users, '<Modal title={ut("adm.newUser")} onClose={onDone} secret>'],
      [tools, '<Modal title={ut("ops.import.createdTitle")} onClose={onDone} wide secret>'],
    ] as const) {
      expect(text.includes(line), line).toBe(true);
    }
  });
});
