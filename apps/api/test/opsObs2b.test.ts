import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  VITAL_BOUNDS,
  histQuantile,
  type OpsAlertHistory,
  type OpsAlerts,
  type OpsClientErrors,
  type OpsJobs,
  type OpsRecordings,
  type OpsVitals,
  type OpsWindowStats,
} from "@quizzy/shared";
import {
  appointments,
  auditLog,
  departments,
  opsAlertEvents,
  opsAlertRules,
  opsClientErrors,
  permissionExceptions,
  slots,
  specialistProfiles,
  staffRoles,
  visitRecordings,
} from "../src/db/schema";
import { setTransportForTests } from "../src/lib/notify";
import {
  decide,
  observe,
  resetAlertPrune,
  runAlertChecks,
  scrubSecrets,
  setAlertFetchForTests,
  setAuditChainSource,
  type SignalInputs,
} from "../src/lib/opsAlerts";
import { cleanClientError, resetClientLimits, WindowLimiter } from "../src/lib/opsClient";
import { jobsSnapshot, registerRunnable } from "../src/lib/opsJobs";
import { cleanFailure } from "../src/lib/opsRecordings";
import { resetClientErrorsReadCoalescing } from "../src/routes/opsSignals";
import { adminA, api, app, db, makeUser, patient, root } from "./fixtures";

/**
 * Техпанель, участок obs2b: оповещения, ошибки клиента, скорость экранов,
 * ручной запуск задач, хранилище записей приёма.
 *
 * Порядок важности тот же, что у наблюдаемости (ops.test.ts):
 *
 *   1. Кто видит и кто меняет: ops.read смотрит, ops.manage правит правила,
 *      шлёт тестовое, запускает задачи и повторяет расшифровку.
 *   2. Что уходит наружу: токен бота и номер чата — никогда, ни в ответе,
 *      ни в истории; от клиента — ни адреса с идентификатором, ни почты.
 *   3. Что правила ведут себя как обещано: срабатывают, затихают,
 *      повторяют не чаще N, говорят «відновлено».
 */

const TOKEN = "123456789:AAF-secret-token-value_xyz";
const CHAT = "-1009876543210";

/** Разработчик: сотрудник без клинической роли, с ops.read (и по желанию ops.manage) */
async function makeDeveloper(manage = false) {
  const dev = await makeUser("admin", `o2b-dev-${crypto.randomUUID()}@test`);
  await db.delete(staffRoles).where(eq(staffRoles.userId, dev.id));
  for (const permission of manage ? ["ops.read", "ops.manage"] : ["ops.read"]) {
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: dev.id,
      permission,
      mode: "grant",
      reason: "Разработчик: сигналы техпанели",
      grantedBy: root.id,
    });
  }
  return dev;
}

/** Запрос без входа — как с экрана входа */
async function anon(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const calm: OpsWindowStats = { requests: 0, errors4xx: 0, errors5xx: 0, share5xx: null, avgMs: null, p50: null, p95: null, p99: null, maxMs: null };
const busy = (over: Partial<OpsWindowStats>): OpsWindowStats => ({ ...calm, requests: 100, share5xx: 0, p95: 120, ...over });

function signals(over: Partial<SignalInputs> = {}): Partial<SignalInputs> {
  return {
    stats: () => busy({}),
    scheduler: { enabled: false, lastTickAt: null, startedAt: 0 },
    disk: { totalBytes: 100, freeBytes: 50, freePct: 50 },
    auditChain: undefined,
    ...over,
  };
}

interface Sent {
  url: string;
  body: { chat_id: string; text: string };
}
let sent: Sent[] = [];
const fakeTelegram = (status = 200) =>
  setAlertFetchForTests(async (url, init) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { ok: false, description: "Bad Request: chat not found" }), { status });
  });

const saved = { t: process.env.TELEGRAM_BOT_TOKEN, c: process.env.TELEGRAM_CHAT_ID, m: process.env.OPS_ALERT_EMAIL };

beforeEach(async () => {
  sent = [];
  resetClientLimits();
  resetClientErrorsReadCoalescing();
  resetAlertPrune();
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_CHAT_ID = CHAT;
  delete process.env.OPS_ALERT_EMAIL;
  fakeTelegram();
  setTransportForTests(null);
  setAuditChainSource(null);
  /* правила к умолчаниям миграции и без инцидента: тесты не видят чужого состояния */
  await db
    .update(opsAlertRules)
    .set({ enabled: true, firingSince: null, lastSentAt: null, lastState: null, channels: ["telegram", "email"] });
  await db.update(opsAlertRules).set({ threshold: 5, windowMin: 10, repeatMin: 60 }).where(eq(opsAlertRules.key, "errors5xx"));
  await db.update(opsAlertRules).set({ threshold: 2000, windowMin: 15, repeatMin: 60 }).where(eq(opsAlertRules.key, "p95"));
  await db.delete(opsAlertEvents);
});

