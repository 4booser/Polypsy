import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type {
  CohortMembers,
  CohortPreview,
  ConditionsResult,
  GroupAnalytics,
  OverviewAnalytics,
  SeverityTrendResult,
  StatRunResult,
  SurveyAnalytics,
} from "@quizzy/shared";
import {
  api,
  createSurveySchema,
  createVersion,
  db,
  encryptPersonFields,
  eq,
  groupAdmins,
  makeUser,
  root,
  sql,
  submitSurvey,
  surveyGroups,
  surveys,
  users,
  type Person,
} from "./fixtures";
import { decisionRules, responseScores, responses, ruleHits, scales, surveyVersions } from "../src/db/schema";
import { env } from "../src/env";
import { minimult } from "../src/instruments/minimult";
import { average, round, variance } from "../src/lib/stats";

/**
 * Основание агрегатов по людям: ЧТО складывается, КОГО считают и за КАКИЕ сутки.
 *
 * Клинический разбор волны 12 нашёл одиннадцать мест, где сводные числа
 * врали молча: средний «T-балл», в котором половина — сырые баллы; нормы,
 * набранные по прохождениям вместо людей; шкала лжи, записанная в тяжёлые;
 * сотрудник, пробующий методику, — среди пациентов; сутки, отрезанные по
 * Гринвичу. Каждая проверка ниже падала до правки и называет виновника
 * числом, сверенным с посевом.
 *
 * Посев — прямо в базу, а не сдачей через маршрут: нужны заданные баллы,
 * снимки пола, флаг достоверности и даты в прошлом. Сдача через API — только
 * там, где проверяется сама сдача (время до первого ответа, правило
 * поддержки решений). Все люди, подразделения и методики — свои, с
 * уникальными именами: CI обходит файлы в другом порядке, и числа не должны
 * зависеть от соседей.
 */

const uid = () => crypto.randomUUID();
const tag = () => uid().slice(0, 8);

/** Своя зона: администратор и группа только с его методиками — сводки считают ровно посев */
async function zone(name: string): Promise<{ admin: Person; groupId: string }> {
  const admin = await makeUser("admin", `agg-${name}-${uid()}@agg.test`);
  const groupId = uid();
  await db.insert(surveyGroups).values({ id: groupId, title: `Зона ${name} ${tag()}`, createdBy: root.id });
  await db.insert(groupAdmins).values({ groupId, userId: admin.id, addedBy: root.id });
  return { admin, groupId };
}

/** Человек без пароля: argon2 на сотню посевных людей стоил бы минуты */
async function quick(
  name: string,
  extra: { sex?: "male" | "female" | null; birthDate?: string; unit?: string; role?: "user" | "admin" } = {},
): Promise<string> {
  const id = uid();
  await db.insert(users).values({
    id,
    email: `${name}-${id}@agg.test`,
    passwordHash: "посів-без-входу",
    ...encryptPersonFields({ firstName: "Тест", lastName: name, birthDate: extra.birthDate ?? null }),
    role: extra.role ?? "user",
    sex: extra.sex ?? null,
    unit: extra.unit ?? null,
  } as never);
  return id;
}

async function publish(groupId: string, owner: Person, draft: unknown, title: string): Promise<string> {
  const id = uid();
  const parsed = createSurveySchema.parse(draft);
  await db.insert(surveys).values({
    id,
    groupId,
    title: { uk: `${title} ${tag()}` },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: owner.id,
  } as never);
  await createVersion(id, parsed, owner.id, "v1");
  return id;
}

interface Version {
  id: string;
  number: number;
  scale: (code: string) => string;
}

async function versionsOf(surveyId: string): Promise<Version[]> {
  const rows = await db.select().from(surveyVersions).where(eq(surveyVersions.surveyId, surveyId));
  const out: Version[] = [];
  for (const v of rows.sort((a, b) => a.version - b.version)) {
    const own = await db.select().from(scales).where(eq(scales.versionId, v.id));
    out.push({
      id: v.id,
      number: v.version,
      scale: (code) => {
        const hit = own.find((s) => s.code === code);
        if (!hit) throw new Error(`в версии ${v.version} нет шкалы ${code}`);
        return hit.id;
      },
    });
  }
  return out;
}

interface Score {
  scaleId: string;
  raw?: number;
  value: number;
  normalization?: "raw" | "ratio" | "tscore" | "sten";
  normalized?: boolean;
  severity?: "none" | "mild" | "moderate" | "severe" | null;
  /** Подпись полосы — как её записал бы движок; по ней считает аналитика методики */
  label?: string;
}

