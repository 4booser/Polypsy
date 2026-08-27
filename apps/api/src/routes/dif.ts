import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import {
  itemContribution,
  mantelHaenszel,
  quantile,
  type MhResult,
  type MhStratum,
} from "@quizzy/shared";
import { db } from "../db";
import { answers, responseScores, responses, } from "../db/schema";
import { audit } from "../lib/audit";
import { notFound } from "../lib/http";
import { reliabilityOf } from "../lib/psychometrics";
import { assertSurveyAccess } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";
import { cached } from "../lib/analyticsCache";

export const difRoutes = new Hono<AppEnv>();

difRoutes.use("*", requireAuth, requireStaff);

/** Меньше — MH не считаем вовсе; 50–199 — «предварительно» (α=0.2) */
const MIN_GROUP = 50;
const SOLID_GROUP = 200;
/** χ²-критики: p<0.05 и p<0.2 при df=1 */
const CHI2_STRICT = 3.84;
const CHI2_LOOSE = 1.64;

interface PersonRow {
  responseId: string;
  group: string;
  total: number;
  /** questionId → 1 если ответ по ключу */
  hits: Map<string, 0 | 1>;
}

/**
 * Страты по критерию сопоставления: до 5 квантильных корзин.
 *
 * Критерий — REST-SCORE: суммарный балл МИНУС изучаемый пункт. Если оставить
 * пункт в критерии, он загрязняет стратификацию и маскирует сам себя: группа,
 * которая чаще отвечает по ключу, автоматически уезжает в верхние страты, и
 * различие исчезает. Это стандартная «очистка» DIF-анализа, и без неё метод
 * систематически недооценивает эффект.
 */
function buildStrata(people: PersonRow[], questionId: string, refGroup: string): MhStratum[] {
  const restOf = (p: PersonRow) => p.total - (p.hits.get(questionId) ?? 0);
  const totals = people.map(restOf);
  const cuts = [0.2, 0.4, 0.6, 0.8]
    .map((q) => quantile(totals, q))
    .filter((v): v is number => v !== null);
  const binOf = (t: number) => cuts.filter((c) => t > c).length;

  const bins = new Map<number, MhStratum>();
  for (const p of people) {
    const hit = p.hits.get(questionId);
    if (hit === undefined) continue;
    const b = binOf(restOf(p));
    const cell = bins.get(b) ?? { refYes: 0, refNo: 0, focalYes: 0, focalNo: 0 };
    if (p.group === refGroup) {
      if (hit) cell.refYes++;
      else cell.refNo++;
    } else if (hit) cell.focalYes++;
    else cell.focalNo++;
    bins.set(b, cell);
  }
  return [...bins.values()];
}

interface DifEntry {
  factor: "sex" | "age" | "lang";
  reference: string;
  focal: string;
  refN: number;
  focalN: number;
  result: MhResult | null;
  /** Группы 50–199: значимость по мягкому критерию, трактовать осторожно */
  preliminary: boolean;
}

/**
 * DIF по Mantel–Haenszel (5.2): работает ли пункт одинаково у людей с
 * одинаковым уровнем черты, но разного пола / возраста / языка предъявления.
 *
 * Класс C — не приговор пункту, а сигнал на клинический разбор формулировки.
 */
difRoutes.get("/surveys/:id", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  // DIF считает MH по каждому пункту × 3 фактора — самый дорогой срез.
  // Кэшируем ДАННЫЕ, а не Response: тело ответа одноразово, и повторная
  // отдача того же объекта вернула бы пустоту
  const data = await cached(surveyId, "dif", () => buildDif(c, surveyId));
  return c.json(data);
});

