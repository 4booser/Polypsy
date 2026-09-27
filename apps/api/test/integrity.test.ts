import { beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { baseDb } from "../src/db";
import { dbContext } from "../src/db/context";
import { auditLog, conclusions } from "../src/db/schema";
import { AUDIT_HASH_VERSION, auditSystem, chainHash } from "../src/lib/audit";
import { csvCell } from "../src/lib/csv";
import { isUniqueViolation } from "../src/lib/http";
import {
  adminA,
  api,
  app,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  groupAdmins,
  makeUser,
  root,
  sql,
  submitSurvey,
  surveyInA,
  surveys,
  type Person,
} from "./fixtures";

/**
 * Юридическая и доказательная целостность (волна 12, участок integrity).
 *
 * Пункты внешнего разбора кода, по которым документ или журнал мог сказать
 * не то, что было на самом деле: подпись под текстом, которого подписавший
 * не видел; пятисотка вместо конфликта в гонке за номер версии; выгрузка с
 * фамилиями по опечатке в параметре; кривая дата, доезжавшая до базы;
 * удаление человека, способное переписать поле журнала под хэшем.
 *
 * Данные у каждого теста свои — прохождение, пациент, коллега заводятся
 * здесь и ищутся по своим id: сюита гоняет файлы в разном порядке на macOS и
 * в CI (Linux), а база у всех файлов одна.
 */

/** Второй сотрудник той же зоны — «B», который правит, пока «A» читает */
let colleague: Person;
beforeAll(async () => {
  colleague = await makeUser("admin", `integrity-b-${crypto.randomUUID()}@test`);
  await db.insert(groupAdmins).values({ groupId: groupA, userId: colleague.id, addedBy: root.id });
});

/* ── 1. подпись несёт то, что видел подписывающий ── */

describe("заключение: подпись и правка сверяют редакцию текста", () => {
  const url = (rid: string) => `/api/conclusions/responses/${rid}/conclusion`;
  const put = (rid: string, token: string, body: Record<string, unknown>) =>
    api(url(rid), token, { method: "PUT", body: JSON.stringify(body) });
  const sign = (rid: string, token: string, body: Record<string, unknown>) =>
    api(`${url(rid)}/sign`, token, { method: "POST", body: JSON.stringify(body) });

  async function freshResponse() {
    const done = await submitSurvey(surveyInA, (await makeUser("user", `integrity-p-${crypto.randomUUID()}@test`)).token);
    expect(done.status).toBe(201);
    return done.body.id as string;
  }

  test("A открыл, B переписал черновик, A подписывает своей редакцией → 409, подпись не легла", async () => {
    /*
     * Ровно сценарий разбора. Черновик правится на месте, версия у
     * переписанного та же — прежняя сверка по одной версии пропускала
     * подпись A под текстом B.
     */
    const rid = await freshResponse();
    expect((await put(rid, adminA.token, { text: "Текст, который читал A", baseVersion: 0 })).status).toBe(200);

    const seenByA = (await api(url(rid), adminA.token)).body.current;
    expect(seenByA.version).toBe(1);
    expect(seenByA.revision).toBe(1);

    const byB = await put(rid, colleague.token, { text: "Текст B", baseVersion: 1, baseRevision: 1 });
    expect(byB.status).toBe(200);
    expect(byB.body.current.version).toBe(1);
    expect(byB.body.current.revision).toBe(2);

    const blind = await sign(rid, adminA.token, { version: seenByA.version, revision: seenByA.revision });
    expect(blind.status).toBe(409);
    expect(blind.body.error).toContain("Чернетку версії 1 змінили");

    const [row] = await db.select().from(conclusions).where(eq(conclusions.responseId, rid));
    expect(row!.status).toBe("draft");
    expect(row!.signedAt).toBeNull();

    // перечитал — и подписывает то, что теперь видит; редакция уходит в журнал
    const reread = (await api(url(rid), adminA.token)).body.current;
    const signed = await sign(rid, adminA.token, { version: reread.version, revision: reread.revision });
    expect(signed.status).toBe(200);
    expect(signed.body.current.text).toBe("Текст B");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "conclusion.sign"), eq(auditLog.resourceId, rid)));
    expect(entry!.details).toMatchObject({ version: 1, revision: 2 });
  });

  test("правка поверх чужой редакции той же версии — 409, текст B цел", async () => {
    const rid = await freshResponse();
    await put(rid, adminA.token, { text: "Исходный", baseVersion: 0 });
    // оба открыли версию 1, редакцию 1; B сохранил первым
    expect((await put(rid, colleague.token, { text: "Правка B", baseVersion: 1, baseRevision: 1 })).status).toBe(200);

    const stale = await put(rid, adminA.token, { text: "Правка A поверх старого", baseVersion: 1, baseRevision: 1 });
    expect(stale.status).toBe(409);
    expect((await api(url(rid), adminA.token)).body.current.text).toBe("Правка B");
  });

  test("подпись без редакции не принимается: подписать можно только увиденное", async () => {
    const rid = await freshResponse();
    await put(rid, adminA.token, { text: "Без редакции", baseVersion: 0 });
    const res = await sign(rid, adminA.token, { version: 1 });
    expect(res.status).toBe(400);
    expect((await api(url(rid), adminA.token)).body.current.status).toBe("draft");
  });
});

