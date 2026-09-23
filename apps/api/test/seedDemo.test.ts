import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { adminA, createSurveySchema, createVersion, db, groupA, makeUser, surveys, type Person } from "./fixtures";
import { decisionRules, patientGroupMembers, patientGroups, patientGroupSurveys, surveyAccess } from "../src/db/schema";
import { seedDemoGroupsRules, type DemoGroupsRulesReport } from "../src/seed/demoGroupsRules";

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

let psy: Person;
let sleepId: string;
let emotionalId: string;
let first: DemoGroupsRulesReport;

beforeAll(async () => {
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

    const { users } = await import("../src/db/schema");
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
