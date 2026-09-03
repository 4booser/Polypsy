import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { checkRls, rlsRefusal } from "../src/lib/rlsGuard";
import { adminA, adminB, and, api, app, batteries, batteryAssignments, batteryItems, db, eq, groupA, groupAdmins, makeUser, patient, root, surveyGroups, submitSurvey, surveyInA, surveys, users, type Person } from "./fixtures";

/* Права доступа: кто что видит и чего не может */

/* ── скоупинг ── */

describe("скоупинг групп", () => {
  test("админ чужой группы получает отказ на методику группы А", async () => {
    const own = await api(`/api/surveys/${surveyInA}`, adminA.token);
    expect(own.status).toBe(200);

    // контракт scope.ts: 404 — методики нет, 403 — вне зоны ответственности.
    // Раскрытие факта существования внутри круга персонала — осознанный выбор:
    // явный отказ помогает разобраться с неверно настроенной группой
    const foreign = await api(`/api/surveys/${surveyInA}`, adminB.token);
    expect(foreign.status).toBe(403);
  });

  test("прошедший методику группы А виден своему админу и не виден чужому", async () => {
    /*
     * Проверяется конкретный человек, а не длина списка: тесты идут в одном
     * процессе с общей базой, и «список пуст» держалось лишь на том, что этот
     * файл выполнялся первым. Такое утверждение ломается от появления
     * соседнего теста — то есть проверяет порядок файлов, а не права.
     */
    const unit = `Рота-${crypto.randomUUID().slice(0, 8)}`;
    const person = await makeUser("user", `scope-${crypto.randomUUID()}@test`, { unit });
    await submitSurvey(surveyInA, person.token);

    // фильтр по подразделению: список постраничный, и без фильтра проверка
    // была бы про номер страницы, а не про права
    const own = await api(`/api/access/patients?unit=${encodeURIComponent(unit)}`, adminA.token);
    expect(own.body.items.some((p: { id: string }) => p.id === person.id)).toBe(true);

    const foreign = await api(`/api/access/patients?unit=${encodeURIComponent(unit)}`, adminB.token);
    expect(foreign.body.items).toEqual([]);
  });

  test("суперадмин видит всё", async () => {
    const unit = `Штаб-${crypto.randomUUID().slice(0, 8)}`;
    const person = await makeUser("user", `root-sees-${crypto.randomUUID()}@test`, { unit });
    await submitSurvey(surveyInA, person.token);

    const all = await api(`/api/access/patients?unit=${encodeURIComponent(unit)}`, root.token);
    expect(all.body.items.some((p: { id: string }) => p.id === person.id)).toBe(true);
    expect(all.body.truncated).toBe(false);

    const s = await api(`/api/surveys/${surveyInA}`, root.token);
    expect(s.status).toBe(200);
  });
});

/* ── RLS под не-владельцем ── */

