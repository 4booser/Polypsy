import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { normalizeLocalized, t, validateSurvey, type Issue } from "@quizzy/shared";
import { createSurveySchema, updateSurveySchema, type SurveyFull, type SurveyListItem } from "@quizzy/shared";
import { db } from "../db";
import { surveyVersions, surveys } from "../db/schema";
import { badRequest, langOf, notFound, parseBody } from "../lib/http";
import { attachContent, createVersion, getSurvey } from "../lib/surveys";
import { audit } from "../lib/audit";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";
import { assertGroupAccess, assertSurveyAccess, isStaff, surveyScopeFilter } from "../lib/scope";
import { patientVisibilityFilter } from "./access";
import { hasGrant } from "../lib/scope";

/**
 * Приводит сохранённую методику к виду, который понимает валидатор.
 *
 * Сохранённая методика хранит ключ ссылками на вопросы и поправки ссылками на
 * шкалы, а валидатор работает с номерами пунктов и кодами шкал, как в пособии.
 * Без этого перевода проверка молча считала бы поправки битыми.
 */
function toValidatable(survey: SurveyFull | null) {
  if (!survey) return { questions: [], scales: [] };
  const indexById = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  return {
    questions: survey.questions,
    scales: survey.scales.map((s) => ({
      ...s,
      key: s.items.flatMap((i) => {
        const item = indexById.get(i.questionId);
        return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
      }),
      corrections: s.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
    })),
  };
}

export const surveyRoutes = new Hono<AppEnv>();

surveyRoutes.use("*", requireAuth);

/** Пользователю видны только опубликованные методики, админу — все */
surveyRoutes.get("/", async (c) => {
  const user = c.get("user");
  const groupId = c.req.query("groupId");

  const filters = [];
  if (!isStaff(user)) {
    // пациент видит опубликованные общедоступные плюс назначенные лично ему
    filters.push(patientVisibilityFilter(user.id));
  } else {
    // сотрудник видит только методики своих групп
    const scope = await surveyScopeFilter(user);
    if (scope) filters.push(scope);
  }
  if (groupId) filters.push(eq(surveys.groupId, groupId));

  const rows = await db
    .select({
      survey: surveys,
      // подзапросы пишем с алиасами и полной квалификацией внешней колонки:
      // drizzle рендерит surveys.id как "id", а внутри подзапроса это имя перехватила бы
      // одноимённая колонка вложенной таблицы
      questionCount: sql<number>`(select count(*) from questions q where q.survey_id = "surveys"."id")`,
      responseCount: sql<number>`(select count(*) from responses r where r.survey_id = "surveys"."id" and r.status = 'completed')`,
      completedByMe: sql<number>`(select count(*) from responses r where r.survey_id = "surveys"."id" and r.user_id = ${user.id} and r.status = 'completed')`,
    })
    .from(surveys)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(surveys.createdAt));

  const list: SurveyListItem[] = rows.map((r) => ({
    ...r.survey,
    title: t(r.survey.title as never, langOf(c)),
    description: r.survey.description ? t(r.survey.description as never, langOf(c)) : null,
    instructions: r.survey.instructions ? t(r.survey.instructions as never, langOf(c)) : null,
    questionCount: Number(r.questionCount ?? 0),
    responseCount: Number(r.responseCount ?? 0),
    completedByMe: Number(r.completedByMe ?? 0) > 0,
  }));
  return c.json(list);
});

surveyRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  // raw=1 отдаёт локализованные объекты целиком — этим живёт конструктор
  const raw = c.req.query("raw") === "1" && isStaff(user);
  const survey = await getSurvey(c.req.param("id"), null, langOf(c), raw);
  if (!survey) notFound("Методика не найдена");
  if (!isStaff(user)) {
    if (survey.status !== "published") notFound("Методика не найдена");
    if (survey.administration !== "self") notFound("Методика не найдена");
    if (survey.visibility === "restricted" && !(await hasGrant(user.id, survey.id))) {
      notFound("Методика не найдена");
    }
  } else {
    await assertSurveyAccess(user, survey.id);
  }
  return c.json(survey);
});

/**
 * Проверка методики без сохранения — конструктор зовёт её перед публикацией.
 * Отдельным маршрутом, чтобы можно было проверить черновик, ничего не записав.
 */
