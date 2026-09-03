import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { adminA, adminB, and, api, app, json, batteries, batteryAssignments, batteryItems, createSurveySchema, createVersion, db, eq, groupA, isNull, makeUser, patient, runDueSchedules, scheduleRuns, schedules, sr45, submitSurvey, surveyInA, surveys, users } from "./fixtures";

/* Батареи, назначения, расписания и приглашения */

/* ── батареи: строгий порядок и автозакрытие ── */

describe("батареи", () => {
  let batteryId: string;
  let secondSurvey: string;

  beforeAll(async () => {
    // вторая методика в группе А
    const input = createSurveySchema.parse(sr45);
    secondSurvey = crypto.randomUUID();
    await db.insert(surveys).values({
      id: secondSurvey,
      groupId: groupA,
      title: { uk: "Друга методика", ru: "Вторая методика" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(secondSurvey, input, adminA.id, "v1");

    batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      title: "Тестовая батарея",
      groupId: groupA,
      strictOrder: true,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([
      { batteryId, surveyId: surveyInA, position: 0, required: true },
      { batteryId, surveyId: secondSurvey, position: 1, required: true },
    ]);
  });

  test("назначение выдаёт доступ; пациенту нельзя сдать второй шаг раньше первого", async () => {
    const assign = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id }),
    });
    expect(assign.status).toBe(201);

    const out = await submitSurvey(secondSurvey, patient.token);
    expect(out.status).toBe(400);
    expect(out.body.error).toContain("суворий порядок");
  });

  test("после первого шага открывается второй; назначение закрывается само", async () => {
    const first = await submitSurvey(surveyInA, patient.token);
    expect(first.status).toBe(201);

    const second = await submitSurvey(secondSurvey, patient.token);
    expect(second.status).toBe(201);

    const rows = await db
      .select()
      .from(batteryAssignments)
      .where(eq(batteryAssignments.batteryId, batteryId));
    expect(rows[0]!.completedAt).not.toBeNull();
  });

  test("чужой админ не может назначить батарею группы А", async () => {
    const res = await api(`/api/batteries/${batteryId}/assign`, adminB.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id }),
    });
    expect([403, 404]).toContain(res.status);
  });
});

/* ── очерёдность и шаги клинициста ── */

