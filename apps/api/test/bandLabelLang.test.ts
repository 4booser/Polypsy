import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { adminA, api, db, makeUser, submitSurvey, surveyInA, type Person } from "./fixtures";
import { responseScores, scales, surveyAccess } from "../src/db/schema";

/**
 * Слово полосы — на языке читателя, а не на языке прохождения.
 *
 * response_scores.band_label — снимок подписи полосы на том языке, на котором
 * прошли методику (у посева — украинском). Маршруты отдавали его как есть, и
 * русская консоль показывала «Помірні порушення» рядом с русским названием
 * шкалы «Нарушения сна»: в определениях методик языки не перепутаны, но
 * экрану это не помогало (lib/bandLabels.ts).
 *
 * СР-45 «безопасными» ответами (все «Нет»): Sr = 11/35 = 0,314 — полоса
 * «Нижче середнього» / «Ниже среднего». Сдача — по-украински (язык запроса
 * по умолчанию), читает сотрудник с русской консолью.
 *
 * Мутация: вернуть в маршруте снимок (`bandLabel: score.bandLabel` и т. п.) —
 * тест падает и называет экран, на котором осталось украинское слово.
 */

const UK = "Нижче середнього";
const RU = "Ниже среднего";

let person: Person;
let responseId: string;

beforeAll(async () => {
  person = await makeUser("user", `band-lang-${crypto.randomUUID()}@test`, { sex: "male", birthDate: "1990-01-01" });
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
  const res = await submitSurvey(surveyInA, person.token);
  expect(res.status).toBe(201);
  responseId = res.body.responseId ?? res.body.id;
  expect(typeof responseId).toBe("string");
});

describe("слово полосы на языке читателя", () => {
  test("снимок записан на языке прохождения — украинском", async () => {
    const rows = await db
      .select({ code: scales.code, band: responseScores.bandLabel })
      .from(responseScores)
      .innerJoin(scales, eq(scales.id, responseScores.scaleId))
      .where(eq(responseScores.responseId, responseId));
    expect(rows.find((r) => r.code === "Sr")?.band).toBe(UK);
  });

  test("карточка пациента: русской консоли — по-русски, украинской — по-украински", async () => {
    const ru = await api(`/api/patients/${person.id}/card?lang=ru`, adminA.token);
    expect(ru.status).toBe(200);
    const sr = (lang: { body: any }) =>
      lang.body.responses
        .find((r: { responseId: string }) => r.responseId === responseId)
        ?.scales.find((s: { code: string }) => s.code === "Sr");
    expect(sr(ru)?.bandLabel, "карточка, ru").toBe(RU);
    const uk = await api(`/api/patients/${person.id}/card?lang=uk`, adminA.token);
    expect(sr(uk)?.bandLabel, "карточка, uk").toBe(UK);
  });

  test("динамика человека: точка замера — по-русски", async () => {
    const res = await api(`/api/dynamics/respondents/${person.id}?lang=ru`, adminA.token);
    expect(res.status).toBe(200);
    const points = res.body.surveys
      .flatMap((s: { scales: { code: string; points: { responseId: string; bandLabel: string | null }[] }[] }) => s.scales)
      .filter((s: { code: string }) => s.code === "Sr")
      .flatMap((s: { points: { responseId: string; bandLabel: string | null }[] }) => s.points);
    expect(points.find((p: { responseId: string }) => p.responseId === responseId)?.bandLabel, "динамика, ru").toBe(RU);
  });

  test("разбор прохождения: полоса балла — по-русски, как и лестница", async () => {
    const res = await api(`/api/responses/${responseId}?lang=ru`, adminA.token);
    expect(res.status).toBe(200);
    const sr = res.body.scores.find((s: { scaleCode: string }) => s.scaleCode === "Sr");
    expect(sr?.band?.label, "разбор, ru").toBe(RU);
    expect(sr?.bands.some((b: { label: string; hit?: boolean }) => b.label === RU)).toBe(true);
  });

  /*
   * Мутация: вернуть getSurvey без языка или bandLabelsIn("uk") — русская
   * сводка методики называет полосу «Нижче середнього», а прохождение не
   * попадает ни в одну полосу распределения.
   */
  test("сводка методики (огляд): название шкалы, полосы и распределение — по-русски", async () => {
    const res = await api(`/api/analytics/surveys/${surveyInA}?lang=ru`, adminA.token);
    expect(res.status).toBe(200);
    const sr = res.body.scales.find((s: { code: string }) => s.code === "Sr");
    expect(sr?.title, "сводка, название шкалы").toBe("Склонность к суицидальным реакциям");
    const band = sr?.bands.find((b: { label: string }) => b.label === RU);
    expect(band, "сводка, полоса").toBeTruthy();
    expect(band.count, "прохождение на украинском не попало в русскую полосу").toBeGreaterThanOrEqual(1);
    const uk = await api(`/api/analytics/surveys/${surveyInA}?lang=uk`, adminA.token);
    const ukBand = uk.body.scales.find((s: { code: string }) => s.code === "Sr")?.bands.find((b: { label: string }) => b.label === UK);
    expect(ukBand?.count, "сводка, uk").toBe(band.count);
  });

  test("список прохождений методики: название шкалы и полоса — по-русски", async () => {
    const res = await api(`/api/surveys/${surveyInA}/responses?lang=ru`, adminA.token);
    expect(res.status).toBe(200);
    const mine = res.body.rows.find((r: { id: string }) => r.id === responseId);
    const sr = mine?.scores.find((s: { scaleCode: string }) => s.scaleCode === "Sr");
    expect(sr?.scaleTitle, "список, название шкалы").toBe("Склонность к суицидальным реакциям");
    expect(sr?.band?.label, "список, полоса").toBe(RU);
  });
});