surveyRoutes.post("/validate", requireStaff, async (c) => {
  const input = await parseBody(c.req.raw, createSurveySchema);
  return c.json({ issues: validateSurvey(input) });
});

surveyRoutes.post("/", requireStaff, async (c) => {
  const input = await parseBody(c.req.raw, createSurveySchema);
  // методику нельзя положить в чужую группу
  if (input.groupId) await assertGroupAccess(c.get("user"), input.groupId);

  const [row] = await db
    .insert(surveys)
    .values({
      id: crypto.randomUUID(),
      groupId: input.groupId ?? null,
      title: normalizeLocalized(input.title)!,
      description: normalizeLocalized(input.description),
      instructions: normalizeLocalized(input.instructions),
      administration: input.administration,
      timeLimitSec: input.timeLimitSec ?? null,
      randomizeQuestions: input.randomizeQuestions ?? false,
      allowBack: input.allowBack ?? true,
      showProgress: input.showProgress ?? true,
      anonymous: input.anonymous ?? false,
      visibility: input.visibility ?? "public",
      allowRetake: input.allowRetake ?? false,
      scoringEnabled: input.scoringEnabled ?? false,
      createdBy: c.get("user").id,
    })
    .returning();

  await createVersion(row!.id, input, c.get("user").id, "Первая версия");
  await audit(c, {
    action: "survey.create",
    resourceType: "survey",
    resourceId: row!.id,
    details: { title: t(row!.title as never), questions: input.questions.length },
  });
  const [full] = await attachContent([row!]);
  return c.json({ ...full, issues: validateSurvey(input) satisfies Issue[] }, 201);
});

surveyRoutes.patch("/:id", requireStaff, async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);
  const input = await parseBody(c.req.raw, updateSurveySchema);
  if (input.groupId) await assertGroupAccess(c.get("user"), input.groupId);

  const existing = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  if (!existing) notFound("Методика не найдена");

  const changesContent = !!(input.questions || input.sections || input.scales);

  const goingLive = input.status === "published" && existing.status !== "published";

  /*
   * Публикация со структурными ошибками запрещена: методика, которая не может
   * быть корректно посчитана, не должна попадать к пациентам. Черновик с
   * ошибками сохранить можно — это нормальное состояние незаконченной работы.
   */
  if (input.status === "published") {
    const full = changesContent
      ? { questions: input.questions ?? [], scales: input.scales ?? [] }
      : toValidatable(await getSurvey(id, null, "uk", true));
    const errors = validateSurvey(full as never).filter((i) => i.level === "error");
    if (errors.length) {
      badRequest(
        `Методику нельзя опубликовать: ${errors.length} структурных ошибок. ` +
          errors.map((e) => `${e.where}: ${e.message}`).join("; "),
      );
    }
  }
  const [row] = await db
    .update(surveys)
    .set({
      ...(input.title !== undefined && { title: normalizeLocalized(input.title)! }),
      ...(input.description !== undefined && { description: normalizeLocalized(input.description) }),
      ...(input.instructions !== undefined && { instructions: normalizeLocalized(input.instructions) }),
      ...(input.groupId !== undefined && { groupId: input.groupId ?? null }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.timeLimitSec !== undefined && { timeLimitSec: input.timeLimitSec ?? null }),
      ...(input.randomizeQuestions !== undefined && { randomizeQuestions: input.randomizeQuestions }),
      ...(input.allowBack !== undefined && { allowBack: input.allowBack }),
      ...(input.showProgress !== undefined && { showProgress: input.showProgress }),
      ...(input.anonymous !== undefined && { anonymous: input.anonymous }),
      ...(input.administration !== undefined && { administration: input.administration }),
      ...(input.visibility !== undefined && { visibility: input.visibility }),
      ...(input.allowRetake !== undefined && { allowRetake: input.allowRetake }),
      ...(input.scoringEnabled !== undefined && { scoringEnabled: input.scoringEnabled }),
      ...(goingLive && { publishedAt: new Date().toISOString() }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(surveys.id, id))
    .returning();

  if (changesContent) {
    // правка не трогает старые строки: создаётся новая версия, а уже собранные
    // прохождения продолжают ссылаться на ту версию, которую респондент видел
    await createVersion(
      id,
      {
        sections: input.sections ?? [],
        scales: input.scales ?? [],
        questions: input.questions ?? [],
      },
      c.get("user").id,
      input.versionNote,
    );
  }

  await audit(c, {
    action: goingLive ? "survey.publish" : "survey.update",
    resourceType: "survey",
    resourceId: id,
    details: { status: row!.status, contentChanged: changesContent },
  });

  // перечитываем строку: currentVersionId выставляется внутри createVersion,
  // и без этого ответ вернул бы содержимое прежней версии
  const fresh = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  const [full] = await attachContent([fresh ?? row!]);
  return c.json(full);
});

