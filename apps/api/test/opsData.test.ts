import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { DataCheck, DataCheckKey, MobileReport, PushReport, UsageReport } from "@quizzy/shared";
import { api, db, makeUser, patient, root, submitSurvey, surveyInA } from "./fixtures";
import {
  answers,
  auditLog,
  devices,
  inviteUses,
  invites,
  permissionExceptions,
  pushOutcomes,
  pushTokens,
  questionLogic,
  questions,
  refreshTokens,
  responseScores,
  responses,
  scaleBands,
  scaleItems,
  scales,
  screenViews,
  surveyVersions,
  surveys,
} from "../src/db/schema";
import { DATA_CHECK_KEYS, runDataChecks } from "../src/lib/dataChecks";
import { funnelCells, usageReport } from "../src/lib/opsData";
import { checkPushReceipts, pushToUser, setPushReceiptFetcherForTests, setPushSenderForTests, tokenFingerprint } from "../src/lib/push";

/**
 * Техпанель, «Дані й продукт».
 *
 * Главное здесь — проверки качества данных: каждая обязана сработать там,
 * где несостыковка есть, и промолчать там, где её нет. Проверка, которая
 * срабатывает всегда, приучает не смотреть; проверка, которая молчит всегда,
 * хуже её отсутствия — она выдаёт «чисто» за знание.
 *
 * Данные — подставные, прямо в базу: несостыковки, которые ловятся, через
 * API создать нельзя (на то они и несостыковки). Проверки сужаются до своих
 * методик (surveyIds): в общей тестовой базе чужие файлы оставляют свои.
 */

afterAll(() => {
  setPushSenderForTests(null);
  setPushReceiptFetcherForTests(null);
});

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Built {
  surveyId: string;
  versionId: string;
  questionId: string;
  scaleId: string;
}

/**
 * Чистая методика: подсчёт включён, одна версия, один пункт в ключе
 * единственной шкалы, у шкалы полоса. Каждый сценарий ниже портит в ней
 * ровно одно.
 */
async function cleanSurvey(opts: { scoring?: boolean; band?: boolean } = {}): Promise<Built> {
  const surveyId = id();
  const versionId = id();
  const questionId = id();
  const scaleId = id();
  await db.insert(surveys).values({
    id: surveyId,
    title: { uk: "Перевірна", ru: "Проверочная" },
    status: "published",
    scoringEnabled: opts.scoring ?? true,
    createdBy: root.id,
  } as never);
  await db.insert(surveyVersions).values({ id: versionId, surveyId, version: 1 });
  await db.update(surveys).set({ currentVersionId: versionId }).where(eq(surveys.id, surveyId));
  await db.insert(scales).values({ id: scaleId, surveyId, versionId, code: "S", title: { uk: "Шкала", ru: "Шкала" } });
  if (opts.band ?? true) {
    await db.insert(scaleBands).values({
      id: id(),
      scaleId,
      minScore: 0,
      maxScore: 10,
      label: { uk: "Норма", ru: "Норма" },
    });
  }
  await db.insert(questions).values({
    id: questionId,
    surveyId,
    versionId,
    type: "yesno",
    title: { uk: "Пункт", ru: "Пункт" },
  });
  await db.insert(scaleItems).values({ scaleId, questionId });
  return { surveyId, versionId, questionId, scaleId };
}

/** Сданное прохождение с ответом и нормированным баллом — чистое */
async function cleanResponse(
  b: Built,
  opts: { userId?: string; submittedAt?: string; answer?: boolean; score?: boolean; normalized?: boolean } = {},
): Promise<string> {
  const responseId = id();
  await db.insert(responses).values({
    id: responseId,
    surveyId: b.surveyId,
    userId: opts.userId ?? null,
    status: "completed",
    versionId: b.versionId,
    startedAt: ago(120_000),
    submittedAt: opts.submittedAt ?? now(),
  });
  if (opts.answer ?? true) {
    await db.insert(answers).values({ id: id(), responseId, questionId: b.questionId, optionIds: ["yes"] });
  }
  if (opts.score ?? true) {
    await db.insert(responseScores).values({
      id: id(),
      responseId,
      scaleId: b.scaleId,
      rawScore: 1,
      value: 1,
      maxScore: 1,
      percent: 100,
      normalized: opts.normalized ?? true,
    });
  }
  return responseId;
}

