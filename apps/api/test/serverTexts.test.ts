import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { appointments, decisionRules, departments, ruleHits, slots, specialistProfiles } from "../src/db/schema";
import { adminA, api, app, db, makeUser, root, submitSurvey, surveyInA } from "./fixtures";

/**
 * Тексты, которые собирает сервер, — на языке запроса (волна 13, srv-i18n).
 *
 * Проблемы методики, сообщения схем, объяснения правил, печатные листы,
 * подписи выгрузки SPSS и вывод консоли были русскими при любом языке
 * интерфейса: фразы набирались прямо в модулях. Здесь проверяется сквозной
 * путь — что маршрут берёт язык запроса и что хранимое объяснение правила
 * становится текстом при отдаче, а старое показывается как было. Полнота
 * самого словаря — packages/shared/test/serverStrings.test.ts, литералы в
 * модулях — noRawStrings.test.ts.
 */

const ask = (path: string, token: string, lang: string, init: RequestInit = {}) =>
  api(path, token, { ...init, headers: { "Accept-Language": lang, ...(init.headers as object) } });

/** Ответ не-JSON (HTML, CSV, скрипт) на заданном языке */
async function page(path: string, token: string, lang: string) {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${token}`, "Accept-Language": lang } });
  return { status: res.status, text: (await res.text()).replace(/^﻿/, "") };
}

const draft = (over: Record<string, unknown> = {}) => ({
  title: { uk: "Перевірка мови", ru: "Проверка языка" },
  questions: [
    {
      type: "yesno",
      title: { uk: "Пункт", ru: "Пункт" },
      options: [
        { text: { uk: "Так", ru: "Да" }, keyCode: "yes" },
        { text: { uk: "Ні", ru: "Нет" }, keyCode: "no" },
      ],
    },
  ],
  scales: [
    {
      code: "S",
      title: { uk: "Шкала", ru: "Шкала" },
      key: [{ item: 7, matchKey: "yes" }],
      bands: [{ minScore: 0, maxScore: 1, label: { uk: "Норма", ru: "Норма" }, severity: "none" }],
    },
  ],
  ...over,
});

describe("конструктор: проблемы методики и сообщения схемы", () => {
  test("проблемы — на языке конструктора, код — один на всех", async () => {
    const body = JSON.stringify(draft());
    const pick = async (lang: string) => {
      const res = await ask("/api/surveys/validate", adminA.token, lang, { method: "POST", body });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body.issues as { code: string; where: string; message: string }[]).find(
        (i) => i.code === "val.keyItemOutOfRange",
      )!;
    };
    expect(await pick("uk")).toMatchObject({ where: "Шкала S", message: "У ключі пункт 7, а в методиці їх 1" });
    expect(await pick("ru")).toMatchObject({ where: "Шкала S", message: "В ключе пункт 7, а в методике их 1" });
    expect(await pick("en")).toMatchObject({ where: "Scale S", message: "The key refers to item 7, but the assessment has 1" });
  });

  test("сообщение схемы — переводом, с тем же путём поля", async () => {
    /*
     * Прежде это было «questions.0.options: Нужно минимум 2 варианта
     * ответа» на любом экране. Русский остался прежним дословно.
     */
    const body = JSON.stringify(
      draft({
        scales: [],
        questions: [{ type: "single", title: { uk: "П", ru: "П" }, options: [{ text: { uk: "А", ru: "А" } }] }],
      }),
    );
    const error = async (lang: string) => {
      const res = await ask("/api/surveys/validate", adminA.token, lang, { method: "POST", body });
      expect(res.status).toBe(400);
      return res.body.error as string;
    };
    expect(await error("ru")).toBe("questions.0.options: Нужно минимум 2 варианта ответа");
    expect(await error("uk")).toBe("questions.0.options: Потрібно щонайменше 2 варіанти відповіді");
    expect(await error("en")).toBe("questions.0.options: At least 2 answer options are needed");
  });

  test("подробность разбора не уходит единственным текстом", async () => {
    // zod пишет «Required» по-английски; впереди — человеческое «не прошёл проверку» на языке экрана
    const res = await ask("/api/surveys/validate", adminA.token, "uk", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(res.body.error).toStartWith("Запит не пройшов перевірку: ");
    expect(res.body.error).toContain("title");
    const en = await ask("/api/surveys/validate", adminA.token, "en", { method: "POST", body: JSON.stringify({}) });
    expect(en.body.error).toStartWith("The request didn’t pass validation: ");
  });
});

describe("объяснение правила: хранится кодом, читается на своём языке", () => {
  let ruleId = "";
  const people: string[] = [];

  afterAll(async () => {
    /*
     * Правило действует на все прохождения методики — выключенным оно не
     * даст предложений чужим файлам. Свои срабатывания закрываются: живое
     * «предложено» в общей очереди сбило бы соседей, считающих очередь.
     */
    if (ruleId) await db.update(decisionRules).set({ enabled: false }).where(eq(decisionRules.id, ruleId));
    if (people.length) {
      await db
        .update(ruleHits)
        .set({ status: "declined", decidedAt: new Date().toISOString(), decisionNote: "тест языка" })
        .where(inArray(ruleHits.userId, people));
    }
  });

  test("новое срабатывание — на языке читающего, старое — прежним текстом", async () => {
    const survey = await api(`/api/surveys/${surveyInA}`, adminA.token);
    const scale = survey.body.scales[0].code as string;
    const created = await api("/api/decisions/rules", root.token, {
      method: "POST",
      body: JSON.stringify({
        title: `Язык ${crypto.randomUUID()}`,
        conditions: [{ kind: "scale", surveyId: surveyInA, scaleCode: scale, metric: "raw", op: ">=", value: -1 }],
        actions: [{ kind: "notify_duty" }],
      }),
    });
    expect(created.status).toBe(201);
    ruleId = created.body.id;

    const person = await makeUser("user", `srvi18n-rule-${crypto.randomUUID()}@test`);
    people.push(person.id);
    const submitted = await submitSurvey(surveyInA, person.token);
    expect(submitted.status).toBe(201);
    // правило своё дело сделало — дальше оно чужим файлам не нужно
    await db.update(decisionRules).set({ enabled: false }).where(eq(decisionRules.id, ruleId));

    // в базе — код и числа, без фразы
    const [stored] = await db.select().from(ruleHits).where(eq(ruleHits.ruleId, ruleId));
    const because = (stored!.explanation as { because: Record<string, unknown>[] }).because[0]!;
    expect(because.code).toBe("rule.raw");
    expect(because.text).toBeUndefined();

    const textOf = async (lang: string, hitId: string) => {
      const hits = await ask("/api/decisions/hits", adminA.token, lang);
      const hit = (hits.body.items as { id: string; explanation: { because: { text: string }[] } }[]).find(
        (h) => h.id === hitId,
      );
      return hit!.explanation.because[0]!.text;
    };
    expect(await textOf("uk", stored!.id)).toContain(`${scale}: сирий бал`);
    expect(await textOf("ru", stored!.id)).toContain(`${scale}: сырой балл`);
    expect(await textOf("en", stored!.id)).toContain(`${scale}: raw score`);

    /*
     * Срабатывание, записанное до волны 13: готовая русская фраза. Перевести
     * её не из чего, и переписывать объяснение задним числом нельзя — по
     * нему уже решали.
     */
    const legacyId = crypto.randomUUID();
    await db.insert(ruleHits).values({
      id: legacyId,
      ruleId,
      ruleVersion: 1,
      responseId: submitted.body.id,
      userId: person.id,
      surveyId: surveyInA,
      explanation: { title: "Старое правило", because: [{ met: true, text: "Sr: сырой балл 5 >= 1" }], actions: [] },
    });
    for (const lang of ["uk", "ru", "en"]) expect(await textOf(lang, legacyId)).toBe("Sr: сырой балл 5 >= 1");
  });
});

describe("печатные листы — на языке того, кто открыл", () => {
  test("заключение по прохождению", async () => {
    const person = await makeUser("user", `srvi18n-report-${crypto.randomUUID()}@test`);
    const submitted = await submitSurvey(surveyInA, person.token);
    const path = `/api/reports/responses/${submitted.body.id}`;

    const uk = await page(path, adminA.token, "uk");
    expect(uk.status).toBe(200);
    expect(uk.text).toContain('<html lang="uk">');
    expect(uk.text).toContain("Результати за субшкалами");
    expect(uk.text).toContain("Роздруковано:");

    const ru = await page(path, adminA.token, "ru");
    expect(ru.text).toContain("Результаты по субшкалам");
    expect(ru.text).toContain("Распечатано:");

    const en = await page(path, adminA.token, "en");
    expect(en.text).toContain('<html lang="en">');
    expect(en.text).toContain("Results by subscale");
    expect(en.text).toContain("Printed by");
    // обвязка листа — английская; прежние русские заголовки не просочились
    for (const word of ["Результаты", "Ответы", "Распечатано", "Субшкала"]) expect(en.text).not.toContain(word);
  });

  test("справка о посещении", async () => {
    /*
     * Прежде — только по-украински, набранная прямо в разметке. Украинский
     * текст остался прежним дословно; русский и английский — новые.
     */
    const person = await makeUser("user", `srvi18n-cert-${crypto.randomUUID()}@test`, { unit: "Рота забезпечення" });
    await submitSurvey(surveyInA, person.token);
    const departmentId = crypto.randomUUID();
    await db.insert(departments).values({ id: departmentId, title: { uk: "Відділення", ru: "Отделение" }, timezone: "Europe/Kyiv" });
    await db.insert(specialistProfiles).values({ userId: adminA.id, departmentId }).onConflictDoNothing();
    // своё время далеко впереди: открытые слоты одного специалиста не пересекаются (миграция 0105)
    const start = Date.now() + (400 + Math.floor(Math.random() * 3000)) * 86_400_000;
    const slotId = crypto.randomUUID();
    await db.insert(slots).values({
      id: slotId,
      specialistId: adminA.id,
      departmentId,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 3_600_000).toISOString(),
      kind: "any",
    });
    const appointmentId = crypto.randomUUID();
    await db.insert(appointments).values({
      id: appointmentId,
      slotId,
      patientId: person.id,
      specialistId: adminA.id,
      kind: "primary",
      status: "done",
    });
    const path = `/api/reports/visits/${appointmentId}`;
    const uk = await page(path, adminA.token, "uk");
    expect(uk.status, uk.text).toBe(200);
    expect(uk.text).toContain("Довідка про відвідування");
    expect(uk.text).toContain("він(вона) перебував(ла) на прийомі.");
    expect((await page(path, adminA.token, "ru")).text).toContain("Справка о посещении");
    const en = await page(path, adminA.token, "en");
    expect(en.text).toContain("Certificate of attendance");
    expect(en.text).toContain(", Рота забезпечення to certify that on");
  });

  test("амбулаторная карта", async () => {
    const person = await makeUser("user", `srvi18n-chart-${crypto.randomUUID()}@test`);
    // обследование делает человека «своим» для adminA
    await submitSurvey(surveyInA, person.token);
    const path = `/api/reports/patients/${person.id}/chart`;
    expect((await page(path, adminA.token, "uk")).text).toContain("Амбулаторна карта");
    expect((await page(path, adminA.token, "ru")).text).toContain("Амбулаторная карта");
    const en = await page(path, adminA.token, "en");
    expect(en.status).toBe(200);
    expect(en.text).toContain("Outpatient record");
    expect(en.text).toContain("No episodes of care.");
  });
});

describe("выгрузка SPSS: подписи на языке запроса, имена переменных — прежние", () => {
  const codebook = (lang: string, extra = "") =>
    page(`/api/spss/surveys/${surveyInA}/codebook.csv?profile=deidentified${extra}`, adminA.token, lang);
  const names = (text: string) => text.split(/\r?\n/).map((line) => line.split(";")[0]);

  test("словарь переменных на трёх языках", async () => {
    const uk = await codebook("uk");
    const en = await codebook("en");
    const ru = await codebook("uk", "&lang=ru");
    expect(uk.status).toBe(200);
    expect(uk.text).toContain("sex;F1.0;Стать;1=чоловіча | 2=жіноча");
    expect(en.text).toContain("sex;F1.0;Sex;1=male | 2=female");
    expect(en.text).toContain("age_band;F1.0;Age band;1=under 25 | 2=25–34 | 3=35–44 | 4=45 and over");
    // явный ?lang — и подписи, и содержимое русские, как было
    expect(ru.text).toContain("sex;F1.0;Пол;1=мужской | 2=женский");
    // машинные имена переменных от языка не зависят: по ним склеивают выгрузки
    expect(names(en.text)).toEqual(names(uk.text));
    expect(names(ru.text)).toEqual(names(uk.text));
  });

  test("синтаксис, скрипт загрузки и манифест", async () => {
    const syntax = await page(`/api/spss/surveys/${surveyInA}/syntax.sps`, adminA.token, "en");
    expect(syntax.text).toContain("* Syntax exported from Quizzy:");
    expect(syntax.text).toContain("VARIABLE LABELS");
    const r = await page(`/api/spss/surveys/${surveyInA}/load/r`, adminA.token, "uk");
    expect(r.text).toContain("# Як відкрити вивантаження Quizzy в R.");
    const manifest = await ask(`/api/spss/surveys/${surveyInA}/manifest.json?profile=deidentified`, adminA.token, "en");
    // содержимое у английского интерфейса — украинское (английского текста у методик нет), подписи — английские
    expect(manifest.body.lang).toBe("uk");
    expect(manifest.body.labels).toBe("en");
    expect(manifest.body.freeText.note).toStartWith("Free-text answers and dates are not exported");
  });

  test("?lang=en по-прежнему отвергается: английского содержимого нет", async () => {
    const res = await page(`/api/spss/surveys/${surveyInA}/codebook.csv?lang=en`, adminA.token, "en");
    expect(res.status).toBe(400);
  });
});

describe("командная консоль", () => {
  const run = (line: string, lang: string) =>
    ask("/api/console/run", root.token, lang, { method: "POST", body: JSON.stringify({ line }) });

  test("список команд и вывод — на языке консоли", async () => {
    const list = await ask("/api/console/commands", root.token, "en");
    const summary = (name: string) => (list.body.items as { name: string; summary: string }[]).find((c) => c.name === name)!.summary;
    expect(summary("help")).toBe("List of commands");
    expect(summary("whoami")).toBe("Who you are and what you may do");

    expect((await run("whoami", "en")).body.lines).toContain("account class: superadmin");
    expect((await run("whoami", "uk")).body.lines).toContain("клас облікового запису: superadmin");
  });

  test("ошибка команды — тоже, вместе с подсказкой, как её вызвать", async () => {
    const en = await run("user find", "en");
    expect(en.body.ok).toBe(false);
    expect(en.body.lines).toEqual(["more arguments needed: user find <part of email>"]);
    const uk = await run("user find", "uk");
    expect(uk.body.lines).toEqual(["потрібно більше аргументів: user find <частина пошти>"]);
    expect((await run("ls -la", "en")).body.lines).toEqual(["no such command: ls", "type help"]);
  });
});
