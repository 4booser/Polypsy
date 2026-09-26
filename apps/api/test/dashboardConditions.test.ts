import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ConditionSummary, ConditionsResult, Severity } from "@quizzy/shared";
import { adminB, api, db, eq, makeUser, patient, root, sql, type Person } from "./fixtures";
import { groupAdmins, responseScores, responses, scaleBands, scales, surveyGroups, surveyVersions, surveys } from "../src/db/schema";
import { installCatalog } from "../src/lib/catalogInstall";
import { CATALOG } from "../src/instruments/catalog";
import { CONDITION_DOMAINS, spreadOf } from "../src/lib/conditions";

/**
 * Состояние пациентов по направлениям (GET /api/dashboard/conditions).
 *
 * Замеры кладутся прямо в базу, а не сдаются через маршрут: здесь нужна
 * дата сдачи в прошлом («сначала тяжело, потом легче») и точная ступень, а
 * сдача через API к тому же открывала бы случаи риска и сдвигала счётчики
 * соседних проверок. Ступень берётся не из головы: для WHO-5 она
 * вычитывается из полос установленной методики — так проверка полярности
 * опирается на настоящую лестницу каталога, а не на то, что тест сам себе
 * написал.
 */

interface Seed {
  surveyId: string;
  versionId: string;
  scaleId: string;
}

const ids = new Map<string, Seed>();

async function seedOf(catalogKey: string, code: string): Promise<Seed> {
  const k = `${catalogKey}:${code}`;
  const hit = ids.get(k);
  if (hit) return hit;
  const [s] = await db.select().from(surveys).where(eq(surveys.catalogKey, catalogKey));
  if (!s) throw new Error(`методика каталога «${catalogKey}» не установлена`);
  const [v] = await db
    .select()
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, s.id))
    .orderBy(sql`${surveyVersions.version} desc`)
    .limit(1);
  const [sc] = await db
    .select()
    .from(scales)
    .where(sql`${scales.versionId} = ${v!.id} and ${scales.code} = ${code}`);
  if (!sc) throw new Error(`у «${catalogKey}» нет шкалы ${code}`);
  const seed = { surveyId: s.id, versionId: v!.id, scaleId: sc.id };
  ids.set(k, seed);
  return seed;
}

/** Ступень по настоящим полосам установленной шкалы — тем же сравнением, что движок */
async function bandOf(scaleId: string, raw: number): Promise<Severity | null> {
  const rows = await db.select().from(scaleBands).where(eq(scaleBands.scaleId, scaleId));
  return (rows.find((b) => raw >= b.minScore && raw <= b.maxScore)?.severity ?? null) as Severity | null;
}

async function measure(
  who: Person,
  catalogKey: string,
  code: string,
  m: { severity: Severity | null; percent: number; raw?: number; daysAgo: number },
) {
  const seed = await seedOf(catalogKey, code);
  const at = new Date(Date.now() - m.daysAgo * 86_400_000).toISOString();
  const responseId = crypto.randomUUID();
  await db.insert(responses).values({
    id: responseId,
    surveyId: seed.surveyId,
    userId: who.id,
    status: "completed",
    versionId: seed.versionId,
    startedAt: at,
    submittedAt: at,
  } as never);
  await db.insert(responseScores).values({
    id: crypto.randomUUID(),
    responseId,
    scaleId: seed.scaleId,
    rawScore: m.raw ?? m.percent,
    value: m.raw ?? m.percent,
    normalization: "raw",
    maxScore: 100,
    percent: m.percent,
    normalized: true,
    bandLabel: m.severity,
    severity: m.severity,
  } as never);
}

const people = async (prefix: string, n: number) => {
  const out: Person[] = [];
  for (let i = 0; i < n; i++) out.push(await makeUser("user", `${prefix}${i}-${crypto.randomUUID().slice(0, 6)}@cond.test`));
  return out;
};

const byDomain = (body: ConditionsResult, key: string): ConditionSummary | undefined =>
  body.domains.find((d) => d.domain === key);

/* группа, в которую на время проверки зоны переносится GAD-7 */
const scopeGroup = crypto.randomUUID();
let scopeAdmin: Person;
let gadSurveyId = "";