async function measure(o: {
  surveyId: string;
  versionId: string;
  userId: string;
  at?: string;
  sex?: "male" | "female" | null;
  reliable?: boolean;
  scores: Score[];
}): Promise<string> {
  const at = o.at ?? new Date(Date.now() - 3_600_000).toISOString();
  const responseId = uid();
  await db.insert(responses).values({
    id: responseId,
    surveyId: o.surveyId,
    userId: o.userId,
    status: "completed",
    versionId: o.versionId,
    startedAt: at,
    submittedAt: at,
    durationMs: 60_000,
    respondentSex: o.sex ?? null,
    reliable: o.reliable ?? true,
  } as never);
  for (const s of o.scores) {
    await db.insert(responseScores).values({
      id: uid(),
      responseId,
      scaleId: s.scaleId,
      rawScore: s.raw ?? s.value,
      value: s.value,
      normalization: s.normalization ?? "raw",
      maxScore: 100,
      percent: 0,
      normalized: s.normalized ?? true,
      bandLabel: s.label ?? s.severity ?? null,
      severity: s.severity ?? null,
    } as never);
  }
  return responseId;
}

/** Методика из одной содержательной шкалы «C» и шкалы достоверности «V» */
const simpleDraft = {
  title: { uk: "Проста методика" },
  administration: "self",
  scoringEnabled: true,
  allowRetake: true,
  visibility: "public",
  scales: [
    {
      code: "C",
      title: { uk: "Стан" },
      aggregation: "sum",
      bands: [
        { minScore: 0, maxScore: 0, label: { uk: "Норма" }, severity: "none" },
        { minScore: 1, maxScore: 9, label: { uk: "Помірно" }, severity: "moderate" },
        { minScore: 10, maxScore: 99, label: { uk: "Тяжко" }, severity: "severe" },
      ],
    },
    {
      code: "V",
      title: { uk: "Щирість" },
      kind: "validity",
      aggregation: "sum",
      bands: [
        { minScore: 0, maxScore: 0, label: { uk: "Щиро" }, severity: "none" },
        { minScore: 1, maxScore: 9, label: { uk: "Нещиро" }, severity: "severe" },
      ],
    },
  ],
  questions: [
    {
      type: "single",
      title: { uk: "Як ви?" },
      scaleCode: "C",
      required: true,
      options: [
        { text: { uk: "Добре" }, score: 0 },
        { text: { uk: "Погано" }, score: 5 },
      ],
    },
    {
      type: "single",
      title: { uk: "Чесно?" },
      scaleCode: "V",
      options: [
        { text: { uk: "Так" }, score: 0 },
        { text: { uk: "Ні" }, score: 1 },
      ],
    },
  ],
};

/** Мини-мульт с правкой: ключ Hs короче на пункт или другие нормы Hs */
function minimultWith(change: "hsKey" | "hsNorms") {
  const draft = structuredClone(minimult) as unknown as {
    scales: { code: string; key: unknown[]; norms: { mean: number }[] }[];
  };
  const hs = draft.scales.find((s) => s.code === "Hs")!;
  if (change === "hsKey") hs.key = hs.key.slice(1);
  else hs.norms = hs.norms.map((n) => ({ ...n, mean: n.mean + 0.5 }));
  return createSurveySchema.parse(draft);
}

const preview = (actor: Person, spec: object) =>
  api<CohortPreview>("/api/cohorts/preview", actor.token, { method: "POST", body: JSON.stringify(spec) });

const run = (actor: Person, columns: object[]) =>
  api<StatRunResult>("/api/stat-models/run", actor.token, { method: "POST", body: JSON.stringify({ columns }) });

const column = (surveyId: string, filters: object = {}, bands: object[] = []) => ({
  title: null,
  presetId: null,
  filters,
  surveyId,
  bands,
  questions: [],
});

/** Смена пояса учреждения на время проверки: сутки должны резаться по нему, а не по базе */
async function inZone<T>(zoneName: string, body: () => Promise<T>): Promise<T> {
  const was = env.institutionTz;
  env.institutionTz = zoneName;
  try {
    return await body();
  } finally {
    env.institutionTz = was;
  }
}

/* ═══════════ посев ═══════════ */

let main: { admin: Person; groupId: string };
/** Срезы (и условие подбора по баллу — на тех же людях): Мини-мульт, два издания ключа Hs, одно подразделение */
let facetSurvey: string;
const FACET_UNIT = `Срез-${tag()}`;
/** Нормы: три версии — исходная, с другим ключом Hs, с другими нормами Hs */
let normSurvey: string;
/** Возраст: статистика и подбор на одном фильтре */
let ageSurvey: string;
/** Пол-снимок против нынешнего пола */
let sexSurvey: string;
const SEX_UNIT = `Стать-${tag()}`;

/** Методики, заведённые прямо в проверках: их прохождения тоже уводятся в прошлое (см. afterAll) */
const extra: string[] = [];

/** Своя зона для сводки, ряда, группы и «Зведення»: достоверность, шкалы достоверности, сотрудник */
let z: { admin: Person; groupId: string };
let zSurvey: string;
let zBands: { none: string };

