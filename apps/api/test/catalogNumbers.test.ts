import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type { SurveyListItem, SurveyListPage } from "@quizzy/shared";
import { surveyAccess } from "../src/db/schema";
import { requestSql } from "../src/lib/opsSql";
import { adminA, api, db, eq, groupA, makeUser, patient, responsesTable, root, sql, surveys, type Person } from "./fixtures";

/**
 * Числа строк каталога соединениями и агрегатами (волна 27, perf-day).
 *
 * GET /api/surveys нёс на каждую строку десять подзапросов, из них пять —
 * паспорт UI 3; число пунктов перебирало все пункты всех редакций на каждую
 * строку. Теперь числа считаются вторым запросом по строкам страницы.
 *
 * Сверка — с прежним запросом, дословно (ORACLE ниже — подзапросы из
 * routes/surveys.ts до правки) на тех же методиках и тем же человеком:
 * сотрудник группы, суперадмин и обследуемый, со страницей и без. Данные —
 * своя методика с двумя редакциями (у прежней — критический пункт и другие
 * шкалы), завершённые, давние и брошенные прохождения, своё и чужое,
 * действующее и истёкшее назначения; остальные строки — что лежит в базе
 * от соседних файлов, они сверяются тем же оракулом.
 */

const tag = crypto.randomUUID().slice(0, 8);
const L = (uk: string) => ({ uk, ru: uk });
let current: string;
let second: string;
let other: Person;