beforeAll(async () => {
  await installCatalog();

  /*
   * Депрессия, PHQ-9. Пятнадцать человек за последний месяц — по пять на
   * «норму», «легку» и «помірну». У первого месяц назад была «виражена», а
   * последний замер — «норма»: в раскладку идёт последний. Шестнадцатый
   * замерен два месяца назад — он есть в периоде 90 и нет в периоде 30.
   */
  const dep = await people("dep", 16);
  for (const [i, p] of dep.slice(0, 15).entries()) {
    const severity: Severity = i < 5 ? "none" : i < 10 ? "mild" : "moderate";
    const percent = i < 5 ? 15 : i < 10 ? 30 : 50;
    await measure(p, "phq9", "PHQ", { severity, percent, daysAgo: 2 });
  }
  await measure(dep[0]!, "phq9", "PHQ", { severity: "severe", percent: 90, daysAgo: 25 });
  await measure(dep[15]!, "phq9", "PHQ", { severity: "moderate", percent: 50, daysAgo: 60 });

  /*
   * Тревога, GAD-7: десять человек, из них двое в «вираженій». Двое — малая
   * ячейка; вместе с опубликованным числом людей они вычисляются из любой
   * соседней, поэтому скрыто должно быть всё, кроме числа людей.
   */
  const anx = await people("anx", 10);
  for (const [i, p] of anx.entries()) {
    await measure(p, "gad7", "GAD", { severity: i < 2 ? "severe" : "none", percent: i < 2 ? 80 : 10, daysAgo: 3 });
  }

  /*
   * Благополучие, WHO-5: пятеро с сырым баллом 4 из 25 и пятеро с 22.
   * Ступень — из полос установленной методики.
   */
  const who = await seedOf("who5", "WHO5");
  const low = await bandOf(who.scaleId, 4);
  const high = await bandOf(who.scaleId, 22);
  const well = await people("well", 10);
  for (const [i, p] of well.entries()) {
    const raw = i < 5 ? 4 : 22;
    await measure(p, "who5", "WHO5", { severity: i < 5 ? low : high, raw, percent: raw * 4, daysAgo: 4 });
  }

  /* стресс, PSS-10: у автора порогов нет — шесть замеров без ступени */
  const stress = await people("pss", 6);
  for (const p of stress) await measure(p, "pss10", "PSS", { severity: null, percent: 40, daysAgo: 5 });

  /* ПТСР, PCL-5: трое — меньше порога, не показывается ничего */
  const ptsd = await people("pcl", 3);
  for (const p of ptsd) await measure(p, "pcl5", "PCL", { severity: "severe", percent: 70, daysAgo: 5 });

  /* зона: GAD-7 переезжает в группу, где администратор — только scopeAdmin */
  scopeAdmin = await makeUser("admin", `scope-${crypto.randomUUID().slice(0, 6)}@cond.test`);
  await db.insert(surveyGroups).values({ id: scopeGroup, title: "Група зведення", createdBy: root.id } as never);
  await db.insert(groupAdmins).values({ groupId: scopeGroup, userId: scopeAdmin.id, addedBy: root.id } as never);
  gadSurveyId = (await seedOf("gad7", "GAD")).surveyId;
  await db.update(surveys).set({ groupId: scopeGroup } as never).where(eq(surveys.id, gadSurveyId));
}, 120_000); // установка каталога и полсотни учётных записей с argon2 не укладываются в дефолтные 5 секунд

afterAll(async () => {
  /* методика каталога возвращается в корень: другие проверки ждут её там */
  if (gadSurveyId) await db.update(surveys).set({ groupId: null } as never).where(eq(surveys.id, gadSurveyId));
});

describe("состав направлений", () => {
  test("каждый источник направления есть в каталоге с этой шкалой", () => {
    /*
     * Шкала, переименованная в каталоге, иначе выпала бы из сводки молча:
     * маршрут ищет её по паре «ключ — код», и пропажа выглядела бы как
     * «замеров нет».
     */
    for (const d of CONDITION_DOMAINS) {
      for (const s of d.sources) {
        const entry = CATALOG.find((e) => e.key === s.catalogKey);
        expect(entry, `${d.key}: в каталоге нет «${s.catalogKey}»`).toBeTruthy();
        const codes = (entry!.draft.scales ?? []).map((x) => x.code);
        expect(codes, `${d.key}: у «${s.catalogKey}» нет шкалы ${s.code}`).toContain(s.code);
      }
    }
  });

  test("благополучие — единственное направление, где больше значит лучше", () => {
    expect(CONDITION_DOMAINS.filter((d) => !d.higherIsWorse).map((d) => d.key)).toEqual(["wellbeing"]);
  });
});