describe("порядок батареи и методики клинициста", () => {
  test("непройденное интервью специалиста не блокирует самоотчёт", async () => {
    // батарея: [клиницист, самоотчёт] со строгим порядком
    const clinicianSurvey = crypto.randomUUID();
    const input = createSurveySchema.parse(sr45);
    await db.insert(surveys).values({
      id: clinicianSurvey,
      groupId: groupA,
      title: { uk: "Інтерв’ю", ru: "Интервью" },
      administration: "clinician",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(clinicianSurvey, input, adminA.id, "v1");

    const selfSurvey = crypto.randomUUID();
    await db.insert(surveys).values({
      id: selfSurvey,
      groupId: groupA,
      title: { uk: "Самозвіт", ru: "Самоотчёт" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(selfSurvey, input, adminA.id, "v1");

    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      title: "Смешанная батарея",
      groupId: groupA,
      strictOrder: true,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([
      { batteryId, surveyId: clinicianSurvey, position: 0, required: true },
      { batteryId, surveyId: selfSurvey, position: 1, required: true },
    ]);

    const person = await makeUser("user", "mixed@test.dev", { sex: "male", birthDate: "1992-02-02" });
    await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    // интервью ещё не внесено, но самоотчёт должен пройти:
    // дорожка специалиста параллельна и не запирает очередь
    const res = await submitSurvey(selfSurvey, person.token);
    expect(res.status).toBe(201);

    // батарея при этом НЕ закрыта: обязательная часть специалиста не внесена
    const assignments = await api(`/api/batteries/${batteryId}/assignments`, adminA.token);
    expect(assignments.body.items[0].completedAt).toBeNull();
    const clinicianStep = assignments.body.items[0].steps.find(
      (s: { surveyId: string }) => s.surveyId === clinicianSurvey,
    );
    expect(clinicianStep.state).toBe("available");
  });
});

/* ── планировщик: идемпотентность ── */

describe("планировщик", () => {
  test("два прогона подряд не плодят назначений", async () => {
    const scheduleId = crypto.randomUUID();
    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      title: "Батарея расписания",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId, surveyId: surveyInA, position: 0, required: true }]);
    await db.insert(schedules).values({
      id: scheduleId,
      title: "Тестовое расписание",
      batteryId,
      scope: "unit",
      unit: "Рота А",
      intervalDays: 30,
      dueDays: 7,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      active: true,
      createdBy: adminA.id,
    });

    await runDueSchedules();
    await runDueSchedules(); // второй прогон должен быть пустым

    const assignments = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.batteryId, batteryId), isNull(batteryAssignments.cancelledAt)));
    expect(assignments.length).toBe(1);

    const runs = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId));
    // срабатывание одно: второй прогон не дошёл до выдачи, срок уже сдвинут
    expect(runs.length).toBe(1);
    expect(runs[0]!.assigned).toBe(1);
  });

  test("упавшее расписание не останавливает следующие и само сдвигает срок", async () => {
    /*
     * «Ошибка одного расписания не останавливает остальные» было написано в
     * комментарии к проходу, но проход шёл одной транзакцией на все
     * расписания. Ошибка postgres переводит транзакцию в aborted, и дальше
     * в ней не проходит ничего — ни запись о неудаче, ни сдвиг срока (обе
     * гасят исключение через .catch и потому молчат), ни одно из следующих
     * расписаний. Одно кривое расписание вставало поперёк работы всей
     * больницы и возвращалось каждый тик, потому что срок ему сдвинуть не
     * удавалось.
     *
     * Сбой подстраивается триггером — нужна именно ошибка postgres, только
     * она портит транзакцию, — и подстраивается он на ОБНОВЛЕНИИ
     * расписания после выдачи. Место выбрано не случайно: выдача внутри
     * runSchedule обёрнута своей транзакцией, то есть savepoint'ом, и сбой
     * в ней откатывается, не трогая внешнюю. Первая версия этой проверки
     * ломала именно выдачу — и проходила на сломанном коде тоже. Всё, что
     * идёт в проходе вне этого savepoint'а (отметка о прогоне, сдвиг срока,
     * подсчёт охвата), такой защиты не имеет.
     */
    const battery = crypto.randomUUID();
    await db.insert(batteries).values({
      id: battery,
      title: "Батарея для сбоя",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId: battery, surveyId: surveyInA, position: 0, required: true }]);

    const broken = crypto.randomUUID();
    const healthy = crypto.randomUUID();
    const mark = `СБОЙ-${crypto.randomUUID().slice(0, 8)}`;
    // кривое идёт первым: проход берёт расписания по возрастанию nextRunAt
    await db.insert(schedules).values([
      {
        id: broken,
        title: mark,
        batteryId: battery,
        scope: "unit",
        unit: "Рота А",
        intervalDays: 30,
        dueDays: 7,
        startsAt: new Date(Date.now() - 120_000).toISOString(),
        nextRunAt: new Date(Date.now() - 120_000).toISOString(),
        active: true,
        createdBy: adminA.id,
      },
      {
        id: healthy,
        title: `Исправное ${mark}`,
        batteryId: battery,
        scope: "unit",
        unit: "Рота А",
        intervalDays: 30,
        dueDays: 7,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        active: true,
        createdBy: adminA.id,
      },
    ]);

    /*
     * Условие `new.last_run_at is not null` отделяет успешное обновление
     * (оно проставляет отметку о запуске) от восстановительного в catch (оно
     * трогает только срок). Иначе триггер запретил бы и сдвиг срока, и
     * проверка не смогла бы отличить починенный код от сломанного.
     *
     * Метка подставляется в текст функции, а не параметром: в теле CREATE
     * FUNCTION связывать нечего — postgres не выводит тип $1.
     */
    await db.execute(
      sql.raw(`
      create or replace function quizzy_test_break_schedule() returns trigger as $fn$
      begin
        if new.title = '${mark}' and new.last_run_at is not null then
          raise exception 'подстроенный сбой расписания';
        end if;
        return new;
      end $fn$ language plpgsql`),
    );
    await db.execute(sql`
      create trigger quizzy_test_break_schedule_trg before update on schedules
      for each row execute function quizzy_test_break_schedule()`);

    try {
      await runDueSchedules();
    } finally {
      await db.execute(sql`drop trigger if exists quizzy_test_break_schedule_trg on schedules`);
      await db.execute(sql`drop function if exists quizzy_test_break_schedule()`);
    }

    const brokenRuns = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, broken));
    expect(brokenRuns.length, "неудача кривого расписания нигде не записана").toBe(1);
    expect(brokenRuns[0]!.assigned).toBe(0);
    expect(brokenRuns[0]!.note).toContain("подстроенный сбой");

    const healthyRuns = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, healthy));
    expect(healthyRuns.length, "следующее расписание не отработало — проход встал на первом сбое").toBe(1);
    expect(healthyRuns[0]!.assigned).toBeGreaterThan(0);

    // срок кривого сдвинут: иначе оно вернётся на следующем же тике
    const [after] = await db.select().from(schedules).where(eq(schedules.id, broken));
    expect(
      new Date(after!.nextRunAt).getTime(),
      "срок кривого расписания не сдвинут — оно будет падать каждый тик",
    ).toBeGreaterThan(Date.now());

    // от кривого не осталось наполовину розданных назначений
    const leftovers = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.batteryId, battery), sql`${batteryAssignments.note} like ${`%${mark}%`}`));
    expect(leftovers.every((a) => a.note?.includes("Исправное"))).toBe(true);
  });
});

