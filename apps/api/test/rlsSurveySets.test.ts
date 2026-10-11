import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { db, makeUser, root, sql, surveyInA, type Person } from "./fixtures";
import { rlsRoleUrl } from "./appRole";

/**
 * Видимость прохождений и всего, что им принадлежит, под ролью приложения
 * (#185) — по ролям, строка в строку.
 *
 * Политики responses, answers, response_scores, answer_events,
 * conclusions, risk_alerts и alert_cases переписаны ради скорости
 * (0120_rls_survey_sets.sql): множество методик администратора считается
 * раз на запрос, а не вызовом на строку, а дочерние таблицы видны тогда,
 * когда видно их прохождение. Правка обязана не поменять ничего, кроме
 * скорости. Ожидание ниже снято на коде main — прежними политиками, тем же
 * миром — и записано словами: кто какие строки видит.
 *
 * Мир нарочно с краями, на которых политики можно перепутать: две группы и
 * администратор обеих; личная методика без группы и её создатель (ему
 * видна только она, а не методики группы, которые он тоже создавал);
 * методика без группы чужого автора; анонимное прохождение; администратор,
 * сам проходивший методику чужой группы («своё» сотруднику не положено —
 * прежнее условие событий ответов было шире, его сужала политика
 * прохождений); тревога, чья методика не совпадает с методикой
 * прохождения; роли без пользователя, пустой контекст и незнакомая роль.
 *
 * Чтение — отдельным подключением роли без прав владельца: владелец
 * политики обходит, и сравнение под ним было бы сравнением пустоты.
 */

const TAG = `w21rls-${crypto.randomUUID().slice(0, 8)}`;
const TABLES = [
  "responses",
  "answers",
  "response_scores",
  "answer_events",
  "conclusions",
  "risk_alerts",
  "alert_cases",
] as const;
type Table = (typeof TABLES)[number];
/** У таблицы своя приставка ключа: имя строки после неё — то же, что у прохождения */
const PREFIX: Record<Table, string> = {
  responses: "r",
  answers: "a",
  response_scores: "s",
  answer_events: "e",
  conclusions: "c",
  risk_alerts: "ra",
  alert_cases: "ac",
};
const id = (t: Table, name: string) => `${TAG}-${PREFIX[t]}-${name}`;

let rls: ReturnType<typeof postgres>;
const people: Record<string, Person> = {};

/** Прохождения: имя → методика, человек (null — анонимное) */
const RESPONSES: Record<string, [survey: string, user: string | null]> = {
  A_p1: ["A", "p1"],
  A_anon: ["A", null],
  A2_p2: ["A2", "p2"],
  B_p1: ["B", "p1"],
  B_p3: ["B", "p3"],
  B_admA: ["B", "admA"],
  Draft_p2: ["Draft", "p2"],
  Loose_p3: ["Loose", "p3"],
  Loose_admDraft: ["Loose", "admDraft"],
};
/** Тревоги: имя → прохождение, методика (у mix — не та, что у прохождения) */
const ALERTS: Record<string, [response: string, survey: string]> = {
  A_p1: ["A_p1", "A"],
  B_p3: ["B_p3", "B"],
  Draft_p2: ["Draft_p2", "Draft"],
  Loose_p3: ["Loose_p3", "Loose"],
  mix: ["B_p1", "A"],
};
/** Случаи: имя → методика, человек */
const CASES: Record<string, [survey: string, user: string]> = {
  A_p1: ["A", "p1"],
  B_p3: ["B", "p3"],
  Draft_p2: ["Draft", "p2"],
  Loose_p3: ["Loose", "p3"],
};

const surveyId = (name: string) => `${TAG}-survey-${name}`;
const uid = (who: string) => people[who]!.id;

