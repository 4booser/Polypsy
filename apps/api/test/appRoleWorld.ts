import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  alertCases,
  appointments,
  departments,
  riskAlerts,
  slots,
  specialistProfiles,
  staffRoles,
  users,
} from "../src/db/schema";
import {
  createSurveySchema,
  createVersion,
  db,
  groupAdmins,
  makeUser,
  root,
  surveyGroups,
  surveys,
  type Person,
} from "./fixtures";

/**
 * Свой маленький мир для сценариев под ролью приложения.
 *
 * Каждый файл сценариев строит его заново, со своими идентификаторами:
 * CI обходит файлы в другом порядке, чем macOS, база у всех одна, и мир,
 * общий на несколько файлов, превратил бы порядок обхода в условие теста.
 *
 * Мир нарочно не пустой по краям: у зоны есть «чужой» — пациент другой
 * группы и администратор другой группы. Без них проверка «видит своих»
 * не отличалась бы от «видит всех» — политики строк проверяются именно
 * на границе.
 *
 * Фикстуры заводятся владельцем (прямыми вставками), а не под ролью: это
 * подготовка сцены, а не проверяемый путь. Всё, что проверяется, идёт
 * через appApi.
 */
export interface World {
  tag: string;
  groupId: string;
  /** Администратор своей группы (встроенная роль) */
  admin: Person;
  /** Чужая группа и её администратор — граница зоны */
  otherGroupId: string;
  otherAdmin: Person;
  departmentId: string;
  /** Специалист отделения (роль «специалист»): профиль, свободные слоты, ведущий у пациента */
  specialist: Person;
  /** Методика своей группы: критический первый вариант, результаты видны пациенту */
  surveyOpen: string;
  /** Методика своей группы: результаты у специалиста */
  surveyHidden: string;
  /** Методика чужой группы — ею пациент «соседа» попадает в чужую зону */
  surveyOther: string;
  patient: Person & { email: string };
  /** Пациент чужой группы: его своя зона видеть не должна */
  stranger: Person & { email: string };
  /** Свободные слоты специалиста (в будущем, не пересекаются) */
  slotIds: string[];
  /** Всё, что сценарии завели в общих очередях, — чтобы закрыть в afterAll */
  cleanup: { appointments: string[]; people: string[] };
}

const L = (uk: string, ru: string, en = uk) => ({ uk, ru, en });

/** Методика с одним вопросом: первый вариант — критический, тяжёлая полоса */
function criticalDraft(title: string) {
  return createSurveySchema.parse({
    title: L(title, title),
    administration: "self",
    scoringEnabled: true,
    questions: [
      {
        type: "single",
        title: L("Чи були думки, що краще не жити?", "Были ли мысли, что лучше не жить?"),
        required: true,
        scaleCode: "S",
        options: [
          {
            text: L("Часто", "Часто"),
            score: 3,
            riskFlag: true,
            riskLabel: L("Часті думки про небажання жити", "Частые мысли о нежелании жить"),
            riskSeverity: "severe",
          },
          { text: L("Ні", "Нет"), score: 0 },
        ],
      },
      {
        type: "single",
        title: L("Як ви спите?", "Как вы спите?"),
        required: true,
        scaleCode: "S",
        options: [
          { text: L("Погано", "Плохо"), score: 1 },
          { text: L("Добре", "Хорошо"), score: 0 },
        ],
      },
    ],
    scales: [
      {
        code: "S",
        title: L("Тяжкість стану", "Тяжесть состояния"),
        kind: "clinical",
        normalization: "raw",
        key: [{ item: 1 }, { item: 2 }],
        bands: [
          { minScore: 0, maxScore: 1, label: L("Немає", "Нет"), severity: "none" },
          { minScore: 2, maxScore: 4, label: L("Виражена", "Выраженная"), severity: "severe" },
        ],
      },
    ],
  });
}

async function publishedSurvey(
  groupId: string,
  author: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const draft = criticalDraft(title);
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId,
    title: draft.title,
    safetyPlan: L("Якщо важко просто зараз — зателефонуйте 7333", "Если тяжело прямо сейчас — позвоните 7333"),
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    /* закрытая: чужие файлы, сдающие «первую попавшуюся» общую методику, её не увидят */
    visibility: "restricted",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: author,
    ...extra,
  } as never);
  await createVersion(id, draft, author, "v1");
  return id;
}

let slotSeq = 0;

/** Свободный слот специалиста: далеко в будущем, у каждого вызова — своё время */
export async function futureSlot(w: Pick<World, "specialist" | "departmentId">): Promise<string> {
  slotSeq += 1;
  const start = Date.now() + 120 * 3600_000 + slotSeq * 2 * 3600_000;
  const id = crypto.randomUUID();
  await db.insert(slots).values({
    id,
    specialistId: w.specialist.id,
    departmentId: w.departmentId,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3600_000).toISOString(),
  });
  return id;
}

