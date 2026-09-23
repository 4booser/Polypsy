import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  adminA,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  makeUser,
  responsesTable,
  surveys,
  users,
  type Person,
} from "./fixtures";
import {
  decisionRules,
  patientGroupMembers,
  patientGroups,
  patientGroupSurveys,
  riskAlerts,
  surveyAccess,
} from "../src/db/schema";
import { purgeDemoData } from "../src/lib/demoFill";
import { purgeDemoGroupsRules, seedDemoGroupsRules, type DemoGroupsRulesReport } from "../src/seed/demoGroupsRules";

/**
 * Посев демонстрационных групп пациентов и правил поддержки решений.
 *
 * Модуль вызывается дважды: из seed.ts на стенде и из demo-fill на проде,
 * где посев не пересоздаётся. Поэтому главное здесь — не «завёл три
 * группы», а «второй прогон на заполненной базе не удвоил ни одной таблицы
 * и не упал». Проверено мутацией: снятый onConflictDoNothing на любой из
 * вставок роняет второй прогон дубликатом ключа с именем таблицы.
 *
 * Модуль ищет свои опоры по устойчивым ключам — почту psy, украинские
 * названия демо-методик, пул patientN@quizzy.dev с подразделениями посева.
 * Фикстуры их не заводят, поэтому тест собирает ту же картину сам: иначе
 * проверялся бы пропуск «нет владельца», а не посев.
 */

/** Подразделения — как у PATIENT_POOL в seed.ts, поимённо по тем же номерам */
const POOL: [string, string][] = [
  ["patient1@quizzy.dev", "1-й батальон"],
  ["patient2@quizzy.dev", "Медицинская рота"],
  ["patient3@quizzy.dev", "1-й батальон"],
  ["patient4@quizzy.dev", "Узел связи"],
  ["patient5@quizzy.dev", "2-й батальон"],
  ["patient6@quizzy.dev", "2-й батальон"],
  ["patient7@quizzy.dev", "Медицинская рота"],
  ["patient8@quizzy.dev", "Рота обеспечения"],
  ["patient9@quizzy.dev", "1-й батальон"],
  ["patient10@quizzy.dev", "Штаб"],
  ["user@quizzy.dev", "1-й батальон"],
  ["user2@quizzy.dev", "Медицинская рота"],
];

const uk = (u: string, ru: string) => ({ uk: u, ru });

/** Демо-методика с нужными шкалами; текст двуязычный — сторож content.test.ts смотрит и сюда */
async function makeDemoSurvey(
  title: { uk: string; ru: string },
  scaleList: { code: string; title: { uk: string; ru: string } }[],
): Promise<string> {
  const input = createSurveySchema.parse({
    title,
    description: uk("Демонстраційна методика для посіву", "Демонстрационная методика для посева"),
    groupId: groupA,
    scoringEnabled: true,
    allowRetake: true,
    sections: [],
    scales: scaleList.map((s) => ({
      code: s.code,
      title: s.title,
      description: null,
      aggregation: "sum",
      bands: [{ minScore: 0, maxScore: 30, label: uk("Норма", "Норма"), severity: "none", description: null }],
    })),
    questions: scaleList.map((s) => ({
      type: "scale",
      title: uk(`Оцініть: ${s.title.uk}`, `Оцените: ${s.title.ru}`),
      scaleCode: s.code,
      required: true,
      minValue: 0,
      maxValue: 10,
      step: 1,
      options: [],
    })),
  });
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: input.title,
    description: input.description,
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "restricted",
    scoringEnabled: true,
    allowRetake: true,
    isDemo: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, input, adminA.id, "Версія для посіву");
  return id;
}

/* ═════════════ живой экземпляр: ни psy, ни пула, ни демо-методик ═════════════ */

