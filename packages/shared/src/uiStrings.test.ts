import { describe, expect, test } from "bun:test";
import { EMPTY_BY_DESIGN_EN, UI, makeUiT, detectLang, parseAcceptLanguage, untranslatedEn, uiText, type UiKey } from "./uiStrings";
import { LANGS, LANG_FALLBACK, LANG_NAMES, contentLangNotice, presentedLang, t } from "./types";
import { ERRORS } from "./errorStrings";
import { PUSH, renderPush } from "./pushStrings";
import { LOCALE_OF, formatDuration } from "./format";

/**
 * Словарь оболочки.
 *
 * Проверяется не перевод — его качество тестом не поймать, — а полнота и
 * отсутствие подделок. Ключ с пустым или совпадающим переводом означает, что
 * человек, переключивший язык, увидит чужой: половина экрана на украинском,
 * половина на русском. Это хуже, чем один язык честно.
 */
const entries = Object.entries(UI) as [UiKey, { uk: string; ru: string }][];

describe("словарь оболочки", () => {
  test("у каждого ключа есть оба языка и оба непустые", () => {
    const broken = entries
      .filter(([, v]) => !v.uk?.trim() || !v.ru?.trim())
      .map(([k]) => k);
    expect(broken).toEqual([]);
  });

  test("нет ключей, где украинский — копия русского", () => {
    /*
     * Совпадение допустимо там, где слово одинаково в обоих языках
     * («Email», «Методики»), поэтому запрещаем только длинные фразы: их
     * совпадение почти наверняка значит «скопировал и не перевёл».
     */
    /*
     * Рыба с кадра — исключение с именем и сроком, а не молчаливая поблажка.
     * На кадре f00 текст «Про кампанію» набран латинской рыбой: настоящего
     * заказчик не дал, а рисовать свой значило бы выдумать за него. Рыба
     * одинакова на обоих языках по определению. Как только текст появится,
     * ключ уходит отсюда — и проверка снова начнёт его сторожить. Список
     * может только уменьшаться.
     */
    const PLACEHOLDER = new Set<string>(["pub.aboutText"]);
    const suspicious = entries
      .filter(([k, v]) => v.uk === v.ru && v.ru.length > 24 && !PLACEHOLDER.has(k))
      .map(([k, v]) => `${k}: ${v.ru}`);
    expect(suspicious).toEqual([]);
    // исключение обязано указывать на существующий ключ, иначе оно переживёт свой повод
    expect([...PLACEHOLDER].filter((k) => !entries.some(([key]) => key === k))).toEqual([]);
  });

  test("перевод возвращает строку для любого ключа", () => {
    // все языки, включая английский: у непереведённой записи — украинский, а не пустота
    for (const lang of LANGS) {
      const t = makeUiT(lang);
      for (const [key] of entries) {
        expect(typeof t(key)).toBe("string");
        // пустой английский суффикс года — намеренно (EMPTY_BY_DESIGN_EN)
        if (lang === "en" && EMPTY_BY_DESIGN_EN.has(key)) continue;
        expect(t(key).length).toBeGreaterThan(0);
      }
    }
  });

  test("язык определяется по настройкам браузера, украинский по умолчанию", () => {
    expect(detectLang(["uk-UA", "en"])).toBe("uk");
    expect(detectLang(["ru-RU"])).toBe("ru");
    // был украинским, пока английского не было; теперь английский браузер получает английский
    expect(detectLang(["en-US"])).toBe("en");
    expect(detectLang([])).toBe("uk");
  });

  test("порядок в списке языков — решение человека, и первый умеемый выигрывает", () => {
    expect(detectLang(["en-GB", "uk"])).toBe("en");
    expect(detectLang(["de-DE", "ru", "en"])).toBe("ru");
    expect(detectLang(["pl", "uk-UA"])).toBe("uk");
  });

  test("список без наших языков — английский, пустой список — украинский", () => {
    /*
     * Немецкий или французский браузер без украинского, русского и
     * английского держит, скорее всего, доброволец из-за рубежа: английский
     * он прочтёт вернее украинского. Ничего не известно — умолчание
     * учреждения. Решение и его довод — у detectLang.
     */
    expect(detectLang(["de-DE", "de"])).toBe("en");
    expect(detectLang(["fr"])).toBe("en");
    expect(detectLang(["*"])).toBe("uk");
    expect(detectLang(["", " "])).toBe("uk");
  });

  test("заголовок Accept-Language разбирается по весам", () => {
    expect(parseAcceptLanguage("en-GB,en;q=0.9,uk;q=0.8")).toEqual(["en-GB", "en", "uk"]);
    expect(parseAcceptLanguage("uk;q=0.5, ru;q=0.9")).toEqual(["ru", "uk"]);
    // нулевой вес — «не присылать на этом языке», звёздочка — не язык
    expect(parseAcceptLanguage("en;q=0, uk")).toEqual(["uk"]);
    expect(parseAcceptLanguage("*")).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(detectLang(parseAcceptLanguage("en-US,uk;q=0.9"))).toBe("en");
  });
});

