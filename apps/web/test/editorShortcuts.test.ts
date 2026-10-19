import { describe, expect, test } from "bun:test";
import { editorShortcut } from "../src/pages/constructor/shortcuts";

/**
 * Сочетания конструктора и заключения — в любой раскладке.
 *
 * Ctrl+S в русской раскладке приходит с key «ы», в украинской — с «і»;
 * сочетание, сверенное по знаку, молча не срабатывало, и браузер открывал
 * «Сохранить страницу как» вместо черновика.
 */
const key = (code: string, k: string, over: Partial<KeyboardEvent> = {}) =>
  ({ code, key: k, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...over }) as KeyboardEvent;

describe("сочетания редактора", () => {
  test("Ctrl+S, Ctrl+Z, Ctrl+Y — в латинской, русской и украинской раскладке", () => {
    for (const [s, z, y] of [
      ["s", "z", "y"],
      ["ы", "я", "н"],
      ["і", "я", "н"],
    ] as const) {
      expect(editorShortcut(key("KeyS", s)), `Ctrl+S при «${s}»`).toBe("save");
      expect(editorShortcut(key("KeyZ", z)), `Ctrl+Z при «${z}»`).toBe("undo");
      expect(editorShortcut(key("KeyY", y)), `Ctrl+Y при «${y}»`).toBe("redo");
    }
    expect(editorShortcut(key("KeyZ", "Я", { shiftKey: true }))).toBe("redo");
    // ⌘ на маке — то же, что Ctrl
    expect(editorShortcut(key("KeyS", "ы", { ctrlKey: false, metaKey: true }))).toBe("save");
  });

  test("без модификатора, с AltGr или другой клавишей — не сочетание", () => {
    expect(editorShortcut(key("KeyS", "s", { ctrlKey: false }))).toBeNull();
    // Ctrl+Alt — это AltGr: «ś» в польской раскладке не сохраняет черновик
    expect(editorShortcut(key("KeyS", "ś", { altKey: true }))).toBeNull();
    expect(editorShortcut(key("KeyD", "в"))).toBeNull();
  });

  test("клавиша не названа (экранная клавиатура) — по знаку", () => {
    expect(editorShortcut(key("", "s"))).toBe("save");
    expect(editorShortcut(key("Unidentified", "z"))).toBe("undo");
    expect(editorShortcut(key("", "ы"))).toBeNull();
  });
});
