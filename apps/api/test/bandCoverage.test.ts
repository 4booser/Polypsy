import { beforeAll, describe, expect, test } from "bun:test";
import {
  bandFor,
  createSurveySchema,
  itemContribution,
  scaleMaxScore,
  type Answer,
  type CreateSurveyDraft,
  type Question,
  type Scale,
  type ScaleItem,
  type SurveyFull,
} from "@quizzy/shared";
import { createVersion, db, root, surveys } from "./fixtures";
import { surveyGroups } from "../src/db/schema";
import { getSurvey } from "../src/lib/surveys";
import { CATALOG } from "../src/instruments/catalog";
import { minimult } from "../src/instruments/minimult";
import { mlo } from "../src/instruments/mlo";
import { sadPersons } from "../src/instruments/sadPersons";
import { sr45 } from "../src/instruments/sr45";

/**
 * Каждое достижимое значение каждой шкалы попадает в полосу (волна 12, engine).
 *
 * Клиническое ревью нашло дыру у СР-45: Sr = 26 из 35 = 0,743 лежит между
 * «0,60–0,74» и «0,75–1», и у человека в группе суицидального риска не было
 * ни полосы, ни тревоги. Ревьюер нашёл одну — этот тест стережёт все:
 * встроенные методики и весь каталог, установленные настоящим путём
 * (createVersion → getSurvey, как при посеве и установке), каждая шкала с
 * полосами, каждая страта норм.
 *
 * Достижимые значения перебираются по ответам, а не по диапазону: для
 * каждого пункта — все его возможные ответы (и пропуск, если пункт можно не
 * заполнить или он скрыт условием), дальше — агрегация, поправки и
 * нормировка теми же функциями движка. Поправки комбинируются как
 * независимые — это надмножество достижимого, а значит, проверка строже,
 * чем нужно, но не слабее.
 */

const tag = crypto.randomUUID().slice(0, 8);
const group = crypto.randomUUID();

const INSTRUMENTS: [string, CreateSurveyDraft][] = [
  ["sr45", sr45],
  ["sad-persons", sadPersons],
  ["minimult", minimult],
  ["mlo", mlo],
  ...CATALOG.map((e): [string, CreateSurveyDraft] => [e.key, e.draft]),
];

const installed = new Map<string, SurveyFull>();

beforeAll(async () => {
  await db.insert(surveyGroups).values({ id: group, title: `Покриття смуг ${tag}`, createdBy: root.id });
  for (const [key, draft] of INSTRUMENTS) {
    const input = createSurveySchema.parse(draft);
    const id = crypto.randomUUID();
    await db.insert(surveys).values({
      id,
      groupId: group,
      title: { uk: `Покриття ${key} ${tag}` },
      administration: input.administration ?? "self",
      status: "draft",
      scoringEnabled: true,
      createdBy: root.id,
    } as never);
    await createVersion(id, input, root.id, "покриття смуг");
    installed.set(key, (await getSurvey(id, null, "uk"))!);
  }
}, 60_000);

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

/** Все ответы, которые можно дать на пункт */
function possibleAnswers(q: Question): Answer[] {
  const choices = q.options.filter((o) => o.kind === "option");
  switch (q.type) {
    case "single":
    case "yesno":
      return choices.map((o) => ({ questionId: q.id, optionIds: [o.id] }));
    case "multiple": {
      const out: Answer[] = [];
      for (let mask = 1; mask < 1 << Math.min(choices.length, 12); mask++) {
        out.push({ questionId: q.id, optionIds: choices.filter((_, i) => mask & (1 << i)).map((o) => o.id) });
      }
      return out;
    }
    case "matrix": {
      const rows = q.options.filter((o) => o.kind === "row");
      let combos: Record<string, string>[] = [{}];
      for (const row of rows) combos = combos.flatMap((m) => choices.map((o) => ({ ...m, [row.id]: o.id })));
      return combos.map((matrix) => ({ questionId: q.id, matrix }));
    }
    case "scale":
    case "slider":
    case "number": {
      const out: Answer[] = [];
      const step = q.step ?? 1;
      for (let v = q.minValue ?? 0; v <= (q.maxValue ?? 0) + 1e-9; v += step) {
        out.push({ questionId: q.id, number: round(v, 6) });
      }
      return out;
    }
    default:
      return [];
  }
}

