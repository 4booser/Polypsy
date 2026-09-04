import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, adminB, api, app, db, eq, makeUser, patient, root, submitSurvey, surveyInA, surveys } from "./fixtures";
import { textTemplates } from "../src/db/schema";

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

/* ── маршруты помощи ── */

/* ── заметки приёма ── */

describe("заметка приёма", () => {
  test("черновик правится на месте, подпись фиксирует версию", async () => {
    const person = await makeUser("user", `note-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const first = await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Первичная беседа", kind: "intake", baseVersion: 0 }),
    });
    expect(first.body.current.version).toBe(1);
    expect(first.body.current.kind).toBe("intake");

    const edited = await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Первичная беседа, дополнено", baseVersion: 1 }),
    });
    expect(edited.body.current.version).toBe(1);

    const signed = await api(`/api/notes/patients/${person.id}/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(signed.body.current.status).toBe("signed");

    // правка после подписи создаёт версию 2, подписанная остаётся как была
    const next = await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Повторный приём", baseVersion: 1 }),
    });
    expect(next.body.current.version).toBe(2);
    const v1 = next.body.versions.find((v: { version: number }) => v.version === 1);
    expect(v1.text).toBe("Первичная беседа, дополнено");
    expect(v1.status).toBe("signed");
  });

  test("подписанная заметка не правится прямым SQL", async () => {
    /*
     * Договорённости «не править руками» недостаточно, когда речь о
     * клиническом документе: запрет живёт в базе, а не в коде приложения.
     */
    const { sql } = await import("drizzle-orm");
    const { patientNotes } = await import("../src/db/schema");
    const person = await makeUser("user", `note-sql-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Подписываемая", baseVersion: 0 }),
    });
    await api(`/api/notes/patients/${person.id}/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });

    const [row] = await db.select().from(patientNotes).where(eq(patientNotes.userId, person.id));
    await expect(
      (async () => {
        await db.execute(sql`update patient_notes set text = ${"подмена"} where id = ${row!.id}`);
      })(),
    ).rejects.toThrow(/неизменяем/i);
  });

  test("подписывается та версия, что была на экране", async () => {
    const person = await makeUser("user", `note-race-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Версия 1", baseVersion: 0 }),
    });
    await api(`/api/notes/patients/${person.id}/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Версия 2, чужая", baseVersion: 1 }),
    });

    const blind = await api(`/api/notes/patients/${person.id}/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(blind.status).toBe(409);
  });

  test("текст шифруется в базе и читается через API", async () => {
    const { patientNotes } = await import("../src/db/schema");
    const person = await makeUser("user", `note-enc-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Клинический текст", baseVersion: 0 }),
    });

    const [row] = await db.select().from(patientNotes).where(eq(patientNotes.userId, person.id));
    expect(row!.text.startsWith("enc1:v1:")).toBe(true);

    const back = await api(`/api/notes/patients/${person.id}`, adminA.token);
    expect(back.body.current.text).toBe("Клинический текст");
  });

  test("чужой админ заметок не видит", async () => {
    const person = await makeUser("user", `note-foreign-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Своя запись", baseVersion: 0 }),
    });

    const foreign = await api(`/api/notes/patients/${person.id}`, adminB.token);
    expect(foreign.status).toBe(404);
  });
});

/* ── личный план безопасности ── */

describe("план безопасности", () => {
  const content = {
    warningSigns: ["Не сплю больше двух ночей", "Перестаю отвечать на сообщения"],
    copingStrategies: ["Выйти на улицу", "Дыхание 4-7-8"],
    distractions: ["Спортзал", "Позвонить брату"],
    people: [{ name: "Брат Игорь", contact: "+380..." }],
    professionals: [{ name: "Дежурный психолог", contact: "вн. 214" }],
    meansRestriction: "Табельное оружие сдано на хранение",
    reasonsToLive: ["Дочь"],
  };

  test("сохранение создаёт новую версию, а не правит прежнюю", async () => {
    /*
     * План пересматривают вместе с человеком, и «как было в марте» —
     * клинически значимый вопрос: по нему видно, что изменилось в жизни и
     * что перестало работать.
     */
    const person = await makeUser("user", `sp-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const first = await api(`/api/safety/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify(content),
    });
    expect(first.status).toBe(201);
    expect(first.body.version).toBe(1);

    const second = await api(`/api/safety/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ ...content, meansRestriction: "Оружие сдано, ключи у супруги" }),
    });
    expect(second.body.version).toBe(2);

    const list = await api(`/api/safety/patients/${person.id}`, adminA.token);
    expect(list.body.versions).toHaveLength(2);
    // действующей остаётся ровно одна
    expect(list.body.versions.filter((v: { active: boolean }) => v.active)).toHaveLength(1);
    expect(list.body.versions[0].version).toBe(2);
  });

  test("пациент читает свой план сам", async () => {
    /*
     * План нужен человеку в кризисе, когда рядом никого нет, — поэтому
     * доступ шире обычного клинического: это единственный документ, который
     * пациент открывает о себе целиком.
     */
    const person = await makeUser("user", `sp-own-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    await api(`/api/safety/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify(content),
    });

    const own = await api("/api/safety/me", person.token);
    expect(own.status).toBe(200);
    expect(own.body.plan.content.people[0].name).toBe("Брат Игорь");
    expect(own.body.plan.content.meansRestriction).toContain("оружие");
  });

  test("чужой план пациенту не отдаётся", async () => {
    const mine = await makeUser("user", `sp-a-${crypto.randomUUID()}@test`);
    const other = await makeUser("user", `sp-b-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, mine.token);
    await submitSurvey(surveyInA, other.token);
    await api(`/api/safety/patients/${other.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify(content),
    });

    // у mine плана нет — и чужой он получить не может никаким путём
    const own = await api("/api/safety/me", mine.token);
    expect(own.body.plan).toBeNull();

    const foreign = await api(`/api/safety/patients/${other.id}`, mine.token);
    expect(foreign.status).toBe(404);
  });

  test("содержимое шифруется в базе", async () => {
    const { safetyPlans } = await import("../src/db/schema");
    const person = await makeUser("user", `sp-enc-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    await api(`/api/safety/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify(content),
    });

    const [row] = await db.select().from(safetyPlans).where(eq(safetyPlans.userId, person.id));
    expect(row!.content.startsWith("enc1:v1:")).toBe(true);
    // самый чувствительный документ в системе не лежит открытым ни секунды
    expect(row!.content).not.toContain("Брат");
  });
});

