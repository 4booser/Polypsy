import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { FEATURE_FLAG_KEYS, renderError } from "@quizzy/shared";
import {
  adminA,
  adminB,
  api,
  app,
  db,
  eq,
  groupA,
  json,
  makeUser,
  patient,
  root,
  sql,
  submitSurvey,
  surveyInA,
  type Person,
} from "./fixtures";
import { rlsRoleUrl, underAppRole } from "./appRole";
import { env } from "../src/env";
import {
  departments,
  permissionExceptions,
  releases,
  serviceAnnouncements,
  specialistProfiles,
} from "../src/db/schema";
import {
  composeStatus,
  exemptFromMaintenance,
  publicStatus,
  resetStatusCache,
  retryAfterSeconds,
} from "../src/lib/serviceStatus";
import { dispatchDeploy, migrationsSince, recordRelease, releaseFromEnv } from "../src/lib/releases";

/**
 * Техпанель, эксплуатация: режим обслуживания, страница статуса, флаги
 * функций, история выкаток.
 *
 * Главное здесь — режим обслуживания. Он закрывает запись всей системе, и
 * ошибиться можно в обе стороны: закрыть не то (вход, саму техпанель — и
 * режим больше не выключить) или не закрыть то (сдача ответов уйдёт в базу
 * посреди работ). Поэтому проверяется поведением — настоящими запросами, а
 * не списком путей.
 */

const FLAG = FEATURE_FLAG_KEYS[0]!;

/** Выставить состояние напрямую, минуя маршрут: для подготовки и уборки */
async function declare(status: "ok" | "maintenance" | "degraded") {
  await db.insert(serviceAnnouncements).values({ id: crypto.randomUUID(), status, createdBy: root.id });
  resetStatusCache();
}

async function grant(person: Person, permission: "ops.read" | "ops.manage") {
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: person.id,
    permission,
    mode: "grant",
    reason: "Разработчик на дежурстве по серверу",
    grantedBy: root.id,
  });
}

async function auditHas(action: string, predicate: (e: { details: Record<string, unknown> | null }) => boolean = () => true) {
  const res = await api(`/api/audit?action=${action}&limit=50`, root.token);
  return (res.body.entries as { details: Record<string, unknown> | null }[]).some(predicate);
}

/*
 * Сюита гоняется одним процессом на одной базе: включённое обслуживание,
 * оставшееся после упавшего теста, уронило бы все следующие файлы отказами
 * 503. Уборка — безусловная.
 */
afterAll(async () => {
  await declare("ok");
});

describe("страница статуса без входа", () => {
  test("отвечает без токена и не отдаёт ничего сверх нужного людям", async () => {
    await db.insert(serviceAnnouncements).values({
      id: crypto.randomUUID(),
      status: "degraded",
      message: "Повільно відкриваються картки",
      createdBy: root.id,
    });
    resetStatusCache();
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(
      ["auto", "checkedAt", "expectedEnd", "history", "message", "since", "status", "writable"].sort(),
    );
    expect(body.status).toBe("degraded");
    expect(body.message).toBe("Повільно відкриваються картки");
    /*
     * История — без авторов: страницу открывают со экрана входа, и имя
     * того, кто объявлял работы, постороннему знать незачем.
     */
    for (const entry of body.history) {
      expect(Object.keys(entry).sort()).toEqual(["at", "expectedEnd", "id", "message", "status"].sort());
    }
    const text = JSON.stringify(body);
    expect(text).not.toContain(root.id);
    expect(text).not.toContain("@test");
    await declare("ok");
  });

  test("база молчит — «збої» автоматом, а объявленные работы остаются работами", async () => {
    const failing = () => Promise.reject(new Error("connection refused"));
    // сначала удачное чтение: страница помнит последнее известное
    await publicStatus(10);
    const down = await publicStatus(10, failing);
    expect(down.status).toBe("degraded");
    expect(down.auto).toBe("db");
    expect(down.writable).toBe(false);

    const row = {
      id: "x",
      status: "maintenance" as const,
      message: "Оновлення бази",
      expectedEnd: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    };
    const during = composeStatus(row, false, [row]);
    expect(during.status).toBe("maintenance");
    expect(during.auto).toBe("db");
    expect(during.message).toBe("Оновлення бази");

    // сама по себе система «працює»: сбой ставится только тем, что сервер знает наверняка
    expect(composeStatus(null, true, []).status).toBe("ok");
    expect(composeStatus(null, true, []).auto).toBeNull();
  });
});