/**
 * Прод, из-за которого модуль и переписан: посевных учёток нет, есть
 * настоящий администратор, вымышленные люди demo-fill и обычные
 * опубликованные методики.
 *
 * Разыгрывается ПЕРВЫМ, до посевных учёток, и за собой прибирает: база у всех
 * тестовых файлов одна на процесс (см. докблок fixtures.ts), и психолог
 * psy@quizzy.dev, заведённый ниже, отключил бы запасной выбор владельца
 * насовсем. Снимки состояния сняты здесь же, а проверяются в тестах: порядок
 * шагов — часть проверки, и разносить его по тестам значило бы полагаться на
 * порядок их запуска.
 */

/** Кто заводит вымышленных: подразделение — как у demo-fill, разной численности */
const DEMO_PEOPLE: [string, string][] = [
  ["demo-001@demo.local", "Медична рота"],
  ["demo-002@demo.local", "Медична рота"],
  ["demo-003@demo.local", "Медична рота"],
  ["demo-004@demo.local", "Медична рота"],
  ["demo-005@demo.local", "Медична рота"],
  ["demo-006@demo.local", "Вузол зв'язку"],
  ["demo-007@demo.local", "Вузол зв'язку"],
  ["demo-008@demo.local", "Вузол зв'язку"],
  ["demo-009@demo.local", "Вузол зв'язку"],
  ["demo-010@demo.local", "Штаб"],
  ["demo-011@demo.local", "Штаб"],
  ["demo-012@demo.local", "Штаб"],
];
/** Тревога у троих — по одному из каждого подразделения: группа риска обязана пересечь обе другие */
const ALERTED = ["demo-002@demo.local", "demo-007@demo.local", "demo-011@demo.local"];

const AUTO_GROUP_IDS = ["demo-pg-auto-unit", "demo-pg-auto-risk", "demo-pg-auto-rest"];
const AUTO_RULE_IDS = ["demo-rule-auto-1", "demo-rule-auto-2", "demo-rule-auto-3"];

/*
 * Полосы настоящей лестницы: норма, умеренное, выраженное. Порог правила —
 * нижняя граница средней, то есть 8; одной полосой «Норма от 0» проверялось бы
 * только то, что модуль не падает.
 */
const BANDS = [
  { minScore: 0, maxScore: 7, label: uk("Норма", "Норма"), severity: "none", description: null },
  { minScore: 8, maxScore: 14, label: uk("Помірні прояви", "Умеренные проявления"), severity: "moderate", description: null },
  { minScore: 15, maxScore: 30, label: uk("Виражені прояви", "Выраженные проявления"), severity: "severe", description: null },
];

/**
 * Опубликованная методика с двумя шкалами и ОДНИМ вопросом.
 *
 * Вопрос один намеренно, и идентификатор задан руками. Модуль отбирает две
 * методики по возрастанию числа вопросов, потом по идентификатору, а база у
 * тестов общая: к этому файлу в ней уже лежат чужие опубликованные методики,
 * и самая маленькая из них — об одном вопросе. Две шкалы при одном вопросе
 * дают три шкалы на пару методик, то есть три правила.
 */
async function makeAutoSurvey(id: string, title: { uk: string; ru: string }, codes: string[]): Promise<string> {
  const input = createSurveySchema.parse({
    title,
    description: uk("Методика живого екземпляра", "Методика живого экземпляра"),
    groupId: groupA,
    scoringEnabled: true,
    allowRetake: true,
    sections: [],
    scales: codes.map((code, i) => ({
      code,
      title: uk(`Шкала ${i + 1} (${code})`, `Шкала ${i + 1} (${code})`),
      description: null,
      aggregation: "sum",
      bands: BANDS,
    })),
    questions: [
      {
        type: "scale",
        title: uk("Оцініть свій стан", "Оцените своё состояние"),
        scaleCode: codes[0],
        required: true,
        minValue: 0,
        maxValue: 10,
        step: 1,
        options: [],
      },
    ],
  });
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: input.title,
    description: input.description,
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "restricted",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, input, adminA.id, "Версія живого екземпляра");
  return id;
}

