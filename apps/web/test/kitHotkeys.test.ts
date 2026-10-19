import { describe, expect, test } from "bun:test";
import { hotkeyFor, hotkeyNames, layerAbove } from "../src/ui/keys";

/**
 * Клавиши набора (useHotkeys) — по месту клавиши, а не по знаку.
 *
 * Консоль открывают на украинской и русской раскладке. Прежний набор искал
 * в карте e.key: на кириллице J печатает «о», а «/» — «.», и подсказки
 * «J K рядки», «/ пошук» молчали ровно у тех, кто пишет нотатки
 * по-украински. Нажатие здесь — то, что браузер кладёт в событие: знак
 * текущей раскладки (key) и место клавиши (code).
 */

const press = (key: string, code: string, shiftKey = false) => ({ key, code, shiftKey });

/** Какое действие карты сработает: имя ключа карты или null */
function fired(map: Record<string, string>, e: ReturnType<typeof press>): string | null {
  const handlers = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, () => v]));
  return hotkeyFor(handlers, e)?.() ?? null;
}

describe("буквы — по месту клавиши", () => {
  const map = { j: "next", k: "prev", n: "new", r: "review", m: "move" };

  test("латиница — как прежде", () => {
    expect(fired(map, press("j", "KeyJ"))).toBe("next");
    expect(fired(map, press("k", "KeyK"))).toBe("prev");
  });

  test("украинская раскладка: J печатает «о», N — «т», R — «к», M — «ь»", () => {
    expect(fired(map, press("о", "KeyJ"))).toBe("next");
    expect(fired(map, press("л", "KeyK"))).toBe("prev");
    expect(fired(map, press("т", "KeyN"))).toBe("new");
    expect(fired(map, press("к", "KeyR"))).toBe("review");
    expect(fired(map, press("ь", "KeyM"))).toBe("move");
  });

  test("русская раскладка — те же места", () => {
    expect(fired(map, press("о", "KeyJ"))).toBe("next");
    expect(fired(map, press("т", "KeyN"))).toBe("new");
  });

  test("Shift с буквой — та же клавиша, если отдельной прописной в карте нет", () => {
    expect(fired(map, press("О", "KeyJ", true))).toBe("next");
    expect(fired({ ...map, J: "last" }, press("О", "KeyJ", true))).toBe("last");
  });

  test("кириллица в карте рядом с латиницей (прежний обход экранов) срабатывает один раз — по месту", () => {
    const handlers = { j: () => "j", о: () => "о" };
    expect(hotkeyFor(handlers, press("о", "KeyJ"))?.()).toBe("j");
  });

  test("клавиатура без кода (экранная) — по знаку", () => {
    expect(fired(map, press("j", ""))).toBe("next");
  });
});

describe("знаки и цифры", () => {
  test("«/» — клавиша, на которой нарисован «/»: на кириллице она печатает «.»", () => {
    expect(fired({ "/": "search" }, press("/", "Slash"))).toBe("search");
    expect(fired({ "/": "search" }, press(".", "Slash"))).toBe("search");
  });

  test("«[» и «]» на кириллице печатают «х» и «ї» / «ъ»", () => {
    const map = { "[": "back", "]": "forward" };
    expect(fired(map, press("х", "BracketLeft"))).toBe("back");
    expect(fired(map, press("ї", "BracketRight"))).toBe("forward");
    expect(fired(map, press("ъ", "BracketRight"))).toBe("forward");
  });

  test("знак, набранный по-своему, тоже находится: «?» на Shift+7 русской раскладки", () => {
    expect(fired({ "?": "help" }, press("?", "Digit7", true))).toBe("help");
    expect(fired({ "?": "help" }, press(",", "Slash", true))).toBe("help");
  });

  test("цифры верхнего ряда — по месту; с Shift — уже не цифра", () => {
    const map = { "1": "confirmed", "2": "followup" };
    expect(fired(map, press("1", "Digit1"))).toBe("confirmed");
    expect(fired(map, press("!", "Digit1", true))).toBeNull();
    expect(fired(map, press("\"", "Digit2", true))).toBeNull();
  });

  test("цифровой блок: цифра — только при включённом NumLock", () => {
    const map = { "1": "confirmed" };
    expect(fired(map, press("1", "Numpad1"))).toBe("confirmed");
    expect(fired(map, press("End", "Numpad1"))).toBeNull();
  });

  test("именованные клавиши — по имени", () => {
    expect(fired({ Escape: "close" }, press("Escape", "Escape"))).toBe("close");
    expect(fired({ ArrowDown: "down" }, press("ArrowDown", "ArrowDown"))).toBe("down");
  });
});

