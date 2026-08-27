import type { SurveyFull, SurveyGroupWithCounts } from "@quizzy/shared";

export type Tab = "basics" | "questions" | "scales" | "json";

/** Черновик методики в том же виде, какой принимает API */
export interface Draft {
  title: Record<string, string>;
  description?: Record<string, string> | null;
  instructions?: Record<string, string> | null;
  groupId?: string | null;
  administration: "self" | "clinician";
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

export const TYPES = [
  ["yesno", "Да / Нет"],
  ["single", "Один ответ"],
  ["multiple", "Несколько"],
  ["scale", "Шкала"],
  ["slider", "Ползунок"],
  ["matrix", "Матрица"],
  ["ranking", "Ранжирование"],
  ["number", "Число"],
  ["text", "Строка"],
  ["longtext", "Текст"],
  ["date", "Дата"],
  ["info", "Информация"],
] as const;

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