/** Пояс учреждения: сутки и недели */
let tzZone: { admin: Person; groupId: string };
let tzSurvey: string;
const TZ_UNIT = `Пояс-${tag()}`;
/** Воскресенье прошлой недели, полдень по Гринвичу: на Кірітіматі это уже понедельник */
const sunday = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7 - d.getUTCDay());
  d.setUTCHours(12, 0, 0, 0);
  return d;
})();
const sundayDay = sunday.toISOString().slice(0, 10);
const mondayAfter = new Date(sunday.getTime() + 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  main = await zone("main");

  /* ── срезы ── */
  facetSurvey = await publish(main.groupId, main.admin, minimult, "Міні-мульт зрізів");
  await createVersion(facetSurvey, minimultWith("hsKey"), main.admin.id, "ключ Hs");
  const [f1, f2] = await versionsOf(facetSurvey);
  const hs = (v: Version, value: number, normed: boolean): Score => ({
    scaleId: v.scale("Hs"),
    value,
    raw: normed ? 10 : value,
    normalization: "tscore",
    normalized: normed,
    severity: normed ? "none" : null,
  });
  // версия 1: пятеро мужчин с T 60, 62, 65, 67, 70,5 — среднее 64,9
  for (const t of [60, 62, 65, 67, 70.5]) {
    const u = await quick("f1m", { sex: "male", unit: FACET_UNIT });
    await measure({ surveyId: facetSurvey, versionId: f1!.id, userId: u, sex: "male", scores: [hs(f1!, t, true)] });
  }
  // версия 1: пятеро без пола — нормы нет, в value лежит сырой 11
  for (let i = 0; i < 5; i++) {
    const u = await quick("f1n", { unit: FACET_UNIT });
    await measure({ surveyId: facetSurvey, versionId: f1!.id, userId: u, scores: [hs(f1!, 11, false)] });
  }
  // версия 2 (ключ Hs другой): пятеро мужчин T 50 и пятеро без пола — сырой 20
  for (let i = 0; i < 5; i++) {
    const u = await quick("f2m", { sex: "male", unit: FACET_UNIT });
    await measure({ surveyId: facetSurvey, versionId: f2!.id, userId: u, sex: "male", scores: [hs(f2!, 50, true)] });
  }
  for (let i = 0; i < 5; i++) {
    const u = await quick("f2n", { unit: FACET_UNIT });
    await measure({ surveyId: facetSurvey, versionId: f2!.id, userId: u, scores: [hs(f2!, 20, false)] });
  }
  // недостоверные протоколы (T 30) и сотрудник на себя (T 100) — вне средних
  for (let i = 0; i < 5; i++) {
    const u = await quick("f1u", { sex: "male", unit: FACET_UNIT });
    await measure({ surveyId: facetSurvey, versionId: f1!.id, userId: u, sex: "male", reliable: false, scores: [hs(f1!, 30, true)] });
  }
  {
    const u = await quick("f1s", { sex: "male", unit: FACET_UNIT, role: "admin" });
    await measure({ surveyId: facetSurvey, versionId: f1!.id, userId: u, sex: "male", scores: [hs(f1!, 100, true)] });
  }

  /* ── нормы ── */
  normSurvey = await publish(main.groupId, main.admin, minimult, "Міні-мульт норм");
  await createVersion(normSurvey, minimultWith("hsKey"), main.admin.id, "ключ Hs");
  await createVersion(normSurvey, minimultWith("hsNorms"), main.admin.id, "нормы Hs");
  const [n1, n2, n3] = await versionsOf(normSurvey);
  const hsk = (v: Version, raw: number): Score[] => [
    { scaleId: v.scale("Hs"), raw, value: 50, normalization: "tscore" },
    { scaleId: v.scale("K"), raw: 10, value: 50, normalization: "tscore" },
  ];
  const early = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  /*
   * 29 человек, все мужчины по снимку; двое из них сейчас записаны женщинами.
   * Первые двадцать сдавали версию 1, остальные девять — версию 3 (другие
   * только нормы, ключ тот же). Сырой Hs = 5 + (i mod 5), K = 10: исправленный
   * балл 10…14.
   */
  for (let i = 0; i < 29; i++) {
    const u = await quick("nm", { sex: i < 2 ? "female" : "male" });
    const v = i < 20 ? n1! : n3!;
    await measure({ surveyId: normSurvey, versionId: v.id, userId: u, sex: "male", at: early(30), scores: hsk(v, 5 + (i % 5)) });
    // трое пересдали позже с сырым 30: считается первое прохождение, а человек — один
    if (i < 3) await measure({ surveyId: normSurvey, versionId: v.id, userId: u, sex: "male", at: early(5), scores: hsk(v, 30) });
  }
  // версия 2 — другой ключ Hs: её сырые баллы с этими не складываются
  for (let i = 0; i < 4; i++) {
    const u = await quick("nm2", { sex: "male" });
    await measure({ surveyId: normSurvey, versionId: n2!.id, userId: u, sex: "male", at: early(20), scores: hsk(n2!, 0) });
  }
  // недостоверные — не норма
  for (let i = 0; i < 3; i++) {
    const u = await quick("nmu", { sex: "male" });
    await measure({ surveyId: normSurvey, versionId: n1!.id, userId: u, sex: "male", reliable: false, at: early(20), scores: hsk(n1!, 40) });
  }
  // сотрудник на себя — не норма
  {
    const u = await quick("nms", { sex: "male", role: "admin" });
    await measure({ surveyId: normSurvey, versionId: n1!.id, userId: u, sex: "male", at: early(20), scores: hsk(n1!, 50) });
  }

  /* ── возраст ── */
  ageSurvey = await publish(main.groupId, main.admin, simpleDraft, "Вік");
  const [a1] = await versionsOf(ageSurvey);
  const born = new Date();
  born.setUTCFullYear(born.getUTCFullYear() - 31);
  born.setUTCDate(born.getUTCDate() - 10);
  const birthDate = born.toISOString().slice(0, 10);
  for (let i = 0; i < 6; i++) {
    const u = await quick("age", { sex: "male", birthDate });
    // сорок дней назад человеку было 30, сейчас — 31 (день рождения десять дней назад)
    await measure({ surveyId: ageSurvey, versionId: a1!.id, userId: u, sex: "male", at: early(40), scores: [{ scaleId: a1!.scale("C"), value: 0, severity: "none" }] });
    if (i === 5) {
      await measure({ surveyId: ageSurvey, versionId: a1!.id, userId: u, sex: "male", at: early(2), scores: [{ scaleId: a1!.scale("C"), value: 0, severity: "none" }] });
    }
  }

  /* ── пол ── */
  sexSurvey = await publish(main.groupId, main.admin, simpleDraft, "Стать");
  const [s1] = await versionsOf(sexSurvey);
  for (let i = 0; i < 6; i++) {
    // сдавали мужчинами; карточку потом поправили на «жінка»
    const u = await quick("sx", { sex: "female", unit: SEX_UNIT });
    await measure({ surveyId: sexSurvey, versionId: s1!.id, userId: u, sex: "male", scores: [{ scaleId: s1!.scale("C"), value: 0, severity: "none" }] });
  }

  /* ── своя зона сводок ── */
  z = await zone("z");
  zSurvey = await publish(z.groupId, z.admin, simpleDraft, "Зведення");
  const [zv] = await versionsOf(zSurvey);
  const zScores = (c: "none" | "severe"): Score[] => [
    { scaleId: zv!.scale("C"), value: c === "none" ? 0 : 20, severity: c, label: c === "none" ? "Норма" : "Тяжко" },
    // шкала достоверности в полосе «severe» у всех: это протокол, а не человек
    { scaleId: zv!.scale("V"), value: 1, severity: "severe", label: "Нещиро" },
  ];
  // шестеро достоверных в норме, пятеро недостоверных с «тяжело», один сотрудник с «тяжело»
  for (let i = 0; i < 6; i++) {
    const u = await quick("zr");
    await measure({ surveyId: zSurvey, versionId: zv!.id, userId: u, scores: zScores("none") });
  }
  for (let i = 0; i < 5; i++) {
    const u = await quick("zu");
    await measure({ surveyId: zSurvey, versionId: zv!.id, userId: u, reliable: false, scores: zScores("severe") });
  }
  {
    const u = await quick("zs", { role: "admin" });
    await measure({ surveyId: zSurvey, versionId: zv!.id, userId: u, scores: zScores("severe") });
  }
  const full = await api(`/api/surveys/${zSurvey}`, z.admin.token);
  const c = full.body.scales.find((s: { code: string }) => s.code === "C");
  zBands = { none: c.bands.find((b: { severity: string }) => b.severity === "none").id };

  /* ── пояс ── */
  tzZone = await zone("tz");
  tzSurvey = await publish(tzZone.groupId, tzZone.admin, simpleDraft, "Пояс");
  const [t1] = await versionsOf(tzSurvey);
  // воскресенье, полдень по Гринвичу: на Кірітіматі (UTC+14) — уже понедельник, следующий день и следующая неделя
  for (let i = 0; i < 5; i++) {
    const u = await quick("tz", { unit: TZ_UNIT });
    await measure({ surveyId: tzSurvey, versionId: t1!.id, userId: u, at: sunday.toISOString(), scores: [{ scaleId: t1!.scale("C"), value: 0, severity: "none" }] });
  }
}, 120_000);

