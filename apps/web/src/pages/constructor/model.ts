import type { Administration, SurveyFull, SurveyGroupWithCounts, UiKey } from "@quizzy/shared";

export type Tab = "basics" | "questions" | "scales" | "json";

/** Черновик методики в том же виде, какой принимает API */
export interface Draft {
  title: Record<string, string>;
  description?: Record<string, string> | null;
  instructions?: Record<string, string> | null;
  groupId?: string | null;
  administration: Administration;
  visibility: "public" | "restricted";
  scoringEnabled: boolean;
  allowRetake: boolean;
  showProgress: boolean;
  allowBack: boolean;
  anonymous: boolean;
  randomizeQuestions: boolean;
  timeLimitSec?: number | null;
  tooFastMs?: number | null;
  alertEscalateMinutes?: number | null;
  safetyPlan?: Record<string, string> | null;
  showResultsToPatient?: boolean;
  sections: unknown[];
  questions: DraftQuestion[];
  scales: DraftScale[];
}

export interface DraftQuestion {
  /**
   * Идентификатор строки списка на время правки.
   *
   * Ключом React был порядковый номер, и при удалении пункта его место
   * занимал следующий: поле ввода оставалось тем же узлом DOM, курсор — в
   * нём, а текст в нём — уже от другого вопроса. На сервер не уходит.
   */
  uid: string;
  type: string;
  title: Record<string, string>;
  help?: Record<string, string> | null;
  required: boolean;
  options: {
    text: Record<string, string>;
    score?: number;
    keyCode?: string | null;
    riskFlag?: boolean;
    riskLabel?: Record<string, string> | null;
    riskSeverity?: "moderate" | "severe" | null;
  }[];
}

export interface DraftScale {
  /** См. DraftQuestion.uid — то же для списка шкал */
  uid: string;
  code: string;
  title: Record<string, string>;
  kind: "clinical" | "validity";
  normalization: "raw" | "ratio" | "tscore" | "sten";
  aggregation?: "sum" | "average" | "count";
  ratioDenominator?: number | null;
  validityThreshold?: number | null;
  validityDirection?: "above" | "below" | null;
  validityMessage?: Record<string, string> | null;
  key: { item: number; matchKey?: string | null; weight?: number }[];
  corrections: { from: string; coefficient: number }[];
  norms: { sex?: "male" | "female" | null; mean: number; sd: number }[];
  stenTable: { rawMin: number; rawMax: number; sten: number }[];
  bands: {
    minScore: number;
    maxScore: number;
    label: Record<string, string>;
    severity: "none" | "mild" | "moderate" | "severe";
    grade?: number | null;
    recommendation?: Record<string, string> | null;
    cascadeBatteryId?: string | null;
    cascadeDueDays?: number | null;
    followUpDays?: string | null;
  }[];
}

export const EMPTY: Draft = {
  title: { uk: "", ru: "" },
  administration: "self",
  visibility: "public",
  scoringEnabled: true,
  allowRetake: false,
  showProgress: true,
  allowBack: true,
  anonymous: false,
  randomizeQuestions: false,
  sections: [],
  questions: [],
  scales: [],
};

/*
 * Виды вопросов: код и ключ подписи.
 *
 * Подпись была написана здесь по-русски и уезжала на экран как есть — в
 * конструкторе на украинском выпадающий список видов оставался русским.
 * Файл живёт вне разметки, поэтому первая редакция проверки строк его не
 * видела: она смотрела только .tsx.
 */
export const TYPES = [
  ["yesno", "qt.yesno"],
  ["single", "qt.single"],
  ["multiple", "qt.multiple"],
  ["scale", "qt.scale"],
  ["slider", "qt.slider"],
  ["matrix", "qt.matrix"],
  ["ranking", "qt.ranking"],
  ["number", "qt.number"],
  ["text", "qt.text"],
  ["longtext", "qt.longtext"],
  ["date", "qt.date"],
  ["info", "qt.info"],
] as const satisfies readonly (readonly [string, UiKey])[];

