import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, api, app, db, eq, makeUser, submitSurvey, surveyInA } from "./fixtures";
import { responses as responsesTable } from "../src/db/schema";
import { env } from "../src/env";

/**
 * Чем выгрузка называет наблюдение.
 *
 * Первая колонка каждой выгрузки — case_id, и во всех трёх профилях в ней
 * стоял первичный ключ прохождения. Обезличенная и анонимная выгрузки при
 * этом обещают разное, а отдавали одно и то же: ключ обратной
 * идентификации. Достаточно было взять case_id из CSV и открыть
 * GET /api/reports/responses/<case_id>, чтобы получить ФИО — мимо
 * обобщения возраста, мимо стирания пола в редких ячейках, мимо
 * отсутствия субъекта.
 *
 * Проверяется здесь именно эта дорога целиком, а не формат кода: формат
 * можно поменять и снова оставить ключ в соседней колонке.
 */

let subjectId: string;
let responseIds: string[];

async function csv(profile: string, file = "data.csv"): Promise<string> {
  const res = await app.request(`/api/spss/surveys/${surveyInA}/${file}?profile=${profile}`, {
    headers: { Authorization: `Bearer ${adminA.token}` },
  });
  expect(res.status).toBe(200);
  return res.text();
}

/** Первая колонка каждой строки данных */
function caseColumn(text: string): string[] {
  const [, ...rows] = text.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  return rows.map((r) => r.split(",")[0]!.replace(/^"|"$/g, ""));
}

beforeAll(async () => {
  const person = await makeUser("user", `export-${crypto.randomUUID()}@test.dev`);
  subjectId = person.id;
  await submitSurvey(surveyInA, person.token);

  responseIds = (
    await db
      .select({ id: responsesTable.id })
      .from(responsesTable)
      .where(eq(responsesTable.surveyId, surveyInA))
  ).map((r) => r.id);
  expect(responseIds.length).toBeGreaterThan(0);
});

describe("анонимный профиль", () => {
  test("case_id не ведёт обратно в карту", async () => {
    const text = await csv("anonymous");
    const codes = caseColumn(text);
    expect(codes.length).toBeGreaterThan(0);

    // ни один идентификатор прохождения в файл не попал
    for (const id of responseIds) expect(text).not.toContain(id);

    /*
     * И главное — дорога закрыта не только по виду кода. Берём код из файла
     * ровно так, как взял бы его исследователь, и идём тем же маршрутом,
     * которым раскрывалось имя.
     */
    const probe = await api(`/api/reports/responses/${encodeURIComponent(codes[0]!)}`, adminA.token);
    expect(probe.status).toBe(404);
  });

  test("две выгрузки не склеиваются между собой", async () => {
    /*
     * Стабильный код (хоть бы и необратимый) означал бы, что выгрузки за
     * разные месяцы сопоставляются построчно — то есть «анонимные»
     * наблюдения снова собираются в цепочку одного человека. Профиль
     * обещает обратное, и обещание должно быть выполнимо только так.
     */
    const first = caseColumn(await csv("anonymous"));
    const second = caseColumn(await csv("anonymous"));

    expect(first.length).toBe(second.length);
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  });

  test("внутри одной выгрузки код у наблюдения один", async () => {
    // long-формат кладёт по строке на каждую шкалу: если бы код считался
    // на каждую строку заново, файл распался бы на несвязные наблюдения
    const codes = caseColumn(await csv("anonymous", "long.csv"));
    expect(codes.length).toBeGreaterThan(new Set(codes).size);
  });
});

describe("обезличенный профиль", () => {
  test("case_id — необратимый код, а не идентификатор прохождения", async () => {
    const text = await csv("deidentified");
    for (const id of responseIds) expect(text).not.toContain(id);

    const codes = caseColumn(text);
    expect(codes[0]).toMatch(/^C[0-9A-F]{10}$/);

    const probe = await api(`/api/reports/responses/${encodeURIComponent(codes[0]!)}`, adminA.token);
    expect(probe.status).toBe(404);
  });

  test("код стабилен между выгрузками — дозагрузка волны возможна", async () => {
    /*
     * Здесь стабильность нужна, и в этом вся разница между профилями:
     * обезличенный датасет дополняют новой волной и склеивают по коду.
     */
    const first = caseColumn(await csv("deidentified"));
    const second = caseColumn(await csv("deidentified"));
    expect(second).toEqual(first);
  });

  test("коды считаются секретом выгрузок, а не секретом подписи сессий", async () => {
    /*
     * Ротация JWT_SECRET — штатная реакция на утечку. Пока коды считались
     * на нём, она молча меняла их все: датасеты, собранные до ротации, с
     * новыми выгрузками уже не склеивались, и заметить это можно было
     * только по разъехавшемуся лонгитюду.
     */
    const text = await csv("deidentified");
    const expectedCase = `C${new Bun.CryptoHasher("sha256", env.exportSecret)
      .update(`case:${responseIds[0]}`)
      .digest("hex")
      .slice(0, 10)
      .toUpperCase()}`;
    const expectedSubject = `R${new Bun.CryptoHasher("sha256", env.exportSecret)
      .update(`subject:${subjectId}`)
      .digest("hex")
      .slice(0, 10)
      .toUpperCase()}`;

    expect(text).toContain(expectedCase);
    expect(text).toContain(expectedSubject);
    // и тот же код не получается из секрета подписи
    expect(env.exportSecret).not.toBe(env.jwtSecret);
  });
});

describe("полный профиль", () => {
  test("идентификатор прохождения остаётся настоящим", async () => {
    /*
     * Обратная проверка: выгрузка с именами существует ради возврата к
     * карте, и прятать в ней ключ бессмысленно. Без этой проверки «код
     * везде» прошло бы как исправление.
     */
    const text = await csv("full");
    expect(responseIds.some((id) => text.includes(id))).toBe(true);
  });
});