/* ═══════════ 1. срезы: среднее только по сравнимым значениям ═══════════ */

describe("срезы усредняют только сравнимое", () => {
  interface Entry {
    code: string;
    unit: string;
    normed: boolean;
    versions: number[];
    basis: string;
    strata: { stratum: string; n: number; mean: number | null; median: number | null }[];
  }

  /*
   * Мутация: вернуть `avg(value)` по всем строкам шкалы — T-баллы и сырые
   * сливаются в одно «среднее» 37,67, и проверка называет его.
   */
  test("T-баллы отдельно от сырых, сырые — по изданиям ключа", async () => {
    const res = await api<{ scales: Entry[] }>(`/api/facets/surveys/${facetSurvey}?facet=unit`, main.admin.token);
    expect(res.status).toBe(200);
    const hs = res.body.scales.filter((s) => s.code === "Hs");
    const cell = (e: Entry | undefined) => e?.strata.find((s) => s.stratum === FACET_UNIT);

    // T-баллы обеих версий — одна шкала: они уже приведены нормой
    const t = hs.find((e) => e.unit === "tscore");
    expect(t, `групп Hs: ${JSON.stringify(hs.map((e) => [e.unit, e.normed, e.versions]))}`).toBeTruthy();
    expect(t!.normed).toBe(true);
    expect(t!.versions).toEqual([1, 2]);
    // 60 62 65 67 70,5 и пятеро по 50: среднее 57,45, медиана 55 — без T 30 недостоверных и T 100 сотрудника
    expect(cell(t)).toMatchObject({ n: 10, mean: 57.45, median: 55 });

    // сырые без нормы — отдельно и по своей версии: ключ Hs во второй другой
    const raw1 = hs.find((e) => e.unit === "raw" && e.versions.join() === "1");
    const raw2 = hs.find((e) => e.unit === "raw" && e.versions.join() === "2");
    expect(raw1?.normed).toBe(false);
    expect(cell(raw1)).toMatchObject({ n: 5, mean: 11 });
    expect(cell(raw2)).toMatchObject({ n: 5, mean: 20 });
    expect(hs).toHaveLength(3);
  });

  test("у каждой группы есть подпись — что именно усреднено", async () => {
    const res = await api<{ scales: Entry[] }>(`/api/facets/surveys/${facetSurvey}?facet=unit`, main.admin.token, {
      headers: { "Accept-Language": "uk" },
    });
    const hs = res.body.scales.filter((s) => s.code === "Hs");
    const t = hs.find((e) => e.unit === "tscore")!;
    const raw = hs.find((e) => e.unit === "raw")!;
    expect(t.basis).toContain("T-бал");
    expect(raw.basis).toContain("норму не застосовано");
    expect(raw.basis).toContain(String(raw.versions[0]));
  });
});

