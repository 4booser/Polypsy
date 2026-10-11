import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, inArray } from "drizzle-orm";
import { adminA, appApi, appRequest, client, createSurveySchema, createVersion, db, eq, groupA, makeUser, surveys } from "./fixtures";
import { responseScores, responses, scales } from "../src/db/schema";
import { MIGRATIONS_FOLDER } from "../src/db/migrations";
import { MIN_NORM_SAMPLE } from "../src/lib/norms";
import { minimult } from "../src/instruments/minimult";
import { mlo } from "../src/instruments/mlo";

/**
 * Процент и «бал з максимуму» — от балла после поправок (#133).
 *
 * ЛАП МЛО — сумма ПР + КП + МН поправками, своих пунктов у неё нет: сырой
 * балл 0, максимум по пунктам 0, и лист печатал «0 з 0 · 0 % · 50-й
 * перцентиль» у любого человека. У Мини-мульта с K-поправкой процент уходил
 * за сто (Pt, Se). Подсчёт общий (packages/shared, scaleMaxScore); здесь —
 * что пишет сдача, что печатает лист и что делает миграция 0126 со старыми
 * строками. Сдают пациенты ролью приложения, лист открывает специалист.
 */

const LAP_TITLE = "Особистісний адаптаційний потенціал (ОАП)";
const mloId = crypto.randomUUID();
const mmId = crypto.randomUUID();
const people: string[] = [];
/** Сдачи МЛО: id прохождения → балл ЛАП после поправок */
const lapOf = new Map<string, number>();

async function install(id: string, draft: unknown, title: string) {
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: title, ru: title, en: title },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(draft), adminA.id, "v1");
}

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };

/** Детерминированные ответы «так» с долей share; «так» — первый вариант у обеих методик */
function yesNoAnswers(shown: Loaded, seed: number, share: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  return shown.questions.map((q) => ({
    questionId: q.id,
    optionIds: [q.options[next() < share ? 0 : 1]!.id],
    durationMs: 1500,
    changeCount: 0,
    visitCount: 1,
  }));
}