describe("заключение: только по завершённому прохождению", () => {
  test("по черновику прохождения — 409 и на сохранение, и на подпись; строки заключения нет", async () => {
    /*
     * Клиническое ревью, P1: заключение по черновику либо уходило каскадом
     * при сдаче, либо (подписанное) ломало сдачу пятисоткой навсегда.
     */
    const person = await makeUser("user", `integrity-draft-${crypto.randomUUID()}@test`);
    const saved = await api(`/api/surveys/${surveyInA}/draft`, person.token, {
      method: "PUT",
      body: JSON.stringify({ answers: [], startedAt: new Date().toISOString(), durationMs: 1000 }),
    });
    expect(saved.status).toBe(200);
    const draftId = (await api(`/api/surveys/${surveyInA}/draft`, person.token)).body.id as string;
    expect(draftId).toBeTruthy();

    const put = await api(`/api/conclusions/responses/${draftId}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "По черновику", baseVersion: 0 }),
    });
    expect(put.status).toBe(409);
    expect(put.body.error).toContain("не завершене");
    const sign = await api(`/api/conclusions/responses/${draftId}/conclusion/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1, revision: 1 }),
    });
    expect(sign.status).toBe(409);
    expect(await db.select().from(conclusions).where(eq(conclusions.responseId, draftId))).toEqual([]);

    // и сдача после этого проходит — ей нечему мешать
    expect((await submitSurvey(surveyInA, person.token)).status).toBe(201);
  });
});

describe("заметка приёма: подпись и правка сверяют редакцию текста", () => {
  /** Пациент в зоне группы А — прохождение методики группы */
  async function patientInA() {
    const person = await makeUser("user", `integrity-note-${crypto.randomUUID()}@test`);
    expect((await submitSurvey(surveyInA, person.token)).status).toBe(201);
    return person;
  }
  const url = (userId: string) => `/api/notes/patients/${userId}`;
  const put = (userId: string, token: string, body: Record<string, unknown>) =>
    api(url(userId), token, { method: "PUT", body: JSON.stringify(body) });

  test("A открыл, B переписал черновик, A подписывает своей редакцией → 409, подпись не легла", async () => {
    const person = await patientInA();
    await put(person.id, adminA.token, { text: "Запись A", baseVersion: 0 });
    const seenByA = (await api(url(person.id), adminA.token)).body.current;
    expect(seenByA.revision).toBe(1);

    const byB = await put(person.id, colleague.token, { text: "Запись B", baseVersion: 1, baseRevision: 1 });
    expect(byB.body.current.revision).toBe(2);

    const blind = await api(`${url(person.id)}/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: seenByA.version, revision: seenByA.revision }),
    });
    expect(blind.status).toBe(409);
    expect(blind.body.error).toContain("змінили");
    expect((await api(url(person.id), adminA.token)).body.current.status).toBe("draft");

    // правка A поверх старой редакции тоже не проходит
    const stale = await put(person.id, adminA.token, { text: "Запись A поверх", baseVersion: 1, baseRevision: 1 });
    expect(stale.status).toBe(409);
    expect((await api(url(person.id), adminA.token)).body.current.text).toBe("Запись B");

    const ok = await api(`${url(person.id)}/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1, revision: 2 }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.current.status).toBe("signed");
  });
});

/* ── 2. гонка за номер версии — конфликт, а не 500 ── */

describe("заключение: одновременные правки не дают пятисотки", () => {
  test("шесть сохранений поверх подписанной версии: одна новая версия, остальные — 409", async () => {
    const person = await makeUser("user", `integrity-race-${crypto.randomUUID()}@test`);
    const rid = (await submitSurvey(surveyInA, person.token)).body.id as string;
    const url = `/api/conclusions/responses/${rid}/conclusion`;
    await api(url, adminA.token, { method: "PUT", body: JSON.stringify({ text: "v1", baseVersion: 0 }) });
    await api(`${url}/sign`, adminA.token, { method: "POST", body: JSON.stringify({ version: 1, revision: 1 }) });

    /*
     * Все шесть видели подписанную v1 и создают v2. Без блокировки двое
     * посчитали бы следующей одну и ту же v2 и упёрлись бы в уникальный
     * индекс — пятисоткой. С блокировкой первый создаёт v2, остальные видят,
     * что база ушла вперёд.
     */
    const racing = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api(url, i % 2 ? adminA.token : colleague.token, {
          method: "PUT",
          body: JSON.stringify({ text: `Параллельно ${i}`, baseVersion: 1, baseRevision: 1 }),
        }),
      ),
    );
    const codes = racing.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    expect(racing.filter((r) => r.status === 409).every((r) => typeof r.body.error === "string")).toBe(true);

    // без базовой версии (старый клиент) — «последний победил», но по очереди и без потерянных ревизий
    const blind = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api(url, adminA.token, { method: "PUT", body: JSON.stringify({ text: `Вслепую ${i}` }) }),
      ),
    );
    expect(blind.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);

    const state = await api(url, adminA.token);
    expect(state.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    // v2 родилась с ревизией 1 и шесть раз переписана на месте — ни одна правка не потерялась
    expect(state.body.current.revision).toBe(7);
  }, 20_000);

  test("уникальный индекс версии распознаётся как конфликт, а не как внутренняя ошибка", async () => {
    /*
     * Вторая линия обороны маршрута (isUniqueViolation) должна узнавать
     * настоящую ошибку драйвера, а не выдуманный объект: код Postgres у
     * drizzle бывает и в самой ошибке, и в cause.
     */
    const person = await makeUser("user", `integrity-uniq-${crypto.randomUUID()}@test`);
    const rid = (await submitSurvey(surveyInA, person.token)).body.id as string;
    await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Единственная v1", baseVersion: 0 }),
    });
    const [existing] = await db.select().from(conclusions).where(eq(conclusions.responseId, rid)).orderBy(desc(conclusions.version));
    let caught: unknown = null;
    try {
      await db.insert(conclusions).values({
        id: crypto.randomUUID(),
        responseId: rid,
        version: existing!.version,
        text: "дубль",
        createdBy: adminA.id,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });
});

