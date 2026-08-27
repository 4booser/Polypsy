import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ageAt, createSurveySchema, quantile, type Sex } from "@quizzy/shared";
import { db } from "../db";
import { responseScores, responses, scales, users } from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { badRequest, notFound, parseBody } from "../lib/http";
import { average, round, variance } from "../lib/stats";
import { assertSurveyAccess } from "../lib/scope";
import { createVersion, getSurvey, surveyToDraft } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const normRoutes = new Hono<AppEnv>();

normRoutes.use("*", requireAuth, requireStaff);

/** Ниже этого нормы — шум, а не нормы */
const MIN_GROUP = 30;
/** Ниже этого даже не показываем кандидата */
const MIN_SHOW = 10;

interface CandidateGroup {
  sex: Sex | null;
  n: number;
  mean: number;
  sd: number;
  /** Достаточно ли выборки для публикации */
  publishable: boolean;
}

/**
 * Кандидатные нормы по фактической выборке.
 *
 * Считаются по СКОРРЕКТИРОВАННОМУ сырому баллу (как того требует формула
 * T = 50 + 10(x − M)/SD): raw хранится в response_scores, поправки
 * восстанавливаются по кодам шкал той же версии. Группировка — по полу,
 * как в нормах пособий; возрастные разрезы появятся, когда выборка позволит.
 */
async function candidateStats(surveyId: string) {
  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("Методика не найдена");

  const completed = await db
    .select({ response: responses, sex: users.sex })
    .from(responses)
    .leftJoin(users, eq(users.id, responses.userId))
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")));
  const scoreRows = completed.length
    ? await db
        .select({ score: responseScores, code: scales.code })
        .from(responseScores)
        .innerJoin(scales, eq(scales.id, responseScores.scaleId))
        .where(inArray(responseScores.responseId, completed.map((r) => r.response.id)))
    : [];

  const sexOf = new Map(completed.map((r) => [r.response.id, (r.sex ?? null) as Sex | null]));
  const rawByResponse = new Map<string, Map<string, number>>();
  for (const { score, code } of scoreRows) {
    const m = rawByResponse.get(score.responseId) ?? new Map<string, number>();
    m.set(code, score.rawScore);
    rawByResponse.set(score.responseId, m);
  }

  return survey.scales
    .filter((s) => s.normalization === "tscore")
    .map((scale) => {
      // скорректированный балл: raw + Σ coeff × raw(источник)
      const corrected = new Map<string, number>();
      for (const [responseId, raws] of rawByResponse) {
        const own = raws.get(scale.code);
        if (own === undefined) continue;
        let value = own;
        for (const c of scale.corrections) {
          value += (raws.get(c.sourceScaleCode) ?? 0) * c.coefficient;
        }
        corrected.set(responseId, value);
      }

      const groups: CandidateGroup[] = [];
      for (const sex of ["male", "female", null] as const) {
        const values = [...corrected.entries()]
          .filter(([rid]) => (sex === null ? true : sexOf.get(rid) === sex))
          .map(([, v]) => v);
        if (values.length < MIN_SHOW) continue;
        const sd = round(Math.sqrt(variance(values)));
        groups.push({
          sex,
          n: values.length,
          mean: round(average(values)),
          sd,
          // нулевой разброс — не норма: T-формула делит на SD, а выборка,
          // где все ответили одинаково, ничего не измеряет
          publishable: values.length >= MIN_GROUP && sd > 0,
        });
      }

      return {
        code: scale.code,
        title: scale.title,
        current: scale.norms.map((n) => ({
          sex: n.sex,
          mean: n.mean,
          sd: n.sd,
          source: n.source,
        })),
        candidate: groups,
      };
    });
}

normRoutes.get("/surveys/:id/candidates", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const scales_ = await candidateStats(surveyId);
  return c.json({ minGroup: MIN_GROUP, scales: scales_ });
});

const applySchema = z.object({
  /** Какие шкалы перевести на локальные нормы */
  scaleCodes: z.array(z.string()).min(1),
});

/**
 * Публикация локальных норм = новая версия методики: нормы — часть контента,
 * и уже собранные прохождения остаются на прежних нормах своей версии.
 */
