import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readNotes, type SurveyFull } from "@quizzy/shared";
import { appApi, db, makeUser, type Person } from "./fixtures";
import { auditLog, batteries, batteryItems, surveyAccess, surveyVersions, surveys } from "../src/db/schema";
import { CATALOG } from "../src/instruments/catalog";
import { catalogDomain } from "../src/instruments/catalogDomains";
import { CATALOG_GROUP_ID, installCatalog } from "../src/lib/catalogInstall";

/**
 * Методики учреждения на рабочем экземпляре (dp-inst, 2026-10-28).
 *
 * БОО «Адаптивність-200», Міні-мульт, СР-45 и SAD PERSONS ставил только
 * демонстрационный посев — на проде, где посева нет, их не было. Теперь их
 * ставит установщик каталога: в группу каталога, с примечанием для персонала и
 * направлением, а второй выкат их не трогает. Обследуемый видит СР-45 под
 * нейтральным названием и без шкал, а SAD PERSONS, которую заполняет
 * специалист, не видит вовсе.
 *
 * Запросы пациента — ролью приложения (appApi): политики строк — часть того,
 * что ему отдаётся.
 */

const KEYS = ["mlo", "minimult", "sr45", "sad-persons"] as const;
const SLOW = 60_000;

type Row = typeof surveys.$inferSelect;
let rows: Row[] = [];
let person: Person;
/* тот же пациент без назначений: методики учреждения ему не видны */
let stranger: Person;

const idOf = (key: (typeof KEYS)[number]) => rows.find((r) => r.catalogKey === key)!.id;

const versionsOf = async (id: string) =>
  db.select({ note: surveyVersions.note }).from(surveyVersions).where(eq(surveyVersions.surveyId, id));

beforeAll(async () => {
  await installCatalog();
  rows = await db.select().from(surveys).where(inArray(surveys.catalogKey, [...KEYS]));
  person = await makeUser("user", `inst-${crypto.randomUUID().slice(0, 8)}@test`, { sex: "male", birthDate: "1990-01-01" });
  stranger = await makeUser("user", `inst-x-${crypto.randomUUID().slice(0, 8)}@test`, { sex: "male", birthDate: "1990-01-01" });
  // методики учреждения — только по назначению: обследуемому их выдают
  await db.insert(surveyAccess).values((["mlo", "minimult", "sr45"] as const).map((key) => ({ surveyId: idOf(key), userId: person.id })));
}, SLOW);

describe("установщик каталога: методики учреждения", () => {
  test("ставит все четыре в группу каталога — опубликованными, с «Джерелом» и направлением", async () => {
    /*
     * Мутация: убрать запись из CATALOG (блок dp-inst) — методики нет, падает счёт строк;
     * не класть note в catalogSettings — падает «Джерело».
     */
    expect(rows.map((r) => r.catalogKey).sort()).toEqual([...KEYS].sort());
    for (const row of rows) {
      const entry = CATALOG.find((e) => e.key === row.catalogKey)!;
      const where = `«${entry.key}»`;
      expect(row.groupId, where).toBe(CATALOG_GROUP_ID);
      expect(row.status, where).toBe("published");
      expect(row.scoringEnabled, where).toBe(true);
      expect(row.sourceNote, where).toBe(entry.note);
      expect(row.domain, where).toBe(catalogDomain(entry.key));
      expect(row.administration, where).toBe(entry.key === "sad-persons" ? "clinician" : "self");
      // только по назначению — все четыре: обследование у психолога, а не тест из списка кабинета
      expect(row.visibility, where).toBe("restricted");
      expect(row.showResultsToPatient, where).toBe(false);

      // действующую версию выпустил каталог: заметка — код note.catalog с отпечатком редакции
      const notes = (await versionsOf(row.id)).map((v) => readNotes(v.note).map((n) => n.code));
      expect(notes.some((codes) => codes.includes("note.catalog")), where).toBe(true);

      // журнал помнит установку с источником — решением владельца продукта, а не лицензией
      const [created] = await db
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.action, "survey.create"), sql`${auditLog.details}->>'catalogKey' = ${entry.key}`))
        .limit(1);
      expect((created?.details as { source?: string } | undefined)?.source, where).toBe(entry.source);
      expect(entry.source, where).toContain("рішенням власника продукту від 28.10.2026");
    }
    // эскалация и порог небрежности — из черновика, а не потеряны, как у копии посева
    const mlo = rows.find((r) => r.catalogKey === "mlo")!;
    expect([mlo.alertEscalateMinutes, mlo.tooFastMs, mlo.timeLimitSec]).toEqual([120, 700, 3600]);
    expect(rows.find((r) => r.catalogKey === "sr45")!.alertEscalateMinutes).toBe(60);
  });

  test(
    "второй прогон ничего не ставит, не обновляет и не выпускает версий",
    async () => {
      const before = new Map(await Promise.all(rows.map(async (r) => [r.id, (await versionsOf(r.id)).length] as const)));
      const again = await installCatalog();
      for (const key of KEYS) {
        expect(again.installed, key).not.toContain(key);
        expect(again.updated, key).not.toContain(key);
        expect(again.skipped, key).toContain(key);
        expect(again.domainSet, key).not.toContain(key);
        expect(again.sourceNoteSet, key).not.toContain(key);
      }
      for (const r of rows) expect((await versionsOf(r.id)).length, r.catalogKey!).toBe(before.get(r.id)!);
      const now = await db.select({ id: surveys.id }).from(surveys).where(inArray(surveys.catalogKey, [...KEYS]));
      expect(now.length, "вторая копия методики учреждения").toBe(KEYS.length);
    },
    SLOW,
  );

  test("заготовка «Поглиблене психологічне обстеження»: СР-45, БОО, Міні-мульт — по порядку", async () => {
    const [tpl] = await db.select().from(batteries).where(eq(batteries.catalogKey, "psych-deep"));
    expect(tpl?.title).toBe("Поглиблене психологічне обстеження");
    expect(tpl?.strictOrder).toBe(false);
    const items = await db
      .select({ surveyId: batteryItems.surveyId, position: batteryItems.position })
      .from(batteryItems)
      .where(eq(batteryItems.batteryId, tpl!.id))
      .orderBy(batteryItems.position);
    expect(items.map((i) => i.surveyId)).toEqual([idOf("sr45"), idOf("mlo"), idOf("minimult")]);
  });
});

