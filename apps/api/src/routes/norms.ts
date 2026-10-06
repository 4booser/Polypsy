import { Hono } from "hono";
import { mergeNorms } from "../lib/norms";
import { MIN_GROUP, normCandidates } from "../lib/normCandidates";
import { patientRespondent } from "../lib/population";
import { and, eq } from "drizzle-orm";
import { referenceObservationSets } from "../lib/referenceSample";
import { z } from "zod";
import { ageAt, noteCode, quantile, scaleMaxScore, type Lang } from "@quizzy/shared";
import { db } from "../db";
import { responses, users } from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { badRequest, langOf, notFound, parseBody } from "../lib/http";
import { assertSurveyAccess } from "../lib/scope";
import { copyVersion, getSurvey, type NormValues } from "../lib/surveys";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { env } from "../env";

export const normRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 *
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
normRoutes.use("*", requireAuth, requireStaff, requirePermission("norms.manage"));

/**
 * Кандидатные нормы по фактической выборке — считает lib/normCandidates.ts.
 *
 * Там же — почему выборка это люди, а не прохождения, почему пол — снимок
 * сдачи, почему без недостоверных протоколов и почему только версии, где
 * сырой балл шкалы считается так же, как в действующей. Здесь — только
 * вход: действующая версия и способ достать прежние.
 *
 * Язык — запроса: на нём названия шкал и источники нынешних норм, которые
 * видит экран «Локальні норми» (источник локальной нормы хранится кодом и
 * становится фразой в getSurvey). Прежде здесь стоял русский при любом
 * языке интерфейса. На сами числа язык не влияет.
 */
async function candidateReport(surveyId: string, lang: Lang) {
  const survey = await getSurvey(surveyId, null, lang);
  if (!survey) notFound("err.surveyNotFound");
  return normCandidates(surveyId, survey, (versionId) => getSurvey(surveyId, versionId, lang));
}

async function candidateStats(surveyId: string, lang: Lang) {
  return (await candidateReport(surveyId, lang)).scales;
}

