import { beforeAll, describe, expect, test } from "bun:test";
import type { CaseSummary, RespondentDynamics, ScaleDynamics } from "@quizzy/shared";
import { and, eq } from "drizzle-orm";
import {
  api,
  createSurveySchema,
  createVersion,
  db,
  makeUser,
  root,
  sql,
  sr45,
  surveys,
  type Person,
} from "./fixtures";
import { answers, responseScores, responses, scales, surveyVersions } from "../src/db/schema";
import { getSurvey } from "../src/lib/surveys";
import { percentileOf } from "../src/lib/norms";
import { variance } from "../src/lib/stats";

/**
 * Изменение балла между замерами: когда его можно считать и на чём.
 *
 * Внешний и клинический разборы, волна 12:
 *
 *   P1  частичное приведение версий: одного удачного коэффициента хватало,
 *       чтобы весь ряд считался сопоставимым, — при трёх версиях первая
 *       вычиталась из последней неприведённой;
 *   P1  сырой балл без норм вычитался из T-балла той же версии, а базой
 *       служил и недостоверный протокол;
 *   P2  выборка для SD и перцентиля смешивала версии и нормировки;
 *   P2  альфа бралась по трёмстам САМЫМ СТАРЫМ прохождениям и сверялась с
 *       вопросами действующей версии — после правки методики RCI пропадал;
 *   P2  сводка случая считала RCI между любыми версиями и с надёжностью 0,8;
 *   P2  RCI уже от десяти наблюдений при общем пороге тридцать.
 *
 * Методика — своя, три версии (СР-45, шкала Sr). Замеры и выборка кладутся
 * прямо в базу: нужны точные значения, нормировка и время сдачи, а сдача
 * через API подняла бы тревоги и сдвинула бы соседние проверки.
 */

const CODE = "Sr";
const DAY = 86_400_000;
const now = Date.now();
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

/** Детерминированный генератор: повтор запуска — повтор данных */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20260927);

const surveyId = crypto.randomUUID();
const versionIds: string[] = [];
const scaleIdOf = new Map<string, string>();
let pop: Person;
const people: Record<"P" | "Q" | "R" | "U" | "V", Person> = {} as never;

interface Measure {
  who: Person;
  version: 1 | 2 | 3;
  value: number;
  normalization?: "ratio" | "tscore";
  normalized?: boolean;
  reliable?: boolean;
  at: string;
  /** склонность отвечать «так» — для ответов, из которых считается альфа */
  latent?: number;
}

async function measure(m: Measure): Promise<string> {
  const versionId = versionIds[m.version - 1]!;
  const responseId = crypto.randomUUID();
  await db.insert(responses).values({
    id: responseId,
    surveyId,
    userId: m.who.id,
    status: "completed",
    versionId,
    startedAt: m.at,
    submittedAt: m.at,
    reliable: m.reliable ?? true,
  } as never);
  await db.insert(responseScores).values({
    id: crypto.randomUUID(),
    responseId,
    scaleId: scaleIdOf.get(versionId)!,
    rawScore: m.value,
    value: m.value,
    normalization: m.normalization ?? "ratio",
    maxScore: 100,
    percent: 0,
    normalized: m.normalized ?? true,
  } as never);
  if (m.latent !== undefined) {
    const survey = (await getSurvey(surveyId, versionId, "ru"))!;
    await db.insert(answers).values(
      survey.questions.map((q) => {
        const yes = q.options.find((o) => o.keyCode === "yes")!;
        const no = q.options.find((o) => o.keyCode === "no")!;
        return {
          id: crypto.randomUUID(),
          responseId,
          questionId: q.id,
          optionIds: [rand() < m.latent! ? yes.id : no.id],
          skipped: false,
        };
      }) as never,
    );
  }
  return responseId;
}

/** Нормированные баллы шкалы одной версии и нормировки — то, на чём обязан стоять расчёт */
async function bucket(version: 1 | 2 | 3, normalization: "ratio" | "tscore"): Promise<number[]> {
  const rows = await db
    .select({ value: responseScores.value })
    .from(responseScores)
    .innerJoin(responses, eq(responses.id, responseScores.responseId))
    .where(
      and(
        eq(responses.surveyId, surveyId),
        eq(responses.versionId, versionIds[version - 1]!),
        eq(responseScores.normalized, true),
        eq(responseScores.normalization, normalization),
      ),
    );
  return rows.map((r) => r.value);
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v: number[]) => Math.sqrt(variance(v));

async function dynamicsOf(who: Person): Promise<ScaleDynamics> {
  const res = await api<RespondentDynamics>(`/api/dynamics/respondents/${who.id}?survey=${surveyId}`, root.token);
  expect(res.status).toBe(200);
  const sc = res.body.surveys[0]?.scales.find((s) => s.code === CODE);
  expect(sc, "шкала Sr в динамике не найдена").toBeDefined();
  return sc!;
}

