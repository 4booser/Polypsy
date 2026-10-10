import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resetStore } from "./store.mock";
import { json, loadClient, noNetwork, revocations, serve, session, signIn, useFakeServer, type Server } from "./client.harness";
import { deviceId } from "../src/offline/device";

/**
 * Стирание устройства отзывает его сессию и отвязывает push (#128).
 *
 * Было: carryOutWipe снимал токены только на устройстве, а push.ts держал
 * `registered = true`. Сервер не знал, какую сессию и какие уведомления
 * закрыть: «стёртое» устройство получало уведомления о тревогах и приёмах,
 * refresh, скопированный с него, продлевал сессию, а новый вход в том же
 * процессе push не регистрировал.
 *
 * Стало: refresh снятой сессии до снятия встаёт в список «отозвать» и едет
 * с подтверждением (сервер гасит семью и отвязывает push установки —
 * apps/api/test/deviceWipeSession.test.ts); подтверждение не дошло —
 * отзыв уходит своим путём. Регистрация push после стирания — заново, с
 * идентификатором установки.
 */

/* push.ts тянет нативные модули — подменяются до его загрузки */
mock.module("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ status: "granted" }),
  requestPermissionsAsync: async () => ({ status: "granted" }),
  getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[wipe-test]" }),
  setNotificationHandler: () => {},
}));
mock.module("expo-device", () => ({ isDevice: true }));
mock.module("expo-constants", () => ({ default: { expoConfig: null, easConfig: null } }));
const push = await import("../src/push");

useFakeServer();

const ownerOf = () => `staff-${crypto.randomUUID().slice(0, 8)}`;

/** Сервер устройства: команда стирания, подтверждение, отзыв и регистрация push — с записью тел */
function deviceServer(opts: { wipe: boolean; wiped?: Server; logout?: Server }) {
  const bodies: Record<string, unknown[]> = {};
  serve((path, init) => {
    (bodies[path] ??= []).push(init.body ? JSON.parse(String(init.body)) : null);
    if (path === "/api/devices/checkin") return json(200, { wipe: opts.wipe });
    if (path === "/api/devices/wiped") return (opts.wiped ?? (() => json(200, { ok: true })))(path, init);
    if (path === "/api/auth/logout") return (opts.logout ?? (() => json(200, { ok: true })))(path, init);
    if (path === "/api/push/register") return json(200, { ok: true });
    return json(404, { error: "not found" });
  });
  return bodies;
}

beforeEach(() => {
  resetStore();
});

describe("стирание и сессия на сервере", () => {
  test("подтверждение несёт refresh снятой сессии; погашенный сервером — из списка отзыва снят", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    const device = deviceId();
    const bodies = deviceServer({ wipe: true });

    expect(await api.deviceCheckin(null)).toBe(true);
    expect(session.token).toBeNull();
    expect(bodies["/api/devices/wiped"]).toEqual([{ deviceId: device, refreshToken: `refresh-${owner}` }]);
    expect(revocations, "семью погасил сервер — второй отзыв не нужен").toEqual([]);
  });

  test("подтверждение не дошло — refresh остаётся в списке отзыва и уходит при первой связи", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    deviceServer({ wipe: true, wiped: noNetwork, logout: noNetwork });

    expect(await api.deviceCheckin(null)).toBe(true);
    await Bun.sleep(5); // фоновый прогон отзывов после стирания — сети нет, он ничего не снимает
    expect(revocations).toEqual([`refresh-${owner}`]);

    const bodies = deviceServer({ wipe: false });
    await api.flushRevocations();
    expect(bodies["/api/auth/logout"]).toEqual([{ refreshToken: `refresh-${owner}` }]);
    expect(revocations).toEqual([]);
  });

  test("положительный контроль: без команды стирания сессия и список отзыва не тронуты", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    const bodies = deviceServer({ wipe: false });

    expect(await api.deviceCheckin(null)).toBe(false);
    expect(session.refresh).toBe(`refresh-${owner}`);
    expect(revocations).toEqual([]);
    expect(bodies["/api/devices/wiped"]).toBeUndefined();
  });
});

describe("стирание и push", () => {
  test("регистрация несёт установку; после стирания следующий вход регистрирует push заново", async () => {
    const api = await loadClient();
    signIn(ownerOf());
    const bodies = deviceServer({ wipe: true });

    expect(await push.ensurePushRegistered()).toBe(true);
    const before = deviceId();
    expect(bodies["/api/push/register"]).toEqual([
      { token: "ExponentPushToken[wipe-test]", platform: "android", deviceId: before },
    ]);

    expect(await api.deviceCheckin(null)).toBe(true);

    // в том же процессе вошёл следующий — его уведомления должны прийти сюда
    signIn(ownerOf());
    expect(await push.ensurePushRegistered()).toBe(true);
    const registrations = bodies["/api/push/register"] as { deviceId: string }[];
    expect(registrations, "после стирания push не зарегистрирован заново").toHaveLength(2);
    // после стирания установка представляется новой (offline/device.ts)
    expect(registrations[1]!.deviceId).not.toBe(before);
  });

  test("положительный контроль: без стирания повторная регистрация не идёт", async () => {
    const api = await loadClient();
    signIn(ownerOf());
    const bodies = deviceServer({ wipe: false });
    await push.forgetPush(); // с чистого листа: регистрация прошлых тестов этого процесса снята, как при выходе
    delete bodies["/api/push/forget"];

    expect(await push.ensurePushRegistered()).toBe(true);
    expect(await api.deviceCheckin(null)).toBe(false);
    expect(await push.ensurePushRegistered()).toBe(true);
    expect(bodies["/api/push/register"], "регистрация повторилась без причины").toHaveLength(1);
  });
});
