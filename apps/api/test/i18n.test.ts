import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { renderPush } from "@quizzy/shared";
import { consentTexts, pushTokens } from "../src/db/schema";
import { pushToUser, setPushSenderForTests } from "../src/lib/push";
import {
  adminA,
  api,
  batteries,
  batteryItems,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  makeUser,
  responsesTable,
  root,
  sr45,
  surveyInA,
  surveys,
} from "./fixtures";

/**
 * Третий язык интерфейса — английский (решение заказчика 2026-09-26).
 *
 * Здесь — то, где язык меняет поведение сервера, а не только текст на
 * экране: как он выбирается из запроса, что при нём отдаётся вместо
 * несуществующего английского текста методик, что записывается в
 * прохождение и на каком языке уходит уведомление. Полнота самих переводов
 * проверяется словарными тестами (errorStrings.test.ts, uiStrings.test.ts).
 */

const CYRILLIC = /[Ѐ-ӿ]/;
const missing = "/api/surveys/00000000-0000-0000-0000-000000000000";
const ask = (path: string, token: string, lang: string, init: RequestInit = {}) =>
  api(path, token, { ...init, headers: { "Accept-Language": lang, ...(init.headers as object) } });

describe("язык запроса", () => {
  test("английский отказ — английский, и не совпадает с двумя прежними", async () => {
    const en = await ask(missing, root.token, "en");
    const uk = await ask(missing, root.token, "uk");
    const ru = await ask(missing, root.token, "ru");
    expect(en.status).toBe(404);
    expect(en.body.error.length).toBeGreaterThan(0);
    expect(en.body.error).not.toMatch(CYRILLIC);
    expect(en.body.error).not.toBe(uk.body.error);
    expect(en.body.error).not.toBe(ru.body.error);
  });

  test("заголовок читается списком: первый язык, который мы умеем", async () => {
    /*
     * Прежде читались две первые буквы, и «en-US,uk» давало украинский
     * только потому, что всё, кроме «ru», им и было. Браузер, открывший
     * печатную форму напрямую, шлёт именно список.
     */
    const en = await ask(missing, root.token, "en");
    expect((await ask(missing, root.token, "en-US,uk;q=0.9")).body.error).toBe(en.body.error);
    const uk = await ask(missing, root.token, "uk");
    expect((await ask(missing, root.token, "uk-UA,en;q=0.8")).body.error).toBe(uk.body.error);
    // вес важнее порядка
    const ru = await ask(missing, root.token, "ru");
    expect((await ask(missing, root.token, "en;q=0.2, ru;q=0.9")).body.error).toBe(ru.body.error);
  });

  test("чужой язык — английский, пустой заголовок — украинский", async () => {
    const en = await ask(missing, root.token, "en");
    const uk = await ask(missing, root.token, "uk");
    expect((await ask(missing, root.token, "de-DE,de;q=0.9")).body.error).toBe(en.body.error);
    expect((await ask(missing, root.token, "")).body.error).toBe(uk.body.error);
  });

  test("?lang перебивает заголовок, и английский он тоже знает", async () => {
    const en = await ask(missing, root.token, "en");
    const viaQuery = await ask(`${missing}?lang=en`, root.token, "uk");
    expect(viaQuery.body.error).toBe(en.body.error);
  });
});

