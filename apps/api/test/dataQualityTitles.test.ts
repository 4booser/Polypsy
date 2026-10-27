import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, root, sql } from "./fixtures";
import { surveyGroups, surveys } from "../src/db/schema";
import { runDataChecks } from "../src/lib/dataChecks";

/**
 * «Якість даних»: название методики без языков — строка, а не объект.
 *
 * Методика, заведённая до двуязычия, хранит название jsonb-строкой
 * («Абетка»). Разбивка проверок по методикам разбирала его как JSON и роняла
 * весь маршрут /api/ops/data/quality пятисоткой, как только такая методика
 * попадала в разбивку.
 *
 * Мутация: снова разбирать parsed() любое строковое название — тест падает
 * на «JSON Parse error».
 */
describe("якість даних: название без языков", () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const group = crypto.randomUUID();
  const id = crypto.randomUUID();
  const responseId = `dq-title-${tag}`;
  const title = `Абетка ${tag}`;

  beforeAll(async () => {
    await db.insert(surveyGroups).values({ id: group, title: `Якість ${tag}`, createdBy: root.id });
    await db.insert(surveys).values({
      id,
      groupId: group,
      title,
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      createdBy: root.id,
    } as never);
    // прохождение без версии — несостыковка, которая ставит методику в разбивку
    await db.execute(sql`
      insert into responses (id, survey_id, status, version_id, started_at, submitted_at)
      values (${responseId}, ${id}, 'completed', null, now(), now())`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from responses where id = ${responseId}`);
    await db.delete(surveys).where(eq(surveys.id, id));
    await db.delete(surveyGroups).where(eq(surveyGroups.id, group));
  });

  test("разбивка называет методику её строкой, а не падает", async () => {
    const checks = await runDataChecks("uk", { surveyIds: [id] });
    const orphans = checks.find((c) => c.key === "orphans.responseNoVersion");
    expect(orphans?.bySurvey).toEqual([{ surveyId: id, count: 1, title }]);
  });
});
