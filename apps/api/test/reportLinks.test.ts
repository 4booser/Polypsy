import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc } from "drizzle-orm";
import postgres from "postgres";
import {
  adminA,
  adminB,
  and,
  api,
  app,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  makeUser,
  sql,
  sr45,
  submitSurvey,
  surveyInA,
  surveys,
  users,
  type Person,
} from "./fixtures";
import { auditLog, reportLinks } from "../src/db/schema";
import { hashLinkToken } from "../src/lib/reportLinks";
import { APP_ROLE_MODE, rlsRoleUrl } from "./appRole";

/**
 * Одноразовая ссылка на печатный лист (волна 14, участок mobreport).
 *
 * Было: мобилка открывала /api/reports/responses/:id браузером телефона
 * (Linking.openURL) — без заголовка Authorization (лист не открывался, 401)
 * и без языка приложения. Стало: приложение запросом с токеном и языком
 * получает ссылку на один лист (POST …/link), браузер открывает её без
 * входа: минута, одно открытие, от имени выдавшего, на языке выдачи.
 *
 * Файл стоит и в прогоне под ролью приложения (test:app-role): выдача
 * вставляет строку ролью пациента, гашение идёт системной — обе политики
 * миграции 0109 проверяются боевой ролью, а не владельцем.
 */

/** Методика с показом результатов пациенту: без него лист пациенту закрыт */
let shownSurvey = "";
let patient: Person;
let responseId = "";

beforeAll(async () => {
  shownSurvey = crypto.randomUUID();
  await db.insert(surveys).values({
    id: shownSurvey,
    groupId: groupA,
    title: { uk: "Лист за посиланням", ru: "Лист по ссылке", en: "Linked report" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    showResultsToPatient: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(shownSurvey, createSurveySchema.parse(sr45), adminA.id, "mobreport");

  patient = await makeUser("user", `mobreport-${crypto.randomUUID()}@test`);
  const done = await submitSurvey(shownSurvey, patient.token);
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  responseId = done.body.id;
}, 30_000);

afterAll(async () => {
  /* методика своя — не оставляем её в общих списках соседних файлов */
  await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, shownSurvey));
});

/** Выдать ссылку; язык — заголовком, как шлёт мобилка */
function issue(token: string, id: string, lang = "uk") {
  return api<{ path: string; ttlSeconds: number; error?: string }>(`/api/reports/responses/${id}/link`, token, {
    method: "POST",
    headers: { "Accept-Language": lang },
  });
}

/** Открыть ссылку так, как её открывает браузер: без токена, со своим списком языков */
async function open(path: string, init: RequestInit = {}) {
  const res = await app.request(path, { headers: { "Accept-Language": "de-DE,de;q=0.9" }, ...init });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function linkOf(path: string) {
  const raw = path.slice("/api/report-links/".length);
  const [row] = await db.select().from(reportLinks).where(eq(reportLinks.tokenHash, hashLinkToken(raw)));
  return row!;
}

async function auditRows(action: string, linkId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), sql`${auditLog.details}->>'linkId' = ${linkId}`))
    .orderBy(desc(auditLog.at));
}