describe("RLS-политики (роль без прав владельца)", () => {
  let rlsSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    // роль создаём владельцем, подключаемся ею: для неё политики активны
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = 'quizzy_rls_test') then
        create role quizzy_rls_test login;
      end if;
    end $$`);
    await admin.unsafe(`grant usage on schema public to quizzy_rls_test`);
    await admin.unsafe(`grant select, insert, update, delete on all tables in schema public to quizzy_rls_test`);
    await admin.end();

    const url = new URL(process.env.DATABASE_URL!);
    url.username = "quizzy_rls_test";
    url.password = "";
    rlsSql = postgres(url.toString(), { max: 1 });
  });

  afterAll(async () => {
    await rlsSql?.end({ timeout: 3 }).catch(() => {});
  });

  /** Выполнить запрос в транзакции с заданной RLS-идентичностью */
  async function as(identity: { userId?: string; role?: string }, query: string): Promise<number> {
    const rows = await rlsSql.begin(async (tx: postgres.TransactionSql) => {
      await tx`select set_config('app.user_id', ${identity.userId ?? ""}, true),
                      set_config('app.role', ${identity.role ?? ""}, true)`;
      return tx.unsafe(query);
    });
    return Number((rows as unknown as { n: number }[])[0]?.n ?? NaN);
  }

  const countResponses = `select count(*)::int n from responses`;
  const countSurveyA = `select count(*)::int n from responses where survey_id = (select id from surveys limit 1)`;

  test("без контекста — ноль строк, а не чужие данные", async () => {
    expect(await as({}, countResponses)).toBe(0);
    expect(await as({}, `select count(*)::int n from surveys`)).toBe(0);
    expect(await as({}, `select count(*)::int n from answers`)).toBe(0);
    expect(await as({}, `select count(*)::int n from risk_alerts`)).toBe(0);
  });

  test("system и superadmin видят всё", async () => {
    const total = await as({ role: "system" }, countResponses);
    expect(total).toBeGreaterThan(0);
    expect(await as({ userId: root.id, role: "superadmin" }, countResponses)).toBe(total);
  });

  test("админ видит только свою группу", async () => {
    const a = await as({ userId: adminA.id, role: "admin" }, countResponses);
    const b = await as({ userId: adminB.id, role: "admin" }, countResponses);
    expect(a).toBeGreaterThan(0); // группа А — все прохождения теста в ней
    expect(b).toBe(0); // у группы Б прохождений нет — и чужих ей не видно
  });

  test("пациент видит только свои прохождения и ответы", async () => {
    /*
     * Оба прохождения создаются здесь же. Раньше тест опирался на то, что
     * кто-то раньше в файле уже сдал методику, — то есть проверял порядок
     * выполнения не меньше, чем политики.
     */
    await submitSurvey(surveyInA, patient.token);
    const other = await makeUser("user", `rls-other-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, other.token);

    const own = await as({ userId: patient.id, role: "user" }, countResponses);
    const total = await as({ role: "system" }, countResponses);
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan(total);

    // и не может читать тревоги (они — для персонала)
    expect(await as({ userId: patient.id, role: "user" }, `select count(*)::int n from risk_alerts`)).toBe(0);
  });

  test("пациент не может подсунуть прохождение за другого", async () => {
    const attempt = rlsSql.begin(async (tx: postgres.TransactionSql) => {
      await tx`select set_config('app.user_id', ${patient.id}, true),
                      set_config('app.role', 'user', true)`;
      await tx`insert into responses (id, survey_id, user_id, status, started_at, duration_ms)
               values (${crypto.randomUUID()}, ${surveyInA}, ${adminA.id}, 'completed', now(), 0)`;
    });
    await expect((async () => { await attempt; })()).rejects.toThrow(/row-level security|policy/i);
  });
  test("сторож развёртывания различает роль владельца и роль приложения", async () => {
    /*
     * Самая дорогая находка при подготовке к развёртыванию: поставляемый
     * docker-compose подключал приложение владельцем базы. Владелец в
     * PostgreSQL обходит политики строк, FORCE у нас намеренно не стоит —
     * значит все сорок семь политик оставались на месте, а видел каждый
     * всё. Заметить это нельзя ничем: запросы отрабатывают, экраны
     * рисуются.
     *
     * Сторож спрашивается двумя ролями подряд, потому что «вернул true»
     * доказывает не больше, чем «вернул false»: различать он обязан.
     */
    // роль тестов владеет схемой — сторож обязан отказать
    const owner = await checkRls();
    expect(owner.bypasses).toBe(true);
    expect(rlsRefusal(owner)).toContain(owner.role);

    // та же проверка от имени роли без прав владельца
    const [row] = (await rlsSql.unsafe(`
      select current_user as role,
             r.rolsuper as is_super,
             r.rolbypassrls as bypass,
             (select count(*)::int
                from pg_class c
                join pg_roles o on o.oid = c.relowner
               where c.relnamespace = 'public'::regnamespace
                 and c.relkind = 'r' and c.relrowsecurity
                 and o.rolname = current_user) as owned
        from pg_roles r where r.rolname = current_user
    `)) as unknown as { role: string; is_super: boolean; bypass: boolean; owned: number }[];

    expect(row!.is_super).toBe(false);
    expect(row!.bypass).toBe(false);
    expect(Number(row!.owned)).toBe(0);
  });

  test("запись сеанса видна только двоим — тому, кого писали, и тому, кто писал", async () => {
    /*
     * Самые чувствительные данные в системе: не «результат методики», а
     * разговор человека о себе целиком. Политика на этой таблице
     * проверяется поведением, а не только фактом существования — «политика
     * есть» и «политика пускает кого надо» это разные утверждения, и
     * второе дороже.
     *
     * Проверяется в том числе посторонний специалист: он персонал, у него
     * есть права на маршруты записи, — и именно поэтому важно, что строка
     * чужого приёма ему не видна на уровне базы, а не только на уровне
     * маршрута.
     */
    const { appointments, slots, specialistProfiles, departments, visitRecordings } =
      await import("../src/db/schema");

    const departmentId = crypto.randomUUID();
    await db.insert(departments).values({
      id: departmentId,
      title: { uk: "Запис", ru: "Запись" },
      timezone: "Europe/Kyiv",
    });
    const doctor = await makeUser("admin", `rec-doc-${crypto.randomUUID()}@test`);
    const stranger = await makeUser("admin", `rec-x-${crypto.randomUUID()}@test`);
    const person = await makeUser("user", `rec-p-${crypto.randomUUID()}@test`);
    await db.insert(specialistProfiles).values({ userId: doctor.id, departmentId });

    const slotId = crypto.randomUUID();
    await db.insert(slots).values({
      id: slotId,
      departmentId,
      specialistId: doctor.id,
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 3000_000).toISOString(),
      kind: "primary",
    });
    const appointmentId = crypto.randomUUID();
    await db.insert(appointments).values({
      id: appointmentId,
      slotId,
      patientId: person.id,
      specialistId: doctor.id,
      kind: "primary",
      status: "done",
      bookedBy: doctor.id,
    });
    await db.insert(visitRecordings).values({
      id: crypto.randomUUID(),
      appointmentId,
      patientId: person.id,
      specialistId: doctor.id,
    } as never);

    const count = `select count(*)::int n from visit_recordings where appointment_id = '${appointmentId}'`;

    expect(await as({ userId: doctor.id, role: "admin" }, count)).toBe(1);
    expect(await as({ userId: person.id, role: "user" }, count)).toBe(1);
    // посторонний специалист — тоже персонал, и именно поэтому это важно
    expect(await as({ userId: stranger.id, role: "admin" }, count)).toBe(0);
    expect(await as({}, count)).toBe(0);
  });

});

