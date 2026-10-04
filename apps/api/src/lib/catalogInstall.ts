import { desc, eq } from "drizzle-orm";
import {
  CONTENT_LANGS,
  createSurveySchema,
  normalizeLocalized,
  noteCode,
  readNotes,
  renderNote,
  serverText,
  t,
  type LocalizedText,
} from "@quizzy/shared";
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
   * Обновлены, но часть настроек строки осталась учреждения: ключ методики →
   * поля (visibility, instructions, timeLimitSec…), которые обычное
   * обновление не переписало (см. localFields / mergeFields).
   */
  keptSettings: Record<string, string[]>;
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

/*
 * Название — содержимое на языках содержимого, из словаря (как название
 * копии методики): язык выбирает t() при показе. Украинское название —
 * ещё и признак, по которому отделение находится повторно (ensureDepartment);
 * переименовать его в словаре значит завести второе отделение на выкате.
 */
const DEPARTMENT_TITLE: LocalizedText = Object.fromEntries(
  CONTENT_LANGS.map((lang) => [lang, serverText("content.defaultDepartment", lang)]),
);

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
 * Отпечаток редакции каталога — в заметке версии: кодом note.catalog с
 * отпечатком в подстановке (до волны 14 — фразой «Каталог · <отпечаток>»).
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
 *
 * Заметка — кодом, а не фразой: её читают в истории версий и в манифесте
 * выгрузки на любом языке. Узнаётся своя версия по коду — или по прежнему
 * началу «Каталог» у поставленных до кодов: их отпечаток сравнивается так
 * же, и первый выкат после перехода не выпускает сорок одинаковых версий.
 */
const LEGACY_NOTE = "Каталог";

/** Отпечаток редакции из заметки версии; null — версию выпустил не каталог */
function catalogEdition(note: string | null | undefined): string | null {
  const coded = readNotes(note).find((n) => n.code === "note.catalog");
  if (coded) return String(coded.params?.edition ?? "");
  if (!note?.startsWith(LEGACY_NOTE)) return null;
  // «Каталог · 1a2b3c…»; у самых старых — одно слово, без отпечатка
  return note.slice(LEGACY_NOTE.length).replace(/^\s*·\s*/, "");
}

async function fingerprint(entry: CatalogEntry): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(entry.draft));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Поля строки методики, которые берутся из черновика каталога.
 *
 * Открыты наружу ради листов сверки (instrumentSheets/): лист обязан
 * описывать методику такой, какой её ставит установщик, и второй список
 * полей рядом с этим однажды разошёлся бы с ним.
 */