/* ── приглашения ── */

describe("приглашения", () => {
  let token: string;
  let code: string;
  let inviteBattery: string;

  beforeAll(async () => {
    inviteBattery = crypto.randomUUID();
    await db.insert(batteries).values({
      id: inviteBattery,
      title: "Батарея приглашения",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId: inviteBattery, surveyId: surveyInA, position: 0, required: true }]);
  });

  test("создание: токен и код выдаются один раз", async () => {
    const res = await api("/api/invites", adminA.token, {
      method: "POST",
      body: JSON.stringify({ batteryId: inviteBattery, unit: "Рота Б", maxUses: 2, ttlDays: 7 }),
    });
    expect(res.status).toBe(201);
    token = res.body.token;
    code = res.body.code;
    expect(token.length).toBeGreaterThan(20);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  test("предпросмотр публичен и не раскрывает лишнего", async () => {
    const res = await app.request(`/api/invites/preview/${token}`);
    const body = await json(res);
    expect(body.valid).toBe(true);
    expect(body.batteryTitle).toBe("Батарея приглашения");
    expect(Object.keys(body).sort()).toEqual(["batteryTitle", "unit", "valid"]);
  });

  test("регистрация по коду: батарея назначена, подразделение из приглашения", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "invited@test.dev",
        password: "longpass123",
        phone: "+380501112233",
        anonymous: false,
        firstName: "Новый",
        lastName: "Пациент",
        inviteCode: code,
        unit: "своё-игнорируется",
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.user.unit).toBe("Рота Б");

    const mine = await api("/api/batteries/mine", body.token);
    expect(mine.body.items.length).toBe(1);
    expect(mine.body.items[0].batteryTitle).toBe("Батарея приглашения");
  });

  test("лимит использований соблюдается атомарно", async () => {
    // второе из двух использований
    const second = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "invited2@test.dev", password: "longpass123", phone: "+380501112244",
        anonymous: true, inviteCode: code,
      }),
    });
    expect(second.status).toBe(201);

    // третье — отказ до создания аккаунта
    const third = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // телефон валидный намеренно: отказ должен прийти по лимиту приглашения,
        // а не по отсутствию номера — иначе проверка прошла бы не за то
        email: "invited3@test.dev", password: "longpass123", phone: "+380501112255",
        anonymous: true, inviteCode: code,
      }),
    });
    expect(third.status).toBe(400);
    const { users: usersTable } = await import("../src/db/schema");
    const ghost = await db.query.users.findFirst({ where: eq(usersTable.email, "invited3@test.dev") });
    expect(ghost).toBeUndefined();
  });

  test("отзыв гасит приглашение", async () => {
    const created = await api("/api/invites", adminA.token, {
      method: "POST",
      body: JSON.stringify({ maxUses: 5, ttlDays: 7 }),
    });
    await api(`/api/invites/${created.body.id}/revoke`, adminA.token, { method: "POST" });
    const preview = await app.request(`/api/invites/preview/${created.body.token}`);
    const body = await json(preview);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe("revoked");
  });

  test("чужой админ не видит приглашение группы А в списке", async () => {
    const mine = await api("/api/invites", adminA.token);
    expect(mine.body.items.length).toBeGreaterThan(0);
    const foreign = await api("/api/invites", adminB.token);
    const ids = foreign.body.items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(
      mine.body.items.find((i: { batteryId: string | null }) => i.batteryId)?.id,
    );
  });
});

