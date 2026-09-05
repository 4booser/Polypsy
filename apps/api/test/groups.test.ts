import { describe, expect, test } from "bun:test";
import { adminA, adminB, api, db, eq, groupA, patient, root, submitSurvey, surveyGroups, surveyInA } from "./fixtures";

/* Группы: администрирование и аналитика отделения */

describe("список групп", () => {
  test("снятая с использования остаётся в списке и помечена", async () => {
    /*
     * Расформированное отделение исчезнуть из списка не должно: за ним
     * остались люди, прохождения и открытые случаи. Пока оно не показано,
     * дороги к ним нет вовсе — а удалить его нельзя, удаление разрешено
     * только пустой группе.
     */
    const created = await api("/api/groups", root.token, {
      method: "POST",
      body: JSON.stringify({ title: "Расформированное отделение" }),
    });
    expect(created.status).toBe(201);
    const id: string = created.body.id;

    const archived = await api(`/api/groups/${id}/archive`, root.token, { method: "POST" });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBe(null);

    const listed = await api("/api/groups", root.token);
    const row = listed.body.items.find((g: { id: string }) => g.id === id);
    expect(row, "снятая группа пропала из списка").toBeTruthy();
    expect(row.archivedAt).not.toBe(null);

    const restored = await api(`/api/groups/${id}/archive`, root.token, {
      method: "POST",
      body: JSON.stringify({ archived: false }),
    });
    expect(restored.status).toBe(200);
    expect(restored.body.archivedAt).toBe(null);

    await db.delete(surveyGroups).where(eq(surveyGroups.id, id));
  });

  test("снятие не отбирает доступ у администраторов группы", async () => {
    /*
     * Снятие — пометка «не предлагать», а не запрет. Если бы оно закрывало
     * доступ, «прибраться в списке» молча отобрало бы у отделения его
     * собственные данные, и узнали бы об этом на первом же разборе.
     */
    await api(`/api/groups/${groupA}/archive`, root.token, { method: "POST" });
    try {
      const surveys = await api("/api/surveys", adminA.token);
      expect(surveys.status).toBe(200);
      expect(
        surveys.body.items.some((s: { id: string }) => s.id === surveyInA),
        "методика снятой группы пропала у её администратора",
      ).toBe(true);
    } finally {
      await api(`/api/groups/${groupA}/archive`, root.token, {
        method: "POST",
        body: JSON.stringify({ archived: false }),
      });
    }
  });

  test("признак «можно вести» не расходится с тем, что разрешает сервер", async () => {
    /*
     * Экран рисует кнопки по этому полю. Разойдись оно с настоящей проверкой
     * права — человек либо жмёт кнопку и получает отказ, либо не видит
     * кнопки, хотя сервер его пропускает. Второе и было: экран смотрел на
     * роль, а право стало выдаваемым.
     */
    for (const person of [root, adminA]) {
      const listed = await api("/api/groups", person.token);
      const row = listed.body.items.find((g: { id: string }) => g.id === groupA);
      if (!row) continue;

      // возврат в работу уже работающей группы ничего не меняет — проверяем только допуск
      const res = await api(`/api/groups/${groupA}/archive`, person.token, {
        method: "POST",
        body: JSON.stringify({ archived: false }),
      });
      expect(res.status === 403, `manageable=${row.manageable}, ответ ${res.status}`).toBe(!row.manageable);
    }
  });
});

describe("аналитика группы", () => {
  test("людей считает по людям, а не по прохождениям", async () => {
    /*
     * Двадцать замеров одного человека читаются как двадцать обследованных
     * ровно до тех пор, пока стоит одно число. Заведующему нужны оба.
     */
    const before = await api(`/api/analytics/groups/${groupA}`, adminA.token);
    expect(before.status).toBe(200);

    await submitSurvey(surveyInA, patient.token);
    await submitSurvey(surveyInA, patient.token);

    const after = await api(`/api/analytics/groups/${groupA}`, adminA.token);
    expect(after.body.responseCount).toBe(before.body.responseCount + 2);
    expect(after.body.patientCount, "повторный замер посчитан вторым человеком").toBe(
      before.body.patientCount === 0 ? 1 : before.body.patientCount,
    );
  });

  test("разбивка по методикам сходится с итогом", async () => {
    const res = await api(`/api/analytics/groups/${groupA}`, adminA.token);
    expect(res.status).toBe(200);
    const sum = res.body.surveys.reduce((n: number, s: { responseCount: number }) => n + s.responseCount, 0);
    expect(sum, "сумма по методикам разошлась с итогом группы").toBe(res.body.responseCount);
    expect(res.body.surveys.some((s: { surveyId: string }) => s.surveyId === surveyInA)).toBe(true);
  });

  test("чужая группа не отдаётся даже с правом на аналитику", async () => {
    // право открывает аналитику, но не расширяет зону ответственности
    const res = await api(`/api/analytics/groups/${groupA}`, adminB.token);
    expect(res.status).toBe(403);
  });
});