describe("режим обслуживания", () => {
  let staff: Person & { email: string };
  let refreshToken = "";

  beforeAll(async () => {
    const email = `maint-${crypto.randomUUID().slice(0, 8)}@test.dev`;
    staff = { ...(await makeUser("admin", email)), email };
  });

  test("включается из техпанели, пишется в журнал и видно всем", async () => {
    const until = new Date(Date.now() + 40 * 60_000).toISOString();
    const res = await api("/api/ops/maint/status", root.token, {
      method: "POST",
      body: JSON.stringify({ status: "maintenance", message: "Оновлюємо сервер", expectedEnd: until }),
    });
    expect(res.status).toBe(201);
    expect(res.body.current.status).toBe("maintenance");
    expect(res.body.current.writable).toBe(false);

    const open = await json(await app.request("/api/status"));
    expect(open.status).toBe("maintenance");
    expect(open.message).toBe("Оновлюємо сервер");
    expect(Date.parse(open.expectedEnd)).toBe(Date.parse(until));

    expect(await auditHas("ops.maintenance_on", (e) => e.details?.to === "maintenance")).toBe(true);
  });

  test("изменяющий запрос — 503 с Retry-After и понятным текстом на языке человека", async () => {
    const res = await api("/api/auth/me/workspace", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ density: "compact" }),
      headers: { "Accept-Language": "en" },
    });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("maintenance");
    expect(res.body.error).toBe(renderError("err.maintenance", "en"));
    const retry = Number(res.headers.get("Retry-After"));
    // до конца работ ~40 минут: заголовок говорит правду, а не «через пять минут»
    expect(retry).toBeGreaterThan(30 * 60);
    expect(retry).toBeLessThanOrEqual(40 * 60);

    const uk = await api("/api/auth/me/workspace", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ density: "compact" }),
    });
    expect(uk.body.error).toBe(renderError("err.maintenance", "uk"));
  });

  test("сдача ответов пациентом — тоже запись: 503, а не молчаливая потеря", async () => {
    /*
     * 503 — «повторите позже»: мобильная очередь и веб-кабинет кладут сдачу
     * ждать (isTransientStatus), а не помечают отказом по существу.
     */
    const res = await submitSurvey(surveyInA, patient.token);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("maintenance");
  });

  test("чтение работает", async () => {
    expect((await api("/api/auth/me", adminA.token)).status).toBe(200);
    expect((await api(`/api/surveys/${surveyInA}`, patient.token)).status).toBe(200);
    expect((await api("/api/flags", patient.token)).status).toBe(200);
  });

  test("вход, обновление сессии и выход работают — иначе режим не выключить", async () => {
    const login = await api("/api/auth/login", "", {
      method: "POST",
      body: JSON.stringify({ email: staff.email, password: "secret12345" }),
    });
    expect(login.status).toBe(200);
    const refreshed = await api("/api/auth/refresh", "", {
      method: "POST",
      body: JSON.stringify({ refreshToken: login.body.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    refreshToken = refreshed.body.refreshToken;
    const out = await api("/api/auth/logout", "", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    expect(out.status).not.toBe(503);
  });

  test("операции техпанели работают", async () => {
    const res = await api(`/api/ops/maint/flags/${FLAG}`, root.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false, audience: { all: false } }),
    });
    expect(res.status).toBe(200);
  });

  test("переживает перезапуск: состояние в базе, а не в памяти", async () => {
    // так выглядит новый процесс: кэша нет, состояние читается заново
    resetStatusCache();
    const res = await api("/api/auth/me/workspace", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ density: "compact" }),
    });
    expect(res.status).toBe(503);
  });

  test("включённое другим процессом видно без перезапуска", async () => {
    /*
     * Другой процесс пишет строку в базу; этот узнаёт о ней, как только
     * истечёт короткий кэш. Кэш здесь сброшен вручную — ожидание в три
     * секунды проверяло бы часы, а не устройство.
     */
    await declare("ok");
    expect(
      (await api("/api/auth/me/workspace", adminA.token, { method: "PUT", body: JSON.stringify({ density: "cozy" }) }))
        .status,
    ).toBe(200);
    await db.insert(serviceAnnouncements).values({ id: crypto.randomUUID(), status: "maintenance", createdBy: root.id });
    resetStatusCache();
    const res = await api("/api/auth/me/workspace", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ density: "compact" }),
    });
    expect(res.status).toBe(503);
    // срока нет — пять минут
    expect(res.headers.get("Retry-After")).toBe("300");
  });

  test("выключается из техпанели — запись снова открыта, в журнале строка", async () => {
    const res = await api("/api/ops/maint/status", root.token, {
      method: "POST",
      body: JSON.stringify({ status: "ok", message: "Роботи завершено" }),
    });
    expect(res.status).toBe(201);
    expect(res.body.current.writable).toBe(true);
    const write = await api("/api/auth/me/workspace", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ density: "cozy" }),
    });
    expect(write.status).toBe(200);
    expect(await auditHas("ops.maintenance_off")).toBe(true);
  });

  test("«збої» запись не закрывают", async () => {
    await api("/api/ops/maint/status", root.token, {
      method: "POST",
      body: JSON.stringify({ status: "degraded", message: "Повільно" }),
    });
    const write = await api("/api/auth/me/workspace", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ density: "cozy" }),
    });
    expect(write.status).toBe(200);
    expect(await auditHas("ops.status_set")).toBe(true);
    await declare("ok");
  });

  test("исключения — ровно техпанель и вход", () => {
    expect(exemptFromMaintenance("GET", "/api/surveys")).toBe(true);
    expect(exemptFromMaintenance("POST", "/api/ops/maint/status")).toBe(true);
    expect(exemptFromMaintenance("POST", "/api/auth/login")).toBe(true);
    expect(exemptFromMaintenance("POST", "/api/auth/register")).toBe(false);
    expect(exemptFromMaintenance("POST", "/api/auth/password")).toBe(false);
    // похожий путь не проходит заодно
    expect(exemptFromMaintenance("POST", "/api/opsx")).toBe(false);
    expect(exemptFromMaintenance("POST", "/api/surveys/x/responses")).toBe(false);
  });

  test("Retry-After не обещает ни «сейчас», ни «завтра»", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(retryAfterSeconds(null, now)).toBe(300);
    expect(retryAfterSeconds("2026-09-26T11:00:00Z", now)).toBe(60);
    expect(retryAfterSeconds("2026-09-26T12:00:10Z", now)).toBe(30);
    expect(retryAfterSeconds("2026-09-28T12:00:00Z", now)).toBe(6 * 3600);
  });
});