describe("методики учреждения глазами обследуемого", () => {
  test("СР-45: нейтральное название на обоих языках, без шкал, полос и «Джерела»", async () => {
    /*
     * Прежде человек читал «СР-45. Схильність до суїцидальних реакцій» до первого
     * вопроса. Клинический смысл — в названии шкалы Sr, а шкалы обследуемому не
     * отдаются (respondentView). Мутация: вернуть прежнее название — первое ожидание.
     */
    const uk = await appApi<SurveyFull>(`/api/surveys/${idOf("sr45")}`, person.token);
    expect(uk.status).toBe(200);
    expect(uk.body.title).toBe("Опитувальник (СР-45)");
    expect(uk.body.description).not.toMatch(/суїцид|ризик/iu);
    expect(uk.body.scales).toEqual([]);
    expect(uk.body.keyWithheld).toBe(true);
    const text = JSON.stringify(uk.body);
    /*
     * «Джерело» паспорта — и самим полем, и копией в снимке настроек каталога
     * (catalogFields): прежде снимок уходил пациенту целиком, вместе с «Методика …
     * для виявлення схильності до суїцидальних реакцій». Мутация: вернуть
     * catalogFields в respondentView — падает на «catalogFields».
     */
    for (const word of ["Схильність до суїцидальних реакцій", "схильності до суїцидальних", "Шкала брехні", "sourceNote", "catalogFields", "riskFlag", "keyCode"]) {
      expect(text.includes(word), `«${word}» в ответе обследуемому`).toBe(false);
    }
    const ru = await appApi<SurveyFull>(`/api/surveys/${idOf("sr45")}`, person.token, { headers: { "Accept-Language": "ru" } });
    expect(ru.body.title).toBe("Опросник (СР-45)");
    expect(JSON.stringify(ru.body).includes("Склонность к суицидальным реакциям")).toBe(false);
  });

  test("БОО и Міні-мульт: названия шкал до обследуемого не доходят", async () => {
    const words: Record<string, string[]> = {
      mlo: ["Суїцидальний ризик", "Схильність до девіантних", "Достовірність", "Високий ризик"],
      minimult: ["Психопатія", "Шизоїдність", "Іпохондрія", "Шкала брехні"],
    };
    for (const key of ["mlo", "minimult"] as const) {
      const res = await appApi<SurveyFull>(`/api/surveys/${idOf(key)}`, person.token);
      expect(res.status, key).toBe(200);
      expect(res.body.scales, key).toEqual([]);
      const text = JSON.stringify(res.body);
      for (const word of words[key]!) expect(text.includes(word), `${key}: «${word}»`).toBe(false);
    }
  });

  test("SAD PERSONS пациенту не предлагается: ни в списке, ни по прямой ссылке", async () => {
    // заполняет специалист: фильтр видимости пациента пропускает только самоотчёт (routes/access.ts)
    const direct = await appApi(`/api/surveys/${idOf("sad-persons")}`, person.token);
    expect(direct.status).toBe(404);
    const list = await appApi<{ items: { id: string }[] }>(`/api/surveys?groupId=${CATALOG_GROUP_ID}&limit=500`, person.token);
    expect(list.status).toBe(200);
    const ids = list.body.items.map((s) => s.id);
    for (const key of ["mlo", "minimult", "sr45"] as const) expect(ids, key).toContain(idOf(key));
    // без назначения — ни одной: методики учреждения выдаёт психолог
    const bare = await appApi<{ items: { id: string }[] }>(`/api/surveys?groupId=${CATALOG_GROUP_ID}&limit=500`, stranger.token);
    for (const key of KEYS) expect(bare.body.items.map((s) => s.id), key).not.toContain(idOf(key));
    expect((await appApi(`/api/surveys/${idOf("sr45")}`, stranger.token)).status).toBe(404);
    expect(ids).not.toContain(idOf("sad-persons"));
    // строка списка пациента — без «Джерела» и без снимка настроек каталога с его копией
    const listed = JSON.stringify(list.body.items);
    expect(listed.includes("sourceNote") || listed.includes("catalogFields")).toBe(false);
  });
});
