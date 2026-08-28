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

/* ── маршруты помощи ── */

describe("маршрут помощи", () => {
  let pathwayId: string;

  test("шаблон заводится со шагами и сроками", async () => {
    const res = await api("/api/pathways", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        title: { uk: "Ризик", ru: "Риск" },
        steps: [
          { title: { uk: "Скринінг", ru: "Скрининг" }, kind: "survey", surveyId: surveyInA, dueDays: 0 },
          { title: { uk: "Бесіда", ru: "Беседа" }, kind: "action", dueDays: 1 },
          { title: { uk: "Рішення", ru: "Решение" }, kind: "decision", dueDays: 14, required: false },
        ],
      }),
    });
    expect(res.status).toBe(201);
    pathwayId = res.body.id;

    const list = await api("/api/pathways", adminA.token);
    const mine = list.body.items.find((p: { id: string }) => p.id === pathwayId);
    expect(mine.steps).toHaveLength(3);
    expect(mine.steps[0].kind).toBe("survey");
  });

  test("человек ставится на маршрут, сроки считаются от старта", async () => {
    /*
     * Срок шага — от начала маршрута, а не от предыдущего шага: иначе
     * просрочка одного сдвигает все следующие, и «через две недели после
     * скрининга» превращается в «когда-нибудь».
     */
    const person = await makeUser("user", `pw-${crypto.randomUUID()}@test`, { unit: "Рота П" });
    await submitSurvey(surveyInA, person.token);

    const started = await api(`/api/pathways/${pathwayId}/start`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });
    expect(started.status).toBe(201);

    const detail = await api(`/api/pathways/instances/${started.body.id}`, adminA.token);
    expect(detail.body.steps).toHaveLength(3);

    const [first, second, third] = detail.body.steps;
    const day = 86_400_000;
    const startedAt = new Date(detail.body.startedAt).getTime();
    expect(new Date(first.dueAt).getTime() - startedAt).toBeLessThan(day);
    expect(Math.round((new Date(second.dueAt).getTime() - startedAt) / day)).toBe(1);
    expect(Math.round((new Date(third.dueAt).getTime() - startedAt) / day)).toBe(14);
  });

  test("второй такой же маршрут не открывается", async () => {
    // два списка шагов рядом невозможно разобрать, и это почти всегда ошибка
    const person = await makeUser("user", `pw2-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const first = await api(`/api/pathways/${pathwayId}/start`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });
    expect(first.status).toBe(201);

    const second = await api(`/api/pathways/${pathwayId}/start`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });
    expect(second.status).toBe(400);
  });

  test("пропуск обязательного шага требует объяснения", async () => {
    /*
     * Без объяснения запись «шаг пропущен» через месяц ничего не значит — а
     * именно к ней возвращаются, разбирая, почему человек не дошёл до помощи.
     */
    const person = await makeUser("user", `pw3-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    const started = await api(`/api/pathways/${pathwayId}/start`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });
    const detail = await api(`/api/pathways/instances/${started.body.id}`, adminA.token);
    const required = detail.body.steps.find((s: { required: boolean }) => s.required);
    const optional = detail.body.steps.find((s: { required: boolean }) => !s.required);

    const bare = await api(`/api/pathways/progress/${required.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ state: "skipped" }),
    });
    expect(bare.status).toBe(400);

    const explained = await api(`/api/pathways/progress/${required.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ state: "skipped", note: "Проходил на прошлой неделе" }),
    });
    expect(explained.status).toBe(200);

    // необязательный пропускается без объяснений
    const soft = await api(`/api/pathways/progress/${optional.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ state: "skipped" }),
    });
    expect(soft.status).toBe(200);
  });

  test("в списке видно, где стоим и что просрочено", async () => {
    const person = await makeUser("user", `pw4-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    const started = await api(`/api/pathways/${pathwayId}/start`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    const list = await api("/api/pathways/instances", adminA.token);
    const mine = list.body.items.find((i: { id: string }) => i.id === started.body.id);
    expect(mine.total).toBe(3);
    expect(mine.done).toBe(0);
    // «где стоим» — первый незакрытый шаг: он и есть ответ на вопрос.
    // Язык по умолчанию украинский: заголовок приходит на нём, и это верно —
    // сервер локализует контент, а не отдаёт ключи
    expect(mine.currentStep).toBe("Скринінг");
    // первый шаг со сроком «в тот же день» уже просрочен
    expect(mine.overdue).toBeGreaterThanOrEqual(1);
  });

  test("чужой админ маршрут не видит и не правит", async () => {
    const person = await makeUser("user", `pw5-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    const started = await api(`/api/pathways/${pathwayId}/start`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    const foreign = await api(`/api/pathways/instances/${started.body.id}`, adminB.token);
    expect(foreign.status).toBe(404);

    const list = await api("/api/pathways/instances", adminB.token);
    expect(list.body.items.some((i: { id: string }) => i.id === started.body.id)).toBe(false);
  });

  test("закрытие требует исхода и делает маршрут неизменяемым", async () => {
    const person = await makeUser("user", `pw6-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    const started = await api(`/api/pathways/${pathwayId}/start`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    const noOutcome = await api(`/api/pathways/instances/${started.body.id}/close`, adminA.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(noOutcome.status).toBe(400);

    const closed = await api(`/api/pathways/instances/${started.body.id}/close`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ outcome: "resolved", note: "Снят с наблюдения" }),
    });
    expect(closed.status).toBe(200);

    // после закрытия шаги не двигаются: маршрут стал историей
    const detail = await api(`/api/pathways/instances/${started.body.id}`, adminA.token);
    const step = detail.body.steps[0];
    const late = await api(`/api/pathways/progress/${step.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ state: "done" }),
    });
    expect(late.status).toBe(400);
  });
});

describe("маршрут в очереди работы", () => {
  test("просроченный шаг попадает в общую очередь", async () => {
    /*
     * Иначе маршрут был бы отдельным списком, который надо не забыть
     * открыть, — то есть ровно тем, от чего уходим: очередь существует,
     * чтобы держать всё входящее в одном месте.
     */
    const template = await api("/api/pathways", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        title: { uk: "Черга", ru: "Очередь" },
        steps: [{ title: { uk: "Прострочений крок", ru: "Просроченный шаг" }, kind: "action", dueDays: 0 }],
      }),
    });

    const person = await makeUser("user", `wl-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    await api(`/api/pathways/${template.body.id}/start`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    const work = await api("/api/worklist", adminA.token);
    const mine = work.body.items.filter(
      (i: { kind: string; userId: string }) => i.kind === "pathway" && i.userId === person.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].overdue).toBe(true);
    // ссылка ведёт на маршрут, а не на карту: работать надо там
    expect(mine[0].href).toContain("/pathways/");
  });
});