beforeAll(async () => {
  for (const who of ["admA", "admB", "admAB", "admDraft", "admNone"]) {
    people[who] = await makeUser("admin", `${TAG}-${who}@rls-sets.test`);
  }
  for (const who of ["p1", "p2", "p3"]) people[who] = await makeUser("user", `${TAG}-${who}@rls-sets.test`);

  const gA = `${TAG}-gA`;
  const gB = `${TAG}-gB`;
  await db.execute(sql`insert into survey_groups (id, title, created_by) values
    (${gA}, 'А', ${root.id}), (${gB}, 'Б', ${root.id})`);
  await db.execute(sql`insert into group_admins (group_id, user_id, added_by) values
    (${gA}, ${uid("admA")}, ${root.id}), (${gB}, ${uid("admB")}, ${root.id}),
    (${gA}, ${uid("admAB")}, ${root.id}), (${gB}, ${uid("admAB")}, ${root.id})`);
  const surveyRows: [string, string | null, string][] = [
    ["A", gA, uid("admA")],
    // методика группы, созданная автором личной: создателю без группы она не видна
    ["A2", gA, uid("admDraft")],
    ["B", gB, uid("admB")],
    ["Draft", null, uid("admDraft")],
    ["Loose", null, root.id],
  ];
  for (const [name, group, author] of surveyRows) {
    await db.execute(sql`insert into surveys (id, group_id, title, administration, status, created_by)
      values (${surveyId(name)}, ${group}, ${JSON.stringify({ uk: name })}::jsonb, 'self', 'published', ${author})`);
  }

  // пункт и шкала для внешних ключей — любые существующие: политики на них не смотрят
  const [ref] = (await db.execute(sql`
    select q.id as question, sc.id as scale
      from survey_versions v
      join questions q on q.version_id = v.id
      join scales sc on sc.version_id = v.id
     where v.survey_id = ${surveyInA}
     limit 1`)) as unknown as { question: string; scale: string }[];

  for (const [name, [survey, who]] of Object.entries(RESPONSES)) {
    const user = who ? uid(who) : null;
    await db.execute(sql`insert into responses (id, survey_id, user_id, status, submitted_at)
      values (${id("responses", name)}, ${surveyId(survey)}, ${user}, 'completed', now())`);
    await db.execute(sql`insert into answers (id, response_id, question_id, option_ids)
      values (${id("answers", name)}, ${id("responses", name)}, ${ref!.question}, '[]'::jsonb)`);
    await db.execute(sql`insert into response_scores (id, response_id, scale_id, raw_score, value, max_score, percent)
      values (${id("response_scores", name)}, ${id("responses", name)}, ${ref!.scale}, 1, 1, 3, 33)`);
    await db.execute(sql`insert into answer_events (id, response_id, question_id, sequence, kind, at)
      values (${id("answer_events", name)}, ${id("responses", name)}, ${ref!.question}, 1, 'answer', now())`);
    await db.execute(sql`insert into conclusions (id, response_id, version, text, created_by)
      values (${id("conclusions", name)}, ${id("responses", name)}, 1, 'вывод', ${root.id})`);
  }
  for (const [name, [survey, who]] of Object.entries(CASES)) {
    await db.execute(sql`insert into alert_cases (id, user_id, survey_id, outcome)
      values (${id("alert_cases", name)}, ${uid(who)}, ${surveyId(survey)}, 'resolved')`);
  }
  for (const [name, [response, survey]] of Object.entries(ALERTS)) {
    const who = RESPONSES[response]![1];
    await db.execute(sql`insert into risk_alerts (id, response_id, survey_id, user_id, label, outcome, acknowledged_at)
      values (${id("risk_alerts", name)}, ${id("responses", response)}, ${surveyId(survey)},
              ${who ? uid(who) : null}, 'проверка', 'resolved', now())`);
  }

  rls = (await import("postgres")).default(await rlsRoleUrl(), { max: 1, onnotice: () => {} });
}, 60_000);

afterAll(async () => {
  await rls?.end({ timeout: 1 });
  // тревоги держат прохождение (RESTRICT); случаи — общая очередь, их не оставляем
  await db.execute(sql`delete from risk_alerts where id like ${`${TAG}-%`}`);
  await db.execute(sql`delete from alert_cases where id like ${`${TAG}-%`}`);
  await db.execute(sql`delete from conclusions where id like ${`${TAG}-%`}`);
  await db.execute(sql`delete from responses where id like ${`${TAG}-%`}`);
  await db.execute(sql`delete from surveys where id like ${`${TAG}-%`}`);
  await db.execute(sql`delete from group_admins where group_id like ${`${TAG}-%`}`);
  await db.execute(sql`delete from survey_groups where id like ${`${TAG}-%`}`);
}, 30_000);

/** Контекст запроса: роль и пользователь, как их ставит src/db/context.ts */
type Ctx = { role: string; user: string };

