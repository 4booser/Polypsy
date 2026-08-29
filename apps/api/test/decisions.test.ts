import { afterAll, describe, expect, test } from "bun:test";
import { adminA, adminB, api, db, eq, makeUser, root, submitSurvey, surveyInA, surveys } from "./fixtures";
import { decisionRules } from "../src/db/schema";

/**
 * Поддержка решений.
 *
 * Главное, что здесь проверяется, — что система ничего не решает сама:
 * срабатывание правила это строка «предложено», а не выполненное действие.
 */

/*
 * Правила действуют на все прохождения, поэтому оставленное включённым правило
 * начало бы создавать предложения в других файлах тестов — и «предложений нет»
 * там перестало бы что-либо значить.
 */
afterAll(async () => {
  await db.update(decisionRules).set({ enabled: false });
});

async function makeRule(over: Record<string, unknown> = {}) {
  const survey = await api(`/api/surveys/${surveyInA}`, adminA.token);
  const scale = survey.body.scales[0].code;
  const res = await api("/api/decisions/rules", root.token, {
    method: "POST",
    body: JSON.stringify({
      title: "Тестовое правило",
      conditions: [
        { kind: "scale", surveyId: surveyInA, scaleCode: scale, metric: "raw", op: ">=", value: -1 },
      ],
      actions: [{ kind: "notify_duty" }],
      ...over,
    }),
  });
  return { id: res.body.id as string, status: res.status, scale };
}

