/**
 * superadmin — видит все группы и назначает их администраторов.
 * admin      — работает только со своими группами.
 * user       — проходит методики.
 */
/** Языки, на которых ведутся методики */
export type Lang = "uk" | "ru";
export const LANGS: Lang[] = ["uk", "ru"];

/**
 * Локализованный текст. Хранится как объект языков, а не как строка:
 * пособия дают каждую методику и на украинском, и на русском, и это один
 * и тот же пункт, а не две разные методики.
 */
export type LocalizedText = Partial<Record<Lang, string>>;

/**
 * В базе контент хранится локализованно, а API отдаёт его уже разрешённым
 * на запрошенном языке. Так потребители — мобилка, консоль, заключения —
 * работают с обычными строками и ничего не знают о языках,
 * а мультиязычность живёт в одном слое.
 */

/** Достаёт текст на нужном языке, откатываясь на любой доступный */
export function t(text: LocalizedText | string | null | undefined, lang: Lang = "uk"): string {
  if (text === null || text === undefined) return "";
  if (typeof text === "string") return text;
  return text[lang] ?? text[lang === "uk" ? "ru" : "uk"] ?? Object.values(text)[0] ?? "";
}

export type Role = "superadmin" | "admin" | "user";

/** Администратор, назначенный на группу */
export interface GroupAdmin {
  userId: string;
  fullName: string;
  email: string;
  addedAt: string;
  addedBy: string | null;
}

/** Типы вопросов. info — не вопрос, а информационный блок между вопросами. */
export type QuestionType =
  | "single"
  | "multiple"
  | "scale"
  | "slider"
  | "matrix"
  | "ranking"
  | "yesno"
  | "number"
  | "text"
  | "longtext"
  | "date"
  | "info";

export type SurveyStatus = "draft" | "published" | "closed" | "archived";

/** Как складываются вклады пунктов в сырой балл субшкалы */
export type ScaleAggregation = "sum" | "average" | "count";

/**
 * Во что превращается сырой балл.
 * raw    — остаётся как есть;
 * ratio  — доля от максимума (Sr = N/35, L = N/10);
 * tscore — T-балл по норме пола и возраста: 50 + 10·(X − M)/δ;
 * sten   — стен по таблице перевода.
 */
export type ScaleNormalization = "raw" | "ratio" | "tscore" | "sten";

/**
 * clinical — содержательная шкала;
 * validity — шкала достоверности: её результат не интерпретируется сам по себе,
 *            а решает, можно ли доверять профилю целиком.
 */
export type ScaleKind = "clinical" | "validity";

/** Направление, в котором значение шкалы достоверности делает профиль недостоверным */
export type ValidityDirection = "above" | "below";

/**
 * Вклад пункта в шкалу.
 *
 * matchKey задан — работает «ключ»: пункт даёт weight баллов, если выбран вариант
 * с этим кодом («Да» или «Нет»). Так устроены СР-45, МЛО, Мини-мульт.
 * matchKey не задан — берётся балл выбранного варианта или числовой ответ.
 */
export interface ScaleItem {
  questionId: string;
  matchKey: string | null;
  weight: number;
}

/** Поправка одной шкалы на другую: Hs = Hs + 0,5·K в Мини-мульте */
export interface ScaleCorrection {
  sourceScaleCode: string;
  coefficient: number;
}

/** Норма для перевода в T-баллы: среднее и стандартное отклонение по выборке */
export interface ScaleNorm {
  sex: Sex | null;
  ageMin: number | null;
  ageMax: number | null;
  mean: number;
  sd: number;
  /** Происхождение: «пособие НПС, 2016» или «локальная выборка, N=213» */
  source: string | null;
}

/** Строка таблицы перевода сырых баллов в стены */
export interface StenRow {
  sex: Sex | null;
  ageMin: number | null;
  ageMax: number | null;
  rawMin: number;
  rawMax: number;
  sten: number;
}

/**
 * Степень выраженности признака в интерпретационной норме.
 * Ровно четыре ступени: они ложатся один-в-один на зарезервированные статусные
 * роли дизайн-системы (good / warning / serious / critical), поэтому цвет
 * выраженности никогда не конкурирует с цветами серий на графиках.
 */
export type Severity = "none" | "mild" | "moderate" | "severe";

export type ResponseStatus = "in_progress" | "completed" | "abandoned";

export type LogicOperator =
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "answered"
  | "not_answered";