describe("RLS покрывает все клинические таблицы", () => {
  test("ни одна таблица с клиническими данными не осталась без политик", async () => {
    /*
     * Список таблиц раньше был вписан руками — и устарел в тот же день, когда
     * появились маршруты, заметки, планы безопасности, цели и консилиум:
     * семь новых таблиц с данными о людях прошли бы мимо проверки, которая
     * ровно для этого и писалась.
     *
     * Теперь список выводится: клинической считается любая таблица со
     * ссылкой на пользователя, кроме перечисленных исключений. Новая таблица
     * попадает под проверку сама, а исключение приходится назвать явно — и
     * тогда оно хотя бы обдумано.
     */
    const { sql: sqlOp } = await import("drizzle-orm");

    /** Таблицы со ссылкой на человека, но без клинического содержания */
    const notClinical = new Set([
      "users", // сами учётные записи закрыты правами, а не политикой строк
      "group_admins",
      "refresh_tokens",
      "login_attempts",
      "invites",
      "invite_uses",
      "push_tokens",
      "push_deliveries",
      "saved_views",
      "consent_texts",
      "audit_log", // журнал закрыт ролью: суперадмин видит всё, остальные ничего
      "schedule_targets", // поимённые цели расписания: видны только персоналу
      "pathways", // шаблон маршрута — не данные о человеке
      "pathway_steps",
      "schedules",
      "schedule_targets",
      "schedule_runs",
      "batteries",
      "battery_items",
      "surveys",
      "survey_groups",
      "survey_versions",
      "kiosk_sessions",
      "alert_notifications",
    ]);

    const rows = await db.execute<{ relname: string; n: number } & Record<string, unknown>>(sqlOp`
      select c.relname,
             (select count(*)::int from pg_policies p where p.tablename = c.relname) as n
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r'
        and exists (
          select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.relname
            -- Имена колонок, по которым таблица считается клинической.
            -- Первые три — наследие первой половины проекта. Весь контур
            -- поликлиники ссылается на человека иначе, через patient_id,
            -- specialist_id и author_id, — и потому тринадцать таблиц с
            -- приёмами, перепиской и записями сеансов проходили мимо этой
            -- проверки целиком. Политики у них есть, но никто этого не
            -- сторожил: следующая таблица приехала бы без политики молча.
            -- Ровно то, о чём предупреждает комментарий выше: список,
            -- вписанный руками, устаревает в день появления новой сущности.
            and col.column_name in (
              'user_id', 'response_id', 'subject_user_id',
              'patient_id', 'specialist_id', 'author_id'
            )
        )
    `);

    const seen = new Set([...rows].map((r) => String(r.relname)));

    /*
     * Сначала — что определитель вообще что-то видит, и видит то, что надо.
     *
     * «Незащищённых нет» истинно и тогда, когда список таблиц пуст: именно
     * так проверка и жила, пока искала только user_id, response_id и
     * subject_user_id. Весь контур поликлиники ссылается на человека через
     * patient_id — тринадцать таблиц с приёмами, перепиской и записями
     * сеансов не попадали в выборку вовсе, и проверка объявляла победу,
     * ни разу на них не взглянув.
     *
     * Поэтому здесь поимённо названы таблицы, которые определитель обязан
     * находить. Сузить список колонок обратно теперь нельзя молча.
     */
    const mustSee = [
      "responses",
      "answers",
      "appointments",
      "threads",
      "messages",
      "visit_recordings",
      "episodes",
      "dispensary",
      "department_patients",
    ];
    expect(mustSee.filter((t) => !seen.has(t))).toEqual([]);

    const unprotected = [...rows]
      .filter((r) => Number(r.n) === 0 && !notClinical.has(String(r.relname)))
      .map((r) => String(r.relname));
    expect(unprotected).toEqual([]);
  });

  test("политика случаев видит группу, а не всё подряд", async () => {
    const { alertCases } = await import("../src/db/schema");
    const [row] = await db.select().from(alertCases).limit(1);
    if (!row) return;
    // чужой админ не получает случай ни по API, ни по прямому чтению в его контексте
    const res = await api(`/api/alert-cases/${row.id}/history`, adminB.token);
    expect(res.status).toBe(404);
  });
});