describe("права", () => {
  test("без права техпанели — отказ, и пациенту, и психологу", async () => {
    expect((await api("/api/ops/maint/status", patient.token)).status).toBe(403);
    // встроенная роль психолога техпанели не несёт (см. PSYCHOLOGIST_PERMISSIONS)
    expect((await api("/api/ops/maint/status", adminB.token)).status).toBe(403);
    expect((await api("/api/ops/maint/releases", adminB.token)).status).toBe(403);
  });

  test("ops.read смотрит, но не меняет", async () => {
    const dev = await makeUser("admin", `dev-${crypto.randomUUID().slice(0, 8)}@test.dev`);
    await grant(dev, "ops.read");
    expect((await api("/api/ops/maint/status", dev.token)).status).toBe(200);
    expect((await api("/api/ops/maint/flags", dev.token)).status).toBe(200);
    expect((await api("/api/ops/maint/releases", dev.token)).status).toBe(200);

    const post = await api("/api/ops/maint/status", dev.token, {
      method: "POST",
      body: JSON.stringify({ status: "maintenance" }),
    });
    expect(post.status).toBe(403);
    expect(String(post.body.error)).toContain("ops.manage");
    const flag = await api(`/api/ops/maint/flags/${FLAG}`, dev.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, audience: { all: true } }),
    });
    expect(flag.status).toBe(403);
  });

  test("ops.manage меняет — от своего имени", async () => {
    const dev = await makeUser("admin", `devm-${crypto.randomUUID().slice(0, 8)}@test.dev`);
    await grant(dev, "ops.read");
    await grant(dev, "ops.manage");
    const res = await api("/api/ops/maint/status", dev.token, {
      method: "POST",
      body: JSON.stringify({ status: "degraded", message: "Перевірка прав" }),
    });
    expect(res.status).toBe(201);
    const history = await api("/api/ops/maint/status", dev.token);
    expect(history.body.history[0].message).toBe("Перевірка прав");
    expect(history.body.history[0].by).toBeTruthy();
    await declare("ok");
  });
});

