import { beforeEach, describe, expect, test } from "bun:test";
import { SERVER_FAILURES_MAX, retriesServerFailure } from "@quizzy/shared";
import { resetStore } from "./store.mock";
import { json, loadClient, serve, signIn, useFakeServer } from "./client.harness";
import { enqueue, pending, rejectedItems } from "../src/offline/queue";

/**
 * 500 при досылке очереди — не приговор, как и в веб-кабинете (#201).
 *
 * Веб после #172 считает сбой сервера временным до SERVER_FAILURES_MAX
 * падений на одной сдаче, а мобилка помечала сдачу отклонённой с первого же
 * 500: одна и та же сдача на телефоне ждала разбора человеком, а в браузере
 * ушла бы следующим проходом. Теперь правило и порог — общие
 * (packages/shared, retriesServerFailure).
 *
 * Через настоящий клиент (api.flushQueue) и подменённый сервер.
 */

useFakeServer();

const ownerOf = () => `patient-${crypto.randomUUID().slice(0, 8)}`;

/** Сервер сдач: на сдачи из `broken` — 500, на прочие — 201; кого и с каким id принял */
function submissions(broken: Set<string>) {
  const st = { calls: [] as string[], accepted: [] as { surveyId: string; clientRequestId: string }[] };
  serve((path, init) => {
    const m = /^\/api\/surveys\/([^/]+)\/responses$/.exec(path);
    if (!m) return json(404, { error: "not found" });
    const surveyId = m[1]!;
    st.calls.push(surveyId);
    if (broken.has(surveyId)) return json(500, { error: "Внутрішня помилка сервера", requestId: "r-500" });
    st.accepted.push({ surveyId, clientRequestId: JSON.parse(String(init.body)).clientRequestId });
    return json(201, { id: `resp-${surveyId}`, scores: [] });
  });
  return st;
}

beforeEach(() => {
  resetStore();
});

describe("мобилка: сбой сервера при досылке", () => {
  test("после 500 и здорового прогона сдача уходит — та же, с тем же clientRequestId", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    const item = enqueue(owner, "s1", { answers: [1] });
    const broken = new Set(["s1"]);
    const st = submissions(broken);

    const first = await api.flushQueue();
    expect(first.rejected, "один 500 сделал сдачу отклонённой").toBe(0);
    expect(first.left).toBe(1);
    expect(pending(owner)[0]!.attempts).toBe(1);

    broken.clear();
    const second = await api.flushQueue();
    expect(second).toEqual({ sent: 1, left: 0, rejected: 0 });
    expect(st.accepted).toEqual([{ surveyId: "s1", clientRequestId: item.payload.clientRequestId as string }]);
  });

  test("500 останавливает прогон, как временный отказ: порядок сдач сохраняется", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    enqueue(owner, "s1", {});
    await Bun.sleep(2);
    enqueue(owner, "s2", {});
    const broken = new Set(["s1"]);
    const st = submissions(broken);

    await api.flushQueue();
    expect(st.calls).toEqual(["s1"]);
    broken.clear();
    await api.flushQueue();
    expect(st.accepted.map((a) => a.surveyId)).toEqual(["s1", "s2"]);
  });

  test("сервер падает на сдаче раз за разом — после порога она отклонена с причиной и больше не держит очередь", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    enqueue(owner, "bad", {});
    await Bun.sleep(2);
    enqueue(owner, "good", {});
    const st = submissions(new Set(["bad"]));

    for (let i = 1; i < SERVER_FAILURES_MAX; i++) {
      expect((await api.flushQueue()).rejected, `прогон ${i}`).toBe(0);
    }
    expect(st.accepted).toEqual([]);
    const last = await api.flushQueue();
    expect(last).toEqual({ sent: 1, left: 0, rejected: 1 });
    expect(st.accepted.map((a) => a.surveyId)).toEqual(["good"]);
    expect(rejectedItems(owner)[0]!.rejectedReason).toContain("Внутрішня помилка сервера");
  });

  test("положительный контроль: отказ по существу (4xx) — отклонена сразу и не держит остальных", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    enqueue(owner, "gone", {});
    await Bun.sleep(2);
    enqueue(owner, "ok", {});
    serve((path) =>
      path === "/api/surveys/gone/responses" ? json(409, { error: "Методику знято" }) : json(201, { id: "r", scores: [] }),
    );
    expect(await api.flushQueue()).toEqual({ sent: 1, left: 0, rejected: 1 });
  });

  test("правило общее с веб-кабинетом: 5xx повторяется до порога, 4xx — нет", () => {
    expect(retriesServerFailure(500, 1)).toBe(true);
    expect(retriesServerFailure(500, SERVER_FAILURES_MAX)).toBe(false);
    expect(retriesServerFailure(409, 1)).toBe(false);
  });
});
