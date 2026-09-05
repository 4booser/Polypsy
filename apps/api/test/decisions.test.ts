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
