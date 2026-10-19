import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ERRORS, type ErrorKey } from "@quizzy/shared";
import {
  adminA,
  adminB,
  api,
  appApi,
  db,
  eq,
  groupA,
  groupB,
  makeUser,
  root,
  submitSurvey,
  surveyInA,
  surveys,
  type Person,
} from "./fixtures";
import { decisionRules, groupAdmins, permissionExceptions } from "../src/db/schema";

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
    expect(again.status).toBe(409);
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

/**
 * Зона правил и версия правки.
 *
 * Правило действует на прохождения своей группы. Завести или перенести его
 * можно только в группу, которой управляешь, как методику
 * (routes/surveys.ts); правило чужой группы для правки «не найдено», как в
 * перечне. Прежде маршрут принимал любую группу: владелец базы такую
 * вставку пропускал, а под ролью приложения её отвергала политика строк —
 * пятисоткой. Поэтому каждая проверка идёт и владельцем базы, и под ролью
 * приложения.
 *
 * Версия: правка от устаревшей версии — 409, а не тихая перезапись.
 *
 * Мутации: убрать assertGroupAccess из POST или PATCH, проверку зоны правила
 * в PATCH или сверку версии в UPDATE — падает своя проверка.
 */
describe("правила: зона группы и версия правки", () => {
  let manager: Person;
  beforeAll(async () => {
    manager = await makeUser("admin", `rules-zone-${crypto.randomUUID()}@test`);
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: manager.id,
      permission: "decisions.manage",
      mode: "grant",
      reason: "Веде моделі аналітики відділення",
      grantedBy: root.id,
    });
    await db.insert(groupAdmins).values({ groupId: groupA, userId: manager.id, addedBy: root.id });
  });

  /* выключенным: правило этого блока не должно срабатывать в чужих проверках */
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      title: "Зональне правило",
      enabled: false,
      conditions: [{ kind: "risk", severity: "severe" }],
      actions: [{ kind: "notify_duty" }],
      ...over,
    });
  const expectRefusal = (res: { status: number; body: { error?: string } }, status: number, key: ErrorKey) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(String(res.body?.error ?? ""), `ждали отказ ${key}`).toContain(ERRORS[key].uk.split("{")[0]!.trim());
  };
  const rootRule = async (groupId: string) => {
    const res = await api("/api/decisions/rules", root.token, { method: "POST", body: body({ groupId }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const ruleRow = async (id: string) => (await db.select().from(decisionRules).where(eq(decisionRules.id, id)))[0]!;

  for (const [how, call] of [
    ["владельцем базы", api],
    ["под ролью приложения", appApi],
  ] as const) {
    test(`заводится только в свою группу или общим (${how})`, async () => {
      const own = await call("/api/decisions/rules", manager.token, { method: "POST", body: body({ groupId: groupA }) });
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      const general = await call("/api/decisions/rules", manager.token, { method: "POST", body: body() });
      expect(general.status, JSON.stringify(general.body)).toBe(201);

      const foreign = await call("/api/decisions/rules", manager.token, { method: "POST", body: body({ groupId: groupB }) });
      expectRefusal(foreign, 403, "err.groupNotManaged");

      // суперадмин заводит в любую
      const byRoot = await call("/api/decisions/rules", root.token, { method: "POST", body: body({ groupId: groupB }) });
      expect(byRoot.status, JSON.stringify(byRoot.body)).toBe(201);
    });

    test(`правило чужой группы не правится, своё не переносится в чужую (${how})`, async () => {
      const foreign = await rootRule(groupB);
      const seized = await call(`/api/decisions/rules/${foreign}`, manager.token, {
        method: "PATCH",
        body: JSON.stringify({ title: "Захоплено" }),
      });
      expectRefusal(seized, 404, "err.ruleNotFound");
      expect((await ruleRow(foreign)).title).toBe("Зональне правило");

      const own = await rootRule(groupA);
      const moved = await call(`/api/decisions/rules/${own}`, manager.token, {
        method: "PATCH",
        body: JSON.stringify({ groupId: groupB }),
      });
      expectRefusal(moved, 403, "err.groupNotManaged");
      expect(await ruleRow(own)).toMatchObject({ groupId: groupA, version: 1 });

      const renamed = await call(`/api/decisions/rules/${own}`, manager.token, {
        method: "PATCH",
        body: JSON.stringify({ title: "Своє" }),
      });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

      // суперадмин переносит куда угодно
      const byRoot = await call(`/api/decisions/rules/${own}`, root.token, {
        method: "PATCH",
        body: JSON.stringify({ groupId: groupB }),
      });
      expect(byRoot.status, JSON.stringify(byRoot.body)).toBe(200);
      expect((await ruleRow(own)).groupId).toBe(groupB);
    });

    test(`правка от устаревшей версии — 409, от своей — ложится (${how})`, async () => {
      const id = await rootRule(groupA);
      const first = await call(`/api/decisions/rules/${id}`, manager.token, {
        method: "PATCH",
        body: JSON.stringify({ title: "Перша", version: 1 }),
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.version).toBe(2);

      const stale = await call(`/api/decisions/rules/${id}`, manager.token, {
        method: "PATCH",
        body: JSON.stringify({ title: "Друга", version: 1 }),
      });
      expectRefusal(stale, 409, "err.ruleChanged");
      expect(await ruleRow(id), "правка от старой версии стёрла новую").toMatchObject({ title: "Перша", version: 2 });

      // без версии — последняя правка побеждает, как прежде; номер — следующий, а не повтор
      const blind = await call(`/api/decisions/rules/${id}`, manager.token, {
        method: "PATCH",
        body: JSON.stringify({ title: "Третя" }),
      });
      expect(blind.status).toBe(200);
      expect(blind.body.version).toBe(3);
    });
  }

  test("две правки от одной версии разом: одна ложится, другая — 409", async () => {
    const id = await rootRule(groupA);
    const edit = (title: string) =>
      api(`/api/decisions/rules/${id}`, manager.token, { method: "PATCH", body: JSON.stringify({ title, version: 1 }) });
    const [a, b] = await Promise.all([edit("А"), edit("Б")]);
    expect([a.status, b.status].sort(), "обе правки легли от одной версии").toEqual([200, 409]);
    expect((await ruleRow(id)).version).toBe(2);
  });
});
