import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, inArray } from "drizzle-orm";
import { noteCode, readNotes, renderError, renderNote, serverText, type Lang } from "@quizzy/shared";
import { batteries, batteryAssignments, batteryItems, surveyAccess, surveyVersions, surveys } from "../src/db/schema";
import { installCatalog } from "../src/lib/catalogInstall";
import { qualityOf } from "../src/lib/psychometrics";
import { checkRls, rlsRefusal } from "../src/lib/rlsGuard";
import { adminA, api, db, eq, groupA, makeUser, root, surveyInA } from "./fixtures";

/**
 * Оставшиеся фразы сервера — на языке запроса (волна 14, srvstrings).
 *
 * Волна 13 перевела печать, выгрузку, консоль и проблемы методики и
 * оставила хвост: заметки версий «Первая версия» и «Импорт из файла»,
 * название копии «(копия)», подписи норм, перечень содержимого в отказе
 * удалить папку или группу, русские подробности отказов (курсор, номер
 * запроса трассы), примечания доступа «Батарея «…»», причина обхода
 * политик строк, признаки небрежного заполнения. Здесь — сквозной путь:
 * маршрут берёт язык запроса, а пометка, которую сервер пишет в базу,
 * хранится кодом и становится фразой при показе. Литералы в модулях
 * держит noRawStrings.test.ts, сам словарь — packages/shared/test/
 * serverStrings.test.ts.
 */

const LANGS: Lang[] = ["uk", "ru", "en"];
const ask = (path: string, token: string, lang: Lang, init: RequestInit = {}) =>
  api(path, token, { ...init, headers: { "Accept-Language": lang, ...(init.headers as object) } });

const tag = crypto.randomUUID().slice(0, 8);

/** Методика, у которой есть что показать: ключ, нормы без пола и мужская, локальная женская */
const draft = (over: Record<string, unknown> = {}) => ({
  groupId: groupA,
  title: { uk: `Мова заміток ${tag}`, ru: `Язык заметок ${tag}` },
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
      normalization: "tscore",
      key: [{ item: 1, matchKey: "yes" }],
      norms: [
        { sex: null, mean: 10, sd: 2, source: "Посібник, 2001" },
        { sex: "male", mean: 11, sd: 3, source: "Посібник, 2001" },
        { sex: "female", mean: 12, sd: 4, source: noteCode("note.localSample", { n: 12, date: "2026-09-01" }) },
      ],
    },
  ],
  ...over,
});

const created: string[] = [];
afterAll(async () => {
  // черновики — свои, по id: в общих очередях их нет, но и лежать без дела им незачем
  if (created.length) await db.update(surveys).set({ archivedAt: new Date().toISOString() }).where(inArray(surveys.id, created));
});

