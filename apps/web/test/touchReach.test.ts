import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Действия остаются достижимыми там, где наведения нет.
 *
 * Правка, которую сторож ловит, выглядела безобидно: «⋯» в строке каталога
 * спрятали `opacity-0` и возвращали `group-hover`/`group-focus-within` —
 * ровно так, как нарисовано на кадре f11, где курсор стоит на строке. На
 * планшете и телефоне наведения нет вовсе, фокус мышью тоже не приходит, и
 * все действия строки (переименовать, перенести в папку, архивировать)
 * исчезли с экрана целиком. Ошибка тихая: разметка на месте, обход
 * клавиатурой работает, снимок экрана совпадает с кадром.
 *
 * Проверяется не «есть ли класс», а условие: невидимость обязана стоять ПОД
 * `@media (hover: hover)`, а безусловного `opacity-0` на глифе быть не
 * должно. И обратная половина того же: проявление наведением обязано стоять
 * под тем же медиазапросом — иначе спор двух правил равной специфичности
 * решает порядок в собранном CSS, а у Tailwind медиа-варианты идут после
 * псевдоклассовых, и глиф не показался бы уже нигде.
 */

/** Исходник без комментариев: иначе сторож читает объяснение вместо кода */
const bare = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/*
 * С волны 25 действия строки каталога всплывают не своим «⋯», а полосой
 * действий таблицы набора (DataTable, rowActions): каталог больше не прячет
 * их сам. Сторож стоит там, где теперь живёт правило, — на полосе таблицы,
 * — и следит, что каталог не завёл себе прежнюю самодельную невидимость.
 */
const SURVEY_LIST = bare("../src/pages/constructor/SurveyList.tsx");
const DATA_TABLE = bare("../src/ui/DataTable.tsx");

/** Строка классов полосы действий строки в таблице набора */
const glyphClasses = (() => {
  const at = DATA_TABLE.indexOf("{actions}");
  expect(at, "в строке таблицы больше нет {actions} — проверять нечего").toBeGreaterThan(0);
  const head = DATA_TABLE.slice(0, at);
  const open = head.lastIndexOf("<span");
  return head.slice(open);
})();

const UNCONDITIONAL = /(^|[\s"'`])opacity-0(?![-:\w])/;

describe("действия строки каталога достижимы без мыши", () => {
  test("каталог отдаёт действия строки таблице, а не прячет их сам", () => {
    expect(SURVEY_LIST.includes("rowActions={rowActions}"), "каталог больше не передаёт действия строки таблице").toBe(true);
    expect(UNCONDITIONAL.test(SURVEY_LIST), "каталог снова прячет что-то безусловным opacity-0: на планшете это недостижимо").toBe(
      false,
    );
  });

  test("невидимость объявлена только там, где есть наведение", () => {
    expect(
      glyphClasses.includes("[@media(hover:hover)]:opacity-0"),
      "невидимость полосы действий не ограничена @media (hover: hover)",
    ).toBe(true);
  });

  test("безусловного opacity-0 на полосе нет", () => {
    expect(
      UNCONDITIONAL.test(glyphClasses),
      "полоса действий снова спрятана безусловно: на планшете и телефоне действия строки недостижимы",
    ).toBe(false);
  });

  test("проявление наведением и фокусом стоит под тем же медиазапросом", () => {
    for (const variant of ["group-hover/row", "group-focus-within/row"]) {
      expect(
        glyphClasses.includes(`[@media(hover:hover)]:${variant}:opacity-100`),
        `${variant} вынесен из @media (hover: hover): порядок в собранном CSS решал бы, видно ли полосу`,
      ).toBe(true);
    }
  });

  test("полоса остаётся в разметке: ни hidden, ни display:none", () => {
    for (const hiding of ["hidden", "display:none"]) {
      expect(
        glyphClasses.includes(hiding),
        `полоса убрана из разметки (${hiding}) — вместе с ней из обхода клавиатурой выпадает меню`,
      ).toBe(false);
    }
  });
});

/**
 * Вторая половина того же урока: выключенной кнопке браузер не доставляет
 * события мыши, поэтому `title` на ней не всплывает никогда. Полоса
 * форматирования заключения выключена целиком, и причина недоступности
 * обязана приходить откуда-то ещё.
 */
const EDITOR = bare("../src/components/ConclusionEditor.tsx");

describe("причина недоступности полосы форматирования доходит до человека", () => {
  test("подпись наведения стоит не на выключенной кнопке", () => {
    const disabledWithTitle = /<button[^>]*\bdisabled\b[^>]*\btitle=/.test(EDITOR);
    expect(
      disabledWithTitle,
      "title вернулся на disabled-кнопку: такая подсказка не показывается ни в одном браузере",
    ).toBe(false);
  });

  test("подпись наведения есть на обёртке плашки", () => {
    expect(
      /<span[^>]*\btitle=\{why\}/.test(EDITOR),
      "у плашек полосы не осталось ни одной живой подсказки с причиной",
    ).toBe(true);
  });

  test("та же причина объявлена диктору", () => {
    expect(EDITOR.includes("aria-describedby={whyId}"), "панель не ссылается на текст причины").toBe(true);
    expect(EDITOR.includes('id={whyId} className="sr-only"'), "текста причины для диктора нет").toBe(true);
  });
});
