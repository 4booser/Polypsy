import { afterAll, describe, expect, test } from "bun:test";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { renderError, type User } from "@quizzy/shared";
import {
  api,
  app,
  appApi,
  createSurveySchema,
  createVersion,
  db,
  makeUser,
  root,
  surveyGroups,
  surveys,
  type Person,
} from "./fixtures";
import { asAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { withDbContext } from "../src/db/context";
import {
  alertCases,
  auditLog,
  batteryAssignments,
  departmentPatients,
  departments,
  groupAdmins,
  responses,
  riskAlerts,
  specialistProfiles,
  surveyAccess,
  surveyVersions,
} from "../src/db/schema";
import { CATALOG_GROUP_ID, patientsInScope, staffInChargeOf } from "../src/lib/scope";

/**
 * Методики общего каталога — библиотека всех сотрудников (lib/scope.ts,
 * миграция 0134).
 *
 * Прежде каталог был обычной группой: врач без неё не видел ни одного
 * результата каталога (на стенде — «замеров нет» у каждого из ста двадцати
 * пациентов), а врачи, назначенные её администраторами руками, получали
 * правку выверенных методик и каждого, кто проходил методику каталога, из
 * любого отделения.
 *
 * Мир: два отделения, D и E, по врачу без групп в каждом (в D — ещё
 * коллега), администратор группы каталога без отделения; пациент D,
 * пациент E и ничей. Методика каталога — своя у файла, с критическим
 * вариантом: сдача поднимает тревогу и случай. Выдана она и пациенту E —
 * суперадмином: выдача методики библиотеки в зону не вводит, и это тоже
 * проверяется.
 *
 * Всё — владельцем базы (api) и ролью приложения (appApi), как в бою;
 * файл стоит и в списке test:app-role.
 */

const SLOW = 30_000;
const tag = crypto.randomUUID().slice(0, 8);
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const calls = [
  ["владелец", api],
  ["роль приложения", appApi],
] as const;

/* ── отделения и люди ── */

const deptD = crypto.randomUUID();
const deptE = crypto.randomUUID();
await db.insert(departments).values([
  { id: deptD, title: { uk: `Відділення D ${tag}`, ru: `Отделение D ${tag}` }, timezone: "Europe/Kyiv" },
  { id: deptE, title: { uk: `Відділення E ${tag}`, ru: `Отделение E ${tag}` }, timezone: "Europe/Kyiv" },
]);

const doctorD = await makeUser("admin", `lib-doc-d-${tag}@test`);
const colleagueD = await makeUser("admin", `lib-colleague-d-${tag}@test`);
const doctorE = await makeUser("admin", `lib-doc-e-${tag}@test`);
/* администратор группы каталога — без отделения: правит каталог, людей своих у него нет */
const editor = await makeUser("admin", `lib-editor-${tag}@test`);
await db.insert(specialistProfiles).values([
  { userId: doctorD.id, departmentId: deptD },
  { userId: colleagueD.id, departmentId: deptD },
  { userId: doctorE.id, departmentId: deptE },
]);

const patientD = await makeUser("user", `lib-p-d-${tag}@test`);
const patientE = await makeUser("user", `lib-p-e-${tag}@test`);
const nobody = await makeUser("user", `lib-p-none-${tag}@test`);
await db.insert(departmentPatients).values([
  { departmentId: deptD, patientId: patientD.id, attachedVia: "staff" },
  { departmentId: deptE, patientId: patientE.id, attachedVia: "staff" },
] as never);

/* группа каталога — та, что заводит установщик; соседний файл мог её уже завести */
await db
  .insert(surveyGroups)
  .values({ id: CATALOG_GROUP_ID, title: "Каталог методик", position: 1000, createdBy: root.id })
  .onConflictDoNothing();
await db.insert(groupAdmins).values({ groupId: CATALOG_GROUP_ID, userId: editor.id, addedBy: root.id });

/* ── методика каталога с критическим вариантом ── */

const library = crypto.randomUUID();
{
  const title = `Скринінг каталогу ${tag}`;
  const draft = createSurveySchema.parse({
    title: { uk: title, ru: title },
    administration: "self",
    scoringEnabled: false,
    questions: [
      {
        type: "single",
        title: { uk: "Чи були думки, що краще не жити?", ru: "Были ли мысли, что лучше не жить?" },
        required: true,
        options: [
          {
            text: { uk: "Часто", ru: "Часто" },
            score: 3,
            riskFlag: true,
            riskLabel: { uk: "Думки про небажання жити", ru: "Мысли о нежелании жить" },
            riskSeverity: "severe",
          },
          { text: { uk: "Ні", ru: "Нет" }, score: 0 },
        ],
      },
    ],
    scales: [],
  });
  await db.insert(surveys).values({
    id: library,
    groupId: CATALOG_GROUP_ID,
    title: draft.title,
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "restricted",
    scoringEnabled: false,
    allowRetake: true,
    createdBy: root.id,
  } as never);
  await createVersion(library, draft, root.id, "v1");
}

/* выдана обоим пациентам суперадмином: выдача методики библиотеки никого не вводит в зону */
await db.insert(surveyAccess).values(
  [patientD, patientE].map((p) => ({ surveyId: library, userId: p.id, grantedBy: root.id })),
);

/** Сдача критическим вариантом — тем же путём, что в бою: прохождение, тревога, случай */
async function submitRisky(person: Person): Promise<string> {
  const loaded = await api(`/api/surveys/${library}`, person.token);
  expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
  const answers = loaded.body.questions.map((q: { id: string; options: { id: string }[] }) => ({
    questionId: q.id,
    optionIds: [q.options[0]!.id],
    durationMs: 1500,
    changeCount: 0,
    visitCount: 1,
  }));
  const res = await api(
    `/api/surveys/${library}/responses`,
    person.token,
    post({ startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 60_000, events: [], answers }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const responseD = await submitRisky(patientD);
const responseE = await submitRisky(patientE);

const ids = (items: { id: string }[]) => items.map((i) => i.id);

/** Выгрузка текстом — владельцем базы или ролью приложения: api разбирает тело как JSON */
async function download(path: string, who: Person, appRole: boolean): Promise<{ status: number; text: string }> {
  const run = async () => app.request(path, { headers: { Authorization: `Bearer ${who.token}` } });
  const res = appRole ? await asAppRole(run) : await run();
  return { status: res.status, text: await res.text() };
}
const asUser = (p: Person, role: "admin" | "superadmin" = "admin") => ({ id: p.id, role }) as User;

/* случаи и тревоги файла закрываются: суперадмин видит любые, а очередь общая на процесс */
afterAll(async () => {
  const now = new Date().toISOString();
  await db.update(alertCases).set({ acknowledgedAt: now }).where(eq(alertCases.surveyId, library));
  await db.update(riskAlerts).set({ acknowledgedAt: now }).where(eq(riskAlerts.surveyId, library));
});

describe("методики каталога — библиотека всех сотрудников", () => {
  test(
    "врач отделения без групп находит методику каталога, читает ключ и назначает своему пациенту — чужому и ничьему нет",
    async () => {
      for (const [who, call] of calls) {
        const list = await call(`/api/surveys?groupId=${CATALOG_GROUP_ID}`, doctorD.token);
        expect(list.status, who).toBe(200);
        const row = list.body.items.find((s: { id: string }) => s.id === library);
        expect(row, `${who}: методики каталога нет в каталоге врача`).toBeDefined();
        expect(row.editable, `${who}: врачу предложена правка методики каталога`).toBe(false);
        // число прохождений в строке каталога — только его людей, а не всех отделений
        expect(row.responseCount, `${who}: счёт прохождений каталога по всему учреждению`).toBe(1);

        const one = await call(`/api/surveys/${library}`, doctorD.token);
        expect(one.status, who).toBe(200);
        expect(one.body.editable).toBe(false);
        expect((await call(`/api/surveys/${library}/key`, doctorD.token)).status, `${who}: ключ`).toBe(200);
        expect((await call(`/api/surveys/${library}/versions`, doctorD.token)).status, `${who}: версии`).toBe(200);

        // выбор пациента для назначения — зона врача: пациент отделения есть, чужого и ничьего нет
        const picker = await call("/api/access/patients", doctorD.token);
        expect(picker.status, who).toBe(200);
        const picked = ids(picker.body.items);
        expect(picked, `${who}: пациента своего отделения нет в выборе`).toContain(patientD.id);
        expect(picked).not.toContain(patientE.id);
        expect(picked).not.toContain(nobody.id);

        const mine = await call(`/api/access/surveys/${library}/grants`, doctorD.token, post({ userId: patientD.id }));
        expect(mine.status, `${who}: ${JSON.stringify(mine.body)}`).toBe(201);
        /*
         * Мутация: убрать отказ библиотеки в POST /grants — «ничьему» выдача
         * проходит владельцем базы и падает пятисоткой ролью приложения.
         */
        for (const other of [patientE, nobody]) {
          const refused = await call(`/api/access/surveys/${library}/grants`, doctorD.token, post({ userId: other.id }));
          expect(refused.status, `${who}: методика каталога выдана человеку вне зоны`).toBe(404);
        }
        // и администратору каталога: правка каталога зоны не даёт
        const byEditor = await call(`/api/access/surveys/${library}/grants`, editor.token, post({ userId: patientE.id }));
        expect(byEditor.status, who).toBe(404);
      }
      const [grantE] = await db
        .select({ grantedBy: surveyAccess.grantedBy })
        .from(surveyAccess)
        .where(and(eq(surveyAccess.surveyId, library), eq(surveyAccess.userId, patientE.id)));
      expect(grantE?.grantedBy, "отказанная выдача переписала доступ").toBe(root.id);
      expect(
        await db.select().from(surveyAccess).where(and(eq(surveyAccess.surveyId, library), eq(surveyAccess.userId, nobody.id))),
      ).toEqual([]);

      // назначения методики — только его людей
      for (const [who, call] of calls) {
        const grants = await call(`/api/access/surveys/${library}/grants`, doctorD.token);
        expect(grants.status, who).toBe(200);
        expect(grants.body.items.map((g: { userId: string }) => g.userId), who).toEqual([patientD.id]);
      }
    },
    SLOW,
  );

  test(
    "результат каталога о пациенте своего отделения — в карточке, динамике, прохождении, тревогах и очереди случаев",
    async () => {
      for (const [who, call] of calls) {
        const card = await call(`/api/patients/${patientD.id}/card`, doctorD.token);
        expect(card.status, who).toBe(200);
        expect(card.body.responses.map((r: { responseId: string }) => r.responseId), `${who}: карточка`).toContain(responseD);

        const dynamics = await call(`/api/dynamics/respondents/${patientD.id}`, doctorD.token);
        expect(dynamics.status, who).toBe(200);
        expect(dynamics.body.surveys.map((s: { surveyId: string }) => s.surveyId), `${who}: динамика`).toContain(library);

        expect((await call(`/api/responses/${responseD}`, doctorD.token)).status, `${who}: прохождение`).toBe(200);

        const alerts = await call("/api/alerts?all=1&limit=500", doctorD.token);
        expect(alerts.status, who).toBe(200);
        const alertResponses = alerts.body.items.map((a: { responseId: string }) => a.responseId);
        expect(alertResponses, `${who}: тревоги`).toContain(responseD);
        expect(alertResponses, `${who}: тревога пациента чужого отделения`).not.toContain(responseE);

        const cases = await call("/api/alert-cases?limit=100", doctorD.token);
        expect(cases.status, who).toBe(200);
        const caseUsers = cases.body.items.map((c: { userId: string }) => c.userId);
        expect(caseUsers, `${who}: очередь случаев`).toContain(patientD.id);
        expect(caseUsers).not.toContain(patientE.id);
        // у врача отделения D других людей нет: в бейдже очереди — ровно один
        expect((await call("/api/alert-cases/count", doctorD.token)).body.total, `${who}: бейдж очереди`).toBe(1);

        // реестр: последняя сдача — методикой каталога, без неё было бы «замеров нет»
        const registry = await call("/api/patients", doctorD.token);
        expect(registry.status, who).toBe(200);
        const rowD = registry.body.items.find((r: { id: string }) => r.id === patientD.id);
        expect(rowD?.lastResponseAt, `${who}: реестр не видит сдачи каталога`).not.toBeNull();
        expect(rowD?.risk, `${who}: реестр не видит случая каталога`).not.toBeNull();
        expect(ids(registry.body.items)).not.toContain(patientE.id);
      }
    },
    SLOW,
  );

  test(
    "пациента другого отделения нет нигде: карточка, прохождение, списки, аналитика, подбор, выгрузка, очередь работы",
    async () => {
      /* повтор по протоколу, просроченный у обоих: очередь работы врача D обязана назвать только своего */
      const past = new Date(Date.now() - 30 * 86_400_000).toISOString();
      await db
        .update(surveyAccess)
        .set({ grantedAt: past, expiresAt: new Date(Date.now() - 60_000).toISOString(), note: "Протокол наблюдения: повтор" })
        .where(and(eq(surveyAccess.surveyId, library), inArray(surveyAccess.userId, [patientD.id, patientE.id])));
      await db.update(responses).set({ submittedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() })
        .where(inArray(responses.id, [responseD, responseE]));
      try {
        for (const [who, call] of calls) {
          expect((await call(`/api/patients/${patientE.id}/card`, doctorD.token)).status, `${who}: карточка`).toBe(404);
          expect((await call(`/api/responses/${responseE}`, doctorD.token)).status, `${who}: прохождение`).toBe(404);
          expect((await call(`/api/dynamics/respondents/${patientE.id}`, doctorD.token)).status, `${who}: динамика`).toBe(404);

          const list = await call(`/api/surveys/${library}/responses`, doctorD.token);
          expect(list.status, who).toBe(200);
          expect(list.body.rows.map((r: { id: string }) => r.id), `${who}: список прохождений`).toEqual([responseD]);

          const analytics = await call(`/api/analytics/surveys/${library}`, doctorD.token);
          expect(analytics.status, who).toBe(200);
          expect(analytics.body.completed, `${who}: аналитика методики`).toBe(1);
          // сводка по всем методикам: своих групп у врача нет — весь его видимый мир одно прохождение каталога
          const overview = await call("/api/analytics/overview", doctorD.token);
          expect(overview.status, who).toBe(200);
          expect(overview.body.responseCount, `${who}: сводка аналитики`).toBe(1);
          expect(overview.body.respondentCount, who).toBe(1);

          /*
           * Подбор людей: размер ниже порога малых чисел на экран не идёт
           * (null), поэтому настоящий — из строки журнала cohort.preview.
           */
          const cohort = await call("/api/cohorts/preview", doctorD.token, post({ surveyId: library }));
          expect(cohort.status, `${who}: ${JSON.stringify(cohort.body)}`).toBe(200);
          const [logged] = await db
            .select({ details: auditLog.details })
            .from(auditLog)
            .where(and(eq(auditLog.action, "cohort.preview"), eq(auditLog.actorId, doctorD.id)))
            .orderBy(desc(auditLog.at))
            .limit(1);
          expect(logged?.details?.size, `${who}: подбор людей`).toBe(1);

          const respondents = await call(`/api/dynamics/respondents?limit=100`, doctorD.token);
          expect(respondents.body.items.map((r: { userId: string }) => r.userId), `${who}: повторные`).not.toContain(patientE.id);

          const work = await call("/api/worklist", doctorD.token);
          expect(work.status, who).toBe(200);
          const followups = work.body.items.filter((i: { kind: string }) => i.kind === "followup").map((i: { userId: string }) => i.userId);
          expect(followups, `${who}: повтор своего пациента`).toContain(patientD.id);
          expect(followups, `${who}: повтор пациента чужого отделения`).not.toContain(patientE.id);
        }
        /*
         * Выгрузки — текстом: строка чужого прохождения не должна уехать ни в
         * каком виде. Длинная выгрузка читает витрину response_facts — под
         * ролью приложения её держит security_invoker (0134), а не одна
         * проверка маршрута.
         */
        for (const appRole of [false, true]) {
          for (const path of [
            `/api/analytics/surveys/${library}/export`,
            `/api/spss/surveys/${library}/long.csv?profile=full`,
            `/api/spss/surveys/${library}/data.csv?profile=full`,
          ]) {
            const file = await download(path, doctorD, appRole);
            expect(file.status, `${path}: ${file.text.slice(0, 200)}`).toBe(200);
            expect(file.text, `${path}${appRole ? " (роль приложения)" : ""}: чужой пациент в выгрузке`).not.toContain(patientE.id);
          }
          const csv = await download(`/api/analytics/surveys/${library}/export`, doctorD, appRole);
          expect(csv.text, "своё прохождение пропало из выгрузки").toContain(responseD);
          expect(csv.text).not.toContain(responseE);
        }
      } finally {
        await db
          .update(surveyAccess)
          .set({ expiresAt: null, note: null })
          .where(and(eq(surveyAccess.surveyId, library), inArray(surveyAccess.userId, [patientD.id, patientE.id])));
      }
    },
    SLOW,
  );

  test(
    "врач методику каталога не правит: правка, новая версия, перенос, снятие, возврат — отказ; копия — его личный черновик",
    async () => {
      const readOnly = renderError("err.surveyLibraryReadOnly", "uk");
      const versionsBefore = await db.select({ id: surveyVersions.id }).from(surveyVersions).where(eq(surveyVersions.surveyId, library));
      for (const [who, call] of calls) {
        const edit = await call(`/api/surveys/${library}`, doctorD.token, patch({ showResultsToPatient: true }));
        expect(edit.status, who).toBe(403);
        expect(edit.body.error, who).toBe(readOnly);
        const version = await call(
          `/api/surveys/${library}`,
          doctorD.token,
          patch({ versionNote: "правка врача", questions: [{ type: "info", title: { uk: "Ні", ru: "Нет" } }] }),
        );
        expect(version.status, `${who}: новая версия`).toBe(403);
        const moved = await call(`/api/surveys/${library}/folder`, doctorD.token, { method: "PUT", body: JSON.stringify({ folderId: null }) });
        expect(moved.status, `${who}: перенос`).toBe(403);
        expect((await call(`/api/surveys/${library}`, doctorD.token, { method: "DELETE" })).status, `${who}: снятие`).toBe(403);
        expect((await call(`/api/surveys/${library}/restore`, doctorD.token, { method: "POST" })).status, `${who}: возврат`).toBe(403);
        expect(
          (await call(`/api/norms/surveys/${library}/apply`, doctorD.token, post({ scaleCodes: ["X"] }))).status,
          `${who}: локальные нормы`,
        ).toBe(403);

        const copy = await call(`/api/surveys/${library}/duplicate`, doctorD.token, { method: "POST" });
        expect(copy.status, `${who}: ${JSON.stringify(copy.body)}`).toBe(201);
        expect(copy.body.groupId, `${who}: копия легла в каталог`).toBeNull();
        await db.delete(surveys).where(eq(surveys.id, copy.body.id));
      }
      const [row] = await db.select().from(surveys).where(eq(surveys.id, library));
      expect(row?.showResultsToPatient, "отказанная правка дошла до строки").toBe(false);
      expect(row?.archivedAt).toBeNull();
      const versionsAfter = await db.select({ id: surveyVersions.id }).from(surveyVersions).where(eq(surveyVersions.surveyId, library));
      expect(versionsAfter.length, "отказанная правка выпустила версию").toBe(versionsBefore.length);
    },
    SLOW,
  );

  test(
    "администратор группы каталога правит методику, а её результаты видит по общему правилу: людей вне зоны — нет",
    async () => {
      for (const [who, call] of calls) {
        const one = await call(`/api/surveys/${library}`, editor.token);
        expect(one.body.editable, who).toBe(true);
        const on = await call(`/api/surveys/${library}`, editor.token, patch({ showResultsToPatient: true }));
        expect(on.status, `${who}: ${JSON.stringify(on.body)}`).toBe(200);
        const off = await call(`/api/surveys/${library}`, editor.token, patch({ showResultsToPatient: false }));
        expect(off.status, who).toBe(200);

        // прежде строка group_admins каталога открывала ему каждого, кто проходил методику каталога
        expect((await call(`/api/patients/${patientE.id}/card`, editor.token)).status, `${who}: карточка`).toBe(404);
        expect((await call(`/api/responses/${responseE}`, editor.token)).status, `${who}: прохождение`).toBe(404);
        const list = await call(`/api/surveys/${library}/responses`, editor.token);
        expect(list.body.rows, `${who}: список прохождений`).toEqual([]);
        const alerts = await call("/api/alerts?all=1&limit=500", editor.token);
        const alertResponses = alerts.body.items.map((a: { responseId: string }) => a.responseId);
        expect(alertResponses, who).not.toContain(responseD);
        expect(alertResponses, who).not.toContain(responseE);
      }
      // суперадмин видит всё, как и прежде
      const all = await api(`/api/surveys/${library}/responses`, root.token);
      expect(all.body.rows.map((r: { id: string }) => r.id).sort()).toEqual([responseD, responseE].sort());
    },
    SLOW,
  );

  test(
    "под ролью приложения политики строк держат то же правило — прямым чтением таблиц",
    async () => {
      /** Что видно сотруднику в таблице под политиками: строки этой методики */
      const visible = (who: Person, role: "admin" | "superadmin", table: "responses" | "risk_alerts" | "alert_cases" | "survey_access") =>
        asAppRole(() =>
          withDbContext(baseDb, { userId: who.id, role }, async () =>
            [
              ...(await db.execute<{ user_id: string }>(
                sql`select user_id from ${sql.raw(table)} where survey_id = ${library} order by user_id`,
              )),
            ].map((r) => r.user_id),
          ),
        );
      for (const table of ["responses", "risk_alerts", "alert_cases", "survey_access"] as const) {
        expect(await visible(doctorD, "admin", table), `${table}: врач D`).toEqual([patientD.id]);
        expect(await visible(doctorE, "admin", table), `${table}: врач E`).toEqual([patientE.id]);
        expect(await visible(editor, "admin", table), `${table}: администратор каталога`).toEqual([]);
        expect((await visible(root, "superadmin", table)).sort(), `${table}: суперадмин`).toEqual([patientD.id, patientE.id].sort());
      }

      const inContext = <T>(who: Person, fn: () => Promise<T>) =>
        asAppRole(() => withDbContext(baseDb, { userId: who.id, role: "admin" }, fn));
      // ответы и баллы — вместе с прохождением
      const answersOf = (who: Person) =>
        inContext(who, async () =>
          [
            ...(await db.execute<{ response_id: string }>(
              sql`select distinct a.response_id from answers a where a.response_id in (${responseD}, ${responseE})`,
            )),
          ].map((r) => r.response_id),
        );
      expect(await answersOf(doctorD)).toEqual([responseD]);
      expect(await answersOf(editor)).toEqual([]);

      // строку методики врач читает, а править не может: UPDATE не находит строк
      const touched = await inContext(doctorD, async () => {
        const seen = await db.select({ id: surveys.id }).from(surveys).where(eq(surveys.id, library));
        const changed = await db.update(surveys).set({ allowBack: false }).where(eq(surveys.id, library)).returning({ id: surveys.id });
        return { seen: seen.length, changed: changed.length };
      });
      expect(touched).toEqual({ seen: 1, changed: 0 });

      // группа библиотеки в политиках — тот же идентификатор, что CATALOG_GROUP_ID
      const [same] = await db.execute<{ yes: boolean; no: boolean }>(
        sql`select rls_library_group(${CATALOG_GROUP_ID}) as yes, rls_library_group('catalog-x') as no`,
      );
      expect(same).toEqual({ yes: true, no: false });
    },
    SLOW,
  );

  test(
    "кто ведёт человека — та же зона, увиденная с его стороны: адресаты тревог каталога",
    async () => {
      const staff = [doctorD, colleagueD, doctorE, editor];
      for (const person of [patientD, patientE, nobody]) {
        const inCharge = new Set((await staffInChargeOf(person.id)).map((s) => s.id));
        for (const s of staff) {
          const sees = (await patientsInScope(asUser(s), [person.id]))?.has(person.id) ?? true;
          expect(inCharge.has(s.id), `${s.id} → ${person.id}`).toBe(sees);
        }
      }
      const forD = (await staffInChargeOf(patientD.id)).map((s) => s.id);
      expect(forD).toEqual(expect.arrayContaining([doctorD.id, colleagueD.id]));
      expect(forD).not.toContain(doctorE.id);
      expect(forD, "тревога каталога ушла бы администратору каталога").not.toContain(editor.id);
    },
    SLOW,
  );

  test(
    "общий набор из методики каталога: назначают его человеку своей зоны, а назначения каждый видит только о своих",
    async () => {
      const made = await api("/api/batteries", root.token, post({ title: `Спільний набір ${tag}`, items: [{ surveyId: library }] }));
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const batteryId = made.body.id as string;

      const given = await appApi(`/api/batteries/${batteryId}/assign`, doctorE.token, post({ userId: patientE.id }));
      expect(given.status, JSON.stringify(given.body)).toBe(201);
      try {
        for (const [who, call] of calls) {
          // врачу D пациент E чужой: общий набор в зону не вводит
          const refused = await call(`/api/batteries/${batteryId}/assign`, doctorD.token, post({ userId: patientE.id }));
          expect(refused.status, `${who}: общий набор назначен человеку вне зоны`).toBe(404);

          const theirs = await call(`/api/batteries/${batteryId}/assignments`, doctorD.token);
          expect(theirs.status, who).toBe(200);
          expect(theirs.body.items.map((a: { userId: string }) => a.userId), `${who}: чужое назначение`).toEqual([]);
          const own = await call(`/api/batteries/${batteryId}/assignments`, doctorE.token);
          expect(own.body.items.map((a: { userId: string }) => a.userId), who).toEqual([patientE.id]);

          const listD = await call("/api/batteries", doctorD.token);
          const rowD = listD.body.items.find((b: { id: string }) => b.id === batteryId);
          expect(rowD?.items.map((i: { surveyId: string }) => i.surveyId), `${who}: шаги общего набора`).toEqual([library]);
          expect(rowD?.activeAssignments, `${who}: счётчик назначений общего набора`).toBe(0);
        }
        const [stored] = await db
          .select({ id: batteryAssignments.id })
          .from(batteryAssignments)
          .where(and(eq(batteryAssignments.batteryId, batteryId), eq(batteryAssignments.userId, patientE.id)));
        expect(stored?.id).toBe(given.body.id);
      } finally {
        await api(`/api/batteries/assignments/${given.body.id}/cancel`, root.token, { method: "POST" });
      }
    },
    SLOW,
  );

  test(
    "полки каталога видны каждому сотруднику, а заводят, правят и перекладывают их администраторы каталога",
    async () => {
      /*
       * Методика каталога в папке: у врача без группы каталога её папка
       * обязана быть видна — иначе из корня каталога методика пропала бы
       * (корень — методики вне папок). Мутация: убрать группу библиотеки из
       * GET /api/survey-folders (или политику survey_folders_library_read) —
       * папки у врача нет.
       */
      const made = await appApi("/api/survey-folders", editor.token, post({ groupId: CATALOG_GROUP_ID, title: `Полиця каталогу ${tag}` }));
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const folderId = made.body.id as string;
      const move = (who: Person, to: string | null) =>
        appApi(`/api/surveys/${library}/folder`, who.token, { method: "PUT", body: JSON.stringify({ folderId: to }) });
      expect((await move(editor, folderId)).status).toBe(200);
      try {
        for (const [who, call] of calls) {
          const folders = await call("/api/survey-folders", doctorD.token);
          expect(folders.status, who).toBe(200);
          expect(ids(folders.body.items), `${who}: полки каталога нет у врача`).toContain(folderId);
          const inFolder = await call(`/api/surveys?folder=${folderId}`, doctorD.token);
          expect(ids(inFolder.body.items), `${who}: методика в полке каталога`).toContain(library);

          const renamed = await call(`/api/survey-folders/${folderId}`, doctorD.token, patch({ title: "Моя полиця" }));
          expect(renamed.status, `${who}: врач переименовал полку каталога`).toBe(403);
          expect((await call("/api/survey-folders", doctorD.token, post({ groupId: CATALOG_GROUP_ID, title: "Ще одна" }))).status).toBe(403);
        }
        expect((await move(doctorD, null)).status, "врач переложил методику каталога").toBe(403);
      } finally {
        expect((await move(editor, null)).status).toBe(200);
        expect((await appApi(`/api/survey-folders/${folderId}`, editor.token, { method: "DELETE" })).status).toBeLessThan(300);
      }
    },
    SLOW,
  );

  test(
    "приглашение к методике каталога — отделения выписавшего, как приглашение ни к чему",
    async () => {
      const made = await appApi("/api/invites", doctorD.token, post({ surveyId: library }));
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const listed = async (who: Person) => {
        const res = await appApi("/api/invites?limit=100", who.token);
        expect(res.status).toBe(200);
        return (res.body.items as { id: string }[]).some((i) => i.id === made.body.id);
      };
      expect(await listed(doctorD)).toBe(true);
      expect(await listed(colleagueD)).toBe(true);
      expect(await listed(root)).toBe(true);
      expect(await listed(doctorE), "приглашение к каталогу видно чужому отделению").toBe(false);
      expect(await listed(editor)).toBe(false);
    },
    SLOW,
  );
});
