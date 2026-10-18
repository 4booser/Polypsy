import {
  isQuestionVisible,
  itemContribution,
  questionScoreRange,
  scaleMaxScore,
  type Answer,
  type SurveyFull,
} from "@quizzy/shared";
import { api } from "../api";

/**
 * Ввод методики специалистом (Administer.tsx): какая версия и что уходит.
 *
 * Бумажный бланк печатают пачкой заранее, и его код ведёт сюда с номером
 * версии — `…/administer?v=N` (BlankForm.tsx, SheetCode). Экран номер не
 * читал (#169): грузилась и сдавалась действующая версия. Методику правили
 * после печати — ответы бланка vN ложились на пункты v(N+1) и считались по
 * её ключу, а быстрый ввод по порядку переносил их на чужие пункты молча.
 */

/** Номер версии из `?v=` — целое от единицы; нет или мусор — действующая версия */
export function blankVersion(raw: string | null): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 ? n : undefined;
}

/**
 * Методика той версии, что на бланке. Версии нет — отказ сервера
 * (err.surveyVersionNotFound) показывается как ошибка загрузки, а не
 * подменяется действующей.
 *
 * Пациентов здесь нет: первая сотня без поиска прятала остальных (#174) —
 * выбор ищет их на сервере сам (components/PatientPicker.tsx).
 */
export async function loadAdminister(id: string, version: number | undefined): Promise<{ survey: SurveyFull }> {
  return { survey: await api.survey(id, version) };
}

/** Тело сдачи за пациента */
export function administerPayload(
  survey: SurveyFull,
  input: { subject: string; startedAt: string; answers: Map<string, Answer>; now?: number },
) {
  const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, input.answers));
  return {
    onBehalfOf: input.subject,
    // считается по той версии, пункты которой на экране (с бланка — его версия), а не по действующей на момент нажатия
    versionId: survey.versionId,
    startedAt: input.startedAt,
    durationMs: (input.now ?? Date.now()) - new Date(input.startedAt).getTime(),
    status: "completed" as const,
    events: [],
    /*
     * Только ответы на показанные пункты. Движок считает всё, что пришло,
     * а ответ на пункт, скрытый условием, остаётся в памяти формы: в ASSIST
     * специалист отметил «да» по веществу, заполнил частоту, потом исправил
     * «да» на «нет» — и балл по веществу, которого человек не употреблял,
     * ушёл бы в протокол. Пациентская форма (Runner) шлёт так же — только
     * видимые. Отвергнуто чистить ответы при смене условия: скрытый пункт
     * вернётся с прежним ответом, если специалист передумает обратно.
     */
    answers: [...input.answers.values()].filter((a) => visible.some((q) => q.id === a.questionId)),
  };
}

/** Предварительный подсчёт единственной содержательной шкалы — пока бланк не сдан */
export interface Preliminary {
  code: string;
  title: string;
  /** Сумма по уже отвеченным пунктам шкалы */
  sum: number;
  /** Какой может стать сумма, когда ответят оставшиеся пункты */
  min: number;
  max: number;
  /** Максимум шкалы */
  top: number;
  answered: number;
  items: number;
}

/**
 * «6 /27 поки що; за пунктами, що лишились, сума буде від 6 до 18».
 *
 * Только для простой суммы: одна содержательная шкала, агрегат «сумма», без
 * поправок от других шкал. Средние, счёт, поправки, нормирование и полосы
 * считает сервер при сохранении — их предварительный пересчёт здесь был бы
 * вторым движком, который однажды разойдётся с первым. Вклад пункта —
 * функцией движка (itemContribution) с ключом и весом; пункт, скрытый
 * условием, не задают — ни в сумму, ни в диапазон.
 */
export function preliminary(survey: SurveyFull, answers: Map<string, Answer>): Preliminary | null {
  const content = survey.scales.filter((s) => s.kind !== "validity");
  if (content.length !== 1) return null;
  const scale = content[0]!;
  if ((scale.aggregation ?? "sum") !== "sum" || scale.corrections.length) return null;
  const byId = new Map(survey.questions.map((q) => [q.id, q] as const));
  let sum = 0;
  let min = 0;
  let max = 0;
  let answered = 0;
  let items = 0;
  for (const item of scale.items) {
    const q = byId.get(item.questionId);
    if (!q || q.type === "info" || !isQuestionVisible(q, survey.questions, answers)) continue;
    items++;
    const got = itemContribution(q, item, answers.get(q.id));
    if (got !== null && Number.isFinite(got)) {
      answered++;
      sum += got;
      continue;
    }
    if (item.matchKey !== null) {
      min += Math.min(0, item.weight);
      max += Math.max(0, item.weight);
    } else {
      const r = questionScoreRange(q);
      min += Math.min(r.min * item.weight, r.max * item.weight);
      max += Math.max(r.min * item.weight, r.max * item.weight);
    }
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    code: scale.code,
    title: scale.title,
    sum: round(sum),
    min: round(sum + min),
    max: round(sum + max),
    top: round(scaleMaxScore(scale, survey.questions, survey.scales)),
    answered,
    items,
  };
}
