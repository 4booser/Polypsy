import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { renderError } from "@quizzy/shared";
import {
  and,
  api,
  appApi,
  client,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupAdmins,
  makeUser,
  root,
  surveyGroups,
  surveys,
} from "./fixtures";
import {
  auditLog,
  batteries,
  batteryAssignments,
  batteryItems,
  decisionRules,
  responses,
  ruleHits,
  surveyFollowups,
} from "../src/db/schema";

/**
 * Каскад и правила при сдаче: сбой строки журнала откатывает их действие
 * (#145, продолжение).
 *
 * Прежде назначение набора, окна повторов и срабатывание правила
 * фиксировались, а сбой строки журнала о них гасил общий перехват
 * (runCascades, applyRules): действие без следа в журнале. Теперь каждый
 * шаг каскада и каждое срабатывание — своей точкой сохранения: сбой журнала
 * откатывает шаг вместе со строкой, остальное и сдача идут дальше.
 * Взаимоблокировка — наверх: вся сдача получает 503 «повторите», ничего не
 * сохранено, повтор проходит целиком.
 *
 * Сбой журнала — настоящий отказ базы: триггер на audit_log отвергает
 * строку нужного действия для нужного человека. Сдача — ролью приложения.
 */

const tag = crypto.randomUUID().slice(0, 8);
const groupId = crypto.randomUUID();
const surveyId = crypto.randomUUID();
const deepId = crypto.randomUUID();
const batteryId = crypto.randomUUID();
let ruleId: string;
const people: string[] = [];

const l = (uk: string) => ({ uk, ru: uk });

async function publish(id: string, title: string, bands: Record<string, unknown>[]) {
  await db.insert(surveys).values({
    id,
    groupId,
    title: l(title),
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: root.id,
  } as never);
  await createVersion(
    id,
    createSurveySchema.parse({
      title: l(title),
      administration: "self",
      scoringEnabled: true,
      questions: [
        {
          type: "single",
          title: l("Пункт"),
          required: true,
          scaleCode: "S",
          options: [
            { text: l("Так"), score: 1 },
            { text: l("Ні"), score: 0 },
          ],
        },
      ],
      scales: [{ code: "S", title: l("Сума"), kind: "clinical", normalization: "raw", bands }],
    }),
    root.id,
    "v1",
  );
}

beforeAll(async () => {
  // своя группа: правило группы срабатывает только на своей методике
  await db.insert(surveyGroups).values({ id: groupId, title: `Каскад і журнал ${tag}`, createdBy: root.id });
  await db.insert(groupAdmins).values({ groupId, userId: root.id, addedBy: root.id });
  await publish(deepId, `Поглиблена ${tag}`, []);
  await db.insert(batteries).values({ id: batteryId, title: `Набір ${tag}`, groupId, strictOrder: false, createdBy: root.id });
  await db.insert(batteryItems).values([{ batteryId, surveyId: deepId, position: 0, required: true }]);
  // любая сдача попадает в полосу, а на полосе — и набор, и повтор через 7 дней
  await publish(surveyId, `Скринінг ${tag}`, [
    { minScore: 0, maxScore: 1, label: l("Будь-який"), cascadeBatteryId: batteryId, cascadeDueDays: 14, followUpDays: "7" },
  ]);
  const rule = await api("/api/decisions/rules", root.token, {
    method: "POST",
    body: JSON.stringify({
      title: `Порада ${tag}`,
      groupId,
      conditions: [{ kind: "scale", surveyId, scaleCode: "S", metric: "raw", op: ">=", value: 0 }],
      actions: [{ kind: "advise", text: "Поговорити" }],
    }),
  });
  if (rule.status !== 201) throw new Error(`правило не заведено: ${rule.status} ${JSON.stringify(rule.body)}`);
  ruleId = rule.body.id;
}, 30_000);

afterAll(async () => {
  await healAudit();
  // очереди общие: назначения сняты, окна убраны, срабатывания решены, правило выключено
  if (people.length) {
    await db
      .update(batteryAssignments)
      .set({ cancelledAt: new Date().toISOString() })
      .where(inArray(batteryAssignments.userId, people));
    await db.delete(surveyFollowups).where(inArray(surveyFollowups.userId, people));
    await db
      .update(ruleHits)
      .set({ status: "declined", decidedBy: root.id, decidedAt: new Date().toISOString() })
      .where(inArray(ruleHits.userId, people));
  }
  if (ruleId) await db.update(decisionRules).set({ enabled: false }).where(eq(decisionRules.id, ruleId));
});

/** Журнал отвергает строку действия action о человеке subjectId — кодом errcode */
async function failAudit(action: string, subjectId: string, errcode = "P0001") {
  await client.unsafe(`
    create or replace function w20_audit_probe() returns trigger language plpgsql as $$
    begin
      if new.action = '${action}' and new.subject_user_id = '${subjectId}' then
        raise exception 'проба: журнал не принял строку' using errcode = '${errcode}';
      end if;
      return new;
    end $$;
    create trigger w20_audit_probe before insert on audit_log for each row execute function w20_audit_probe();
  `);
}