/* ═══════════ 2. кандидаты локальных норм ═══════════ */

describe("кандидаты локальных норм", () => {
  /*
   * Мутации, каждая роняет «n = 29»: считать прохождения (32 с тремя
   * пересдачами), брать нынешний пол из карточки (27), пускать недостоверные
   * (+3), смешивать версии с другим ключом (+4), пускать сотрудника (+1).
   */
  test("люди, а не прохождения: первое достоверное прохождение совместимых версий, пол — снимок", async () => {
    const res = await api(`/api/norms/surveys/${normSurvey}/candidates`, main.admin.token);
    expect(res.status).toBe(200);
    const hs = res.body.scales.find((s: { code: string }) => s.code === "Hs");
    expect(hs.versions, "версия 2 с другим ключом в выборку Hs не идёт").toEqual([1, 3]);

    const values = Array.from({ length: 29 }, (_, i) => 10 + (i % 5));
    const male = hs.candidate.find((g: { sex: string | null }) => g.sex === "male");
    expect(male).toMatchObject({
      n: 29,
      mean: round(average(values)),
      sd: round(Math.sqrt(variance(values))),
      publishable: false,
    });
    // двое «сейчас жінки» сдавали мужчинами: женской группы нет вовсе
    expect(hs.candidate.find((g: { sex: string | null }) => g.sex === "female")).toBeUndefined();
    expect(hs.candidate.find((g: { sex: string | null }) => g.sex === null)?.n).toBe(29);
  });

  test("порог 30 — по людям: 29 человек не публикуются, сколько бы прохождений у них ни было", async () => {
    const res = await api(`/api/norms/surveys/${normSurvey}/apply`, main.admin.token, {
      method: "POST",
      body: JSON.stringify({ scaleCodes: ["Hs"] }),
    });
    expect(res.status).toBe(400);
  });
});

/* ═══════════ 3, 6, 8. сводка, ряд, группа, «Зведення», подбор ═══════════ */