async function checksFor(surveyIds: string[]): Promise<Map<DataCheckKey, DataCheck>> {
  const list = await runDataChecks("uk", { surveyIds });
  return new Map(list.map((c) => [c.key, c]));
}

/** Сработала именно эта проверка и именно на этом объекте */
function fired(checks: Map<DataCheckKey, DataCheck>, key: DataCheckKey, objectId: string) {
  const c = checks.get(key)!;
  expect(c.count, `${key} не сработала`).toBeGreaterThan(0);
  expect(c.examples.map((e) => e.id), `${key}: нет примера ${objectId}`).toContain(objectId);
  return c;
}

describe("качество данных: чистое молчит", () => {
  test("чистая методика с чистым прохождением не поднимает ни одной проверки", async () => {
    const b = await cleanSurvey();
    await cleanResponse(b, { userId: patient.id });
    const checks = await checksFor([b.surveyId]);
    // перечень целиком: новая проверка без сценария здесь упадёт первой
    expect([...checks.keys()].sort()).toEqual([...DATA_CHECK_KEYS].sort());
    const noisy = [...checks.values()].filter((c) => c.count > 0).map((c) => c.key);
    expect(noisy, `сработали на чистых данных: ${noisy.join(", ")}`).toEqual([]);
  });
});

describe("качество данных: каждая проверка срабатывает на своём", () => {
  test("брошенные и висящие прохождения — с корзинами давности", async () => {
    const b = await cleanSurvey();
    const stale = id();
    await db.insert(responses).values({
      id: stale,
      surveyId: b.surveyId,
      status: "in_progress",
      versionId: b.versionId,
      startedAt: ago(10 * 86_400_000),
      lastSavedAt: ago(10 * 86_400_000),
    });
    const fresh = id();
    await db.insert(responses).values({
      id: fresh,
      surveyId: b.surveyId,
      status: "abandoned",
      versionId: b.versionId,
      startedAt: ago(3_600_000),
    });
    const c = fired(await checksFor([b.surveyId]), "responses.stale", stale);
    expect(c.count).toBe(2);
    expect(c.extra).toMatchObject({ inProgress: 1, abandoned: 1, lt1d: 1, lt7d: 0, lt30d: 1, gte30d: 0 });
    expect(c.bySurvey[0]).toMatchObject({ surveyId: b.surveyId, count: 2, title: "Перевірна" });
  });

  test("подсчёт включён, а полос нет — и не срабатывает без подсчёта", async () => {
    const noBands = await cleanSurvey({ band: false });
    const noScoring = await cleanSurvey({ band: false, scoring: false });
    const checks = await checksFor([noBands.surveyId, noScoring.surveyId]);
    const c = fired(checks, "scoring.noBands", noBands.surveyId);
    expect(c.count).toBe(1);
    expect(c.examples[0]!.kind).toBe("survey");
    expect(c.extra.scales).toBe(1);
  });

  test("подсчёт включён, шкал нет вовсе", async () => {
    const b = await cleanSurvey();
    await db.delete(scales).where(eq(scales.id, b.scaleId));
    const c = fired(await checksFor([b.surveyId]), "scoring.noBands", b.surveyId);
    expect(c.extra.noScales).toBe(1);
  });

  test("сдано без баллов при включённом подсчёте", async () => {
    const b = await cleanSurvey();
    const bare = await cleanResponse(b, { score: false });
    await cleanResponse(b); // рядом — с баллом, его не трогаем
    const c = fired(await checksFor([b.surveyId]), "scoring.noScores", bare);
    expect(c.count).toBe(1);
  });

  test("без подсчёта отсутствие баллов — норма", async () => {
    const b = await cleanSurvey({ scoring: false });
    await cleanResponse(b, { score: false });
    expect((await checksFor([b.surveyId])).get("scoring.noScores")!.count).toBe(0);
  });

  test("прохождение без версии", async () => {
    const b = await cleanSurvey();
    const r = await cleanResponse(b);
    await db.update(responses).set({ versionId: null }).where(eq(responses.id, r));
    fired(await checksFor([b.surveyId]), "orphans.responseNoVersion", r);
  });

  test("прохождение на версии чужой методики", async () => {
    const mine = await cleanSurvey();
    const other = await cleanSurvey();
    const r = await cleanResponse(mine);
    await db.update(responses).set({ versionId: other.versionId }).where(eq(responses.id, r));
    const checks = await checksFor([mine.surveyId, other.surveyId]);
    const c = fired(checks, "orphans.responseForeignVersion", r);
    expect(c.count).toBe(1);
  });

  /** Вторая версия той же методики со своим пунктом и шкалой */
  async function secondVersion(b: Built): Promise<Built> {
    const versionId = id();
    const questionId = id();
    const scaleId = id();
    await db.insert(surveyVersions).values({ id: versionId, surveyId: b.surveyId, version: 2 });
    await db.update(surveys).set({ currentVersionId: versionId }).where(eq(surveys.id, b.surveyId));
    await db.insert(scales).values({ id: scaleId, surveyId: b.surveyId, versionId, code: "S", title: { uk: "Шкала", ru: "Шкала" } });
    await db.insert(scaleBands).values({ id: id(), scaleId, minScore: 0, maxScore: 10, label: { uk: "Норма", ru: "Норма" } });
    await db.insert(questions).values({ id: questionId, surveyId: b.surveyId, versionId, type: "yesno", title: { uk: "Пункт", ru: "Пункт" } });
    await db.insert(scaleItems).values({ scaleId, questionId });
    return { surveyId: b.surveyId, versionId, questionId, scaleId };
  }

  test("ответ на пункт чужой версии", async () => {
    const v1 = await cleanSurvey();
    const v2 = await secondVersion(v1);
    const r = await cleanResponse(v2);
    // ответ на пункт первой версии в прохождении по второй
    await db.insert(answers).values({ id: id(), responseId: r, questionId: v1.questionId, optionIds: ["yes"] });
    const checks = await checksFor([v1.surveyId]);
    const c = fired(checks, "orphans.answerForeignQuestion", r);
    expect(c.extra.items).toBe(1);
    // прохождение по первой версии с её же пунктом — не несостыковка
    await cleanResponse(v1);
    expect((await checksFor([v1.surveyId])).get("orphans.answerForeignQuestion")!.count).toBe(1);
  });

  test("балл на шкале чужой версии", async () => {
    const v1 = await cleanSurvey();
    const v2 = await secondVersion(v1);
    const r = await cleanResponse(v2);
    await db.insert(responseScores).values({
      id: id(),
      responseId: r,
      scaleId: v1.scaleId,
      rawScore: 1,
      value: 1,
      maxScore: 1,
      percent: 100,
    });
    const c = fired(await checksFor([v1.surveyId]), "orphans.scoreForeignScale", r);
    expect(c.extra.scores).toBe(1);
  });

  test("методика ссылается на несуществующую или чужую версию", async () => {
    const dangling = await cleanSurvey();
    const foreign = await cleanSurvey();
    const donor = await cleanSurvey();
    await db.update(surveys).set({ currentVersionId: id() }).where(eq(surveys.id, dangling.surveyId));
    await db.update(surveys).set({ currentVersionId: donor.versionId }).where(eq(surveys.id, foreign.surveyId));
    const checks = await checksFor([dangling.surveyId, foreign.surveyId, donor.surveyId]);
    const c = fired(checks, "orphans.surveyDanglingVersion", dangling.surveyId);
    expect(c.examples.map((e) => e.id)).toContain(foreign.surveyId);
    expect(c.count).toBe(2);
  });

  test("ключ шкалы через границу версий", async () => {
    const v1 = await cleanSurvey();
    const v2 = await secondVersion(v1);
    // пункт первой версии в ключе шкалы второй
    await db.insert(scaleItems).values({ scaleId: v2.scaleId, questionId: v1.questionId });
    const c = fired(await checksFor([v1.surveyId]), "orphans.keyAcrossVersions", v1.surveyId);
    expect(c.extra.links).toBe(1);
  });

  test("ненормированный балл", async () => {
    const b = await cleanSurvey();
    const raw = await cleanResponse(b, { normalized: false });
    await cleanResponse(b);
    const c = fired(await checksFor([b.surveyId]), "scores.unnormalized", raw);
    expect(c.count).toBe(1);
    expect(c.extra.scores).toBe(1);
  });

  test("пункт ключа без ответа в сданном прохождении", async () => {
    const b = await cleanSurvey();
    const missing = await cleanResponse(b, { answer: false });
    const skipped = await cleanResponse(b, { answer: false });
    await db.insert(answers).values({ id: id(), responseId: skipped, questionId: b.questionId, skipped: true });
    await cleanResponse(b);
    const c = fired(await checksFor([b.surveyId]), "answers.missing", missing);
    expect(c.examples.map((e) => e.id)).toContain(skipped);
    expect(c.count).toBe(2);
    expect(c.extra).toMatchObject({ items: 2, required: 0 });
  });

  test("пункт с условием показа не считается пропуском: показан ли он, SQL не знает", async () => {
    const b = await cleanSurvey();
    await db.insert(questionLogic).values({ id: id(), questionId: b.questionId, sourceQuestionId: b.questionId, operator: "answered" });
    await cleanResponse(b, { answer: false, score: true });
    expect((await checksFor([b.surveyId])).get("answers.missing")!.count).toBe(0);
  });

  test("необязательный свободный текст вне ключа — не пропуск", async () => {
    const b = await cleanSurvey();
    await db.insert(questions).values({ id: id(), surveyId: b.surveyId, versionId: b.versionId, type: "text", title: { uk: "Коментар", ru: "Комментарий" } });
    await cleanResponse(b);
    expect((await checksFor([b.surveyId])).get("answers.missing")!.count).toBe(0);
  });

  test("одна методика дважды за минуту одним человеком — дубль; через пять минут — нет", async () => {
    const b = await cleanSurvey();
    const person = await makeUser("user", `dq-dup-${id()}@test`);
    const t0 = Date.now() - 3_600_000;
    await cleanResponse(b, { userId: person.id, submittedAt: new Date(t0).toISOString() });
    const second = await cleanResponse(b, { userId: person.id, submittedAt: new Date(t0 + 20_000).toISOString() });
    await cleanResponse(b, { userId: person.id, submittedAt: new Date(t0 + 5 * 60_000).toISOString() });
    const c = fired(await checksFor([b.surveyId]), "responses.duplicates", second);
    // считается вторая сдача пары, а не обе: лишняя — одна
    expect(c.count).toBe(1);
  });
});