describe("раскладка по ступеням не выдаёт скрытое", () => {
  test("обе половины прошли порог — видны доля и ступени", () => {
    const s = spreadOf({ none: 6, mild: 5, moderate: 5, severe: 5 });
    expect(s.banded).toBe(21);
    expect(s.clinical).toEqual({ count: 10, percent: 48 });
    expect(s.bands).toEqual({ none: 6, mild: 5, moderate: 5, severe: 5 });
  });

  test("малая ступень прячет свою пару, но не долю", () => {
    // «виражена: 1» — человек; «помірна: 4» рядом с опубликованной долей назвала бы его вычитанием
    const s = spreadOf({ none: 6, mild: 5, moderate: 4, severe: 1 });
    expect(s.clinical).toEqual({ count: 5, percent: 31 });
    expect(s.bands).toEqual({ none: 6, mild: 5, moderate: null, severe: null });
  });

  test("малая половина прячет долю и все ступени", () => {
    const s = spreadOf({ none: 10, mild: 0, moderate: 0, severe: 3 });
    expect(s.banded).toBe(13);
    expect(s.clinical).toEqual({ count: null, percent: null });
    expect(Object.values(s.bands).every((v) => v === null)).toBe(true);
  });

  test("меньше порога людей — не показывается даже их число", () => {
    const s = spreadOf({ none: 2, mild: 1, moderate: 0, severe: 1 });
    expect(s.banded).toBeNull();
    expect(Object.values(s.bands).every((v) => v === null)).toBe(true);
  });

  test("нет полос вовсе — это ноль, а не «скрыто»", () => {
    const s = spreadOf({ none: 0, mild: 0, moderate: 0, severe: 0 });
    expect(s.banded).toBe(0);
    expect(s.clinical.count).toBeNull();
  });
});