async function submit(surveyId: string, seed: number, share: number): Promise<string> {
  const p = await makeUser("user", `cmax-${crypto.randomUUID().slice(0, 8)}@test.dev`, { sex: "male", birthDate: "1990-02-02" });
  people.push(p.id);
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, p.token)).body;
  const res = await appApi(`/api/surveys/${surveyId}/responses`, p.token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      durationMs: 600_000,
      events: [],
      versionId: shown.versionId,
      answers: yesNoAnswers(shown, seed, share),
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function rowsOf(responseId: string) {
  return db
    .select({
      id: responseScores.id,
      code: scales.code,
      raw: responseScores.rawScore,
      corrected: responseScores.correctedScore,
      max: responseScores.maxScore,
      percent: responseScores.percent,
    })
    .from(responseScores)
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(eq(responseScores.responseId, responseId));
}

/** Ячейки строки шкалы в печатном листе: бал з максимуму, процент, полоса, перцентиль */
async function sheetRow(responseId: string, title: string): Promise<string[]> {
  const res = await appRequest(`/api/reports/responses/${responseId}`, {
    headers: { Authorization: `Bearer ${adminA.token}`, "Accept-Language": "uk" },
  });
  const html = await res.text();
  expect(res.status, html.slice(0, 300)).toBe(200);
  const row = html.match(new RegExp(`<tr>\\s*<td>${title.replace(/[()]/g, "\\$&")}</td>([\\s\\S]*?)</tr>`))?.[1] ?? "";
  return [...row.matchAll(/<td(?: class="num")?>([\s\S]*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());
}

beforeAll(async () => {
  await install(mloId, mlo, `МЛО ${mloId.slice(0, 8)}`);
  await install(mmId, minimult, `Міні-мульт ${mmId.slice(0, 8)}`);
  // выборка МЛО: четырнадцать человек с разной долей «так» — разная ЛАП
  for (let i = 0; i < 14; i++) {
    const id = await submit(mloId, 100 + i, 0.25 + (i % 7) * 0.08);
    const lap = (await rowsOf(id)).find((r) => r.code === "LAP");
    if (lap) lapOf.set(id, lap.corrected ?? lap.raw);
  }
}, 120_000);

afterAll(async () => {
  // свои методики — не в общих списках соседних файлов
  await db.update(surveys).set({ status: "closed" }).where(inArray(surveys.id, [mloId, mmId]));
});

describe("максимум и процент шкал с поправками (#133)", () => {
  test("ЛАП МЛО: максимум 152 (96 + 32 + 24), балл — сумма ПР, КП и МН, процент в пределах", async () => {
    const [id] = [...lapOf.keys()];
    const rows = await rowsOf(id!);
    const by = (code: string) => rows.find((r) => r.code === code)!;
    const lap = by("LAP");
    expect(lap.max).toBe(152);
    expect(lap.corrected).toBe(by("PR").raw + by("KP").raw + by("MN").raw);
    expect(lap.percent).toBe(Math.round((lap.corrected! / 152) * 1000) / 10);
    expect(lap.percent).toBeGreaterThan(0);
    expect(lap.percent).toBeLessThanOrEqual(100);
  }, 30_000);

  test("Мини-мульт: у шкал с K-поправкой процент не выше ста при любой доле «так»", async () => {
    for (const share of [0, 0.3, 0.7, 1]) {
      const id = await submit(mmId, 7, share);
      for (const r of await rowsOf(id)) {
        expect(r.percent, `${r.code} при доле «так» ${share}: ${r.corrected} из ${r.max}`).toBeLessThanOrEqual(100);
        expect(r.percent).toBeGreaterThanOrEqual(0);
        expect(r.corrected!).toBeLessThanOrEqual(r.max);
      }
    }
  }, 30_000);

  test("лист: строка ЛАП — «бал з 152» и процент, а не «0 з 0 · 0 %»", async () => {
    const [id] = [...lapOf.keys()];
    const [scoreOf, percent] = await sheetRow(id!, LAP_TITLE);
    expect(scoreOf).toBe(`${lapOf.get(id!)} з 152`);
    expect(percent).not.toBe("0%");
  }, 30_000);

  test("лист: перцентиль ЛАП различается по баллам", async () => {
    const reliable = await db
      .select({ id: responses.id })
      .from(responses)
      .where(and(eq(responses.surveyId, mloId), eq(responses.reliable, true)));
    expect(reliable.length, "в выборке меньше людей, чем нужно для перцентиля").toBeGreaterThanOrEqual(MIN_NORM_SAMPLE);
    const sorted = [...lapOf.entries()].sort((a, b) => a[1] - b[1]);
    const low = sorted[0]!;
    const high = sorted.at(-1)!;
    expect(high[1]).toBeGreaterThan(low[1]);
    const lowCell = (await sheetRow(low[0], LAP_TITLE)).at(-1);
    const highCell = (await sheetRow(high[0], LAP_TITLE)).at(-1);
    expect(lowCell, "перцентиль не напечатан").not.toBe("—");
    expect(highCell, `ЛАП ${low[1]} и ${high[1]} — один перцентиль`).not.toBe(lowCell);
  }, 30_000);
});

describe("миграция 0126: строки, записанные прежним движком", () => {
  const sql = readFileSync(join(MIGRATIONS_FOLDER, "0126_corrected_max.sql"), "utf8");

  test("максимум, процент и балл после поправок — как у нынешнего движка; повторный прогон ничего не меняет", async () => {
    const [mloResponse] = [...lapOf.keys()];
    const mmResponse = await submit(mmId, 11, 0.6);
    const ids = [mloResponse!, mmResponse];
    const now = async () => (await Promise.all(ids.map(rowsOf))).flat().sort((a, b) => a.id.localeCompare(b.id));
    const engine = await now();

    /*
     * Как записал бы прежний движок: максимум — по пунктам ключа (у ЛАП 0),
     * процент — от него, балла после поправок нет (строки до 0118).
     */
    const rawMax: Record<string, number> = { LAP: 0, Hs: 14, Pd: 19, Pt: 16, Se: 20, Ma: 12 };
    for (const r of engine) {
      if (!(r.code in rawMax)) continue;
      const max = rawMax[r.code]!;
      await db
        .update(responseScores)
        .set({
          maxScore: max,
          percent: max > 0 ? Math.round((r.corrected! / max) * 1000) / 10 : 0,
          correctedScore: null,
        })
        .where(eq(responseScores.id, r.id));
    }
    const old = await now();
    expect(old.find((r) => r.code === "LAP")).toMatchObject({ max: 0, percent: 0, corrected: null });

    await client.unsafe(sql);
    expect(await now()).toEqual(engine);
    await client.unsafe(sql);
    expect(await now(), "повторный прогон изменил строки").toEqual(engine);
  }, 30_000);
});
