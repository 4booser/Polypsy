import { describe, expect, test } from "bun:test";
import { adminA, adminB, api, db, eq, makeUser, root, submitSurvey, surveyInA } from "./fixtures";
import { breakGlass } from "../src/db/schema";

/**
 * «Разбить стекло».
 *
 * Проверяется то, ради чего механизм существует, и то, что мешает ему стать
 * дырой: доступ появляется сразу, но громко, ограниченно по времени и только
 * к тому человеку, ради которого его брали.
 */

async function foreignPatient() {
  const person = await makeUser("user", `bg-${crypto.randomUUID()}@test`);
  await submitSurvey(surveyInA, person.token);
  return person;
}

const open = (patientId: string, token: string, reason = "Ночное поступление, дежурный психолог недоступен") =>
  api("/api/break-glass", token, {
    method: "POST",
    body: JSON.stringify({ patientId, reason }),
  });

describe("открытие доступа", () => {
  test("обоснование обязательно и не бывает коротким", async () => {
    /*
     * Не выпадающий список: список превращается в «выбрать первое», а
     * написанное словами обоснование читают.
     */
    const person = await foreignPatient();
    const bare = await open(person.id, adminB.token, "надо");
    expect(bare.status).toBe(400);
  });

  test("доступ открывается сразу и виден в своём списке", async () => {
    /*
     * Замедлять сам доступ значит наказывать за неотложность. Неудобно ровно
     * одно место — обоснование.
     */
    const person = await foreignPatient();
    const made = await open(person.id, adminB.token);
    expect(made.status).toBe(201);
    expect(made.body.windowHours).toBe(8);

    const mine = await api("/api/break-glass/mine", adminB.token);
    expect(mine.body.items.some((i: { patientId: string }) => i.patientId === person.id)).toBe(true);
  });

  test("данные пациента становятся видны", async () => {
    const person = await foreignPatient();

    const before = await api(`/api/dynamics/respondents/${person.id}`, adminB.token);
    expect(before.status).toBe(404);

    await open(person.id, adminB.token);

    const after = await api(`/api/dynamics/respondents/${person.id}`, adminB.token);
    expect(after.status).toBe(200);
    expect(after.body.surveys.length).toBeGreaterThan(0);
  });

  test("открывается только тот человек, ради которого разбивали", async () => {
    /*
     * Открывать группу целиком значило бы дать доступ ко всем её пациентам
     * ради одного, а обоснование писалось про одного.
     */
    const person = await foreignPatient();
    const other = await foreignPatient();

    await open(person.id, adminB.token);

    expect((await api(`/api/dynamics/respondents/${person.id}`, adminB.token)).status).toBe(200);
    expect((await api(`/api/dynamics/respondents/${other.id}`, adminB.token)).status).toBe(404);
  });

  test("нельзя разбить стекло там, где доступ и так есть", async () => {
    /*
     * Иначе запись «разбил стекло» появлялась бы там, где ничего не
     * обходили, и в журнале стало бы невозможно отличить настоящий обход от
     * привычки нажимать кнопку.
     */
    const person = await foreignPatient();
    const pointless = await open(person.id, adminA.token);
    expect(pointless.status).toBe(400);
  });

  test("стекло разбивают ради пациента, а не сотрудника", async () => {
    const wrong = await open(adminA.id, adminB.token);
    expect(wrong.status).toBe(400);
  });
});

describe("срок и закрытие", () => {
  test("истёкший доступ перестаёт работать", async () => {
    const person = await foreignPatient();
    const made = await open(person.id, adminB.token);
    expect((await api(`/api/dynamics/respondents/${person.id}`, adminB.token)).status).toBe(200);

    // отматываем срок в прошлое
    await db
      .update(breakGlass)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(breakGlass.id, made.body.id));

    expect((await api(`/api/dynamics/respondents/${person.id}`, adminB.token)).status).toBe(404);
  });

  test("закрытый досрочно перестаёт работать сразу", async () => {
    const person = await foreignPatient();
    const made = await open(person.id, adminB.token);

    const closed = await api(`/api/break-glass/${made.body.id}/close`, adminB.token, {
      method: "POST",
    });
    expect(closed.status).toBe(200);
    expect((await api(`/api/dynamics/respondents/${person.id}`, adminB.token)).status).toBe(404);
  });

  test("чужой доступ закрывает только суперадмин", async () => {
    const person = await foreignPatient();
    const made = await open(person.id, adminB.token);

    const denied = await api(`/api/break-glass/${made.body.id}/close`, adminA.token, {
      method: "POST",
    });
    expect(denied.status).toBe(400);

    const bySuper = await api(`/api/break-glass/${made.body.id}/close`, root.token, {
      method: "POST",
    });
    expect(bySuper.status).toBe(200);
  });
});

describe("громкость", () => {
  test("случай виден всем сотрудникам, а не только суперадмину", async () => {
    /*
     * Обход правил, о котором знает один человек, ничем не лучше тихого.
     */
    const person = await foreignPatient();
    const made = await open(person.id, adminB.token);

    const byOther = await api("/api/break-glass", adminA.token);
    const found = byOther.body.items.find((i: { id: string }) => i.id === made.body.id);
    expect(found).toBeTruthy();
    expect(found.reason).toContain("Ночное поступление");
    expect(found.actorName).toBeTruthy();
  });

  test("открытие попадает в журнал отдельным действием", async () => {
    const person = await foreignPatient();
    await open(person.id, adminB.token, "Массовое поступление, карта в чужой группе");

    const log = await api("/api/audit?action=breakglass.open&limit=10", root.token);
    const entry = log.body.entries.find(
      (e: { subjectUserId: string | null }) => e.subjectUserId === person.id,
    );
    expect(entry).toBeTruthy();
    expect((entry.details as { reason: string }).reason).toContain("Массовое поступление");
  });
});

describe("границы разбитого стекла", () => {
  test("не открывает методику целиком", async () => {
    /*
     * Ровно эта утечка и была в первой версии: доступ добавлялся прямо в
     * общий фильтр методик, и стекло, разбитое ради одного пациента,
     * открывало методику — а всё, что фильтрует по методике, а не по
     * человеку (когорты, аналитика, списки), начинало показывать чужих.
     * Обоснование писалось про одного, доступ получался ко всем.
     */
    const target = await foreignPatient();
    const bystander = await foreignPatient();

    await open(target.id, adminB.token);

    // тот, ради кого разбивали, — виден
    expect((await api(`/api/dynamics/respondents/${target.id}`, adminB.token)).status).toBe(200);

    // соседи по той же методике — нет, ни поимённо, ни в агрегате
    expect((await api(`/api/dynamics/respondents/${bystander.id}`, adminB.token)).status).toBe(404);

    const cohort = await api("/api/cohorts/preview", adminB.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA }),
    });
    expect(cohort.status).toBe(400);

    const list = await api("/api/dynamics/respondents", adminB.token);
    expect(list.body.items.some((r: { userId: string }) => r.userId === bystander.id)).toBe(false);
  });
});
