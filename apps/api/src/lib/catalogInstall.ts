import { eq } from "drizzle-orm";
import { createSurveySchema, normalizeLocalized, t, type LocalizedText } from "@quizzy/shared";
import { db } from "../db";
import { departments, surveys, users } from "../db/schema";
import { CATALOG, type CatalogEntry } from "../instruments/catalog";
import { auditSystem } from "./audit";
import { log } from "./log";
import { createVersion } from "./surveys";

/**
 * Установка общего каталога методик и отделения по умолчанию.
 *
 * Запускается на выкате и потому обязана быть идемпотентной по-настоящему,
 * а не «обычно ничего не портит»: она пойдёт на боевой базе с реальными
 * прохождениями, и вторая копия методики означает разошедшуюся динамику —
 * половина замеров человека у одной копии, половина у другой, и график,
 * ради которого всё затевалось, разваливается ровно там, где нужен.
 *
 * Опознаётся уже установленная методика по `catalogKey`, а не по названию:
 * название вправе изменить специалист у себя, и следующий выкат завёл бы
 * дубликат.
 *
 * Что установщик НЕ делает — и это решение, а не недоделка:
 *
 * • не трогает уже установленную методику. Обновление пунктов на живой
 *   базе меняет смысл прошлых прохождений: сравнивать «до» и «после» по
 *   изменившемуся тексту нельзя. Новая редакция методики — это новая
 *   версия через редактор, с явной публикацией и человеком, который за неё
 *   отвечает;
 * • не отключает и не удаляет ничего. Методика, выпавшая из каталога,
 *   остаётся у тех, кто её ставил.
 */

export interface InstallReport {
  departmentId: string | null;
  departmentCreated: boolean;
  installed: string[];
  skipped: string[];
  /**
   * Почему установка не состоялась вовсе.
   *
   * Единственная причина — в базе ещё нет ни одного сотрудника: методику
   * надо записать на кого-то, `created_by` обязателен. Так бывает ровно
   * один раз, между первым выкатом и заведением администратора, и само
   * проходит на следующем выкате. Возвращаем причину, а не бросаем: выкат
   * не должен падать из-за того, что учреждение ещё не завело себе
   * заведующего.
   */
  notReady: string | null;
}

const DEPARTMENT_TITLE: LocalizedText = {
  uk: "Психологічне відділення",
  ru: "Психологическое отделение",
};

/** Кем числится установка: первый суперадмин, иначе первый администратор */
async function installerId(): Promise<string | null> {
  const staff = await db.select().from(users).where(eq(users.role, "superadmin")).limit(1);
  if (staff[0]) return staff[0].id;
  const admin = await db.select().from(users).where(eq(users.role, "admin")).limit(1);
  return admin[0]?.id ?? null;
}

/**
 * Отделение по умолчанию.
 *
 * Ищется по украинскому названию: у отделения устойчивого имени нет, а
 * заводить его ради одной записи — заводить колонку, которую больше некому
 * заполнять. Риск дубликата здесь несравним с методиками: отделение видно
 * в списке из трёх строк, а не из тридцати.
 */
async function ensureDepartment(): Promise<{ id: string; created: boolean }> {
  const all = await db.select().from(departments);
  const existing = all.find((d) => t(d.title as never, "uk") === DEPARTMENT_TITLE.uk);
  if (existing) return { id: existing.id, created: false };

  const id = crypto.randomUUID();
  await db.insert(departments).values({ id, title: DEPARTMENT_TITLE, timezone: "Europe/Kyiv" });
  await auditSystem({
    action: "department.create",
    resourceType: "department",
    resourceId: id,
    details: { title: DEPARTMENT_TITLE.uk, by: "catalog-install" },
  });
  return { id, created: true };
}

async function installOne(entry: CatalogEntry, createdBy: string): Promise<boolean> {
  const [existing] = await db.select().from(surveys).where(eq(surveys.catalogKey, entry.key));
  if (existing) return false;

  // через ту же схему, что и API: методика каталога обязана быть валидной
  const input = createSurveySchema.parse(entry.draft);
  const id = crypto.randomUUID();

  await db.insert(surveys).values({
    id,
    catalogKey: entry.key,
    groupId: null,
    title: normalizeLocalized(input.title)!,
    description: normalizeLocalized(input.description),
    instructions: normalizeLocalized(input.instructions),
    administration: input.administration,
    safetyPlan: normalizeLocalized(input.safetyPlan),
    status: "published",
    publishedAt: new Date().toISOString(),
    timeLimitSec: input.timeLimitSec ?? null,
    randomizeQuestions: input.randomizeQuestions ?? false,
    allowBack: input.allowBack ?? true,
    showProgress: input.showProgress ?? true,
    anonymous: input.anonymous ?? false,
    visibility: input.visibility ?? "public",
    allowRetake: input.allowRetake ?? false,
    scoringEnabled: input.scoringEnabled ?? false,
    showResultsToPatient: input.showResultsToPatient ?? false,
    alertEscalateMinutes: input.alertEscalateMinutes ?? null,
    tooFastMs: input.tooFastMs ?? null,
    createdBy,
  } as never);

  await createVersion(id, input, createdBy, "Каталог");

  /*
   * В журнал — с источником. Через год вопрос «откуда взялись пороги этой
   * методики» задаст не автор каталога, и ответ должен лежать в системе, а
   * не в чьей-то памяти.
   */
  await auditSystem({
    action: "survey.create",
    resourceType: "survey",
    resourceId: id,
    details: { catalogKey: entry.key, title: t(input.title as never, "uk"), source: entry.source },
  });
  return true;
}

export async function installCatalog(): Promise<InstallReport> {
  const createdBy = await installerId();
  if (!createdBy) {
    return {
      departmentId: null,
      departmentCreated: false,
      installed: [],
      skipped: [],
      notReady: "в базе нет ни одного сотрудника — методику не на кого записать",
    };
  }

  const department = await ensureDepartment();

  const installed: string[] = [];
  const skipped: string[] = [];
  for (const entry of CATALOG) {
    if (await installOne(entry, createdBy)) installed.push(entry.key);
    else skipped.push(entry.key);
  }

  log.info("catalog.installed", {
    department: department.id,
    installed: installed.length,
    skipped: skipped.length,
  });

  return {
    departmentId: department.id,
    departmentCreated: department.created,
    installed,
    skipped,
    notReady: null,
  };
}
