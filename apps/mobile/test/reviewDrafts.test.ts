import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { json, loadClient, serve, signIn, useFakeServer } from "./client.harness";
import { forgetWipe } from "../src/offline/owner";
import { reviewDrafts } from "../src/staff/reviewDrafts";

/**
 * Черновик разбора сигнала на общем планшете (волна 26).
 *
 * Было: лист разбора держал решение и заметку «що вжито» в памяти под одним
 * номером случая. Специалист закрыл лист, вышел; вошёл второй — и, открыв тот
 * же случай, нашёл в листе чужое решение и чужую заметку о пациенте (проба
 * на веб-сборке: «Зателефонував, домовились про зустріч» у второго). Сохранить
 * их он мог под своим именем.
 *
 * Стало: черновик — владельца, выход и стирание устройства уносят все.
 */

useFakeServer();

const A = "staff-a";
const B = "staff-b";
const CASE = "case-1";
const draft = { outcome: "needs_followup" as const, note: "Зателефонував, домовились про зустріч" };

beforeEach(() => {
  resetStore();
  forgetWipe();
  reviewDrafts.forgetAll();
});

describe("черновик разбора сигнала", () => {
  test("закрыли лист — решение и заметка на месте; другому специалисту их не видно", () => {
    reviewDrafts.set(A, CASE, draft);
    expect(reviewDrafts.get(A, CASE)).toEqual(draft);
    expect(reviewDrafts.get(B, CASE)).toBeNull();
    expect(reviewDrafts.get(null, CASE)).toBeNull();
  });

  test("без владельца не хранится; пустой — не черновик; сохранённый разбор его уносит", () => {
    reviewDrafts.set(null, CASE, draft);
    expect(reviewDrafts.get(A, CASE)).toBeNull();

    reviewDrafts.set(A, CASE, draft);
    reviewDrafts.set(A, CASE, { outcome: null, note: "   " });
    expect(reviewDrafts.get(A, CASE)).toBeNull();

    reviewDrafts.set(A, CASE, draft);
    reviewDrafts.drop(A, CASE);
    expect(reviewDrafts.get(A, CASE)).toBeNull();
  });

  test("выход уносит черновики разбора — следующий на планшете их не находит", async () => {
    const api = await loadClient();
    signIn(A);
    serve(() => json(200, { ok: true }));
    reviewDrafts.set(A, CASE, draft);

    await api.signOut();

    expect(reviewDrafts.get(A, CASE), "черновик вышедшего пережил выход").toBeNull();
    signIn(B);
    expect(reviewDrafts.get(B, CASE)).toBeNull();
  });

  test("стирание устройства уносит черновики разбора", async () => {
    const api = await loadClient();
    signIn(A);
    serve((path) => {
      if (path === "/api/devices/checkin") return json(200, { wipe: true });
      return json(200, { ok: true });
    });
    reviewDrafts.set(A, CASE, draft);

    expect(await api.deviceCheckin(null)).toBe(true);

    expect(reviewDrafts.get(A, CASE), "черновик пережил стирание").toBeNull();
  });
});
