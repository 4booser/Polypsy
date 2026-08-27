import { asc, eq, inArray } from "drizzle-orm";
import { normalizeLocalized, t, type Lang } from "@quizzy/shared";
import type {
  CreateSurveyInput,
  LogicRule,
  Option,
  Question,
  Scale,
  ScaleBand,
  Section,
  SurveyFull,
} from "@quizzy/shared";
import { db } from "../db";
import {
  options,
  questionLogic,
  questions,
  responses,
  scaleBands,
  scaleCorrections,
  scaleItems,
  scaleNorms,
  scales,
  sections,
  stenRows,
  surveyVersions,
  surveys,
  type SurveyRow,
} from "../db/schema";

/**
 * Загружает методики вместе с содержимым конкретной версии.
 *
 * versionOverride позволяет прочитать методику глазами старого прохождения:
 * без этого правка методики ломала бы интерпретацию уже собранных ответов.
 */
/**
 * Кэш собранного контента версии.
 *
 * Контент версии иммутабелен по построению (правка = новая версия), поэтому
 * кэшу не нужен TTL — только ограничение размера. Ключ включает язык и raw:
 * это разные представления одного контента. Метаданные методики (статус,
 * видимость) в кэш не попадают — они накладываются из свежей строки на
 * каждом вызове, иначе публикация отдавала бы чёрствый статус.
 */
interface CachedContent {
  sections: Section[];
  scales: Scale[];
  questions: Question[];
  versionNumber: number;
}
const contentCache = new Map<string, CachedContent>();
const CONTENT_CACHE_MAX = 100;
const contentKey = (versionId: string, lang: Lang, raw: boolean) => `${versionId}:${lang}:${raw ? 1 : 0}`;

function cacheContent(key: string, value: CachedContent): void {
  if (contentCache.size >= CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value;
    if (oldest) contentCache.delete(oldest);
  }
  contentCache.set(key, value);
}

