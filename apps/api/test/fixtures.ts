/**
 * Общая обвязка интеграционных тестов.
 *
 * Модули у bun общие на процесс: этот файл выполняется один раз, сколько бы
 * тестовых файлов его ни импортировало. Поэтому база пересоздаётся, миграции
 * прогоняются и базовые сущности заводятся ровно однажды — иначе разбиение
 * одного файла на восемь стоило бы восьми пересозданий базы.
 *
 * Окружение готовит preload (см. bunfig.toml): модуль db читает DATABASE_URL
 * при загрузке, поэтому переменные должны быть выставлены раньше любого
 * импорта приложения. Импорты ниже динамические по той же причине.
 */
import { ADMIN_DATABASE_URL, TEST_DATABASE_NAME } from "./preload";
import { ensureBuiltinRole, syncBuiltinRole } from "../src/lib/permissions";

// пересоздаём тестовую базу через служебное подключение к рабочей
{
  const postgres = (await import("postgres")).default;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DATABASE_NAME}`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DATABASE_NAME}`);
  await admin.end();
}

export const { app } = await import("../src/app");
export const { db, client } = await import("../src/db");
export const {
  users,
  surveyGroups,
  groupAdmins,
  batteries,
  batteryItems,
  schedules,
  scheduleRuns,
  batteryAssignments,
  surveys,
  responses: responsesTable,
} = await import("../src/db/schema");
export const { hashPassword, issueToken } = await import("../src/lib/auth");
export const { encryptPersonFields } = await import("../src/lib/crypto");
export const { createVersion } = await import("../src/lib/surveys");
export const { runDueSchedules } = await import("../src/lib/scheduler");
export const { createSurveySchema } = await import("@quizzy/shared");
export const { sr45 } = await import("../src/instruments/sr45");
export const { eq, and, isNull } = await import("drizzle-orm");

const { migrate } = await import("drizzle-orm/postgres-js/migrator");

export interface Person {
  id: string;
  token: string;
}

export async function makeUser(
  role: "superadmin" | "admin" | "user",
  email: string,
  extra: Record<string, unknown> = {},
): Promise<Person> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email,
    // тот же путь, что у продуктовых записей: поля персоны шифруются
    ...encryptPersonFields({
      firstName: "Тест",
      lastName: email.split("@")[0]!,
      birthDate: (extra as { birthDate?: string }).birthDate ?? null,
    }),
    passwordHash: await hashPassword("secret12345"),
    role,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "birthDate")),
  } as never);
  /*
   * Тот же путь, что и в бою: администратор получает встроенную роль в
   * момент, когда становится администратором. Без этого тесты работали бы с
   * учётными записями, у которых прав нет вовсе, — и проверяли бы поведение,
   * которого в бою не бывает.
   */
  if (role === "admin") await ensureBuiltinRole(id);

  return { id, token: await issueToken({ id, role }) };
}

export async function api(path: string, token: string, init: RequestInit = {}) {
  const res = await app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body };
}

await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
/*
 * Набор встроенной роли приводится к справочнику до создания учётных
 * записей: миграция заводит саму роль, а её права задаёт код.
 */
await syncBuiltinRole();

export const root = await makeUser("superadmin", "root@test");
export const adminA = await makeUser("admin", "a@test");
export const adminB = await makeUser("admin", "b@test");
export const patient = await makeUser("user", "p@test", {
  sex: "male",
  birthDate: "1990-01-01",
  unit: "Рота А",
});

export const groupA = crypto.randomUUID();
export const groupB = crypto.randomUUID();
await db.insert(surveyGroups).values([
  { id: groupA, title: "Группа А", createdBy: root.id },
  { id: groupB, title: "Группа Б", createdBy: root.id },
]);
await db.insert(groupAdmins).values([
  { groupId: groupA, userId: adminA.id, assignedBy: root.id },
  { groupId: groupB, userId: adminB.id, assignedBy: root.id },
]);

// методика в группе А — через реальный конвейер посева
const input = createSurveySchema.parse(sr45);
export const surveyInA = crypto.randomUUID();
await db.insert(surveys).values({
  id: surveyInA,
  groupId: groupA,
  title: input.title,
  safetyPlan: (sr45 as { safetyPlan?: unknown }).safetyPlan ?? null,
  administration: "self",
  status: "published",
  publishedAt: new Date().toISOString(),
  visibility: "public",
  scoringEnabled: true,
  allowRetake: true,
  createdBy: adminA.id,
} as never);
await createVersion(surveyInA, input, adminA.id, "Тестовая версия");

/*
 * Методика в группе Б. Существует ради тестов вида «чужой админ не видит»:
 * без неё у adminB не было бы ни одной методики, маршруты обрывались бы на
 * проверке «а есть ли у сотрудника вообще методики», и тест доказывал бы
 * пустоту зоны вместо разграничения доступа.
 */
export const surveyInB = crypto.randomUUID();
await db.insert(surveys).values({
  id: surveyInB,
  groupId: groupB,
  title: { uk: "Методика групи Б", ru: "Методика группы Б" },
  administration: "self",
  status: "published",
  publishedAt: new Date().toISOString(),
  visibility: "public",
  scoringEnabled: true,
  allowRetake: true,
  createdBy: adminB.id,
} as never);
await createVersion(surveyInB, input, adminB.id, "Тестовая версия");

/**
 * Сдача методики «безопасными» ответами.
 *
 * Берётся второй вариант каждого пункта — в СР-45 это «Нет»: прохождение
 * заведомо не должно поднимать тревогу, и тест, которому нужна тревога,
 * ставит её явно, а не надеется на случай.
 */
export async function submitSurvey(
  surveyId: string,
  token: string,
  extra: Record<string, unknown> = {},
) {
  const surveyRes = await api(`/api/surveys/${surveyId}`, token);
  if (surveyRes.status !== 200) return surveyRes;
  const survey = surveyRes.body;
  const answers = survey.questions
    .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
    .map((q: { id: string; options: { id: string }[] }) => ({
      questionId: q.id,
      optionIds: [q.options[1]?.id ?? q.options[0]!.id],
      durationMs: 2000,
      changeCount: 0,
      visitCount: 1,
    }));
  return api(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
      ...extra,
    }),
  });
}

/*
 * Пул закрывается один раз на процесс, а не в afterAll каждого файла:
 * закрытый первым же файлом пул оставил бы остальные без соединения.
 */
let poolClosed = false;
process.on("beforeExit", () => {
  if (poolClosed) return;
  poolClosed = true;
  void client.end({ timeout: 3 }).catch(() => {});
});