/** Приводит методику из API к черновику: строки уже могут быть объектами языков */
export function toDraft(s: SurveyFull, groups: SurveyGroupWithCounts[]): Draft {
  const loc = (v: unknown): Record<string, string> =>
    typeof v === "string" ? { ru: v } : ((v ?? {}) as Record<string, string>);
  const indexById = new Map(s.questions.map((q, i) => [q.id, i + 1]));

  return {
    title: loc(s.title),
    description: s.description ? loc(s.description) : null,
    instructions: s.instructions ? loc(s.instructions) : null,
    groupId: s.groupId ?? groups[0]?.id ?? null,
    administration: s.administration,
    visibility: s.visibility,
    scoringEnabled: s.scoringEnabled,
    allowRetake: s.allowRetake,
    showProgress: s.showProgress,
    allowBack: s.allowBack,
    anonymous: s.anonymous,
    randomizeQuestions: s.randomizeQuestions,
    timeLimitSec: s.timeLimitSec,
    tooFastMs: s.tooFastMs,
    alertEscalateMinutes: s.alertEscalateMinutes,
    sections: [],
    questions: s.questions.map((q) => ({
      uid: q.id,
      type: q.type,
      title: loc(q.title),
      help: q.help ? loc(q.help) : null,
      required: q.required,
      options: q.options.map((o) => ({
        text: loc(o.text),
        score: o.score,
        keyCode: o.keyCode,
        riskFlag: o.riskFlag,
        riskLabel: o.riskLabel ? loc(o.riskLabel) : null,
        riskSeverity: o.riskSeverity,
      })),
    })),
    scales: s.scales.map((sc) => ({
      uid: sc.id,
      code: sc.code,
      title: loc(sc.title),
      kind: sc.kind,
      normalization: sc.normalization,
      aggregation: sc.aggregation,
      ratioDenominator: sc.ratioDenominator,
      validityThreshold: sc.validityThreshold,
      validityDirection: sc.validityDirection,
      validityMessage: sc.validityMessage ? loc(sc.validityMessage) : null,
      key: sc.items.flatMap((i) => {
        const item = indexById.get(i.questionId);
        return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
      }),
      corrections: sc.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
      norms: sc.norms.map((n) => ({ sex: n.sex, mean: n.mean, sd: n.sd })),
      stenTable: sc.stenTable.map((r) => ({ rawMin: r.rawMin, rawMax: r.rawMax, sten: r.sten })),
      bands: sc.bands.map((b) => ({
        minScore: b.minScore,
        maxScore: b.maxScore,
        label: loc(b.label),
        severity: b.severity,
        grade: b.grade,
        recommendation: b.recommendation ? loc(b.recommendation) : null,
      })),
    })),
  };
}