describe("флаги функций", () => {
  const set = (audience: Record<string, unknown>, enabled = true) =>
    api(`/api/ops/maint/flags/${FLAG}`, root.token, {
      method: "PUT",
      body: JSON.stringify({ enabled, audience }),
    });
  const flagsOf = async (p: Person) => (await api("/api/flags", p.token)).body.flags as string[];

  test("флага нет в таблице — выключен для всех", async () => {
    for (const p of [root, adminA, patient]) expect(await flagsOf(p)).not.toContain(FLAG);
  });

  test("по людям: включён ровно тому, кого назвали", async () => {
    expect((await set({ users: [adminA.id] })).status).toBe(200);
    expect(await flagsOf(adminA)).toContain(FLAG);
    expect(await flagsOf(adminB)).not.toContain(FLAG);
    expect(await flagsOf(patient)).not.toContain(FLAG);
  });

  test("по классу учётной записи: «пацієнти» — это все пациенты", async () => {
    await set({ roles: ["user"] });
    expect(await flagsOf(patient)).toContain(FLAG);
    expect(await flagsOf(adminA)).not.toContain(FLAG);
  });

  test("по роли лестницы", async () => {
    // встроенный психолог есть у каждого администратора, заведённого makeUser
    await set({ staffRoles: ["psychologist"] });
    expect(await flagsOf(adminA)).toContain(FLAG);
    expect(await flagsOf(patient)).not.toContain(FLAG);
  });

  test("по группе методик: те, кто её ведёт", async () => {
    await set({ surveyGroups: [groupA] });
    expect(await flagsOf(adminA)).toContain(FLAG);
    expect(await flagsOf(adminB)).not.toContain(FLAG);
  });

  test("по відділенню профиля приёма", async () => {
    const departmentId = crypto.randomUUID();
    await db.insert(departments).values({ id: departmentId, title: { uk: "Пілот", ru: "Пилот" } });
    await db.insert(specialistProfiles).values({ userId: adminB.id, departmentId });
    await set({ departments: [departmentId] });
    expect(await flagsOf(adminB)).toContain(FLAG);
    expect(await flagsOf(adminA)).not.toContain(FLAG);
    await db.delete(specialistProfiles).where(eq(specialistProfiles.userId, adminB.id));
  });

  test("главный выключатель гасит флаг, не теряя аудиторию", async () => {
    await set({ all: true }, false);
    expect(await flagsOf(root)).not.toContain(FLAG);
    const list = await api("/api/ops/maint/flags", root.token);
    const row = list.body.items.find((i: { key: string }) => i.key === FLAG);
    expect(row.enabled).toBe(false);
    expect(row.audience.all).toBe(true);
    expect(row.known).toBe(true);
  });

  test("выдуманный ключ и выдуманный адресат — отказ", async () => {
    const unknown = await api("/api/ops/maint/flags/no.such.flag", root.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, audience: { all: true } }),
    });
    expect(unknown.status).toBe(400);
    const nobody = await set({ users: [crypto.randomUUID()] });
    expect(nobody.status).toBe(400);
  });

  test("журнал изменений: было и стало, кто; строка в журнале доступа", async () => {
    await set({ users: [adminA.id] });
    const changes = await api(`/api/ops/maint/flags/changes?key=${FLAG}`, root.token);
    expect(changes.status).toBe(200);
    const last = changes.body.items[0];
    expect(last.after.audience.users).toEqual([adminA.id]);
    expect(last.before).not.toBeNull();
    expect(last.by).toBeTruthy();
    expect(await auditHas("ops.flag_set")).toBe(true);
  });

  test("имена в аудиториях — с записью в журнал о чтении", async () => {
    const list = await api("/api/ops/maint/flags", root.token);
    expect(list.body.names.users[adminA.id]).toBeTruthy();
    expect(await auditHas("ops.flags_read")).toBe(true);
    const options = await api("/api/ops/maint/flags/audience", root.token);
    expect(options.status).toBe(200);
    expect(options.body.people.some((p: { id: string }) => p.id === adminA.id)).toBe(true);
    // пациентов поимённо в выборе нет
    expect(options.body.people.some((p: { id: string }) => p.id === patient.id)).toBe(false);
    await set({}, false);
  });
});