/* ── волна 5: каскады и протоколы наблюдения ── */

describe("каскадные назначения", () => {
  test("попадание в полосу назначает батарею; повтор не дублирует; петля отсекается", async () => {
    const { sr45 } = await import("../src/instruments/sr45");
    const { scaleBands: bandsTable, scales: scalesTable, surveyVersions } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");

    // методика-скрининг
    const screenId = crypto.randomUUID();
    await db.insert(surveys).values({
      id: screenId,
      groupId: groupA,
      title: { uk: "Каскад-скринінг", ru: "Каскад-скрининг" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(screenId, createSurveySchema.parse(sr45), adminA.id, "v1");

    // углублённая батарея из ДРУГОЙ методики
    const deepId = crypto.randomUUID();
    await db.insert(surveys).values({
      id: deepId,
      groupId: groupA,
      title: { uk: "Поглиблена", ru: "Углублённая" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(deepId, createSurveySchema.parse(sr45), adminA.id, "v1");

    const deepBattery = crypto.randomUUID();
    await db.insert(batteries).values({
      id: deepBattery,
      title: "Углублённая диагностика",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId: deepBattery, surveyId: deepId, position: 0, required: true }]);

    // вешаем каскад и повторы на ВСЕ полосы шкалы Sr текущей версии скрининга
    const [version] = await db
      .select()
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, screenId))
      .orderBy(descOp(surveyVersions.version))
      .limit(1);
    const srScale = await db.query.scales.findFirst({
      where: and(eq(scalesTable.versionId, version!.id), eq(scalesTable.code, "Sr")),
    });
    await db
      .update(bandsTable)
      .set({ cascadeBatteryId: deepBattery, cascadeDueDays: 14, followUpDays: "7,30" })
      .where(eq(bandsTable.scaleId, srScale!.id));

    const person = await makeUser("user", "cascade@test.dev", { sex: "male", birthDate: "1990-01-01" });

    const first = await submitSurvey(screenId, person.token);
    expect(first.status).toBe(201);
    expect(first.body.cascade.assignedBatteries).toContain("Углублённая диагностика");
    expect(first.body.cascade.scheduledFollowUps).toBe(2);

    const assigned = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.batteryId, deepBattery), eq(batteryAssignments.userId, person.id)));
    expect(assigned.length).toBe(1);
    expect(assigned[0]!.dueAt).not.toBeNull();

    // доступ к углублённой методике выдан
    const { surveyAccess: accessTable } = await import("../src/db/schema");
    const access = await db
      .select()
      .from(accessTable)
      .where(and(eq(accessTable.surveyId, deepId), eq(accessTable.userId, person.id)));
    expect(access.length).toBe(1);

    // повторная сдача не плодит второе назначение
    const second = await submitSurvey(screenId, person.token);
    expect(second.status).toBe(201);
    expect(second.body.cascade.assignedBatteries).toEqual([]);
    const afterSecond = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.batteryId, deepBattery), eq(batteryAssignments.userId, person.id)));
    expect(afterSecond.length).toBe(1);

    // петля: батарея содержит саму методику-источник → каскад пропускается
    const loopBattery = crypto.randomUUID();
    await db.insert(batteries).values({
      id: loopBattery,
      title: "Петля",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId: loopBattery, surveyId: screenId, position: 0, required: true }]);
    await db.update(bandsTable).set({ cascadeBatteryId: loopBattery }).where(eq(bandsTable.scaleId, srScale!.id));

    const loopPerson = await makeUser("user", "loop@test.dev", { sex: "male", birthDate: "1990-01-01" });
    const third = await submitSurvey(screenId, loopPerson.token);
    expect(third.status).toBe(201);
    expect(third.body.cascade.assignedBatteries).toEqual([]);
    const loopAssigned = await db
      .select()
      .from(batteryAssignments)
      .where(eq(batteryAssignments.batteryId, loopBattery));
    expect(loopAssigned.length).toBe(0);
  }, 60_000);
});