describe("шкалы достоверности, недостоверные протоколы и сотрудники", () => {
  /*
   * Мутации: снять `sc.kind = 'clinical'` — «тяжело» растёт на двенадцать
   * полос шкалы V; снять `reliable` — на пять; снять отсев сотрудника — на
   * одного, и прохождений становится двенадцать.
   */
  test("сводка: выраженность — только содержательные шкалы достоверных протоколов пациентов", async () => {
    const res = await api<OverviewAnalytics>("/api/analytics/overview", z.admin.token);
    expect(res.status).toBe(200);
    expect(res.body.responseCount, "сотрудник на себя — не прохождение пациента").toBe(11);
    expect(res.body.respondentCount).toBe(11);
    expect(res.body.severityBreakdown).toEqual([{ severity: "none", count: 6 }]);
    expect(res.body.unreliableCount).toBe(5);
    expect(res.body.timeline.reduce((s, d) => s + d.count, 0)).toBe(11);
  });

  test("ряд по неделям: недостоверные — отдельной строкой, а не «тяжело»", async () => {
    const res = await api<SeverityTrendResult>("/api/analytics/severity-trend", z.admin.token);
    const sum = (k: "none" | "mild" | "moderate" | "severe") => res.body.weeks.reduce((s, w) => s + w[k], 0);
    expect(sum("none")).toBe(6);
    expect(sum("severe")).toBe(0);
    expect(res.body.unreliable).toBe(5);
  });

  test("группа: те же шесть в норме, пять недостоверных, без сотрудника", async () => {
    const res = await api<GroupAnalytics>(`/api/analytics/groups/${z.groupId}`, z.admin.token);
    expect(res.body.responseCount).toBe(11);
    expect(res.body.patientCount).toBe(11);
    expect(res.body.severityBreakdown).toEqual([{ severity: "none", count: 6 }]);
    expect(res.body.unreliableCount).toBe(5);
  });

  test("«Зведення»: у недостоверного протокола нет состояния", async () => {
    const res = await api<ConditionsResult>("/api/dashboard/conditions?days=30", z.admin.token);
    expect(res.body.overall.people).toBe(6);
    expect(res.body.overall.spread.bands).toEqual({ none: 6, mild: 0, moderate: 0, severe: 0 });
  });

  test("«Зведення» и сводка суперадмина: сотрудник на себя не добавляет ни человека, ни прохождения", async () => {
    const before = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const overviewBefore = await api<OverviewAnalytics>("/api/analytics/overview", root.token);
    const [zv] = await versionsOf(zSurvey);
    const staff = await quick("zs2", { role: "admin" });
    await measure({ surveyId: zSurvey, versionId: zv!.id, userId: staff, scores: [{ scaleId: zv!.scale("C"), value: 20, severity: "severe" }] });
    const after = await api<ConditionsResult>("/api/dashboard/conditions?days=30", root.token);
    const overviewAfter = await api<OverviewAnalytics>("/api/analytics/overview", root.token);
    expect(after.body.overall.people).toBe(before.body.overall.people);
    expect(after.body.overall.spread.bands.severe).toBe(before.body.overall.spread.bands.severe);
    expect(overviewAfter.body.responseCount).toBe(overviewBefore.body.responseCount);
  });

  test("подбор: полоса шкалы лжи — не тяжесть человека, недостоверные — своей строкой", async () => {
    const res = await preview(z.admin, { surveyId: zSurvey });
    expect(res.body.size).toBe(11);
    expect(res.body.bySeverity).toEqual([
      { key: "none", count: 6 },
      { key: "unreliable", count: 5 },
    ]);
    // «не нижче тяжкої» — никого: тяжёлой была только шкала достоверности и недостоверные протоколы
    expect((await preview(z.admin, { surveyId: zSurvey, minSeverity: "severe" })).body.size).toBe(0);
  });

  test("поимённый список: у недостоверного протокола нет полосы, и это сказано", async () => {
    const res = await api<CohortMembers>("/api/cohorts/members", z.admin.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: zSurvey }),
    });
    expect(res.body.items).toHaveLength(11);
    const trusted = res.body.items.filter((p) => p.last?.reliable);
    const doubtful = res.body.items.filter((p) => p.last && !p.last.reliable);
    expect(trusted).toHaveLength(6);
    expect(trusted.every((p) => p.last!.severity === "none")).toBe(true);
    expect(doubtful).toHaveLength(5);
    expect(doubtful.every((p) => p.last!.severity === null)).toBe(true);
  });

  test("статистика: выборка — последний достоверный протокол", async () => {
    const res = await run(z.admin, [column(zSurvey, {}, [{ scaleId: (await versionsOf(zSurvey))[0]!.scale("C"), bandId: zBands.none, highRisk: false }])]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns[0]!.respondents).toEqual({ suppressed: false, count: 6, percent: 100 });
  });

  test("аналитика методики: содержательная шкала без недостоверных, шкала достоверности — все", async () => {
    const res = await api<SurveyAnalytics>(`/api/analytics/surveys/${zSurvey}`, z.admin.token);
    expect(res.status).toBe(200);
    expect(res.body.unreliableCount).toBe(5);
    const c = res.body.scales.find((s) => s.code === "C")!;
    const v = res.body.scales.find((s) => s.code === "V")!;
    expect(c.bands.map((b) => [b.severity, b.count])).toEqual([
      ["none", 6],
      ["moderate", 0],
      ["severe", 0],
    ]);
    // полоса достоверности показывает, сколько протоколов под вопросом, — там считаются все пациенты
    expect(v.bands.find((b) => b.severity === "severe")!.count).toBe(11);
  });
});