describe("история выкаток", () => {
  const TAGS = ["0001_init", "0002_more", "0003_last"];

  beforeAll(async () => {
    await db.delete(releases);
  });

  test("окружение разбирается строго: местная сборка и плавающий тег — не выпуск", () => {
    const base = { version: "v1.2.0", commit: "abc1234", deployedBy: "4booser", runUrl: "", repo: "4booser/Quizzy" };
    expect(releaseFromEnv({ ...base, version: "local" })).toBeNull();
    expect(releaseFromEnv({ ...base, version: "latest" })).toBeNull();
    expect(releaseFromEnv({ ...base, version: "" })).toBeNull();
    const ok = releaseFromEnv({ ...base, runUrl: "https://github.com/4booser/Quizzy/actions/runs/123" })!;
    expect(ok.commitSha).toBe("abc1234");
    expect(ok.runUrl).toBe("https://github.com/4booser/Quizzy/actions/runs/123");
    // ссылка не на GitHub и не-коммит на экран не попадают
    const bad = releaseFromEnv({ ...base, commit: "rm -rf", runUrl: "https://evil.example/x", repo: "../x" })!;
    expect(bad.commitSha).toBeNull();
    expect(bad.runUrl).toBeNull();
    expect(bad.repo).toBeNull();
  });

  test("миграции выпуска считаются от прошлого", () => {
    expect(migrationsSince(TAGS, undefined)).toBeNull();
    expect(migrationsSince(TAGS, "0001_init")).toEqual(["0002_more", "0003_last"]);
    expect(migrationsSince(TAGS, "0003_last")).toEqual([]);
    // откат на старый тег: его журнал короче прошлого — новых миграций нет
    expect(migrationsSince(["0001_init"], "0003_last")).toEqual([]);
  });

  test("новая версия записывается, та же — нет", async () => {
    const info = { version: "v1.0.0", commitSha: "aaaaaaa", deployedBy: "4booser", runUrl: null, repo: "4booser/Quizzy" };
    expect(await recordRelease(info, TAGS.slice(0, 1))).toBe("recorded");
    expect(await recordRelease(info, TAGS.slice(0, 1))).toBe("same");
    const rows = await db.select().from(releases).where(eq(releases.version, "v1.0.0"));
    expect(rows).toHaveLength(1);
    // первая запись: что было до неё, неизвестно — null, а не пустой список
    expect(rows[0]!.migrations).toBeNull();

    await Bun.sleep(5);
    expect(await recordRelease({ ...info, version: "v1.1.0", commitSha: "bbbbbbb" }, TAGS)).toBe("recorded");
    const [next] = await db.select().from(releases).where(eq(releases.version, "v1.1.0"));
    expect(next!.migrations).toEqual(["0002_more", "0003_last"]);
  });

  test("раздел «Випуски»: порядок, время работы, ссылки; токен — только «задан или нет»", async () => {
    const res = await api("/api/ops/maint/releases", root.token);
    expect(res.status).toBe(200);
    const [current, previous] = res.body.items;
    expect(current.version).toBe("v1.1.0");
    expect(current.endedAt).toBeNull();
    expect(previous.endedAt).toBe(current.startedAt);
    expect(current.commitUrl).toBe("https://github.com/4booser/Quizzy/commit/bbbbbbb");
    expect(res.body.workflowUrl).toBe("https://github.com/4booser/Quizzy/actions/workflows/deploy.yml");
    expect(res.body.dispatchConfigured).toBe(false);

    // с токеном — «задан», и сам токен в ответ не попадает
    const saved = env.githubDispatchToken;
    env.githubDispatchToken = "github_pat_secret_for_test";
    try {
      const withToken = await api("/api/ops/maint/releases", root.token);
      expect(withToken.body.dispatchConfigured).toBe(true);
      expect(JSON.stringify(withToken.body)).not.toContain("github_pat_secret_for_test");
    } finally {
      env.githubDispatchToken = saved;
    }
  });

  test("откат из панели без токена — отказ; на неизвестный и на текущий — тоже", async () => {
    const none = await api("/api/ops/maint/releases/rollback", root.token, {
      method: "POST",
      body: JSON.stringify({ version: "v1.0.0" }),
    });
    expect(none.status).toBe(409);
    const unknown = await api("/api/ops/maint/releases/rollback", root.token, {
      method: "POST",
      body: JSON.stringify({ version: "v9.9.9" }),
    });
    expect(unknown.status).toBe(400);
    const current = await api("/api/ops/maint/releases/rollback", root.token, {
      method: "POST",
      body: JSON.stringify({ version: "v1.1.0" }),
    });
    expect(current.status).toBe(400);
    // неудавшаяся попытка тоже видна в журнале
    expect(await auditHas("ops.release_rollback")).toBe(true);
  });

  test("запуск через GitHub: рабочий процесс из main, тег — входом", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await dispatchDeploy("v1.0.0", { token: "t", repo: "4booser/Quizzy", fetch: fake });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/4booser/Quizzy/actions/workflows/deploy.yml/dispatches");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ref: "main", inputs: { ref: "v1.0.0" } });

    const refused = (async () => new Response("{}", { status: 422 })) as unknown as typeof fetch;
    await expect(dispatchDeploy("v1.0.0", { token: "t", repo: "4booser/Quizzy", fetch: refused })).rejects.toThrow();
  });

  afterAll(async () => {
    await db.delete(releases);
  });
});