/** Копия методики — штатный способ «отредактировать» методику, по которой уже есть данные */
surveyRoutes.post("/:id/duplicate", requireStaff, async (c) => {
  await assertSurveyAccess(c.get("user"), c.req.param("id"));
  const source = await getSurvey(c.req.param("id"));
  if (!source) notFound("Методика не найдена");

  const [row] = await db
    .insert(surveys)
    .values({
      id: crypto.randomUUID(),
      groupId: source.groupId,
      title: { uk: `${source.title} (копія)`, ru: `${source.title} (копия)` } as Record<string, string>,
      description: source.description ? { uk: source.description } : null,
      instructions: source.instructions ? { uk: source.instructions } : null,
      status: "draft",
      timeLimitSec: source.timeLimitSec,
      randomizeQuestions: source.randomizeQuestions,
      allowBack: source.allowBack,
      showProgress: source.showProgress,
      anonymous: source.anonymous,
      visibility: source.visibility,
      administration: source.administration,
      allowRetake: source.allowRetake,
      scoringEnabled: source.scoringEnabled,
      createdBy: c.get("user").id,
    })
    .returning();

  const sectionKeyById = new Map(source.sections.map((s) => [s.id, s.id]));
  const questionIndexById = new Map(source.questions.map((q, i) => [q.id, i]));

  await createVersion(
    row!.id,
    {
    sections: source.sections.map((s) => ({
      key: s.id,
      title: s.title,
      description: s.description,
    })),
    // копия сохраняет всю механику шкал, иначе она перестанет считаться
    scales: source.scales.map((s) => ({
      code: s.code,
      title: s.title,
      description: s.description,
      aggregation: s.aggregation,
      kind: s.kind,
      normalization: s.normalization,
      ratioDenominator: s.ratioDenominator,
      validityThreshold: s.validityThreshold,
      validityDirection: s.validityDirection,
      validityMessage: s.validityMessage,
      bands: s.bands.map((b) => ({
        minScore: b.minScore,
        maxScore: b.maxScore,
        label: b.label,
        severity: b.severity,
        description: b.description,
        grade: b.grade,
        recommendation: b.recommendation,
      })),
      key: s.items.flatMap((i) => {
        const idx = questionIndexById.get(i.questionId);
        return idx === undefined ? [] : [{ item: idx + 1, matchKey: i.matchKey, weight: i.weight }];
      }),
      corrections: s.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
      norms: s.norms,
      stenTable: s.stenTable,
    })),
    questions: source.questions.map((q) => ({
      type: q.type,
      title: q.title,
      help: q.help,
      required: q.required,
      sectionKey: q.sectionId ? (sectionKeyById.get(q.sectionId) ?? null) : null,
      scaleCode: source.scales.find((s) => s.id === q.scaleId)?.code ?? null,
      reverseScored: q.reverseScored,
      minValue: q.minValue,
      maxValue: q.maxValue,
      step: q.step,
      minLabel: q.minLabel,
      maxLabel: q.maxLabel,
      randomizeOptions: q.randomizeOptions,
      timeLimitSec: q.timeLimitSec,
      riskThreshold: q.riskThreshold,
      riskLabel: q.riskLabel,
      riskSeverity: q.riskSeverity,
      options: q.options.map((o) => ({
        text: o.text,
        score: o.score,
        kind: o.kind,
        riskFlag: o.riskFlag,
        riskLabel: o.riskLabel,
        riskSeverity: o.riskSeverity,
      })),
      logic: q.logic.flatMap((rule) => {
        const sourceIndex = questionIndexById.get(rule.sourceQuestionId);
        return sourceIndex === undefined
          ? []
          : [{ sourceIndex, operator: rule.operator, value: rule.value, action: rule.action }];
      }),
    })),
    },
    c.get("user").id,
    `Копия «${source.title}»`,
  );

  await audit(c, {
    action: "survey.duplicate",
    resourceType: "survey",
    resourceId: row!.id,
    details: { sourceId: source.id },
  });

  const [full] = await attachContent([row!]);
  return c.json(full, 201);
});

