import { describe, expect, test } from "bun:test";
import { framed, overviewHref } from "../src/pages/Start";

/**
 * Рамка «Зведення» и стартовый экран из настройки рабочего места.
 *
 * На «/» стоит выбранный стартовый экран; рамка с вкладками — только когда
 * это огляд. Огляд при этом остаётся достижимым по своей ссылке — иначе с
 * ним пропадала бы и «Налаштувати зведення», где стартовый экран меняют.
 */
describe("рамка начала смены", () => {
  test("на «/» рамка — только у огляда; на вкладках дня и приглашений — всегда", () => {
    expect(framed("/", undefined)).toBe(true);
    expect(framed("/", "dashboard")).toBe(true);
    expect(framed("/", "worklist")).toBe(false);
    expect(framed("/", "alerts")).toBe(false);
    expect(framed("/today", "worklist")).toBe(true);
    expect(framed("/invites", "patients")).toBe(true);
  });

  test("огляд достижим и при другом стартовом экране", () => {
    expect(overviewHref(undefined)).toBe("/");
    expect(overviewHref("dashboard")).toBe("/");
    expect(overviewHref("worklist")).toBe("/?view=overview");
    expect(framed("/", "worklist", "overview")).toBe(true);
  });
});