normRoutes.post("/surveys/:id/apply", async (c) => {
  const user = c.get("user");
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const input = await parseBody(c.req.raw, applySchema);

  const stats = await candidateStats(surveyId);
  const byCode = new Map(stats.map((s) => [s.code, s]));
  for (const code of input.scaleCodes) {
    const stat = byCode.get(code);
    if (!stat) badRequest(`Шкала «${code}» не найдена или не использует T-баллы`);
    const publishable = stat.candidate.filter((g) => g.sex !== null && g.publishable);
    if (!publishable.length) {
      badRequest(
        `Шкала «${code}»: ни одна половая группа не набрала ${MIN_GROUP} наблюдений — публиковать нечего`,
      );
    }
  }

  const raw = await getSurvey(surveyId, null, "uk", true);
  if (!raw) notFound("Методика не найдена");
  const draft = surveyToDraft(raw) as { scales?: { code: string; norms?: unknown[] }[] };

  const today = new Date().toISOString().slice(0, 10);
  for (const scale of draft.scales ?? []) {
    if (!input.scaleCodes.includes(scale.code)) continue;
    const stat = byCode.get(scale.code)!;
    scale.norms = stat.candidate
      .filter((g) => g.sex !== null && g.publishable)
      .map((g) => ({
        sex: g.sex,
        mean: g.mean,
        sd: g.sd,
        source: `локальная выборка, N=${g.n}, ${today}`,
      }));
  }

  const parsed = createSurveySchema.parse(draft);
  const versionId = await createVersion(
    surveyId,
    parsed,
    user.id,
    `Локальные нормы: ${input.scaleCodes.join(", ")}`,
  );

  await audit(c, {
    action: "norms.publish",
    resourceType: "survey",
    resourceId: surveyId,
    details: { scaleCodes: input.scaleCodes, versionId },
  });
  return c.json({ versionId }, 201);
});

/**
 * Перцентильные кривые по возрасту (5.3).
 *
 * Формат знаком врачам по картам роста: P10/P25/P50/P75/P90 против возраста,
 * отдельно для каждого пола. Скользящее окно ±5 лет; если в окне меньше
 * MIN_WINDOW наблюдений — окно расширяется, и его фактическая ширина
 * возвращается честно: врач должен видеть, на чём построена кривая.
 * За пределы наблюдаемых возрастов не экстраполируем.
 */
const MIN_WINDOW = 30;
const PERCENTILES = [0.1, 0.25, 0.5, 0.75, 0.9] as const;

normRoutes.get("/surveys/:id/age-curves", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("Методика не найдена");

  const rows = await db
    .select({
      responseId: responses.id,
      sex: responses.respondentSex,
      birthDate: users.birthDate,
      submittedAt: responses.submittedAt,
    })
    .from(responses)
    .leftJoin(users, eq(users.id, responses.userId))
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")));

  const ageOf = new Map<string, number>();
  const sexOf = new Map<string, "male" | "female">();
  for (const r of rows) {
    const age = ageAt(decryptField(r.birthDate), r.submittedAt);
    if (age === null || !r.sex) continue;
    ageOf.set(r.responseId, age);
    sexOf.set(r.responseId, r.sex);
  }

  const scoreRows = ageOf.size
    ? await db
        .select({ score: responseScores, code: scales.code, kind: scales.kind })
        .from(responseScores)
        .innerJoin(scales, eq(scales.id, responseScores.scaleId))
        .where(inArray(responseScores.responseId, [...ageOf.keys()]))
    : [];

  const curves = survey.scales
    .filter((s) => s.kind === "clinical")
    .map((scale) => {
      const own = scoreRows.filter((r) => r.code === scale.code);
      const bySex = (["male", "female"] as const).map((sex) => {
        const points = own
          .filter((r) => sexOf.get(r.score.responseId) === sex)
          .map((r) => ({ age: ageOf.get(r.score.responseId)!, value: r.score.value }));
        if (points.length < MIN_WINDOW) return { sex, points: [], enough: false as const };

        const ages = [...new Set(points.map((p) => p.age))].sort((a, b) => a - b);
        const curve = ages.map((age) => {
          let halfWidth = 5;
          let window = points.filter((p) => Math.abs(p.age - age) <= halfWidth);
          // окно расширяется, пока не наберётся минимум — и это видно наружу
          while (window.length < MIN_WINDOW && halfWidth < 40) {
            halfWidth += 2;
            window = points.filter((p) => Math.abs(p.age - age) <= halfWidth);
          }
          if (window.length < MIN_WINDOW) return null;
          const values = window.map((p) => p.value);
          return {
            age,
            n: window.length,
            halfWidth,
            percentiles: PERCENTILES.map((q) => ({ q, value: quantile(values, q)! })),
          };
        }).filter((x): x is NonNullable<typeof x> => x !== null);

        return { sex, points: curve, enough: curve.length > 0 };
      });

      return { code: scale.code, title: scale.title, normalization: scale.normalization, bySex };
    })
    .filter((s) => s.bySex.some((b) => b.enough));

  return c.json({ surveyId, title: survey.title, minWindow: MIN_WINDOW, scales: curves });
});