/** Вклады пункта в шкалу; null — пункт без ответа (можно пропустить или скрыт условием) */
function contributions(q: Question, item: ScaleItem): (number | null)[] {
  const values = new Set<number>();
  for (const a of possibleAnswers(q)) {
    const c = itemContribution(q, item, a);
    if (c !== null) values.add(round(c, 6));
  }
  const skippable = !q.required || q.logic.length > 0;
  return [...values, ...(skippable ? [null] : [])];
}

/** Достижимые сырые баллы шкалы — так же, как их складывает computeProfile */
function rawValues(survey: SurveyFull, scale: Scale): number[] {
  const byId = new Map(survey.questions.map((q) => [q.id, q]));
  // состояние: «сумма|число ответов»
  let states = new Set(["0|0"]);
  for (const item of scale.items) {
    const q = byId.get(item.questionId);
    if (!q) continue;
    const options = contributions(q, item);
    const next = new Set<string>();
    for (const s of states) {
      const [sum, n] = s.split("|").map(Number) as [number, number];
      for (const c of options) {
        if (c === null) next.add(s);
        else if (scale.aggregation === "count") next.add(`${sum + (c > 0 ? 1 : 0)}|${n + 1}`);
        else next.add(`${round(sum + c, 6)}|${n + 1}`);
      }
    }
    states = next;
  }
  const values = new Set<number>();
  for (const s of states) {
    const [sum, n] = s.split("|").map(Number) as [number, number];
    const value = scale.aggregation === "average" ? (n ? sum / n : 0) : sum;
    values.add(round(value, 3));
  }
  return [...values];
}

interface Gap {
  scale: string;
  stratum: string;
  value: number;
}

function gapsOf(survey: SurveyFull): Gap[] {
  const raw = new Map(survey.scales.map((s) => [s.code, rawValues(survey, s)]));
  const gaps: Gap[] = [];

  for (const scale of survey.scales) {
    if (!scale.bands.length) continue;

    // поправки — надмножество: каждая комбинация сырых баллов источников
    let corrected = new Set(raw.get(scale.code)!);
    for (const correction of scale.corrections) {
      const source = raw.get(correction.sourceScaleCode) ?? [0];
      const next = new Set<number>();
      for (const c of corrected) for (const s of source) next.add(round(c + s * correction.coefficient, 3));
      corrected = next;
    }

    const check = (stratum: string, value: number) => {
      if (!bandFor(scale.bands, value)) gaps.push({ scale: scale.code, stratum, value });
    };

    for (const c of corrected) {
      if (scale.normalization === "raw") check("—", c);
      else if (scale.normalization === "ratio") {
        const maxScore = Math.round(scaleMaxScore(scale, survey.questions) * 100) / 100;
        const denominator = scale.ratioDenominator ?? maxScore;
        if (denominator > 0) check("—", round(c / denominator, 3));
      } else if (scale.normalization === "tscore") {
        for (const norm of scale.norms) {
          if (norm.sd <= 0) continue;
          const stratum = `${norm.sex ?? "*"} ${norm.ageMin ?? ""}–${norm.ageMax ?? ""}`;
          check(stratum, round(50 + (10 * (c - norm.mean)) / norm.sd, 1));
        }
      } else if (scale.normalization === "sten") {
        const strata = new Map<string, typeof scale.stenTable>();
        for (const row of scale.stenTable) {
          const key = `${row.sex ?? "*"} ${row.ageMin ?? ""}–${row.ageMax ?? ""}`;
          strata.set(key, [...(strata.get(key) ?? []), row]);
        }
        for (const [stratum, rows] of strata) {
          const row = rows.find((r) => c >= r.rawMin && c <= r.rawMax);
          // сырой балл вне таблицы стенов — та же дыра: нормы нет, полосы нет
          if (!row) gaps.push({ scale: scale.code, stratum: `${stratum} (вне таблицы стенов)`, value: c });
          else check(stratum, row.sten);
        }
      }
    }
  }
  return gaps;
}

describe("полосы покрывают все достижимые значения", () => {
  for (const [key] of INSTRUMENTS) {
    test(key, () => {
      const survey = installed.get(key)!;
      expect(survey, `${key}: методика не установилась`).toBeDefined();
      const gaps = gapsOf(survey);
      const shown = gaps.slice(0, 12).map((g) => `${g.scale} [${g.stratum}] = ${g.value}`);
      expect(shown, `${key}: значения без полосы (${gaps.length})`).toEqual([]);
    });
  }
});