export async function attachContent(
  rows: SurveyRow[],
  versionOverride?: Map<string, string>,
  lang: Lang = "uk",
  /**
   * raw — отдать локализованные объекты как есть, без разрешения языка.
   * Нужно конструктору: иначе правка методики на одном языке затирала бы другой.
   */
  raw = false,
): Promise<SurveyFull[]> {
  if (rows.length === 0) return [];

  const versionBySurvey = new Map<string, string>();
  for (const r of rows) {
    const v = versionOverride?.get(r.id) ?? r.currentVersionId;
    if (v) versionBySurvey.set(r.id, v);
  }
  const versionIds = [...versionBySurvey.values()];
  if (versionIds.length === 0) {
    return rows.map((r) => ({
      ...r,
      title: t(r.title as never, lang),
      description: r.description ? t(r.description as never, lang) : null,
      instructions: r.instructions ? t(r.instructions as never, lang) : null,
      safetyPlan: r.safetyPlan ? t(r.safetyPlan as never, lang) : null,
      sections: [],
      scales: [],
      questions: [],
      versionId: null,
      versionNumber: 0,
    }));
  }

  // полный кэш-хит: контент версий уже собран, в базу не ходим вовсе
  const allCached = versionIds.every((v) => contentCache.has(contentKey(v, lang, raw)));
  if (allCached) {
    return rows.map((survey) => {
      const vId = versionBySurvey.get(survey.id) ?? null;
      const cached = vId ? contentCache.get(contentKey(vId, lang, raw))! : null;
      const L = (v: unknown) => (raw ? (v as string) : t(v as never, lang));
      const Lnull = (v: unknown) => (v == null ? null : L(v));
      return {
        ...survey,
        title: L(survey.title),
        description: Lnull(survey.description),
        instructions: Lnull(survey.instructions),
        safetyPlan: Lnull(survey.safetyPlan),
        versionId: vId,
        versionNumber: cached?.versionNumber ?? 0,
        sections: cached?.sections ?? [],
        scales: cached?.scales ?? [],
        questions: cached?.questions ?? [],
      } as SurveyFull;
    });
  }

  const versionRows = await db.select().from(surveyVersions).where(inArray(surveyVersions.id, versionIds));
  const versionNumber = new Map(versionRows.map((v) => [v.id, v.version]));

  const [sectionRows, scaleRows, questionRows] = await Promise.all([
    db.select().from(sections).where(inArray(sections.versionId, versionIds)).orderBy(asc(sections.position)),
    db.select().from(scales).where(inArray(scales.versionId, versionIds)).orderBy(asc(scales.position)),
    db.select().from(questions).where(inArray(questions.versionId, versionIds)).orderBy(asc(questions.position)),
  ]);

  const questionIds = questionRows.map((q) => q.id);
  const scaleIds = scaleRows.map((s) => s.id);

  const [optionRows, logicRows, bandRows, itemRows, correctionRows, normRows, stenTableRows] =
    await Promise.all([
    questionIds.length
      ? db.select().from(options).where(inArray(options.questionId, questionIds)).orderBy(asc(options.position))
      : Promise.resolve([]),
    questionIds.length
      ? db.select().from(questionLogic).where(inArray(questionLogic.questionId, questionIds))
      : Promise.resolve([]),
    scaleIds.length
      ? db.select().from(scaleBands).where(inArray(scaleBands.scaleId, scaleIds)).orderBy(asc(scaleBands.position))
      : Promise.resolve([]),
    scaleIds.length
      ? db.select().from(scaleItems).where(inArray(scaleItems.scaleId, scaleIds))
      : Promise.resolve([]),
    scaleIds.length
      ? db.select().from(scaleCorrections).where(inArray(scaleCorrections.targetScaleId, scaleIds))
      : Promise.resolve([]),
    scaleIds.length
      ? db.select().from(scaleNorms).where(inArray(scaleNorms.scaleId, scaleIds))
      : Promise.resolve([]),
    scaleIds.length
      ? db.select().from(stenRows).where(inArray(stenRows.scaleId, scaleIds))
      : Promise.resolve([]),
    ]);

  const scaleCodeById = new Map(scaleRows.map((s) => [s.id, s.code]));

  const optionsByQuestion = groupBy(optionRows, (o) => o.questionId);
  const logicByQuestion = groupBy(logicRows, (l) => l.questionId);
  const bandsByScale = groupBy(bandRows, (b) => b.scaleId);
  const itemsByScale = groupBy(itemRows, (i) => i.scaleId);
  const correctionsByScale = groupBy(correctionRows, (c) => c.targetScaleId);
  const normsByScale = groupBy(normRows, (n) => n.scaleId);
  const stenByScale = groupBy(stenTableRows, (r) => r.scaleId);

  const sectionsBySurvey = groupBy(sectionRows, (s) => s.surveyId);
  const scalesBySurvey = groupBy(scaleRows, (s) => s.surveyId);
  const questionsBySurvey = groupBy(questionRows, (q) => q.surveyId);

  // контент хранится локализованно, наружу отдаём уже разрешённым на нужный язык
  const L = (v: unknown) => (raw ? (v as never) : t(v as never, lang));
  const Lnull = (v: unknown) => (raw ? ((v ?? null) as never) : v ? t(v as never, lang) : null);

  return rows.map((survey) => {
    const vId = versionBySurvey.get(survey.id) ?? null;
    const content: CachedContent = {
    versionNumber: versionNumber.get(vId ?? "") ?? 0,
    sections: (sectionsBySurvey.get(survey.id) ?? []).map(
      (s): Section => ({ ...s, title: L(s.title), description: Lnull(s.description) }),
    ),
    scales: (scalesBySurvey.get(survey.id) ?? []).map(
      (s): Scale => ({
        ...s,
        title: L(s.title),
        description: Lnull(s.description),
        validityMessage: Lnull(s.validityMessage),
        bands: (bandsByScale.get(s.id) ?? []).map(
          (b): ScaleBand => ({
            ...b,
            label: L(b.label),
            description: Lnull(b.description),
            recommendation: Lnull(b.recommendation),
          }),
        ),
        items: (itemsByScale.get(s.id) ?? []).map((i) => ({
          questionId: i.questionId,
          matchKey: i.matchKey,
          weight: i.weight,
        })),
        corrections: (correctionsByScale.get(s.id) ?? []).map((c) => ({
          sourceScaleCode: scaleCodeById.get(c.sourceScaleId) ?? "",
          coefficient: c.coefficient,
        })),
        norms: (normsByScale.get(s.id) ?? []).map((n) => ({
          source: n.source,
          sex: n.sex,
          ageMin: n.ageMin,
          ageMax: n.ageMax,
          mean: n.mean,
          sd: n.sd,
        })),
        stenTable: (stenByScale.get(s.id) ?? []).map((r) => ({
          sex: r.sex,
          ageMin: r.ageMin,
          ageMax: r.ageMax,
          rawMin: r.rawMin,
          rawMax: r.rawMax,
          sten: r.sten,
        })),
      }),
    ),
    questions: (questionsBySurvey.get(survey.id) ?? []).map(
      (q): Question => ({
        ...q,
        title: L(q.title),
        help: Lnull(q.help),
        riskLabel: Lnull(q.riskLabel),
        options: (optionsByQuestion.get(q.id) ?? []).map(
          (o): Option => ({ ...o, text: L(o.text), riskLabel: Lnull(o.riskLabel) }),
        ),
        logic: (logicByQuestion.get(q.id) ?? []) as LogicRule[],
      }),
    ),
    };

    if (vId) cacheContent(contentKey(vId, lang, raw), content);

    return {
      ...survey,
      title: L(survey.title),
      description: Lnull(survey.description),
      instructions: Lnull(survey.instructions),
      safetyPlan: Lnull(survey.safetyPlan),
      versionId: vId,
      ...content,
    } as SurveyFull;
  });
}

