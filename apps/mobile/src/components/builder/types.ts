import type { QuestionType, ScaleAggregation, Severity } from "@quizzy/shared";

/** Черновики редактора: числа держим строками, пока пользователь печатает */
export interface DraftOption {
  key: string;
  text: string;
  score: string;
  kind: "option" | "row";
  /** Выбор варианта поднимает тревогу немедленно */
  riskFlag: boolean;
  riskLabel: string;
  riskSeverity: "moderate" | "severe";
}

export interface DraftBand {
  key: string;
  minScore: string;
  maxScore: string;
  label: string;
  severity: Severity;
  description: string;
}

export interface DraftScale {
  key: string;
  code: string;
  title: string;
  description: string;
  aggregation: ScaleAggregation;
  bands: DraftBand[];
}

export interface DraftSection {
  key: string;
  title: string;
  description: string;
}

export interface DraftLogic {
  key: string;
  sourceIndex: number;
  operator: "eq" | "contains" | "answered" | "not_answered" | "gt" | "lt";
  value: string;
  action: "show" | "hide";
}

export interface DraftQuestion {
  key: string;
  type: QuestionType;
  title: string;
  help: string;
  required: boolean;
  sectionKey: string | null;
  scaleCode: string | null;
  reverseScored: boolean;
  minValue: string;
  maxValue: string;
  step: string;
  minLabel: string;
  maxLabel: string;
  randomizeOptions: boolean;
  timeLimitSec: string;
  /** Для числовых вопросов: значение не ниже порога поднимает тревогу */
  riskThreshold: string;
  riskLabel: string;
  riskSeverity: "moderate" | "severe";
  options: DraftOption[];
  logic: DraftLogic[];
}

export const TYPE_LABEL: Record<QuestionType, string> = {
  single: "Один ответ",
  multiple: "Несколько",
  scale: "Шкала",
  slider: "Ползунок",
  matrix: "Матрица",
  ranking: "Ранжирование",
  yesno: "Да / Нет",
  number: "Число",
  text: "Строка",
  longtext: "Текст",
  date: "Дата",
  info: "Информация",
};

export const NEEDS_OPTIONS: QuestionType[] = ["single", "multiple", "matrix", "ranking", "yesno"];
export const NEEDS_RANGE: QuestionType[] = ["scale", "slider", "number"];
export const SCORABLE: QuestionType[] = [
  "single",
  "multiple",
  "matrix",
  "yesno",
  "scale",
  "slider",
  "number",
];

let counter = 0;
export const newKey = () => `k${Date.now().toString(36)}${(counter++).toString(36)}`;

export function emptyOption(kind: "option" | "row" = "option"): DraftOption {
  return { key: newKey(), text: "", score: "0", kind, riskFlag: false, riskLabel: "", riskSeverity: "severe" };
}

export function emptyQuestion(type: QuestionType = "single"): DraftQuestion {
  return {
    key: newKey(),
    type,
    title: "",
    help: "",
    required: true,
    sectionKey: null,
    scaleCode: null,
    reverseScored: false,
    minValue: type === "scale" ? "1" : "0",
    maxValue: type === "scale" ? "5" : "10",
    step: "1",
    minLabel: "",
    maxLabel: "",
    randomizeOptions: false,
    timeLimitSec: "",
    riskThreshold: "",
    riskLabel: "",
    riskSeverity: "severe",
    options: NEEDS_OPTIONS.includes(type)
      ? type === "yesno"
        ? [
            { ...emptyOption(), text: "Да", score: "1" },
            { ...emptyOption(), text: "Нет", score: "0" },
          ]
        : type === "matrix"
          ? [emptyOption("option"), emptyOption("option"), emptyOption("row")]
          : [emptyOption(), emptyOption()]
      : [],
    logic: [],
  };
}

export function emptyScale(): DraftScale {
  return {
    key: newKey(),
    code: "",
    title: "",
    description: "",
    aggregation: "sum",
    bands: [],
  };
}

export function emptyBand(): DraftBand {
  return { key: newKey(), minScore: "0", maxScore: "0", label: "", severity: "none", description: "" };
}
