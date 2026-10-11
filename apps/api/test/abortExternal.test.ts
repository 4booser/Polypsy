import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, api, db, eq, makeUser, root, sql } from "./fixtures";
import { appointments, auditLog, departments, googleCalendarTokens, releases, slots, specialistProfiles } from "../src/db/schema";
import { env } from "../src/env";
import { encryptField } from "../src/lib/crypto";

/*
 * Клиент ушёл посреди изменяющего запроса, который уже сделал необратимое
 * снаружи (ревью PR #198). Отмена запросов к базе при уходе клиента (#186)
 * откатывала только свою половину: событие удалено в Google — приём
 * записан; событие переехало — приём на прежнем слоте; событие создано —
 * приёма нет; откат прода запущен в GitHub — строки журнала нет. Теперь
 * отмена — только у чтения (middleware/auth.ts), изменяющий запрос доходит
 * до конца, и база совпадает с внешней системой.
 */
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const originalFetch = globalThis.fetch;
const live = new Map<string, { start?: string }>();
const calls: { method: string; url: string; body?: string }[] = [];
let seq = 0;
let hold: ((m: string) => Promise<void>) | null = null;

function gate(method: string) {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let reached = false;
  hold = async (m) => {
    if (m !== method || reached) return;
    reached = true;
    await opened;
  };
  return { reached: () => reached, release: () => { hold = null; open(); } };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 2000 && !check(); i++) await Bun.sleep(5);
  if (!check()) throw new Error("не дождались");
}

let departmentId: string;
beforeAll(async () => {
  env.googleClientId = "test-client";
  env.googleClientSecret = "test-secret";
  env.googleRedirectUri = "http://localhost/meet/callback";
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "x" });
    if (url.startsWith("https://www.googleapis.com/")) {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
      if (hold) await hold(method);
      const id = decodeURIComponent(url.slice(EVENTS.length + 1).replace(/\?.*$/, ""));
      if (method === "POST") {
        const created = `rv-evt-${++seq}`;
        live.set(created, {});
        return Response.json({ id: created, hangoutLink: `https://meet.google.com/${created}` });
      }
      if (!live.has(id)) return Response.json({ error: "not found" }, { status: 404 });
      if (method === "DELETE") { live.delete(id); return new Response(null, { status: 204 }); }
      if (method === "PATCH") { live.set(id, { start: JSON.parse(String(init?.body ?? "{}"))?.start?.dateTime }); }
      return Response.json({ id });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({ id: departmentId, title: { uk: "rv21", ru: "rv21" }, timezone: "Europe/Kyiv" });
});
afterAll(() => { globalThis.fetch = originalFetch; hold = null; });

