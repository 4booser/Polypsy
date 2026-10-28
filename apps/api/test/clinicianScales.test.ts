import { beforeAll, describe, expect, test } from "bun:test";
import { api, db, eq, makeUser, root, type Person } from "./fixtures";
import { batteries, batteryItems, riskAlerts, surveys } from "../src/db/schema";
import { installCatalog } from "../src/lib/catalogInstall";

/**
 * Шкалы специалиста каталога (HAM-D-17, HAM-A, CGI-S, CGI-I, BPRS) — настоящим
 * путём: установщик → заполнение специалистом за пациента → балл и полоса →
 * тревоги → динамика пациента. Золотые протоколы (golden-clinician.test.ts)
 * считают описание методики без базы; здесь — то, что видит отделение.
 *
 * Мутации: снять `administration: "clinician"` — пациент сдаёт HAM-D сам, и
 * падает первая проверка; вернуть полосе «Тяжка депресія» тяжесть severe —
 * у сдачи появляется тревога по шкале, и падает проверка тревог.
 */

const tag = crypto.randomUUID().slice(0, 8);
let patient: Person;
const ids = new Map<string, string>();

beforeAll(async () => {
  await installCatalog();
  for (const key of ["hamd17", "hama", "cgi_s", "cgi_i", "bprs"]) {
    const [row] = await db.select({ id: surveys.id }).from(surveys).where(eq(surveys.catalogKey, key));
    expect(row, `«${key}» не установлен`).toBeTruthy();
    ids.set(key, row!.id);
  }
  patient = await makeUser("user", `scales-${tag}@test`, { sex: "male", birthDate: "1990-04-02" });
}, 120_000);

interface KeyedQuestion {
  id: string;
  options: { id: string; score: number }[];
}

/** Ответы по баллам — по вариантам, которые отдаёт сервер (ключ видит суперадмин) */
async function answersByScores(surveyId: string, scores: number[]) {
  const res = await api<{ questions: KeyedQuestion[] }>(`/api/surveys/${surveyId}`, root.token);
  expect(res.status).toBe(200);
  expect(res.body.questions.length).toBe(scores.length);
  return res.body.questions.map((q, i) => {
    const option = q.options.find((o) => o.score === scores[i]);
    if (!option) throw new Error(`пункт ${i + 1}: нет варианта с баллом ${scores[i]}`);
    return { questionId: q.id, optionIds: [option.id], durationMs: 1500, changeCount: 0, visitCount: 1 };
  });
}

async function fillFor(key: string, scores: number[], token = root.token, onBehalfOf: string | null = patient.id) {
  const surveyId = ids.get(key)!;
  return api(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      ...(onBehalfOf ? { onBehalfOf } : {}),
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      durationMs: 600_000,
      events: [],
      answers: await answersByScores(surveyId, scores),
    }),
  });
}

describe("шкалы специалиста каталога: заполнение, тревоги, динамика", () => {
  test("ставятся как оценка специалиста: пациент сам их не сдаёт", async () => {
    for (const key of ids.keys()) {
      const [row] = await db.select().from(surveys).where(eq(surveys.catalogKey, key));
      expect(row!.administration, key).toBe("clinician");
      expect(row!.status, key).toBe("published");
    }
    const own = await fillFor("cgi_s", [4], patient.token, null);
    expect(own.status).toBe(403);
  });

  test("HAM-D-17 за пациента: сумма и полоса; тяжёлая тревога — от пункта 3, тревоги по шкале нет", async () => {
    // 3+2+3+2+2+2+3+2+2+3+2+1+2+1+2+1+1 = 34 — тяжёлая депрессия; пункт 3 = 3
    const res = await fillFor("hamd17", [3, 2, 3, 2, 2, 2, 3, 2, 2, 3, 2, 1, 2, 1, 2, 1, 1]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const score = res.body.scores.find((s: { scaleCode: string }) => s.scaleCode === "HAMD");
    expect(score.rawScore).toBe(34);
    expect(score.band.label).toBe("Тяжка депресія");

    const alerts = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id));
    expect(alerts.map((a) => a.severity)).toEqual(["severe"]);
    expect(alerts[0]!.questionId, "тревога должна быть по пункту, а не по полосе").not.toBeNull();
    expect(alerts[0]!.scaleId).toBeNull();
  });

  test("HAM-A, CGI-S, CGI-I и BPRS за пациента: балл есть, тревог нет даже в верхних полосах", async () => {
    const cases: [string, number[], string, number][] = [
      ["hama", [3, 3, 2, 3, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2], "HAMA", 30],
      ["cgi_s", [6], "CGIS", 6],
      ["cgi_i", [6], "CGII", 6],
      ["bprs", [3, 4, 4, 5, 2, 4, 3, 2, 3, 4, 5, 5, 2, 4, 5, 3, 3, 2], "BPRS", 63],
    ];
    for (const [key, scores, code, total] of cases) {
      const res = await fillFor(key, scores);
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(201);
      const score = res.body.scores.find((s: { scaleCode: string }) => s.scaleCode === code);
      expect(score.rawScore, key).toBe(total);
      const alerts = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id));
      expect(alerts, key).toEqual([]);
    }
  });

  test("динамика пациента: второй замер HAM-D даёт изменение от первого", async () => {
    // 1+1+0+1+0+0+1+1+0+1+1+0+1+0+0+0+0 = 8 — лёгкая; пункт 3 = 0
    const second = await fillFor("hamd17", [1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0]);
    expect(second.status).toBe(201);
    const dyn = await api(`/api/dynamics/respondents/${patient.id}?survey=${ids.get("hamd17")}`, root.token);
    expect(dyn.status, JSON.stringify(dyn.body)).toBe(200);
    const hamd = dyn.body.surveys.find((s: { surveyId: string }) => s.surveyId === ids.get("hamd17"));
    const scale = hamd.scales.find((s: { code: string }) => s.code === "HAMD");
    expect(scale.points.map((p: { rawScore: number }) => p.rawScore)).toEqual([34, 8]);
    expect(scale.delta).toBe(-26);
    // полосы приходят графику: лестница «краще ↓» выводится из них
    expect(scale.bands.map((b: { min: number }) => b.min)).toEqual([0, 8, 17, 24]);
  });

  test("набор «Первинний огляд лікаря-психіатра» поставлен: C-SSRS, HAM-D-17, HAM-A, CGI-S — в порядке беседы", async () => {
    const [battery] = await db.select().from(batteries).where(eq(batteries.catalogKey, "psychiatrist-intake"));
    expect(battery, "заготовка не поставлена").toBeTruthy();
    expect(battery!.strictOrder).toBe(false);
    const items = await db.select().from(batteryItems).where(eq(batteryItems.batteryId, battery!.id));
    const keyOf = new Map<string, string>();
    for (const row of await db.select({ id: surveys.id, key: surveys.catalogKey }).from(surveys)) {
      if (row.key) keyOf.set(row.id, row.key);
    }
    const ordered = [...items].sort((a, b) => a.position - b.position).map((i) => keyOf.get(i.surveyId));
    expect(ordered).toEqual(["cssrs", "hamd17", "hama", "cgi_s"]);
  });
});
