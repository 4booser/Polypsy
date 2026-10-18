import type { BatteryAssignment, SurveyGroupWithCounts, SurveyListItem, SurveyResponse } from "@quizzy/shared";

/**
 * Данные вкладки «Опитування» — без react-native, проверяется тестом.
 *
 * Группы методик (`/api/groups`) — справочник консоли: единица
 * разграничения доступа, по ней сотрудник видит каталог разложенным по
 * отделениям. Вкладка брала их у всех, и сервер отвечал пациенту 403
 * «Доступно лише співробітникам». Запросы шли одним Promise.all, отказ
 * групп ронял его целиком — и пациент вместо списка методик видел только
 * эту строку (прод, волна 25).
 *
 * Поэтому здесь два правила:
 *  — пациенту служебный справочник не запрашивается вовсе: ему список
 *    раскладывается по смыслу «назначено / пройдено / можно самому», а не
 *    по группам консоли;
 *  — ни один вспомогательный запрос не роняет список: группы, батареи и
 *    свои прохождения — украшение; без методик экран показывает ошибку, но
 *    батареи, если они пришли, остаются на месте.
 */
export interface SurveysTabApi {
  listSurveys: () => Promise<SurveyListItem[]>;
  myBatteries: () => Promise<BatteryAssignment[]>;
  listGroups: () => Promise<SurveyGroupWithCounts[]>;
  myResponses: () => Promise<SurveyResponse[]>;
}

export interface SurveysTabData {
  surveys: SurveyListItem[];
  /** Методики не пришли: экран говорит об этом, а не показывает «назначенного нет» */
  surveysFailed: boolean;
  /** Незакрытые батареи — закрытые на вкладке не нужны */
  batteries: BatteryAssignment[];
  /** Группы — только у сотрудника; у пациента всегда пусто */
  groups: SurveyGroupWithCounts[];
  /** Свои сданные прохождения — у пациента, для «Пройдені» */
  responses: SurveyResponse[];
}

export async function loadSurveysTab(api: SurveysTabApi, who: { staff: boolean }): Promise<SurveysTabData> {
  const [surveys, batteries, groups, responses] = await Promise.all([
    api.listSurveys().then(
      (rows) => ({ rows, failed: false }),
      () => ({ rows: [] as SurveyListItem[], failed: true }),
    ),
    api.myBatteries().catch(() => [] as BatteryAssignment[]),
    who.staff ? api.listGroups().catch(() => [] as SurveyGroupWithCounts[]) : Promise.resolve([]),
    who.staff ? Promise.resolve([]) : api.myResponses().catch(() => [] as SurveyResponse[]),
  ]);
  return {
    surveys: surveys.rows,
    surveysFailed: surveys.failed,
    batteries: batteries.filter((b) => !b.completedAt && b.doneRequired < b.totalRequired),
    groups,
    responses,
  };
}

/** Строка «Пройдені»: методика и последнее своё прохождение по ней */
export interface DoneItem {
  survey: SurveyListItem;
  /** Последняя сдача; null — сервер отметил «пройдено», но прохождения в списке нет (анонимная методика) */
  last: SurveyResponse | null;
  /** Сдача перед последней — для «було N» */
  before: SurveyResponse | null;
}

/**
 * Вкладки пациента.
 *
 * Назначенное отдельно от общедоступного, и порядок именно такой:
 * назначенное от человека ждут, и у него срок; общедоступное он проходит,
 * если захочет. Методики, уже показанные в батарее, из списков убираются —
 * иначе одна карточка встречается дважды и порядок прохождения теряется.
 */
