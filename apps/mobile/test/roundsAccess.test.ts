import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { json, loadClient, noNetwork, serve, signIn, useFakeServer } from "./client.harness";
import { cache } from "../src/offline/cache";

/**
 * Кэш обхода — только без сети (#126).
 *
 * Было: rounds() и roundsCard() ловили любую ошибку и отдавали кэш, а экран
 * подписывал его «Мережі немає». Специалист открыл обход и карту p1, потом
 * пациента вывели из его зоны (403) или учётку выключили (refresh — 401), а
 * карта с баллами всё равно открывалась — из копии, которая не устаревает.
 * Остальные чтения отдают кэш только при status 0 (offlineFallback); обход
 * теперь идёт тем же путём, а отказ доступа копию ещё и уносит.
 */

useFakeServer();

const STAFF = "staff-126";
const WORKLIST = { items: [{ userId: "p1", fullName: "Петренко" }] };
const CARD = { fullName: "Петренко", sex: null, age: null, surveys: [{ surveyId: "s1", title: "PHQ-9" }] };

/** Сервер, который сначала всё отдаёт; `deny` — что он отвечает потом */
function server(deny: { status: number } | "offline" | null) {
  serve((path) => {
    if (path === "/api/auth/refresh") return json(401, { error: "refresh revoked" });
    if (deny === "offline") return noNetwork();
    if (deny) return json(deny.status, { error: "forbidden" });
    if (path === "/api/worklist") return json(200, WORKLIST);
    if (path === "/api/dynamics/respondents/p1") return json(200, CARD);
    return json(404, { error: "not found" });
  });
}

/** Специалист открыл обход и карту p1, пока всё было можно: копии легли */
async function openedRounds() {
  const api = await loadClient();
  signIn(STAFF);
  server(null);
  expect((await api.rounds()).cachedAt).toBeNull();
  expect((await api.roundsCard("p1")).cachedAt).toBeNull();
  expect(cache.rounds(STAFF)).not.toBeNull();
  expect(cache.patientCard(STAFF, "p1")).not.toBeNull();
  return api;
}

beforeEach(() => {
  resetStore();
});

describe("отказ доступа — не «нет сети»", () => {
  test("пациента вывели из зоны (403) — карта и обход не отдаются из кэша, копии уходят", async () => {
    const api = await openedRounds();
    server({ status: 403 });

    await expect(api.roundsCard("p1")).rejects.toMatchObject({ status: 403 });
    expect(cache.patientCard(STAFF, "p1"), "карта, которую сервер не показал, не остаётся на устройстве").toBeNull();

    await expect(api.rounds()).rejects.toMatchObject({ status: 403 });
    expect(cache.rounds(STAFF)).toBeNull();
  });

  test("учётку выключили (401, продление отвергнуто) — то же самое", async () => {
    const api = await openedRounds();
    server({ status: 401 });

    await expect(api.roundsCard("p1")).rejects.toMatchObject({ status: 401 });
    await expect(api.rounds()).rejects.toMatchObject({ status: 401 });
    expect(cache.patientCard(STAFF, "p1")).toBeNull();
    expect(cache.rounds(STAFF)).toBeNull();
  });

  test("отказ обхода целиком уносит и карты", async () => {
    const api = await openedRounds();
    server({ status: 403 });

    await expect(api.rounds()).rejects.toMatchObject({ status: 403 });
    expect(cache.patientCard(STAFF, "p1")).toBeNull();
  });
});

describe("без сети кэш отдаётся, как прежде", () => {
  test("status 0 — список и карта из кэша, с отметкой, когда сняты", async () => {
    const api = await openedRounds();
    server("offline");

    const rounds = await api.rounds();
    expect(rounds.list).toEqual(WORKLIST as never);
    expect(rounds.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const card = await api.roundsCard("p1");
    expect(card.card.fullName).toBe("Петренко");
    expect(card.cachedAt).not.toBeNull();
  });

  test("истёк access, а продлить не дала сеть — это тоже «нет сети», кэш отдаётся", async () => {
    const api = await openedRounds();
    serve((path) => {
      if (path === "/api/auth/refresh") return noNetwork();
      return json(401, { error: "token expired" });
    });

    expect((await api.roundsCard("p1")).cachedAt).not.toBeNull();
    expect((await api.rounds()).cachedAt).not.toBeNull();
  });

  test("кэша нет — исходная ошибка, а не пустота", async () => {
    const api = await loadClient();
    signIn(STAFF);
    server("offline");
    await expect(api.roundsCard("p2")).rejects.toMatchObject({ status: 0 });
  });
});