describe("сведения о выпуске доезжают до контейнера", () => {
  /*
   * Цепочка из трёх файлов: deploy.yml пишет переменную в .env.docker,
   * docker-compose.yml передаёт её в контейнер api, env.ts её читает.
   * Разрыв в любом звене ничего не роняет — история выкаток просто молча
   * перестаёт пополняться. Ровно так уже терялся SITE_ALIASES: записан в
   * файл, не объявлен в compose, в контейнере его нет. Проверка — по
   * тексту файлов, без запуска выкатки.
   */
  const ROOT = new URL("../../../", import.meta.url).pathname;
  const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");

  test("каждая QUIZZY_* из выкатки объявлена у api и читается сервером", () => {
    const deploy = read(".github/workflows/deploy.yml");
    const written = [...new Set([...deploy.matchAll(/"(QUIZZY_[A-Z_]+)=\$/g)].map((m) => m[1]!))].filter(
      (k) => k !== "QUIZZY_IMAGE_PREFIX",
    );
    expect(written.sort()).toEqual(["QUIZZY_COMMIT", "QUIZZY_DEPLOYED_BY", "QUIZZY_REPO", "QUIZZY_RUN_URL", "QUIZZY_VERSION"]);

    const compose = read("docker-compose.yml");
    const api = compose.slice(compose.indexOf("\n  api:\n"), compose.indexOf("\n  whisper-model:\n"));
    const envSource = read("apps/api/src/env.ts");
    for (const key of [...written, "GITHUB_DISPATCH_TOKEN"]) {
      expect(api, `${key} не объявлена у api в docker-compose.yml`).toContain(`      ${key}: \${${key}`);
      expect(envSource, `${key} не читается в env.ts`).toContain(`${key}: z.`);
    }
  });
});

describe("политики строк", () => {
  let rlsSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const pg = (await import("postgres")).default;
    rlsSql = pg(await rlsRoleUrl(), { max: 2 });
    await declare("ok");
    await api(`/api/ops/maint/flags/${FLAG}`, root.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false, audience: { all: true } }),
    });
  });

  afterAll(async () => {
    await rlsSql.end({ timeout: 2 });
  });

  const as = async <T>(uid: string, role: string, q: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
    (await rlsSql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${uid}, true), set_config('app.role', ${role}, true)`;
      return q(tx);
    })) as T;

  test("RLS включён на всех четырёх таблицах", async () => {
    const rows = await db.execute<{ relname: string; relrowsecurity: boolean }>(sql`
      select c.relname, c.relrowsecurity from pg_class c
       where c.relname in ('service_announcements', 'feature_flags', 'feature_flag_changes', 'releases')
    `);
    expect([...rows].filter((r) => r.relrowsecurity).map((r) => String(r.relname)).sort()).toEqual(
      ["feature_flag_changes", "feature_flags", "releases", "service_announcements"],
    );
  });

  test("пациенту не видно ничего; персоналу видно", async () => {
    for (const table of ["service_announcements", "feature_flags", "feature_flag_changes"]) {
      const mine = await as(patient.id, "user", (tx) => tx.unsafe(`select count(*)::int n from ${table}`));
      expect(Number((mine as unknown as { n: number }[])[0]!.n)).toBe(0);
      const staff = await as(adminA.id, "admin", (tx) => tx.unsafe(`select count(*)::int n from ${table}`));
      expect(Number((staff as unknown as { n: number }[])[0]!.n)).toBeGreaterThan(0);
    }
  });

  test("под ролью приложения, как в бою: режим, статус и флаги работают через политики", async () => {
    /*
     * Сюита ходит владельцем базы, а владелец политики обходит. Заслон
     * режима читает состояние ДО входа — системным контекстом; забудь его,
     * и в бою режим выглядел бы выключенным всегда, а сюита оставалась бы
     * зелёной. Поэтому весь путь — отдельным процессом под ролью без прав
     * владельца: разработчик с ops.manage включает режим, запись получает
     * 503, пациент узнаёт свои флаги, режим выключается.
     */
    const devEmail = `dev-app-${crypto.randomUUID().slice(0, 8)}@test.dev`;
    const dev = await makeUser("admin", devEmail);
    await grant(dev, "ops.read");
    await grant(dev, "ops.manage");
    const patientEmail = `pt-app-${crypto.randomUUID().slice(0, 8)}@test.dev`;
    const person = await makeUser("user", patientEmail);

    const login = (email: string, name: string) => `
      const ${name}Res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: "secret12345" }),
      });
      const ${name} = { Authorization: "Bearer " + (await ${name}Res.json()).token, "Content-Type": "application/json" };
    `;
    const out = await underAppRole<Record<string, unknown>>(`
      ${login(devEmail, "dev")}
      ${login(patientEmail, "pt")}
      const on = await app.request("/api/ops/maint/status", { method: "POST", headers: dev, body: JSON.stringify({ status: "maintenance", message: "Під роллю застосунку" }) });
      out.on = on.status;
      const write = await app.request("/api/auth/me/workspace", { method: "PUT", headers: pt, body: JSON.stringify({ density: "compact" }) });
      out.write = write.status;
      out.status = (await (await app.request("/api/status")).json()).status;
      const flag = await app.request(${JSON.stringify(`/api/ops/maint/flags/${FLAG}`)}, { method: "PUT", headers: dev, body: JSON.stringify({ enabled: true, audience: { users: [${JSON.stringify(person.id)}] } }) });
      out.flag = flag.status;
      out.flags = (await (await app.request("/api/flags", { headers: pt })).json()).flags;
      out.devFlags = (await (await app.request("/api/flags", { headers: dev })).json()).flags;
      const off = await app.request("/api/ops/maint/status", { method: "POST", headers: dev, body: JSON.stringify({ status: "ok" }) });
      out.off = off.status;
      const after = await app.request("/api/auth/me/workspace", { method: "PUT", headers: pt, body: JSON.stringify({ density: "compact" }) });
      out.after = after.status;
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive, "роль обходит политики — проверка ничего не доказывает").toBe(true);
    expect(out.on).toBe(201);
    expect(out.write).toBe(503);
    expect(out.status).toBe("maintenance");
    expect(out.flag).toBe(200);
    expect(out.flags).toEqual([FLAG]);
    expect(out.devFlags).toEqual([]);
    expect(out.off).toBe(201);
    expect(out.after).toBe(200);
    await declare("ok");
    await api(`/api/ops/maint/flags/${FLAG}`, root.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false, audience: {} }),
    });
  }, 60_000);

  test("объявить работы от имени коллеги нельзя, историю переписать — тоже", async () => {
    const forged = as(adminA.id, "admin", (tx) =>
      tx`insert into service_announcements (id, status, created_by) values (${crypto.randomUUID()}, 'maintenance', ${adminB.id})`,
    );
    await expect((async () => { await forged; })()).rejects.toThrow(/row-level security|policy/i);

    const erased = await as(adminA.id, "admin", (tx) => tx`delete from service_announcements`);
    expect(erased.count).toBe(0);
    // выкатку пишет только сам сервер: человеку вписать её нечем
    const inserted = await as(adminA.id, "admin", (tx) =>
      tx`insert into releases (id, version) values (${crypto.randomUUID()}, 'v0-fake')`,
    ).then(
      () => "written",
      () => "denied",
    );
    expect(inserted).toBe("denied");
  });
});
