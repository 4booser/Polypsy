import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, inArray, like, sql } from "drizzle-orm";
import type { RuleHit } from "@quizzy/shared";
import { api, appApi, db, eq, makeUser, root, surveys, type Person } from "./fixtures";
import { auditLog, decisionRules, ruleHits, surveyAccess, users } from "../src/db/schema";
import { CATALOG_PASSPORT, catalogRules, type PassportSpec } from "../src/instruments/catalogPassport";
import { ruleScaleTitle } from "../src/lib/catalogPassport";
import { catalogRuleId, installCatalog } from "../src/lib/catalogInstall";

/**
 * Ступенчатый скрининг каталога: правило шага короткой формы
 * (instruments/catalogPassport.ts) установщик заводит один раз, дальше им
 * распоряжается отделение; положительная короткая форма даёт предложение
 * пройти полную методику — с тем, что нужно строке «Рекомендовано: PHQ-9 —
 * PHQ-2 = 4 від 12.10» и одному нажатию.
 *
 * Проверяется то, что ломается тихо: второй выкат заводит второе правило;
 * выкат возвращает порог или включение, которые отделение изменило; удалённое
 * правило возвращается; правило без своей методики ссылается в никуда;
 * положительный PHQ-2 молчит, а отрицательный — предлагает.
 */

const SLOW = 30_000;
const RULES = catalogRules(ruleScaleTitle);

let idOf: Map<string, string>;

async function ruleRows() {
  return db.select().from(decisionRules).where(like(decisionRules.id, "catalog-step-%"));
}

beforeAll(async () => {
  await installCatalog();
  const rows = await db.select({ id: surveys.id, key: surveys.catalogKey }).from(surveys).where(sql`${surveys.catalogKey} is not null`);
  idOf = new Map(rows.map((r) => [r.key!, r.id] as const));
}, SLOW);

/*
 * Правила действуют на все прохождения: включённое правило каталога создавало
 * бы предложения в других файлах тестов (тот же уговор, что в decisions.test.ts).
 */
afterAll(async () => {
  await db.update(decisionRules).set({ enabled: false }).where(like(decisionRules.id, "catalog-step-%"));
});