/** Снимок одной таблицы посева по его постоянным ключам */
async function autoRows() {
  return {
    groups: await db.select().from(patientGroups).where(inArray(patientGroups.id, AUTO_GROUP_IDS)),
    members: await db.select().from(patientGroupMembers).where(inArray(patientGroupMembers.groupId, AUTO_GROUP_IDS)),
    assigned: await db.select().from(patientGroupSurveys).where(inArray(patientGroupSurveys.groupId, AUTO_GROUP_IDS)),
    rules: await db.select().from(decisionRules).where(inArray(decisionRules.id, AUTO_RULE_IDS)),
    access: await db.select().from(surveyAccess).where(inArray(surveyAccess.viaPatientGroupId, AUTO_GROUP_IDS)),
  };
}

/** Самый ранний настоящий администратор картотеки: его и обязан выбрать модуль */
let chief: Person;
let autoFirst: DemoGroupsRulesReport;
let autoSecond: DemoGroupsRulesReport;
let autoAfterSeed: Awaited<ReturnType<typeof autoRows>>;
let autoAfterRepeat: Awaited<ReturnType<typeof autoRows>>;
let autoAfterPeoplePurge: Awaited<ReturnType<typeof autoRows>>;
let autoAfterPurge: Awaited<ReturnType<typeof autoRows>>;
let autoSurveyIds: string[];
let peopleRemoved: number;
let peoplePurgeError: unknown = null;

async function runLiveInstanceScenario() {
  /*
   * Заведён 2000 годом: «самый ранний admin» модуль ищет по created_at, а в
   * общей базе к этому файлу администраторов уже несколько. Без явной даты
   * проверялось бы не правило выбора, а порядок запуска файлов.
   */
  chief = await makeUser("admin", "chief@clinic.local", { createdAt: "2000-01-01T00:00:00.000Z" });
  /*
   * Вымышленный специалист demo-fill — и заведён РАНЬШЕ настоящего. По
   * created_at он первый, и выбрать модуль обязан всё равно не его:
   * patient_groups.owner_id и decision_rules.created_by объявлены ON DELETE
   * RESTRICT, а demo-purge убирает вымышленных одним условием по домену
   * почты. Группа на его имени превратила бы «убрать всех вымышленных» в
   * отказ внешнего ключа — что и проверяет последний тест этого разыгрывания.
   */
  await makeUser("admin", "demo-specialist@demo.local", { createdAt: "1999-01-01T00:00:00.000Z" });
  const people = new Map<string, string>();
  for (const [email, unit] of DEMO_PEOPLE) people.set(email, (await makeUser("user", email, { unit })).id);

  autoSurveyIds = [
    await makeAutoSurvey("0000-demo-auto-a", uk("Скринінг живого екземпляра", "Скрининг живого экземпляра"), ["a1", "a2"]),
    await makeAutoSurvey("0000-demo-auto-b", uk("Опитувальник живого екземпляра", "Опросник живого экземпляра"), ["b1", "b2"]),
  ];

  /* Сработавшая тревога — то, по чему модуль набирает группу риска */
  for (const email of ALERTED) {
    const responseId = crypto.randomUUID();
    await db
      .insert(responsesTable)
      .values({ id: responseId, surveyId: autoSurveyIds[0]!, userId: people.get(email)!, status: "completed" } as never);
    await db.insert(riskAlerts).values({
      id: crypto.randomUUID(),
      responseId,
      surveyId: autoSurveyIds[0]!,
      userId: people.get(email)!,
      label: "Критичний пункт",
    } as never);
  }

  autoFirst = await seedDemoGroupsRules();
  autoAfterSeed = await autoRows();
  autoSecond = await seedDemoGroupsRules();
  autoAfterRepeat = await autoRows();

  /*
   * Уборка в том же порядке, что и demoFill.ts: сначала люди, потом группы.
   * Этот порядок и проверяет RESTRICT на patient_groups.owner_id: будь
   * владельцем вымышленный demo-specialist, отказ пришёл бы отсюда.
   */
  try {
    peopleRemoved = await purgeDemoData();
  } catch (e) {
    peoplePurgeError = e;
    peopleRemoved = -1;
  }
  autoAfterPeoplePurge = await autoRows();
  await purgeDemoGroupsRules();
  autoAfterPurge = await autoRows();

  /*
   * За собой прибираем: методики и администратор этого разыгрывания не должны
   * попадать в выборки следующих тестовых файлов — база у них общая.
   */
  await db.delete(surveys).where(inArray(surveys.id, autoSurveyIds));
  await db.delete(users).where(eq(users.id, chief.id));
}