export type LogicAction = "show" | "hide";

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  /** Готовое отображаемое имя — собирается на сервере, чтобы не разъезжалось */
  fullName: string;

  /** Псевдонимизированный аккаунт: ФИО не хранится, показывается код */
  anonymous: boolean;
  pseudonym: string | null;

  /** Паспортная часть: нужна для норм по полу и возрасту и для заключения */
  sex: Sex | null;
  birthDate: string | null;
  unit: string | null;
  position: string | null;
  specialty: string | null;
  rank: string | null;

  role: Role;
  createdAt: string;
}

export type Sex = "male" | "female";

/** Возраст на конкретную дату — считается на момент обследования */
export function ageAt(birthDate: string | null, at: string | null): number | null {
  if (!birthDate || !at) return null;
  const born = new Date(birthDate);
  const when = new Date(at);
  if (Number.isNaN(born.getTime()) || Number.isNaN(when.getTime())) return null;
  let age = when.getFullYear() - born.getFullYear();
  const monthDiff = when.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && when.getDate() < born.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** Кому выдан доступ к методике */
export interface SurveyGrant {
  userId: string;
  fullName: string;
  email: string;
  grantedBy: string | null;
  grantedByName: string | null;
  grantedAt: string;
  expiresAt: string | null;
  note: string | null;
  /** Проходил ли уже */
  completed: boolean;
}

/** Группа опросов — батарея методик (например «Приёмное отделение») */
export interface SurveyGroup {
  id: string;
  title: string;
  description: string | null;
  color: string | null;
  position: number;
  createdBy: string;
  createdAt: string;
}

export interface SurveyGroupWithCounts extends SurveyGroup {
  surveyCount: number;
  publishedCount: number;
  responseCount: number;
  /** Заполняется только для суперадмина — обычный админ чужих админов не видит */
  admins: GroupAdmin[];
}

export type RiskSeverity = "moderate" | "severe";

export interface Option {
  id: string;
  questionId: string;
  text: string;
  /**
   * Код варианта для ключа: «yes» / «no» у методик с ответами да/нет.
   * Ключ ссылается на код, а не на порядок вариантов — порядок может
   * перемешиваться, а смысл ответа нет.
   */
  keyCode: string | null;
  /** Балл, который даёт этот вариант при подсчёте субшкалы */
  score: number;
  position: number;
  /** row — строка матричного вопроса, option — вариант ответа */
  kind: "option" | "row";
  /** Выбор поднимает тревогу немедленно */
  riskFlag: boolean;
  riskLabel: string | null;
  riskSeverity: RiskSeverity | null;
}

export interface SurveyVersion {
  id: string;
  surveyId: string;
  version: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Сколько прохождений собрано на этой версии */
  responseCount: number;
}

/** Тревога по критическому пункту */
export interface RiskAlert {
  id: string;
  responseId: string;
  surveyId: string;
  surveyTitle: string;
  questionId: string;
  questionTitle: string;
  userId: string | null;
  respondent: string | null;
  label: string;
  severity: RiskSeverity;
  at: string;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  note: string | null;
  /** Сколько минут тревога висит неразобранной */
  minutesOpen: number;
  /** Просрочена ли по правилу эскалации методики */
  overdue: boolean;
}

/** Условие показа вопроса, зависящее от ответа на другой вопрос */
export interface LogicRule {
  id: string;
  questionId: string;
  sourceQuestionId: string;
  operator: LogicOperator;
  /** JSON: id варианта, число или строка — зависит от оператора */
  value: unknown;
  action: LogicAction;
}

export interface Question {
  id: string;
  surveyId: string;
  sectionId: string | null;
  type: QuestionType;
  title: string;
  /** Пояснение под заголовком */
  help: string | null;
  required: boolean;
  position: number;

  /** Субшкала, в которую идёт балл за этот вопрос */
  scaleId: string | null;
  /** Обратный ключ: балл инвертируется относительно максимума шкалы */
  reverseScored: boolean;

  /** scale / slider / number */
  minValue: number | null;
  maxValue: number | null;
  step: number | null;
  minLabel: string | null;
  maxLabel: string | null;

  randomizeOptions: boolean;
  /** Лимит времени на вопрос, секунды */
  timeLimitSec: number | null;

  /** Для числовых вопросов: значение не ниже порога поднимает тревогу */
  riskThreshold: number | null;
  riskLabel: string | null;
  riskSeverity: RiskSeverity | null;

  options: Option[];
  logic: LogicRule[];
}

export interface Section {
  id: string;
  surveyId: string;
  title: string;
  description: string | null;
  position: number;
}

/** Интерпретационная норма: диапазон баллов → вывод */
export interface ScaleBand {
  id: string;
  scaleId: string;
  minScore: number;
  maxScore: number;
  label: string;
  severity: Severity;
  description: string | null;
  /**
   * Порядковая оценка методики. Отдельно от severity, потому что у части
   * методик шкала оценок перевёрнута: у СР-45 «1» — худший результат, «5» — лучший.
   */
  grade: number | null;
  /** Что делать: от амбулаторного наблюдения до обязательной госпитализации */
  recommendation: string | null;
  position: number;
}

/** Субшкала методики (тревога, депрессия, соматизация...) */
export interface Scale {
  id: string;
  surveyId: string;
  code: string;
  title: string;
  description: string | null;
  aggregation: ScaleAggregation;
  position: number;

  kind: ScaleKind;
  normalization: ScaleNormalization;
  /** Знаменатель для ratio: 35 у Sr, 10 у шкалы лжи */
  ratioDenominator: number | null;
  /** Порог недостоверности и сторона, с которой он нарушается */
  validityThreshold: number | null;
  validityDirection: ValidityDirection | null;
  validityMessage: string | null;

  bands: ScaleBand[];
  items: ScaleItem[];
  corrections: ScaleCorrection[];
  norms: ScaleNorm[];
  stenTable: StenRow[];
}

export interface Survey {
  id: string;
  groupId: string | null;
  title: string;
  description: string | null;
  /** Инструкция, показывается перед первым вопросом */
  instructions: string | null;
  /**
   * Кто заполняет: сам респондент или специалист за него.
   * SAD PERSONS, шкалы Бека и структурированные интервью заполняет клиницист.
   */
  administration: Administration;
  /** Порог «слишком быстрого» ответа, мс. null — берётся значение по умолчанию */
  tooFastMs: number | null;
  /** Через сколько минут неразобранная тревога просрочена. null — эскалации нет */
  alertEscalateMinutes: number | null;
  /** Немедленные действия при критическом ответе; показывается после сдачи при тревоге */
  safetyPlan: string | null;
  /** Пациент видит свою динамику по этой методике */
  showResultsToPatient: boolean;
  /** Демонстрационная: не для клинического применения */
  isDemo: boolean;
  status: SurveyStatus;

  timeLimitSec: number | null;
  randomizeQuestions: boolean;
  allowBack: boolean;
  showProgress: boolean;
  /** Не связывать прохождение с пользователем */
  anonymous: boolean;
  /** public — видна всем пациентам, restricted — только по персональному назначению */
  visibility: "public" | "restricted";
  /** Разрешить повторные прохождения — нужно для отслеживания динамики */
  allowRetake: boolean;
  scoringEnabled: boolean;

  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface SurveyFull extends Survey {
  sections: Section[];
  questions: Question[];
  scales: Scale[];
  /** Версия, содержимое которой отдано в этом ответе */
  versionId: string | null;
  versionNumber: number;
}

/** Нормативное сравнение: где балл относительно накопленной выборки */
export interface NormComparison {
  scaleId: string;
  /** Доля выборки со строго меньшим баллом, 0–100 */
  percentile: number;
  sampleSize: number;
  sampleMean: number;
  sampleMedian: number;
}

/** Точка динамики пациента по одной субшкале */
export interface DynamicsPoint {
  responseId: string;
  submittedAt: string;
  rawScore: number;
  maxScore: number;
  percent: number;
  bandLabel: string | null;
  severity: Severity | null;
  percentile: number | null;
}

export interface ScaleDynamics {
  scaleId: string;
  code: string;
  title: string;
  points: DynamicsPoint[];
  /** Изменение между первым и последним замером */
  delta: number | null;
  /** Направление: улучшение зависит от того, что шкала измеряет */
  direction: "up" | "down" | "flat" | null;
  /**
   * Достоверность сдвига первый↔последний (Jacobson–Truax).
   * null — посчитать нельзя: мало выборки для SD или альфы. Это честный
   * ответ, а не ноль: без ошибки измерения сдвиг не интерпретируем.
   */
  reliableChange: {
    rci: number;
    significant: boolean;
    direction: "up" | "down" | "flat";
    /** На чём основан расчёт — видно в подсказке */
    basis: { sd: number; alpha: number; sampleN: number };
  } | null;
}

export interface RespondentDynamics {
  userId: string;
  fullName: string;
  email: string;
  surveys: {
    surveyId: string;
    title: string;
    responseCount: number;
    firstAt: string | null;
    lastAt: string | null;
    scales: ScaleDynamics[];
  }[];
}

export interface SurveyListItem extends Survey {
  questionCount: number;
  responseCount: number;
  /** Проходил ли текущий пользователь */
  completedByMe: boolean;
}

/** Ответ на один вопрос вместе с телеметрией */
export interface Answer {
  questionId: string;
  optionIds?: string[];
  text?: string;
  number?: number;
  date?: string;
  /** matrix: { rowId: optionId } */
  matrix?: Record<string, string>;
  /** ranking: упорядоченный список id вариантов */
  ranking?: string[];
  skipped?: boolean;

  /** Телеметрия, снимается на клиенте */
  durationMs?: number;
  /** Сколько раз респондент менял ответ перед отправкой */
  changeCount?: number;
  /** Сколько раз возвращался к вопросу */
  visitCount?: number;
}

export interface AnswerEvent {
  questionId: string;
  sequence: number;
  kind: "shown" | "set" | "change" | "clear" | "leave";
  elapsedMs: number;
  at: string;
  value?: unknown;
}

export interface SubmitResponsePayload {
  answers: Answer[];
  startedAt: string;
  durationMs: number;
  status?: "completed" | "abandoned";
  events: AnswerEvent[];
}

/** Рассчитанный балл по субшкале для конкретного прохождения */
export interface ScoreResult {
  scaleId: string;
  scaleCode: string;
  scaleTitle: string;
  kind: ScaleKind;
  /** Сумма вкладов пунктов до поправок и нормирования */
  rawScore: number;
  /** После поправок от других шкал (K-коррекция) */
  correctedScore: number;
  /** Итоговое значение: доля, T-балл или стен — по нормировке шкалы */
  value: number;
  normalization: ScaleNormalization;
  maxScore: number;
  /** Процент от максимума, 0–100 */
  percent: number;
  band: {
    label: string;
    severity: Severity;
    description: string | null;
    grade: number | null;
    recommendation: string | null;
  } | null;
  /** Для шкал достоверности: нарушен ли порог */
  validityFailed?: boolean;
}

/** Итог по прохождению целиком с учётом шкал достоверности */
export interface ProfileResult {
  scores: ScoreResult[];
  /**
   * Можно ли доверять профилю. Если шкала достоверности вышла за порог,
   * содержательные шкалы всё равно считаются, но помечаются как ненадёжные —
   * решение об исключении принимает специалист, а не программа.
   */
  reliable: boolean;
  warnings: string[];
}

export interface SurveyResponse {
  id: string;
  surveyId: string;
  versionNumber?: number;
  userId: string | null;
  userName: string | null;
  status: ResponseStatus;
  startedAt: string;
  submittedAt: string | null;
  durationMs: number;
  scores: ScoreResult[];
}

/* ─────────────── Аналитика ─────────────── */

export interface QuestionAnalytics {
  questionId: string;
  title: string;
  type: QuestionType;
  position: number;

  shown: number;
  answered: number;
  skipped: number;
  skipRate: number;

  /** Время на вопрос, миллисекунды */
  avgDurationMs: number;
  medianDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  /** Среднее число смен ответа — маркер сложных/неоднозначных формулировок */
  avgChangeCount: number;
  /** Среднее время до первого выбора: сколько думали, прежде чем ответить */
  avgTimeToFirstAnswerMs: number;
  /** Доля респондентов, менявших ответ хотя бы раз */
  changedShare: number;
  /** Доля ответов быстрее порога — признак небрежного заполнения */
  tooFastShare: number;

  /**
   * Распределение по вариантам.
   * percent для single/multiple/yesno — доля респондентов, для matrix — доля от всех
   * заполненных ячеек (респондент отвечает на каждую строку, поэтому база другая).
   * Для ranking вместо доли осмысленна средняя позиция в ранжировании.
   */
  options?: { optionId: string; text: string; count: number; percent: number; avgRank?: number }[];
  /** Числовые вопросы: scale/slider/number */
  numeric?: {
    average: number;
    median: number;
    min: number;
    max: number;
    /** Гистограмма: значение → количество */
    distribution: { value: number; count: number }[];
  };
  /** Свободные ответы */
  texts?: string[];
}

/** Психометрика одного пункта относительно его субшкалы */
export interface ItemStat {
  questionId: string;
  title: string;
  /** Корреляция пункта с суммой остальных пунктов шкалы (исправленная) */
  itemTotalCorrelation: number;
  /**
   * Альфа шкалы без этого пункта: рост означает, что пункт вредит согласованности.
   * null для шкалы из двух пунктов — там величина не определена.
   */
  alphaIfDeleted: number | null;
  variance: number;
}

/** Надёжность субшкалы */
export interface Reliability {
  /** Альфа Кронбаха: внутренняя согласованность, 0–1 */
  alpha: number;
  itemCount: number;
  items: ItemStat[];
}

/** Признаки небрежного заполнения у одного прохождения */
export interface QualityFlags {
  responseId: string;
  respondent: string | null;
  submittedAt: string | null;
  durationMs: number;
  /** Доля вопросов, отвеченных быстрее порога */
  tooFastShare: number;
  /** Самая длинная серия одинаковых ответов подряд */
  longestStraightLine: number;
  flagged: boolean;
  reasons: string[];
}

export interface ScaleAnalytics {
  scaleId: string;
  code: string;
  title: string;
  average: number;
  median: number;
  min: number;
  max: number;
  maxPossible: number;
  /** Сколько прохождений попало в каждую интерпретационную полосу */
  bands: { label: string; severity: Severity; count: number; percent: number }[];
  /** null, если пунктов меньше двух или нет разброса ответов */
  reliability: Reliability | null;
}

export interface SurveyAnalytics {
  surveyId: string;
  title: string;
  /** Версия, по которой посчитаны срезы */
  versionId: string | null;
  versionNumber: number;
  /** Все версии с числом прохождений — для переключателя */
  versions: { id: string; version: number; responseCount: number; note: string | null }[];
  /** Кто прямо сейчас в процессе: черновики со свежим автосохранением */
  inProgressNow: { userName: string | null; startedAt: string; lastSavedAt: string; answered: number }[];

  started: number;
  completed: number;
  abandoned: number;
  completionRate: number;

  avgDurationMs: number;
  medianDurationMs: number;

  /** На каком вопросе люди бросают прохождение */
  dropOff: { questionId: string; title: string; position: number; reached: number; lost: number }[];

  questions: QuestionAnalytics[];
  scales: ScaleAnalytics[];
  /** Прохождения с признаками небрежного заполнения */
  quality: QualityFlags[];
  /** Порог «слишком быстрого» ответа, миллисекунды */
  tooFastThresholdMs: number;
  /** Прохождения по дням для графика динамики */
  timeline: { date: string; count: number }[];
}

/** Кто заполняет методику: сам обследуемый или специалист */
export type Administration = "self" | "clinician";

/** Батарея: набор методик, назначаемый целиком */
export interface BatteryItem {
  surveyId: string;
  title: string;
  position: number;
  required: boolean;
  /**
   * Кто заполняет. Батарея может смешивать режимы: скрининг заполняет
   * клиницист, основной опросник — обследуемый. Обследуемому такой шаг видно,
   * но открыть его он не может, поэтому режим обязан доезжать до экрана.
   */
  administration: Administration;
  questionCount: number;
  /** Ориентировочная длительность по фактическим прохождениям, минут */
  medianMinutes: number | null;
}

export interface Battery {
  id: string;
  title: string;
  description: string | null;
  groupId: string | null;
  groupTitle: string | null;
  strictOrder: boolean;
  archived: boolean;
  createdAt: string;
  items: BatteryItem[];
  /** Сколько активных назначений висит на батарее */
  activeAssignments: number;
}

export type BatteryProgressState = "done" | "current" | "locked" | "available";

export interface BatteryStep extends BatteryItem {
  state: BatteryProgressState;
  responseId: string | null;
  submittedAt: string | null;
}

export interface BatteryAssignment {
  id: string;
  batteryId: string;
  batteryTitle: string;
  userId: string;
  userName: string;
  assignedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  note: string | null;
  /** Просрочено: срок прошёл, а обязательные методики не пройдены */
  overdue: boolean;
  doneRequired: number;
  totalRequired: number;
  steps: BatteryStep[];
}

/** Сеанс киоска: групповое обследование на одном устройстве */
export interface KioskSession {
  id: string;
  title: string;
  batteryId: string;
  batteryTitle: string;
  expiresAt: string;
  closedAt: string | null;
  createdAt: string;
  createdByName: string;
  participants: KioskParticipantState[];
}

export interface KioskParticipantState {
  id: string;
  displayName: string;
  startedAt: string;
  finishedAt: string | null;
  doneRequired: number;
  totalRequired: number;
}

/** Что видит устройство киоска по своему токену */
export interface KioskState {
  valid: boolean;
  reason?: "expired" | "closed" | "unknown";
  title?: string;
  batteryTitle?: string;
  steps?: { surveyId: string; title: string; questionCount: number; required: boolean; administration: Administration }[];
}

/** Приглашение: вход пациента по ссылке или короткому коду */
export interface Invite {
  id: string;
  /** Короткий код для ручного ввода (показывается только при создании и в списке staff) */
  code: string;
  batteryId: string | null;
  batteryTitle: string | null;
  unit: string | null;
  note: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  createdByName: string;
  /** Кто вошёл по приглашению */
  uses: { userId: string; fullName: string; usedAt: string }[];
}

/** Что видит человек, открывший ссылку, до регистрации */
export interface InvitePreview {
  valid: boolean;
  reason?: "expired" | "revoked" | "exhausted" | "unknown";
  batteryTitle?: string | null;
  unit?: string | null;
}

/** Динамика самого пациента — то, что он видит о себе */
export interface MyDynamics {
  surveys: {
    surveyId: string;
    title: string;
    scales: {
      code: string;
      title: string;
      points: { submittedAt: string; value: number; bandLabel: string | null; severity: Severity | null }[];
    }[];
  }[];
}

/** Расписание повторных обследований */
export type ScheduleScope = "unit" | "users";

export interface ScheduleRun {
  id: string;
  ranAt: string;
  assigned: number;
  skipped: number;
  note: string | null;
}

export interface Schedule {
  id: string;
  title: string;
  batteryId: string;
  batteryTitle: string;
  scope: ScheduleScope;
  unit: string | null;
  intervalDays: number;
  dueDays: number;
  startsAt: string;
  endsAt: string | null;
  active: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
  /** Поимённый список для scope = users */
  targets: { userId: string; fullName: string }[];
  /** Сколько человек охватит ближайшее срабатывание */
  reach: number;
  runs: ScheduleRun[];
}

/** Срез сравнения: одна когорта по одной субшкале */
export interface CohortStat {
  cohort: string;
  n: number;
  mean: number;
  median: number;
  sd: number;
  min: number;
  max: number;
  /** Распределение по интерпретационным нормам */
  bands: { label: string; severity: Severity; count: number; percent: number }[];
}

export interface ScaleComparison {
  scaleId: string;
  code: string;
  title: string;
  /** Максимум сырого балла — для шкал без нормализации */
  maxScore: number;
  /** В каких единицах лежит value: от этого зависит шкала оси */
  normalization: ScaleNormalization;
  cohorts: CohortStat[];
}

export type CohortBy = "unit" | "sex" | "ageGroup" | "month" | "rank";

export interface ComparisonResult {
  surveyId: string;
  title: string;
  by: CohortBy;
  /** Сколько прохождений не попало ни в одну когорту: поле не заполнено */
  unclassified: number;
  scales: ScaleComparison[];
}

/** Корреляция между двумя субшкалами */
export interface ScaleCorrelation {
  a: string;
  b: string;
  r: number;
  n: number;
}

export interface CorrelationMatrix {
  surveyId: string;
  title: string;
  codes: string[];
  titles: Record<string, string>;
  pairs: ScaleCorrelation[];
  /** Минимальное число наблюдений, ниже которого коэффициент не считается */
  minSample: number;
}

/** Сводка по всем опросам — для главного экрана аналитики */
export interface OverviewAnalytics {
  surveyCount: number;
  publishedCount: number;
  responseCount: number;
  respondentCount: number;
  avgDurationMs: number;
  completionRate: number;
  /** Топ методик по числу прохождений */
  topSurveys: { surveyId: string; title: string; responseCount: number; avgDurationMs: number }[];
  /** Распределение по степени выраженности across всех шкал */
  severityBreakdown: { severity: Severity; count: number }[];
  timeline: { date: string; count: number }[];
}

export interface AuthPayload {
  /** Одноразовый refresh-токен: хранить в защищённом хранилище */
  refreshToken: string;
  token: string;
  user: User;
}

/** Запись журнала доступа */
export interface AuditEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: Role | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  subjectUserId: string | null;
  outcome: "success" | "denied" | "error";
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  /** Сколько записей пропущено — для постраничной выдачи */
  offset: number;
  limit: number;
}