async function healAudit() {
  await client.unsafe(`
    drop trigger if exists w20_audit_probe on audit_log;
    drop function if exists w20_audit_probe();
  `);
}

async function person() {
  const p = await makeUser("user", `cascade-audit-${crypto.randomUUID().slice(0, 8)}@test.dev`, {
    sex: "female",
    birthDate: "1993-06-06",
  });
  people.push(p.id);
  return p;
}

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };

async function submit(token: string) {
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, token)).body;
  const q = shown.questions[0]!;
  return appApi(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      versionId: shown.versionId,
      answers: [{ questionId: q.id, optionIds: [q.options[0]!.id], durationMs: 1000, changeCount: 0, visitCount: 1 }],
    }),
  });
}

/** Что после сдачи лежит в базе о человеке: действия автоматики и их строки журнала */
async function stateOf(userId: string) {
  const assigned = await db
    .select({ id: batteryAssignments.id })
    .from(batteryAssignments)
    .where(and(eq(batteryAssignments.userId, userId), eq(batteryAssignments.batteryId, batteryId)));
  const windows = await db
    .select({ id: surveyFollowups.id })
    .from(surveyFollowups)
    .where(and(eq(surveyFollowups.userId, userId), eq(surveyFollowups.surveyId, surveyId)));
  const hits = await db.select({ id: ruleHits.id }).from(ruleHits).where(eq(ruleHits.userId, userId));
  const logged = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.subjectUserId, userId),
        inArray(auditLog.action, ["cascade.assign", "cascade.followup", "rule.hit", "response.submit"]),
      ),
    );
  const count = (action: string) => logged.filter((r) => r.action === action).length;
  const completed = await db
    .select({ id: responses.id })
    .from(responses)
    .where(and(eq(responses.userId, userId), eq(responses.status, "completed")));
  return {
    assigned: assigned.length,
    assignLogged: count("cascade.assign"),
    windows: windows.length,
    followupLogged: count("cascade.followup"),
    hits: hits.length,
    hitLogged: count("rule.hit"),
    submitted: completed.length,
    submitLogged: count("response.submit"),
  };
}

describe("каскад и правила: сбой строки журнала откатывает действие (#145)", () => {
  test("журнал не принял cascade.assign: назначения нет, повтор и правило на месте, сдача прошла", async () => {
    const p = await person();
    await failAudit("cascade.assign", p.id);
    let res: Awaited<ReturnType<typeof submit>>;
    try {
      res = await submit(p.token);
    } finally {
      await healAudit();
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cascade.assignedBatteries, "в ответе — набор, которого нет").toEqual([]);
    expect(await stateOf(p.id)).toEqual({
      assigned: 0,
      assignLogged: 0,
      windows: 1,
      followupLogged: 1,
      hits: 1,
      hitLogged: 1,
      submitted: 1,
      submitLogged: 1,
    });
  }, 30_000);

  test("журнал не принял rule.hit: срабатывания нет, каскад на месте, сдача прошла", async () => {
    const p = await person();
    await failAudit("rule.hit", p.id);
    let res: Awaited<ReturnType<typeof submit>>;
    try {
      res = await submit(p.token);
    } finally {
      await healAudit();
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stateOf(p.id)).toEqual({
      assigned: 1,
      assignLogged: 1,
      windows: 1,
      followupLogged: 1,
      hits: 0,
      hitLogged: 0,
      submitted: 1,
      submitLogged: 1,
    });
  }, 30_000);

  test("взаимоблокировка на строке cascade.followup: вся сдача — 503, ничего не сохранено, повтор проходит целиком", async () => {
    const p = await person();
    await failAudit("cascade.followup", p.id, "40P01");
    let res: Awaited<ReturnType<typeof submit>>;
    try {
      res = await submit(p.token);
    } finally {
      await healAudit();
    }
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.error).toBe(renderError("err.retryRequest", "uk"));
    expect(await stateOf(p.id)).toEqual({
      assigned: 0,
      assignLogged: 0,
      windows: 0,
      followupLogged: 0,
      hits: 0,
      hitLogged: 0,
      submitted: 0,
      submitLogged: 0,
    });

    const again = await submit(p.token);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await stateOf(p.id)).windows).toBe(1);
  }, 30_000);

  test("контроль: журнал принимает всё — назначение, повтор, срабатывание и их строки на месте", async () => {
    const p = await person();
    const res = await submit(p.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cascade.assignedBatteries.length).toBe(1);
    expect(await stateOf(p.id)).toEqual({
      assigned: 1,
      assignLogged: 1,
      windows: 1,
      followupLogged: 1,
      hits: 1,
      hitLogged: 1,
      submitted: 1,
      submitLogged: 1,
    });
  }, 30_000);
});
