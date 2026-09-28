import { beforeAll, describe, expect, test } from "bun:test";
import { desc, inArray } from "drizzle-orm";
import {
  adminA,
  and,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  makeUser,
  sr45,
  submitSurvey,
  surveys,
} from "./fixtures";
import { responseScores, scaleBands, scales, surveyFollowups, surveyVersions } from "../src/db/schema";

/**
 * Каскад выбирает полосу по её id, а не по подписи.
 *
 * Внешний разбор 2026-09-28 (P2): каскад брал из результата подсчёта
 * подпись полосы и искал в базе полосы шкалы с такой подписью — на любом
 * языке. Подпись — отображаемая строка, у двух полос она может совпасть
 * (методист назвал обе «Помірно» на разных концах двусторонней шкалы, или
 * подписи сошлись в одном языке), и тогда срабатывали обе: при сыром балле
 * в нижней полосе назначалось то, что прописано на верхней.
 *
 * Сценарий через настоящую сдачу: подсчёт кладёт в результат id полосы
 * версии, каскад берёт по нему ровно её.
 */

let surveyId: string;
let scaleId: string;
let hitBandId: string;

async function publishSr45(title: string): Promise<{ id: string; scaleId: string }> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: title, ru: title, en: title },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(sr45), adminA.id, "v1");
  const [version] = await db
    .select()
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, id))
    .orderBy(desc(surveyVersions.version))
    .limit(1);
  const scale = await db.query.scales.findFirst({ where: and(eq(scales.versionId, version!.id), eq(scales.code, "Sr")) });
  return { id, scaleId: scale!.id };
}

beforeAll(async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  /*
   * В какую полосу ложатся «безопасные» ответы — узнаём сдачей той же
   * методики-близнеца, пока подписи у полос разные. Не сдачей целевой:
   * содержимое версии кэшируется при первом чтении (lib/surveys.ts), и
   * подписи, поправленные после, до подсчёта целевой уже не дошли бы.
   */
  const probeSurvey = await publishSr45(`Каскад-проба ${tag}`);
  const probe = await makeUser("user", `cascade-band-probe-${crypto.randomUUID()}@test`, {
    sex: "male",
    birthDate: "1990-01-01",
  });
  const res = await submitSurvey(probeSurvey.id, probe.token);
  expect(res.status).toBe(201);
  const [score] = await db
    .select()
    .from(responseScores)
    .where(and(eq(responseScores.responseId, res.body.id), eq(responseScores.scaleId, probeSurvey.scaleId)));
  const probeBands = await db.select().from(scaleBands).where(eq(scaleBands.scaleId, probeSurvey.scaleId));
  const hit = probeBands.filter((b) => Object.values(b.label as Record<string, string>).includes(score!.bandLabel!));
  expect(hit.length, "подписи полос шкалы до правки разные").toBe(1);

  const target = await publishSr45(`Каскад за id смуги ${tag}`);
  surveyId = target.id;
  scaleId = target.scaleId;
  const bands = await db.select().from(scaleBands).where(eq(scaleBands.scaleId, scaleId));
  hitBandId = bands.find((b) => b.position === hit[0]!.position)!.id;
  // у всех полос целевой шкалы одна подпись — до её первого чтения
  await db
    .update(scaleBands)
    .set({ label: { uk: "Однаково", ru: "Одинаково", en: "Same" } })
    .where(eq(scaleBands.scaleId, scaleId));
}, 30_000);

async function windowsOf(userId: string) {
  return db
    .select()
    .from(surveyFollowups)
    .where(and(eq(surveyFollowups.surveyId, surveyId), eq(surveyFollowups.userId, userId)));
}

describe("каскад по id полосы", () => {
  test("повтор, прописанный на другой полосе с той же подписью, не назначается", async () => {
    const others = (await db.select({ id: scaleBands.id }).from(scaleBands).where(eq(scaleBands.scaleId, scaleId)))
      .map((b) => b.id)
      .filter((id) => id !== hitBandId);
    expect(others.length).toBeGreaterThan(0);
    await db.update(scaleBands).set({ followUpDays: null }).where(eq(scaleBands.id, hitBandId));
    await db.update(scaleBands).set({ followUpDays: "7,30" }).where(inArray(scaleBands.id, others));

    const p = await makeUser("user", `cascade-band-other-${crypto.randomUUID()}@test`, {
      sex: "male",
      birthDate: "1990-01-01",
    });
    const res = await submitSurvey(surveyId, p.token);
    expect(res.status).toBe(201);
    expect(res.body.cascade.scheduledFollowUps).toBe(0);
    expect(await windowsOf(p.id)).toEqual([]);
  }, 30_000);

  test("повтор, прописанный на самой полосе, назначается — ровно один раз", async () => {
    await db.update(scaleBands).set({ followUpDays: null }).where(eq(scaleBands.scaleId, scaleId));
    await db.update(scaleBands).set({ followUpDays: "7" }).where(eq(scaleBands.id, hitBandId));

    const p = await makeUser("user", `cascade-band-own-${crypto.randomUUID()}@test`, {
      sex: "male",
      birthDate: "1990-01-01",
    });
    const res = await submitSurvey(surveyId, p.token);
    expect(res.status).toBe(201);
    expect(res.body.cascade.scheduledFollowUps).toBe(1);
    expect((await windowsOf(p.id)).map((w) => w.afterDays)).toEqual([7]);
  }, 30_000);
});
