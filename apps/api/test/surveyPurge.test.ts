import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { and, inArray } from "drizzle-orm";
import { db, eq, groupAdmins, makeUser, responsesTable, root, sql, surveyGroups, surveys } from "./fixtures";
import { alertCases, auditLog, conclusions, riskAlerts } from "../src/db/schema";
import { PurgeRefused, purgePlan, purgeSurvey } from "../src/lib/surveyPurge";
import { underAppRole } from "./appRole";

/**
 * Физическая чистка методики (клиническое ревью волны 12, P1 и P2).
 *
 * Воспроизведение из ревью: у человека сигналы двух методик одной группы,
 * случай начат методикой А. После чистки А у методики Б оставалось 0 тревог
 * из 10: каскад по alert_cases.survey_id уносил случай, по risk_alerts.case_id
 * — все сигналы в нём. Сводка «будет уничтожено» считала только тревоги А.
 *
 * Всё своё: группа, методики, люди. Чистка удаляет только своё; то, что
 * остаётся открытым, закрывается в конце проверки, где оно заведено.
 */

const tag = crypto.randomUUID().slice(0, 8);
const groupId = crypto.randomUUID();
await db.insert(surveyGroups).values({ id: groupId, title: `Чистка ${tag}`, createdBy: root.id });
const staff = await makeUser("admin", `purge-${crypto.randomUUID()}@test.dev`);
await db.insert(groupAdmins).values({ groupId, userId: staff.id, addedBy: root.id });

async function survey(title: string, archived = true): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId,
    title: { uk: title, ru: title },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    archivedAt: archived ? new Date().toISOString() : null,
    visibility: "private",
    createdBy: root.id,
  } as never);
  return id;
}

/** Прохождение и n сигналов по нему — время сигналов с шагом в минуту от `from` */
async function signals(surveyId: string, userId: string, caseId: string, n: number, from: number, severity = "moderate") {
  const responseId = crypto.randomUUID();
  await db.insert(responsesTable).values({
    id: responseId,
    surveyId,
    userId,
    status: "completed",
    startedAt: new Date(from).toISOString(),
    submittedAt: new Date(from).toISOString(),
  } as never);
  await db.insert(riskAlerts).values(
    Array.from({ length: n }, (_, k) => ({
      id: crypto.randomUUID(),
      responseId,
      surveyId,
      userId,
      caseId,
      label: `Сигнал ${k}`,
      severity: severity as "moderate" | "severe",
      at: new Date(from + k * 60_000).toISOString(),
    })),
  );
  return responseId;
}

async function openCase(userId: string, surveyId: string, at: number, severity: "moderate" | "severe") {
  const id = crypto.randomUUID();
  await db.insert(alertCases).values({
    id,
    userId,
    surveyId,
    severity,
    openedAt: new Date(at).toISOString(),
    lastAlertAt: new Date(at).toISOString(),
  });
  return id;
}

const alertsOf = async (surveyId: string) =>
  Number(
    ((await db.execute(sql`select count(*)::int as n from risk_alerts where survey_id = ${surveyId}`)) as unknown as {
      n: number;
    }[])[0]!.n,
  );
const purgeEntries = async (surveyId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "survey.purge"), eq(auditLog.resourceId, surveyId)));