async function summaryOf(who: Person) {
  const res = await api<CaseSummary>(`/api/referrals/summary/${who.id}`, root.token);
  expect(res.status).toBe(200);
  return res.body.surveys.find((s) => s.surveyId === surveyId)?.scales.find((s) => s.code === CODE);
}

beforeAll(async () => {
  const input = createSurveySchema.parse(sr45);
  await db.insert(surveys).values({
    id: surveyId,
    groupId: null,
    title: { uk: "Динаміка трьох версій", ru: "Динамика трёх версий" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: root.id,
  } as never);
  for (const note of ["перша", "друга", "третя"]) versionIds.push(await createVersion(surveyId, input, root.id, note));
  for (const versionId of versionIds) {
    const [sc] = await db
      .select({ id: scales.id })
      .from(scales)
      .where(and(eq(scales.versionId, versionId), eq(scales.code, CODE)));
    scaleIdOf.set(versionId, sc!.id);
  }
  const numbers = await db
    .select({ id: surveyVersions.id, version: surveyVersions.version })
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, surveyId));
  expect(numbers.map((n) => n.version).sort()).toEqual([1, 2, 3]);

  pop = await makeUser("user", `dyn-pop-${crypto.randomUUID()}@test`);
  for (const k of ["P", "Q", "R", "U", "V"] as const) {
    people[k] = await makeUser("user", `dyn-${k}-${crypto.randomUUID()}@test`);
  }

  /*
   * Триста старых прохождений первой версии — без баллов и без ответов.
   * Прежняя альфа брала триста САМЫХ СТАРЫХ прохождений методики и сверяла
   * их ответы с вопросами действующей версии: здесь они все — первой версии,
   * и альфа третьей не находилась бы никогда.
   */
  await db.insert(responses).values(
    Array.from({ length: 300 }, (_, i) => ({
      id: crypto.randomUUID(),
      surveyId,
      userId: pop.id,
      status: "completed",
      versionId: versionIds[0]!,
      startedAt: at(400 * DAY + i * 60_000),
      submittedAt: at(400 * DAY + i * 60_000),
    })) as never,
  );

  /*
   * Выборка по версиям. Первая — двенадцать: для перцентиля довольно, для
   * приведения и SD (порог 30) — нет. Вторая — доли, третья — уже T-баллы:
   * нормировку сменили вместе с версией. У первой и третьей — ответы, из
   * которых считается альфа.
   */
  for (let i = 0; i < 12; i++) {
    const latent = 0.15 + 0.7 * rand();
    await measure({ who: pop, version: 1, value: Math.round(latent * 100) / 100, at: at(60 * DAY - i * 60_000), latent });
  }
  for (let i = 0; i < 35; i++) {
    await measure({ who: pop, version: 2, value: Math.round((0.2 + 0.6 * rand()) * 100) / 100, at: at(40 * DAY - i * 60_000) });
  }
  for (let i = 0; i < 35; i++) {
    const latent = 0.1 + 0.8 * rand();
    await measure({ who: pop, version: 3, value: Math.round(30 + 40 * latent), normalization: "tscore", at: at(20 * DAY - i * 60_000), latent });
  }

  // P: три версии, у первой приведения нет (мала выборка), у второй — есть
  await measure({ who: people.P, version: 1, value: 0.25, at: at(3 * DAY) });
  await measure({ who: people.P, version: 2, value: 0.6, at: at(2 * DAY) });
  await measure({ who: people.P, version: 3, value: 58, normalization: "tscore", at: at(1 * DAY) });
  // Q: вторая → третья, приводится
  await measure({ who: people.Q, version: 2, value: 0.35, at: at(2 * DAY) });
  await measure({ who: people.Q, version: 3, value: 60, normalization: "tscore", at: at(1 * DAY) });
  // R: одна версия, но первый замер без норм (сырой), второй — T-балл
  await measure({ who: people.R, version: 3, value: 20, normalization: "tscore", normalized: false, at: at(2 * DAY) });
  await measure({ who: people.R, version: 3, value: 55, normalization: "tscore", at: at(1 * DAY) });
  // U: одна версия и одни единицы, но первый протокол недостоверен
  await measure({ who: people.U, version: 3, value: 45, normalization: "tscore", reliable: false, at: at(2 * DAY) });
  await measure({ who: people.U, version: 3, value: 62, normalization: "tscore", at: at(1 * DAY) });
  // V: две точки первой версии — сравнимы, но выборка версии меньше тридцати
  await measure({ who: people.V, version: 1, value: 0.2, at: at(2 * DAY) });
  await measure({ who: people.V, version: 1, value: 0.7, at: at(1 * DAY) });
}, 120_000);