describe("учётная запись только на просмотр", () => {
  let viewer: Person;

  beforeAll(async () => {
    viewer = await makeUser("admin", "viewer@test");
    await db.update(users).set({ readOnly: true }).where(eq(users.id, viewer.id));
    await db.insert(groupAdmins).values({ groupId: groupA, userId: viewer.id, addedBy: root.id });
  });

  test("читать можно всё, что положено роли", async () => {
    expect((await api("/api/surveys", viewer.token)).status).toBe(200);
    expect((await api(`/api/surveys/${surveyInA}`, viewer.token)).status).toBe(200);
    expect((await api("/api/alerts", viewer.token)).status).toBe(200);
  });

  test("любое изменение отклоняется — независимо от эндпоинта", async () => {
    const attempts = [
      ["POST", "/api/referrals", { userId: patient.id, destination: "psychiatrist" }],
      ["POST", `/api/access/surveys/${surveyInA}/grants`, { userId: patient.id }],
      ["DELETE", `/api/surveys/${surveyInA}`, undefined],
      ["PATCH", "/api/auth/me", { unit: "Другое" }],
    ] as const;

    for (const [method, path, body] of attempts) {
      const res = await api(path, viewer.token, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(res.status).toBe(403);
      // без Accept-Language сервер отвечает по-украински — как и на украинском рабочем месте
      expect(res.body.error).toContain("лише на перегляд");
    }
  });

  test("отказ попадает в журнал", async () => {
    await api("/api/referrals", viewer.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id, destination: "other" }),
    });
    const { auditLog } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, viewer.id))
      .orderBy(descOp(auditLog.at))
      .limit(1);
    expect(entry!.action).toBe("access.denied");
    expect((entry!.details as { reason?: string }).reason).toBe("read_only_account");
  });

  test("данные после попыток не изменились", async () => {
    // самая важная проверка: отказ должен быть до записи, а не после
    const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, surveyInA) });
    expect(survey!.archivedAt).toBeNull();
  });
});