/* ── цели лечения ── */

/* ── консилиум ── */

describe("достоверность изменения в сводке", () => {
  test("RCI не вырождается в одно и то же число для всех шкал", async () => {
    /*
     * SD раньше считалась по тем же двум точкам, между которыми меряется
     * изменение. Арифметика такого расчёта вырождается: при двух значениях
     * sd = |Δ|/√2, и RCI выходит ровно ±2.24 всегда — для любой шкалы,
     * любого человека и любого сдвига. На экране это выглядело как уверенное
     * «достоверное возрастание» в каждой строке подряд.
     */
    const person = await makeUser("user", `rci-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    await submitSurvey(surveyInA, person.token);

    const res = await api(`/api/referrals/summary/${person.id}`, adminA.token);
    expect(res.status).toBe(200);

    const rcis = res.body.surveys
      .flatMap((s: { scales: { reliableChange: { rci: number } | null }[] }) => s.scales)
      .map((sc: { reliableChange: { rci: number } | null }) => sc.reliableChange?.rci)
      .filter((x: number | undefined) => x !== undefined);

    // либо достоверность не посчитана (мало выборки), либо значения различаются
    if (rcis.length > 1) {
      expect(new Set(rcis.map((x: number) => Math.abs(x))).size).toBeGreaterThan(1);
    }
    for (const rci of rcis) {
      expect(Math.abs(rci)).not.toBeCloseTo(2.236, 2);
    }
  });
});

describe("карточка пациента вне зоны", () => {
  /*
   * У adminB есть своя методика, поэтому проверка «есть ли вообще методики»
   * его не остановит — отказ должен приходить именно из-за чужого пациента.
   */
  test("динамика чужого пациента не отдаёт ни имени, ни почты", async () => {
    const email = `dyn-foreign-${crypto.randomUUID()}@test`;
    const person = await makeUser("user", email);
    await submitSurvey(surveyInA, person.token);

    const res = await api(`/api/dynamics/respondents/${person.id}`, adminB.token);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(email);
  });

  test("свой админ ту же карточку получает", async () => {
    const person = await makeUser("user", `dyn-own-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const res = await api(`/api/dynamics/respondents/${person.id}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.surveys.length).toBeGreaterThan(0);
  });
});

describe("сведение версий", () => {
  test("одна версия — коэффициентов нет", async () => {
    /*
     * Приводить нечего: все замеры сделаны на одной версии, и «коэффициент 1»
     * здесь был бы ответом на незаданный вопрос.
     */
    const person = await makeUser("user", `eq-one-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    await submitSurvey(surveyInA, person.token);

    const card = await api(`/api/dynamics/respondents/${person.id}`, adminA.token);
    for (const sv of card.body.surveys) {
      for (const sc of sv.scales) {
        expect(sc.equated ?? null).toBeNull();
      }
    }
  });

  test("коэффициенты приходят вместе с размерами выборок", async () => {
    /*
     * Решение показывать приведённый балл принимает человек, который знает,
     * менялся ли контингент. Значит ему нужны основания, а не одно число.
     */
    const { equate } = await import("@quizzy/shared");
    const eq = equate(
      { version: 1, n: 120, mean: 20, sd: 5 },
      { version: 2, n: 90, mean: 24, sd: 6 },
    )!;
    expect(eq.from.n).toBe(120);
    expect(eq.to.n).toBe(90);
    // +1 SD в старой версии остаётся +1 SD в новой
    expect(eq.slope * 25 + eq.intercept).toBeCloseTo(30, 6);
  });
});

describe("черновик заключения из результатов", () => {
  /**
   * Переписывание цифр из соседнего окна и есть та работа, где ошибка не
   * видна, а время уходит. Черновик подставляет то, что система знает
   * наверняка, и оставляет специалисту вывод.
   */
  test("подставляет человека, методику и баллы", async () => {
    const person = await makeUser("user", `cn-draft-${crypto.randomUUID()}@test`);
    const submitted = await submitSurvey(surveyInA, person.token);
    expect(submitted.status).toBe(201);

    const res = await api(
      `/api/conclusions/responses/${submitted.body.id}/conclusion/draft`,
      adminA.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.patient.fullName).toContain("cn-draft-");
    expect(res.body.surveyTitle.length).toBeGreaterThan(0);
    expect(res.body.scales.length).toBeGreaterThan(0);
  });

  test("черновик не сохраняется сам", async () => {
    /*
     * Сохранённый автоматически, он стал бы клиническим документом, которого
     * никто не писал: лежал бы в карте и попал бы в историю версий раньше,
     * чем его прочитали.
     */
    const person = await makeUser("user", `cn-draft2-${crypto.randomUUID()}@test`);
    const submitted = await submitSurvey(surveyInA, person.token);
    await api(`/api/conclusions/responses/${submitted.body.id}/conclusion/draft`, adminA.token);

    const state = await api(
      `/api/conclusions/responses/${submitted.body.id}/conclusion`,
      adminA.token,
    );
    expect(state.body.current).toBeNull();
    expect(state.body.versions).toEqual([]);
  });

  test("первое прохождение не показывает динамику", async () => {
    // сравнивать не с чем, и строки динамики нет вовсе, а не «не изменилось»
    const person = await makeUser("user", `cn-draft3-${crypto.randomUUID()}@test`);
    const submitted = await submitSurvey(surveyInA, person.token);

    const res = await api(
      `/api/conclusions/responses/${submitted.body.id}/conclusion/draft`,
      adminA.token,
    );
    expect(res.body.previousAt).toBeNull();
    expect(res.body.scales.every((s: { previousValue: number | null }) => s.previousValue === null)).toBe(true);
  });

  test("повторное прохождение показывает, с чем сравнивать", async () => {
    const person = await makeUser("user", `cn-draft4-${crypto.randomUUID()}@test`);
    const first = await submitSurvey(surveyInA, person.token);
    expect(first.status).toBe(201);
    const second = await submitSurvey(surveyInA, person.token);
    expect(second.status).toBe(201);

    const res = await api(
      `/api/conclusions/responses/${second.body.id}/conclusion/draft`,
      adminA.token,
    );
    expect(res.body.previousAt).not.toBeNull();
    expect(res.body.scales.some((s: { previousValue: number | null }) => s.previousValue !== null)).toBe(true);
  });

  test("чужое прохождение черновика не отдаёт", async () => {
    const person = await makeUser("user", `cn-draft5-${crypto.randomUUID()}@test`);
    const submitted = await submitSurvey(surveyInA, person.token);

    const res = await api(
      `/api/conclusions/responses/${submitted.body.id}/conclusion/draft`,
      adminB.token,
    );
    expect([403, 404]).toContain(res.status);
  });
});