export function patientTabs(data: Pick<SurveysTabData, "surveys" | "batteries" | "responses">): {
  assigned: SurveyListItem[];
  done: DoneItem[];
  self: SurveyListItem[];
} {
  const inBattery = new Set(data.batteries.flatMap((b) => b.steps.map((s) => s.surveyId)));
  const loose = data.surveys.filter((s) => !inBattery.has(s.id));
  const assigned = loose.filter((s) => s.assigned && !s.completedByMe);
  const assignedIds = new Set(assigned.map((s) => s.id));

  const completed = data.responses
    .filter((r) => r.status === "completed" && r.submittedAt)
    .sort((a, b) => (a.submittedAt! < b.submittedAt! ? 1 : -1));
  const bySurvey = new Map<string, SurveyResponse[]>();
  for (const r of completed) bySurvey.set(r.surveyId, [...(bySurvey.get(r.surveyId) ?? []), r]);

  const done = data.surveys
    .filter((s) => s.completedByMe || bySurvey.has(s.id))
    .map((survey) => {
      const own = bySurvey.get(survey.id) ?? [];
      return { survey, last: own[0] ?? null, before: own[1] ?? null };
    })
    .sort((a, b) => ((a.last?.submittedAt ?? "") < (b.last?.submittedAt ?? "") ? 1 : -1));

  // «самостійно» — то, что можно пройти по своей воле: не назначенное и ещё не пройденное
  const self = loose.filter((s) => !assignedIds.has(s.id) && !s.completedByMe && !s.assigned);
  return { assigned, done, self };
}

/**
 * Код методики из её названия: «Тривога (GAD-7)» → «GAD-7».
 *
 * Отдельного поля с кодом у методики нет, а название каталога пишется по
 * одному правилу — смысл, потом код в скобках. Нет скобок или в них не код
 * (длинная фраза) — кода нет, и строка рисуется значком, а не выдуманной
 * аббревиатурой.
 */
export function codeOf(title: string): { name: string; code: string | null } {
  const whole = title.trim();
  const m = /^(.*\S)\s*\(([^()]{1,48})\)$/.exec(whole);
  if (!m) return { name: whole, code: null };
  // в скобках бывает и пояснение: «SRQ-20, ВООЗ», «Копенгагенський опитувальник, CBI» — код любой из частей
  const code = m[2]!
    .split(",")
    .map((part) => part.trim())
    .find((part) => /^[A-Z][A-Za-z0-9.\-]{1,11}$/.test(part));
  return code ? { name: m[1]!, code } : { name: whole, code: null };
}

/** Шаг набора, который человек проходит сам: не за специалиста и не снятый с использования */
function ownStep(step: BatteryAssignment["steps"][number]): boolean {
  return step.administration !== "clinician" && step.state !== "retired";
}

/**
 * Место методики в незакрытом наборе — перед началом: «Крок 1 з 4 у наборі
 * „Перед сесією 6“», и что дальше. Методика не в наборе — null: тогда и
 * строки нет, а не «крок 1 з 1».
 */
export function placeInSet(
  sets: BatteryAssignment[],
  surveyId: string,
): { title: string; index: number; total: number; next: string[] } | null {
  for (const set of sets) {
    if (set.completedAt || set.cancelledAt) continue;
    const steps = set.steps.filter(ownStep);
    const index = steps.findIndex((s) => s.surveyId === surveyId);
    if (index < 0) continue;
    const next = steps
      .slice(index + 1)
      .filter((s) => s.state !== "done")
      .map((s) => codeOf(s.title).code ?? s.title);
    return { title: set.batteryTitle, index, total: steps.length, next };
  }
  return null;
}

/**
 * Что пройти следующим после сдачи — «Далі: GAD-7». Следующий по порядку
 * несданный свой шаг того же набора; за ним — несданный раньше (пропущенный
 * необязательный). Ничего не осталось — null, и кнопка ведёт к списку.
 */
export function nextInSet(sets: BatteryAssignment[], surveyId: string): { surveyId: string; title: string } | null {
  for (const set of sets) {
    if (set.cancelledAt) continue;
    const steps = set.steps.filter(ownStep);
    const index = steps.findIndex((s) => s.surveyId === surveyId);
    if (index < 0) continue;
    const pending = (s: (typeof steps)[number]) => s.state !== "done" && s.surveyId !== surveyId;
    const next = steps.slice(index + 1).find(pending) ?? steps.slice(0, index).find(pending);
    return next ? { surveyId: next.surveyId, title: next.title } : null;
  }
  return null;
}