export async function buildWorld(tag: string): Promise<World> {
  const u = `${tag}-${crypto.randomUUID()}`;
  const groupId = crypto.randomUUID();
  const otherGroupId = crypto.randomUUID();
  await db.insert(surveyGroups).values([
    { id: groupId, title: `Група ${tag}`, createdBy: root.id },
    { id: otherGroupId, title: `Чужа група ${tag}`, createdBy: root.id },
  ]);
  const admin = await makeUser("admin", `role-adm-${u}@test.dev`);
  const otherAdmin = await makeUser("admin", `role-oth-${u}@test.dev`);
  await db.insert(groupAdmins).values([
    { groupId, userId: admin.id, addedBy: root.id },
    { groupId: otherGroupId, userId: otherAdmin.id, addedBy: root.id },
  ]);

  const departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: L(`Відділення ${tag}`, `Отделение ${tag}`),
    timezone: "Europe/Kyiv",
  });
  /*
   * Специалист — узкая роль «специалист» (не встроенная широкая): так
   * сценарий видит и то, что ему можно, и явные отказы по правам. Он же
   * сотрудник своей группы: его зона — и приём, и методики группы.
   */
  const specialist = await makeUser("admin", `role-spec-${u}@test.dev`);
  await db.delete(staffRoles).where(eq(staffRoles.userId, specialist.id));
  await db.insert(staffRoles).values({ userId: specialist.id, roleId: "role-specialist", grantedBy: root.id });
  await db.insert(groupAdmins).values({ groupId, userId: specialist.id, addedBy: root.id });
  await db.insert(specialistProfiles).values({ userId: specialist.id, departmentId });

  const surveyOpen = await publishedSurvey(groupId, admin.id, `Скринінг ${tag}`, { showResultsToPatient: true });
  const surveyHidden = await publishedSurvey(groupId, admin.id, `Закритий скринінг ${tag}`);
  const surveyOther = await publishedSurvey(otherGroupId, otherAdmin.id, `Чужий скринінг ${tag}`);

  const patientEmail = `role-p-${u}@test.dev`;
  const patient = await makeUser("user", patientEmail, {
    sex: "female",
    birthDate: "1991-05-05",
    leadSpecialistId: specialist.id,
  });
  const strangerEmail = `role-s-${u}@test.dev`;
  const stranger = await makeUser("user", strangerEmail, { sex: "male", birthDate: "1988-02-02" });

  const { surveyAccess } = await import("../src/db/schema");
  /* назначения: закрытые методики открываются человеку только так */
  await db.insert(surveyAccess).values([
    { surveyId: surveyOpen, userId: patient.id, grantedBy: admin.id },
    { surveyId: surveyHidden, userId: patient.id, grantedBy: admin.id },
    { surveyId: surveyOther, userId: stranger.id, grantedBy: otherAdmin.id },
  ]);

  const w: World = {
    tag,
    groupId,
    admin,
    otherGroupId,
    otherAdmin,
    departmentId,
    specialist,
    surveyOpen,
    surveyHidden,
    surveyOther,
    patient: { ...patient, email: patientEmail },
    stranger: { ...stranger, email: strangerEmail },
    slotIds: [],
    cleanup: { appointments: [], people: [patient.id, stranger.id] },
  };
  w.slotIds = [await futureSlot(w), await futureSlot(w), await futureSlot(w)];
  return w;
}

/**
 * Закрыть то, что сценарии оставили живым в общих очередях: приёмы,
 * случаи и сигналы тревоги. Закрываются, а не удаляются — так же, как
 * закрыл бы человек; ограничения базы (RESTRICT у risk_alerts) удаление
 * и не пропустили бы.
 */
export async function closeWorld(w: World): Promise<void> {
  const at = new Date().toISOString();
  const booked = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(inArray(appointments.patientId, w.cleanup.people));
  const ids = [...new Set([...w.cleanup.appointments, ...booked.map((b) => b.id)])];
  if (ids.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: at })
      .where(and(inArray(appointments.id, ids), isNull(appointments.cancelledAt)));
  }
  await db
    .update(alertCases)
    .set({ acknowledgedAt: at, acknowledgedBy: root.id, outcome: "not_confirmed", note: "очистка теста" })
    .where(and(inArray(alertCases.userId, w.cleanup.people), isNull(alertCases.acknowledgedAt)));
  await db
    .update(riskAlerts)
    .set({ acknowledgedAt: at, acknowledgedBy: root.id, outcome: "not_confirmed" })
    .where(and(inArray(riskAlerts.userId, w.cleanup.people), isNull(riskAlerts.acknowledgedAt)));
  /* ведущий специалист — ссылка на сотрудника; снять, чтобы мир не держал чужие выборки «моих» */
  await db.update(users).set({ leadSpecialistId: null }).where(eq(users.id, w.patient.id));
}

/** Ответы на методику мира: first — первый вариант каждого вопроса (критический), иначе — последний */
export function answersFor(survey: { questions: { id: string; options: { id: string }[] }[] }, pick: "first" | "last") {
  return survey.questions.map((q) => ({
    questionId: q.id,
    optionIds: [pick === "first" ? q.options[0]!.id : q.options[q.options.length - 1]!.id],
    durationMs: 1500,
    changeCount: 0,
    visitCount: 1,
  }));
}
