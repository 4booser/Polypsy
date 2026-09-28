import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { appApi, db, makeUser } from "./fixtures";
import { appointments, auditLog, departments, googleCalendarTokens, slots, specialistProfiles } from "../src/db/schema";
import { env } from "../src/env";
import { encryptField } from "../src/lib/crypto";

/**
 * Ссылка на встречу при записи на дистанционный приём (волна 15, внешний
 * разбор, пп. 10 и 11).
 *
 * Было:
 *   — пациент записывается сам, запрос идёт в его контексте политик строк, и
 *     разрешение специалиста на календарь (google_calendar_tokens: своя
 *     строка или система) ему не видно: ссылка не создавалась никогда, ноль
 *     обращений к Google. Специалист, подключивший календарь, получал её
 *     только при записи, сделанной им самим. Сюита этого не видела — она
 *     ходит в базу владельцем, мимо политик;
 *   — обмен refresh-токена на токен доступа стоял до try/catch: обрыв связи
 *     с Google выходил исключением из записи на приём — пятисотка, приёма нет.
 *
 * Google подменён локальным fetch (как в пробе ревьюера, proof-integrations.ts):
 * настоящих обращений нет. Запись — ролью приложения (appApi) в любом
 * прогоне: владелец базы политики обходит и дефекта не видит.
 */

const MEET = "https://meet.google.com/abc-defg-hij";
let departmentId: string;
const mine: string[] = [];
const saved = { id: env.googleClientId, secret: env.googleClientSecret, redirect: env.googleRedirectUri };
const originalFetch = globalThis.fetch;

/** Что Google «ответит»: по умолчанию — выдаёт токен и создаёт событие */
let google: (url: string) => Promise<Response> = async () => new Response("unset", { status: 500 });
const calls: string[] = [];

function googleOk(): (url: string) => Promise<Response> {
  return async (url) =>
    url.startsWith("https://oauth2.googleapis.com/token")
      ? Response.json({ access_token: "synthetic-access" })
      : Response.json({ hangoutLink: MEET });
}

beforeAll(async () => {
  env.googleClientId = "test-client";
  env.googleClientSecret = "test-secret";
  env.googleRedirectUri = "http://localhost/meet/callback";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/") || url.startsWith("https://www.googleapis.com/")) {
      calls.push(url);
      return google(url);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Дистанційний прийом", ru: "Дистанционный приём" },
    timezone: "Europe/Kyiv",
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  env.googleClientId = saved.id;
  env.googleClientSecret = saved.secret;
  env.googleRedirectUri = saved.redirect;
  // ничего живого в общей очереди приёмов (brief-w12: порядок файлов в CI)
  if (mine.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
      .where(inArray(appointments.id, mine));
  }
});