/* ═══════════ 4. условие по баллу — только по нормированному ═══════════ */

describe("условие подбора по баллу", () => {
  /*
   * Мутация: снять `rs.normalized` — «Hs ≤ 25» находит десятерых без пола с
   * сырыми 11 и 20, будто это T-баллы ниже нормы.
   */
  test("сырой балл без нормы не сравнивается с T-порогом", async () => {
    const at = (op: string, value: number) =>
      preview(main.admin, { surveyId: facetSurvey, units: [FACET_UNIT], scales: [{ code: "Hs", op, value }] });
    expect((await at("<=", 25)).body.size).toBe(0);
    // T 60…70,5 и T 50 — десять человек; недостоверные T 30 и сотрудник не в счёт
    expect((await at(">=", 10)).body.size).toBe(10);
    expect((await at(">=", 55)).body.size).toBe(5);
  });
});

/* ═══════════ 5. возраст: статистика и подбор на одном фильтре ═══════════ */

describe("возрастной фильтр", () => {
  /*
   * Мутация: вернуть фильтр возраста после выбора последнего прохождения —
   * шестой (последний замер в 31) выпадает, статистика даёт 5 против 6.
   */
  test("статистика и подбор отвечают одним числом", async () => {
    const stat = await run(main.admin, [column(ageSurvey, { ageMin: 30, ageMax: 30 })]);
    const cohort = await preview(main.admin, { surveyId: ageSurvey, ageMin: 30, ageMax: 30 });
    expect(cohort.body.size).toBe(6);
    expect(stat.body.columns[0]!.respondents).toEqual({ suppressed: false, count: 6, percent: 100 });
  });
});

/* ═══════════ 7. пол — снимок на момент сдачи ═══════════ */

describe("пол в фильтрах — снимок сдачи", () => {
  /*
   * Мутация: вернуть `u.sex` / `users.sex` — шестеро «сейчас жінки» пропадают
   * из «чоловіки» и появляются в «жінки».
   */
  test("подбор", async () => {
    expect((await preview(main.admin, { surveyId: sexSurvey, sex: "male" })).body.size).toBe(6);
    expect((await preview(main.admin, { surveyId: sexSurvey, sex: "female" })).body.size).toBe(0);
    const all = await preview(main.admin, { surveyId: sexSurvey, units: [SEX_UNIT] });
    expect(all.body.bySex).toEqual([{ key: "male", count: 6 }]);
  });

  test("статистика", async () => {
    const res = await run(main.admin, [column(sexSurvey, { sex: "male" })]);
    expect(res.body.columns[0]!.respondents).toEqual({ suppressed: false, count: 6, percent: 100 });
  });
});

/* ═══════════ 9. сутки и недели — по поясу учреждения ═══════════ */

describe("пояс учреждения", () => {
  /*
   * Пояс учреждения ставится на Кірітіматі (UTC+14), чтобы разойтись и с
   * UTC сервера, и с Киевом разработчика: воскресный полдень по Гринвичу там
   * уже понедельник — другой день и другая неделя. Мутация: вернуть `::date` без пояса в любой из границ —
   * соответствующая проверка находит ноль вместо пяти.
   */
  const KIRITIMATI = "Pacific/Kiritimati";

  test("подбор", async () => {
    await inZone(KIRITIMATI, async () => {
      expect((await preview(tzZone.admin, { units: [TZ_UNIT], from: mondayAfter, to: mondayAfter })).body.size).toBe(5);
      expect((await preview(tzZone.admin, { units: [TZ_UNIT], to: sundayDay })).body.size).toBe(0);
    });
  });

  test("статистика", async () => {
    await inZone(KIRITIMATI, async () => {
      const res = await run(tzZone.admin, [column(tzSurvey, { from: mondayAfter, to: mondayAfter })]);
      expect(res.body.columns[0]!.respondents).toEqual({ suppressed: false, count: 5, percent: 100 });
    });
  });

  test("аналитика методики и список прохождений", async () => {
    await inZone(KIRITIMATI, async () => {
      const a = await api<SurveyAnalytics>(`/api/analytics/surveys/${tzSurvey}?from=${mondayAfter}&to=${mondayAfter}`, tzZone.admin.token);
      expect(a.body.completed).toBe(5);
      const list = await api(`/api/surveys/${tzSurvey}/responses?from=${mondayAfter}&to=${mondayAfter}`, tzZone.admin.token);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.rows).toHaveLength(5);
    });
  });

  test("ряд выраженности режет недели там же, где «Зведення»", async () => {
    await inZone(KIRITIMATI, async () => {
      const res = await api<SeverityTrendResult>("/api/analytics/severity-trend", tzZone.admin.token);
      const week = res.body.weeks.find((w) => w.week === mondayAfter);
      expect(week, `недели: ${res.body.weeks.map((w) => w.week).join(", ")}`).toBeTruthy();
      expect(week!.none).toBe(5);
    });
  });
});

