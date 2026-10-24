import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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
import { auditLog, batteries, batteryItems, departments, surveyGroups, surveyVersions, surveys, users } from "../db/schema";
import { CATALOG_BATTERIES, CATALOG_BATTERY_LANG, type CatalogBattery } from "../instruments/catalogBatteries";
import { CATALOG, type CatalogEntry } from "../instruments/catalog";
import { catalogDomain } from "../instruments/catalogDomains";
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
 *
 * Кроме методик, установщик заводит наборы-заготовки каталога
 * (instruments/catalogBatteries.ts) — каждую один раз, см. installBatteries.
 *
 * Методики каталога стоят в своей группе — см. CATALOG_GROUP_ID.
 */

export interface InstallReport {
  departmentId: string | null;
  departmentCreated: boolean;
  /** Группа каталога заведена этим прогоном (ensureCatalogGroup) */
  groupCreated: boolean;
  /** Методики каталога без группы, перенесённые в группу каталога при её заведении */
  grouped: string[];
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
   * Методики, которым этот прогон проставил или сменил направление (карта
   * instruments/catalogDomains.ts) — у уже стоявших это делается без новой
   * версии (syncDomain). Поставленные этим прогоном сюда не входят: у них
   * направление с первой строки.
   */
  domainSet: string[];
  /** Наборы-заготовки каталога (installBatteries) */
  batteries: BatteryInstallReport;
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

/**
 * Группа каталога: в ней стоят методики каталога.
 *
 * Раньше они стояли без группы, а методика без группы — личный черновик
 * автора (lib/scope.ts): её видят суперадмин и тот, кто её завёл, а заводит
 * их установщик. Врач, назначенный на группу, методик каталога не видел и
 * назначить не мог, наборы-заготовки видел без шагов, а тревоги по этим
 * методикам доставались одному суперадмину.
 *
 * Открыть методики без группы всем сотрудникам — отвергнуто. Через группу
 * методики считается и круг пациентов врача (accessiblePatientIds): каждый,
 * кто проходил методику каталога, стал бы виден каждому сотруднику. Поэтому
 * каталог живёт в обычной группе, и кто его видит, решает суперадмин,
 * назначая администраторов группы, как у любой другой.
 *
 * Постоянный id, а не поиск по названию: группу учреждение вправе
 * переименовать, и следующий выкат завёл бы вторую.
 */
export const CATALOG_GROUP_ID = "catalog";
const CATALOG_GROUP_POSITION = 1000;

/**
 * Завести группу каталога, если её нет. При заведении в неё переносятся
 * методики каталога без группы — те, что стояли до неё.
 *
 * Перенос — один раз, при заведении, а не на каждом выкате: методику,
 * которую учреждение потом унесёт из группы (в свою группу или в черновики),
 * установщик назад не возвращает. Новые методики каталога ставятся сразу в
 * группу (installOne).
 */
async function ensureCatalogGroup(createdBy: string): Promise<{ created: boolean; grouped: string[] }> {
  const title = serverText("content.catalogGroup", CATALOG_BATTERY_LANG);
  const rows = await db
    .insert(surveyGroups)
    .values({
      id: CATALOG_GROUP_ID,
      title,
      description: serverText("content.catalogGroupNote", CATALOG_BATTERY_LANG),
      /*
       * В конце списка групп. Конструктор ставит новой методике первую группу
       * из списка (constructor/model.ts), и своя методика врача не должна по
       * умолчанию ложиться в каталог.
       */
      position: CATALOG_GROUP_POSITION,
      createdBy,
    })
    .onConflictDoNothing()
    .returning({ id: surveyGroups.id });
  if (!rows.length) return { created: false, grouped: [] };
  await auditSystem({
    action: "group.create",
    resourceType: "group",
    resourceId: CATALOG_GROUP_ID,
    details: { title, by: "catalog-install" },
  });

  const moved = await db
    .update(surveys)
    .set({ groupId: CATALOG_GROUP_ID, updatedAt: new Date().toISOString() })
    .where(and(isNotNull(surveys.catalogKey), isNull(surveys.groupId)))
    .returning({ id: surveys.id, key: surveys.catalogKey });
  for (const m of moved) {
    await auditSystem({
      action: "survey.update",
      resourceType: "survey",
      resourceId: m.id,
      details: { catalogKey: m.key, groupId: CATALOG_GROUP_ID, from: null, by: "catalog-install" },
    });
  }
  return { created: true, grouped: moved.map((m) => m.key!).sort() };
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

type SurveyRow = typeof surveys.$inferSelect;

/**
 * Настройки строки, которые ведёт каталог: поля черновика (surveyFields) и
 * направление из карты instruments/catalogDomains.ts.
 *
 * Направление — не в surveyFields: оно не из черновика, от него не считается
 * отпечаток редакции (fingerprint), и листы сверки, которым surveyFields
 * открыт, его не описывают. Но правится и сохраняется оно как любая
 * настройка каталога: снимок catalog_fields, правка учреждения не
 * перетирается (localFields / mergeFields), --force возвращает каталоговое.
 */
export function catalogSettings(key: string, input: ReturnType<typeof createSurveySchema.parse>) {
  return { ...surveyFields(input), domain: catalogDomain(key) };
}

type CatalogSettings = ReturnType<typeof catalogSettings>;

/**
 * Значение в JSON с ключами по порядку на всех уровнях — для сравнения.
 *
 * jsonb хранит ключи объекта в своём порядке, а не в порядке записи:
 * название {uk, ru} из каталога возвращается из базы как {ru, uk}. Строка
 * через простой JSON.stringify тогда «отличалась» бы у одинаковых значений —
 * снимок настроек считался бы устаревшим на каждом выкате, а у строки без
 * снимка (до 0118) название и описание — правленными в учреждении. Круг
 * через JSON — затем же, зачем у базы: undefined jsonb не хранит.
 */
function stable(value: unknown): string {
  const walk = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    if (v !== null && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      return `{${Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${walk(obj[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v);
  };
  return walk(JSON.parse(JSON.stringify(value ?? null)));
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/**
 * Настройки моложе снимков: их нет в catalog_fields строк, сверенных до их
 * появления, и сравнивать такое поле не с чем, кроме умолчания колонки.
 * Направление (0133) у методики, поставленной раньше, пусто не потому, что
 * учреждение его стёрло, а потому, что его ещё не было: пустое — не правка, и
 * первый же выкат его заполнит. Заполненное до установщика (правкой между
 * миграцией и выкатом каталога) — правка, и она сохраняется.
 */
const NEWER_THAN_SNAPSHOT: Partial<Record<keyof CatalogSettings, unknown>> = { domain: null };

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
export function localFields(row: SurveyRow, catalog: CatalogSettings): string[] {
  const snapshot = (row.catalogFields ?? null) as Partial<CatalogSettings> | null;
  return (Object.keys(catalog) as (keyof CatalogSettings)[]).filter((key) => {
    /*
     * С чем сравнивать: со снимком, если поле в нём есть; поле моложе снимка —
     * с умолчанием колонки (NEWER_THAN_SNAPSHOT); снимка нет вовсе или он
     * частичный (направление, записанное методике с правленным содержимым,
     * см. syncDomain) — с текущей редакцией, как до 0118. Остальные поля
     * снимок установщика несёт всегда: surveyFields не отдаёт undefined.
     */
    const base =
      snapshot && key in snapshot
        ? snapshot[key]
        : key in NEWER_THAN_SNAPSHOT
          ? NEWER_THAN_SNAPSHOT[key]
          : catalog[key];
    return !same(row[key], base);
  });
}

/**
 * Что записать в строку при обычном обновлении: поля каталога, кроме
 * правленных в учреждении, — те остаются как есть.
 */
function mergeFields(row: SurveyRow, catalog: CatalogSettings, kept: readonly string[]): CatalogSettings {
  const out = { ...catalog } as Record<string, unknown>;
  for (const key of kept) out[key] = row[key as keyof SurveyRow];
  return out as CatalogSettings;
}

type Outcome = "installed" | "updated" | "skipped" | "keptLocal";

interface OneResult {
  outcome: Outcome;
  /** Настройки, оставленные учреждению при обновлении */
  keptSettings: string[];
  /** Направление строки проставлено или сменено этим прогоном (у уже стоявшей методики) */
  domainChanged: boolean;
}

/**
 * Направление уже стоящей методики — без новой версии и без updatedAt.
 *
 * Направление — классификация каталога, а не содержимое: от него не
 * считается редакция (fingerprint), и смена карты catalogDomains.ts версию не
 * выпускает. Поэтому оно сверяется и там, где содержимое трогать нечего, —
 * у той же редакции (skipped), — и там, где трогать его нельзя: у методики,
 * последнюю версию которой выпустило учреждение (keptLocal). Правка пунктов в
 * конструкторе не делает направление учреждения: PHQ-9 с переписанным
 * пунктом — по-прежнему методика настроения, и без этого правленные методики
 * выпали бы из чипов каталога навсегда.
 *
 * Правило — то же, что у любой настройки каталога (localFields): направление,
 * выбранное учреждением (отличное от снимка), остаётся; не тронутое — следует
 * за картой. Снимок обновляется только в поле направления: остальные поля
 * установщик здесь не сверял, и переписать их снимок значило бы объявить
 * чужие значения «своими» (у keptLocal) или наоборот.
 *
 * updatedAt не трогается намеренно: каталог печатает «версія N від <дата>»
 * по нему, и первый выкат после 0133 датировал бы сегодняшним днём все
 * методики разом, хотя ни одна не менялась.
 */
async function syncDomain(existing: SurveyRow, catalog: CatalogSettings, key: string): Promise<boolean> {
  const snapshot = (existing.catalogFields ?? null) as Partial<CatalogSettings> | null;
  const institutions = localFields(existing, catalog).includes("domain");
  const target = institutions ? existing.domain : catalog.domain;
  const snapshotCurrent = !!snapshot && "domain" in snapshot && same(snapshot.domain, catalog.domain);
  const changed = !same(existing.domain, target);
  if (!changed && snapshotCurrent) return false;

  await db
    .update(surveys)
    .set({ domain: target, catalogFields: { ...(snapshot ?? {}), domain: catalog.domain } } as never)
    .where(eq(surveys.id, existing.id));
  // журнал — когда сменилось то, что видно в каталоге; одна сверка снимка — служебная запись, не событие
  if (changed) {
    await auditSystem({
      action: "survey.catalog_update",
      resourceType: "survey",
      resourceId: existing.id,
      details: { catalogKey: key, settingsOnly: true, domain: { from: existing.domain, to: target } },
    });
  }
  return changed;
}

async function installOne(entry: CatalogEntry, createdBy: string, force = false): Promise<OneResult> {
  const [existing] = await db.select().from(surveys).where(eq(surveys.catalogKey, entry.key));
  const edition = await fingerprint(entry);
  const note = noteCode("note.catalog", { edition });
  // через ту же схему, что и API: методика каталога обязана быть валидной
  const input = createSurveySchema.parse(entry.draft);
  const catalog = catalogSettings(entry.key, input);
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
     * Правки настроек строки (visibility, инструкция, лимит, направление…) —
     * тоже правки учреждения, но не версии: обычное обновление их сохраняет и
     * обновляет остальное; --force возвращает и их к каталогу.
     */
    const headEdition = catalogEdition(head?.note);
    const local = headEdition === null;
    if (local && !force) {
      return { outcome: "keptLocal", keptSettings: [], domainChanged: await syncDomain(existing, catalog, entry.key) };
    }

    const localNow = localFields(existing, catalog);
    const kept = force ? [] : localNow;
    const sameEdition = headEdition === edition;
    /*
     * Та же редакция и настройки каталога на месте (или учреждения, без
     * --force) — содержимое трогать нечего. Остаётся то, что от редакции не
     * зависит, — направление (syncDomain).
     */
    if (sameEdition && (!force || localNow.length === 0)) {
      return { outcome: "skipped", keptSettings: [], domainChanged: await syncDomain(existing, catalog, entry.key) };
    }

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
    return { outcome: "updated", keptSettings: kept, domainChanged: !same(existing.domain, fields.domain) };
  }

  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    catalogKey: entry.key,
    groupId: CATALOG_GROUP_ID,
    ...catalog,
    catalogFields: catalog,
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
    details: { catalogKey: entry.key, title: t(input.title as never, "uk"), source: entry.source, domain: catalog.domain },
  });
  return { outcome: "installed", keptSettings: [], domainChanged: false };
}

/* ─────────── наборы-заготовки ─────────── */

/** Что установщик сделал с наборами-заготовками каталога */
export interface BatteryInstallReport {
  /** Заведены этим прогоном */
  installed: string[];
  /** Заведены раньше и стоят: ими распоряжается отделение, установщик их не трогает */
  kept: string[];
  /** Заведены раньше и удалены отделением — заново не заводятся */
  removed: string[];
  /**
   * Не заведены: ни одной методики набора в базе нет (или все сняты).
   * Пустой набор назначить нельзя, а заведённый — уже не дополнится;
   * следующий выкат попробует снова.
   */
  pending: string[];
  /** Ключ заведённого набора → методики, пропущенные при заведении: нет в базе или сняты */
  missingItems: Record<string, string[]>;
}

function emptyBatteryReport(): BatteryInstallReport {
  return { installed: [], kept: [], removed: [], pending: [], missingItems: {} };
}

/**
 * Была ли заготовка уже заведена — по журналу, а не только по строке.
 *
 * Строку набора отделение вправе удалить (без назначений — routes/batteries.ts,
 * DELETE), и вместе с ней уходит catalog_key: по одной таблице такая
 * заготовка неотличима от ещё не заведённой, и следующий выкат вернул бы
 * набор, от которого отказались. Журнал неизменяем и не чистится (хэш-цепочка),
 * а заведение заготовки пишется в него с её ключом — ниже, в installBattery.
 */
async function installedBefore(key: string): Promise<boolean> {
  const [seen] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, "battery.create"), sql`${auditLog.details}->>'catalogKey' = ${key}`))
    .limit(1);
  return !!seen;
}

type BatteryOutcome = "installed" | "kept" | "removed" | "pending";

async function installBattery(
  template: CatalogBattery,
  createdBy: string,
): Promise<{ outcome: BatteryOutcome; missing: string[] }> {
  const [existing] = await db.select({ id: batteries.id }).from(batteries).where(eq(batteries.catalogKey, template.key));
  // заведён — дальше набор отделения: ни состав, ни название, ни архив установщик не трогает
  if (existing) return { outcome: "kept", missing: [] };
  if (await installedBefore(template.key)) return { outcome: "removed", missing: [] };

  /*
   * Методика берётся, только если её можно пройти сейчас: опубликована и не
   * снята. Снятая в наборе — шаг «знято з використання» с первого дня, а
   * назначение такого набора отказало бы (assertBatteryInUse).
   */
  const keys = template.items.map((i) => i.key);
  const found = await db
    .select({ id: surveys.id, key: surveys.catalogKey, status: surveys.status, archivedAt: surveys.archivedAt })
    .from(surveys)
    .where(inArray(surveys.catalogKey, keys));
  const usable = new Map(
    found.flatMap((r) => (r.key && r.status === "published" && !r.archivedAt ? [[r.key, r.id] as const] : [])),
  );
  const items = template.items.flatMap((i) => {
    const surveyId = usable.get(i.key);
    return surveyId ? [{ surveyId, required: i.required ?? true }] : [];
  });
  const missing = keys.filter((k) => !usable.has(k));
  if (missing.length) log.warn("catalog.battery_items_skipped", { battery: template.key, missing: missing.join(",") });
  if (!items.length) return { outcome: "pending", missing };

  const id = crypto.randomUUID();
  const title = t(template.title, CATALOG_BATTERY_LANG);
  const description = t(template.description, CATALOG_BATTERY_LANG);
  const inserted = await db.transaction(async (tx) => {
    /*
     * Второй установщик, запущенный разом (выкат и ручная задача техпанели),
     * упрётся в уникальный ключ: его строка не ляжет, и состав не пишется.
     */
    const rows = await tx
      .insert(batteries)
      .values({
        id,
        catalogKey: template.key,
        title,
        description,
        groupId: null,
        strictOrder: template.strictOrder,
        archived: false,
        createdBy,
      })
      .onConflictDoNothing()
      .returning({ id: batteries.id });
    if (!rows.length) return false;
    await tx
      .insert(batteryItems)
      .values(items.map((item, position) => ({ batteryId: id, surveyId: item.surveyId, position, required: item.required })));
    return true;
  });
  if (!inserted) return { outcome: "kept", missing: [] };

  // журнал — с ключом заготовки: по нему установщик узнаёт её и после удаления (installedBefore)
  await auditSystem({
    action: "battery.create",
    resourceType: "battery",
    resourceId: id,
    details: {
      catalogKey: template.key,
      title,
      items: items.length,
      strictOrder: template.strictOrder,
      ...(missing.length ? { skipped: missing } : {}),
      by: "catalog-install",
    },
  });
  return { outcome: "installed", missing };
}

/**
 * Наборы-заготовки каталога (instruments/catalogBatteries.ts): каждая
 * заводится один раз — общим набором, на того же сотрудника, на которого
 * записаны методики каталога (installerId), — и дальше принадлежит отделению.
 * Идёт после методик: состав набора — методики, поставленные тем же прогоном.
 */
export async function installBatteries(createdBy: string): Promise<BatteryInstallReport> {
  const report = emptyBatteryReport();
  for (const template of CATALOG_BATTERIES) {
    const one = await installBattery(template, createdBy);
    report[one.outcome].push(template.key);
    if (one.outcome === "installed" && one.missing.length) report.missingItems[template.key] = one.missing;
  }
  return report;
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
      localFields: localFields(existing, catalogSettings(entry.key, createSurveySchema.parse(entry.draft))),
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
      groupCreated: false,
      grouped: [],
      installed: [],
      updated: [],
      skipped: [],
      keptLocal: [],
      keptSettings: {},
      domainSet: [],
      batteries: emptyBatteryReport(),
      notReady: "в базе нет ни одного сотрудника — методику не на кого записать",
    };
  }

  const department = await ensureDepartment();
  // до методик: новые ставятся сразу в группу, а перенос стоявших — до их обновления
  const group = await ensureCatalogGroup(createdBy);

  const out: Record<Outcome, string[]> = { installed: [], updated: [], skipped: [], keptLocal: [] };
  const keptSettings: Record<string, string[]> = {};
  const domainSet: string[] = [];
  for (const entry of CATALOG) {
    const one = await installOne(entry, createdBy, force.has(entry.key));
    out[one.outcome].push(entry.key);
    if (one.keptSettings.length) keptSettings[entry.key] = one.keptSettings;
    if (one.domainChanged) domainSet.push(entry.key);
  }
  const { installed, updated, skipped, keptLocal } = out;
  // после методик: состав заготовки — методики, которые этот же прогон поставил
  const batteryReport = await installBatteries(createdBy);

  log.info("catalog.installed", {
    department: department.id,
    groupCreated: group.created,
    grouped: group.grouped.length,
    installed: installed.length,
    updated: updated.length,
    skipped: skipped.length,
    keptLocal: keptLocal.length,
    domainSet: domainSet.length,
    batteriesInstalled: batteryReport.installed.length,
  });

  return {
    departmentId: department.id,
    departmentCreated: department.created,
    groupCreated: group.created,
    grouped: group.grouped,
    installed,
    updated,
    skipped,
    keptLocal,
    keptSettings,
    domainSet,
    batteries: batteryReport,
    notReady: null,
  };
}