describe("GET /api/dashboard/conditions", () => {
  test("депрессия: последний замер каждого, доля и средний балл основной методики", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=90", root.token);
    expect(res.status).toBe(200);
    const dep = byDomain(res.body, "depression");
    expect(dep, "направление с замерами не пришло").toBeTruthy();

    /*
     * Шестнадцать человек: пятнадцать свежих и один двухмесячной давности.
     * Первый месяц назад был в «вираженій», но последний его замер — норма:
     * «виражених» ноль, и ноль показывается нулём.
     */
    expect(dep!.people).toBe(16);
    expect(dep!.spread.banded).toBe(16);
    expect(dep!.spread.bands).toEqual({ none: 5, mild: 5, moderate: 6, severe: 0 });
    expect(dep!.spread.clinical).toEqual({ count: 6, percent: 38 });

    // среднее — по последнему замеру каждого: (5·15 + 5·30 + 6·50) / 16 = 32,8
    expect(dep!.primary?.meanPercent).toBe(33);
    expect(dep!.primary?.people).toBe(16);
    expect(dep!.primary?.title).toContain("PHQ-9");
    expect(dep!.higherIsWorse).toBe(true);
  });

  test("период сужает выборку: двухмесячный замер за 30 дней не считается", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const dep = byDomain(res.body, "depression")!;
    expect(dep.people).toBe(15);
    expect(dep.spread.clinical).toEqual({ count: 5, percent: 33 });
    expect(dep.primary?.meanPercent).toBe(32);
    expect(res.body.days).toBe(30);
  });

  test("ход по неделям: подряд, и неделя со свежими замерами посчитана", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const weeks = byDomain(res.body, "depression")!.weeks;
    expect(weeks.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < weeks.length; i++) {
      const gap = Date.parse(`${weeks[i]!.week}T00:00:00Z`) - Date.parse(`${weeks[i - 1]!.week}T00:00:00Z`);
      expect(gap).toBe(7 * 86_400_000);
    }
    expect(weeks.some((w) => w.meanPercent !== null)).toBe(true);
    for (const w of weeks) expect(w.meanPercent === null || Number.isFinite(w.meanPercent)).toBe(true);
  });

  test("WHO-5: низкий балл — клиническая полоса, среднее помечено «больше — лучше»", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const well = byDomain(res.body, "wellbeing")!;
    expect(well.higherIsWorse).toBe(false);
    /*
     * Пятеро с баллом 4 из 25 — это «дуже низьке благополуччя», то есть
     * клинические; пятеро с 22 — нет. Перевёрнутая полярность дала бы ровно
     * наоборот при том же проценте, поэтому проверяется, КТО попал в долю.
     */
    expect(well.spread.clinical).toEqual({ count: 5, percent: 50 });
    expect(well.spread.bands.severe).toBe(5);
    expect(well.spread.bands.none).toBe(5);
    // среднее в процентах от максимума: (5·16 + 5·88) / 10 = 52
    expect(well.primary?.meanPercent).toBe(52);
  });

  test("малая клиническая ячейка: доля и ступени скрыты, число людей — нет", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const anx = byDomain(res.body, "anxiety")!;
    expect(anx.people).toBe(10);
    expect(anx.spread.banded).toBe(10);
    expect(anx.spread.clinical).toEqual({ count: null, percent: null });
    expect(Object.values(anx.spread.bands).every((v) => v === null)).toBe(true);
    // двойка не должна проступить ни в одном числе ответа
    expect(JSON.stringify(anx.spread)).not.toContain(":2");
    expect(JSON.stringify(anx.spread)).not.toContain(":8");
  });

  test("меньше порога людей — «замало даних»: ни числа, ни долей, ни среднего", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const ptsd = byDomain(res.body, "ptsd")!;
    expect(ptsd.people).toBeNull();
    expect(ptsd.spread.banded).toBeNull();
    expect(ptsd.primary?.meanPercent).toBeNull();
    expect(ptsd.primary?.people).toBeNull();
    expect(ptsd.weeks.every((w) => w.meanPercent === null)).toBe(true);
  });

  test("методика без полос: людей и среднее видно, доли нет", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const stress = byDomain(res.body, "stress")!;
    expect(stress.people).toBe(6);
    expect(stress.spread.banded).toBe(0);
    expect(stress.spread.clinical.percent).toBeNull();
    expect(stress.primary?.meanPercent).toBe(40);
  });

  test("направления без замеров — списком, а не пустыми блоками", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    expect(res.body.empty).toContain("burnout");
    expect(res.body.empty).toContain("alcohol");
    expect(res.body.domains.map((d) => d.domain)).not.toContain("burnout");
  });

  test("все методики разом: каждый человек один раз", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const o = res.body.overall;
    expect(o.people).not.toBeNull();
    expect(o.people!).toBeGreaterThanOrEqual(15 + 10 + 10 + 6 + 3);
    if (o.spread.banded !== null) expect(o.spread.banded).toBeLessThanOrEqual(o.people!);
  });

  test("зона: администратор видит только методики своей группы", async () => {
    // GAD-7 перенесена в группу scopeAdmin — у него есть тревога и нет депрессии
    const mine = await api<ConditionsResult>("/api/dashboard/conditions?days=30", scopeAdmin.token);
    expect(mine.status).toBe(200);
    expect(mine.body.domains.map((d) => d.domain)).toEqual(["anxiety"]);
    expect(byDomain(mine.body, "anxiety")!.people).toBe(10);
    expect(mine.body.empty).toContain("depression");

    // чужой администратор методик каталога не видит вовсе
    const other = await api<ConditionsResult>("/api/dashboard/conditions?days=30", adminB.token);
    expect(other.status).toBe(200);
    expect(other.body.domains).toEqual([]);
  });

  test("пациенту сводка закрыта, период вне границ — отказ", async () => {
    expect((await api("/api/dashboard/conditions", patient.token)).status).toBe(403);
    expect((await api("/api/dashboard/conditions?days=3", root.token)).status).toBe(400);
  });

  test("чтение пишется в журнал", async () => {
    await api("/api/dashboard/conditions?days=30", root.token);
    const rows = await db.execute<{ n: number } & Record<string, unknown>>(sql`
      select count(*)::int as n from audit_log where action = 'dashboard.conditions' and actor_id = ${root.id}
    `);
    expect(Number([...rows][0]!.n)).toBeGreaterThan(0);
  });
});
