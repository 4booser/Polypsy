import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  adminA,
  api,
  appRequest,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  makeUser,
  surveys,
  type Person,
} from "./fixtures";
import { phq9 } from "../src/instruments/phq9";
import { cssString, sevPill, sheetDocument, stepsOfBands } from "../src/lib/printSheet";

/**
 * Печатный лист «Виразной» (UI 3, v2-print): оснастка lib/printSheet.ts и
 * то, что лист прохождения показывает разным людям.
 *
 * Лист читают на монохромном принтере, поэтому выраженность — слово в
 * обводке, а номер страницы — полями страницы @page на языке листа. Шрифт
 * вшит в лист копией подмножеств консоли: копия не должна разойтись с ними.
 */

const ROOT = resolve(import.meta.dir, "../../..");

describe("оснастка листа", () => {
  test("шрифт листа — те же подмножества Manrope, что у консоли", () => {
    for (const file of ["Manrope-latin.woff2", "Manrope-cyrillic.woff2"]) {
      const sheet = readFileSync(join(ROOT, "apps/api/assets/fonts", file));
      const web = readFileSync(join(ROOT, "apps/web/public/fonts", file));
      expect(sheet.equals(web), `${file}: копия листа разошлась с консолью`).toBe(true);
    }
  });

  test("номер страницы — счётчиками CSS и словами языка листа", () => {
    const uk = sheetDocument({ lang: "uk", title: "t", running: "r", body: "" });
    expect(uk).toContain('content:"Сторінка " counter(page) " з " counter(pages)');
    const en = sheetDocument({ lang: "en", title: "t", running: "r", body: "" });
    expect(en).toContain('content:"Page " counter(page) " of " counter(pages)');
    /* шрифт вшит, внешних адресов у листа нет: CSP консоли закрыт */
    expect(uk).toContain("src:url(data:font/woff2;base64,");
    expect(uk).not.toMatch(/https?:\/\//);
  });

  test("строка поля страницы не выходит из CSS и из <style>", () => {
    expect(cssString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(cssString("</style><script>")).not.toContain("<");
  });

  test("выраженность — словом в обводке, у нейтральной полосы тоже", () => {
    expect(sevPill("помірна", 2)).toBe('<span class="ps-sev l2">помірна</span>');
    expect(sevPill("<b>", null)).toBe('<span class="ps-sev ln">&lt;b&gt;</span>');
  });

  test("две тяжёлые полосы подряд различаются: менее крайняя — пятая ступень набора (s3)", () => {
    const phq = ["none", "mild", "moderate", "severe", "severe"].map((severity) => ({ severity }));
    expect(stepsOfBands(phq)).toEqual([0, 1, 2, 3, 4]);
    /* обратная шкала (меньше — хуже): крайняя тяжёлая — нижняя */
    const reversed = ["severe", "severe", "mild", "none"].map((severity) => ({ severity }));
    expect(stepsOfBands(reversed)).toEqual([4, 3, 1, 0]);
    expect(stepsOfBands([{ severity: "moderate" }, { severity: null }])).toEqual([2, null]);
  });
});

/*
 * Лист прохождения одношкальной методики: крупный балл и шкала с прежними
 * замерами. Полосы шкалы — только сотруднику: пороги полос обследуемому не
 * отдаются и в самой методике (#141).
 *
 * Ответы — первым вариантом («зовсім ні»): критических среди них нет, и
 * тревог в общих очередях тест не оставляет. Ролью приложения.
 */
let surveyId = "";
let person: Person;
const responseIds: string[] = [];

async function submitFirstOptions(token: string) {
  const survey = (await api(`/api/surveys/${surveyId}`, token)).body as {
    questions: { id: string; type: string; options: { id: string }[] }[];
  };
  const answers = survey.questions
    .filter((q) => q.type !== "info" && q.options.length)
    .map((q) => ({ questionId: q.id, optionIds: [q.options[0]!.id], durationMs: 2000, changeCount: 0, visitCount: 1 }));
  const res = await api(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    /* начало — после версии методики, иначе сервер не примет заявленное время сдачи и поставит «сейчас» */
    body: JSON.stringify({ startedAt: new Date(Date.now() - 1000).toISOString(), durationMs: 1000, events: [], answers }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: { uk: "Лист PHQ-9", ru: "Лист PHQ-9", en: "Sheet PHQ-9" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    showResultsToPatient: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(surveyId, createSurveySchema.parse(phq9), adminA.id, "print sheet");
  person = await makeUser("user", `print-sheet-${crypto.randomUUID()}@test`, { sex: "female", birthDate: "1990-05-01" });
  responseIds.push(await submitFirstOptions(person.token));
  await Bun.sleep(20);
  responseIds.push(await submitFirstOptions(person.token));
}, 60_000);

afterAll(async () => {
  /* методика своя — не оставляем её в общих списках соседних файлов */
  await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, surveyId));
});

async function sheet(token: string): Promise<string> {
  const res = await appRequest(`/api/reports/responses/${responseIds[1]}`, {
    headers: { Authorization: `Bearer ${token}`, "Accept-Language": "uk" },
  });
  const html = await res.text();
  expect(res.status, html.slice(0, 300)).toBe(200);
  return html;
}

describe("лист прохождения одношкальной методики", () => {
  test("сотрудник: крупный балл, полосы шкалы ступенями набора, прежний замер кольцом", async () => {
    const html = await sheet(adminA.token);
    expect(html).toContain('<div class="ps-res">');
    expect(html).toContain("з 27");
    expect(html).toContain("fill:var(--s0)");
    expect(html).toContain("fill:var(--s4b)");
    expect(html).toContain('class="ring"');
    expect(html).toContain("Заміри");
    expect(html).toContain("0 → 0");
    /* полоса — словом в обводке, а не только цветом */
    expect(html).toMatch(/<span class="ps-sev l0 big">[^<]+<\/span>/);
  });

  test("обследуемый: тот же балл и слово полосы, но без порогов полос", async () => {
    const html = await sheet(person.token);
    expect(html).toContain('<div class="ps-res">');
    expect(html).toContain('class="ps-scale"');
    expect(html).not.toContain("fill:var(--s");
    expect(html).toMatch(/<span class="ps-sev l0 big">[^<]+<\/span>/);
    expect(html).not.toContain("критична відповідь");
  });
});