afterEach(() => {
  setAlertFetchForTests(null);
  setTransportForTests(null);
  for (const [k, v] of [
    ["TELEGRAM_BOT_TOKEN", saved.t],
    ["TELEGRAM_CHAT_ID", saved.c],
    ["OPS_ALERT_EMAIL", saved.m],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* ═══════════ кто видит ═══════════ */

describe("кто видит и кто меняет", () => {
  const READS = ["/api/ops/alerts", "/api/ops/alerts/history", "/api/ops/client-errors", "/api/ops/vitals", "/api/ops/recordings"];

  test("клинический администратор без ops.read — отказ по праву на каждом разделе", async () => {
    for (const path of READS) {
      const res = await api(path, adminA.token);
      expect(res.status, path).toBe(403);
      expect(String(res.body?.error ?? ""), path).toContain("ops.read");
    }
  });

  test("ops.read смотрит, но не меняет: правка, тестовое, запуск и повтор — по ops.manage", async () => {
    const dev = await makeDeveloper(false);
    for (const path of READS) expect((await api(path, dev.token)).status, path).toBe(200);

    const writes: [string, string, unknown][] = [
      ["PUT", "/api/ops/alerts/rules/errors5xx", { threshold: 7 }],
      ["POST", "/api/ops/alerts/test", { channel: "telegram" }],
      ["POST", "/api/ops/jobs/analytics.cache/run", {}],
      ["POST", `/api/ops/recordings/${crypto.randomUUID()}/retry`, {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await api(path, dev.token, { method, body: JSON.stringify(body) });
      expect(res.status, path).toBe(403);
      expect(String(res.body?.error ?? ""), path).toContain("ops.manage");
    }
    // и тестовое сообщение по отказу не ушло
    expect(sent).toHaveLength(0);
  });

  test("ops.manage правит правило — и это в журнале", async () => {
    const dev = await makeDeveloper(true);
    const res = await api("/api/ops/alerts/rules/errors5xx", dev.token, {
      method: "PUT",
      body: JSON.stringify({ threshold: 7.5, windowMin: 5, repeatMin: 30, channels: ["telegram"] }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: "errors5xx", threshold: 7.5, windowMin: 5, repeatMin: 30, channels: ["telegram"] });
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, dev.id), eq(auditLog.action, "ops.alerts.rule_update")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resourceId).toBe("errors5xx");
  });

  test("порог вне пределов правила, окно у правила без окна, лишнее поле — 400", async () => {
    for (const [key, body] of [
      ["errors5xx", { threshold: 0 }],
      ["diskFree", { threshold: 99 }],
      ["diskFree", { windowMin: 10 }],
      ["auditChain", { threshold: 3 }],
      ["p95", { repeatMin: 1 }],
      ["p95", { channels: ["sms"] }],
      ["p95", { token: "x" }],
    ] as const) {
      const res = await api(`/api/ops/alerts/rules/${key}`, root.token, { method: "PUT", body: JSON.stringify(body) });
      expect(res.status, `${key} ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await api("/api/ops/alerts/rules/nope", root.token, { method: "PUT", body: "{}" })).status).toBe(404);
  });
});

/* ═══════════ правила ═══════════ */

describe("правило: сработало, затихло, повторило, восстановилось", () => {
  const rule5xx = { key: "errors5xx", threshold: 5, windowMin: 10 };
  const inputs = (over: Partial<SignalInputs>): SignalInputs => ({ ...(signals() as SignalInputs), now: 0, ...over });

  test("доля 5xx выше порога — сигнал; мало запросов — тишина, а не сигнал", () => {
    expect(observe(rule5xx, inputs({ stats: () => busy({ share5xx: 0.08 }) }))).toEqual({ firing: true, value: 8 });
    expect(observe(rule5xx, inputs({ stats: () => busy({ share5xx: 0.02 }) }))).toEqual({ firing: false, value: 2 });
    // одна пятисотка из трёх запросов ночью — это «33 %», но не повод будить
    expect(observe(rule5xx, inputs({ stats: () => ({ ...calm, requests: 3, errors5xx: 1, share5xx: 1 / 3 }) })).firing).toBe(false);
  });

  test("p95, диск, планировщик, журнал — каждый по своей мерке", () => {
    expect(observe({ key: "p95", threshold: 2000, windowMin: 15 }, inputs({ stats: () => busy({ p95: 2600 }) }))).toEqual({ firing: true, value: 2600 });
    expect(observe({ key: "diskFree", threshold: 10, windowMin: null }, inputs({ disk: { totalBytes: 1, freeBytes: 0, freePct: 4.24 } }))).toEqual({
      firing: true,
      value: 4.2,
    });
    // statfs не ответил — «недоступно», а не «гаразд»
    expect(observe({ key: "diskFree", threshold: 10, windowMin: null }, inputs({ disk: null }))).toMatchObject({ firing: null, unavailable: "diskUnknown" });
    // выключенный на этом экземпляре планировщик не «молчит»
    expect(observe({ key: "schedulerSilent", threshold: 130, windowMin: null }, inputs({}))).toMatchObject({ firing: null, unavailable: "schedulerOff" });
    const now = 10 * 3_600_000;
    expect(
      observe(
        { key: "schedulerSilent", threshold: 130, windowMin: null },
        inputs({ now, scheduler: { enabled: true, lastTickAt: now - 200 * 60_000, startedAt: 0 } }),
      ),
    ).toEqual({ firing: true, value: 200 });
    // источник проверки журнала не подключён (участок sec) — правило честно недоступно
    expect(observe({ key: "auditChain", threshold: null, windowMin: null }, inputs({ auditChain: undefined }))).toMatchObject({
      firing: null,
      unavailable: "noSource",
    });
    expect(observe({ key: "auditChain", threshold: null, windowMin: null }, inputs({ auditChain: { ok: false, checkedAt: "x" } })).firing).toBe(true);
  });

  test("решение по инциденту: одно оповещение, тишина до повтора, «відновлено»", () => {
    const t0 = Date.UTC(2026, 8, 26, 10, 0);
    const on = { firing: true, value: 9 } as const;
    const off = { firing: false, value: 1 } as const;

    const a = decide({ firingSince: null, lastSentAt: null }, on, 60, t0);
    expect(a.kind).toBe("fired");
    // минуту спустя сигнал держится — молчим
    const b = decide(a.next, on, 60, t0 + 60_000);
    expect(b.kind).toBeNull();
    expect(b.next).toEqual(a.next);
    // час спустя — повтор, начало инцидента прежнее
    const c = decide(b.next, on, 60, t0 + 60 * 60_000);
    expect(c.kind).toBe("repeat");
    expect(c.next.firingSince).toBe(a.next.firingSince);
    // сигнал не измерить — ничего не меняем, ни «починилось», ни «сломалось»
    expect(decide(c.next, { firing: null, value: null }, 60, t0 + 61 * 60_000)).toEqual({ kind: null, next: c.next });
    // ушёл — «відновлено» и конец инцидента
    const d = decide(c.next, off, 60, t0 + 70 * 60_000);
    expect(d).toEqual({ kind: "resolved", next: { firingSince: null, lastSentAt: null } });
    // спокойно и без инцидента — тишина
    expect(decide(d.next, off, 60, t0 + 71 * 60_000).kind).toBeNull();
  });

  test("проход целиком: «збій» в Telegram один раз, повтор через час, «відновлено» — и всё в истории", async () => {
    const t0 = Date.UTC(2026, 8, 26, 10, 0);
    const spike = signals({ stats: () => busy({ share5xx: 0.2 }) });

    const first = await runAlertChecks({ now: t0, signals: spike });
    expect(first).toMatchObject({ fired: 1, repeated: 0, resolved: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(sent[0]!.body.chat_id).toBe(CHAT);
    expect(sent[0]!.body.text).toContain("Збій: частка 5xx 20 %");

    const [rule] = await db.select().from(opsAlertRules).where(eq(opsAlertRules.key, "errors5xx"));
    expect(rule!.lastState).toBe("firing");
    expect(rule!.firingSince).toBe(new Date(t0).toISOString());

    // через пять минут — тишина: одно оповещение на инцидент
    expect(await runAlertChecks({ now: t0 + 5 * 60_000, signals: spike })).toMatchObject({ fired: 0, repeated: 0 });
    expect(sent).toHaveLength(1);

    // через час — повтор
    expect(await runAlertChecks({ now: t0 + 60 * 60_000, signals: spike })).toMatchObject({ repeated: 1 });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.text).toContain("Досі триває");

    // ушло — «відновлено» с длительностью
    expect(await runAlertChecks({ now: t0 + 75 * 60_000, signals: signals() })).toMatchObject({ resolved: 1 });
    expect(sent).toHaveLength(3);
    expect(sent[2]!.body.text).toContain("Відновлено");
    expect(sent[2]!.body.text).toContain("Тривало 75 хв");

    const history = await api<OpsAlertHistory>("/api/ops/alerts/history", root.token);
    const kinds = history.body.items.filter((e) => e.rule === "errors5xx").map((e) => e.kind);
    expect(kinds).toEqual(["resolved", "repeat", "fired"]);
    // почта не настроена — «не настроено», а не «ушло» и не «отказ»
    const fired = history.body.items.find((e) => e.kind === "fired")!;
    expect(fired.deliveries).toEqual([
      { channel: "telegram", outcome: "sent", error: null },
      { channel: "email", outcome: "unset", error: null },
    ]);
  });

  test("выключенное правило молчит и закрывает инцидент без «відновлено»", async () => {
    const t0 = Date.UTC(2026, 8, 26, 12, 0);
    const spike = signals({ stats: () => busy({ share5xx: 0.2 }) });
    await runAlertChecks({ now: t0, signals: spike });
    expect(sent).toHaveLength(1);
    const off = await api("/api/ops/alerts/rules/errors5xx", root.token, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    expect(off.body).toMatchObject({ enabled: false, state: "off", firingSince: null });
    await runAlertChecks({ now: t0 + 2 * 3_600_000, signals: spike });
    await runAlertChecks({ now: t0 + 3 * 3_600_000, signals: signals() });
    expect(sent).toHaveLength(1);
  });

  test("подключённый источник проверки журнала: провал — «збій»", async () => {
    setAuditChainSource(async () => ({ ok: false, checkedAt: new Date().toISOString() }));
    const report = await runAlertChecks({ now: Date.UTC(2026, 8, 26, 14, 0), signals: { ...signals(), auditChain: undefined } });
    // undefined в подстановке — «источника нет»; здесь подменяем только статистику, источник берётся настоящий
    expect(report.fired).toBe(0);
    const { auditChain: _drop, ...rest } = signals();
    const again = await runAlertChecks({ now: Date.UTC(2026, 8, 26, 14, 1), signals: rest });
    expect(again.fired).toBe(1);
    expect(sent.at(-1)!.body.text).toContain("ланцюжка журналу");
  });
});

/* ═══════════ каналы и секреты ═══════════ */

describe("каналы: наружу только «задано»", () => {
  test("в разделе — ни токена, ни номера чата; признаки — да", async () => {
    const res = await api<OpsAlerts>("/api/ops/alerts", root.token);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("AAF-secret");
    expect(text).not.toContain(CHAT);
    expect(res.body.channels.telegram).toEqual({ configured: true, token: true, chat: true });
    expect(res.body.rules.map((r) => r.key)).toEqual(["errors5xx", "schedulerSilent", "p95", "diskFree", "auditChain"]);
    // адреса получателей почты — только числом
    expect(text).not.toContain("root@test");

    delete process.env.TELEGRAM_CHAT_ID;
    const half = await api<OpsAlerts>("/api/ops/alerts", root.token);
    expect(half.body.channels.telegram).toEqual({ configured: false, token: true, chat: false });
  });

  test("тестовое сообщение: уходит в Telegram, в ответе и истории — без токена; в журнале — кто", async () => {
    const res = await api("/api/ops/alerts/test", root.token, { method: "POST", body: JSON.stringify({ channel: "telegram" }) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: "telegram", outcome: "sent", error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text).toContain("Тестове сповіщення");
    const history = await api<OpsAlertHistory>("/api/ops/alerts/history", root.token);
    expect(history.body.items[0]).toMatchObject({ kind: "test", rule: null });
    expect(JSON.stringify(history.body)).not.toContain(TOKEN);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.actorId, root.id), eq(auditLog.action, "ops.alerts.test")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("отказ сети с адресом в тексте — токен и чат вычищены до истории", async () => {
    setAlertFetchForTests(async (url) => {
      throw new TypeError(`Unable to connect. Is the computer able to access the url? ${url} chat=${CHAT}`);
    });
    const res = await api("/api/ops/alerts/test", root.token, { method: "POST", body: JSON.stringify({ channel: "telegram" }) });
    expect(res.body.outcome).toBe("failed");
    expect(res.body.error).toContain("bot[token]");
    const history = await api<OpsAlertHistory>("/api/ops/alerts/history", root.token);
    const text = JSON.stringify(history.body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CHAT);
    // и сама вычистка ловит токен в любом виде
    expect(scrubSecrets(`GET https://api.telegram.org/bot999:zzz-top/getMe ${TOKEN}`)).not.toMatch(/zzz-top|AAF-secret/);
  });

  test("Telegram ответил отказом — «failed» с описанием, а не молча", async () => {
    fakeTelegram(400);
    const res = await api("/api/ops/alerts/test", root.token, { method: "POST", body: JSON.stringify({ channel: "telegram" }) });
    expect(res.body).toMatchObject({ outcome: "failed" });
    expect(res.body.error).toContain("chat not found");
  });

  test("без переменных окружения канал «не настроен»; почта — тем же транспортом, что тревоги", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const tg = await api("/api/ops/alerts/test", root.token, { method: "POST", body: JSON.stringify({ channel: "telegram" }) });
    expect(tg.body).toEqual({ channel: "telegram", outcome: "unset", error: null });
    expect(sent).toHaveLength(0);

    const mails: { to: string; subject: string }[] = [];
    setTransportForTests({ sendMail: async (m: { to: string; subject: string }) => void mails.push(m) } as never);
    process.env.OPS_ALERT_EMAIL = "oncall@hospital.test, second@hospital.test";
    const mail = await api("/api/ops/alerts/test", root.token, { method: "POST", body: JSON.stringify({ channel: "email" }) });
    expect(mail.body).toEqual({ channel: "email", outcome: "sent", error: null });
    expect(mails[0]!.to).toBe("oncall@hospital.test, second@hospital.test");
    const info = await api<OpsAlerts>("/api/ops/alerts", root.token);
    expect(info.body.channels.email).toEqual({ configured: true, smtp: true, recipients: "env", count: 2 });
    expect(JSON.stringify(info.body)).not.toContain("oncall@");
  });
});

/* ═══════════ ошибки клиента ═══════════ */

const webError = (over: Record<string, unknown> = {}) => ({
  platform: "web",
  kind: "react",
  name: "TypeError",
  message: "Cannot read properties of undefined (reading 'scales')",
  stack: "TypeError: x\n    at Card (https://console.example/assets/index-DkJ3f8a2.js:12:345)\n    at div",
  route: "/patients/:id/case",
  release: "a1b2c3d",
  browser: "Chrome 128",
  os: "Windows",
  ...over,
});

describe("ошибки клиента: приём", () => {
  test("без входа принимается и группируется по отпечатку", async () => {
    const marker = `Boom ${crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 8)}`;
    const a = await anon("/api/ops/client-errors", { items: [webError({ message: marker })] });
    expect(a.status).toBe(202);
    expect(a.body).toEqual({ accepted: 1, rejected: 0, dropped: 0 });
    await anon("/api/ops/client-errors", { items: [webError({ message: marker, count: 3 })] });

    const res = await api<OpsClientErrors>("/api/ops/client-errors", root.token);
    const group = res.body.items.find((g) => g.message === marker)!;
    expect(group.count).toBe(4);
    expect(group.route).toBe("/patients/:id/case");
    // кадр — без хоста, имя сборки на месте
    expect(group.frames[0]).toBe("at Card (assets/index-DkJ3f8a2.js:12:345)");
    expect(group).toMatchObject({ platform: "web", kind: "react", browser: "Chrome 128", os: "Windows", release: "a1b2c3d" });
  });

  test("адрес с идентификатором отвергается и не хранится", async () => {
    const id = crypto.randomUUID();
    const res = await anon("/api/ops/client-errors", {
      items: [
        webError({ route: `/patients/${id}/case` }),
        webError({ kind: "network", route: "/today", apiMethod: "GET", apiRoute: `/api/patients/${id}`, status: 502 }),
        webError({ route: "/search/%D0%86%D0%B2%D0%B0%D0%BD" }),
      ],
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 0, rejected: 3, dropped: 0 });
    const all = await db.select().from(opsClientErrors);
    expect(JSON.stringify(all)).not.toContain(id);
  });

  test("лишнее поле (email, body) — отказ всей пачки", async () => {
    for (const extra of [{ email: "ivan@example.com" }, { body: "{}" }, { userId: crypto.randomUUID() }]) {
      const res = await anon("/api/ops/client-errors", { items: [webError(extra)] });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await anon("/api/ops/client-errors", { items: [webError()], user: "x" })).status).toBe(400);
  });

  test("почта, телефон и UUID в тексте — вычищены тем же фильтром, что ошибки сервера", async () => {
    const res = await anon("/api/ops/client-errors", {
      items: [
        webError({
          name: "ApiError",
          message: `no user olena.pchilka@example.com, phone +380501234567, id ${crypto.randomUUID()}, value "Іваненко"`,
          stack: "Error\n    at f (https://h.example/assets/a.js?token=abc:1:2)\n    at g (webpack://x/src/y.ts:3:4)",
        }),
      ],
    });
    expect(res.body.accepted).toBe(1);
    const list = await api<OpsClientErrors>("/api/ops/client-errors", root.token);
    const text = JSON.stringify(list.body);
    for (const leak of ["olena.pchilka", "+380501234567", "Іваненко", "token=abc"]) expect(text, leak).not.toContain(leak);
    const g = list.body.items.find((x) => x.name === "ApiError")!;
    expect(g.message).toBe('no user [email], phone [phone], id :id, value "?"');
  });

  test("браузер и ОС — только грубо; подробная строка агента не хранится", () => {
    const row = cleanClientError(
      webError({ browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.6613.84", os: "Windows 10 build 19045" }) as never,
    )!;
    expect(row.browser).toBeNull();
    expect(row.os).toBeNull();
  });

  test("лимит без входа: пять в пачке и десять за десять минут с адреса", async () => {
    const five = { items: Array.from({ length: 5 }, (_, i) => webError({ message: `lim-${i}` })) };
    expect((await anon("/api/ops/client-errors", { items: [...five.items, webError()] })).status).toBe(400);
    expect((await anon("/api/ops/client-errors", five)).status).toBe(202);
    expect((await anon("/api/ops/client-errors", five)).status).toBe(202);
    const over = await anon("/api/ops/client-errors", { items: [webError()] });
    expect(over.status).toBe(429);
    // другой адрес за прокси — своё окно
    expect((await anon("/api/ops/client-errors", { items: [webError()] }, { "X-Forwarded-For": "10.0.0.9" })).status).toBe(202);
    // вошедший — по учётке, со своим, более широким окном
    const signedIn = await api("/api/ops/client-errors", patient.token, {
      method: "POST",
      body: JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => webError({ platform: "mobile", kind: "error", message: `m-${i}` })) }),
    });
    expect(signedIn.status).toBe(202);
  });

  test("окно лимита: исчерпано — отказ, прошло — снова можно", () => {
    const l = new WindowLimiter(3, 1000);
    expect(l.take("k", 2, 0)).toBe(true);
    expect(l.take("k", 2, 10)).toBe(false);
    expect(l.take("k", 1, 20)).toBe(true);
    expect(l.take("k", 1, 30)).toBe(false);
    expect(l.retryAfterSec("k", 500)).toBe(1);
    expect(l.take("k", 3, 1000)).toBe(true);
  });

  test("чтение групп — в журнал, опросы склеены", async () => {
    const dev = await makeDeveloper(false);
    await api("/api/ops/client-errors", dev.token);
    await api("/api/ops/client-errors", dev.token);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.actorId, dev.id), eq(auditLog.action, "ops.client_errors.read")));
    expect(rows).toHaveLength(1);
  });
});

/* ═══════════ скорость экранов ═══════════ */

describe("скорость экранов", () => {
  test("без входа — 401; маршрут с идентификатором — отвергнут", async () => {
    expect((await anon("/api/ops/vitals", { items: [{ metric: "LCP", route: "/today", value: 900 }] })).status).toBe(401);
    const res = await api("/api/ops/vitals", patient.token, {
      method: "POST",
      body: JSON.stringify({ items: [{ metric: "LCP", route: `/patients/${crypto.randomUUID()}`, value: 900 }] }),
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 0, rejected: 1 });
  });

  test("p75 по корзинам, оценка словом и ход по дням", async () => {
    const route = `/o2b-${crypto.randomUUID().slice(0, 6)}/screen`;
    const items = [
      ...[1000, 1000, 1000, 3000].map((value) => ({ metric: "LCP", route, value })),
      ...[80, 90, 450, 700].map((value) => ({ metric: "INP", route, value })),
      { metric: "CLS", route, value: 0.02 },
      { metric: "NAV", route, value: 5200 },
    ];
    const res = await api("/api/ops/vitals", root.token, { method: "POST", body: JSON.stringify({ items }) });
    expect(res.body).toEqual({ accepted: 10, rejected: 0 });

    const report = await api<OpsVitals>("/api/ops/vitals?days=30", root.token);
    expect(report.status).toBe(200);
    expect(report.body.days).toHaveLength(30);
    expect(report.body.sampleRate).toBe(0.2);
    const row = report.body.routes.find((r) => r.route === route)!;
    // три по секунде и одна на три: p75 — секунда, «добре»
    expect(row.metrics.LCP).toMatchObject({ p75: 1000, n: 4, rating: "good" });
    expect(row.metrics.LCP!.daily.at(-1)).toBe(1000);
    expect(row.metrics.LCP!.daily.slice(0, -1).every((v) => v === null)).toBe(true);
    // p75 INP из корзин — та же функция, что на клиенте и в тесте общего пакета
    const inpHist = new Array(VITAL_BOUNDS.INP.length + 1).fill(0);
    for (const b of [2, 2, 7, 8]) inpHist[b]++;
    expect(row.metrics.INP!.p75).toBe(Math.round(histQuantile(inpHist, 0.75, VITAL_BOUNDS.INP)!));
    expect(row.metrics.INP!.rating).toBe("needs");
    expect(row.metrics.CLS!.rating).toBe("good");
    expect(row.metrics.NAV!.rating).toBe("poor");
    expect(row.metrics.TTFB).toBeUndefined();
  });

  test("лишнее поле и неизвестная мера — 400", async () => {
    for (const items of [[{ metric: "FID", route: "/x", value: 1 }], [{ metric: "LCP", route: "/x", value: 1, url: "/x?q=1" }]]) {
      const res = await api("/api/ops/vitals", root.token, { method: "POST", body: JSON.stringify({ items }) });
      expect(res.status).toBe(400);
    }
  });
});

/* ═══════════ ручной запуск ═══════════ */

describe("ручной запуск фоновой задачи", () => {
  test("фоном, один проход за раз, итог в реестре, кто запустил — в журнале", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let runs = 0;
    registerRunnable("o2b.test.slow", async () => {
      runs++;
      await gate;
    });

    const first = await api("/api/ops/jobs/o2b.test.slow/run", root.token, { method: "POST", body: "{}" });
    expect(first.status).toBe(202);
    expect(jobsSnapshot().find((j) => j.name === "o2b.test.slow")).toMatchObject({ lastResult: "running", manual: true, lastByHand: true });

    const second = await api("/api/ops/jobs/o2b.test.slow/run", root.token, { method: "POST", body: "{}" });
    expect(second.status).toBe(409);

    release();
    await Bun.sleep(10);
    expect(runs).toBe(1);
    expect(jobsSnapshot().find((j) => j.name === "o2b.test.slow")).toMatchObject({ lastResult: "ok", runs: 1, lastByHand: true });

    const rows = await db.select().from(auditLog).where(and(eq(auditLog.actorId, root.id), eq(auditLog.action, "ops.job.run")));
    expect(rows.some((r) => r.resourceId === "o2b.test.slow")).toBe(true);
  });

  test("неизвестная задача и задача, которую руками не запускают, — 404", async () => {
    expect((await api("/api/ops/jobs/nope/run", root.token, { method: "POST", body: "{}" })).status).toBe(404);
    // расписания выдают людям задания — их лишний проход виден человеку, руками их не запускают
    expect((await api("/api/ops/jobs/schedules/run", root.token, { method: "POST", body: "{}" })).status).toBe(404);
  });

  test("безопасные задачи видны в реестре до первого прохода; сброс кэша аналитики проходит", async () => {
    const jobs = await api<OpsJobs>("/api/ops/jobs", root.token);
    const manual = jobs.body.items.filter((j) => j.manual).map((j) => j.name);
    expect(manual).toEqual(expect.arrayContaining(["analytics.cache", "search.reindex", "catalog.install", "retention", "ops.alerts"]));
    expect(manual).not.toContain("schedules");

    const run = await api("/api/ops/jobs/analytics.cache/run", root.token, { method: "POST", body: "{}" });
    expect(run.status).toBe(202);
    await Bun.sleep(10);
    expect(jobsSnapshot().find((j) => j.name === "analytics.cache")).toMatchObject({ lastResult: "ok", lastByHand: true });
  });

  test("проверка оповещений руками — проход под замком, без запроса в чужой контекст", async () => {
    const run = await api("/api/ops/jobs/ops.alerts/run", root.token, { method: "POST", body: "{}" });
    expect(run.status).toBe(202);
    for (let i = 0; i < 50 && jobsSnapshot().find((j) => j.name === "ops.alerts")?.lastResult === "running"; i++) await Bun.sleep(20);
    const job = jobsSnapshot().find((j) => j.name === "ops.alerts")!;
    expect(job.lastError).toBeNull();
    expect(job.lastResult).toBe("ok");
  });
});