/**
 * Английский — третий язык оболочки (решение заказчика 2026-09-26).
 *
 * Перевод словаря оболочки идёт отдельно и не за один день, поэтому здесь
 * две разные строгости. Всё, что уже переведено, проверяется сразу и
 * строго: перевод непустой, без кириллицы, с теми же подстановками. Сколько
 * НЕ переведено — только считается, и проверка не падает: непереведённая
 * запись показывает украинский (makeUiT), это ожидаемое промежуточное
 * состояние, а не поломка.
 *
 * Когда счёт дойдёт до нуля, тест «считает непереведённые» становится
 * строгим: `expect(missing).toEqual([])`, а поле `en?` в UiEntry —
 * обязательным `en`. После этого пропущенный перевод будет ловить
 * компилятор.
 */
describe("английский в словаре оболочки", () => {
  const CYRILLIC = /[А-Яа-яЁёІіЇїЄєҐґ]/;
  /*
   * Язык, названный на себе самом, — не перевод: в списке языков
   * «Українська» стоит украинскими буквами на любом интерфейсе (см.
   * LANG_NAMES и langLetters.test.ts). «adm.inEnglish» — наоборот: подпись
   * поля «In English» латиницей и в украинском, и в русском интерфейсе.
   */
  const SELF_NAMED = new Set<string>(["lang.uk", "lang.ru", "adm.inUkrainian", "adm.inRussian"]);
  const translated = (Object.entries(UI) as [UiKey, { uk: string; ru: string; en?: string }][]).filter(
    ([, v]) => v.en !== undefined,
  );

  test("переведено всё", () => {
    // словарь переведён целиком в волне 9; тип UiEntry требует en, а этот
    // тест ловит пустую строку, которую тип пропускает
    expect(untranslatedEn()).toEqual([]);
  });

  test("переведённое — непустое и не заглушка", () => {
    const bad = translated
      .filter(([k, v]) => (!v.en!.trim() && !EMPTY_BY_DESIGN_EN.has(k)) || /TODO|FIXME|xxx/i.test(v.en!))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  test("в переведённом нет кириллицы", () => {
    const leaked = translated
      .filter(([k, v]) => !SELF_NAMED.has(k) && CYRILLIC.test(v.en!))
      .map(([k, v]) => `${k}: «${v.en}»`);
    expect(leaked, "в английское поле попал украинский или русский текст").toEqual([]);
  });

  test("подстановки в переводе те же, что в украинском", () => {
    const marks = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    const bad = translated.filter(([, v]) => marks(v.en!) !== marks(v.uk)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  test("без перевода английский показывает украинский, а не ключ и не русский", () => {
    const [key] = untranslatedEn();
    if (!key) return; // перевод закончен — проверять нечего
    expect(makeUiT("en")(key)).toBe(UI[key].uk);
    expect(uiText(key, "en")).toBe(UI[key].uk);
  });

  test("переведённое показывается по-английски", () => {
    expect(makeUiT("en")("top.lang")).toBe("Eng");
    expect(makeUiT("uk")("top.lang")).toBe("Укр");
    expect(LANG_NAMES.en).toEqual({ full: "English", short: "ENG" });
  });
});

describe("английский в словарях сервера", () => {
  const CYRILLIC = /[А-Яа-яЁёІіЇїЄєҐґ]/;
  const marks = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

  test("уведомления переведены целиком, без кириллицы, с теми же подстановками", () => {
    const bad: string[] = [];
    for (const [key, v] of Object.entries(PUSH)) {
      if (!v.en?.trim()) bad.push(`${key}: пустой en`);
      else if (CYRILLIC.test(v.en)) bad.push(`${key}: кириллица в en`);
      else if (marks(v.en) !== marks(v.uk)) bad.push(`${key}: другие подстановки`);
    }
    expect(bad).toEqual([]);
    expect(renderPush("push.room", "en", { room: 214 })).toBe(", room 214");
  });

  test("отказы — тоже: у ERRORS английский обязателен", () => {
    // полноту держит тип (ErrorEntry), здесь — то, чего тип не видит
    const leaked = Object.entries(ERRORS)
      .filter(([, v]) => CYRILLIC.test(v.en))
      .map(([k]) => k);
    expect(leaked).toEqual([]);
  });
});

describe("содержимое методик при английском интерфейсе", () => {
  test("t() берёт английский, затем украинский, затем русский", () => {
    expect(t({ uk: "Так", ru: "Да", en: "Yes" }, "en")).toBe("Yes");
    expect(t({ uk: "Так", ru: "Да" }, "en")).toBe("Так");
    expect(t({ ru: "Да" }, "en")).toBe("Да");
    // для прежних языков порядок не изменился
    expect(t({ uk: "Так", ru: "Да" }, "ru")).toBe("Да");
    expect(t({ ru: "Да" }, "uk")).toBe("Да");
    expect(t({ uk: "Так" }, "ru")).toBe("Так");
    // пустая строка — решение автора, а не отсутствие перевода: как было с `??`
    expect(t({ uk: "", ru: "Да" }, "uk")).toBe("");
  });

  test("у каждого языка цепочка начинается с него самого и содержит все языки", () => {
    for (const lang of LANGS) {
      expect(LANG_FALLBACK[lang][0]).toBe(lang);
      expect([...LANG_FALLBACK[lang]].sort()).toEqual([...LANGS].sort());
    }
  });

  test("язык предъявления — тот, откуда t() взял текст", () => {
    expect(presentedLang({ uk: "Так", ru: "Да" }, "en")).toBe("uk");
    expect(presentedLang({ ru: "Да" }, "en")).toBe("ru");
    expect(presentedLang({ uk: "Так", ru: "Да" }, "ru")).toBe("ru");
    expect(presentedLang("строка без языка", "en")).toBe("en");
  });

  test("строка о языке пунктов — только при английском интерфейсе", () => {
    expect(contentLangNotice("en", "uk")).toBe("uk");
    expect(contentLangNotice("en", "ru")).toBe("ru");
    expect(contentLangNotice("en", "en")).toBeNull();
    expect(contentLangNotice("en", undefined)).toBeNull();
    // расхождение украинского с русским было всегда и молча — так и остаётся
    expect(contentLangNotice("uk", "ru")).toBeNull();
    // у каждого возможного ответа есть строка в словаре
    for (const l of ["uk", "ru"] as const) expect(`contentLang.${l}` in UI).toBe(true);
  });
});

describe("форматирование по языку", () => {
  test("английский — en-GB: день первым и 24 часа", () => {
    expect(LOCALE_OF.en).toBe("en-GB");
    const d = new Date(Date.UTC(2026, 8, 2, 14, 5));
    expect(d.toLocaleDateString(LOCALE_OF.en, { timeZone: "UTC" })).toBe("02/09/2026");
    expect(d.toLocaleTimeString(LOCALE_OF.en, { timeZone: "UTC", hour: "2-digit", minute: "2-digit" })).toBe(
      "14:05",
    );
  });

  test("длительность говорит на языке интерфейса", () => {
    expect(formatDuration(65_000, "en")).toBe("1 min 5 s");
    expect(formatDuration(4200, "en")).toBe("4.2 s");
    expect(formatDuration(65_000, "uk")).toBe("1 хв 5 с");
    expect(formatDuration(4200, "uk")).toBe("4,2 с");
    // без языка — как было до языков
    expect(formatDuration(65_000)).toBe("1 мин 5 с");
    expect(formatDuration(0, "en")).toBe("—");
  });
});

describe("палитра одна на все приложения", () => {
  test("у каждой степени есть заливка и текст в обеих темах", async () => {
    const { SEVERITY_FILL, SEVERITY_TEXT_DARK, SEVERITY_TEXT_LIGHT, SEVERITY_KEY } = await import("./palette");
    for (const sev of ["none", "mild", "moderate", "severe"] as const) {
      for (const set of [SEVERITY_FILL, SEVERITY_TEXT_DARK, SEVERITY_TEXT_LIGHT]) {
        expect(set[sev]).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(SEVERITY_KEY[sev] in UI).toBe(true);
    }
  });

  test("цвет текста проходит порог контраста на своей подложке", async () => {
    /*
     * Считаем, а не доверяем глазу. Порог 4.5:1 — тот же, что проверяет
     * смоук доступности; здесь он закреплён на уровне палитры, чтобы
     * подобранный «на глаз» оттенок не проехал в мобильное приложение,
     * где axe не работает.
     */
    const { SEVERITY_TEXT_DARK, SEVERITY_TEXT_LIGHT } = await import("./palette");
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };

    for (const sev of ["none", "mild", "moderate", "severe"] as const) {
      expect(ratio(SEVERITY_TEXT_DARK[sev], "#16191f")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(SEVERITY_TEXT_LIGHT[sev], "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });
});