let n = 0;
async function slotFor(specialistId: string) {
  n += 1;
  const start = Date.now() + 400 * 3600_000 + n * 2 * 3600_000;
  const id = crypto.randomUUID();
  await db.insert(slots).values({ id, specialistId, departmentId, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600_000).toISOString() });
  return id;
}
async function doctor(tag: string) {
  const d = await makeUser("admin", `rv21-d-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: d.id, departmentId });
  await db.insert(googleCalendarTokens).values({ userId: d.id, refreshTokenEnc: encryptField(`r-${tag}`)!, googleEmail: `${tag}@ex.test` });
  return d;
}
const row = async (id: string) => (await db.select().from(appointments).where(eq(appointments.id, id)))[0]!;

describe("клиент ушёл после вызова Google — база совпадает с календарём", () => {
  test("отмена: событие удалено, приём отменён", async () => {
    const d = await doctor("cancel");
    const p = await makeUser("user", `rv21-p-c-${crypto.randomUUID()}@test`);
    const booked = await api("/api/clinic/appointments", p.token, { method: "POST", body: JSON.stringify({ slotId: await slotFor(d.id), mode: "remote" }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const before = await row(booked.body.id);
    expect(live.has(before.meetingEventId!)).toBe(true);

    const g = gate("DELETE");
    const gone = new AbortController();
    const pending = api(`/api/clinic/appointments/${booked.body.id}/cancel`, p.token, { method: "POST", body: JSON.stringify({}), signal: gone.signal });
    await until(g.reached);
    gone.abort(); // человек закрыл вкладку / связь оборвалась, пока Google «думает»
    g.release();
    const res = await pending;
    void res;
    const after = await row(booked.body.id);
    // событие удалено в Google — и приём отменён в базе
    expect(live.has(before.meetingEventId!)).toBe(false);
    expect(after.status).toBe("cancelled");
  }, 30_000);

  test("перенос к тому же врачу: событие и приём на новом слоте", async () => {
    const d = await doctor("move");
    const p = await makeUser("user", `rv21-p-m-${crypto.randomUUID()}@test`);
    const first = await slotFor(d.id);
    const booked = await api("/api/clinic/appointments", p.token, { method: "POST", body: JSON.stringify({ slotId: first, mode: "remote" }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const second = await slotFor(d.id);
    const [secondSlot] = await db.select().from(slots).where(eq(slots.id, second));

    const g = gate("PATCH");
    const gone = new AbortController();
    const pending = api(`/api/clinic/appointments/${booked.body.id}/reschedule`, p.token, { method: "POST", body: JSON.stringify({ slotId: second }), signal: gone.signal });
    await until(g.reached);
    gone.abort();
    g.release();
    const res = await pending;
    void res;
    const after = await row(booked.body.id);
    const ev = live.get(after.meetingEventId!);
    // событие переехало в Google — и приём на новом слоте
    expect(new Date(ev!.start!).getTime()).toBe(new Date(secondSlot!.startsAt).getTime());
    expect(after.slotId).toBe(second);
  }, 30_000);

  test("запись дистанционного приёма: событие создано, приём записан", async () => {
    const d = await doctor("book");
    const p = await makeUser("user", `rv21-p-b-${crypto.randomUUID()}@test`);
    const slotId = await slotFor(d.id);
    const g = gate("POST");
    const gone = new AbortController();
    const liveBefore = live.size;
    const pending = api("/api/clinic/appointments", p.token, { method: "POST", body: JSON.stringify({ slotId, mode: "remote" }), signal: gone.signal });
    await until(g.reached);
    gone.abort();
    g.release();
    const res = await pending;
    void res;
    const rows = await db.select().from(appointments).where(eq(appointments.slotId, slotId));
    // событие создано в Google — и приём записан с ним
    expect(live.size - liveBefore).toBe(1);
    expect(rows.length).toBe(1);
    expect(live.has(rows[0]!.meetingEventId!)).toBe(true);
  }, 30_000);
});

const originalFetchRb = globalThis.fetch;
const dispatched: string[] = [];
let openRb!: () => void;
const openedRb = new Promise<void>((r) => (openRb = r));
let reachedRb = false;

describe("откат выкатки: клиент ушёл, пока GitHub принимал запуск", () => {
beforeAll(async () => {
  await db.delete(releases);
  const t0 = Date.now();
  await db.insert(releases).values([
    { id: crypto.randomUUID(), version: "v9.0.0", commitSha: "aaaaaaa", deployedBy: "x", repo: "4booser/Quizzy", startedAt: new Date(t0 - 86_400_000).toISOString() },
    { id: crypto.randomUUID(), version: "v9.1.0", commitSha: "bbbbbbb", deployedBy: "x", repo: "4booser/Quizzy", startedAt: new Date(t0).toISOString() },
  ] as never);
  env.githubDispatchToken = "github_pat_test";
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.github.com/")) {
      reachedRb = true;
      await openedRb; // GitHub отвечает не сразу
      dispatched.push(String(init?.body));
      return new Response(null, { status: 204 });
    }
    return originalFetchRb(input, init);
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = originalFetchRb;
  env.githubDispatchToken = "";
  await db.delete(releases);
});

test("запуск ушёл в GitHub — и строка журнала на месте", async () => {
  const since = new Date(Date.now() - 1000).toISOString();
  const gone = new AbortController();
  const pending = api("/api/ops/maint/releases/rollback", root.token, {
    method: "POST",
    body: JSON.stringify({ version: "v9.0.0" }),
    signal: gone.signal,
  });
  for (let i = 0; i < 2000 && !reachedRb; i++) await Bun.sleep(5);
  expect(reachedRb).toBe(true);
  gone.abort(); // вкладку закрыли / прокси оборвал, пока GitHub думает
  openRb();
  const res = await pending;
  void res;
  const rows = await db
    .select({ action: auditLog.action, outcome: auditLog.outcome })
    .from(auditLog)
    .where(and(eq(auditLog.action, "ops.release_rollback"), sql`${auditLog.at} >= ${since}`));
  expect(dispatched).toHaveLength(1);
  expect(rows).toHaveLength(1);
}, 30_000);
});
