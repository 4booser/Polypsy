import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, appRequest, db, makeUser, root } from "./fixtures";
import { pushTokens } from "../src/db/schema";
import { issuePair } from "../src/lib/refresh";

/**
 * Стирание устройства закрывает его сессию и отвязывает его уведомления (#128).
 *
 * Было (проба под ролью приложения): вход, регистрация push, отметка,
 * суперадмин стирает, /wiped → 200 — а push-токен на месте, и
 * /api/auth/refresh старым refresh → 200. «Стёртое» устройство получало
 * уведомления о тревогах и приёмах, а скопированный с него refresh продлевал
 * сессию ещё месяц.
 *
 * Стало: после /wiped push-токены установки удалены, refresh-семья сессии,
 * которую стирание сняло, отозвана; сессии на других устройствах живы.
 *
 * Запросы — через api() и appRequest() фикстур: в шаге test:app-role ролью
 * приложения, с политиками строк.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const installation = () => `inst-${crypto.randomUUID()}`;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

async function refreshWith(refreshToken: string): Promise<number> {
  const res = await appRequest("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  return res.status;
}

/** Человек с двумя сессиями: планшет отделения и свой телефон, у каждого — свой push */
async function staffOnTwoDevices() {
  const person = await makeUser("admin", `wipe-s-${tag()}@test`);
  const tablet = { ...(await issuePair({ id: person.id, role: "admin" })), device: installation(), push: `ExponentPushToken[t-${tag()}]` };
  const phone = { ...(await issuePair({ id: person.id, role: "admin" })), device: installation(), push: `ExponentPushToken[p-${tag()}]` };
  for (const d of [tablet, phone]) {
    const reg = await api("/api/push/register", d.token, post({ token: d.push, platform: "android", deviceId: d.device }));
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect((await api("/api/devices/checkin", d.token, post({ deviceId: d.device }))).status).toBe(200);
  }
  const asked = await api(`/api/devices/${tablet.device}/wipe`, root.token, post({ userId: person.id }));
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  return { person, tablet, phone };
}

const pushOf = async (userId: string) =>
  (await db.select().from(pushTokens).where(eq(pushTokens.userId, userId))).map((r) => r.token).sort();

describe("подтверждение стирания", () => {
  test("отвязывает push установки и гасит семью её сессии; телефон того же человека жив", async () => {
    const { person, tablet, phone } = await staffOnTwoDevices();

    const wiped = await api(
      "/api/devices/wiped",
      tablet.token,
      post({ deviceId: tablet.device, refreshToken: tablet.refreshToken }),
    );
    expect(wiped.status, JSON.stringify(wiped.body)).toBe(200);

    expect(await pushOf(person.id), "уведомления стёртого планшета остались").toEqual([phone.push]);
    expect(await refreshWith(tablet.refreshToken), "сессия стёртого планшета продлевается").toBe(401);
    // другая семья не тронута: телефон молча продлевает сессию
    expect(await refreshWith(phone.refreshToken)).toBe(200);
  }, 30_000);

  test("чужой refresh в теле не гасит чужую сессию", async () => {
    const { tablet } = await staffOnTwoDevices();
    const stranger = await makeUser("admin", `wipe-x-${tag()}@test`);
    const theirs = await issuePair({ id: stranger.id, role: "admin" });

    const wiped = await api(
      "/api/devices/wiped",
      tablet.token,
      post({ deviceId: tablet.device, refreshToken: theirs.refreshToken }),
    );
    expect(wiped.status).toBe(200);
    expect(await refreshWith(theirs.refreshToken)).toBe(200);
  }, 30_000);

  test("подтверждение старой сборки (без refresh) принимается; push установки всё равно отвязан", async () => {
    const { person, tablet, phone } = await staffOnTwoDevices();
    const wiped = await api("/api/devices/wiped", tablet.token, post({ deviceId: tablet.device }));
    expect(wiped.status).toBe(200);
    expect(await pushOf(person.id)).toEqual([phone.push]);
  }, 30_000);

  test("без команды стирания ничего не отвязывается и не гасится", async () => {
    const person = await makeUser("admin", `wipe-n-${tag()}@test`);
    const pair = await issuePair({ id: person.id, role: "admin" });
    const device = installation();
    const push = `ExponentPushToken[n-${tag()}]`;
    await api("/api/push/register", pair.token, post({ token: push, platform: "ios", deviceId: device }));
    await api("/api/devices/checkin", pair.token, post({ deviceId: device }));

    const wiped = await api("/api/devices/wiped", pair.token, post({ deviceId: device, refreshToken: pair.refreshToken }));
    expect(wiped.status).toBe(404);
    expect(await pushOf(person.id)).toEqual([push]);
    expect(await refreshWith(pair.refreshToken)).toBe(200);
  }, 30_000);
});

describe("регистрация push запоминает установку", () => {
  test("токен, переехавший к вошедшему следом, несёт установку; регистрация без неё прежнюю не затирает", async () => {
    const a = await makeUser("user", `push-a-${tag()}@test`);
    const b = await makeUser("user", `push-b-${tag()}@test`);
    const device = installation();
    const push = `ExponentPushToken[s-${tag()}]`;

    await api("/api/push/register", a.token, post({ token: push, platform: "android", deviceId: device }));
    await api("/api/push/register", b.token, post({ token: push, platform: "android" }));

    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, push));
    expect(row!.userId).toBe(b.id);
    expect(row!.deviceId).toBe(device);
  }, 30_000);
});