describe("маршрут проверок", () => {
  test("открыт по ops.read и пишет чтение в журнал", async () => {
    const res = await api<{ checks: DataCheck[]; checkedAt: string }>("/api/ops/data/quality", root.token);
    expect(res.status).toBe(200);
    expect(res.body.checks.map((c) => c.key)).toEqual([...DATA_CHECK_KEYS]);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "ops.data_read"), eq(auditLog.actorId, root.id), eq(auditLog.resourceId, "quality")));
    expect(row).toBeDefined();
  });

  test("пациенту и сотруднику без ops.read — отказ", async () => {
    expect((await api("/api/ops/data/quality", patient.token)).status).toBe(403);
    /*
     * Обычный администратор группы — со встроенной ролью «психолог». Набор
     * роли собран вычитанием из справочника, и ops.read попадал в него сам:
     * техпанель открывалась каждому, кто ведёт пациентов.
     */
    const staff = await makeUser("admin", `dq-staff-${id()}@test`);
    for (const view of ["quality", "usage", "mobile", "push"]) {
      expect((await api(`/api/ops/data/${view}`, staff.token)).status, view).toBe(403);
    }
  });

  test("разработчику — личным исключением ops.read — открыто, и числа те же, что у суперадмина", async () => {
    const dev = await makeUser("admin", `dq-dev-${id()}@test`);
    await db.insert(permissionExceptions).values({
      id: id(),
      userId: dev.id,
      permission: "ops.read",
      mode: "grant",
      reason: "разработчик: разбор качества данных в техпанели",
      grantedBy: root.id,
    });
    const mine = await api<{ checks: DataCheck[] }>("/api/ops/data/quality", dev.token);
    expect(mine.status).toBe(200);
    // под asSystem: у администратора без групп зона пуста, а числа — про всю базу
    const theirs = await api<{ checks: DataCheck[] }>("/api/ops/data/quality", root.token);
    expect(mine.body.checks.map((c) => c.count)).toEqual(theirs.body.checks.map((c) => c.count));
  });

  test("окно — только 7, 30 или 90 дней", async () => {
    expect((await api("/api/ops/data/usage?days=45", root.token)).status).toBe(400);
    expect((await api("/api/ops/data/usage?days=7", root.token)).status).toBe(200);
  });
});

