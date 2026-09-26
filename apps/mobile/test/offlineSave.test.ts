import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore, storeFaults } from "./store.mock";
import { cache, drafts, type LocalDraft } from "../src/offline/cache";
import { logoutNotice } from "../src/offline/logout";
import { enqueue, pending } from "../src/offline/queue";
import { isStoreWriteError, StoreWriteError } from "../src/offline/writeError";
import { finishFailureText, finishSubmission } from "../src/runner/finish";

/**
 * Офлайн-сохранение не отчитывается успехом, которого не было.
 *
 * Дефект: хранилище глотало отказ записи (квота, диск), enqueue возвращал
 * запись безусловно, экран показывал «збережено, відправимо пізніше» и
 * стирал черновик — ответы исчезали насовсем после слов о том, что они
 * сохранены. Здесь проверяется вся цепочка: запись не легла → очередь это
 * видит → экран получает отказ → черновик цел → можно повторить.
 */

const A = "patient-a";

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const draft = (surveyId: string): LocalDraft => ({
  surveyId,
  answers: Array.from({ length: 200 }, (_, i) => ({ questionId: `q${i}`, optionIds: ["o"] })),
  startedAt: "2026-01-01T10:00:00.000Z",
  durationMs: 3_600_000,
  events: [],
  savedAt: "2026-01-01T11:00:00.000Z",
  synced: false,
});

/**
 * Как сдача идёт без сети: сервер недоступен → клиент кладёт ответы в очередь
 * (api.submitResponse) → экран стирает черновик, только если это
 * подтвердилось (finishSubmission). Отказ очереди летит наружу как есть — так
 * устроен и клиент: enqueue вызывается прямо в обработчике сетевого отказа.
 */
function finishOffline(surveyId: string) {
  return finishSubmission({
    submit: () =>
      Promise.reject(new HttpError("Немає зв’язку", 0)).catch(() => {
        const item = enqueue(A, surveyId, { answers: [] });
        return { id: item.id, queued: true };
      }),
    dropDraft: () => drafts.drop(A, surveyId),
  });
}

beforeEach(() => {
  resetStore();
});

describe("очередь подтверждает запись", () => {
  test("отказ хранилища летит из enqueue, а не превращается в «сохранено»", () => {
    storeFaults.failWrite = (name) => name.startsWith("queue:");
    let caught: unknown = null;
    try {
      enqueue(A, "s1", { answers: [] });
    } catch (error) {
      caught = error;
    }
    expect(isStoreWriteError(caught)).toBe(true);
    expect(pending(A)).toEqual([]);
  });

  test("хранилище, проглотившее отказ, тоже ловится — запись читается назад", () => {
    /*
     * Ровно поведение прежнего хранилища: исключения нет, записи тоже нет.
     * Без чтения назад enqueue отчитался бы успехом.
     */
    storeFaults.swallowWrite = (name) => name.startsWith("queue:");
    expect(() => enqueue(A, "s1", { answers: [] })).toThrow(StoreWriteError);
    expect(pending(A)).toEqual([]);
  });
});

describe("завершение прохождения: черновик стирается только после подтверждённой записи", () => {
  test("запись упала — черновик цел, исход — отказ «не сохранено»", async () => {
    drafts.save(A, draft("s1"));
    storeFaults.failWrite = (name) => name.startsWith("queue:");

    const outcome = await finishOffline("s1");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.notSaved).toBe(true);
    // все двести ответов на месте: следующая попытка начнёт не с нуля
    expect(drafts.get(A, "s1")?.answers).toHaveLength(200);
    expect(pending(A)).toEqual([]);
  });

  test("повтор после того, как место освободилось, проходит и только тогда стирает черновик", async () => {
    drafts.save(A, draft("s1"));
    storeFaults.failWrite = (name) => name.startsWith("queue:");
    expect((await finishOffline("s1")).ok).toBe(false);

    storeFaults.failWrite = null;
    const again = await finishOffline("s1");

    expect(again.ok).toBe(true);
    expect(drafts.get(A, "s1")).toBeNull();
    expect(pending(A)).toHaveLength(1);
  });

  test("отказ сервера — тоже отказ; черновик не трогается", async () => {
    drafts.save(A, draft("s1"));
    const outcome = await finishSubmission({
      submit: () => Promise.reject(new HttpError("Методику архівовано", 409)),
      dropDraft: () => drafts.drop(A, "s1"),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.notSaved).toBe(false);
    expect(drafts.get(A, "s1")).not.toBeNull();
  });

  test("человеку — понятная фраза, а не текст ошибки хранилища", () => {
    const ut = (key: string) => `«${key}»`;
    expect(finishFailureText({ notSaved: true, error: new StoreWriteError("queue:1") }, ut)).toBe(
      "«ms.notSavedOnDevice»",
    );
    expect(finishFailureText({ notSaved: false, error: new HttpError("Методику архівовано", 409) }, ut)).toBe(
      "Методику архівовано",
    );
    expect(finishFailureText({ notSaved: false, error: "?" }, ut)).toBe("«runner.submitFailed»");
  });
});

describe("кто глотает отказ записи, а кто нет", () => {
  test("кэш глотает: копия серверного не должна ронять успешный запрос", () => {
    storeFaults.failWrite = () => true;
    expect(() => cache.saveSurveyList(A, [] as never)).not.toThrow();
    expect(() => cache.saveSafetyPlan(A, null)).not.toThrow();
  });

  test("черновик не глотает: экран обязан знать, что копия не легла", () => {
    storeFaults.failWrite = (name) => name.includes(":draft:");
    expect(() => drafts.save(A, draft("s1"))).toThrow(StoreWriteError);
  });
});

describe("выход при неотправленном", () => {
  test("нечего сказать — выход без вопроса", () => {
    expect(logoutNotice({ submissions: 0, drafts: 0 })).toBeNull();
  });

  test("сколько осталось и чего — отдельными строками", () => {
    expect(logoutNotice({ submissions: 2, drafts: 0 })).toEqual([{ key: "mp.logoutKeepsAnswers", n: 2 }]);
    expect(logoutNotice({ submissions: 0, drafts: 1 })).toEqual([{ key: "mp.logoutKeepsDrafts", n: 1 }]);
    expect(logoutNotice({ submissions: 3, drafts: 1 })).toEqual([
      { key: "mp.logoutKeepsAnswers", n: 3 },
      { key: "mp.logoutKeepsDrafts", n: 1 },
    ]);
  });
});
