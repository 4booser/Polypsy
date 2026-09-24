import { desc, eq } from "drizzle-orm";
import { createSurveySchema, normalizeLocalized, t, type LocalizedText } from "@quizzy/shared";
import { db } from "../db";
import { departments, surveyVersions, surveys, users } from "../db/schema";
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
  /** Стояли и обновлены до текущей редакции каталога новой версией */
  updated: string[];
  skipped: string[];
  /** Правлены в учреждении после установки — каталог их не трогает */
  keptLocal: string[];
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

/*
 * Отпечаток редакции каталога — в заметке версии: «Каталог · <отпечаток>».
 *
 * Раньше установщик узнавал методику по ключу и больше её не трогал. Правка
 * каталога тогда доходила только до новых установок: на проде оставались,
 * например, полосы PSS-10, которых у автора нет, и они открывали случаи в
 * очереди разбора. Теперь редакция сравнивается по отпечатку, и отличие
 * выкатывается новой версией — старые прохождения остаются при своей.
 *
 * Правки учреждения важнее каталога: если последнюю версию выпустил человек
 * в конструкторе (заметка не начинается с «Каталог»), методика не трогается и
 * попадает в отчёт. Отвергнуто: сравнивать содержимое версии с черновиком —
 * это второй конвертер из базы в черновик, который однажды разойдётся с
 * createVersion и начнёт «обновлять» каждую методику на каждом выкате.
 */
const NOTE = "Каталог";

async function fingerprint(entry: CatalogEntry): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(entry.draft));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Поля строки методики, которые берутся из черновика каталога */
function surveyFields(input: ReturnType<typeof createSurveySchema.parse>) {
  return {
    title: normalizeLocalized(input.title)!,
    description: normalizeLocalized(input.description),
    instructions: normalizeLocalized(input.instructions),
    administration: input.administration,
    safetyPlan: normalizeLocalized(input.safetyPlan),
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
  };
}

type Outcome = "installed" | "updated" | "skipped" | "keptLocal";

async function installOne(entry: CatalogEntry, createdBy: string): Promise<Outcome> {
  const [existing] = await db.select().from(surveys).where(eq(surveys.catalogKey, entry.key));
  const note = `${NOTE} · ${await fingerprint(entry)}`;
  if (existing) {
    const [head] = await db
      .select({ note: surveyVersions.note })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, existing.id))
      .orderBy(desc(surveyVersions.version))
      .limit(1);
    if (!head?.note?.startsWith(NOTE)) return "keptLocal";
    if (head.note === note) return "skipped";

    const input = createSurveySchema.parse(entry.draft);
    await db
      .update(surveys)
      .set({ ...surveyFields(input), updatedAt: new Date().toISOString() } as never)
      .where(eq(surveys.id, existing.id));
    await createVersion(existing.id, input, createdBy, note);
    await auditSystem({
      action: "survey.catalog_update",
      resourceType: "survey",
      resourceId: existing.id,
      details: { catalogKey: entry.key, from: head.note, to: note, source: entry.source },
    });
    return "updated";
  }

  // через ту же схему, что и API: методика каталога обязана быть валидной
  const input = createSurveySchema.parse(entry.draft);
  const id = crypto.randomUUID();

  await db.insert(surveys).values({
    id,
    catalogKey: entry.key,
    groupId: null,
    ...surveyFields(input),
    status: "published",
    publishedAt: new Date().toISOString(),
    createdBy,
  } as never);

  await createVersion(id, input, createdBy, note);

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
  return "installed";
}

export async function installCatalog(): Promise<InstallReport> {
  const createdBy = await installerId();
  if (!createdBy) {
    return {
      departmentId: null,
      departmentCreated: false,
      installed: [],
      updated: [],
      skipped: [],
      keptLocal: [],
      notReady: "в базе нет ни одного сотрудника — методику не на кого записать",
    };
  }

  const department = await ensureDepartment();

  const out: Record<Outcome, string[]> = { installed: [], updated: [], skipped: [], keptLocal: [] };
  for (const entry of CATALOG) out[await installOne(entry, createdBy)].push(entry.key);
  const { installed, updated, skipped, keptLocal } = out;

  log.info("catalog.installed", {
    department: department.id,
    installed: installed.length,
    updated: updated.length,
    skipped: skipped.length,
    keptLocal: keptLocal.length,
  });

  return {
    departmentId: department.id,
    departmentCreated: department.created,
    installed,
    updated,
    skipped,
    keptLocal,
    notReady: null,
  };
}