normRoutes.get("/surveys/:id/candidates", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const report = await candidateReport(surveyId, langOf(c));
  return c.json({ minGroup: MIN_GROUP, unreliable: report.unreliable, scales: report.scales });
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

  const stats = await candidateStats(surveyId, langOf(c));
  const byCode = new Map(stats.map((s) => [s.code, s]));
  for (const code of input.scaleCodes) {
    const stat = byCode.get(code);
    if (!stat) badRequest("err.scaleNotFoundOrNotTscore", { code });
    const publishable = stat.candidate.filter((g) => g.sex !== null && g.publishable);
    if (!publishable.length) {
      badRequest("err.scaleGroupTooSmall", { code, minGroup: MIN_GROUP });
    }
  }

  /*
   * Новая версия — копия действующей по строкам (copyVersion), в которой
   * меняются только нормы выбранных шкал. До волны 12 здесь стоял путь
   * через экспорт (surveyToDraft → createVersion): он терял секции, условия
   * показа, обратный ключ пунктов, привязку пунктов к шкалам, каскады полос
   * и локальные нормы ДРУГИХ шкал — «обновить нормы одной шкалы» тихо
   * переписывало всю методику, и по этой новой версии считались все
   * следующие сдачи.
   *
   * Нормы берутся из той же копируемой версии, под её замком: локальная
   * норма другого пола этой же шкалы, опубликованная раньше, остаётся на
   * месте (mergeNorms), а не пропадает вместе с экспортным фильтром.
   */
  const today = new Date().toISOString().slice(0, 10);
  /*
   * Заметка версии и источник нормы — кодом (noteCode): их читают на любом
   * языке — история версий, экран норм, словарь выгрузки. Источник к тому же
   * признак: по коду локальную норму не выгружают в файл методики
   * (isLocalNormSource, lib/surveys.ts).
   */
  const versionId = await copyVersion(surveyId, user.id, noteCode("note.localNorms", { scales: input.scaleCodes.join(", ") }), {
    norms: (code, current) => {
      if (!input.scaleCodes.includes(code)) return undefined;
      const stat = byCode.get(code)!;
      const fresh: NormValues[] = stat.candidate
        .filter((g) => g.sex !== null && g.publishable)
        .map((g) => ({
          sex: g.sex,
          ageMin: null,
          ageMax: null,
          mean: g.mean,
          sd: g.sd,
          source: noteCode("note.localSample", { n: g.n, date: today }),
        }));
      // локальные нормы дополняют, а не заменяют — см. mergeNorms в lib/norms.ts
      return mergeNorms(current, fresh);
    },
  });

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
 *
 * Выборка — референтная (lib/referenceSample.ts, мера «value»), та же, что у
 * перцентиля листа и динамики. Прежде баллы складывались по коду шкалы без
 * оглядки на версию: у действующей шкалы 0–10 кривая показывала медиану 100
 * из прохождений старой редакции 0–100 (CR-102). Теперь в кривую шкалы идут
 * только версии, где приведённое значение считается так же (отпечаток
 * valueSignature), с тем же размахом и в тех же единицах; достоверные,
 * обследуемые, человек — одно наблюдение (его последнее совместимое, с его
 * возрастом на тот день). Порог окна считается после отбора. Подпись,
 * нормировка, n и перцентили поэтому относятся к одной мере.
 */
const MIN_WINDOW = 30;
const PERCENTILES = [0.1, 0.25, 0.5, 0.75, 0.9] as const;

normRoutes.get("/surveys/:id/age-curves", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const survey = await getSurvey(surveyId, null, langOf(c));
  if (!survey) notFound("err.surveyNotFound");

  const rows = await db
    .select({
      responseId: responses.id,
      sex: responses.respondentSex,
      birthDate: users.birthDate,
      submittedAt: responses.submittedAt,
    })
    .from(responses)
    .leftJoin(users, eq(users.id, responses.userId))
    .where(
      and(
        eq(responses.surveyId, surveyId),
        eq(responses.status, "completed"),
        // кривая — та же норма, только по возрасту: без недостоверных протоколов и проб сотрудников
        eq(responses.reliable, true),
        patientRespondent("responses"),
      ),
    );

  const ageOf = new Map<string, number>();
  const sexOf = new Map<string, "male" | "female">();
  for (const r of rows) {
    const age = ageAt(decryptField(r.birthDate), r.submittedAt, env.institutionTz);
    if (age === null || !r.sex) continue;
    ageOf.set(r.responseId, age);
    sexOf.set(r.responseId, r.sex);
  }

  /*
   * Точка каждой шкалы — действующая версия: её код, размах сырого балла
   * (как его пишет сдача, scoring.ts) и единицы — нормировка шкалы.
   */
  const clinical = survey.scales.filter((s) => s.kind === "clinical");
  // методика без единой версии: сравнивать не с чем — кривых нет, а не кривые по всему
  const versionId = survey.versionId;
  if (!versionId) return c.json({ surveyId, title: survey.title, minWindow: MIN_WINDOW, scales: [] });
  const targetOf = (scale: (typeof clinical)[number]) => ({
    versionId,
    code: scale.code,
    maxScore: Math.round(scaleMaxScore(scale, survey.questions) * 100) / 100,
    unit: scale.normalization,
  });
  const pick = ageOf.size
    ? await referenceObservationSets(surveyId, "value", clinical.map(targetOf), (o) => ageOf.has(o.responseId))
    : () => [];

  const curves = clinical
    .map((scale) => {
      const own = pick(targetOf(scale));
      const bySex = (["male", "female"] as const).map((sex) => {
        const points = own
          .filter((o) => sexOf.get(o.responseId) === sex)
          .map((o) => ({ age: ageOf.get(o.responseId)!, value: o.value }));
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