/** История версий методики со счётчиком прохождений на каждой */
surveyRoutes.get("/:id/versions", requireStaff, async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);

  const rows = await db
    .select({
      id: surveyVersions.id,
      surveyId: surveyVersions.surveyId,
      version: surveyVersions.version,
      note: surveyVersions.note,
      createdBy: surveyVersions.createdBy,
      createdAt: surveyVersions.createdAt,
      responseCount: sql<number>`(select count(*) from responses r where r.version_id = "survey_versions"."id")`,
    })
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, id))
    .orderBy(desc(surveyVersions.version));

  return c.json(rows.map((r) => ({ ...r, responseCount: Number(r.responseCount ?? 0) })));
});

/**
 * Печать ключей методики для сверки с пособием.
 *
 * Структурная проверка ловит форму, но не содержание: если при переносе
 * перепутаны 47 и 74, она промолчит. Единственный способ поймать такое —
 * положить рядом распечатку ключей и оригинал, поэтому ключи выводятся
 * ровно в том виде, в каком они напечатаны в пособии.
 */
surveyRoutes.get("/:id/key", requireStaff, async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);
  const survey = await getSurvey(id, null, langOf(c));
  if (!survey) notFound("Методика не найдена");

  const indexById = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  const compress = (nums: number[]) => nums.sort((a, b) => a - b).join(", ");

  const scales = survey.scales.map((scale) => {
    const yes = scale.items.filter((i) => i.matchKey === "yes").map((i) => indexById.get(i.questionId)!);
    const no = scale.items.filter((i) => i.matchKey === "no").map((i) => indexById.get(i.questionId)!);
    const scored = scale.items.filter((i) => i.matchKey === null).map((i) => indexById.get(i.questionId)!);
    return {
      code: scale.code,
      title: scale.title,
      kind: scale.kind,
      normalization: scale.normalization,
      itemCount: scale.items.length,
      yes: compress(yes),
      no: compress(no),
      scored: compress(scored),
      corrections: scale.corrections.map((x) => `${x.sourceScaleCode} × ${x.coefficient}`).join(", "),
      norms: scale.norms.map((n) => `${n.sex ?? "любой"}: M=${n.mean}, δ=${n.sd}`).join("; "),
      stens: scale.stenTable
        .sort((a, b) => a.sten - b.sten)
        .map((r) => `${r.sten}: ${r.rawMin}–${r.rawMax >= 999 ? "∞" : r.rawMax}`)
        .join("  "),
      bands: scale.bands.map((b) => `${b.minScore}–${b.maxScore} → ${b.label}`).join("; "),
    };
  });

  await audit(c, { action: "survey.key_print", resourceType: "survey", resourceId: id });

  return c.json({
    surveyId: id,
    title: survey.title,
    version: survey.versionNumber,
    questionCount: survey.questions.length,
    questions: survey.questions.map((q, i) => ({ n: i + 1, title: q.title })),
    scales,
  });
});