/* ═══════════ записи приёмов ═══════════ */

describe("записи приёмов: только числа", () => {
  async function recording(status: string, extra: Record<string, unknown> = {}) {
    const departmentId = crypto.randomUUID();
    await db.insert(departments).values({ id: departmentId, title: { uk: "Відділення", ru: "Отделение" }, timezone: "Europe/Kyiv" });
    const doctor = await makeUser("admin", `o2b-doc-${crypto.randomUUID()}@test`);
    const person = await makeUser("user", `o2b-person-${crypto.randomUUID()}@test`);
    await db.insert(specialistProfiles).values({ userId: doctor.id, departmentId });
    const slotId = crypto.randomUUID();
    await db.insert(slots).values({
      id: slotId,
      departmentId,
      specialistId: doctor.id,
      startsAt: new Date(Date.now() - 7200_000).toISOString(),
      endsAt: new Date(Date.now() - 3600_000).toISOString(),
      kind: "primary",
    });
    const appointmentId = crypto.randomUUID();
    await db.insert(appointments).values({
      id: appointmentId,
      slotId,
      patientId: person.id,
      specialistId: doctor.id,
      kind: "primary",
      status: "done",
      bookedBy: doctor.id,
    });
    const id = crypto.randomUUID();
    await db.insert(visitRecordings).values({
      id,
      appointmentId,
      patientId: person.id,
      specialistId: doctor.id,
      status,
      endedAt: new Date(Date.now() - 3600_000).toISOString(),
      ...extra,
    } as never);
    return { id, person };
  }

  test("сводка — числа, идентификаторы и ошибки без путей; ни имени, ни пути к файлу", async () => {
    const path = `/data/recordings/${crypto.randomUUID()}.enc`;
    const bad = await recording("failed", {
      audioPath: path,
      audioBytes: 12_345,
      failure: `Error: whisper вышел с кодом 1: cannot open ${path} for olena@example.com`,
    });
    await recording("uploaded", { audioPath: `/data/recordings/${crypto.randomUUID()}.enc`, audioBytes: 1000 });

    const res = await api<OpsRecordings>("/api/ops/recordings", root.token);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(path);
    expect(text).not.toContain("/data/recordings");
    expect(text).not.toContain("olena@");
    expect(text).not.toContain(bad.person.id);
    expect(text).not.toContain("o2b-person");

    const f = res.body.failed.find((x) => x.id === bad.id)!;
    expect(f.retryable).toBe(true);
    expect(f.error).toBe("Error: whisper вышел с кодом 1: cannot open [path] for [email]");
    expect(f.ageSec).toBeGreaterThanOrEqual(3500);
    expect(res.body.queue.waiting).toBeGreaterThanOrEqual(1);
    expect(res.body.byStatus.find((s) => s.status === "failed")!.bytes).toBeGreaterThanOrEqual(12_345);
    // каталог записей в тестах пуст или отсутствует — ноль, а не «не прочиталось»
    expect(res.body.disk).not.toBeNull();
  });

  test("повтор упавшего: в очередь, второй раз — 409, чужой номер — 404, в журнал", async () => {
    const ok = await recording("failed", { audioPath: "/data/recordings/x.enc", failure: "boom" });
    const gone = await recording("failed", { audioPath: null, failure: "boom" });

    const res = await api(`/api/ops/recordings/${ok.id}/retry`, root.token, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(visitRecordings).where(eq(visitRecordings.id, ok.id));
    expect(row).toMatchObject({ status: "uploaded", failure: null });

    expect((await api(`/api/ops/recordings/${ok.id}/retry`, root.token, { method: "POST", body: "{}" })).status).toBe(409);
    // файл стёрт (человек попросил удалить) — в очередь не возвращается
    expect((await api(`/api/ops/recordings/${gone.id}/retry`, root.token, { method: "POST", body: "{}" })).status).toBe(409);
    expect((await api(`/api/ops/recordings/${crypto.randomUUID()}/retry`, root.token, { method: "POST", body: "{}" })).status).toBe(404);

    const rows = await db.select().from(auditLog).where(and(eq(auditLog.action, "ops.recording.retry"), eq(auditLog.resourceId, ok.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectUserId).toBeNull();
  });

  test("вычистка текста отказа: пути Unix и Windows, почта", () => {
    expect(cleanFailure("ENOENT: no such file, open '/data/recordings/tmp-1.wav'")).toBe("ENOENT: no such file, open '?'");
    expect(cleanFailure("cannot read C:\\rec\\a.enc")).toBe("cannot read [path]");
    expect(cleanFailure(null)).toBeNull();
  });
});