describe("методика при английском интерфейсе", () => {
  test("текст — украинский, и ответ говорит, на каком языке он отдан", async () => {
    /*
     * Английского текста у методик нет намеренно (CONTENT_LANGS): нормы
     * сняты с украинского и русского текста. Отдаётся украинский — первый в
     * цепочке английского, — и contentLang называет его, чтобы экран
     * прохождения мог сказать об этом человеку.
     */
    const en = await ask(`/api/surveys/${surveyInA}`, root.token, "en");
    const uk = await ask(`/api/surveys/${surveyInA}`, root.token, "uk");
    const ru = await ask(`/api/surveys/${surveyInA}`, root.token, "ru");
    expect(en.status).toBe(200);
    expect(en.body.title).toBe(uk.body.title);
    expect(en.body.questions[0].title).toBe(uk.body.questions[0].title);
    expect(en.body.contentLang).toBe("uk");
    expect(uk.body.contentLang).toBe("uk");
    expect(ru.body.contentLang).toBe("ru");
  });

  test("прохождение записывает язык текста, а не интерфейса", async () => {
    /*
     * responses.lang — психометрический фактор: украинская и русская
     * редакции — разные предъявления. «en» здесь означало бы третью
     * редакцию, которой не существует, и раскололо бы выборку украинских
     * прохождений на две.
     */
    const person = await makeUser("user", `i18n-take-${crypto.randomUUID()}@test`, {
      sex: "female",
      birthDate: "1994-05-05",
    });
    const survey = (await ask(`/api/surveys/${surveyInA}`, person.token, "en")).body;
    const answers = survey.questions
      .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && q.options.length)
      .map((q: { id: string; options: { id: string }[] }) => ({
        questionId: q.id,
        optionIds: [q.options[1]?.id ?? q.options[0]!.id],
        durationMs: 2000,
        changeCount: 0,
        visitCount: 1,
      }));
    const out = await ask(`/api/surveys/${surveyInA}/responses`, person.token, "en", {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers,
      }),
    });
    expect(out.status).toBe(201);
    const [row] = await db.select().from(responsesTable).where(eq(responsesTable.id, out.body.id));
    expect(row!.lang).toBe("uk");
  });

  test("названия методик в наборах идут за языком запроса", async () => {
    /*
     * Маршрут наборов держал своё правило — «всё, кроме ?lang=uk, по-русски»
     * — и параметра этого никто не слал: названия приходили русскими на
     * любом интерфейсе, а английский получил бы русский тоже.
     */
    const surveyId = crypto.randomUUID();
    await db.insert(surveys).values({
      id: surveyId,
      groupId: groupA,
      title: { uk: "Методика для мови", ru: "Методика для языка" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(surveyId, createSurveySchema.parse(sr45), adminA.id, "v1");
    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({ id: batteryId, title: "Набір мови", groupId: groupA, createdBy: adminA.id });
    await db.insert(batteryItems).values({ batteryId, surveyId, position: 0, required: true });

    const titleIn = async (lang: string) => {
      const res = await ask("/api/batteries", adminA.token, lang);
      expect(res.status).toBe(200);
      const battery = res.body.items.find((b: { id: string }) => b.id === batteryId);
      return battery.items[0].title as string;
    };
    expect(await titleIn("uk")).toBe("Методика для мови");
    expect(await titleIn("ru")).toBe("Методика для языка");
    expect(await titleIn("en")).toBe("Методика для мови");
  });
});

describe("уведомления на языке устройства", () => {
  const sent: { to: string; title: string; body: string }[] = [];
  beforeAll(() =>
    setPushSenderForTests(async (messages) => {
      sent.push(...messages);
    }),
  );
  afterAll(() => setPushSenderForTests(null));

  test("регистрация запоминает язык из заголовка и обновляет его при повторе", async () => {
    const person = await makeUser("user", `i18n-push-${crypto.randomUUID()}@test`);
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;
    const register = (lang: string) =>
      ask("/api/push/register", person.token, lang, {
        method: "POST",
        body: JSON.stringify({ token, platform: "ios" }),
      });

    expect((await register("en")).status).toBe(200);
    let [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(row!.lang).toBe("en");

    // человек переключил язык — приложение перерегистрирует устройство
    await register("uk");
    [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(row!.lang).toBe("uk");
  });

  test("у каждого устройства — свой язык; без языка — запасной вызывающего", async () => {
    const person = await makeUser("user", `i18n-devices-${crypto.randomUUID()}@test`);
    const phone = `ExponentPushToken[${crypto.randomUUID()}]`;
    const tablet = `ExponentPushToken[${crypto.randomUUID()}]`;
    const old = `ExponentPushToken[${crypto.randomUUID()}]`;
    await db.insert(pushTokens).values([
      { id: crypto.randomUUID(), userId: person.id, token: phone, platform: "ios", lang: "en" },
      { id: crypto.randomUUID(), userId: person.id, token: tablet, platform: "android", lang: "uk" },
      // зарегистрировано до миграции 0087: языка нет
      { id: crypto.randomUUID(), userId: person.id, token: old, platform: "android", lang: null },
    ]);

    sent.length = 0;
    const ok = await pushToUser(
      person.id,
      {
        eventKey: `mailing:${crypto.randomUUID()}`,
        kind: "mailing",
        title: (lang) => renderPush("push.mailingTitle", lang),
        body: (lang) => renderPush("push.mailingBody", lang),
      },
      "ru",
    );
    expect(ok).toBe(true);
    const byToken = new Map(sent.map((m) => [m.to, m.title]));
    expect(byToken.get(phone)).toBe(renderPush("push.mailingTitle", "en"));
    expect(byToken.get(tablet)).toBe(renderPush("push.mailingTitle", "uk"));
    expect(byToken.get(old)).toBe(renderPush("push.mailingTitle", "ru"));
    expect(byToken.get(phone)).not.toMatch(CYRILLIC);
  });

  test("в базу язык вне списка не попадает", async () => {
    const person = await makeUser("user", `i18n-check-${crypto.randomUUID()}@test`);
    let failed = false;
    try {
      await db.insert(pushTokens).values({
        id: crypto.randomUUID(),
        userId: person.id,
        token: `ExponentPushToken[${crypto.randomUUID()}]`,
        platform: "ios",
        lang: "de",
      } as never);
    } catch {
      failed = true;
    }
    expect(failed, "ограничение push_tokens_lang_check пропустило чужой язык").toBe(true);
  });
});

describe("согласие по-английски", () => {
  test("необязательный английский текст отдаётся английскому интерфейсу, без него — украинский", async () => {
    const uk = "Я погоджуюся на обробку даних для обстеження.";
    const ru = "Я согласен на обработку данных для обследования.";
    const en = "I agree to the processing of my data for the assessment.";
    const save = (body: Record<string, string>) =>
      api("/api/consents/text", root.token, { method: "PUT", body: JSON.stringify({ body }) });

    expect((await save({ uk, ru, en: "" })).status).toBe(200);
    // пустое поле формы — «не задан»: ключа en в записи нет вовсе
    const [withoutEn] = await db.select().from(consentTexts).orderBy(desc(consentTexts.version)).limit(1);
    expect(withoutEn!.body).toEqual({ uk, ru });
    expect((await ask("/api/consents/me", root.token, "en")).body.text).toBe(uk);

    // начатый английский короче десяти знаков — отказ, как у двух других
    expect((await save({ uk, ru, en: "Short" })).status).toBe(400);

    expect((await save({ uk, ru, en })).status).toBe(200);
    expect((await ask("/api/consents/me", root.token, "en")).body.text).toBe(en);
    expect((await ask("/api/consents/me", root.token, "uk")).body.text).toBe(uk);
  });
});