describe("правила ступенчатого скрининга: установка", () => {
  test(
    "по правилу на шаг: условие — шкала короткой формы и порог, действие — предложить полную методику",
    async () => {
      const rows = new Map((await ruleRows()).map((r) => [r.id, r] as const));
      for (const spec of RULES) {
        const row = rows.get(catalogRuleId(spec.key));
        expect(row, `правило ${spec.key} не заведено`).toBeDefined();
        expect(row!.groupId, `${spec.key}: правило не общее`).toBeNull();
        expect(row!.title).toBe(spec.title);
        expect(row!.note).toContain(spec.title.split(" → ")[0]!.split(" ")[0]!);
        expect(row!.conditions).toEqual([
          { kind: "scale", surveyId: idOf.get(spec.short)!, scaleCode: spec.scale, metric: "raw", op: spec.op, value: spec.value },
        ]);
        expect(row!.actions).toEqual([{ kind: "suggest_survey", surveyId: idOf.get(spec.next)! }]);
        // записано на того же, на кого методики каталога
        const [owner] = await db.select({ role: users.role }).from(users).where(eq(users.id, row!.createdBy));
        expect(["superadmin", "admin"]).toContain(owner!.role);
      }
      // журнал — с ключом правила: по нему установщик узнаёт его и после удаления
      const trail = await db
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.action, "rule.save"), sql`${auditLog.details}->>'by' = 'catalog-install'`));
      const logged = new Set(trail.map((r) => (r.details as { catalogRule?: string }).catalogRule));
      for (const spec of RULES) expect(logged.has(spec.key), `${spec.key} не записан в журнал`).toBe(true);
    },
    SLOW,
  );

  /** Мутация: искать правило по названию, а не по id — второй выкат заводит второе после переименования */
  test(
    "повторный выкат ничего не заводит и не меняет",
    async () => {
      const before = await ruleRows();
      const report = await installCatalog();
      expect(report.rules.installed).toEqual([]);
      expect(report.rules.kept.sort()).toEqual(RULES.map((r) => r.key).sort());
      expect(await ruleRows()).toEqual(before);
    },
    SLOW,
  );

  /** Мутация: в installRule переписывать заведённое правило каталожным — порог и выключение отделения пропадают */
  test(
    "порог, название и выключение, выбранные отделением, выкат не откатывает",
    async () => {
      const id = catalogRuleId("k6-k10");
      const [rule] = await db.select().from(decisionRules).where(eq(decisionRules.id, id));
      const patch = await api(`/api/decisions/rules/${id}`, root.token, {
        method: "PATCH",
        body: JSON.stringify({
          version: rule!.version,
          title: "K6 ≥ 20 → K10 (поріг відділення)",
          enabled: false,
          conditions: [{ ...(rule!.conditions as Record<string, unknown>[])[0], value: 20 }],
        }),
      });
      expect(patch.status, JSON.stringify(patch.body)).toBe(200);

      const report = await installCatalog();
      expect(report.rules.kept).toContain("k6-k10");
      const [after] = await db.select().from(decisionRules).where(eq(decisionRules.id, id));
      expect(after!.title).toBe("K6 ≥ 20 → K10 (поріг відділення)");
      expect(after!.enabled, "выкат включил правило, выключенное отделением").toBe(false);
      expect((after!.conditions as { value: number }[])[0]!.value).toBe(20);
      expect(after!.version).toBe(rule!.version + 1);
    },
    SLOW,
  );

  /**
   * Методики шага нет (не поставлена, снята) — правило не заводится и не
   * помечается: следующий выкат попробует снова. Удалённое правило не
   * возвращается — по журналу. Шаг здесь — свой, в памяти процесса: файл
   * паспорта не трогается.
   */
  test(
    "правило без своей методики ждёт её; удалённое — не возвращается",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const key = `test-short-${suffix}`;
      const spec: PassportSpec = {
        code: `TEST-${suffix}`,
        role: "short",
        fullForms: ["phq9"],
        purpose: { uk: "Перевірка правила без методики", ru: "Проверка правила без методики" },
        steps: [{ scale: "TEST", op: ">=", value: 1, next: "phq9", source: "Тест, 2026: перевірка установника" }],
      };
      const passport = CATALOG_PASSPORT as Record<string, PassportSpec>;
      passport[key] = spec;
      const ruleKey = `${key}-phq9`;
      let shortId: string | null = null;
      try {
        const waiting = await installCatalog();
        expect(waiting.rules.pending).toContain(ruleKey);
        expect(await db.select().from(decisionRules).where(eq(decisionRules.id, catalogRuleId(ruleKey)))).toEqual([]);

        // методика появилась — правило заводится
        shortId = crypto.randomUUID();
        await db.insert(surveys).values({
          id: shortId,
          catalogKey: key,
          title: { uk: `Тест (TEST-${suffix})` },
          administration: "self",
          status: "published",
          publishedAt: new Date().toISOString(),
          visibility: "restricted",
          createdBy: root.id,
        } as never);
        const made = await installCatalog();
        expect(made.rules.installed).toEqual([ruleKey]);

        // удалённое правило установщик не возвращает
        await db.delete(decisionRules).where(eq(decisionRules.id, catalogRuleId(ruleKey)));
        const after = await installCatalog();
        expect(after.rules.removed).toContain(ruleKey);
        expect(await db.select().from(decisionRules).where(eq(decisionRules.id, catalogRuleId(ruleKey)))).toEqual([]);
      } finally {
        delete passport[key];
        if (shortId) await db.update(surveys).set({ archivedAt: new Date().toISOString() }).where(eq(surveys.id, shortId));
      }
    },
    SLOW,
  );
});