/* ── 3. выгрузка: с именами — только по явному слову ── */

describe("выгрузки: кривой параметр — отказ, умолчание — обезличено", () => {
  let subject: Person;
  beforeAll(async () => {
    subject = await makeUser("user", `integrity-exp-${crypto.randomUUID()}@test`, { unit: "Рота Ц" });
    expect((await submitSurvey(surveyInA, subject.token)).status).toBe(201);
  });
  const get = (path: string) => app.request(path, { headers: { Authorization: `Bearer ${root.token}` } });

  test("SPSS без профиля — обезличенная: ни идентификатора, ни подразделения", async () => {
    /*
     * До волны 12 умолчанием был «full»: забытый параметр уносил файл с
     * идентификаторами и подразделениями тому, у кого есть export.full.
     */
    const res = await get(`/api/spss/surveys/${surveyInA}/data.csv`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const head = text.replace(/^﻿/, "").split("\r\n")[0]!;
    expect(head).toContain("subject");
    expect(head).not.toContain("unit");
    expect(text).not.toContain(subject.id);
    expect(text).not.toContain("Рота Ц");

    const manifest = await api(`/api/spss/surveys/${surveyInA}/manifest.json`, root.token);
    expect(manifest.body.profile).toBe("deidentified");
  });

  test("опечатка в имени или значении параметра — 400, а не «как обычно»", async () => {
    for (const bad of ["?profil=deidentified", "?Profile=deidentified", "?profile=FULL", "?profile=deidentifed", "?anonymize=1"]) {
      const res = await get(`/api/spss/surveys/${surveyInA}/data.csv${bad}`);
      expect(res.status, bad).toBe(400);
    }
    // с именами — по слову «full», сказанному явно
    const full = await get(`/api/spss/surveys/${surveyInA}/data.csv?profile=full`);
    expect(full.status).toBe(200);
    expect(await full.text()).toContain(subject.id);
  });

  test("сырая выгрузка аналитики не делает вид, что обезличивает", async () => {
    /*
     * Параметров она не читала, и `?profile=deidentified` молча отдавал
     * файл с user_id. Обезличенной она не бывает — значит, отказ.
     */
    for (const bad of ["?profile=deidentified", "?profile=anonymous", "?deidentified=1"]) {
      const res = await get(`/api/analytics/surveys/${surveyInA}/export${bad}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await get(`/api/analytics/surveys/${surveyInA}/export`)).status).toBe(200);
    expect((await get(`/api/analytics/surveys/${surveyInA}/export?profile=full`)).status).toBe(200);
  });
});

/* ── 3б. формулы в CSV: ответ обследуемого не исполняется у аналитика ── */

describe("выгрузки: ячейка-формула нейтрализуется, числа остаются числами", () => {
  test("помощник ячейки: формулы — с апострофом, числа — как есть", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("+380")).toBe("'+380");
    expect(csvCell("\tскрыто")).toBe("'\tскрыто");
    expect(csvCell('=HYPERLINK("http://x";"y")')).toBe(`"'=HYPERLINK(""http://x"";""y"")"`);
    // балл и код пропуска — числа: апостроф сделал бы колонку строковой
    expect(csvCell("-3")).toBe("-3");
    expect(csvCell("-99")).toBe("-99");
    expect(csvCell("-0.25")).toBe("-0.25");
    expect(csvCell(-7)).toBe("-7");
    // выражение числом не является
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell("обычный текст, с запятой")).toBe('"обычный текст, с запятой"');
    expect(csvCell(null)).toBe("");
  });

  test("свободный ответ «=1+1» уходит в SPSS и сырую выгрузку текстом, а не формулой", async () => {
    const surveyId = crypto.randomUUID();
    const draft = createSurveySchema.parse({
      title: { uk: "Методика з вільною відповіддю" },
      groupId: groupA,
      administration: "self",
      scoringEnabled: true,
      allowRetake: true,
      visibility: "public",
      scales: [
        {
          code: "neg",
          title: { uk: "Шкала з від’ємними балами" },
          aggregation: "sum",
          bands: [{ minScore: -5, maxScore: 5, label: { uk: "Будь-яка" }, severity: "none" }],
        },
      ],
      questions: [
        {
          type: "single",
          title: { uk: "Як ви?" },
          scaleCode: "neg",
          required: true,
          options: [
            { text: { uk: "Гірше" }, score: -3 },
            { text: { uk: "Так само" }, score: 0 },
          ],
        },
        { type: "text", title: { uk: "Коментар" }, options: [] },
      ],
    });
    await db.insert(surveys).values({
      id: surveyId,
      groupId: groupA,
      title: draft.title,
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(surveyId, draft, adminA.id, "Перша версія");

    const person = await makeUser("user", `integrity-csv-${crypto.randomUUID()}@test`);
    const full = (await api(`/api/surveys/${surveyId}`, person.token)).body;
    const choice = full.questions.find((q: { type: string }) => q.type === "single");
    const text = full.questions.find((q: { type: string }) => q.type === "text");
    const submitted = await api(`/api/surveys/${surveyId}/responses`, person.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: [
          { questionId: choice.id, optionIds: [choice.options[0].id], durationMs: 1000, changeCount: 0, visitCount: 1 },
          { questionId: text.id, text: "=1+1", durationMs: 1000, changeCount: 0, visitCount: 1 },
        ],
      }),
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

    const read = async (path: string) => {
      const res = await app.request(path, { headers: { Authorization: `Bearer ${root.token}` } });
      expect(res.status, path).toBe(200);
      return res.text();
    };

    const spss = await read(`/api/spss/surveys/${surveyId}/data.csv?profile=full`);
    expect(spss).toContain("'=1+1");
    expect(spss).not.toMatch(/(^|,)=1\+1/m);
    // возраст неизвестен — код пропуска -99 остаётся числом
    expect(spss).toMatch(/(^|,)-99(,|\r?$)/m);
    expect(spss).not.toContain("'-99");

    const raw = await read(`/api/analytics/surveys/${surveyId}/export`);
    expect(raw).toContain("'=1+1");
    expect(raw).not.toMatch(/(^|,)=1\+1/m);

    // балл шкалы отрицательный и в длинном формате остаётся числом
    const long = await read(`/api/spss/surveys/${surveyId}/long.csv?profile=full`);
    expect(long).toMatch(/(^|,)-3(,|\r?$)/m);
    expect(long).not.toContain("'-3");
  }, 30_000);
});

/* ── 3в. выгрузка SPSS: свободный ввод не обезличивается, выбор — не теряется ── */

describe("SPSS: переменные по типу вопроса, свободный ввод — только в полной", () => {
  const PII = "Мене звати Петренко Іван, телефон 0501234567";
  let surveyId: string;
  let person: Person;

  beforeAll(async () => {
    surveyId = crypto.randomUUID();
    const draft = createSurveySchema.parse({
      title: { uk: "Методика всіх типів" },
      groupId: groupA,
      administration: "self",
      scoringEnabled: false,
      allowRetake: true,
      visibility: "public",
      scales: [],
      questions: [
        {
          type: "single",
          title: { uk: "Один" },
          options: [{ text: { uk: "Так" } }, { text: { uk: "Ні" } }],
        },
        {
          type: "multiple",
          title: { uk: "Кілька" },
          options: [{ text: { uk: "Шум" } }, { text: { uk: "Думки" } }, { text: { uk: "Біль" } }],
        },
        {
          type: "matrix",
          title: { uk: "Матриця" },
          options: [
            { text: { uk: "Ранок" }, kind: "row" },
            { text: { uk: "Вечір" }, kind: "row" },
            { text: { uk: "Погано" } },
            { text: { uk: "Добре" } },
          ],
        },
        {
          type: "ranking",
          title: { uk: "Порядок" },
          options: [{ text: { uk: "А" } }, { text: { uk: "Б" } }, { text: { uk: "В" } }],
        },
        { type: "text", title: { uk: "Про себе" }, options: [] },
        { type: "date", title: { uk: "Дата" }, options: [] },
      ],
    });
    await db.insert(surveys).values({
      id: surveyId,
      groupId: groupA,
      title: draft.title,
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: false,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(surveyId, draft, adminA.id, "Перша версія");

    person = await makeUser("user", `integrity-types-${crypto.randomUUID()}@test`);
    const full = (await api(`/api/surveys/${surveyId}`, person.token)).body;
    const q = (title: string) => full.questions.find((x: { title: string }) => x.title === title);
    const opt = (question: { options: { id: string; text: string }[] }, text: string) =>
      question.options.find((o) => o.text === text)!.id;
    const [one, many, grid, rank, about, when] = ["Один", "Кілька", "Матриця", "Порядок", "Про себе", "Дата"].map(q);
    const meta = { durationMs: 1000, changeCount: 0, visitCount: 1 };
    const res = await api(`/api/surveys/${surveyId}/responses`, person.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: [
          { questionId: one.id, optionIds: [opt(one, "Ні")], ...meta },
          // отмечены два из трёх — оба обязаны дойти до файла
          { questionId: many.id, optionIds: [opt(many, "Шум"), opt(many, "Біль")], ...meta },
          { questionId: grid.id, matrix: { [opt(grid, "Ранок")]: opt(grid, "Добре"), [opt(grid, "Вечір")]: opt(grid, "Погано") }, ...meta },
          { questionId: rank.id, ranking: [opt(rank, "В"), opt(rank, "А"), opt(rank, "Б")], ...meta },
          { questionId: about.id, text: PII, ...meta },
          { questionId: when.id, date: "1990-05-17", ...meta },
        ],
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  const read = async (path: string) => {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${root.token}` } });
    expect(res.status, path).toBe(200);
    return (await res.text()).replace(/^﻿/, "");
  };
  /** Заголовок и единственная строка данных — как словарь «переменная → значение» */
  const table = (csv: string) => {
    const [head, row] = csv.split("\r\n");
    const names = head!.split(",");
    const values = row!.split(",");
    return Object.fromEntries(names.map((n, i) => [n, values[i]]));
  };

  test("имя и телефон из свободного ответа не попадают в обезличенную и анонимную выгрузки", async () => {
    for (const profile of ["deidentified", "anonymous"]) {
      const csv = await read(`/api/spss/surveys/${surveyId}/data.csv?profile=${profile}`);
      expect(csv, profile).not.toContain("Петренко");
      expect(csv, profile).not.toContain("0501234567");
      expect(csv, profile).not.toContain("1990-05-17");
      const row = table(csv);
      // сам пункт исчез, а время ответа на него — осталось: это не содержание
      expect(Object.keys(row)).not.toContain("q5");
      expect(Object.keys(row)).toContain("q5_ms");
    }
    // полная — с правом export.full — отдаёт текст как есть
    const full = await read(`/api/spss/surveys/${surveyId}/data.csv?profile=full`);
    expect(full).toContain("Петренко");
    expect(full).toContain("1990-05-17");

    const manifest = await api(`/api/spss/surveys/${surveyId}/manifest.json?profile=deidentified`, root.token);
    expect(manifest.body.freeText).toMatchObject({ included: false, excludedItems: [5, 6] });

    // в журнале у выгрузки данных — отметка, ушёл ли свободный ввод
    const exports = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "analytics.export"), eq(auditLog.resourceId, surveyId), eq(auditLog.actorId, root.id)));
    const data = exports.map((e) => e.details as { format?: string; profile?: string; freeText?: boolean }).filter((d) => d.format === "spss-data");
    expect(data.find((d) => d.profile === "full")?.freeText).toBe(true);
    expect(data.find((d) => d.profile === "deidentified")?.freeText).toBe(false);
  });

  test("множественный выбор, матрица и ранжирование — колонкой на вариант, строку и место", async () => {
    const row = table(await read(`/api/spss/surveys/${surveyId}/data.csv?profile=deidentified`));
    expect(row.q1).toBe("2"); // «Ні» — второй вариант
    // было: одна колонка q2 с кодом первого отмеченного — «Біль» терялся
    expect([row.q2_1, row.q2_2, row.q2_3]).toEqual(["1", "0", "1"]);
    expect([row.q3_r1, row.q3_r2]).toEqual(["2", "1"]); // ранок — «Добре», вечір — «Погано»
    expect([row.q4_p1, row.q4_p2, row.q4_p3]).toEqual(["3", "1", "2"]); // В, А, Б

    // словарь переменных — в той же форме, что данные
    // подписи — на языке запроса (волна 13): здесь явно русские, как их и сверяют ниже
    const codebook = await read(`/api/spss/surveys/${surveyId}/codebook.csv?profile=deidentified&lang=ru`);
    expect(codebook).toContain("q2_3;F1.0;2. Кілька: Біль;0=не выбрано | 1=выбрано");
    expect(codebook).toContain("q3_r2;F3.0;3. Матриця: Вечір;1=Погано | 2=Добре");
    expect(codebook).toContain("q4_p1;F3.0;4. Порядок: место 1;1=А | 2=Б | 3=В");
    expect(codebook).not.toMatch(/^q5;/m);
  });
});