export async function getSurvey(
  id: string,
  versionId?: string | null,
  lang: Lang = "uk",
  raw = false,
): Promise<SurveyFull | null> {
  const row = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  if (!row) return null;
  const override = versionId ? new Map([[id, versionId]]) : undefined;
  const [full] = await attachContent([row], override, lang, raw);
  return full ?? null;
}

/** Методика в том виде, в каком её видел конкретный респондент */
export async function getSurveyForResponse(responseId: string): Promise<SurveyFull | null> {
  const response = await db.query.responses.findFirst({ where: eq(responses.id, responseId) });
  if (!response) return null;
  return getSurvey(response.surveyId, response.versionId);
}

type Content = Pick<CreateSurveyInput, "sections" | "scales" | "questions">;

/**
 * Создаёт НОВУЮ версию содержимого и делает её действующей.
 *
 * Старые строки не удаляются: на них ссылаются уже собранные ответы, и только
 * так прохождение остаётся интерпретируемым после правки методики.
 * Всё внутри одной транзакции — частично применённая версия недопустима.
 */
export async function createVersion(
  surveyId: string,
  content: Content,
  createdBy: string | null,
  note?: string,
): Promise<string> {
  const { sections: inputSections = [], scales: inputScales = [], questions: inputQuestions = [] } = content;
  const versionId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    const previous = await tx
      .select({ version: surveyVersions.version })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, surveyId));
    const nextNumber = previous.reduce((max, v) => Math.max(max, v.version), 0) + 1;

    await tx
      .insert(surveyVersions)
      .values({ id: versionId, surveyId, version: nextNumber, note: note ?? null, createdBy });

    const sectionIdByKey = new Map<string, string>();
    for (const [index, section] of inputSections.entries()) {
      const id = crypto.randomUUID();
      sectionIdByKey.set(section.key, id);
      await tx.insert(sections).values({
        id,
        surveyId,
        versionId,
        title: normalizeLocalized(section.title)!,
        description: normalizeLocalized(section.description),
        position: index,
      });
    }

    const scaleIdByCode = new Map<string, string>();
    for (const [index, scale] of inputScales.entries()) {
      const id = crypto.randomUUID();
      scaleIdByCode.set(scale.code, id);
      await tx.insert(scales).values({
        id,
        surveyId,
        versionId,
        code: scale.code,
        title: normalizeLocalized(scale.title)!,
        description: normalizeLocalized(scale.description),
        aggregation: scale.aggregation,
        position: index,
        kind: scale.kind,
        normalization: scale.normalization,
        ratioDenominator: scale.ratioDenominator ?? null,
        validityThreshold: scale.validityThreshold ?? null,
        validityDirection: scale.validityDirection ?? null,
        validityMessage: normalizeLocalized(scale.validityMessage),
      });

      for (const [bandIndex, band] of scale.bands.entries()) {
        await tx.insert(scaleBands).values({
          id: crypto.randomUUID(),
          scaleId: id,
          minScore: band.minScore,
          maxScore: band.maxScore,
          label: normalizeLocalized(band.label)!,
          severity: band.severity,
          description: normalizeLocalized(band.description),
          grade: band.grade ?? null,
          recommendation: normalizeLocalized(band.recommendation),
          position: bandIndex,
        });
      }
    }

    // первый проход: вопросы и варианты, запоминаем id по индексу для логики
    const questionIdByIndex: string[] = [];
    for (const [index, question] of inputQuestions.entries()) {
      const id = crypto.randomUUID();
      questionIdByIndex[index] = id;

      const isNumeric = question.type === "scale" || question.type === "slider" || question.type === "number";
      await tx.insert(questions).values({
        id,
        surveyId,
        versionId,
        sectionId: question.sectionKey ? (sectionIdByKey.get(question.sectionKey) ?? null) : null,
        type: question.type,
        title: normalizeLocalized(question.title)!,
        help: normalizeLocalized(question.help),
        required: question.required,
        position: index,
        scaleId: question.scaleCode ? (scaleIdByCode.get(question.scaleCode) ?? null) : null,
        reverseScored: question.reverseScored,
        minValue: isNumeric ? (question.minValue ?? (question.type === "scale" ? 1 : 0)) : null,
        maxValue: isNumeric ? (question.maxValue ?? (question.type === "scale" ? 5 : 100)) : null,
        step: isNumeric ? (question.step ?? 1) : null,
        minLabel: question.minLabel ?? null,
        maxLabel: question.maxLabel ?? null,
        randomizeOptions: question.randomizeOptions,
        timeLimitSec: question.timeLimitSec ?? null,
        riskThreshold: question.riskThreshold ?? null,
        riskLabel: normalizeLocalized(question.riskLabel),
        riskSeverity: question.riskSeverity ?? null,
      });

      for (const [optionIndex, option] of question.options.entries()) {
        await tx.insert(options).values({
          id: crypto.randomUUID(),
          questionId: id,
          text: normalizeLocalized(option.text)!,
          score: option.score,
          kind: option.kind,
          position: optionIndex,
          keyCode: option.keyCode ?? null,
          riskFlag: option.riskFlag,
          riskLabel: normalizeLocalized(option.riskLabel),
          riskSeverity: option.riskSeverity ?? null,
        });
      }
    }

    // второй проход: логика ссылается на вопросы по индексу, поэтому только
    // после вставки всех вопросов
    for (const [index, question] of inputQuestions.entries()) {
      for (const rule of question.logic) {
        const sourceId = questionIdByIndex[rule.sourceIndex];
        if (!sourceId) continue;
        await tx.insert(questionLogic).values({
          id: crypto.randomUUID(),
          questionId: questionIdByIndex[index]!,
          sourceQuestionId: sourceId,
          operator: rule.operator,
          value: rule.value ?? null,
          action: rule.action,
        });
      }
    }

    /*
     * Третий проход: механика шкал.
     * Ключ ссылается на пункты по номеру, как в пособиях, поэтому его можно
     * записать только когда известны id всех вопросов; поправки ссылаются на
     * другие шкалы по коду, поэтому только когда записаны все шкалы.
     */
    for (const [index, scale] of inputScales.entries()) {
      const scaleId = scaleIdByCode.get(scale.code)!;

      for (const entry of scale.key) {
        const questionId = questionIdByIndex[entry.item - 1];
        if (!questionId) continue;
        await tx
          .insert(scaleItems)
          .values({
            scaleId,
            questionId,
            matchKey: entry.matchKey ?? null,
            weight: entry.weight,
          })
          .onConflictDoNothing();
      }

      // если ключ не задан, шкала собирается из вопросов, помеченных её кодом
      if (scale.key.length === 0) {
        for (const [qIndex, question] of inputQuestions.entries()) {
          if (question.scaleCode !== scale.code) continue;
          await tx
            .insert(scaleItems)
            .values({ scaleId, questionId: questionIdByIndex[qIndex]!, matchKey: null, weight: 1 })
            .onConflictDoNothing();
        }
      }

      for (const correction of scale.corrections) {
        const sourceId = scaleIdByCode.get(correction.from);
        if (!sourceId) continue;
        await tx
          .insert(scaleCorrections)
          .values({ targetScaleId: scaleId, sourceScaleId: sourceId, coefficient: correction.coefficient })
          .onConflictDoNothing();
      }

      for (const norm of scale.norms) {
        await tx.insert(scaleNorms).values({
          id: crypto.randomUUID(),
          scaleId,
          sex: norm.sex ?? null,
          ageMin: norm.ageMin ?? null,
          ageMax: norm.ageMax ?? null,
          mean: norm.mean,
          sd: norm.sd,
          source: norm.source ?? null,
        });
      }

      for (const row of scale.stenTable) {
        await tx.insert(stenRows).values({
          id: crypto.randomUUID(),
          scaleId,
          sex: row.sex ?? null,
          ageMin: row.ageMin ?? null,
          ageMax: row.ageMax ?? null,
          rawMin: row.rawMin,
          rawMax: row.rawMax,
          sten: row.sten,
        });
      }

      void index;
    }

    // действующей версия становится последней операцией: до этого момента
    // проходящие продолжают видеть прежнюю
    await tx
      .update(surveys)
      .set({ currentVersionId: versionId, updatedAt: new Date().toISOString() })
      .where(eq(surveys.id, surveyId));
  });

  return versionId;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * Методика → формат файла экспорта (CreateSurveyInput): ключи по номерам
 * пунктов, поправки по кодам. Общая точка для экспорта и для правок вида
 * «прочитать → изменить → сохранить новой версией» (локальные нормы).
 * Ожидает raw-представление (getSurvey(..., raw = true)).
 */
export function surveyToDraft(survey: SurveyFull) {
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
    safetyPlan: survey.safetyPlan,
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
        cascadeBatteryId: b.cascadeBatteryId,
        cascadeDueDays: b.cascadeDueDays,
        followUpDays: b.followUpDays,
      })),
    })),
  };
  return draft;
}