/** Что видно в каждой таблице из мира этого файла — именами строк */
async function visible(ctx: Ctx): Promise<Record<Table, string[]>> {
  const userId = ctx.user ? (people[ctx.user]?.id ?? (ctx.user === "root" ? root.id : ctx.user)) : "";
  return rls.begin(async (tx) => {
    await tx`select set_config('app.role', ${ctx.role}, true), set_config('app.user_id', ${userId}, true)`;
    const out = {} as Record<Table, string[]>;
    for (const t of TABLES) {
      const head = `${TAG}-${PREFIX[t]}-`;
      const rows = await tx.unsafe<{ id: string }[]>(`select id from ${t} where id like $1`, [`${head}%`]);
      out[t] = rows.map((r) => r.id.slice(head.length)).sort();
    }
    return out;
  }) as Promise<Record<Table, string[]>>;
}

const ALL = Object.keys(RESPONSES).sort();
const ALL_ALERTS = Object.keys(ALERTS).sort();
const ALL_CASES = Object.keys(CASES).sort();
const NONE = { responses: [], risk_alerts: [], alert_cases: [] };

/**
 * Ожидание — снято на main (прежние политики 0016/0029/0040) и сверено
 * глазами. Дочерние таблицы — ответы, баллы, события ответов, заключения —
 * на main видны ровно там же, где их прохождение, для каждой роли; поэтому
 * их ожидание — список прохождений, а проверяется каждая таблица отдельно.
 */
const EXPECTED: [label: string, ctx: Ctx, seen: { responses: string[]; risk_alerts: string[]; alert_cases: string[] }][] = [
  ["system", { role: "system", user: "" }, { responses: ALL, risk_alerts: ALL_ALERTS, alert_cases: ALL_CASES }],
  ["superadmin", { role: "superadmin", user: "root" }, { responses: ALL, risk_alerts: ALL_ALERTS, alert_cases: ALL_CASES }],
  // методики группы — свои, кто бы их ни создал; тревога mix видна по своей методике, а не по прохождению
  ["admin A", { role: "admin", user: "admA" }, { responses: ["A2_p2", "A_anon", "A_p1"], risk_alerts: ["A_p1", "mix"], alert_cases: ["A_p1"] }],
  // собственное прохождение методики группы Б администратор A видит как администратор Б — не как «своё»
  ["admin B", { role: "admin", user: "admB" }, { responses: ["B_admA", "B_p1", "B_p3"], risk_alerts: ["B_p3"], alert_cases: ["B_p3"] }],
  [
    "admin A+B",
    { role: "admin", user: "admAB" },
    {
      responses: ["A2_p2", "A_anon", "A_p1", "B_admA", "B_p1", "B_p3"],
      risk_alerts: ["A_p1", "B_p3", "mix"],
      alert_cases: ["A_p1", "B_p3"],
    },
  ],
  // создатель личной методики: только она — не методика группы, которую он создал, и не своё прохождение
  ["admin личной методики", { role: "admin", user: "admDraft" }, { responses: ["Draft_p2"], risk_alerts: ["Draft_p2"], alert_cases: ["Draft_p2"] }],
  ["admin без групп", { role: "admin", user: "admNone" }, NONE],
  ["admin без пользователя", { role: "admin", user: "" }, NONE],
  ["пациент p1", { role: "user", user: "p1" }, { responses: ["A_p1", "B_p1"], risk_alerts: [], alert_cases: [] }],
  ["пациент p2", { role: "user", user: "p2" }, { responses: ["A2_p2", "Draft_p2"], risk_alerts: [], alert_cases: [] }],
  ["пациент p3", { role: "user", user: "p3" }, { responses: ["B_p3", "Loose_p3"], risk_alerts: [], alert_cases: [] }],
  ["роль user с id администратора", { role: "user", user: "admA" }, { responses: ["B_admA"], risk_alerts: [], alert_cases: [] }],
  ["пациент без пользователя", { role: "user", user: "" }, NONE],
  ["без контекста", { role: "", user: "" }, NONE],
  ["незнакомая роль", { role: "kiosk", user: "p1" }, NONE],
];

describe("видимость прохождений и их частей — та же, что на main (#185)", () => {
  test.each(EXPECTED)("%s", async (_label, ctx, seen) => {
    const got = await visible(ctx);
    expect(got.responses).toEqual(seen.responses);
    for (const child of ["answers", "response_scores", "answer_events", "conclusions"] as const) {
      expect({ [child]: got[child] }).toEqual({ [child]: seen.responses });
    }
    expect(got.risk_alerts).toEqual(seen.risk_alerts);
    expect(got.alert_cases).toEqual(seen.alert_cases);
  }, 15_000);
});