export function surveyFields(input: ReturnType<typeof createSurveySchema.parse>) {
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

type SurveyFields = ReturnType<typeof surveyFields>;
type SurveyRow = typeof surveys.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Поля строки, которые учреждение правило после установки: отличные от
 * снимка настроек редакции каталога, с которой строку в последний раз
 * сверял установщик (surveys.catalog_fields).
 *
 * Локальность содержимого узнаётся по заметке версии (catalogEdition), а
 * правка visibility, инструкции, лимита времени и прочих настроек строки
 * версии не создаёт — и до волны 18 каталог считал такую методику своей
 * неизменённой редакцией и при очередной правке каталога переписывал
 * настройки целиком: ограниченная методика становилась общедоступной,
 * лимит пропадал, инструкция возвращалась каталоговая (CR-017).
 *
 * Снимка нет (установка до 0118) — чьи настройки, не узнать; считаются
 * учреждения все, что отличаются от текущей редакции каталога: обновление
 * их не тронет, а --force вернёт каталоговые явным решением. Осторожная
 * сторона выбрана намеренно: лишнее «не тронул» исправляется одним --force,
 * лишнее «переписал» снимает ограничение доступа у методики пациентов.
 */
export function localFields(row: SurveyRow, catalog: SurveyFields): string[] {
  const snapshot = (row.catalogFields ?? null) as Partial<SurveyFields> | null;
  return (Object.keys(catalog) as (keyof SurveyFields)[]).filter((key) =>
    snapshot ? !same(row[key], snapshot[key]) : !same(row[key], catalog[key]),
  );
}

/**
 * Что записать в строку при обычном обновлении: поля каталога, кроме
 * правленных в учреждении, — те остаются как есть.
 */
function mergeFields(row: SurveyRow, catalog: SurveyFields, kept: readonly string[]): SurveyFields {
  const out = { ...catalog } as Record<string, unknown>;
  for (const key of kept) out[key] = row[key as keyof SurveyRow];
  return out as SurveyFields;
}

type Outcome = "installed" | "updated" | "skipped" | "keptLocal";

interface OneResult {
  outcome: Outcome;
  /** Настройки, оставленные учреждению при обновлении */
  keptSettings: string[];
}

async function installOne(entry: CatalogEntry, createdBy: string, force = false): Promise<OneResult> {
  const [existing] = await db.select().from(surveys).where(eq(surveys.catalogKey, entry.key));
  const edition = await fingerprint(entry);
  const note = noteCode("note.catalog", { edition });
  if (existing) {
    const [head] = await db
      .select({ note: surveyVersions.note })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, existing.id))
      .orderBy(desc(surveyVersions.version))
      .limit(1);
    /*
     * `force` — осознанное решение человека выкатить редакцию каталога поверх
     * правки учреждения (обслуживание, действие catalog-force): например,
     * исправленные по источнику пороги должны дойти и до методики, которую
     * однажды поправили в конструкторе. Правка не исчезает — она остаётся
     * прежней версией, и прохождения по ней считаются по ней же, — но
     * действующей становится редакция каталога. В журнал — с пометкой.
     *
     * Правки настроек строки (visibility, инструкция, лимит…) — тоже правки
     * учреждения, но не версии: обычное обновление их сохраняет и обновляет
     * остальное; --force возвращает и их к каталогу.
     */
    const headEdition = catalogEdition(head?.note);
    const local = headEdition === null;
    if (local && !force) return { outcome: "keptLocal", keptSettings: [] };

    const input = createSurveySchema.parse(entry.draft);
    const catalog = surveyFields(input);
    const localNow = localFields(existing, catalog);
    const kept = force ? [] : localNow;
    const sameEdition = headEdition === edition;
    // та же редакция и настройки каталога на месте (или учреждения, без --force) — нечего делать
    if (sameEdition && (!force || localNow.length === 0)) return { outcome: "skipped", keptSettings: [] };

    const fields = mergeFields(existing, catalog, kept);
    await db
      .update(surveys)
      /*
       * Снимок — настройки РЕДАКЦИИ КАТАЛОГА, а не записанные: у оставленного
       * учреждению поля строка и дальше отличается от снимка, и следующее
       * обновление (или --force) снова видит его правленным. Снимок из
       * записанного стёр бы эту разницу одним обновлением.
       */
      .set({ ...fields, catalogFields: catalog, updatedAt: new Date().toISOString() } as never)
      .where(eq(surveys.id, existing.id));
    if (!sameEdition) await createVersion(existing.id, input, createdBy, note);
    await auditSystem({
      action: "survey.catalog_update",
      resourceType: "survey",
      resourceId: existing.id,
      details: {
        catalogKey: entry.key,
        from: head?.note ?? null,
        to: note,
        source: entry.source,
        forced: force && (local || localNow.length > 0),
        keptSettings: kept,
      },
    });
    return { outcome: "updated", keptSettings: kept };
  }

  // через ту же схему, что и API: методика каталога обязана быть валидной
  const input = createSurveySchema.parse(entry.draft);
  const id = crypto.randomUUID();
  const fields = surveyFields(input);

  await db.insert(surveys).values({
    id,
    catalogKey: entry.key,
    groupId: null,
    ...fields,
    catalogFields: fields,
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
  return { outcome: "installed", keptSettings: [] };
}

/** Состояние методики каталога в базе — для обзора перед решением (catalog-status) */
export interface CatalogStatusRow {
  key: string;
  /** missing — не стоит; current — стоит редакция каталога; behind — стоит прежняя редакция каталога; local — последняя версия выпущена в учреждении */
  state: "missing" | "current" | "behind" | "local";
  /** Последние версии: номер, заметка, когда — от свежей к старой */
  versions: { version: number; note: string | null; createdAt: string }[];
  /** Настройки строки, правленные в учреждении (visibility, instructions, timeLimitSec…) — обновление их не тронет */
  localFields: string[];
}

export async function catalogStatus(): Promise<CatalogStatusRow[]> {
  const rows: CatalogStatusRow[] = [];
  for (const entry of CATALOG) {
    const [existing] = await db.select().from(surveys).where(eq(surveys.catalogKey, entry.key));
    if (!existing) {
      rows.push({ key: entry.key, state: "missing", versions: [], localFields: [] });
      continue;
    }
    const versions = await db
      .select({ version: surveyVersions.version, note: surveyVersions.note, createdAt: surveyVersions.createdAt })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, existing.id))
      .orderBy(desc(surveyVersions.version))
      .limit(5);
    const headEdition = catalogEdition(versions[0]?.note);
    const edition = await fingerprint(entry);
    const state = headEdition === null ? "local" : headEdition === edition ? "current" : "behind";
    rows.push({
      key: entry.key,
      state,
      versions: versions.map((v) => ({ ...v, note: renderNote(v.note, "ru"), createdAt: String(v.createdAt) })),
      localFields: localFields(existing, surveyFields(createSurveySchema.parse(entry.draft))),
    });
  }
  return rows;
}

export async function installCatalog(opts: { force?: readonly string[] } = {}): Promise<InstallReport> {
  const force = new Set(opts.force ?? []);
  const createdBy = await installerId();
  if (!createdBy) {
    return {
      departmentId: null,
      departmentCreated: false,
      installed: [],
      updated: [],
      skipped: [],
      keptLocal: [],
      keptSettings: {},
      notReady: "в базе нет ни одного сотрудника — методику не на кого записать",
    };
  }

  const department = await ensureDepartment();

  const out: Record<Outcome, string[]> = { installed: [], updated: [], skipped: [], keptLocal: [] };
  const keptSettings: Record<string, string[]> = {};
  for (const entry of CATALOG) {
    const one = await installOne(entry, createdBy, force.has(entry.key));
    out[one.outcome].push(entry.key);
    if (one.keptSettings.length) keptSettings[entry.key] = one.keptSettings;
  }
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
    keptSettings,
    notReady: null,
  };
}