/* ── что нельзя удалить, потому что оно тянет за собой историю ── */

describe("защита от каскадного удаления", () => {
  test("непустая группа не удаляется", async () => {
    const res = await api(`/api/groups/${groupA}`, root.token, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("не порожня");

    // группа всё ещё на месте вместе с методикой
    const survey = await api(`/api/surveys/${surveyInA}`, adminA.token);
    expect(survey.status).toBe(200);
  });

  test("пустая группа удаляется", async () => {
    const emptyId = crypto.randomUUID();
    await db.insert(surveyGroups).values({ id: emptyId, title: "Пустая", createdBy: root.id });
    const res = await api(`/api/groups/${emptyId}`, root.token, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("батарея с историей назначений не удаляется даже после завершения", async () => {
    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      groupId: groupA,
      title: "Отработавшая батарея",
      createdBy: adminA.id,
    } as never);
    await db.insert(batteryItems).values({
      id: crypto.randomUUID(),
      batteryId,
      surveyId: surveyInA,
      position: 1,
    } as never);
    // назначение уже закрыто — но это запись о том, что человек проходил набор
    await db.insert(batteryAssignments).values({
      id: crypto.randomUUID(),
      batteryId,
      userId: patient.id,
      assignedBy: adminA.id,
      completedAt: new Date().toISOString(),
    } as never);

    const res = await api(`/api/batteries/${batteryId}`, adminA.token, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("історію призначень");
  });

  test("батарея без назначений удаляется", async () => {
    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      groupId: groupA,
      title: "Ни разу не назначалась",
      createdBy: adminA.id,
    } as never);
    const res = await api(`/api/batteries/${batteryId}`, adminA.token, { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});

describe("удаление учётной записи не уносит клинический архив", () => {
  test("сотрудник с созданными методиками не удаляется из базы", async () => {
    /*
     * Эндпоинта удаления пользователя нет, и проверяется здесь не он, а сам
     * внешний ключ: раньше `createdBy` был каскадным, и одна ручная чистка
     * учётки в psql уносила бы методики вместе со всеми прохождениями.
     */
    let failed = false;
    try {
      await db.delete(users).where(eq(users.id, adminA.id));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    const survey = await api(`/api/surveys/${surveyInA}`, adminA.token);
    expect(survey.status).toBe(200);
  });

  test("данные, принадлежащие самому человеку, уходят вместе с ним", async () => {
    // пациент без авторства удаляется, и его согласия/назначения уходят каскадом
    const throwaway = await makeUser("user", "throwaway@test");
    await db.delete(users).where(eq(users.id, throwaway.id));
    const left = await db.select().from(users).where(eq(users.id, throwaway.id));
    expect(left.length).toBe(0);
  });
});

/* ── согласия ── */

describe("информированное согласие", () => {
  test("новая версия текста сбрасывает принятие; след с версией", async () => {
    // текста ещё нет — согласие не требуется
    const empty = await api("/api/consents/me", patient.token);
    expect(empty.body.required).toBe(false);

    // суперадмин задаёт текст
    const put = await api("/api/consents/text", root.token, {
      method: "PUT",
      body: JSON.stringify({ body: { uk: "Текст згоди, версія перша", ru: "Текст согласия, версия первая" } }),
    });
    expect(put.body.version).toBe(1);

    const before = await api("/api/consents/me", patient.token);
    expect(before.body.required).toBe(true);
    expect(before.body.accepted).toBe(false);
    // без Accept-Language сервер отдаёт украинский — это дефолт госпиталя
    expect(before.body.text).toContain("версія перша");

    await api("/api/consents/me/accept", patient.token, { method: "POST" });
    const after = await api("/api/consents/me", patient.token);
    expect(after.body.accepted).toBe(true);

    // правка текста → согласие требуется заново
    await api("/api/consents/text", root.token, {
      method: "PUT",
      body: JSON.stringify({ body: { uk: "Оновлений текст згоди", ru: "Обновлённый текст согласия" } }),
    });
    const reset = await api("/api/consents/me", patient.token);
    expect(reset.body.accepted).toBe(false);
    expect(reset.body.version).toBe(2);
  });

  test("правка текста — только суперадмину", async () => {
    const res = await api("/api/consents/text", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ body: { uk: "Спроба адміна групи", ru: "Попытка админа группы" } }),
    });
    expect(res.status).toBe(403);
  });
});

describe("полнота проверки зоны на маршрутах о пациенте", () => {
  /*
   * Список маршрутов берётся из самого приложения, а не пишется руками:
   * ровно так уже нашлись четыре таблицы без политик RLS. Новый маршрут с
   * `:userId` попадёт под проверку в тот же день, когда появится, — и если
   * забыть в нём проверку зоны, тест упадёт, а не промолчит.
   *
   * У adminB есть собственная методика (фикстуры), поэтому отказ приходит
   * именно из-за чужого пациента, а не из-за пустой зоны.
   */
  const notAboutPatients = new Set([
    // управление правами: адресат — не пациент, а сотрудник или грант
    "DELETE /api/groups/:id/admins/:userId",
    "DELETE /api/access/surveys/:id/grants/:userId",
  ]);

  test("ни один не отвечает про пациента вне зоны", async () => {
    const person = await makeUser("user", `sweep-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    const routes = (app as unknown as { routes: { method: string; path: string }[] }).routes;
    const checked = [
      ...new Set(
        routes
          .map((r) => `${r.method} ${r.path}`)
          .filter((r) => r.includes(":userId") && !notAboutPatients.has(r)),
      ),
    ];
    expect(checked.length).toBeGreaterThan(5);

    const leaked: string[] = [];
    for (const route of checked) {
      const [method, path] = route.split(" ") as [string, string];
      const url = path.replace(":userId", person.id);
      const res = await app.request(url, {
        method,
        headers: {
          Authorization: `Bearer ${adminB.token}`,
          "Content-Type": "application/json",
        },
        // тело заведомо неполное: до валидации дело дойти не должно
        body: method === "GET" ? undefined : "{}",
      });
      // 404 — «вне зоны его нет»; 403 — прямой отказ. Всё остальное значит,
      // что маршрут начал отвечать о чужом пациенте.
      if (res.status !== 404 && res.status !== 403) leaked.push(`${route} → ${res.status}`);
    }

    expect(leaked).toEqual([]);
  });
});