let psy: Person;
let sleepId: string;
let emotionalId: string;
let first: DemoGroupsRulesReport;

beforeAll(async () => {
  await runLiveInstanceScenario();

  psy = await makeUser("admin", "psy@quizzy.dev");
  for (const [email, unit] of POOL) await makeUser("user", email, { unit });
  sleepId = await makeDemoSurvey(uk("Якість сну (демо)", "Качество сна (демо)"), [
    { code: "sleep", title: uk("Порушення сну", "Нарушения сна") },
  ]);
  emotionalId = await makeDemoSurvey(uk("Скринінг емоційного стану (демо)", "Скрининг эмоционального состояния (демо)"), [
    { code: "anxiety", title: uk("Тривога", "Тревога") },
    { code: "mood", title: uk("Знижений настрій", "Сниженное настроение") },
  ]);
  first = await seedDemoGroupsRules();
});

/** Снимок числа строк во всех таблицах, которые пишет модуль */
async function counts() {
  const n = async (q: ReturnType<typeof sql>) => Number((await db.execute<{ n: number }>(q))[0]?.n ?? 0);
  return {
    patient_groups: await n(sql`select count(*)::int as n from patient_groups`),
    patient_group_members: await n(sql`select count(*)::int as n from patient_group_members`),
    patient_group_surveys: await n(sql`select count(*)::int as n from patient_group_surveys`),
    survey_access: await n(sql`select count(*)::int as n from survey_access`),
    decision_rules: await n(sql`select count(*)::int as n from decision_rules`),
  };
}

const GROUP_IDS = ["demo-pg-1bn", "demo-pg-risk", "demo-pg-evening"];
const RULE_IDS = ["demo-rule-sleep", "demo-rule-anxiety", "demo-rule-mood"];