let seq = 0;
/** Специалист с подключённым календарём и один свободный слот у него */
async function specialistWithCalendar(tag: string) {
  const person = await makeUser("admin", `meet-s-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId });
  await db
    .insert(googleCalendarTokens)
    .values({ userId: person.id, refreshTokenEnc: encryptField(`refresh-${tag}`)!, googleEmail: `${tag}@example.test` });
  seq += 1;
  const start = Date.now() + 120 * 3600_000 + seq * 2 * 3600_000;
  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    specialistId: person.id,
    departmentId,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3600_000).toISOString(),
  });
  return { specialist: person, slotId };
}

async function bookRemote(token: string, slotId: string, patientId?: string) {
  const res = await appApi("/api/clinic/appointments", token, {
    method: "POST",
    body: JSON.stringify({ slotId, mode: "remote", ...(patientId ? { patientId } : {}) }),
  });
  if (res.status === 201) mine.push(res.body.id);
  return res;
}

async function appointment(id: string) {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
  return row!;
}

async function bookingAudit(id: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "clinic.book"), eq(auditLog.resourceId, id)));
  return row?.details as Record<string, unknown> | undefined;
}

describe("пациент записывается сам", () => {
  test("встреча создаётся в календаре специалиста, хотя его разрешение пациенту не видно", async () => {
    const { slotId } = await specialistWithCalendar("self");
    const patient = await makeUser("user", `meet-p-${crypto.randomUUID()}@test`);
    google = googleOk();
    calls.length = 0;

    const res = await bookRemote(patient.token, slotId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // обмен refresh и создание события — два обращения, как у ревьюера от имени специалиста
    expect(calls).toHaveLength(2);
    expect((await appointment(res.body.id)).meetingUrl).toBe(MEET);
    expect((await bookingAudit(res.body.id))?.meet).toBe("created");
  });

  test("записали за пациента — тоже", async () => {
    const { specialist, slotId } = await specialistWithCalendar("staff");
    const patient = await makeUser("user", `meet-q-${crypto.randomUUID()}@test`);
    google = googleOk();
    calls.length = 0;

    const res = await bookRemote(specialist.token, slotId, patient.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await appointment(res.body.id)).meetingUrl).toBe(MEET);
  });

  test("отказ в записи — к Google не обращались: разрешение читается только после проверки слота", async () => {
    const { slotId } = await specialistWithCalendar("taken");
    const first = await makeUser("user", `meet-t1-${crypto.randomUUID()}@test`);
    const second = await makeUser("user", `meet-t2-${crypto.randomUUID()}@test`);
    google = googleOk();
    expect((await bookRemote(first.token, slotId)).status).toBe(201);

    calls.length = 0;
    const refused = await bookRemote(second.token, slotId);
    expect(refused.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("сбой Google не срывает запись", () => {
  for (const by of ["specialist", "patient"] as const) {
    test(`обрыв связи на обмене токена — приём назначен без ссылки, в журнале видно почему (записывает ${by})`, async () => {
      /*
       * Проба ревьюера: connection reset на token endpoint. Сам специалист
       * своё разрешение видел и до правки — у него обрыв выходил из записи
       * пятисоткой; пациент до обмена не доходил вовсе (п. 10).
       */
      const { specialist, slotId } = await specialistWithCalendar(`reset-${by}`);
      const patient = await makeUser("user", `meet-r-${crypto.randomUUID()}@test`);
      google = async () => {
        throw new TypeError("simulated Google token endpoint connection reset");
      };
      calls.length = 0;

      const res =
        by === "specialist" ? await bookRemote(specialist.token, slotId, patient.id) : await bookRemote(patient.token, slotId);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(calls.length, "к Google не обращались").toBeGreaterThan(0);
      const row = await appointment(res.body.id);
      expect(row.meetingUrl).toBeNull();
      expect(row.mode).toBe("remote");
      expect((await bookingAudit(res.body.id))?.meet).toBe("failed");
    });
  }

  test("обрыв на создании события — то же", async () => {
    const { slotId } = await specialistWithCalendar("event");
    const patient = await makeUser("user", `meet-e-${crypto.randomUUID()}@test`);
    google = async (url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "synthetic" });
      throw new TypeError("simulated calendar connection reset");
    };

    const res = await bookRemote(patient.token, slotId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await appointment(res.body.id)).meetingUrl).toBeNull();
    expect((await bookingAudit(res.body.id))?.meet).toBe("failed");
  });

  test("отозванное разрешение снимается и при записи пациентом", async () => {
    /*
     * Google ответил 400 invalid_grant: связь, которая молча не работает,
     * хуже отсутствующей (lib/meet.ts). В контексте пациента удаление чужой
     * строки политика тихо пропускала — разрешение оставалось висеть.
     */
    const { specialist, slotId } = await specialistWithCalendar("revoked");
    const patient = await makeUser("user", `meet-v-${crypto.randomUUID()}@test`);
    google = async () => Response.json({ error: "invalid_grant" }, { status: 400 });

    const res = await bookRemote(patient.token, slotId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await appointment(res.body.id)).meetingUrl).toBeNull();
    expect((await bookingAudit(res.body.id))?.meet).toBe("revoked");
    const left = await db.select().from(googleCalendarTokens).where(eq(googleCalendarTokens.userId, specialist.id));
    expect(left).toEqual([]);
  });

  test("очную запись Google не касается", async () => {
    const { slotId } = await specialistWithCalendar("onsite");
    const patient = await makeUser("user", `meet-o-${crypto.randomUUID()}@test`);
    google = googleOk();
    calls.length = 0;
    const res = await appApi("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(res.status).toBe(201);
    mine.push(res.body.id);
    expect(calls).toEqual([]);
    expect((await bookingAudit(res.body.id))?.meet).toBeUndefined();
  });
});