/* ── 3г. SPSS: прежняя версия методики не превращается в пропуски; «T-балл» — только нормированный ── */

describe("SPSS: версии методики и нормировка", () => {
  const content = (title: string) =>
    createSurveySchema.parse({
      title: { uk: title },
      groupId: groupA,
      administration: "self",
      scoringEnabled: true,
      allowRetake: true,
      visibility: "public",
      scales: [
        {
          code: "anx",
          title: { uk: "Тривога" },
          aggregation: "sum",
          // T-балл без норм: для этого человека нормировка не применится
          normalization: "tscore",
          bands: [{ minScore: 0, maxScore: 100, label: { uk: "Будь-яка" }, severity: "none" }],
        },
      ],
      questions: [
        {
          type: "single",
          title: { uk: "Хвилювання" },
          scaleCode: "anx",
          required: true,
          options: [
            { text: { uk: "Ні" }, score: 0 },
            { text: { uk: "Іноді" }, score: 2 },
            { text: { uk: "Часто" }, score: 3 },
          ],
        },
      ],
    });

  test("прохождение первой версии после выхода второй выгружается своими ответами, а не -99", async () => {
    const surveyId = crypto.randomUUID();
    const v1 = content("Версійна методика");
    await db.insert(surveys).values({
      id: surveyId,
      groupId: groupA,
      title: v1.title,
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(surveyId, v1, adminA.id, "Перша версія");

    const person = await makeUser("user", `integrity-ver-${crypto.randomUUID()}@test`);
    const answerWith = async (optionText: string) => {
      const full = (await api(`/api/surveys/${surveyId}`, person.token)).body;
      const q = full.questions[0];
      const opt = q.options.find((o: { text: string }) => o.text === optionText).id;
      const res = await api(`/api/surveys/${surveyId}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers: [{ questionId: q.id, optionIds: [opt], durationMs: 1000, changeCount: 0, visitCount: 1 }],
        }),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    };

    await answerWith("Іноді"); // версия 1: код 2, балл 2
    // вторая версия — новые строки вопросов, вариантов и шкал с новыми id
    await createVersion(surveyId, content("Версійна методика, редакція 2"), adminA.id, "Друга версія");
    await answerWith("Часто"); // версия 2: код 3, балл 3

    const res = await app.request(`/api/spss/surveys/${surveyId}/data.csv?profile=deidentified`, {
      headers: { Authorization: `Bearer ${root.token}` },
    });
    const [head, ...lines] = (await res.text()).replace(/^﻿/, "").split("\r\n");
    const names = head!.split(",");
    const rows = lines.map((l) => Object.fromEntries(names.map((n, i) => [n, l.split(",")[i]])));
    const byVersion = new Map(rows.map((r) => [r.version, r]));

    expect([...byVersion.keys()].sort()).toEqual(["1", "2"]);
    expect(byVersion.get("1")).toMatchObject({ q1: "2", anx: "2" });
    expect(byVersion.get("2")).toMatchObject({ q1: "3", anx: "3" });

    // норм нет — «T-балл» пуст (-99), признак нормировки 0, сырой балл на месте
    expect(byVersion.get("1")).toMatchObject({ anx_n: "-99", anx_nf: "0" });

    const long = await app.request(`/api/spss/surveys/${surveyId}/long.csv?profile=deidentified`, {
      headers: { Authorization: `Bearer ${root.token}` },
    });
    const [lhead, ...llines] = (await long.text()).replace(/^﻿/, "").split("\r\n");
    const lnames = lhead!.split(",");
    const lrows = llines.map((l) => Object.fromEntries(lnames.map((n, i) => [n, l.split(",")[i]])));
    expect(lrows.length).toBe(2);
    for (const r of lrows) {
      // сырой балл не выдаётся за T-балл: value пуст, признак 0
      expect(r).toMatchObject({ scale: "anx", normalization: "tscore", value: "", normalized: "0" });
      expect(["2", "3"]).toContain(String(r.raw_score));
    }
  }, 30_000);
});

/* ── 4. кривая дата — 400 с ключом, а не 500 из базы ── */

describe("даты снаружи до базы кривыми не доходят", () => {
  const BAD = ["вчора", "0000-01-01", "2026-02-31", "2026-13-01", "2026-01-01T25:00:00Z"];

  test("все документированные GET с датами в параметрах отвечают без 500", async () => {
    /*
     * Обход по реестру маршрутов, как в platform.test.ts («ни один GET не
     * падает пятисоткой»), но с кривыми датами под всеми именами, которыми
     * маршруты их принимают. До волны 12 здесь падали пятисоткой:
     * /api/conclusions/batch, /api/missed, /api/clinic/slots, /api/clinic/today
     * на любой кривой строке; журнал, «хто переглядав», аналитика методики и
     * список прохождений — на нулевом годе.
     */
    const { ROUTE_DOCS } = await import("../src/lib/openapi");
    const person = await makeUser("user", `integrity-dates-${crypto.randomUUID()}@test`);
    const done = await submitSurvey(surveyInA, person.token);
    const subst: Record<string, string> = {
      ":id": surveyInA,
      ":surveyId": surveyInA,
      ":userId": person.id,
      ":responseId": done.body.id,
    };
    const names = ["from", "to", "date", "since", "until", "day", "before", "after"];
    const failures: string[] = [];
    for (const key of Object.keys(ROUTE_DOCS)) {
      const [method, raw] = key.split(" ") as [string, string];
      if (method !== "GET") continue;
      const path = raw.replace(/:[a-zA-Z]+/g, (p) => subst[p] ?? crypto.randomUUID());
      for (const bad of BAD) {
        const qs = names.map((n) => `${n}=${encodeURIComponent(bad)}`).join("&");
        const res = await app.request(`${path}?${qs}&patientId=${person.id}`, {
          headers: { Authorization: `Bearer ${root.token}` },
        });
        if (res.status >= 500) failures.push(`${key} [${bad}] → ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  test("тела с датами: 400 с именем поля, ни одной пятисотки", async () => {
    const pg = await api("/api/patient-groups", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: `integrity ${crypto.randomUUID()}` }),
    });
    const person = await makeUser("user", `integrity-dbody-${crypto.randomUUID()}@test`);
    const cases: [string, string, string, (bad: string) => unknown, string][] = [
      ["POST", `/api/access/surveys/${surveyInA}/grants`, root.token, (b) => ({ userId: person.id, expiresAt: b }), "expiresAt"],
      ["PUT", "/api/auth/me/workspace", root.token, (b) => ({ eventsSeenAt: b }), "eventsSeenAt"],
      ["POST", "/api/survey-folders", root.token, (b) => ({ groupId: groupA, title: "integrity", startsOn: b }), "startsOn"],
      ["POST", "/api/filter-presets", root.token, (b) => ({ title: "integrity", criteria: { from: b } }), "criteria.from"],
      ["POST", "/api/cohorts/preview", root.token, (b) => ({ from: b }), "from"],
      ["POST", `/api/patient-groups/${pg.body.id}/surveys`, adminA.token, (b) => ({ surveyId: surveyInA, expiresAt: b }), "expiresAt"],
      ["POST", "/api/clinic/schedule/exceptions", root.token, (b) => ({ date: b, kind: "off" }), "date"],
      // сдача и черновик: метка начала уходила в responses.started_at как есть
      ["POST", `/api/surveys/${surveyInA}/responses`, person.token, (b) => ({ answers: [], startedAt: b, durationMs: 1000 }), "startedAt"],
      ["PUT", `/api/surveys/${surveyInA}/draft`, person.token, (b) => ({ answers: [], startedAt: b, durationMs: 0 }), "startedAt"],
    ];
    const failures: string[] = [];
    for (const [method, path, token, make, field] of cases) {
      for (const bad of BAD) {
        const res = await api(path, token, { method, body: JSON.stringify(make(bad)) });
        if (res.status !== 400) failures.push(`${method} ${path} [${bad}] → ${res.status}`);
        // отказ переводимый и называет поле — его читает человек, а не только разработчик
        else if (!String(res.body.error).includes(`«${field}»`)) failures.push(`${method} ${path} [${bad}]: ${res.body.error}`);
      }
    }
    expect(failures).toEqual([]);
  }, 30_000);

  test("обслуживание: момент конца с нулевым годом — 400, а не 500", async () => {
    // datetime() zod год ноль пропускает; колонка timestamptz — нет
    const res = await api("/api/ops/maint/status", root.token, {
      method: "POST",
      body: JSON.stringify({ status: "degraded", expectedEnd: "0000-01-01T00:00:00Z" }),
    });
    expect(res.status).toBe(400);
  });

  test("законные даты проходят: день и момент со смещением у полуночи", async () => {
    // прежний queryDate отвергал «23:00 −05:00» — по Гринвичу это уже следующий день
    for (const ok of ["2026-09-01", "2026-01-01T23:00:00-05:00", "2026-09-26T10:00:00.000Z"]) {
      const res = await api(`/api/audit?from=${encodeURIComponent(ok)}&limit=1`, root.token);
      expect(res.status, ok).toBe(200);
    }
  });
});

/* ── 5. удаление человека не трогает полей под хэшем журнала ── */

describe("журнал: удаление пользователя не рвёт цепочку", () => {
  test("ни один внешний ключ журнала не переписывает строку при удалении", async () => {
    /*
     * Под хэшем строки — actor_id и subject_user_id (lib/audit.ts,
     * canonical). SET NULL или CASCADE на любом из них переписали бы (или
     * удалили) уже записанную строку и порвали цепочку у всех последующих.
     * Допустимы только RESTRICT и NO ACTION — «удалить нельзя», — либо
     * отсутствие ключа вовсе (subject_user_id: субъект переживает учётку).
     */
    const rows = await db.execute<{ column: string; action: string }>(sql`
      select a.attname as column, c.confdeltype as action
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f' and c.conrelid = 'audit_log'::regclass
    `);
    const rewriting = [...rows].filter((r) => !["r", "a"].includes(String(r.action)));
    expect(rewriting).toEqual([]);
  });

  test("удалили учётку без следа — цепочка зелёная, субъект в прежних строках прежний", async () => {
    const email = `integrity-del-${crypto.randomUUID()}@test.dev`;
    const created = await api("/api/users", root.token, {
      method: "POST",
      body: JSON.stringify({ email, password: "secret12345", firstName: "Удаляемый", lastName: "Тест", role: "admin" }),
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const [before] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.create"), eq(auditLog.subjectUserId, id)));
    expect(before).toBeTruthy();

    expect((await api(`/api/ops/users/${id}`, root.token, { method: "DELETE" })).status).toBe(200);

    const [after] = await db.select().from(auditLog).where(eq(auditLog.id, before!.id));
    expect(after!.subjectUserId).toBe(id);
    expect(after!.entryHash).toBe(before!.entryHash);

    const { verifyChain } = await import("../src/lib/auditVerify");
    const report = await verifyChain();
    expect(report.ok).toBe(true);
    expect(report.brokenAtSeq).toBeNull();
  }, 30_000);

  test("действовавший хоть раз не удаляется — и цепочка всё так же зелёная", async () => {
    const email = `integrity-actor-${crypto.randomUUID()}@test.dev`;
    const actor = await makeUser("admin", email);
    // вход — строка журнала от его имени (actor_id = он сам)
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "secret12345" }),
    });
    expect(login.status).toBe(200);
    const [own] = await db.select().from(auditLog).where(eq(auditLog.actorId, actor.id)).limit(1);
    expect(own).toBeTruthy();

    const res = await api(`/api/ops/users/${actor.id}`, root.token, { method: "DELETE" });
    expect(res.status).toBe(409);
    const [still] = await db.select().from(auditLog).where(eq(auditLog.id, own!.id));
    expect(still!.actorId).toBe(actor.id);

    const { verifyChain } = await import("../src/lib/auditVerify");
    expect((await verifyChain()).ok).toBe(true);
  }, 30_000);
});

/* ── 5б. хэш журнала защищает вложенное содержимое details ── */

/** Выполнить в транзакции, которая откатится: подмены в журнале не должны пережить тест */
async function inRolledBack<T>(fn: () => Promise<T>): Promise<T> {
  let out: T | undefined;
  await baseDb
    .transaction(async (tx) => {
      out = await dbContext.run(tx as never, fn);
      throw new Error("rollback");
    })
    .catch((e) => {
      if (String(e).includes("rollback")) return;
      throw e;
    });
  return out as T;
}

describe("журнал: канонизация версии 2 держит вложенное", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    at: "2026-09-26T10:00:00.000Z",
    actorId: null,
    actorEmail: null,
    actorRole: null,
    action: "stat_model.run",
    resourceType: null,
    resourceId: null,
    subjectUserId: null,
    outcome: "success",
    ip: null,
    userAgent: null,
  };

  test("правка вложенного меняет хэш; версия 1 этого не видела", () => {
    /*
     * Воспроизведение из ревью: список ключей верхнего уровня у
     * JSON.stringify фильтрует все уровни, и обе выборки сводились к
     * { "columns": [{}] }.
     */
    const a = { ...base, details: { columns: [{ scale: "A", from: "2026-01-01" }] } };
    const b = { ...base, details: { columns: [{ scale: "B", from: "2026-06-01" }] } };
    expect(chainHash(null, a, 1)).toBe(chainHash(null, b, 1));
    expect(chainHash(null, a, 2)).not.toBe(chainHash(null, b, 2));
    expect(chainHash(null, a)).toBe(chainHash(null, a, AUDIT_HASH_VERSION));
  });

  test("порядок ключей на любом уровне хэша не меняет; метка версии — меняет", () => {
    // jsonb хранит ключи в своём порядке — порядок записи не должен значить ничего
    const one = { ...base, details: { b: 1, a: { d: [{ y: 1, x: 2 }], c: 2 } } };
    const two = { ...base, details: { a: { c: 2, d: [{ x: 2, y: 1 }] }, b: 1 } };
    expect(chainHash(null, one, 2)).toBe(chainHash(null, two, 2));
    // даже для плоских details версия 2 не совпадает с версией 1: подмена колонки версии видна
    const flat = { ...base, details: { a: 1 } };
    expect(chainHash(null, flat, 2)).not.toBe(chainHash(null, flat, 1));
  });

  test("новые строки пишутся версией 2, и вложенное переживает круг через jsonb", async () => {
    const res = await api("/api/cohorts/preview", adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA, scales: [{ code: "Sr", op: ">=", value: 0 }], units: [`Ц-${crypto.randomUUID()}`] }),
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "cohort.preview"), eq(auditLog.actorId, adminA.id)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(row!.hashVersion).toBe(2);
    expect((row!.details as { spec: { scales: unknown[] } }).spec.scales).toHaveLength(1);

    const { verifyChain } = await import("../src/lib/auditVerify");
    expect((await verifyChain()).ok).toBe(true);

    // подмена ВЛОЖЕННОГО поля теперь рвёт цепочку ровно на этой строке
    const report = await inRolledBack(async () => {
      await db.execute(sql`alter table audit_log disable trigger audit_log_immutable`);
      await db.execute(
        sql`update audit_log set details = jsonb_set(details, '{spec,scales,0,value}', '99') where id = ${row!.id}`,
      );
      return verifyChain();
    });
    expect(report.ok).toBe(false);
    expect(report.brokenAtSeq).toBe(row!.seq);
    expect((await verifyChain()).ok).toBe(true);
  }, 30_000);

  test("цепочка из старых строк (версия 1) и новых (версия 2) проверяется зелёной", async () => {
    /*
     * Строки до миграции 0096 посчитаны версией 1, и пересчитать их нельзя —
     * это было бы переписыванием журнала. Здесь такая строка ставится в
     * голову цепочки прежним способом, за ней штатно пишется новая — и
     * проверка обязана сойтись на обеих. Всё в откатываемой транзакции:
     * общая база тестов подменённой головы не увидит.
     */
    const { verifyChain } = await import("../src/lib/auditVerify");
    const outcome = await inRolledBack(async () => {
      const [head] = await db.execute<{ seq: number | null; entry_hash: string | null }>(
        sql`select seq, entry_hash from audit_chain_head()`,
      );
      const legacy = {
        ...base,
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        action: "sec.audit_check",
        details: { nested: { scale: "A" } },
      };
      const legacySeq = (head?.seq ?? 0) + 1;
      await db.insert(auditLog).values({
        ...legacy,
        seq: legacySeq,
        prevHash: head?.entry_hash ?? null,
        entryHash: chainHash(head?.entry_hash ?? null, legacy, 1),
        hashVersion: 1,
      } as never);
      await auditSystem({ action: "sec.audit_check", details: { nested: { scale: "B" } } });
      const [fresh] = await db.select().from(auditLog).where(eq(auditLog.seq, legacySeq + 1));
      const green = await verifyChain();

      /*
       * Честная граница: у строки версии 1 вложенное под хэшем не было и
       * не будет — её подмена цепочку не рвёт. У строки версии 2 — рвёт.
       */
      await db.execute(sql`alter table audit_log disable trigger audit_log_immutable`);
      await db.execute(sql`update audit_log set details = '{"nested":{"scale":"Z"}}'::jsonb where seq = ${legacySeq}`);
      const legacyTampered = await verifyChain();
      await db.execute(sql`update audit_log set details = '{"nested":{"scale":"Z"}}'::jsonb where seq = ${legacySeq + 1}`);
      const freshTampered = await verifyChain();
      return { green, fresh, legacySeq, legacyTampered, freshTampered };
    });

    expect(outcome.fresh!.hashVersion).toBe(2);
    expect(outcome.green.ok).toBe(true);
    expect(outcome.green.headSeq).toBe(outcome.legacySeq + 1);
    expect(outcome.legacyTampered.ok).toBe(true);
    expect(outcome.freshTampered.ok).toBe(false);
    expect(outcome.freshTampered.brokenAtSeq).toBe(outcome.legacySeq + 1);
    // откат вернул всё как было
    expect((await verifyChain()).ok).toBe(true);
  }, 30_000);
});