describe("ступенчатый скрининг: положительная короткая форма предлагает полную", () => {
  let person: Person;

  /** Ответы PHQ-2 с баллом каждого пункта `score`: веса вариантов видит сотрудник, у обследуемого ключа нет (#141) */
  async function submitPhq2(as: Person, score: number, call: typeof api = api) {
    const keyed = await api(`/api/surveys/${idOf.get("phq2")}`, root.token);
    const answers = (keyed.body.questions as { id: string; type: string; options: { id: string; score: number }[] }[])
      .filter((q) => q.type !== "info")
      .map((q) => ({
        questionId: q.id,
        optionIds: [q.options.find((o) => o.score === score)!.id],
        durationMs: 2000,
        changeCount: 0,
        visitCount: 1,
      }));
    return call(`/api/surveys/${idOf.get("phq2")}/responses`, as.token, {
      method: "POST",
      body: JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 60_000, events: [], answers }),
    });
  }

  beforeAll(async () => {
    // правило могли выключить файлы, прошедшие раньше (decisions.test.ts выключает все)
    await db.update(decisionRules).set({ enabled: true }).where(eq(decisionRules.id, catalogRuleId("phq2-phq9")));
    person = await makeUser("user", `stepped-${crypto.randomUUID().slice(0, 8)}@test`);
  });

  test(
    "PHQ-2 = 4: предложение пройти PHQ-9 — названием, с баллом и без назначения; PHQ-2 = 2 — ничего",
    async () => {
      const negative = await submitPhq2(person, 1);
      expect(negative.status, JSON.stringify(negative.body)).toBe(201);
      expect(await db.select().from(ruleHits).where(eq(ruleHits.responseId, negative.body.id))).toEqual([]);

      const positive = await submitPhq2(person, 2);
      expect(positive.status, JSON.stringify(positive.body)).toBe(201);

      const res = await api(`/api/decisions/hits?userId=${person.id}`, root.token);
      expect(res.status).toBe(200);
      const hits = res.body.items as RuleHit[];
      expect(hits.map((h) => h.responseId)).toEqual([positive.body.id]);
      const [hit] = hits;
      expect(hit!.ruleTitle).toBe("PHQ-2 ≥ 3 → PHQ-9");
      expect(hit!.surveyTitle).toBe("Депресія, коротко (PHQ-2)");
      // балл главной шкалы — без названия шкалы: строка и так о PHQ-2, а не о коде PHQ2
      expect(hit!.basis).toEqual([{ scale: null, value: 4 }]);
      expect(hit!.suggested).toEqual([
        { surveyId: idOf.get("phq9")!, title: "Депресія (PHQ-9)", clinician: false, assigned: null, doneAt: null },
      ]);

      // на языке читающего
      const ru = await api(`/api/decisions/hits?userId=${person.id}`, root.token, { headers: { "Accept-Language": "ru" } });
      expect((ru.body.items as RuleHit[])[0]!.suggested![0]!.title).toBe("Депрессия (PHQ-9)");

      // ?userId= сужает: чужих срабатываний в выдаче нет
      const other = await makeUser("user", `stepped-other-${crypto.randomUUID().slice(0, 8)}@test`);
      expect((await api(`/api/decisions/hits?userId=${other.id}`, root.token)).body.items).toEqual([]);
    },
    SLOW,
  );

  test(
    "назначенную и пройденную после срабатывания полную методику строка знает — второй раз её не выдадут",
    async () => {
      const grant = await api(`/api/access/surveys/${idOf.get("phq9")}/grants`, root.token, {
        method: "POST",
        body: JSON.stringify({ userId: person.id, expiresAt: null }),
      });
      expect(grant.status, JSON.stringify(grant.body)).toBe(201);
      const assigned = (await api(`/api/decisions/hits?userId=${person.id}`, root.token)).body.items as RuleHit[];
      expect(assigned[0]!.suggested![0]!.assigned).toEqual({ until: null });

      // протокол короткой формы: то же предложение в обстановке прохождения
      const ctx = await api(`/api/response-context/${assigned[0]!.responseId}`, root.token);
      expect(ctx.status).toBe(200);
      expect((ctx.body.hits as RuleHit[])[0]!.suggested![0]!.surveyId).toBe(idOf.get("phq9")!);
      await db.delete(surveyAccess).where(and(eq(surveyAccess.userId, person.id), inArray(surveyAccess.surveyId, [idOf.get("phq9")!])));
    },
    SLOW,
  );

  test(
    "под ролью приложения: пациент сдаёт, правило срабатывает, специалист видит предложение",
    async () => {
      const someone = await makeUser("user", `stepped-app-${crypto.randomUUID().slice(0, 8)}@test`);
      const sent = await submitPhq2(someone, 3, appApi);
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      const res = await appApi(`/api/decisions/hits?userId=${someone.id}`, root.token);
      expect(res.status).toBe(200);
      const [hit] = res.body.items as RuleHit[];
      expect(hit?.basis).toEqual([{ scale: null, value: 6 }]);
      expect(hit?.suggested?.[0]?.surveyId).toBe(idOf.get("phq9")!);
    },
    SLOW,
  );
});