/** Выгрузка методики в том виде, в каком её принимает конструктор */
surveyRoutes.get("/:id/export", requireStaff, async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);
  const survey = await getSurvey(id, null, "uk", true);
  if (!survey) notFound("Методика не найдена");

  const indexById = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  const draft = {
    /** Версия формата файла — на случай несовместимых изменений */
    formatVersion: 1,
    title: survey.title,
    description: survey.description,
    instructions: survey.instructions,
    administration: survey.administration,
    visibility: survey.visibility,
    scoringEnabled: survey.scoringEnabled,
    allowRetake: survey.allowRetake,
    showProgress: survey.showProgress,
    allowBack: survey.allowBack,
    anonymous: survey.anonymous,
    randomizeQuestions: survey.randomizeQuestions,
    timeLimitSec: survey.timeLimitSec,
    tooFastMs: survey.tooFastMs,
    alertEscalateMinutes: survey.alertEscalateMinutes,
    sections: [],
    questions: survey.questions.map((q) => ({
      type: q.type,
      title: q.title,
      help: q.help,
      required: q.required,
      minValue: q.minValue,
      maxValue: q.maxValue,
      step: q.step,
      minLabel: q.minLabel,
      maxLabel: q.maxLabel,
      riskThreshold: q.riskThreshold,
      riskLabel: q.riskLabel,
      riskSeverity: q.riskSeverity,
      options: q.options.map((o) => ({
        text: o.text,
        score: o.score,
        kind: o.kind,
        keyCode: o.keyCode,
        riskFlag: o.riskFlag,
        riskLabel: o.riskLabel,
        riskSeverity: o.riskSeverity,
      })),
    })),
    scales: survey.scales.map((s) => ({
      code: s.code,
      title: s.title,
      description: s.description,
      kind: s.kind,
      aggregation: s.aggregation,
      normalization: s.normalization,
      ratioDenominator: s.ratioDenominator,
      validityThreshold: s.validityThreshold,
      validityDirection: s.validityDirection,
      validityMessage: s.validityMessage,
      key: s.items.flatMap((i) => {
        const item = indexById.get(i.questionId);
        return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
      }),
      corrections: s.corrections.map((x) => ({ from: x.sourceScaleCode, coefficient: x.coefficient })),
      norms: s.norms,
      stenTable: s.stenTable,
      bands: s.bands.map((b) => ({
        minScore: b.minScore,
        maxScore: b.maxScore,
        label: b.label,
        severity: b.severity,
        description: b.description,
        grade: b.grade,
        recommendation: b.recommendation,
      })),
    })),
  };

  await audit(c, { action: "survey.export", resourceType: "survey", resourceId: id });
  return c.json(draft);
});

/**
 * Импорт методики из файла экспорта.
 *
 * Файл — тот же формат, что отдаёт export (ключи по номерам пунктов),
 * поэтому конвейер совпадает с посевом: схема → структурный валидатор →
 * createVersion. Методика с ошибками валидатора не создаётся вовсе:
 * «импортировалось, но считает неправильно» — худший исход из возможных.
 * Импортированное всегда черновик: публикация — осознанное действие после
 * сверки ключей.
 */
surveyRoutes.post("/import", requireStaff, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") badRequest("Ожидается JSON файла экспорта");

  const { formatVersion, groupId, ...raw } = body as Record<string, unknown>;
  if (formatVersion !== undefined && formatVersion !== 1) {
    badRequest(`Неизвестная версия формата: ${formatVersion}. Эта сборка понимает версию 1`);
  }
  if (groupId) await assertGroupAccess(user, String(groupId));

  const parsed = createSurveySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    badRequest(`Файл не разобран: ${first?.path.join(".")}: ${first?.message}`);
  }
  const input = parsed.data;

  const issues = validateSurvey(input);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    // 422 с полным списком: чинить файл, а не половину методики в базе
    return c.json({ error: "Структурные ошибки — методика не создана", issues }, 422);
  }

  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupId ? String(groupId) : null,
    title: normalizeLocalized(input.title),
    description: normalizeLocalized(input.description),
    instructions: normalizeLocalized(input.instructions),
    administration: input.administration,
    status: "draft",
    timeLimitSec: input.timeLimitSec ?? null,
    randomizeQuestions: input.randomizeQuestions ?? false,
    allowBack: input.allowBack ?? true,
    showProgress: input.showProgress ?? true,
    anonymous: input.anonymous ?? false,
    visibility: input.visibility ?? "public",
    allowRetake: input.allowRetake ?? false,
    scoringEnabled: input.scoringEnabled ?? false,
    tooFastMs: input.tooFastMs ?? null,
    alertEscalateMinutes: input.alertEscalateMinutes ?? null,
    createdBy: user.id,
  } as never);
  await createVersion(id, input, user.id, "Импорт из файла");

  await audit(c, {
    action: "survey.import",
    resourceType: "survey",
    resourceId: id,
    details: {
      title: t(normalizeLocalized(input.title) as never),
      questions: input.questions.length,
      scales: (input.scales ?? []).length,
      warnings: issues.length,
    },
  });
  return c.json({ id, issues }, 201);
});

surveyRoutes.delete("/:id", requireStaff, async (c) => {
  await assertSurveyAccess(c.get("user"), c.req.param("id"));
  const deleted = await db.delete(surveys).where(eq(surveys.id, c.req.param("id"))).returning();
  if (deleted.length === 0) notFound("Методика не найдена");
  await audit(c, {
    action: "survey.delete",
    resourceType: "survey",
    resourceId: c.req.param("id"),
    details: { title: t(deleted[0]!.title as never) },
  });
  return c.body(null, 204);
});