describe("украинская и русская раскладки: J, K, [, ] и /", () => {
  /*
   * Что браузер кладёт в событие на кириллице, клавиша за клавишей: знак
   * раскладки и место. «[» и «]» — свернуть список, прежнее и следующее
   * прохождение; «/» — поиск: и клавишей, на которой он нарисован (Slash
   * печатает «.»), и той, что печатает «/» в украинской раскладке
   * (Shift+\ в Windows «Українська (розширена)»).
   */
  const map = { j: "next", k: "prev", "[": "collapse", "]": "forward", "/": "search" };
  const layouts: Record<"uk" | "ru", [ReturnType<typeof press>, string][]> = {
    uk: [
      [press("о", "KeyJ"), "next"],
      [press("л", "KeyK"), "prev"],
      [press("х", "BracketLeft"), "collapse"],
      [press("ї", "BracketRight"), "forward"],
      [press(".", "Slash"), "search"],
      [press("/", "Backslash", true), "search"],
    ],
    ru: [
      [press("о", "KeyJ"), "next"],
      [press("л", "KeyK"), "prev"],
      [press("х", "BracketLeft"), "collapse"],
      [press("ъ", "BracketRight"), "forward"],
      [press(".", "Slash"), "search"],
      [press("/", "Backslash", true), "search"],
    ],
  };
  for (const [lang, presses] of Object.entries(layouts)) {
    test(`${lang}: каждая клавиша — своё действие`, () => {
      for (const [e, action] of presses) expect(fired(map, e), `${lang} ${e.code} «${e.key}»`).toBe(action);
    });
  }
});

test("карта, записанная кодами (прежний useCodeKeys экранов), работает тем же набором", () => {
  const map = { KeyJ: "next", Digit1: "confirmed", BracketLeft: "back" };
  expect(fired(map, press("о", "KeyJ"))).toBe("next");
  expect(fired(map, press("1", "Digit1"))).toBe("confirmed");
  expect(fired(map, press("х", "BracketLeft"))).toBe("back");
});

describe("под окном клавиши экрана молчат, ящик решает сам", () => {
  /*
   * N на списке моделей заводил новую модель под открытым окном удаления,
   * цифры 1–6 переключали вкладки за окном выгрузки. Слой, под которым
   * клавиши экрана молчат, — любой модальный, кроме ящика набора.
   */
  const SELECTOR = '[aria-modal="true"]:not([data-drawer])';
  const doc = (open: { modal?: boolean; drawer?: boolean }) => ({
    querySelector: (sel: string) => {
      expect(sel).toBe(SELECTOR);
      return open.modal ? ({} as Element) : null;
    },
  });

  test("окно, палитра, меню «Ще розділи» — слой есть", () => {
    expect(layerAbove(doc({ modal: true }))).toBe(true);
  });

  test("только ящик или ничего — слоя нет", () => {
    expect(layerAbove(doc({ drawer: true }))).toBe(false);
    expect(layerAbove(doc({}))).toBe(false);
  });

  test("вне браузера — слоя нет", () => {
    expect(layerAbove(undefined)).toBe(false);
  });
});

test("порядок имён: место клавиши, её код, потом знак", () => {
  expect(hotkeyNames(press("о", "KeyJ"))).toEqual(["j", "KeyJ", "о", "о"]);
  expect(hotkeyNames(press("О", "KeyJ", true))).toEqual(["J", "j", "KeyJ", "О", "о"]);
  expect(hotkeyNames(press(".", "Slash"))).toEqual(["/", "Slash", ".", "."]);
});
