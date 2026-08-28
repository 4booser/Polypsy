import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { drafts, pickDraft, type LocalDraft } from "../src/offline/cache";

/**
 * Локальный черновик прохождения.
 *
 * До этого черновик жил только на сервере, и офлайн автосохранение молча
 * ничего не делало: телефон, севший на сто восьмидесятом пункте МЛО-200 в
 * подвале без связи, стоил человеку всего прохождения. Здесь проверяется
 * ровно то, ради чего локальная копия появилась.
 */

const draft = (surveyId: string, answers: number, savedAt: string, synced = false): LocalDraft => ({
  surveyId,
  answers: Array.from({ length: answers }, (_, i) => ({ questionId: `q${i}`, optionIds: ["o"] })),
  startedAt: "2026-01-01T10:00:00.000Z",
  durationMs: 60_000,
  events: [],
  savedAt,
  synced,
});

beforeEach(() => {
  resetStore();
});

describe("черновик на устройстве", () => {
  test("сохраняется и читается по методике", () => {
    drafts.save(draft("s1", 180, "2026-01-01T11:00:00.000Z"));
    expect(drafts.get("s1")?.answers).toHaveLength(180);
    expect(drafts.get("s2")).toBeNull();
  });

  test("один черновик на методику: повторное сохранение заменяет", () => {
    drafts.save(draft("s1", 10, "2026-01-01T11:00:00.000Z"));
    drafts.save(draft("s1", 42, "2026-01-01T11:05:00.000Z"));

    expect(drafts.get("s1")?.answers).toHaveLength(42);
    expect(drafts.unsynced()).toHaveLength(1);
  });

  test("в досылку попадают только не ушедшие на сервер", () => {
    drafts.save(draft("s1", 5, "2026-01-01T11:00:00.000Z", true));
    drafts.save(draft("s2", 7, "2026-01-01T11:00:00.000Z", false));

    expect(drafts.unsynced().map((d) => d.surveyId)).toEqual(["s2"]);
  });

  test("после сдачи черновик удаляется", () => {
    /*
     * Иначе при следующем открытии методики приложение предложило бы
     * «продолжить» уже сданное прохождение.
     */
    drafts.save(draft("s1", 200, "2026-01-01T11:00:00.000Z"));
    drafts.drop("s1");

    expect(drafts.get("s1")).toBeNull();
    expect(drafts.unsynced()).toEqual([]);
  });

});

describe("какой черновик продолжать", () => {
  const remote = (answers: number, lastSavedAt: string | null) => ({
    answers: Array.from({ length: answers }, (_, i) => ({ questionId: `r${i}` })),
    startedAt: "2026-01-01T10:00:00.000Z",
    durationMs: 30_000,
    lastSavedAt,
  });

  test("локальный новее — продолжаем с него", () => {
    /*
     * Ровно этот случай: человек отвечал без сети. Серверная копия отстала на
     * сто вопросов, и молча предпочесть её значит выбросить их.
     */
    const chosen = pickDraft(
      draft("s1", 180, "2026-01-01T12:00:00.000Z"),
      remote(80, "2026-01-01T11:00:00.000Z"),
    );
    expect(chosen?.answers).toHaveLength(180);
  });

  test("серверный новее — продолжаем с него", () => {
    // другое устройство или другой сеанс: локальная копия устарела
    const chosen = pickDraft(
      draft("s1", 80, "2026-01-01T11:00:00.000Z"),
      remote(180, "2026-01-01T12:00:00.000Z"),
    );
    expect(chosen?.answers).toHaveLength(180);
  });

  test("при равенстве выигрывает серверный", () => {
    const chosen = pickDraft(
      draft("s1", 50, "2026-01-01T12:00:00.000Z"),
      remote(50, "2026-01-01T12:00:00.000Z"),
    );
    expect((chosen?.answers[0] as { questionId: string }).questionId).toBe("r0");
  });

  test("пустой черновик не предлагается к продолжению", () => {
    expect(pickDraft(draft("s1", 0, "2026-01-01T12:00:00.000Z"), null)).toBeNull();
    expect(pickDraft(null, remote(0, "2026-01-01T12:00:00.000Z"))).toBeNull();
    expect(pickDraft(null, null)).toBeNull();
  });

  test("сервер молчит — продолжаем с устройства", () => {
    const chosen = pickDraft(draft("s1", 120, "2026-01-01T12:00:00.000Z"), null);
    expect(chosen?.answers).toHaveLength(120);
    expect(chosen?.lastSavedAt).toBe("2026-01-01T12:00:00.000Z");
  });
});