describe("посев групп пациентов и правил", () => {
  test("три группы у psy: состав 5–8 человек с пересечениями", async () => {
    expect(first.skipped).toBeNull();
    expect(first.groups).toBe(3);

    const rows = await db.select().from(patientGroups).where(eq(patientGroups.ownerId, psy.id));
    expect(rows.map((g) => g.id).sort()).toEqual([...GROUP_IDS].sort());
    for (const g of rows) {
      expect(g.title.length, `название ${g.id}`).toBeGreaterThan(0);
      // описание — оба языка подряд: простой текст, за читателем не следует
      expect(g.description, `описание ${g.id}`).toMatch(/[іїє].*\n.*[ыэъ]/is);
    }

    const members = await db
      .select({ groupId: patientGroupMembers.groupId, patientId: patientGroupMembers.patientId })
      .from(patientGroupMembers)
      .where(inArray(patientGroupMembers.groupId, GROUP_IDS));
    for (const id of GROUP_IDS) {
      const n = members.filter((m) => m.groupId === id).length;
      expect(n, `состав ${id}`).toBeGreaterThanOrEqual(5);
      expect(n, `состав ${id}`).toBeLessThanOrEqual(8);
    }
    const perPatient = new Map<string, number>();
    for (const m of members) perPatient.set(m.patientId, (perPatient.get(m.patientId) ?? 0) + 1);
    const shared = [...perPatient.values()].filter((n) => n > 1).length;
    expect(shared, "ни один пациент не состоит в двух группах").toBeGreaterThan(0);
  });

  test("методики назначены группе тем же путём, что кнопка «Призначити Групі»", async () => {
    const assigned = await db
      .select()
      .from(patientGroupSurveys)
      .where(inArray(patientGroupSurveys.groupId, GROUP_IDS));
    expect(assigned.length).toBe(4);
    for (const a of assigned) {
      expect([sleepId, emotionalId], `методика группы ${a.groupId}`).toContain(a.surveyId);
      expect(a.assignedBy).toBe(psy.id);
      expect(a.expiresAt).not.toBeNull();
      expect(a.attemptsAllowed).toBeGreaterThanOrEqual(1);
    }

    /*
     * Каждое групповое назначение развёрнуто в поимённые выдачи с пометкой
     * «через группу». У человека в двух группах с одной методикой пометка
     * — от группы, назначившей последней: так работает кнопка, и посев
     * обязан оставить ту же картину, а не свою.
     */
    const membership = await db
      .select({ groupId: patientGroupMembers.groupId, patientId: patientGroupMembers.patientId })
      .from(patientGroupMembers)
      .where(inArray(patientGroupMembers.groupId, GROUP_IDS));
    let issued = 0;
    for (const a of assigned) {
      const members = membership.filter((m) => m.groupId === a.groupId).map((m) => m.patientId);
      issued += members.length;
      for (const userId of members) {
        const [row] = await db
          .select()
          .from(surveyAccess)
          .where(and(eq(surveyAccess.surveyId, a.surveyId), eq(surveyAccess.userId, userId)));
        expect(row, `выдача ${a.groupId} → ${userId}`).toBeDefined();
        expect(row!.grantedBy).toBe(psy.id);
        expect(GROUP_IDS, `пометка «через группу» у ${userId}`).toContain(row!.viaPatientGroupId ?? "");
        // пометка — от группы, в которой человек состоит и которой методика назначена
        const via = assigned.find((x) => x.groupId === row!.viaPatientGroupId && x.surveyId === a.surveyId);
        expect(via, `группа ${row!.viaPatientGroupId} не назначала методику ${a.surveyId}`).toBeDefined();
        expect(membership.some((m) => m.groupId === via!.groupId && m.patientId === userId)).toBe(true);
        expect(row!.expiresAt).toBe(via!.expiresAt);
        expect(row!.attemptsAllowed).toBe(via!.attemptsAllowed);
      }
    }
    // выдач столько, сколько нажатий кнопки: общий участник получил методику от каждой группы
    expect(first.grants).toBe(issued);

    const byEmail = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0]!.id;
    const inBoth = async (email: string, surveyId: string) =>
      (await db.select().from(surveyAccess).where(and(eq(surveyAccess.surveyId, surveyId), eq(surveyAccess.userId, await byEmail(email)))))[0]!;
    // patient1 — в «1-й батальйон» и «Група ризику», обеим назначен скрининг: последняя — риск
    expect((await inBoth("patient1@quizzy.dev", emotionalId)).viaPatientGroupId).toBe("demo-pg-risk");
    // user2 — в риске и вечерней группе, обеим назначен сон: последняя — вечерняя
    expect((await inBoth("user2@quizzy.dev", sleepId)).viaPatientGroupId).toBe("demo-pg-evening");
  });

  test("три правила на демо-методиках, одно выключено", async () => {
    expect(first.rules).toBe(3);
    const rules = await db.select().from(decisionRules).where(inArray(decisionRules.id, RULE_IDS));
    expect(rules.length).toBe(3);
    expect(rules.filter((r) => !r.enabled).map((r) => r.id)).toEqual(["demo-rule-mood"]);

    const seen = new Set<string>();
    for (const r of rules) {
      const conditions = r.conditions as { kind: string; surveyId: string | null; scaleCode: string }[];
      const actions = r.actions as { kind: string }[];
      expect(conditions.length, `условий у ${r.id}`).toBe(1);
      expect(conditions[0]!.kind).toBe("scale");
      expect([sleepId, emotionalId]).toContain(conditions[0]!.surveyId ?? "");
      expect(actions.length, `действий у ${r.id}`).toBeGreaterThan(0);
      expect(r.createdBy).toBe(psy.id);
      expect(r.note ?? "", `заметка ${r.id}`).toMatch(/[іїє].*\n.*[ыэъ]/is);
      seen.add(`${conditions[0]!.surveyId}:${conditions[0]!.scaleCode}`);
    }
    // по одному условию на каждую шкалу: sleep, anxiety, mood
    expect(seen.size).toBe(3);
  });

  test("повторный прогон ничего не удваивает и не падает", async () => {
    const before = await counts();
    const again = await seedDemoGroupsRules();
    const after = await counts();
    expect(after).toEqual(before);
    expect(again).toEqual({ groups: 0, members: 0, assignments: 0, grants: 0, rules: 0, skipped: null });
  });
});

