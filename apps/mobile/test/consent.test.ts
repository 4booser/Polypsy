import { describe, expect, test } from "bun:test";
import { actionsOf, viewOfLoadError, viewOfStatus, type ConsentView } from "../src/consent/model";

/**
 * Экран согласия: из каждого состояния есть выход, и «погоджуюся» бывает
 * только рядом с текстом.
 *
 * Ловушка из внешнего разбора — экран с одной кнопкой «соглашаюсь». Отказ
 * потом появился, но сразу выводил из учётной записи: объяснение последствий
 * ставилось на экран, который в тот же миг закрывался, а сервер об отказе не
 * узнавал (это — в apps/api/test/access.test.ts). И рядом жила вторая беда:
 * при ошибке загрузки кнопка «погоджуюся» принимала текст, которого человек
 * не видел.
 */

const status = (over: Partial<{ required: boolean; accepted: boolean; text: string | null }>) => ({
  required: true,
  accepted: false,
  version: 3,
  text: "Я погоджуюся на обстеження.",
  ...over,
});

const EXITS = new Set(["decline", "signOut"]);

describe("что показать", () => {
  test("не требуется или уже принято — дальше, в приложение", () => {
    expect(viewOfStatus(status({ required: false }))).toEqual({ kind: "pass" });
    expect(viewOfStatus(status({ accepted: true }))).toEqual({ kind: "pass" });
  });

  test("есть текст — читать и выбирать", () => {
    expect(viewOfStatus(status({}))).toEqual({ kind: "read", text: "Я погоджуюся на обстеження." });
  });

  test("текст пустой — это «не получен», а не «принять пустое»", () => {
    expect(viewOfStatus(status({ text: null }))).toEqual({ kind: "failed" });
    expect(viewOfStatus(status({ text: "   " }))).toEqual({ kind: "failed" });
  });

  test("без сети не запираем уже работавшего; ошибка сервера — не пропуск", () => {
    expect(viewOfLoadError(0)).toEqual({ kind: "pass" });
    expect(viewOfLoadError(500)).toEqual({ kind: "failed" });
    expect(viewOfLoadError(undefined)).toEqual({ kind: "failed" });
  });
});

describe("выходы", () => {
  const views: ConsentView[] = [{ kind: "read", text: "т" }, { kind: "failed" }, { kind: "declined" }];

  test("из каждого состояния экрана можно уйти, не соглашаясь", () => {
    for (const view of views) {
      expect(actionsOf(view).some((a) => EXITS.has(a))).toBe(true);
    }
  });

  test("«погоджуюся» — только рядом с текстом", () => {
    expect(actionsOf({ kind: "read", text: "т" })).toContain("accept");
    expect(actionsOf({ kind: "failed" })).not.toContain("accept");
    expect(actionsOf({ kind: "declined" })).not.toContain("accept");
  });

  test("рядом с «погоджуюся» всегда стоит «не погоджуюся»", () => {
    expect(actionsOf({ kind: "read", text: "т" })).toEqual(["accept", "decline"]);
  });

  test("отказ — не тупик: можно выйти или вернуться к тексту и передумать", () => {
    expect(actionsOf({ kind: "declined" })).toEqual(["signOut", "reconsider"]);
  });

  test("текст не загрузился — повторить или выйти", () => {
    expect(actionsOf({ kind: "failed" })).toEqual(["retry", "signOut"]);
  });
});