/* ─────────────────────── использование ─────────────────────── */

const UUID = "8c1f2b1e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";

function screens(token: string, body: unknown) {
  return api("/api/usage/screens", token, { method: "POST", body: JSON.stringify(body) });
}

describe("телеметрия экранов", () => {
  test("пачка шаблонов принимается и складывается по дню", async () => {
    const route = `/ops-probe-${"x".repeat(4)}/:userId`;
    const first = await screens(patient.token, {
      views: [
        { app: "patient", route, count: 2 },
        { app: "patient", route, count: 1 },
      ],
    });
    expect(first.status).toBe(200);
    expect((await screens(root.token, { views: [{ app: "patient", route, count: 4 }] })).status).toBe(200);
    const rows = await db.select().from(screenViews).where(eq(screenViews.route, route));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.views).toBe(7);

    const usage = await api<UsageReport>("/api/ops/data/usage?days=7", root.token);
    expect(usage.status).toBe(200);
    expect(usage.body.screens.top).toContainEqual({ app: "patient", route, views: 7, days: 1 });
    expect(usage.body.screens.byDay).toHaveLength(7);
  });

  test("адрес с идентификатором отвергается — и ничего не пишется", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(screenViews);
    for (const route of [
      `/patients/${UUID}`,
      "/patients/12345",
      "/patients/deadbeefcafe",
      "/patients?q=Петренко",
      "patients",
    ]) {
      const res = await screens(root.token, { views: [{ app: "console", route, count: 1 }] });
      expect(res.status, route).toBe(400);
    }
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(screenViews);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  test("лишние поля отвергаются: в счётчик нечего положить «заодно»", async () => {
    const ok = { app: "console", route: "/patients/:userId", count: 1 };
    expect((await screens(root.token, { views: [{ ...ok, title: "Петренко І. П." }] })).status).toBe(400);
    expect((await screens(root.token, { views: [{ ...ok, userId: UUID }] })).status).toBe(400);
    expect((await screens(root.token, { views: [ok], email: "p@test" })).status).toBe(400);
    expect((await screens(root.token, { views: [{ ...ok, app: "admin" }] })).status).toBe(400);
    expect((await screens(root.token, { views: [{ ...ok, count: 0 }] })).status).toBe(400);
    expect((await screens(root.token, { views: [] })).status).toBe(400);
  });

  test("без входа — отказ", async () => {
    const { app } = await import("../src/app");
    const res = await app.request("/api/usage/screens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ views: [{ app: "console", route: "/", count: 1 }] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("активные люди", () => {
  test("специалисты — числом, пациенты — через порог: 1…4 не печатается никогда", async () => {
    const staff = await Promise.all([1, 2, 3].map((i) => makeUser("admin", `act-s${i}-${id()}@test`)));
    for (const s of staff) {
      await db.insert(refreshTokens).values({
        id: id(),
        userId: s.id,
        tokenHash: id(),
        familyId: id(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    }
    const b = await cleanSurvey();
    for (let i = 0; i < 6; i++) {
      const p = await makeUser("user", `act-p${i}-${id()}@test`);
      await cleanResponse(b, { userId: p.id });
    }
    const res = await api<UsageReport>("/api/ops/data/usage?days=7", root.token);
    const today = res.body.active.byDay.at(-1)!;
    expect(today.staff).toBeGreaterThanOrEqual(3);
    expect(today.patients).not.toBeNull();
    expect(today.patients!).toBeGreaterThanOrEqual(6);
    for (const d of res.body.active.byDay) {
      if (d.patients !== null) expect(d.patients === 0 || d.patients >= res.body.smallCellFloor, d.date).toBe(true);
    }
    expect(res.body.active.staff7).toBeGreaterThanOrEqual(3);
  });
});

describe("воронка пациента", () => {
  test("ступени через порог цепочкой: малая разница соседних не печатается", () => {
    // 20 → 18: двое не дошли до первого прохождения — горстка, скрыта
    expect(funnelCells([20, 18, 10])).toEqual([20, null, 10]);
    // малая ступень скрыта всегда
    expect(funnelCells([12, 3, 0])).toEqual([12, null, 0]);
    // равные ступени — разница ноль, ничего не выдаёт
    expect(funnelCells([8, 8, 8])).toEqual([8, 8, 8]);
    // разницы не меньше порога — всё видно
    expect(funnelCells([30, 20, 10])).toEqual([30, 20, 10]);
    // первая ступень меньше порога — вся цепочка сравнивается дальше с пустотой
    expect(funnelCells([4, 4, 0])).toEqual([null, null, 0]);
    // следующая сравнивается с последней ПОКАЗАННОЙ, а не со скрытой
    expect(funnelCells([20, 17, 16])).toEqual([20, null, null]);
    expect(funnelCells([20, 17, 15])).toEqual([20, null, 15]);
  });

  test("приглашение → регистрация → первое → повторное (в двух разных днях)", async () => {
    const inviter = await makeUser("admin", `funnel-${id()}@test`);
    const b = await cleanSurvey();
    const inviteId = id();
    await db.insert(invites).values({
      id: inviteId,
      tokenHash: id(),
      code: id().slice(0, 12),
      createdBy: inviter.id,
      maxUses: 20,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    // ещё одно, по которому никто не пришёл
    await db.insert(invites).values({
      id: id(),
      tokenHash: id(),
      code: id().slice(0, 12),
      createdBy: inviter.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    /*
     * Разницы ступеней — не меньше порога, иначе ступень скрылась бы
     * (funnelCells): двадцать пришли, пятнадцать прошли, десять вернулись в
     * другой день. Одиннадцатый прошёл дважды, но за один приход — если бы он
     * посчитался вернувшимся, ступень стала бы 11, разница с 15 — четыре, и
     * она скрылась бы: ошибка не прошла бы незамеченной ни в какую сторону.
     */
    for (let i = 0; i < 20; i++) {
      const p = await makeUser("user", `funnel-p${i}-${id()}@test`);
      await db.insert(inviteUses).values({ inviteId, userId: p.id });
      if (i < 15) await cleanResponse(b, { userId: p.id, submittedAt: ago(3 * 86_400_000) });
      if (i < 10) await cleanResponse(b, { userId: p.id });
      if (i === 10) await cleanResponse(b, { userId: p.id, submittedAt: ago(3 * 86_400_000 - 60_000) });
    }
    const report = await usageReport(30, { inviterId: inviter.id });
    expect(report.funnel.invites).toBe(2);
    expect(report.funnel.registered).toBe(20);
    expect(report.funnel.firstResponse).toBe(15);
    expect(report.funnel.repeatResponse).toBe(10);
    expect(report.funnel.days).toBe(90);
  });

  test("малая разница соседних ступеней скрыта и в отчёте", async () => {
    const inviter = await makeUser("admin", `funnel-small-${id()}@test`);
    const b = await cleanSurvey();
    const inviteId = id();
    await db.insert(invites).values({
      id: inviteId,
      tokenHash: id(),
      code: id().slice(0, 12),
      createdBy: inviter.id,
      maxUses: 20,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    // 8 пришли, 6 прошли: двое не дошли — горстка, которую нельзя напечатать вычитанием
    for (let i = 0; i < 8; i++) {
      const p = await makeUser("user", `funnel-s${i}-${id()}@test`);
      await db.insert(inviteUses).values({ inviteId, userId: p.id });
      if (i < 6) await cleanResponse(b, { userId: p.id });
    }
    const report = await usageReport(30, { inviterId: inviter.id });
    expect(report.funnel.registered).toBe(8);
    expect(report.funnel.firstResponse).toBeNull();
    expect(report.funnel.repeatResponse).toBe(0);
  });
});

/* ─────────────────────── мобильное приложение ─────────────────────── */

function checkin(token: string, body: Record<string, unknown>) {
  return api<{ wipe: boolean }>("/api/devices/checkin", token, { method: "POST", body: JSON.stringify(body) });
}

describe("мобильное приложение", () => {
  test("версия и очередь с отметки устройства; старая сборка — по сравнению версий, а не строк", async () => {
    const a = await makeUser("user", `mob-a-${id()}@test`);
    const newDevice = `dev-${id()}`;
    const oldDevice = `dev-${id()}`;
    const unknownDevice = `dev-${id()}`;
    expect(
      (await checkin(a.token, { deviceId: newDevice, platform: "ios", appVersion: "90.10.0", appBuild: "41", queue: { pending: 2, rejected: 1 } })).status,
    ).toBe(200);
    // «90.9.3» строкой больше «90.10.0», версией — меньше
    expect((await checkin(a.token, { deviceId: oldDevice, platform: "android", appVersion: "90.9.3", appBuild: "39", queue: { pending: 0, rejected: 0 } })).status).toBe(200);
    expect((await checkin(a.token, { deviceId: unknownDevice, platform: "android" })).status).toBe(200);

    const res = await api<MobileReport>("/api/ops/data/mobile", root.token);
    expect(res.status).toBe(200);
    expect(res.body.newest).toBe("90.10.0");
    const row = (v: string) => res.body.versions.find((x) => x.version === v)!;
    expect(row("90.10.0")).toMatchObject({ old: false, build: "41", platform: "ios", devices: 1 });
    expect(row("90.9.3")).toMatchObject({ old: true, build: "39" });
    expect(res.body.old.devices).toBeGreaterThanOrEqual(1);
    expect(res.body.devices.unknown).toBeGreaterThanOrEqual(1);
    expect(res.body.queue.rejected).toBeGreaterThanOrEqual(1);
    expect(res.body.queue.devicesWithRejected).toBeGreaterThanOrEqual(1);
    expect(res.body.queue.pending).toBeGreaterThanOrEqual(2);
  });

  test("старая сборка без версии не затирает присланное раньше", async () => {
    const a = await makeUser("user", `mob-b-${id()}@test`);
    const deviceId = `dev-${id()}`;
    await checkin(a.token, { deviceId, appVersion: "2.0.0", appBuild: "7", queue: { pending: 1, rejected: 0 } });
    await checkin(a.token, { deviceId });
    const [row] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row).toMatchObject({ appVersion: "2.0.0", appBuild: "7", queuePending: 1 });
  });

  test("версия чужого вида отвергается", async () => {
    const a = await makeUser("user", `mob-c-${id()}@test`);
    const res = await checkin(a.token, { deviceId: `dev-${id()}`, appVersion: "<script>" });
    expect(res.status).toBe(400);
  });

  test("досылка из офлайн-очереди видна с опозданием", async () => {
    const res = await submitSurvey(surveyInA, patient.token, {
      clientRequestId: id(),
      startedAt: ago(3 * 86_400_000),
      durationMs: 60_000,
    });
    expect(res.status).toBe(201);
    const report = await api<MobileReport>("/api/ops/data/mobile?days=7", root.token);
    expect(report.body.late.total).toBeGreaterThanOrEqual(1);
    const bucket = report.body.late.buckets.find((x) => x.key === "lt7d")!;
    expect(bucket.count).toBeGreaterThanOrEqual(1);
    expect(report.body.late.medianLagMs).not.toBeNull();
    expect(report.body.late.byDay.at(-1)!.count).toBeGreaterThanOrEqual(1);
  });
});

/* ─────────────────────── пуш-уведомления ─────────────────────── */

async function withDevices(tag: string, n: number) {
  const p = await makeUser("user", `push-ops-${tag}-${id()}@test`);
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) {
    const token = `ExponentPushToken[${id()}]`;
    tokens.push(token);
    await db.insert(pushTokens).values({ id: id(), userId: p.id, token, platform: i % 2 ? "android" : "ios" } as never);
  }
  return { user: p, tokens };
}

const message = (kind = "appointment.reminder") => ({ eventKey: `ops:${id()}`, kind, title: "Нагадування", body: "Завтра о 10:00" });

describe("пуш-уведомления", () => {
  test("исход по каждому устройству: билет, отказ Expo, мёртвый токен забыт", async () => {
    const { user, tokens } = await withDevices("tickets", 2);
    const ticketId = `ticket-${id()}`;
    setPushSenderForTests(async () => [
      { status: "ok", id: ticketId },
      { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
    ]);
    expect(await pushToUser(user.id, message("ops.test"))).toBe(true);

    const rows = await db
      .select()
      .from(pushOutcomes)
      .where(eq(pushOutcomes.kind, "ops.test"));
    expect(rows).toHaveLength(2);
    const accepted = rows.find((r) => r.status === "accepted")!;
    expect(accepted.ticketId).toBe(ticketId);
    expect(accepted.tokenHash).toBe(tokenFingerprint(tokens[0]!));
    const rejected = rows.find((r) => r.status === "rejected")!;
    expect(rejected.error).toBe("DeviceNotRegistered");
    // токен не хранится — только отпечаток
    expect(JSON.stringify(rows)).not.toContain("ExponentPushToken");

    const left = await db.select().from(pushTokens).where(eq(pushTokens.userId, user.id));
    expect(left.map((t) => t.token)).toEqual([tokens[0]!]);
  });

  test("сбой отправки — исход failed, заявка снята, повтор возможен", async () => {
    const { user } = await withDevices("fail", 1);
    setPushSenderForTests(async () => {
      throw new Error("expo push 503");
    });
    expect(await pushToUser(user.id, message("ops.fail"))).toBe(false);
    const rows = await db.select().from(pushOutcomes).where(eq(pushOutcomes.kind, "ops.fail"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", error: "http_503", ticketId: null });
  });

  test("квитанции: передано Apple/Google, отказ с кодом, DeviceNotRegistered забывает токен по отпечатку", async () => {
    const { user, tokens } = await withDevices("receipts", 2);
    const okTicket = `ticket-${id()}`;
    const deadTicket = `ticket-${id()}`;
    setPushSenderForTests(async () => [
      { status: "ok", id: okTicket },
      { status: "ok", id: deadTicket },
    ]);
    expect(await pushToUser(user.id, message("ops.receipt"))).toBe(true);

    // слишком рано — квитанцию не спрашиваем
    let asked: string[] = [];
    setPushReceiptFetcherForTests(async (ids) => {
      asked = ids;
      return {};
    });
    await checkPushReceipts(new Date());
    expect(asked).not.toContain(okTicket);

    setPushReceiptFetcherForTests(async () => ({
      [okTicket]: { status: "ok" },
      [deadTicket]: { status: "error", details: { error: "DeviceNotRegistered" } },
    }));
    const result = await checkPushReceipts(new Date(Date.now() + 20 * 60_000));
    expect(result.checked).toBeGreaterThanOrEqual(2);

    const rows = await db.select().from(pushOutcomes).where(eq(pushOutcomes.kind, "ops.receipt"));
    expect(rows.find((r) => r.ticketId === okTicket)).toMatchObject({ receiptStatus: "ok", receiptError: null });
    expect(rows.find((r) => r.ticketId === deadTicket)).toMatchObject({ receiptStatus: "error", receiptError: "DeviceNotRegistered" });
    const left = await db.select().from(pushTokens).where(eq(pushTokens.userId, user.id));
    expect(left.map((t) => t.token)).toEqual([tokens[0]!]);
  });

  test("отчёт: по типам, по кодам ошибок на скольких устройствах — и ни одного токена", async () => {
    const res = await api<PushReport>("/api/ops/data/push?days=7", root.token);
    expect(res.status).toBe(200);
    expect(res.body.since).not.toBeNull();
    // два устройства + одно + два — исход по каждому устройству, не по сообщению
    expect(res.body.totals.sent).toBeGreaterThanOrEqual(5);
    expect(res.body.totals.delivered).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.failed).toBeGreaterThanOrEqual(1);
    const kinds = new Map(res.body.byKind.map((k) => [k.kind, k]));
    expect(kinds.get("ops.test")).toMatchObject({ sent: 2, errors: 1 });
    expect(kinds.get("ops.receipt")).toMatchObject({ sent: 2, errors: 1, delivered: 1 });
    const dnr = res.body.errors.find((e) => e.code === "DeviceNotRegistered")!;
    expect(dnr.count).toBeGreaterThanOrEqual(2);
    expect(dnr.tokens).toBeGreaterThanOrEqual(2);
    expect(res.body.errors.find((e) => e.code === "http_503")).toBeDefined();
    expect(res.body.byDay).toHaveLength(7);
    expect(JSON.stringify(res.body)).not.toContain("ExponentPushToken");
  });
});

/* ─────────────────────── политики строк ─────────────────────── */

describe("новые таблицы под политикой строк", () => {
  for (const table of ["screen_views", "push_outcomes"]) {
    test(`${table}: политика есть, RLS включён, открыта только системе и суперадмину`, async () => {
      const policies = [
        ...(await db.execute<{ qual: string; with_check: string | null }>(sql`
          select qual, with_check from pg_policies where schemaname = 'public' and tablename = ${table}
        `)),
      ];
      expect(policies.length, `${table} без политики`).toBeGreaterThan(0);
      const text = policies.map((p) => `${p.qual} ${p.with_check}`).join(" ");
      expect(text).toContain("system");
      expect(text).toContain("superadmin");
      expect(text).not.toContain("'admin'");
      const [rls] = [
        ...(await db.execute<{ relrowsecurity: boolean }>(sql`
          select c.relrowsecurity from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'public' and c.relname = ${table}
        `)),
      ];
      expect(rls?.relrowsecurity).toBe(true);
    });
  }
});