describe("посев на живом экземпляре: ни psy, ни пула, ни демо-методик", () => {
  test("владелец — самый ранний настоящий admin, а не вымышленный и не пропуск", () => {
    /*
     * Мутация: убрать запасной выбор владельца в resolveOwner — и модуль
     * снова печатает «пропущено», то есть ровно то, что случилось в проде.
     */
    expect(autoFirst.skipped, "запасной выбор владельца обязан найти настоящего администратора").toBeNull();
    expect(autoAfterSeed.groups.length).toBe(3);
    for (const g of autoAfterSeed.groups) expect(g.ownerId, `владелец ${g.id}`).toBe(chief.id);
    for (const r of autoAfterSeed.rules) expect(r.createdBy, `автор ${r.id}`).toBe(chief.id);
  });

  test("три группы по подразделениям и тревогам, с пересечениями", () => {
    expect(autoFirst.groups).toBe(3);
    // самое населённое подразделение — 5, группа риска — трое с тревогой, остаток — 7
    const size = (id: string) => autoAfterSeed.members.filter((m) => m.groupId === id).length;
    expect(size("demo-pg-auto-unit"), "самое населённое подразделение").toBe(5);
    expect(size("demo-pg-auto-risk"), "группа риска по тревогам").toBe(ALERTED.length);
    expect(size("demo-pg-auto-rest"), "остаток").toBe(DEMO_PEOPLE.length - 5);
    expect(autoFirst.members).toBe(5 + ALERTED.length + (DEMO_PEOPLE.length - 5));

    const perPatient = new Map<string, number>();
    for (const m of autoAfterSeed.members) perPatient.set(m.patientId, (perPatient.get(m.patientId) ?? 0) + 1);
    // трое с тревогой стоят и в своей группе по подразделению: вкладки ради этого и заведены
    expect([...perPatient.values()].filter((n) => n > 1).length).toBe(ALERTED.length);

    for (const g of autoAfterSeed.groups) {
      expect(g.title.length, `название ${g.id}`).toBeGreaterThan(0);
      expect(g.description, `описание ${g.id}`).toMatch(/[іїє].*\n.*[ыэъ]/is);
    }

    expect(autoFirst.assignments).toBe(4);
    expect(autoFirst.grants).toBeGreaterThan(0);
    for (const a of autoAfterSeed.assigned) {
      expect(autoSurveyIds, `методика группы ${a.groupId}`).toContain(a.surveyId);
      expect(a.assignedBy).toBe(chief.id);
      expect(a.expiresAt).not.toBeNull();
    }
    for (const row of autoAfterSeed.access) {
      expect(row.grantedBy).toBe(chief.id);
      expect(AUTO_GROUP_IDS).toContain(row.viaPatientGroupId ?? "");
    }
  });

  test("правила на реальных кодах шкал, порог — граница полосы, одно выключено", () => {
    expect(autoFirst.rules).toBe(3);
    expect(autoAfterSeed.rules.length).toBe(3);
    expect(autoAfterSeed.rules.filter((r) => !r.enabled).map((r) => r.id)).toEqual(["demo-rule-auto-3"]);

    const seen = new Set<string>();
    for (const r of autoAfterSeed.rules) {
      type Cond = { kind: string; surveyId: string | null; scaleCode: string; op: string; value: number };
      const conditions = r.conditions as Cond[];
      expect(conditions.length, `условий у ${r.id}`).toBe(1);
      const c = conditions[0]!;
      expect(c.kind).toBe("scale");
      expect(autoSurveyIds, `методика ${r.id}`).toContain(c.surveyId ?? "");
      // коды — настоящие коды шкал выбранных методик, а не зашитые sleep/anxiety/mood
      expect(["a1", "a2", "b1", "b2"], `шкала ${r.id}`).toContain(c.scaleCode);
      expect(c.op).toBe(">=");
      // 8 — нижняя граница полосы «Помірні прояви»; числа не из интерпретации быть не должно
      expect(c.value, `порог ${r.id}`).toBe(8);
      expect(r.title, `название ${r.id}`).toContain("Помірні прояви");
      expect(r.note ?? "", `заметка ${r.id}`).toMatch(/[іїє].*\n.*[ыэъ]/is);
      seen.add(`${c.surveyId}:${c.scaleCode}`);
    }
    expect(seen.size, "каждое правило на своей шкале").toBe(3);

    const actions = autoAfterSeed.rules.flatMap((r) => r.actions as { kind: string; surveyId?: string }[]);
    const suggest = actions.find((a) => a.kind === "suggest_survey");
    expect(suggest, "первое правило направляет на вторую методику").toBeDefined();
    expect(autoSurveyIds).toContain(suggest!.surveyId ?? "");
    expect(actions.some((a) => a.kind === "notify_duty"), "второе правило поднимает дежурного").toBe(true);
  });

  test("повторный прогон на живом экземпляре ничего не удваивает", () => {
    expect(autoSecond).toEqual({ groups: 0, members: 0, assignments: 0, grants: 0, rules: 0, skipped: null });
    const shape = (r: typeof autoAfterSeed) => ({
      groups: r.groups.length,
      members: r.members.length,
      assigned: r.assigned.length,
      rules: r.rules.length,
      access: r.access.length,
    });
    expect(shape(autoAfterRepeat)).toEqual(shape(autoAfterSeed));
  });

  test("demo-purge убирает вымышленных, а purgeDemoGroupsRules — группы и правила", () => {
    /*
     * Мутация: поставить владельцем вымышленного demo-specialist@demo.local —
     * и удаление людей падает отказом внешнего ключа, потому что
     * patient_groups.owner_id и decision_rules.created_by объявлены ON DELETE
     * RESTRICT (0078_patient_groups.sql, 0042_decision_support.sql).
     */
    expect(peoplePurgeError, "RESTRICT на владельце не должен мешать убрать вымышленных").toBeNull();
    // двенадцать вымышленных людей и вымышленный специалист, заведённый выше
    expect(peopleRemoved).toBe(DEMO_PEOPLE.length + 1);

    // люди ушли — с ними состав и выданные через группу доступы; сами группы остались
    expect(autoAfterPeoplePurge.groups.length).toBe(3);
    expect(autoAfterPeoplePurge.members.length, "состав уходит каскадом с людьми").toBe(0);
    expect(autoAfterPeoplePurge.access.length, "выдачи уходят каскадом с людьми").toBe(0);
    expect(autoAfterPeoplePurge.assigned.length, "решение о назначении группе остаётся").toBe(4);
    expect(autoAfterPeoplePurge.rules.length).toBe(3);

    // и вот их-то и убирает уборка посева: иначе в консоли остались бы пустые группы
    expect(autoAfterPurge.groups.length).toBe(0);
    expect(autoAfterPurge.members.length).toBe(0);
    expect(autoAfterPurge.assigned.length).toBe(0);
    expect(autoAfterPurge.rules.length).toBe(0);
    expect(autoAfterPurge.access.length).toBe(0);
  });
});