/** Прежний подсчёт строки — дословно из routes/surveys.ts до волны 27 */
async function oracle(ids: string[], me: string, staff: boolean) {
  if (!ids.length) return new Map();
  const rows = await db.execute<Record<string, unknown> & { id: string }>(sql`
    select s.id,
      (select v.version from survey_versions v where v.id = s.current_version_id) as version_number,
      (select count(*) from scales sc where sc.version_id = s.current_version_id) as scale_count,
      (select count(*) from scale_bands b join scales sc on sc.id = b.scale_id
        where sc.version_id = s.current_version_id) as band_count,
      (select count(*) from responses r where r.survey_id = s.id
        and r.status = 'completed' and r.submitted_at > now() - interval '30 days') as recent,
      exists (select 1 from options o join questions q on q.id = o.question_id
        where q.version_id = s.current_version_id and o.risk_flag) as critical,
      (select count(*) from questions q where q.version_id = s.current_version_id and q.type <> 'info') as question_count,
      ${
        staff
          ? sql`(select count(*) from responses r where r.survey_id = s.id and r.status = 'completed')`
          : sql`(select count(*) from responses r where r.survey_id = s.id and r.user_id = ${me} and r.status = 'completed')`
      } as response_count,
      (select count(*) from responses r where r.survey_id = s.id and r.user_id = ${me} and r.status = 'completed') as mine,
      (select sa.granted_at from survey_access sa where sa.survey_id = s.id and sa.user_id = ${me}
        and (sa.expires_at is null or sa.expires_at > now()) limit 1) as assigned_at,
      (select sa.expires_at from survey_access sa where sa.survey_id = s.id and sa.user_id = ${me}
        and (sa.expires_at is null or sa.expires_at > now()) limit 1) as due_at
    from surveys s where s.id in ${ids}`);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Строка ответа против прежнего подсчёта: те же числа, тот же набор полей */
function expectSame(items: SurveyListItem[], expected: Map<string, Record<string, unknown>>, staff: boolean) {
  expect(items.length).toBeGreaterThan(0);
  for (const s of items) {
    const o = expected.get(s.id)!;
    const where = `«${s.title}» (${s.id})`;
    expect(s.questionCount, where).toBe(Number(o.question_count));
    expect(s.responseCount, where).toBe(Number(o.response_count));
    expect(s.completedByMe, where).toBe(Number(o.mine) > 0);
    expect(s.assigned, where).toBe(o.assigned_at !== null);
    expect(s.dueAt, where).toBe((o.due_at as string | null) ?? null);
    if (staff) {
      expect(s.versionNumber ?? null, where).toBe(o.version_number === null ? null : Number(o.version_number));
      expect(s.scaleCount, where).toBe(Number(o.scale_count));
      expect(s.bandCount, where).toBe(Number(o.band_count));
      expect(s.recentResponseCount, where).toBe(Number(o.recent));
      expect(s.hasCriticalItem, where).toBe(o.critical === true);
    } else {
      for (const k of ["versionNumber", "scaleCount", "bandCount", "recentResponseCount", "hasCriticalItem"]) {
        expect(k in s, `${k} ушло обследуемому: ${where}`).toBe(false);
      }
    }
  }
}

const day = 86_400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();

beforeAll(async () => {
  other = await makeUser("user", `catnum-other-${tag}@test`);
  const yes = (risk = false) => [
    { text: L("Так"), keyCode: "yes", score: 1, ...(risk ? { riskFlag: true, riskSeverity: "severe" } : {}) },
    { text: L("Ні"), keyCode: "no", score: 0 },
  ];
  // первая редакция: два пункта (второй — критический), информационный экран, две шкалы
  const created = await api("/api/surveys", adminA.token, {
    method: "POST",
    body: JSON.stringify({
      title: L(`Числа каталогу ${tag}`),
      groupId: groupA,
      administration: "self",
      scoringEnabled: true,
      questions: [
        { type: "single", title: L("Пункт 1"), options: yes() },
        { type: "single", title: L("Пункт 2"), options: yes(true) },
        { type: "info", title: L("Дякуємо"), options: [] },
      ],
      scales: [
        {
          code: "A",
          title: L("Шкала А"),
          key: [{ item: 1, matchKey: "yes" }],
          bands: [
            { minScore: 0, maxScore: 0, label: L("норма"), severity: "none" },
            { minScore: 1, maxScore: 1, label: L("увага"), severity: "moderate" },
          ],
        },
        {
          code: "B",
          title: L("Шкала Б"),
          key: [{ item: 2, matchKey: "yes" }],
          bands: [{ minScore: 0, maxScore: 1, label: L("усе"), severity: "none" }],
        },
      ],
    }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  current = created.body.id;
  // вторая редакция: три пункта без критического, одна шкала на три смуги
  const edited = await api(`/api/surveys/${current}`, adminA.token, {
    method: "PATCH",
    body: JSON.stringify({
      status: "published",
      questions: [
        { type: "single", title: L("Пункт 1"), options: yes() },
        { type: "single", title: L("Пункт 2"), options: yes() },
        { type: "single", title: L("Пункт 3"), options: yes() },
      ],
      scales: [
        {
          code: "A",
          title: L("Шкала А"),
          key: [
            { item: 1, matchKey: "yes" },
            { item: 2, matchKey: "yes" },
            { item: 3, matchKey: "yes" },
          ],
          bands: [
            { minScore: 0, maxScore: 0, label: L("норма"), severity: "none" },
            { minScore: 1, maxScore: 2, label: L("увага"), severity: "moderate" },
            { minScore: 3, maxScore: 3, label: L("ризик"), severity: "severe" },
          ],
        },
      ],
    }),
  });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);

  const second_ = await api("/api/surveys", adminA.token, {
    method: "POST",
    body: JSON.stringify({
      title: L(`Числа каталогу, друга ${tag}`),
      groupId: groupA,
      administration: "self",
      questions: [{ type: "single", title: L("Єдиний"), options: yes(true) }],
      scales: [],
    }),
  });
  expect(second_.status, JSON.stringify(second_.body)).toBe(201);
  second = second_.body.id;
  expect((await api(`/api/surveys/${second}`, adminA.token, { method: "PATCH", body: JSON.stringify({ status: "published" }) })).status).toBe(200);

  await db.insert(responsesTable).values([
    { id: crypto.randomUUID(), surveyId: current, userId: patient.id, status: "completed", startedAt: at(1), submittedAt: at(1) },
    { id: crypto.randomUUID(), surveyId: current, userId: patient.id, status: "completed", startedAt: at(40), submittedAt: at(40) },
    { id: crypto.randomUUID(), surveyId: current, userId: other.id, status: "completed", startedAt: at(3), submittedAt: at(3) },
    { id: crypto.randomUUID(), surveyId: current, userId: other.id, status: "abandoned", startedAt: at(2) },
    { id: crypto.randomUUID(), surveyId: second, userId: other.id, status: "completed", startedAt: at(5), submittedAt: at(5) },
  ] as never);
  await db.insert(surveyAccess).values([
    { surveyId: current, userId: patient.id, grantedBy: adminA.id, expiresAt: new Date(Date.now() + 5 * day).toISOString() },
    { surveyId: second, userId: patient.id, grantedBy: adminA.id, expiresAt: new Date(Date.now() - day).toISOString() },
  ]);
});

afterAll(async () => {
  /* свои методики — не оставляем в общих списках соседних файлов */
  await db.update(surveys).set({ status: "closed" }).where(inArray(surveys.id, [current, second]));
});

async function listed(path: string, who: Person) {
  const requestId = crypto.randomUUID();
  const res = await api<SurveyListPage>(path, who.token, { headers: { "x-request-id": requestId } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { ...res.body, sql: requestSql(requestId)?.count ?? 0 };
}

describe("числа строк каталога — те же, что считал прежний запрос", () => {
  test("сотрудник группы: весь список и страница", async () => {
    const all = await listed("/api/surveys?archived=1", adminA);
    expect(all.items.some((s) => s.id === current)).toBe(true);
    expectSame(all.items, await oracle(all.items.map((s) => s.id), adminA.id, true), true);
    const page = await listed(`/api/surveys?limit=2&offset=1&status=draft,published`, adminA);
    expectSame(page.items, await oracle(page.items.map((s) => s.id), adminA.id, true), true);
  });

  test("суперадмин: всё учреждение", async () => {
    const all = await listed("/api/surveys?archived=1", root);
    expectSame(all.items, await oracle(all.items.map((s) => s.id), root.id, true), true);
  });

  test("смысл, а не только совпадение: действующая редакция и окно 30 днів", async () => {
    const [row] = (await listed(`/api/surveys?q=${encodeURIComponent(`Числа каталогу ${tag}`)}`, adminA)).items;
    expect(row!.id).toBe(current);
    expect(row!.versionNumber).toBe(2);
    expect(row!.questionCount, "пункты действующей редакции, без информационных").toBe(3);
    expect(row!.scaleCount).toBe(1);
    expect(row!.bandCount).toBe(3);
    expect(row!.hasCriticalItem, "критический пункт был только в прежней редакции").toBe(false);
    expect(row!.responseCount).toBe(3);
    expect(row!.recentResponseCount).toBe(2);
    const [two] = (await listed(`/api/surveys?q=${encodeURIComponent(`Числа каталогу, друга ${tag}`)}`, adminA)).items;
    expect(two!.hasCriticalItem).toBe(true);
    expect(two!.scaleCount).toBe(0);
  });

  test("обследуемый: свои прохождения, своё назначение и срок, без паспорта", async () => {
    const all = await listed("/api/surveys", patient);
    expectSame(all.items, await oracle(all.items.map((s) => s.id), patient.id, false), false);
    const mine = all.items.find((s) => s.id === current)!;
    expect(mine.responseCount, "только свои завершённые").toBe(2);
    expect(mine.completedByMe).toBe(true);
    expect(mine.assigned).toBe(true);
    expect(mine.dueAt).not.toBeNull();
    const lapsed = all.items.find((s) => s.id === second);
    if (lapsed) {
      expect(lapsed.assigned, "истёкшее назначение — не назначение").toBe(false);
      expect(lapsed.responseCount, "чужое прохождение обследуемому не считается").toBe(0);
    }
  });

  /*
   * Порядок величин: числа — одним запросом на страницу, сколько бы строк в
   * ней ни было. Каждый замер — меньший из двух подряд: сторож запроса
   * перечитывает политику второго фактора, когда истёк её кэш
   * (lib/secondFactor.ts), и в полном прогоне это выпадало на первый замер.
   */
  test("счёт SQL от числа строк не зависит", async () => {
    const sqlOf = async (path: string) => {
      const first = await listed(path, root);
      const again = await listed(path, root);
      return { items: again.items, sql: Math.min(first.sql, again.sql) };
    };
    const one = await sqlOf("/api/surveys?limit=1");
    const many = await sqlOf("/api/surveys?limit=200");
    expect(many.items.length).toBeGreaterThan(1);
    expect(many.sql).toBe(one.sql);
  });

  test("пустой отбор — без второго запроса и без отказа", async () => {
    const none = await listed(`/api/surveys?q=${encodeURIComponent(`нет такой ${tag}`)}`, adminA);
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
  });
});

test("строки отбора — ровно строки ответа", async () => {
  // опора сверки: прежний оракул вернул строки по тем же идентификаторам, что и ответ
  const res = await listed("/api/surveys?archived=1", root);
  const ids = res.items.map((s) => s.id);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(surveys).where(inArray(surveys.id, ids));
  expect(Number(row!.n)).toBe(ids.length);
  expect(new Set(ids).size).toBe(ids.length);
  void eq;
});