describe("чистка методики", () => {
  test("чистка А не уносит тревоги Б: случай переходит на Б, сводка называет сохраняемое", async () => {
    const a = await survey(`Методика А ${tag}`);
    const b = await survey(`Методика Б ${tag}`, false);
    const both = await makeUser("user", `purge-both-${crypto.randomUUID()}@test.dev`);
    const onlyA = await makeUser("user", `purge-a-${crypto.randomUUID()}@test.dev`);
    const t0 = Date.now() - 3 * 3_600_000;

    // случай начат методикой А (2 сигнала), дальше в него легли 10 сигналов Б
    const mixed = await openCase(both.id, a, t0, "severe");
    await signals(a, both.id, mixed, 2, t0, "severe");
    await signals(b, both.id, mixed, 10, t0 + 30 * 60_000);
    // у второго человека — только сигналы А
    const pure = await openCase(onlyA.id, a, t0, "moderate");
    await signals(a, onlyA.id, pure, 3, t0);

    const plan = await purgePlan(a);
    expect(plan).toMatchObject({
      alerts: 5,
      casesRemoved: 1,
      casesMoved: 1,
      keptSignals: 10,
      signedConclusions: 0,
    });

    const title = plan!.title;
    await purgeSurvey(a, title);

    expect(await alertsOf(b), "чистка А унесла тревоги методики Б").toBe(10);
    expect(await alertsOf(a)).toBe(0);
    const moved = await db.query.alertCases.findFirst({ where: eq(alertCases.id, mixed) });
    expect(moved?.surveyId, "случай остался за удалённой методикой").toBe(b);
    // тяжесть и время — по оставшимся сигналам: тяжёлые были у А
    expect(moved?.severity).toBe("moderate");
    expect(Date.parse(moved!.openedAt)).toBe(t0 + 30 * 60_000);
    expect(Date.parse(moved!.lastAlertAt)).toBe(t0 + 30 * 60_000 + 9 * 60_000);
    expect(await db.query.alertCases.findFirst({ where: eq(alertCases.id, pure) })).toBeUndefined();

    const [entry] = await purgeEntries(a);
    expect(entry, "чистка без записи в журнале").toBeDefined();
    expect(entry!.details).toMatchObject({ keptSignals: 10, casesMoved: 1, alerts: 5 });

    // перенесённый случай никому не нужен открытым после проверки
    await db
      .update(alertCases)
      .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: root.id, outcome: "not_confirmed" })
      .where(eq(alertCases.id, mixed));
  });

  test("случай с чужими сигналами база удалить не даёт — отказ вместо молчаливой потери", async () => {
    const a = await survey(`Прямо А ${tag}`);
    const b = await survey(`Прямо Б ${tag}`, false);
    const person = await makeUser("user", `purge-direct-${crypto.randomUUID()}@test.dev`);
    const t0 = Date.now() - 3_600_000;
    const mixed = await openCase(person.id, a, t0, "moderate");
    await signals(a, person.id, mixed, 1, t0);
    await signals(b, person.id, mixed, 4, t0 + 60_000);

    // так удаляла прежняя редакция скрипта: без переноса случая
    const direct = await db
      .delete(surveys)
      .where(eq(surveys.id, a))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(direct, "удаление методики каскадом унесло сигналы другой методики").not.toBeNull();
    expect(await alertsOf(b)).toBe(4);

    // а удаление, уносящее случай вместе со всеми его сигналами, проходит
    await db.delete(riskAlerts).where(and(eq(riskAlerts.caseId, mixed), eq(riskAlerts.surveyId, b)));
    await db.delete(surveys).where(eq(surveys.id, a));
    expect(await db.query.alertCases.findFirst({ where: eq(alertCases.id, mixed) })).toBeUndefined();
  });

  test("подписанное заключение — отказ до начала; ни удаления, ни записи в журнале", async () => {
    const c = await survey(`Із підписаним ${tag}`);
    const person = await makeUser("user", `purge-signed-${crypto.randomUUID()}@test.dev`);
    const caseId = await openCase(person.id, c, Date.now() - 60_000, "moderate");
    const responseId = await signals(c, person.id, caseId, 1, Date.now() - 60_000);
    await db.insert(conclusions).values({
      id: crypto.randomUUID(),
      responseId,
      version: 1,
      text: "Підписаний висновок",
      status: "signed",
      createdBy: staff.id,
      signedBy: staff.id,
      signedAt: new Date().toISOString(),
    } as never);

    const plan = await purgePlan(c);
    expect(plan?.signedConclusions).toBe(1);
    const refused = await purgeSurvey(c, plan!.title).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PurgeRefused);
    expect(await db.query.surveys.findFirst({ where: eq(surveys.id, c) })).toBeDefined();
    expect(await purgeEntries(c), "в журнале чистка, которой не было").toHaveLength(0);

    // и без снятия с использования и точного названия — тоже отказ до начала
    const live = await survey(`Діюча ${tag}`, false);
    expect(await purgeSurvey(live, `Діюча ${tag}`).catch((e: unknown) => e)).toBeInstanceOf(PurgeRefused);
    const archived = await survey(`Знята ${tag}`);
    expect(await purgeSurvey(archived, "не те").catch((e: unknown) => e)).toBeInstanceOf(PurgeRefused);
    expect(await purgeEntries(archived)).toHaveLength(0);

    await db
      .update(alertCases)
      .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: root.id, outcome: "not_confirmed" })
      .where(inArray(alertCases.id, [caseId]));
  });

  test("под боевой ролью методика находится и чистится — без контекста её не видно", async () => {
    const d = await survey(`Під роллю ${tag}`);
    const title = `Під роллю ${tag}`;
    const lib = resolve(import.meta.dir, "../src/lib/surveyPurge.ts");
    const dbModule = resolve(import.meta.dir, "../src/db/index.ts");
    const out = await underAppRole<{ bare: boolean; planned: boolean; purged: boolean; gone: boolean }>(`
      const { db, schema } = await import(${JSON.stringify(dbModule)});
      const { eq } = await import("drizzle-orm");
      const { purgePlan, purgeSurvey } = await import(${JSON.stringify(lib)});
      // так шёл прежний скрипт: без контекста базы политики строк не отдают ничего
      out.bare = !!(await db.query.surveys.findFirst({ where: eq(schema.surveys.id, ${JSON.stringify(d)}) }));
      out.planned = !!(await purgePlan(${JSON.stringify(d)}));
      await purgeSurvey(${JSON.stringify(d)}, ${JSON.stringify(title)});
      out.purged = true;
      out.gone = !(await purgePlan(${JSON.stringify(d)}));
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive, "роль обходит политики — проверка ничего не доказывает").toBe(true);
    expect(out.bare, "без контекста методика видна — проверка не про то").toBe(false);
    expect(out.planned).toBe(true);
    expect(out.purged).toBe(true);
    expect(out.gone).toBe(true);
    expect(await purgeEntries(d)).toHaveLength(1);
  }, 60_000);
});