describe("изменение считается только между сравнимыми концами", () => {
  test("три версии: вторая приводится, первая — нет, и первая с последней не сравниваются", async () => {
    const sc = await dynamicsOf(people.P);
    // приведение 2 → 3 есть, 1 → 3 — нет: выборка первой версии меньше порога
    expect(sc.equated?.map((e) => e.fromVersion)).toEqual([2]);
    expect(sc.delta, "первая точка вычтена из последней неприведённой").toBeNull();
    expect(sc.reliableChange).toBeNull();
    expect(sc.incomparable).toBe("version");
    // сами точки на месте: ряд рисуется, не считается только разность
    expect(sc.points.map((p) => p.versionNo)).toEqual([1, 2, 3]);
  });

  test("две версии с приведением: разность в единицах последней, RCI по её выборке и её альфе", async () => {
    const sc = await dynamicsOf(people.Q);
    expect(sc.incomparable ?? null).toBeNull();

    const v2 = await bucket(2, "ratio");
    const v3 = await bucket(3, "tscore");
    const slope = sd(v3) / sd(v2);
    const intercept = mean(v3) - slope * mean(v2);
    expect(sc.delta).toBe(Math.round((60 - (slope * 0.35 + intercept)) * 100) / 100);

    /*
     * Выборка для SD — только третья версия в T-баллах. Прежде она была
     * смесью долей и T-баллов всех версий: SD «между единицами», а не между
     * людьми. И альфа есть: она теперь третьей версии и по свежим
     * прохождениям, а не по тремстам старым первой.
     */
    expect(sc.reliableChange, "RCI не посчитан — нет альфы версии или выборки").not.toBeNull();
    expect(sc.reliableChange!.basis.sampleN).toBe(v3.length);
    expect(sc.reliableChange!.basis.sd).toBeCloseTo(sd(v3), 2);
  });

  test("перцентиль — среди своих: T-балл среди T-баллов своей версии, а не среди долей", async () => {
    const sc = await dynamicsOf(people.Q);
    const last = sc.points[sc.points.length - 1]!;
    expect(last.percentile).toBe(percentileOf(60, await bucket(3, "tscore")));
    const first = sc.points[0]!;
    expect(first.percentile).toBe(percentileOf(0.35, await bucket(2, "ratio")));
  });

  test("сырой балл без норм и T-балл той же версии — units, и перцентиля у сырого нет", async () => {
    const sc = await dynamicsOf(people.R);
    expect(sc.incomparable).toBe("units");
    expect(sc.delta).toBeNull();
    expect(sc.reliableChange).toBeNull();
    expect(sc.points[0]!.normalized).toBe(false);
    expect(sc.points[0]!.percentile).toBeNull();
  });

  test("недостоверный протокол не служит базой сравнения", async () => {
    const sc = await dynamicsOf(people.U);
    expect(sc.incomparable).toBe("unreliable");
    expect(sc.delta).toBeNull();
    expect(sc.reliableChange).toBeNull();
    expect(sc.points[0]!.reliable).toBe(false);
  });

  test("RCI — только от общего порога выборки (30), а не от десяти наблюдений", async () => {
    const sc = await dynamicsOf(people.V);
    // сравнимы: одна версия, одни единицы — разность есть
    expect(sc.incomparable ?? null).toBeNull();
    expect(sc.delta).toBe(0.5);
    // но выборка первой версии меньше тридцати: SD — шум, RCI и полосы ошибки нет
    expect((await bucket(1, "ratio")).length).toBeLessThan(30);
    expect((await bucket(1, "ratio")).length).toBeGreaterThanOrEqual(10);
    expect(sc.reliableChange).toBeNull();
    expect(sc.sem ?? null).toBeNull();
  });
});

describe("сводка случая считает тем же правилом и той же надёжностью", () => {
  test("RCI сводки совпадает с RCI динамики — альфа фактическая, не 0,8", async () => {
    const dyn = await dynamicsOf(people.Q);
    const sum = await summaryOf(people.Q);
    expect(sum?.reliableChange).not.toBeNull();
    expect(sum!.reliableChange!.rci).toBe(dyn.reliableChange!.rci);
    expect(sum!.reliableChange!.significant).toBe(dyn.reliableChange!.significant);
  });

  test("несравнимые концы — и в сводке прочерк с причиной", async () => {
    expect((await summaryOf(people.P))?.incomparable).toBe("version");
    expect((await summaryOf(people.R))?.incomparable).toBe("units");
    expect((await summaryOf(people.U))?.incomparable).toBe("unreliable");
    for (const k of ["P", "R", "U"] as const) expect((await summaryOf(people[k]))?.reliableChange).toBeNull();
  });
});

describe("сторож посева", () => {
  test("у третьей версии ответы есть, у старых прохождений первой — нет", async () => {
    const [row] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from answers a join responses r on r.id = a.response_id
      where r.survey_id = ${surveyId} and r.version_id = ${versionIds[2]!}
    `);
    expect(Number(row?.n ?? 0)).toBeGreaterThan(0);
  });
});
