import { asc, eq, inArray, sql } from "drizzle-orm";
import { normalizeLocalized, presentedLang, t, type Lang } from "@quizzy/shared";
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
import { conflict } from "./http";

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

/**
 * На каком языке отдан текст методики — по названию.
 *
 * По названию, а не по пунктам: пункты в кэше лежат уже разрешёнными, и
 * их язык оттуда не прочесть, а название пишется вместе с пунктами — в
 * каталоге и в конструкторе оба языка заводятся разом. У сырой выдачи
 * (конструктор) языка нет: там отдаются все.
 */
function contentLangOf(title: unknown, lang: Lang, raw: boolean): Lang | undefined {
  return raw ? undefined : presentedLang(title as never, lang);
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
      contentLang: contentLangOf(r.title, lang, raw),
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
        contentLang: contentLangOf(survey.title, lang, raw),
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
        /* подписи концов шкалы читает пациент — разрешаются так же, как текст вопроса */
        minLabel: Lnull(q.minLabel),
        maxLabel: Lnull(q.maxLabel),
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
      contentLang: contentLangOf(survey.title, lang, raw),
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
/**
 * Методика той версии, которую проходили, — на языке того, кто читает.
 *
 * Язык берётся у читателя, а не у прохождения: просмотр и печать открывает
 * персонал со своей консолью, и украинский заголовок над русским описанием
 * (описание шло другим запросом, с языком) выглядел как недоперевод. Язык
 * прохождения — ответ на другой вопрос («что видел респондент»), и его
 * экран пока не задаёт.
 */
export async function getSurveyForResponse(responseId: string, lang: Lang = "uk"): Promise<SurveyFull | null> {
  const response = await db.query.responses.findFirst({ where: eq(responses.id, responseId) });
  if (!response) return null;
  return getSurvey(response.surveyId, response.versionId, lang);
}

/**
 * Действующая версия → содержимое в формате записи (CreateSurveyInput) —
 * обратное к createVersion, без потерь.
 *
 * Нужно правке, которая меняет не всё: PATCH с одними questions обязан
 * перенести шкалы и секции из действующей версии, а не создать версию без
 * них (так и было: версия без шкал, а PATCH одних scales — версия без
 * единого вопроса). Нужно и копии методики.
 *
 * Не путать с surveyToDraft ниже: тот — формат ОБМЕНА с чужим учреждением и
 * по назначению теряет то, что не должно уехать наружу (локальные нормы,
 * ссылки каскадов, секции, условия). Здесь содержимое остаётся в своём же
 * экземпляре, и терять нельзя ничего: ни кодов вариантов (без них ключ
 * «Так/Ні» перестаёт считать), ни каскадов полос, ни условий показа.
 *
 * Ожидает сырое представление (getSurvey(..., raw = true)): тексты уходят
 * на всех языках. Ключ перенесённой секции — её id: именно его клиент видит
 * в `questions[].sectionId` и шлёт как `sectionKey`, если правит одни вопросы.
 */
export function versionContent(survey: SurveyFull): Content {
  const indexById = new Map(survey.questions.map((q, i) => [q.id, i]));
  const scaleCodeById = new Map(survey.scales.map((s) => [s.id, s.code]));
  const L = (v: unknown) => v as never;

  return {
    sections: survey.sections.map((s) => ({ key: s.id, title: L(s.title), description: L(s.description) })),
    scales: survey.scales.map((s) => {
      /*
       * Ключ, собранный по коду шкалы у вопросов (в исходнике key: [] —
       * см. createVersion), переносится так же — пустым, а не списком
       * номеров. Иначе вопрос, добавленный в следующей правке с тем же
       * кодом шкалы, в неё уже не попал бы: перенесённый явный ключ его не
       * знает, а балл молча считался бы без нового пункта.
       */
      const linked = survey.questions.filter((q) => q.scaleId === s.id).map((q) => q.id);
      const derived =
        s.items.length === linked.length &&
        s.items.every((i) => i.matchKey === null && i.weight === 1 && linked.includes(i.questionId));
      return {
        code: s.code,
        title: L(s.title),
        description: L(s.description),
        aggregation: s.aggregation,
        kind: s.kind,
        normalization: s.normalization,
        ratioDenominator: s.ratioDenominator,
        validityThreshold: s.validityThreshold,
        validityDirection: s.validityDirection,
        validityMessage: L(s.validityMessage),
        minAnsweredShare: s.minAnsweredShare ?? null,
        bands: s.bands.map((b) => ({
          minScore: b.minScore,
          maxScore: b.maxScore,
          label: L(b.label),
          severity: b.severity,
          description: L(b.description),
          grade: b.grade,
          recommendation: L(b.recommendation),
          // каскад — ссылка на батарею этого же экземпляра, и она едет как есть
          cascadeBatteryId: b.cascadeBatteryId,
          cascadeDueDays: b.cascadeDueDays,
          followUpDays: b.followUpDays,
        })),
        key: derived
          ? []
          : s.items.flatMap((i) => {
              const index = indexById.get(i.questionId);
              return index === undefined ? [] : [{ item: index + 1, matchKey: i.matchKey, weight: i.weight }];
            }),
        corrections: s.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
        // нормы — все, и локальные тоже: методика остаётся в своём учреждении
        norms: s.norms.map((n) => ({ sex: n.sex, ageMin: n.ageMin, ageMax: n.ageMax, mean: n.mean, sd: n.sd, source: n.source })),
        stenTable: s.stenTable.map((r) => ({
          sex: r.sex,
          ageMin: r.ageMin,
          ageMax: r.ageMax,
          rawMin: r.rawMin,
          rawMax: r.rawMax,
          sten: r.sten,
        })),
      };
    }),
    questions: survey.questions.map((q) => ({
      type: q.type,
      title: L(q.title),
      help: L(q.help),
      required: q.required,
      sectionKey: q.sectionId,
      scaleCode: q.scaleId ? (scaleCodeById.get(q.scaleId) ?? null) : null,
      reverseScored: q.reverseScored,
      minValue: q.minValue,
      maxValue: q.maxValue,
      step: q.step,
      minLabel: L(q.minLabel),
      maxLabel: L(q.maxLabel),
      randomizeOptions: q.randomizeOptions,
      timeLimitSec: q.timeLimitSec,
      riskThreshold: q.riskThreshold,
      riskLabel: L(q.riskLabel),
      riskSeverity: q.riskSeverity,
      options: q.options.map((o) => ({
        text: L(o.text),
        score: o.score,
        kind: o.kind,
        keyCode: o.keyCode,
        riskFlag: o.riskFlag,
        riskLabel: L(o.riskLabel),
        riskSeverity: o.riskSeverity,
      })),
      // значения условий — id вариантов этой версии; createVersion переведёт их по source
      logic: q.logic.flatMap((rule) => {
        const sourceIndex = indexById.get(rule.sourceQuestionId);
        return sourceIndex === undefined
          ? []
          : [{ sourceIndex, operator: rule.operator, value: rule.value, action: rule.action }];
      }),
    })),
  };
}

export type Content = Pick<CreateSurveyInput, "sections" | "scales" | "questions">;

/**
 * Версия, из которой выведено новое содержимое, — ради ссылок на варианты.
 *
 * Достаточно вариантов по порядку вопросов: см. remapOptionRefs.
 */
export interface ContentSource {
  questions: { options: { id: string }[] }[];
}

/**
 * Перевод ссылок на варианты в значении условия показа.
 *
 * Условие «показать, если выбран вариант X» (eq, contains — scoring.ts,
 * evaluateRule) хранит ИДЕНТИФИКАТОР варианта, а каждая версия заводит
 * варианты с новыми. Значение, указывающее на вариант прежней версии,
 * переводится на его двойника в новой; число и текст остаются как есть.
 * Тот же приём, что у copyVersion (участок submit) — одна функция на оба
 * пути, чтобы однажды не разойтись.
 */
export function remapOptionRefs(value: unknown, resolve: (id: string) => string | undefined): unknown {
  if (typeof value === "string") return resolve(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapOptionRefs(v, resolve));
  return value;
}

/** Нарушение уникального ключа (версия, номер) — PostgreSQL 23505 по этому индексу */
function isVersionNumberClash(error: unknown): boolean {
  const e = error as { code?: string; constraint_name?: string; constraint?: string } | null;
  return e?.code === "23505" && (e.constraint_name ?? e.constraint) === "versions_survey_number_idx";
}

/**
 * Создаёт НОВУЮ версию содержимого и делает её действующей.
 *
 * Старые строки не удаляются: на них ссылаются уже собранные ответы, и только
 * так прохождение остаётся интерпретируемым после правки методики.
 * Всё внутри одной транзакции — частично применённая версия недопустима.
 *
 * `source` — версия, из которой содержимое выведено (правка, копия): по ней
 * ссылки условий показа на варианты переводятся на варианты новой версии.
 * Без неё значения условий пишутся как пришли.
 */
export async function createVersion(
  surveyId: string,
  content: Content,
  createdBy: string | null,
  note?: string,
  source?: ContentSource,
): Promise<string> {
  const { sections: inputSections = [], scales: inputScales = [], questions: inputQuestions = [] } = content;
  const versionId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    /*
     * Номер версии — под замком строки методики.
     *
     * max(version)+1 считался без замка: две правки, сохранённые разом
     * (два окна конструктора, конструктор и применение локальных норм),
     * читали один и тот же максимум, и вторая падала нарушением
     * уникальности (survey_id, version) — пятисоткой вместо понятного
     * ответа, после того как человек уже потратил время на правку.
     * Замок строки методики ставит их в очередь: вторая читает максимум
     * после коммита первой. Тот же замок и тот же приём у copyVersion
     * (участок submit): оба пути выделения номера обязаны быть одинаковыми,
     * иначе они гонялись бы друг с другом.
     *
     * Замок держится до конца транзакции запроса (здесь — точка сохранения
     * внутри неё), то есть до коммита всей правки.
     */
    await tx.select({ id: surveys.id }).from(surveys).where(eq(surveys.id, surveyId)).for("update");
    const [{ next } = { next: 1 }] = await tx
      .select({ next: sql<number>`coalesce(max(${surveyVersions.version}), 0)::int + 1` })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, surveyId));

    try {
      await tx
        .insert(surveyVersions)
        .values({ id: versionId, surveyId, version: next, note: note ?? null, createdBy });
    } catch (error) {
      /*
       * Страховка: номер выделил кто-то, кто замка не брал (прямой скрипт,
       * будущий путь). Это конфликт одновременных правок, а не сбой сервера,
       * — и отвечается он как конфликт.
       */
      if (isVersionNumberClash(error)) conflict("err.surveyVersionConflict");
      throw error;
    }

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
        minAnsweredShare: scale.minAnsweredShare ?? null,
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
          /*
           * Каскад полосы — назначение батареи и повторные замеры.
           *
           * Схема и конструктор их принимали, а запись здесь молча
           * выбрасывала: каждое сохранение методики в конструкторе снимало
           * настроенные назначения по полосе, и человек с тяжёлой полосой
           * больше не получал углублённого обследования — без единого
           * сообщения об этом.
           */
          cascadeBatteryId: band.cascadeBatteryId ?? null,
          cascadeDueDays: band.cascadeDueDays ?? null,
          followUpDays: band.followUpDays?.trim() || null,
          position: bandIndex,
        });
      }
    }

    // первый проход: вопросы и варианты, запоминаем id по индексу для логики
    const questionIdByIndex: string[] = [];
    // id вариантов по индексу вопроса — для перевода ссылок условий (remapOptionRefs)
    const optionIdsByIndex: string[][] = [];
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
        minLabel: normalizeLocalized(question.minLabel),
        maxLabel: normalizeLocalized(question.maxLabel),
        randomizeOptions: question.randomizeOptions,
        timeLimitSec: question.timeLimitSec ?? null,
        riskThreshold: question.riskThreshold ?? null,
        riskLabel: normalizeLocalized(question.riskLabel),
        riskSeverity: question.riskSeverity ?? null,
      });

      optionIdsByIndex[index] = [];
      for (const [optionIndex, option] of question.options.entries()) {
        const optionId = crypto.randomUUID();
        optionIdsByIndex[index]!.push(optionId);
        await tx.insert(options).values({
          id: optionId,
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

    /*
     * Место варианта в своём вопросе в исходной версии: вариант прежней
     * версии переводится на вариант с тем же местом в вопросе-источнике
     * условия. По месту, а не по тексту — тексты правят, и как раз в правке.
     * Порядок вариантов у перенесённого вопроса тот же по построению
     * (versionContent), у присланного клиентом — тот, что он видел.
     */
    const positionOf = new Map<string, number>();
    for (const q of source?.questions ?? []) q.options.forEach((o, i) => positionOf.set(o.id, i));

    // второй проход: логика ссылается на вопросы по индексу, поэтому только
    // после вставки всех вопросов
    for (const [index, question] of inputQuestions.entries()) {
      for (const rule of question.logic) {
        const sourceId = questionIdByIndex[rule.sourceIndex];
        if (!sourceId) continue;
        const resolve = (id: string) => {
          const position = positionOf.get(id);
          return position === undefined ? undefined : optionIdsByIndex[rule.sourceIndex]?.[position];
        };
        await tx.insert(questionLogic).values({
          id: crypto.randomUUID(),
          questionId: questionIdByIndex[index]!,
          sourceQuestionId: sourceId,
          operator: rule.operator,
          value: remapOptionRefs(rule.value ?? null, resolve) ?? null,
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

/** Норма шкалы в том виде, в каком она лежит в scale_norms (без ключей) */
export interface NormValues {
  sex: "male" | "female" | null;
  ageMin: number | null;
  ageMax: number | null;
  mean: number;
  sd: number;
  source: string | null;
}

/**
 * Новая версия — точная копия действующей, с правкой только того, что
 * просили (волна 12, участок submit).
 *
 * Применение локальных норм делало новую версию через surveyToDraft — то
 * есть через ЭКСПОРТ: преобразование, которое по своему назначению
 * выбрасывает всё, что не должно уехать в чужое учреждение или не имеет
 * смысла в файле. Секции, условия показа, обратный ключ пунктов, порядок
 * вариантов, лимиты времени, привязка пунктов к шкалам, каскады полос,
 * локальные нормы других шкал — после «обновить нормы шкалы L» методика
 * теряла всё это разом, и новая версия, по которой дальше считались все
 * сдачи, была другой методикой. Обратный ключ, потерянный на депрессивной
 * шкале, переворачивает её: тяжёлое состояние считалось бы лёгким.
 *
 * Поэтому копия идёт по строкам базы, а не через формат обмена: каждая
 * строка содержимого переносится целиком (`...row`), меняются только
 * собственные идентификаторы и ссылки на них. Новая колонка, добавленная
 * в таблицу содержимого завтра, переедет сама — перечислять поля здесь
 * значило бы однажды забыть одно, как забыл экспорт.
 *
 * Правка сейчас одна — нормы: `edit.norms(code, текущие)` возвращает новый
 * полный список норм шкалы или undefined, если шкалу не трогаем.
 *
 * Действующая версия читается под замком строки методики: копировать надо
 * ту, что действует в момент записи, а не ту, что действовала, когда
 * считали кандидатов, — иначе правка конструктора, сохранённая между ними,
 * молча откатилась бы.
 */
export async function copyVersion(
  surveyId: string,
  createdBy: string | null,
  note: string,
  edit: { norms?: (scaleCode: string, current: NormValues[]) => NormValues[] | undefined } = {},
): Promise<string> {
  const versionId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ from: surveys.currentVersionId })
      .from(surveys)
      .where(eq(surveys.id, surveyId))
      .for("update");
    const from = locked?.from;
    if (!from) throw new Error(`copyVersion: у методики ${surveyId} нет действующей версии`);

    const [{ next } = { next: 1 }] = await tx
      .select({ next: sql<number>`coalesce(max(${surveyVersions.version}), 0)::int + 1` })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, surveyId));
    await tx.insert(surveyVersions).values({ id: versionId, surveyId, version: next, note, createdBy });

    const fresh = () => crypto.randomUUID();
    const remap = (map: Map<string, string>, id: string | null) => (id === null ? null : (map.get(id) ?? null));

    /* секции и шкалы — первыми: на них ссылаются пункты */
    const sectionRows = await tx.select().from(sections).where(eq(sections.versionId, from));
    const sectionMap = new Map(sectionRows.map((r) => [r.id, fresh()]));
    for (const row of sectionRows) {
      await tx.insert(sections).values({ ...row, id: sectionMap.get(row.id)!, versionId });
    }

    const scaleRows = await tx.select().from(scales).where(eq(scales.versionId, from));
    const scaleMap = new Map(scaleRows.map((r) => [r.id, fresh()]));
    for (const row of scaleRows) {
      await tx.insert(scales).values({ ...row, id: scaleMap.get(row.id)!, versionId });
    }

    const questionRows = await tx.select().from(questions).where(eq(questions.versionId, from));
    const questionMap = new Map(questionRows.map((r) => [r.id, fresh()]));
    for (const row of questionRows) {
      await tx.insert(questions).values({
        ...row,
        id: questionMap.get(row.id)!,
        versionId,
        sectionId: remap(sectionMap, row.sectionId),
        scaleId: remap(scaleMap, row.scaleId),
      });
    }

    const oldQuestionIds = [...questionMap.keys()];
    const oldScaleIds = [...scaleMap.keys()];

    const optionRows = oldQuestionIds.length
      ? await tx.select().from(options).where(inArray(options.questionId, oldQuestionIds))
      : [];
    const optionMap = new Map(optionRows.map((r) => [r.id, fresh()]));
    for (const row of optionRows) {
      await tx.insert(options).values({ ...row, id: optionMap.get(row.id)!, questionId: questionMap.get(row.questionId)! });
    }

    /*
     * Условие показа сравнивает ответ с ИДЕНТИФИКАТОРОМ варианта (eq,
     * contains — lib/scoring, evaluateRule), а варианты в новой версии
     * получили новые. Значение, указывающее на вариант исходной версии,
     * переводится на его копию; число и текст остаются как есть.
     */
    const remapValue = (value: unknown): unknown => {
      if (typeof value === "string") return optionMap.get(value) ?? value;
      if (Array.isArray(value)) return value.map(remapValue);
      return value;
    };
    const logicRows = oldQuestionIds.length
      ? await tx.select().from(questionLogic).where(inArray(questionLogic.questionId, oldQuestionIds))
      : [];
    for (const row of logicRows) {
      await tx.insert(questionLogic).values({
        ...row,
        id: fresh(),
        questionId: questionMap.get(row.questionId)!,
        sourceQuestionId: questionMap.get(row.sourceQuestionId) ?? row.sourceQuestionId,
        value: remapValue(row.value),
      });
    }

    if (oldScaleIds.length) {
      const bandRows = await tx.select().from(scaleBands).where(inArray(scaleBands.scaleId, oldScaleIds));
      for (const row of bandRows) {
        // каскад (cascadeBatteryId) — ссылка на батарею этого же учреждения, и она едет как есть
        await tx.insert(scaleBands).values({ ...row, id: fresh(), scaleId: scaleMap.get(row.scaleId)! });
      }

      const itemRows = await tx.select().from(scaleItems).where(inArray(scaleItems.scaleId, oldScaleIds));
      for (const row of itemRows) {
        const questionId = questionMap.get(row.questionId);
        if (!questionId) continue;
        await tx.insert(scaleItems).values({ ...row, scaleId: scaleMap.get(row.scaleId)!, questionId });
      }

      const correctionRows = await tx
        .select()
        .from(scaleCorrections)
        .where(inArray(scaleCorrections.targetScaleId, oldScaleIds));
      for (const row of correctionRows) {
        const sourceScaleId = scaleMap.get(row.sourceScaleId);
        if (!sourceScaleId) continue;
        await tx
          .insert(scaleCorrections)
          .values({ ...row, targetScaleId: scaleMap.get(row.targetScaleId)!, sourceScaleId });
      }

      const normRows = await tx.select().from(scaleNorms).where(inArray(scaleNorms.scaleId, oldScaleIds));
      const codeOf = new Map(scaleRows.map((r) => [r.id, r.code]));
      for (const scale of scaleRows) {
        const own = normRows.filter((n) => n.scaleId === scale.id);
        const replaced = edit.norms?.(
          codeOf.get(scale.id)!,
          own.map(({ sex, ageMin, ageMax, mean, sd, source }) => ({ sex, ageMin, ageMax, mean, sd, source })),
        );
        if (replaced) {
          for (const norm of replaced) {
            await tx.insert(scaleNorms).values({ ...norm, id: fresh(), scaleId: scaleMap.get(scale.id)! });
          }
        } else {
          for (const row of own) {
            await tx.insert(scaleNorms).values({ ...row, id: fresh(), scaleId: scaleMap.get(scale.id)! });
          }
        }
      }

      const stenTableRows = await tx.select().from(stenRows).where(inArray(stenRows.scaleId, oldScaleIds));
      for (const row of stenTableRows) {
        await tx.insert(stenRows).values({ ...row, id: fresh(), scaleId: scaleMap.get(row.scaleId)! });
      }
    }

    // действующей — последней операцией, как в createVersion
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
 * пунктов, поправки по кодам. Ожидает raw-представление
 * (getSurvey(..., raw = true)).
 *
 * ТОЛЬКО для выгрузки наружу. Преобразование по назначению теряет то, что
 * не должно или не может уехать в файл (локальные нормы, ссылки каскадов,
 * секции, условия показа, обратный ключ), и «прочитать → изменить →
 * сохранить новой версией» через него портит методику — так применение
 * локальных норм и теряло всё это до волны 12. Правка своей же методики
 * идёт через copyVersion.
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
      /*
       * Своя доля ответов шкалы, ниже которой балл не вычисляется (участок
       * engine, миграция 0101). Правило подсчёта, а не местная настройка:
       * без него у получателя шкала считалась бы по общей доле. Приведение —
       * до слияния с веткой engine, где поле есть в Scale.
       */
      minAnsweredShare: (s as { minAnsweredShare?: number | null }).minAnsweredShare ?? null,
      /*
       * Ключ выводится по номерам пунктов, а не в том порядке, в каком его
       * вернула база.
       *
       * Для подсчёта порядок не значит ничего — ключ хранится множеством
       * строк, — но файл методики возят между учреждениями и сравнивают:
       * выгрузка, которая при каждом запуске переставляет строки, делает
       * любое сравнение бессмысленным. «Изменилась методика или только
       * порядок» — вопрос, на который человек отвечать не должен.
       */
      key: s.items
        .flatMap((i) => {
          const item = indexById.get(i.questionId);
          return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
        })
        .sort((a, b) => a.item - b.item),
      corrections: s.corrections.map((x) => ({ from: x.sourceScaleCode, coefficient: x.coefficient })),
      /*
       * Нормы из пособия переносятся, нормы местной выборки — нет.
       *
       * T-балл значит разное относительно мирной популяции и относительно
       * своего госпиталя. Норма, посчитанная по выборке одного учреждения и
       * молча уехавшая в другое, означает, что второе учреждение считает
       * своих людей по чужой популяции и об этом не знает. Норма из пособия
       * общая для всех — она и едет.
       *
       * Различает их поле source: локальные помечены «локальная выборка,
       * N=…». Отбрасываем по нему, а не по флагу: флаг пришлось бы
       * проставлять руками, и однажды его забыли бы.
       */
      norms: s.norms.filter((n) => !String(n.source ?? "").startsWith("локальная выборка")),
      stenTable: s.stenTable,
      bands: s.bands.map((b) => ({
        minScore: b.minScore,
        maxScore: b.maxScore,
        label: b.label,
        severity: b.severity,
        description: b.description,
        grade: b.grade,
        recommendation: b.recommendation,
        /*
         * Ссылка на батарею НЕ переносится.
         *
         * Идентификатор батареи принадлежит своему экземпляру; в чужом он
         * либо не найдётся, либо — что хуже — найдётся и укажет на другую
         * батарею. Автоматика назначения по полосе настраивается на месте, и
         * пустое поле честнее случайного попадания.
         */
        cascadeBatteryId: null,
        cascadeDueDays: b.cascadeDueDays,
        followUpDays: b.followUpDays,
      })),
    })),
  };
  return draft;
}

