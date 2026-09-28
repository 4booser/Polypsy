import { describe, expect, test } from "bun:test";
import type { MobileReport } from "@quizzy/shared";
import { and, eq } from "drizzle-orm";
import { api, db, makeUser, root } from "./fixtures";
import { devices } from "../src/db/schema";

/**
 * Установка и привязки учётных записей (волна 15, внешний разбор, п. 12).
 *
 * Было: строка устройства — одна на установку, с владельцем «кто вошёл
 * первым». Отметка второго человека на том же планшете обновляла чужую
 * строку и своей не заводила: GET /api/devices у него был пуст, стереть
 * «его» устройство было нельзя — его данные на этой установке управлением
 * устройствами не покрывались вовсе.
 *
 * Стало (миграция 0113): строка — пара «установка + учётная запись».
 * Список устройств, команда стирания и её подтверждение у каждой привязки
 * свои; техпанель считает установки, а не привязки.
 *
 * Запросы идут через api() фикстур: в шаге test:app-role — ролью
 * приложения, с политиками строк.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const installation = () => `inst-${crypto.randomUUID()}`;

function checkin(token: string, body: Record<string, unknown>) {
  return api<{ wipe: boolean }>("/api/devices/checkin", token, { method: "POST", body: JSON.stringify(body) });
}

type DeviceItem = { id: string; ownerName: string; wipeRequestedAt: string | null; wipedAt: string | null };

async function listOf(token: string, userId?: string): Promise<DeviceItem[]> {
  const res = await api<{ items: DeviceItem[] }>(`/api/devices${userId ? `?userId=${userId}` : ""}`, token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items;
}

function requestWipe(id: string, userId?: string) {
  return api<{ ok: boolean; note: string }>(`/api/devices/${id}/wipe`, root.token, {
    method: "POST",
    body: JSON.stringify(userId ? { userId } : {}),
  });
}

describe("второй человек на той же установке", () => {
  test("получает свою запись устройства, первый — сохраняет свою", async () => {
    // проба ревьюера (proof-integrations.ts): A и B по очереди на одном планшете
    const a = await makeUser("admin", `dev-a-${tag()}@test`);
    const b = await makeUser("admin", `dev-b-${tag()}@test`);
    const id = installation();

    expect((await checkin(a.token, { deviceId: id, label: "Планшет 3", platform: "android" })).status).toBe(200);
    expect((await checkin(b.token, { deviceId: id, label: "Планшет 3", platform: "android" })).status).toBe(200);

    expect((await listOf(b.token)).map((d) => d.id)).toEqual([id]);
    expect((await listOf(a.token)).map((d) => d.id)).toEqual([id]);
    // и суперадмин видит установку у обоих
    expect((await listOf(root.token, b.id)).map((d) => d.id)).toEqual([id]);

    const rows = await db.select().from(devices).where(eq(devices.id, id));
    expect(rows.map((r) => r.userId).sort()).toEqual([a.id, b.id].sort());
  });

  test("повторная отметка не плодит привязок", async () => {
    const a = await makeUser("user", `dev-r-${tag()}@test`);
    const id = installation();
    await checkin(a.token, { deviceId: id });
    await checkin(a.token, { deviceId: id, appVersion: "3.1.0" });
    const rows = await db.select().from(devices).where(eq(devices.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.appVersion).toBe("3.1.0");
  });
});

describe("стирание — у каждой привязки своё", () => {
  test("команда для второго приходит ему, а не первому", async () => {
    const a = await makeUser("admin", `dev-wa-${tag()}@test`);
    const b = await makeUser("admin", `dev-wb-${tag()}@test`);
    const id = installation();
    await checkin(a.token, { deviceId: id });
    await checkin(b.token, { deviceId: id });

    const asked = await requestWipe(id, b.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);

    expect((await checkin(b.token, { deviceId: id })).body.wipe).toBe(true);
    // чужой запрос не стирает работу другого человека (platform.test.ts) — и в обратную сторону тоже
    expect((await checkin(a.token, { deviceId: id })).body.wipe).toBe(false);

    const [bRow] = await listOf(root.token, b.id);
    expect(bRow!.wipeRequestedAt).not.toBeNull();
    const [aRow] = await listOf(root.token, a.id);
    expect(aRow!.wipeRequestedAt).toBeNull();
  });

  test("команда называет учётную запись; без неё или мимо привязки — отказ, а не стирание всех", async () => {
    const a = await makeUser("admin", `dev-wn-${tag()}@test`);
    const stranger = await makeUser("admin", `dev-ws-${tag()}@test`);
    const id = installation();
    await checkin(a.token, { deviceId: id });

    expect((await requestWipe(id)).status).toBe(400);
    expect((await requestWipe(id, stranger.id)).status).toBe(404);
    const rows = await db.select().from(devices).where(eq(devices.id, id));
    expect(rows.every((r) => r.wipeRequestedAt === null)).toBe(true);
  });

  test("подтверждение принимается только от привязки с командой и отмечает стёртой всю установку", async () => {
    /*
     * Команда — у привязки, а очистка — у установки: приложение стирает
     * всё хранилище (offline/device.ts), вместе с офлайн-данными второго.
     * Поэтому после подтверждения стёртой видна установка у обоих, а
     * подтвердить «стёрто» без команды нельзя: мобилка подтверждает только
     * исполненное (offline/wipe.ts), и 404 для неё — «подтверждения не ждут».
     */
    const a = await makeUser("admin", `dev-ca-${tag()}@test`);
    const b = await makeUser("admin", `dev-cb-${tag()}@test`);
    const id = installation();
    await checkin(a.token, { deviceId: id });
    await checkin(b.token, { deviceId: id });

    const early = await api("/api/devices/wiped", b.token, { method: "POST", body: JSON.stringify({ deviceId: id }) });
    expect(early.status).toBe(404);

    await requestWipe(id, b.id);
    const confirmed = await api("/api/devices/wiped", b.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id }),
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    expect((await listOf(b.token))[0]!.wipedAt).not.toBeNull();
    expect((await listOf(a.token))[0]!.wipedAt, "установка стёрта — и у первого тоже").not.toBeNull();
    // повторно не просят
    expect((await checkin(b.token, { deviceId: id })).body.wipe).toBe(false);

    const [aRow] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.userId, a.id)));
    expect(aRow!.wipeRequestedAt, "команды первому никто не давал").toBeNull();
  });
});

describe("техпанель считает установки, а не привязки", () => {
  test("два человека на одном планшете — одна установка и одна очередь", async () => {
    const a = await makeUser("user", `dev-oa-${tag()}@test`);
    const b = await makeUser("user", `dev-ob-${tag()}@test`);
    const id = installation();
    const version = `77.${Math.floor(Math.random() * 1000)}.${Math.floor(Math.random() * 1000)}`;
    await checkin(a.token, { deviceId: id, platform: "android", appVersion: version, queue: { pending: 3, rejected: 0 } });
    await checkin(b.token, { deviceId: id, platform: "android", appVersion: version, queue: { pending: 3, rejected: 0 } });

    const res = await api<MobileReport>("/api/ops/data/mobile", root.token);
    expect(res.status).toBe(200);
    const row = res.body.versions.find((v) => v.version === version);
    expect(row?.devices).toBe(1);
  });
});