/* ═══════════ 10. время до первого ответа без ленты событий ═══════════ */

describe("время до первого ответа", () => {
  /*
   * Мутация: вернуть `Math.round(average([]))` — после чистки ленты событий
   * пункт показывает «0 с до первого ответа», как будто отвечали мгновенно.
   */
  test("нет событий — null, а не ноль", async () => {
    const sid = await publish(main.groupId, main.admin, simpleDraft, "Лента");
    extra.push(sid);
    const person = await makeUser("user", `agg-ev-${uid()}@agg.test`);
    expect((await submitSurvey(sid, person.token)).status).toBe(201);
    const bare = await api<SurveyAnalytics>(`/api/analytics/surveys/${sid}`, main.admin.token);
    expect(bare.body.questions[0]!.avgTimeToFirstAnswerMs).toBeNull();

    const other = await makeUser("user", `agg-ev2-${uid()}@agg.test`);
    const questionId = bare.body.questions[0]!.questionId;
    const res = await submitSurvey(sid, other.token, {
      events: [{ questionId, sequence: 0, kind: "set", elapsedMs: 1500, at: new Date().toISOString() }],
    });
    expect(res.status).toBe(201);
    const withEvents = await api<SurveyAnalytics>(`/api/analytics/surveys/${sid}`, main.admin.token);
    expect(withEvents.body.questions[0]!.avgTimeToFirstAnswerMs).toBe(1500);
  });
});

/* ═══════════ 11. правило «по нормированному баллу» без нормы ═══════════ */

describe("правило поддержки решений по нормированному баллу", () => {
  let ruleId = "";
  afterAll(async () => {
    if (ruleId) await db.update(decisionRules).set({ enabled: false }).where(eq(decisionRules.id, ruleId));
  });

  /*
   * Мутация: вернуть `s.value` для tscore без проверки `normalized` —
   * человек без пола получает «нормированный балл» равным сырому, и правило
   * «Hs ≥ 0 T» срабатывает на сыром.
   */
  test("норма не применилась — правило не срабатывает", async () => {
    const sid = await publish(main.groupId, main.admin, minimult, "Міні-мульт правил");
    extra.push(sid);
    const created = await api("/api/decisions/rules", root.token, {
      method: "POST",
      body: JSON.stringify({
        title: `Hs за нормою ${tag()}`,
        conditions: [{ kind: "scale", surveyId: sid, scaleCode: "Hs", metric: "normed", op: ">=", value: 0 }],
        actions: [{ kind: "notify_duty" }],
      }),
    });
    expect(created.status).toBe(201);
    ruleId = created.body.id;

    const unknown = await makeUser("user", `agg-rule-n-${uid()}@agg.test`);
    const man = await makeUser("user", `agg-rule-m-${uid()}@agg.test`, { sex: "male", birthDate: "1990-01-01" });
    expect((await submitSurvey(sid, unknown.token)).status).toBe(201);
    expect((await submitSurvey(sid, man.token)).status).toBe(201);

    const hits = await db.select().from(ruleHits).where(eq(ruleHits.ruleId, ruleId));
    const who = new Set(hits.map((h) => h.userId));
    expect(who.has(man.id), "контроль: при норме правило срабатывает").toBe(true);
    expect(who.has(unknown.id), "без нормы сравнивался сырой балл").toBe(false);
  });
});

/*
 * Посев уводится за пределы любого периода сводок (больше года назад):
 * соседние файлы считают «Зведення» и ряд выраженности точными числами.
 * Удалять незачем — старше года их не видит ни одна сводка.
 */
afterAll(async () => {
  const mine = [facetSurvey, normSurvey, ageSurvey, sexSurvey, zSurvey, tzSurvey, ...extra].filter(Boolean);
  if (!mine.length) return;
  const away = new Date(Date.now() - 4 * 365 * 86_400_000).toISOString();
  await db
    .update(responses)
    .set({ submittedAt: away, startedAt: away } as never)
    .where(inArray(responses.surveyId, mine));
});

/* посев не пуст: проверки выше, сверяющие «ноль», иначе сверяли бы пустоту с пустотой */
test("посев на месте", async () => {
  const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from responses where survey_id = ${facetSurvey}`);
  expect(Number(row!.n)).toBe(26);
});