describe("правила поддержки решений", () => {
  test("правило заводит только суперадмин", async () => {
    const denied = await api("/api/decisions/rules", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Чужое",
        conditions: [{ kind: "risk", severity: "moderate" }],
        actions: [{ kind: "notify_duty" }],
      }),
    });
    expect(denied.status).toBe(403);
  });

  test("сработавшее правило становится предложением, а не действием", async () => {
    const rule = await makeRule();
    expect(rule.status).toBe(201);

    const person = await makeUser("user", `rule-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const hits = await api("/api/decisions/hits", adminA.token);
    const mine = hits.body.items.filter((h: { userId: string }) => h.userId === person.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].status).toBe("suggested");
    // объяснение — не «сработало», а с числами
    expect(mine[0].explanation.because[0].text).toContain(rule.scale);
  });

  test("правка правила поднимает версию, срабатывание держит свою", async () => {
    /*
     * Правило потом поправят, а объяснение должно остаться верным для случая,
     * который уже разобрали.
     */
    const rule = await makeRule();
    const person = await makeUser("user", `rule2-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const before = await api("/api/decisions/hits", adminA.token);
    const hit = before.body.items.find((h: { userId: string }) => h.userId === person.id);
    expect(hit.ruleVersion).toBe(1);

    const patched = await api(`/api/decisions/rules/${rule.id}`, root.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Переименовано" }),
    });
    expect(patched.body.version).toBe(2);

    const after = await api("/api/decisions/hits", adminA.token);
    const same = after.body.items.find((h: { id: string }) => h.id === hit.id);
    expect(same.ruleVersion).toBe(1);
  });

  test("отклонение требует объяснения, принятие — нет", async () => {
    await makeRule();
    const person = await makeUser("user", `rule3-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const hits = await api("/api/decisions/hits", adminA.token);
    const list = hits.body.items.filter((h: { userId: string }) => h.userId === person.id);
    expect(list.length).toBeGreaterThan(1);

    const bare = await api(`/api/decisions/hits/${list[0].id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "declined" }),
    });
    expect(bare.status).toBe(400);

    const explained = await api(`/api/decisions/hits/${list[0].id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "declined", note: "Пациент уже на маршруте" }),
    });
    expect(explained.status).toBe(200);

    const accepted = await api(`/api/decisions/hits/${list[1].id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "accepted" }),
    });
    expect(accepted.status).toBe(200);
  });

  test("решение принимается один раз", async () => {
    await makeRule();
    const person = await makeUser("user", `rule4-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const hits = await api("/api/decisions/hits", adminA.token);
    const one = hits.body.items.find((h: { userId: string }) => h.userId === person.id);

    await api(`/api/decisions/hits/${one.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "accepted" }),
    });
    const again = await api(`/api/decisions/hits/${one.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "declined", note: "передумал" }),
    });
    expect(again.status).toBe(400);
  });

  test("чужой админ предложений по чужой методике не видит", async () => {
    await makeRule();
    const person = await makeUser("user", `rule5-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const hits = await api("/api/decisions/hits", adminB.token);
    expect(hits.body.items.some((h: { userId: string }) => h.userId === person.id)).toBe(false);
  });

  test("выключенное правило не срабатывает", async () => {
    const rule = await makeRule();
    await api(`/api/decisions/rules/${rule.id}`, root.token, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    // выключаем все прочие тестовые правила, чтобы проверять именно это
    const all = await api("/api/decisions/rules", root.token);
    for (const r of all.body.items) {
      if (r.enabled) {
        await api(`/api/decisions/rules/${r.id}`, root.token, {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        });
      }
    }

    const person = await makeUser("user", `rule6-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const hits = await api("/api/decisions/hits", adminA.token);
    expect(hits.body.items.some((h: { userId: string }) => h.userId === person.id)).toBe(false);
  });
});

describe("дежурная смена", () => {
  test("сейчас на смене видно, прошедшая — нет", async () => {
    const now = Date.now();
    const on = await api("/api/decisions/duty", root.token, {
      method: "POST",
      body: JSON.stringify({
        userId: adminA.id,
        startsAt: new Date(now - 3_600_000).toISOString(),
        endsAt: new Date(now + 3_600_000).toISOString(),
      }),
    });
    expect(on.status).toBe(201);

    await api("/api/decisions/duty", root.token, {
      method: "POST",
      body: JSON.stringify({
        userId: adminB.id,
        startsAt: new Date(now - 7_200_000).toISOString(),
        endsAt: new Date(now - 3_600_000).toISOString(),
      }),
    });

    const duty = await api("/api/decisions/duty", adminA.token);
    const ids = duty.body.items.map((d: { userId: string }) => d.userId);
    expect(ids).toContain(adminA.id);
    expect(ids).not.toContain(adminB.id);
  });

  test("смена, кончающаяся раньше, чем начинается, не заводится", async () => {
    const now = Date.now();
    const bad = await api("/api/decisions/duty", root.token, {
      method: "POST",
      body: JSON.stringify({
        userId: adminA.id,
        startsAt: new Date(now + 3_600_000).toISOString(),
        endsAt: new Date(now).toISOString(),
      }),
    });
    expect(bad.status).toBe(400);
  });

  test("групповой админ ставит на смену только себя", async () => {
    const now = Date.now();
    const other = await api("/api/decisions/duty", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        userId: adminB.id,
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + 3_600_000).toISOString(),
      }),
    });
    expect(other.status).toBe(400);

    const self = await api("/api/decisions/duty", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        userId: adminA.id,
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + 3_600_000).toISOString(),
      }),
    });
    expect(self.status).toBe(201);
  });
});

describe("кризисный режим", () => {
  test("включается один раз, выключается, и всё это в журнале", async () => {
    const on = await api("/api/decisions/crisis", root.token, {
      method: "POST",
      body: JSON.stringify({ reason: "Массовое поступление, учения" }),
    });
    expect(on.status).toBe(201);

    // второй раз включить нельзя: два открытых периода означали бы, что
    // выключение одного не выключает режим
    const again = await api("/api/decisions/crisis", root.token, {
      method: "POST",
      body: JSON.stringify({ reason: "ещё раз" }),
    });
    expect(again.status).toBe(400);

    const state = await api("/api/decisions/crisis", adminA.token);
    expect(state.body.active).toBe(true);
    expect(state.body.reason).toBe("Массовое поступление, учения");

    const off = await api("/api/decisions/crisis", root.token, { method: "DELETE" });
    expect(off.status).toBe(200);
    expect((await api("/api/decisions/crisis", adminA.token)).body.active).toBe(false);
  });

  test("включает только суперадмин", async () => {
    const denied = await api("/api/decisions/crisis", adminA.token, {
      method: "POST",
      body: JSON.stringify({ reason: "самовольно" }),
    });
    expect(denied.status).toBe(403);
  });

  test("плановые расписания в кризис не запускаются", async () => {
    /*
     * В массовое поступление очередь работы должна наполняться поступившими,
     * а не напоминаниями трёхмесячной давности. Сроки при этом не сдвигаются:
     * пропущенный тик — отложенный замер, а не отменённый.
     */
    const { runDueSchedules } = await import("./fixtures");
    await api("/api/decisions/crisis", root.token, {
      method: "POST",
      body: JSON.stringify({ reason: "Проверка планировщика" }),
    });

    const handled = await runDueSchedules(new Date());
    expect(handled).toBe(0);

    await api("/api/decisions/crisis", root.token, { method: "DELETE" });
  });

  test("очередь работы перестраивается по тяжести", async () => {
    const before = await api("/api/worklist", adminA.token);
    expect(before.body.crisis).toBe(false);

    await api("/api/decisions/crisis", root.token, {
      method: "POST",
      body: JSON.stringify({ reason: "Проверка очереди" }),
    });

    const during = await api("/api/worklist", adminA.token);
    expect(during.body.crisis).toBe(true);
    // случаи риска впереди всего остального
    const kinds = during.body.items.map((i: { kind: string }) => i.kind);
    const lastCase = kinds.lastIndexOf("case");
    const firstOther = kinds.findIndex((k: string) => k !== "case");
    if (lastCase >= 0 && firstOther >= 0) expect(lastCase).toBeLessThan(firstOther);

    // состав очереди тот же: режим ничего не скрывает
    expect(during.body.total).toBe(before.body.total);

    await api("/api/decisions/crisis", root.token, { method: "DELETE" });
  });
});
