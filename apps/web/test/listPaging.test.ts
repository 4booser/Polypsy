import { describe, expect, test } from "bun:test";
import { uiText } from "@quizzy/shared";
import { shownNote } from "../src/ui/paging";

/**
 * Строка «показано не всё» над курсорным списком (реестр направлений,
 * приглашения).
 *
 * Внешний разбор: «обрезанный список направлений выглядел полным: записи
 * после лимита исчезали без предупреждения». Строка — половина ответа (вторая
 * — дозагрузка), и у неё три случая, каждый со своей ошибкой: промолчать,
 * когда продолжение есть; сказать «не всё», когда всё; назвать выдуманное
 * общее число, когда сервер его не прислал.
 */

const uk = (key: "lists.shownOf" | "lists.shownFirst") => uiText(key, "uk");

describe("строка «показано не всё»", () => {
  test("продолжения нет — строки нет: полный список не притворяется обрезанным", () => {
    expect(shownNote(uk, 12, 12, false)).toBeNull();
    expect(shownNote(uk, 0, 0, false)).toBeNull();
  });

  test("продолжение есть и общее число известно — «показано N з M»", () => {
    const note = shownNote(uk, 100, 143, true);
    expect(note).toContain("100");
    expect(note).toContain("143");
    expect(note).toContain("Показати ще");
  });

  test("общего числа нет — «перші N», без выдуманного «з M»", () => {
    const note = shownNote(uk, 100, null, true);
    expect(note).toContain("перші 100");
    expect(note).not.toContain("{total}");
    expect(note).not.toMatch(/ з \d/);
  });

  test("общее число устарело и не больше показанного — тоже «перші N»: «100 з 100» при живой кнопке читалось бы как сбой", () => {
    expect(shownNote(uk, 100, 100, true)).toContain("перші 100");
  });

  test("на всех трёх языках подстановки заполнены", () => {
    for (const lang of ["uk", "ru", "en"] as const) {
      const t = (key: "lists.shownOf" | "lists.shownFirst") => uiText(key, lang);
      for (const note of [shownNote(t, 5, 9, true), shownNote(t, 5, undefined, true)]) {
        expect(note).not.toBeNull();
        expect(note!).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