async function createSurvey(over: Record<string, unknown> = {}): Promise<string> {
  const res = await api("/api/surveys", adminA.token, { method: "POST", body: JSON.stringify(draft(over)) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  created.push(res.body.id);
  return res.body.id as string;
}

async function versionNotes(surveyId: string, lang: Lang): Promise<(string | null)[]> {
  const res = await ask(`/api/surveys/${surveyId}/versions`, adminA.token, lang);
  expect(res.status).toBe(200);
  return (res.body.items as { note: string | null }[]).map((v) => v.note);
}

describe("заметка версии — кодом в базе, фразой на языке запроса", () => {
  let surveyId = "";
  beforeAll(async () => {
    surveyId = await createSurvey();
  });

  test("первая версия: в базе код, в истории — на трёх языках", async () => {
    const [row] = await db.select({ note: surveyVersions.note }).from(surveyVersions).where(eq(surveyVersions.surveyId, surveyId));
    expect(row!.note).toBe(noteCode("note.firstVersion"));
    expect(await versionNotes(surveyId, "uk")).toEqual(["Перша версія"]);
    // русский — прежними словами
    expect(await versionNotes(surveyId, "ru")).toEqual(["Первая версия"]);
    expect(await versionNotes(surveyId, "en")).toEqual(["First version"]);
  });

  test("копия: название на обоих языках содержимого, заметка — кодом с названием исходника", async () => {
    const res = await api(`/api/surveys/${surveyId}/duplicate`, adminA.token, { method: "POST" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const copyId = res.body.id as string;
    created.push(copyId);

    const [copy] = await db.select({ title: surveys.title }).from(surveys).where(eq(surveys.id, copyId));
    // английского у содержимого нет намеренно (CONTENT_LANGS); русское — прежнее «(копия)»
    expect(copy!.title).toEqual({ uk: `Мова заміток ${tag} (копія)`, ru: `Язык заметок ${tag} (копия)` });

    expect(await versionNotes(copyId, "ru")).toEqual([`Копия «Мова заміток ${tag}»`]);
    expect(await versionNotes(copyId, "en")).toEqual([`Copy of “Мова заміток ${tag}”`]);
  });

  test("импорт из файла: заметка на языке запроса", async () => {
    const exported = await api(`/api/surveys/${surveyId}/export`, adminA.token);
    expect(exported.status).toBe(200);
    const imported = await api("/api/surveys/import", adminA.token, {
      method: "POST",
      body: JSON.stringify({ ...exported.body, groupId: groupA }),
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const id = (imported.body.id ?? imported.body.survey?.id) as string;
    created.push(id);
    expect(await versionNotes(id, "uk")).toEqual(["Імпорт з файлу"]);
    expect(await versionNotes(id, "ru")).toEqual(["Импорт из файла"]);
    expect(await versionNotes(id, "en")).toEqual(["Imported from a file"]);
  });

  test("человеческая заметка и записанная до кодов — как лежат", async () => {
    const [head] = await db
      .select({ id: surveyVersions.id })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, surveyId))
      .orderBy(desc(surveyVersions.version))
      .limit(1);
    await db.update(surveyVersions).set({ note: "Первая версия" }).where(eq(surveyVersions.id, head!.id));
    for (const lang of LANGS) expect(await versionNotes(surveyId, lang)).toEqual(["Первая версия"]);
    await db.update(surveyVersions).set({ note: "виправлено ключ" }).where(eq(surveyVersions.id, head!.id));
    expect(await versionNotes(surveyId, "en")).toEqual(["виправлено ключ"]);
  });
});

describe("нормы: источник локальной нормы и пол на листе ключей", () => {
  let surveyId = "";
  beforeAll(async () => {
    surveyId = await createSurvey();
  });

  test("источник локальной нормы — фразой на языке выдачи, в сыром виде — кодом", async () => {
    const source = async (lang: Lang, raw = false) => {
      const res = await ask(`/api/surveys/${surveyId}${raw ? "?raw=1" : ""}`, adminA.token, lang);
      expect(res.status).toBe(200);
      const norms = res.body.scales[0].norms as { sex: string | null; source: string | null }[];
      return norms.find((n) => n.sex === "female")!.source;
    };
    expect(await source("uk")).toBe("локальна вибірка, N=12, 2026-09-01");
    expect(await source("ru")).toBe("локальная выборка, N=12, 2026-09-01");
    expect(await source("en")).toBe("local sample, N=12, 2026-09-01");
    // конструктор правит сырой вид и сохраняет его обратно: код не должен превратиться в фразу
    expect(await source("en", true)).toBe(noteCode("note.localSample", { n: 12, date: "2026-09-01" }));
  });

  test("локальная норма не уезжает в файл методики — ни кодом, ни прежней фразой", async () => {
    const legacy = await createSurvey({
      scales: [
        {
          code: "S",
          title: { uk: "Шкала", ru: "Шкала" },
          normalization: "tscore",
          key: [{ item: 1, matchKey: "yes" }],
          norms: [
            { sex: "male", mean: 11, sd: 3, source: "Посібник, 2001" },
            { sex: "female", mean: 12, sd: 4, source: "локальная выборка, N=40, 2026-08" },
          ],
        },
      ],
    });
    for (const id of [surveyId, legacy]) {
      const exported = await api(`/api/surveys/${id}/export`, adminA.token);
      const norms = exported.body.scales[0].norms as { sex: string | null }[];
      expect(norms.map((n) => n.sex).sort()).not.toContain("female");
      expect(norms.some((n) => n.sex === "male")).toBe(true);
    }
  });

  test("лист ключей: пол нормы словом листа на языке запроса", async () => {
    const norms = async (lang: Lang) => {
      const res = await ask(`/api/surveys/${surveyId}/key`, adminA.token, lang);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.scales[0].norms as string;
    };
    // прежде — «любой» и код «male» на любом экране
    expect(await norms("uk")).toContain("будь-яка: M=10, δ=2");
    expect(await norms("uk")).toContain("чол.: M=11, δ=3");
    expect(await norms("ru")).toContain("любой: M=10, δ=2");
    expect(await norms("en")).toContain("any: M=10, δ=2");
    expect(await norms("en")).toContain("male: M=11, δ=3");
  });
});

describe("что мешает удалить папку: перечень — на языке отказа", () => {
  test("папка с методикой: число и слово — одним языком", async () => {
    const folder = await api("/api/survey-folders", adminA.token, {
      method: "POST",
      body: JSON.stringify({ groupId: groupA, title: `Мова ${tag}` }),
    });
    expect(folder.status, JSON.stringify(folder.body)).toBe(201);
    const folderId = folder.body.id as string;
    const surveyId = await createSurvey({ folderId });

    for (const lang of LANGS) {
      const res = await ask(`/api/survey-folders/${folderId}`, adminA.token, lang, { method: "DELETE" });
      expect(res.status).toBe(400);
      const details = serverText("inside.surveys", lang, { n: 1 });
      expect(res.body.error).toBe(renderError("err.surveyFolderNotEmpty", lang, { details }));
    }
    const en = await ask(`/api/survey-folders/${folderId}`, adminA.token, "en", { method: "DELETE" });
    expect(en.body.error).toContain("(assessments: 1)");

    // прибрать за собой: методику — в корень, пустую папку — удалить
    const moved = await api(`/api/surveys/${surveyId}/folder`, adminA.token, { method: "PUT", body: JSON.stringify({ folderId: null }) });
    expect(moved.status).toBe(200);
    expect((await api(`/api/survey-folders/${folderId}`, adminA.token, { method: "DELETE" })).status).toBe(204);
  });
});

describe("проверки параметров маршрутом — отказ целиком на языке запроса", () => {
  /*
   * Прежде — badRequestDetail с русской подробностью: «Запит не пройшов
   * перевірку: group: по человеку группируется только открытая очередь».
   * Теперь — ключ отказа с именем поля, как у сообщений схем.
   */
  test("очередь случаев: группировка по человеку только у открытой", async () => {
    for (const lang of LANGS) {
      const res = await ask("/api/alert-cases?status=all&group=person", adminA.token, lang);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(renderError("err.v.personGroupingOpenOnly", lang, { field: "group" }));
    }
    const ru = await ask("/api/alert-cases?status=all&group=person", adminA.token, "ru");
    // русский — прежняя подробность дословно
    expect(ru.body.error).toBe("group: по человеку группируется только открытая очередь");
  });

  test("битый курсор тревог", async () => {
    const res = await ask("/api/alerts?cursor=garbage", adminA.token, "en");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cursor: the cursor is damaged — start the list again");
  });

  test("номер запроса трассы и окно показателей экранов — техпанель", async () => {
    const trace = await ask("/api/ops/trace/!", root.token, "uk");
    expect(trace.status).toBe(400);
    expect(trace.body.error).toBe(renderError("err.v.requestId", "uk", { field: "requestId" }));
    const vitals = await ask("/api/ops/vitals?days=3", root.token, "en");
    expect(vitals.status).toBe(400);
    expect(vitals.body.error).toBe("days: from 7 to 30");
  });
});

describe("примечание к доступу: пометка сервера — кодом, фразой на языке читающего", () => {
  let batteryId = "";
  let assignmentId = "";
  let personId = "";

  beforeAll(async () => {
    const person = await makeUser("user", `srvstrings-${crypto.randomUUID()}@test`);
    personId = person.id;
    batteryId = crypto.randomUUID();
    await db.insert(batteries).values({ id: batteryId, title: `Набір мови ${tag}`, groupId: groupA, createdBy: adminA.id });
    await db.insert(batteryItems).values([{ batteryId, surveyId: surveyInA, position: 0, required: true }]);
    const res = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: personId }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    assignmentId = res.body.id as string;
  });

  afterAll(async () => {
    // живое назначение в общей очереди сбило бы соседей, считающих назначения
    if (assignmentId) await db.update(batteryAssignments).set({ cancelledAt: new Date().toISOString() }).where(eq(batteryAssignments.id, assignmentId));
  });

  test("в базе — код с названием набора, в списке назначенных — на трёх языках", async () => {
    const [row] = await db
      .select({ note: surveyAccess.note })
      .from(surveyAccess)
      .where(eq(surveyAccess.userId, personId));
    expect(readNotes(row!.note)).toEqual([{ code: "note.battery", params: { title: `Набір мови ${tag}` } }]);

    const noteIn = async (lang: Lang) => {
      const res = await ask(`/api/access/surveys/${surveyInA}/grants`, adminA.token, lang);
      expect(res.status).toBe(200);
      return (res.body.items as { userId: string; note: string | null }[]).find((g) => g.userId === personId)!.note;
    };
    expect(await noteIn("uk")).toBe(`Набір «Набір мови ${tag}»`);
    expect(await noteIn("ru")).toBe(`Батарея «Набір мови ${tag}»`);
    expect(await noteIn("en")).toBe(`Battery “Набір мови ${tag}”`);
  });
});

describe("причина обхода политик строк — кодом, фразой на месте показа", () => {
  const fake =
    (row: { is_super: boolean; bypass: boolean; owned: number }) =>
    async <T,>() =>
      [{ role: "quizzy", ...row }] as unknown as T[];

  test("консоль, техпанель и проверка получают код, терминал при старте — русскую фразу", async () => {
    const owner = await checkRls(fake({ is_super: false, bypass: false, owned: 3 }));
    expect(owner.reason).toBe(noteCode("rls.why.owner", { n: 3 }));
    expect(renderNote(owner.reason, "uk")).toBe("володіє 3 табл. з увімкненою RLS");
    expect(renderNote(owner.reason, "en")).toBe("owns 3 tables with RLS enabled");
    // отказ при старте — по-русски, как весь вывод скриптов, и без кода в тексте
    expect(rlsRefusal(owner)).toContain("ролью «quizzy» — владеет 3 табл. с включённой RLS.");
    expect(rlsRefusal(owner)).not.toContain("⟦");

    const superuser = await checkRls(fake({ is_super: true, bypass: false, owned: 0 }));
    expect(renderNote(superuser.reason, "en")).toBe("database superuser");
    const bypass = await checkRls(fake({ is_super: false, bypass: true, owned: 0 }));
    expect(renderNote(bypass.reason, "ru")).toBe("роль с BYPASSRLS");
  });

  test("экран SQL-консоли: причина уже фразой, не кодом", async () => {
    const res = await ask("/api/ops/sec/sql", root.token, "en");
    expect(res.status).toBe(200);
    const reason = res.body.rlsReason as string | null;
    // сюита ходит в базу владельцем (обход есть), под ролью приложения — нет (причины нет)
    if (reason !== null) {
      expect(reason).not.toContain("⟦");
      expect(["database superuser", "role with BYPASSRLS"].includes(reason) || reason.startsWith("owns ")).toBe(true);
    }
  });
});

describe("признаки небрежного заполнения — на языке того, кто смотрит", () => {
  test("одна и та же анкета — три языка причин", () => {
    const questions = [0, 1, 2, 3, 4].map((i) => ({ id: `q${i}`, type: "scale" }));
    const answers = questions.map((q) => ({ questionId: q.id, skipped: false, durationMs: 100, number: 3 }));
    const reasons = (lang: Lang) =>
      qualityOf("r1", null, null, 500, answers as never, questions as never, 800, 0.5, lang).reasons;
    expect(reasons("ru")).toEqual([
      "100% ответов быстрее 800 мс",
      "серия из 5 одинаковых ответов",
      "общее время меньше минимально правдоподобного",
      "нетипичный паттерн ответов (0.5)",
    ]);
    expect(reasons("uk")[0]).toBe("100% відповідей швидше за 800 мс");
    expect(reasons("en")).toEqual([
      "100% of answers faster than 800 ms",
      "a run of 5 identical answers",
      "total time below the minimum plausible",
      "atypical answer pattern (0.5)",
    ]);
  });
});

describe("заметка каталога: код с отпечатком, прежняя фраза узнаётся", () => {
  test("первый выкат после перехода на коды не выпускает лишней версии", async () => {
    await installCatalog();
    const [pss] = await db.select().from(surveys).where(eq(surveys.catalogKey, "pss10"));
    const head = async () =>
      (
        await db
          .select()
          .from(surveyVersions)
          .where(eq(surveyVersions.surveyId, pss!.id))
          .orderBy(desc(surveyVersions.version))
          .limit(1)
      )[0]!;
    const before = await head();
    const [coded] = readNotes(before.note);
    // если последнюю версию выпустил человек (соседний файл), каталог её не трогает — проверять тут нечего
    if (coded?.code !== "note.catalog") return;
    const edition = String(coded.params?.edition);
    expect(edition).toMatch(/^[0-9a-f]{12}$/);

    // так лежит заметка у поставленных до волны 14
    await db.update(surveyVersions).set({ note: `Каталог · ${edition}` }).where(eq(surveyVersions.id, before.id));
    const report = await installCatalog();
    expect(report.skipped, "прежняя фраза с тем же отпечатком не узнана").toContain("pss10");
    expect(report.updated).not.toContain("pss10");
    expect((await head()).id).toBe(before.id);

    // вернуть код и посмотреть, как заметку читают на английском экране
    await db.update(surveyVersions).set({ note: before.note }).where(eq(surveyVersions.id, before.id));
    const res = await ask(`/api/surveys/${pss!.id}/versions`, root.token, "en");
    expect((res.body.items as { note: string }[])[0]!.note).toBe(`Catalogue · ${edition}`);
  }, 60_000);
});