/* ── 6. дубля /api/audit/storage нет ── */

describe("размеры хранилища: один адрес", () => {
  test("дубль /api/audit/storage не зарегистрирован — 404, а не 500", async () => {
    /*
     * Второй обработчик жил под /api/audit/storage и падал «column reference
     * is ambiguous». Удалён; адрес один — /api/stats/storage.
     */
    expect(app.routes.some((r) => r.path === "/api/audit/storage")).toBe(false);
    expect((await api("/api/audit/storage", root.token)).status).toBe(404);
    expect((await api("/api/stats/storage", root.token)).status).toBe(200);
    expect((await api("/api/stats/storage", adminA.token)).status).toBe(403);
  });
});

/* ── 7. сквозной номер запроса доходит до журнала ── */

describe("номер запроса: заголовок ответа и строка журнала", () => {
  test("X-Request-Id изменяющего запроса стоит в подробностях его строки журнала", async () => {
    const mine = `integrity-${crypto.randomUUID()}`;
    const person = await makeUser("user", `integrity-rid-${crypto.randomUUID()}@test`);
    const rid = (await submitSurvey(surveyInA, person.token)).body.id as string;
    const res = await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token, {
      method: "PUT",
      headers: { "x-request-id": mine },
      body: JSON.stringify({ text: "С номером запроса", baseVersion: 0 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe(mine);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "conclusion.save"), eq(auditLog.resourceId, rid)));
    expect((entry!.details as { requestId?: string }).requestId).toBe(mine);
  });

  test("отказ несёт тот же номер, что и заголовок", async () => {
    const res = await api("/api/conclusions/batch?from=вчора", adminA.token, {
      headers: { "x-request-id": "integrity-deny-1" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("x-request-id")).toBe("integrity-deny-1");
    expect(res.body.requestId).toBe("integrity-deny-1");
  });
});
