import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, adminB, api, app, db, eq, makeUser, patient, submitSurvey, surveyInA, surveys } from "./fixtures";

/* Клинические документы: заключения, направления, консилиум */

/* ── заключения ── */

describe("заключение специалиста", () => {
  let responseId: string;

  beforeAll(async () => {
    const res = await submitSurvey(surveyInA, patient.token);
    responseId = res.body.id;
  });

  test("черновик правится на месте, подпись фиксирует версию", async () => {
    const first = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Первый вариант" }),
    });
    expect(first.body.current.version).toBe(1);

    const edited = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Отредактированный вариант" }),
    });
    // черновик правится, версия не растёт
    expect(edited.body.current.version).toBe(1);
    expect(edited.body.versions.length).toBe(1);

    const signed = await api(`/api/conclusions/responses/${responseId}/conclusion/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(signed.body.current.status).toBe("signed");

    // повторная подпись — отказ
    const again = await api(`/api/conclusions/responses/${responseId}/conclusion/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(again.status).toBe(400);
  });

  test("правка после подписи создаёт версию 2 черновиком; подписанное неизменно", async () => {
    const v2 = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Дополнение после подписи" }),
    });
    expect(v2.body.current.version).toBe(2);
    expect(v2.body.current.status).toBe("draft");
    const v1 = v2.body.versions.find((v: { version: number }) => v.version === 1);
    expect(v1.status).toBe("signed");
    expect(v1.text).toBe("Отредактированный вариант");
  });

  test("в печатный отчёт попадает только подписанная версия", async () => {
    // текущая версия 2 — черновик; отчёт не должен её показывать,
    // но и подписанную v1 показывать не должен: последняя версия не подписана.
    // Контракт: отчёт берёт ПОСЛЕДНЮЮ версию и включает её только если она подписана
    const res = await app.request(`/api/reports/responses/${responseId}`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const html = await res.text();
    expect(html).not.toContain("Дополнение после подписи");

    // подпишем v2 — теперь она в отчёте
    await api(`/api/conclusions/responses/${responseId}/conclusion/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    const res2 = await app.request(`/api/reports/responses/${responseId}`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const html2 = await res2.text();
    expect(html2).toContain("Дополнение после подписи");
    expect(html2).toContain("Распечатано:");
  });

  test("правка поверх устаревшей версии отклоняется, а не затирает чужую", async () => {
    /*
     * Двое открывают заключение одновременно. Первый сохраняет, второй ещё
     * держит на экране прежний текст. Без сверки версии его «сохранить»
     * молча уничтожило бы работу первого — и никто бы не заметил.
     */
    const fresh = await submitSurvey(surveyInA, patient.token);
    const rid = fresh.body.id;

    await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Текст первого специалиста", baseVersion: 0 }),
    });

    // второй правит, считая, что заключения ещё нет
    const stale = await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Текст второго специалиста", baseVersion: 0 }),
    });
    expect(stale.status).toBe(409);

    const state = await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token);
    expect(state.body.current.text).toBe("Текст первого специалиста");
  });

  test("подписывается только та версия, что была на экране", async () => {
    /*
     * Между открытием экрана и нажатием «подписать» текст успел смениться.
     * Подпись удостоверяет содержание — подписать неувиденное нельзя.
     */
    const fresh = await submitSurvey(surveyInA, patient.token);
    const rid = fresh.body.id;

    await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Версия 1", baseVersion: 0 }),
    });
    await api(`/api/conclusions/responses/${rid}/conclusion/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    // поверх подписанной легла новая версия — её специалист не видел
    await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Версия 2, чужая", baseVersion: 1 }),
    });

    const blind = await api(`/api/conclusions/responses/${rid}/conclusion/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(blind.status).toBe(409);

    const state = await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token);
    expect(state.body.current.status).toBe("draft");
  });

  test("одновременные первые сохранения не дают двух версий с одним номером", async () => {
    /*
     * Уникальный индекс не даст записать дубль, но пользователь получил бы
     * пятисотку. Консультативная блокировка выстраивает их в очередь:
     * один создаёт версию 1, второй упирается в проверку версии.
     */
    const fresh = await submitSurvey(surveyInA, patient.token);
    const rid = fresh.body.id;

    const both = await Promise.all([
      api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token, {
        method: "PUT",
        body: JSON.stringify({ text: "Одновременно А", baseVersion: 0 }),
      }),
      api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token, {
        method: "PUT",
        body: JSON.stringify({ text: "Одновременно Б", baseVersion: 0 }),
      }),
    ]);

    const codes = both.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);

    const state = await api(`/api/conclusions/responses/${rid}/conclusion`, adminA.token);
    expect(state.body.versions).toHaveLength(1);
  });

  test("чужой админ не достаёт заключение", async () => {
    const res = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminB.token);
    expect(res.status).toBe(404);
  });
});

/* ── направления и сводка консилиума ── */

describe("направления", () => {
  let referralId: string;

  test("выписывается пациенту; статусы движутся только вперёд", async () => {
    const created = await api("/api/referrals", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        userId: patient.id,
        destination: "psychiatrist",
        urgency: "urgent",
        reason: "Повышенный риск по СР-45",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("created");
    expect(created.body.userName).toContain("Тест");
    referralId = created.body.id;

    // created → completed напрямую нельзя: сначала принять
    const skip = await api(`/api/referrals/${referralId}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
    });
    expect(skip.status).toBe(400);

    const accepted = await api(`/api/referrals/${referralId}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "accepted", outcomeNote: "Принято психиатром" }),
    });
    expect(accepted.body.status).toBe("accepted");

    const done = await api(`/api/referrals/${referralId}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
    });
    expect(done.body.status).toBe("completed");

    // завершённое не откатывается
    const rollback = await api(`/api/referrals/${referralId}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "accepted" }),
    });
    expect(rollback.status).toBe(400);
  });

  test("направление сотруднику не выписывается", async () => {
    const res = await api("/api/referrals", adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: adminB.id, destination: "outpatient" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("сводка консилиума", () => {
  test("собирает баллы, тревоги, заключения и направления в одном ответе", async () => {
    const res = await api(`/api/referrals/summary/${patient.id}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.fullName).toContain("Тест");
    expect(res.body.surveys.length).toBeGreaterThan(0);

    const withScales = res.body.surveys.find(
      (s: { scales: unknown[] }) => s.scales.length > 0,
    );
    expect(withScales).toBeDefined();
    expect(withScales.scales[0].lastValue).toBeGreaterThanOrEqual(0);

    // подписанное заключение из более раннего теста попало в сводку
    expect(res.body.conclusions.length).toBeGreaterThan(0);
    expect(res.body.conclusions[0].text.length).toBeGreaterThan(0);

    // направление из предыдущего describe — здесь же
    expect(res.body.referrals.length).toBeGreaterThan(0);
    expect(res.body.referrals[0].status).toBe("completed");

    // чтение всей карты фиксируется в журнале
    const { auditLog } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectUserId, patient.id))
      .orderBy(descOp(auditLog.at))
      .limit(1);
    expect((entry!.details as { view?: string }).view).toBe("case_summary");
  });

  test("чужой админ сводку не получает", async () => {
    const res = await api(`/api/referrals/summary/${patient.id}`, adminB.token);
    expect(res.status).toBe(404);
  });
});