async function buildDif(c: Context<AppEnv>, surveyId: string) {
  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("Методика не найдена");

  // последние 500 завершённых: страты и ключевые попадания
  const responseRows = await db
    .select()
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")))
    .limit(500);
  const ids = responseRows.map((r) => r.id);
  const [answerRows, scoreRows] = ids.length
    ? await Promise.all([
        db.select().from(answers).where(inArray(answers.responseId, ids)),
        db
          .select({ responseId: responseScores.responseId, scaleId: responseScores.scaleId, raw: responseScores.rawScore })
          .from(responseScores)
          .where(inArray(responseScores.responseId, ids)),
      ])
    : [[], []];

  const answerByResponse = new Map<string, Map<string, (typeof answerRows)[number]>>();
  for (const a of answerRows) {
    const m = answerByResponse.get(a.responseId) ?? new Map();
    m.set(a.questionId, a);
    answerByResponse.set(a.responseId, m);
  }
  const questionById = new Map(survey.questions.map((q) => [q.id, q]));

  const factors: { factor: DifEntry["factor"]; of: (r: (typeof responseRows)[number]) => string | null }[] = [
    { factor: "sex", of: (r) => r.respondentSex },
    // возраст — бинарно: тонкие полосы при наших n дадут пустые страты
    { factor: "age", of: (r) => (r.respondentAgeBand ? (r.respondentAgeBand === "<25" || r.respondentAgeBand === "25-34" ? "до 35" : "35+") : null) },
    { factor: "lang", of: (r) => r.lang },
  ];

  const result = survey.scales
    .filter((s) => s.kind === "clinical" && s.items.some((i) => i.matchKey !== null))
    .map((scale) => {
      const rawOf = new Map(
        scoreRows.filter((s) => s.scaleId === scale.id).map((s) => [s.responseId, s.raw]),
      );

      const peopleFor = (of: (r: (typeof responseRows)[number]) => string | null): PersonRow[] =>
        responseRows.flatMap((r) => {
          const group = of(r);
          const total = rawOf.get(r.id);
          if (!group || total === undefined) return [];
          const hits = new Map<string, 0 | 1>();
          const byQ = answerByResponse.get(r.id);
          if (!byQ) return [];
          for (const item of scale.items) {
            if (item.matchKey === null) continue;
            const q = questionById.get(item.questionId);
            const stored = byQ.get(item.questionId);
            if (!q || !stored) continue;
            const v = itemContribution(q, item, {
              questionId: item.questionId,
              optionIds: stored.optionIds ?? undefined,
              matrix: stored.matrix ?? undefined,
              skipped: stored.skipped,
            });
            if (v !== null) hits.set(item.questionId, v > 0 ? 1 : 0);
          }
          // критерий в тех же единицах, что и попадания: сумма ответов по
          // ключу этой шкалы, а не сырой балл (он мог быть скорректирован)
          const keyTotal = [...hits.values()].reduce<number>((sum, v) => sum + v, 0);
          return [{ responseId: r.id, group, total: keyTotal, hits }];
        });

      const items = scale.items
        .filter((i) => i.matchKey !== null)
        .map((item) => {
          const q = questionById.get(item.questionId);
          const entries: DifEntry[] = [];

          for (const f of factors) {
            const people = peopleFor(f.of);
            const groups = [...new Set(people.map((p) => p.group))];
            if (groups.length !== 2) continue;
            // референс — большая группа: устойчивее оценка
            const counts = groups.map((g) => people.filter((p) => p.group === g).length);
            const [refGroup, focalGroup] =
              counts[0]! >= counts[1]! ? [groups[0]!, groups[1]!] : [groups[1]!, groups[0]!];
            const refN = people.filter((p) => p.group === refGroup).length;
            const focalN = people.filter((p) => p.group === focalGroup).length;
            if (Math.min(refN, focalN) < MIN_GROUP) continue; // честно не считаем

            const preliminary = Math.min(refN, focalN) < SOLID_GROUP;
            const mh = mantelHaenszel(buildStrata(people, item.questionId, refGroup));
            const adjusted =
              mh === null
                ? null
                : {
                    ...mh,
                    significant: mh.chi2 > (preliminary ? CHI2_LOOSE : CHI2_STRICT),
                    etsClass:
                      Math.abs(mh.deltaMH) < 1 || mh.chi2 <= (preliminary ? CHI2_LOOSE : CHI2_STRICT)
                        ? ("A" as const)
                        : Math.abs(mh.deltaMH) > 1.5
                          ? ("C" as const)
                          : ("B" as const),
                  };
            entries.push({ factor: f.factor, reference: refGroup, focal: focalGroup, refN, focalN, result: adjusted, preliminary });
          }

          return {
            questionId: item.questionId,
            position: (q?.position ?? 0) + 1,
            title: q?.title ?? "—",
            entries,
          };
        })
        .filter((i) => i.entries.length > 0);

      return { code: scale.code, title: scale.title, items };
    })
    .filter((s) => s.items.length > 0);

  /* ── 5.4: инвариантность надёжности по группам ── */
  const reliabilityByGroup = survey.scales
    .filter((s) => s.kind === "clinical" && s.items.length >= 2)
    .map((scale) => {
      const groups: { group: string; n: number; alpha: number | null }[] = [];
      for (const sex of ["male", "female"] as const) {
        const subset = responseRows.filter((r) => r.respondentSex === sex);
        if (subset.length < 30) continue;
        const matrix = new Map<string, Map<string, number>>();
        for (const r of subset) {
          const byQ = answerByResponse.get(r.id);
          if (!byQ) continue;
          const row = new Map<string, number>();
          for (const item of scale.items) {
            const q = questionById.get(item.questionId);
            const stored = byQ.get(item.questionId);
            if (!q || !stored) continue;
            const v = itemContribution(q, item, {
              questionId: item.questionId,
              optionIds: stored.optionIds ?? undefined,
              matrix: stored.matrix ?? undefined,
              skipped: stored.skipped,
            });
            if (v !== null) row.set(item.questionId, v);
          }
          if (row.size) matrix.set(r.id, row);
        }
        const rel = reliabilityOf(
          scale.items.map((i) => questionById.get(i.questionId)).filter((q): q is NonNullable<typeof q> => !!q),
          matrix,
        );
        groups.push({ group: sex === "male" ? "мужчины" : "женщины", n: subset.length, alpha: rel?.alpha ?? null });
      }
      const alphas = groups.map((g) => g.alpha).filter((a): a is number => a !== null);
      const spread = alphas.length >= 2 ? Math.round((Math.max(...alphas) - Math.min(...alphas)) * 1000) / 1000 : null;
      return { code: scale.code, title: scale.title, groups, alphaSpread: spread };
    })
    .filter((s) => s.groups.length > 0);

  await audit(c, {
    action: "analytics.dif",
    resourceType: "survey",
    resourceId: surveyId,
    details: { scales: result.length, sample: responseRows.length },
  });

  return {
    surveyId,
    title: survey.title,
    sample: responseRows.length,
    minGroup: MIN_GROUP,
    solidGroup: SOLID_GROUP,
    scales: result,
    reliability: reliabilityByGroup,
  };
}