describe("выдача и открытие", () => {
  test("пациент: лист открывается без токена, на языке приложения, а не браузера", async () => {
    const issued = await issue(patient.token, responseId, "en");
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body.path).toMatch(/^\/api\/report-links\/[A-Za-z0-9_-]{43}$/);
    expect(issued.body.ttlSeconds).toBe(60);
    // в адресе нет ни токена входа, ни его куска
    expect(issued.body.path).not.toContain(patient.token.split(".")[1]!);

    const page = await open(issued.body.path);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<html lang="en">');
    expect(page.text).toContain("Results by subscale");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");

    // журнал: выдача и открытие — одним номером ссылки, от имени пациента
    const link = await linkOf(issued.body.path);
    expect(link.userId).toBe(patient.id);
    expect(link.responseId).toBe(responseId);
    expect(link.lang).toBe("en");
    expect(link.usedAt).not.toBeNull();
    const issuedRows = await auditRows("report.link_issue", link.id);
    expect(issuedRows.length).toBe(1);
    expect(issuedRows[0]!.actorId).toBe(patient.id);
    const rendered = await auditRows("report.render", link.id);
    expect(rendered.length).toBe(1);
    expect(rendered[0]!.actorId).toBe(patient.id);
    expect(rendered[0]!.subjectUserId).toBe(patient.id);
    expect((rendered[0]!.details as { via?: string }).via).toBe("link");
  });

  test("повтор ссылки — отказ страницей на языке ссылки и строка журнала", async () => {
    const issued = await issue(patient.token, responseId, "ru");
    expect((await open(issued.body.path)).status).toBe(200);

    const again = await open(issued.body.path);
    expect(again.status).toBe(410);
    expect(again.text).toContain('<html lang="ru">');
    expect(again.text).toContain("Ссылка на заключение уже недействительна");
    // лист не отдан повторно ни словом
    expect(again.text).not.toContain("Результаты по субшкалам");

    const link = await linkOf(issued.body.path);
    const refused = await auditRows("report.link_refused", link.id);
    expect(refused.length).toBe(1);
    expect(refused[0]!.outcome).toBe("denied");
    // кто открыл повтор — неизвестно; кому выдана — в подробностях
    expect(refused[0]!.actorId).toBeNull();
    expect(refused[0]!.details).toMatchObject({ reason: "used", issuedTo: patient.id });
  });

  test("два одновременных открытия — лист получает одно", async () => {
    const issued = await issue(patient.token, responseId);
    const both = await Promise.all([open(issued.body.path), open(issued.body.path)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  test("истёкшая ссылка — отказ и не гасится", async () => {
    const issued = await issue(patient.token, responseId);
    const link = await linkOf(issued.body.path);
    await db
      .update(reportLinks)
      .set({ expiresAt: sql`now() - interval '1 second'` as never })
      .where(eq(reportLinks.id, link.id));

    const page = await open(issued.body.path);
    expect(page.status).toBe(410);
    expect(page.text).toContain('<html lang="uk">');
    expect((await linkOf(issued.body.path)).usedAt).toBeNull();
    const refused = await auditRows("report.link_refused", link.id);
    expect(refused[0]!.details).toMatchObject({ reason: "expired" });
  });

  test("незнакомая ссылка — отказ на языке браузера, без строки журнала", async () => {
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(eq(auditLog.action, "report.link_refused"));
    const page = await app.request(`/api/report-links/${"x".repeat(43)}`, { headers: { "Accept-Language": "en-US" } });
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This link to the conclusion is no longer valid");
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(eq(auditLog.action, "report.link_refused"));
    // перебор адресов без входа не должен заваливать журнал строками
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  test("HEAD ссылку не гасит: так её трогают роботы, а не человек", async () => {
    const issued = await issue(patient.token, responseId);
    const head = await app.request(issued.body.path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await linkOf(issued.body.path)).usedAt).toBeNull();
    expect((await open(issued.body.path)).status).toBe(200);
  });

  test("выход после выдачи гасит ссылку, как и access-токен", async () => {
    const person = await makeUser("user", `mobreport-out-${crypto.randomUUID()}@test`);
    const done = await submitSurvey(shownSurvey, person.token);
    const issued = await issue(person.token, done.body.id);
    expect(issued.status).toBe(201);
    // отзыв сессий (выход, смена пароля) сдвигает границу токенов
    await db
      .update(users)
      .set({ tokensValidFrom: sql`now() + interval '1 second'` as never })
      .where(eq(users.id, person.id));
    const page = await open(issued.body.path);
    expect(page.status).toBe(410);
    const refused = await auditRows("report.link_refused", (await linkOf(issued.body.path)).id);
    expect(refused[0]!.details).toMatchObject({ reason: "revoked" });
  });

  test("специалист группы: ссылка на лист пациента, на своём языке", async () => {
    const issued = await issue(adminA.token, responseId, "ru");
    expect(issued.status).toBe(201);
    const page = await open(issued.body.path);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Результаты по субшкалам");
    const link = await linkOf(issued.body.path);
    expect(link.userId).toBe(adminA.id);
    const rendered = await auditRows("report.render", link.id);
    expect(rendered[0]!.actorId).toBe(adminA.id);
    expect(rendered[0]!.subjectUserId).toBe(patient.id);
  });
});

describe("отказы при выдаче", () => {
  test("чужой отчёт: другой пациент и администратор чужой группы ссылки не получают", async () => {
    const stranger = await makeUser("user", `mobreport-stranger-${crypto.randomUUID()}@test`);
    const byStranger = await issue(stranger.token, responseId);
    /* владельцем строка видна и отказывает маршрут (403); под ролью её прячет политика — 404 */
    expect(byStranger.status).toBe(APP_ROLE_MODE ? 404 : 403);
    expect((await issue(adminB.token, responseId)).status).toBe(404);
    const made = await db
      .select()
      .from(reportLinks)
      .where(and(eq(reportLinks.responseId, responseId), sql`${reportLinks.userId} in (${stranger.id}, ${adminB.id})`));
    expect(made).toEqual([]);
  });

  test("результаты у специалиста: пациенту отказ сразу, в приложении, на его языке", async () => {
    // surveyInA результатов пациенту не показывает (showResultsToPatient по умолчанию выключен)
    const person = await makeUser("user", `mobreport-hidden-${crypto.randomUUID()}@test`);
    const done = await submitSurvey(surveyInA, person.token);
    const res = await issue(person.token, done.body.id, "en");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("A clinician will go through the results");
    const made = await db.select().from(reportLinks).where(eq(reportLinks.responseId, done.body.id));
    expect(made).toEqual([]);
    // специалист лист по тому же прохождению получает
    expect((await issue(adminA.token, done.body.id)).status).toBe(201);
  });

  test("показ выключили между выдачей и открытием — отказ при открытии, ссылка погашена", async () => {
    const person = await makeUser("user", `mobreport-flip-${crypto.randomUUID()}@test`);
    const own = crypto.randomUUID();
    await db.insert(surveys).values({
      id: own,
      groupId: groupA,
      title: { uk: "Показ вимкнули", ru: "Показ выключили", en: "Results hidden later" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      showResultsToPatient: true,
      createdBy: adminA.id,
    } as never);
    try {
      await createVersion(own, createSurveySchema.parse(sr45), adminA.id, "mobreport");
      const done = await submitSurvey(own, person.token);
      const issued = await issue(person.token, done.body.id, "en");
      expect(issued.status).toBe(201);
      await db.update(surveys).set({ showResultsToPatient: false }).where(eq(surveys.id, own));

      const page = await open(issued.body.path);
      expect(page.status).toBe(403);
      expect(page.text).toContain('<html lang="en">');
      expect(page.text).toContain("A clinician will go through the results");
      expect((await linkOf(issued.body.path)).usedAt).not.toBeNull();
    } finally {
      await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, own));
    }
  });
});

describe("политика строк report_links (миграция 0109)", () => {
  let rls: ReturnType<typeof postgres>;

  beforeAll(async () => {
    rls = postgres(await rlsRoleUrl(), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await rls?.end({ timeout: 3 }).catch(() => {});
  });

  /** Запрос ролью приложения в транзакции с заданной идентичностью (как в access.test.ts) */
  async function as(identity: { userId: string; role: string }, query: string, params: string[]): Promise<{ id: string }[]> {
    const rows = await rls.begin(async (tx: postgres.TransactionSql) => {
      await tx`select set_config('app.user_id', ${identity.userId}, true), set_config('app.role', ${identity.role}, true)`;
      return tx.unsafe(query, params);
    });
    return rows as unknown as { id: string }[];
  }

  const INSERT = `insert into report_links (id, token_hash, user_id, response_id, lang, expires_at)
                  values ($1, $2, $3, $4, 'uk', now() + interval '1 minute')`;

  test("свою ссылку вставить можно, чужую — нет; читать и гасить — только системе", async () => {
    const ownId = crypto.randomUUID();
    await as({ userId: patient.id, role: "user" }, INSERT, [ownId, `h-${ownId}`, patient.id, responseId]);
    expect((await db.select().from(reportLinks).where(eq(reportLinks.id, ownId))).length).toBe(1);

    const foreignId = crypto.randomUUID();
    const foreign = await as({ userId: patient.id, role: "user" }, INSERT, [foreignId, `h-${foreignId}`, adminA.id, responseId]).then(
      () => "inserted",
      (e: Error) => e.message,
    );
    expect(foreign).toContain("row-level security");

    for (const who of [
      { userId: patient.id, role: "user" },
      { userId: adminA.id, role: "admin" },
    ]) {
      const rows = await as(who, "select id from report_links where id = $1", [ownId]);
      expect(rows.length, who.role).toBe(0);
      // погасить чужими руками тоже нельзя: строки для них нет
      const spent = await as(who, "update report_links set used_at = now() where id = $1 returning id", [ownId]);
      expect(spent.length, who.role).toBe(0);
    }
    const system = await as({ userId: "", role: "system" }, "select id from report_links where id = $1", [ownId]);
    expect(system.length).toBe(1);

    await db.delete(reportLinks).where(eq(reportLinks.id, ownId));
  });
});