export function parseItems(input: string): number[] {
  const out: number[] = [];
  for (const chunk of input.split(/[,\s]+/).filter(Boolean)) {
    const range = chunk.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(i);
    } else if (/^\d+$/.test(chunk)) {
      out.push(Number(chunk));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}



/** Свежий идентификатор строки конструктора */
export function newUid(): string {
  return crypto.randomUUID();
}

/**
 * Черновик в том виде, в каком его принимает API.
 *
 * uid — вспомогательное поле редактора, на сервере ему делать нечего: там
 * идентификаторы выдаются заново при каждой новой версии.
 */
export function toPayload(draft: Draft): Omit<Draft, "questions" | "scales"> & {
  questions: Omit<DraftQuestion, "uid">[];
  scales: Omit<DraftScale, "uid">[];
} {
  const { questions, scales, ...rest } = draft;
  return {
    ...rest,
    questions: questions.map(({ uid: _q, ...q }) => q),
    scales: scales.map(({ uid: _s, ...sc }) => sc),
  };
}

/**
 * Восстановление черновика из localStorage: сохранённый до появления uid
 * (или руками правленный) их не имеет — проставляем, иначе список снова
 * поедет по индексам.
 */
export function withUids(draft: Draft): Draft {
  return {
    ...draft,
    questions: draft.questions.map((q) => (q.uid ? q : { ...q, uid: newUid() })),
    scales: draft.scales.map((sc) => (sc.uid ? sc : { ...sc, uid: newUid() })),
  };
}

/**
 * Черновик как готовая методика — для проверки ключа прямо в редакторе.
 *
 * Перенос методики из пособия проверялся только после публикации: заполнить,
 * сдать, посмотреть баллы, вернуться в конструктор. Здесь тот же самый движок
 * подсчёта, что и на сервере (`computeProfile` из общего пакета), считает по
 * черновику — значит проверка отвечает на вопрос «верен ли ключ», а не «верна
 * ли ещё одна реализация ключа».
 *
 * Идентификаторы синтетические: у черновика их нет, а ключ ссылается на пункты
 * по номеру. Номер и становится идентификатором — ровно так же, как это делает
 * сервер при сохранении версии.
 */
export function draftToSurvey(draft: Draft, lang: "uk" | "ru"): SurveyFull {
  const text = (value: Record<string, string> | null | undefined): string =>
    value?.[lang] || value?.uk || value?.ru || "";

  const questions = draft.questions.map((q, i) => ({
    id: `q${i + 1}`,
    surveyId: "draft",
    versionId: "draft",
    type: q.type as never,
    title: text(q.title),
    help: q.help ? text(q.help) : null,
    required: q.required,
    position: i,
    sectionId: null,
    randomizeOptions: false,
    minValue: null,
    maxValue: null,
    step: null,
    logic: [],
    options: q.options.map((o, k) => ({
      id: `q${i + 1}o${k + 1}`,
      questionId: `q${i + 1}`,
      kind: "option" as const,
      text: text(o.text),
      score: o.score ?? 0,
      keyCode: o.keyCode ?? null,
      riskFlag: o.riskFlag ?? false,
      riskLabel: o.riskLabel ? text(o.riskLabel) : null,
      riskSeverity: o.riskSeverity ?? null,
      position: k,
    })),
  }));

  const scales = draft.scales.map((sc, i) => ({
    id: `s${i + 1}`,
    surveyId: "draft",
    code: sc.code,
    title: text(sc.title),
    description: null,
    aggregation: (sc.aggregation ?? "sum") as never,
    position: i,
    kind: sc.kind as never,
    normalization: sc.normalization as never,
    ratioDenominator: sc.ratioDenominator ?? null,
    validityThreshold: sc.validityThreshold ?? null,
    validityDirection: (sc.validityDirection ?? null) as never,
    validityMessage: sc.validityMessage ? text(sc.validityMessage) : null,
    bands: sc.bands.map((b) => ({
      minScore: b.minScore,
      maxScore: b.maxScore,
      label: text(b.label),
      severity: b.severity as never,
      grade: b.grade ?? null,
      recommendation: b.recommendation ? text(b.recommendation) : null,
      cascadeBatteryId: b.cascadeBatteryId ?? null,
      cascadeDueDays: b.cascadeDueDays ?? null,
      followUpDays: b.followUpDays ?? null,
    })),
    /*
     * Ключ ссылается на пункт по номеру. Ссылка за пределы списка — не повод
     * падать: в редакторе пункт могли только что удалить, и проверка обязана
     * это показать, а не сломаться.
     */
    items: sc.key
      .filter((k) => k.item >= 1 && k.item <= questions.length)
      .map((k) => ({
        questionId: `q${k.item}`,
        matchKey: k.matchKey ?? null,
        weight: k.weight ?? 1,
      })),
    corrections: sc.corrections.map((c) => ({
      sourceScaleCode: c.from,
      coefficient: c.coefficient,
    })),
    norms: sc.norms.map((n) => ({
      sex: n.sex ?? null,
      ageMin: null,
      ageMax: null,
      mean: n.mean,
      sd: n.sd,
      source: null,
    })),
    stenTable: sc.stenTable,
  }));

  return {
    id: "draft",
    groupId: draft.groupId ?? null,
    title: text(draft.title),
    description: draft.description ? text(draft.description) : null,
    instructions: draft.instructions ? text(draft.instructions) : null,
    safetyPlan: draft.safetyPlan ? text(draft.safetyPlan) : null,
    administration: draft.administration,
    status: "draft",
    visibility: draft.visibility,
    scoringEnabled: draft.scoringEnabled,
    allowRetake: draft.allowRetake,
    showProgress: draft.showProgress,
    allowBack: draft.allowBack,
    anonymous: draft.anonymous,
    randomizeQuestions: draft.randomizeQuestions,
    timeLimitSec: draft.timeLimitSec ?? null,
    tooFastMs: draft.tooFastMs ?? null,
    alertEscalateMinutes: draft.alertEscalateMinutes ?? null,
    showResultsToPatient: draft.showResultsToPatient ?? false,
    sections: [],
    questions,
    scales,
    versionId: null,
    versionNumber: 0,
  } as unknown as SurveyFull;
}