/* ── хронология ── */

describe("хронология пациента", () => {
  test("события всех видов на одной оси, свежие сверху", async () => {
    const person = await makeUser("user", `tl-${crypto.randomUUID()}@test`, { unit: "Рота Т" });
    const done = await submitSurvey(surveyInA, person.token);

    await api(`/api/conclusions/responses/${done.body.id}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Заключение для хронологии", baseVersion: 0 }),
    });
    await api("/api/referrals", adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, destination: "psychiatrist", reason: "хронология" }),
    });

    const res = await api(`/api/timeline/${person.id}`, adminA.token);
    expect(res.status).toBe(200);

    const kinds = res.body.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toContain("response");
    expect(kinds).toContain("conclusion");
    expect(kinds).toContain("referral");

    // порядок — от свежего к старому: историю читают с конца
    const times = res.body.items.map((i: { at: string }) => i.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("чужой админ хронологию не получает", async () => {
    /*
     * Ответ «пациента нет» здесь честный: вне зоны ответственности его
     * действительно нет, а «есть, но не покажу» раскрывало бы сам факт
     * обследования человека.
     */
    const person = await makeUser("user", `tl-foreign-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const res = await api(`/api/timeline/${person.id}`, adminB.token);
    expect(res.status).toBe(404);
  });

  test("обращение к хронологии попадает в журнал", async () => {
    // хронология — это чтение карты; такие обращения фиксируются наравне с ней
    const { auditLog } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");
    const person = await makeUser("user", `tl-audit-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    await api(`/api/timeline/${person.id}`, adminA.token);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectUserId, person.id))
      .orderBy(descOp(auditLog.at))
      .limit(1);
    expect(entry!.action).toBe("response.read");
    expect((entry!.details as { view?: string }).view).toBe("timeline");
  });
});
