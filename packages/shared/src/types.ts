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
 * Названия языков — каждое на своём языке, и переводу не подлежат.
 *
 * «Українська» по-русски — это способ не найти украинский, когда интерфейс
 * уже переключился на непонятный. Поэтому здесь, а не в словаре: словарь по
 * определению возвращает одну строку на выбранном языке, а тут нужны все
 * сразу.
 *
 * Данными, а не литералом в разметке: иначе оба приложения держат свои
 * подписи, и проверке «строки только через словарь» приходится делать для
 * них исключение — а исключение на файл прячет и всё остальное в этом файле.
 */
export const LANG_NAMES: Record<Lang, { full: string; short: string }> = {
  uk: { full: "Українська", short: "УКР" },
  ru: { full: "Русский", short: "РУС" },
};

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

export type SurveyStatus = "draft" | "published" | "closed";

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

  /**
   * Кто ведёт человека. Закрепляется явно, а не выводится из последнего
   * приёма: иначе визит к коллеге на замене молча переназначал бы ведущего.
   */
  leadSpecialistId?: string | null;

  /** Паспортная часть: нужна для норм по полу и возрасту и для заключения */
  sex: Sex | null;
  birthDate: string | null;
  unit: string | null;
  position: string | null;
  specialty: string | null;
  rank: string | null;

  role: Role;
  createdAt: string;
  /** Учётная запись работает только на просмотр: любые изменения запрещены */
  readOnly: boolean;
  /**
   * Связана ли учётная запись с Google.
   *
   * Только факт, без идентификатора: экрану нужно решить, показывать
   * «привязать» или «отвязать», а сам идентификатор ему для этого не нужен.
   */
  googleLinked: boolean;
  /**
   * Настройки рабочего места. Приходят вместе с профилем: отдельный запрос за
   * ними означал бы, что консоль на мгновение открывается не в той теме.
   */
  workspace?: WorkspacePrefs | null;
  /**
   * Ступень лестницы должностей: 0 — вне лестницы, выше — главнее.
   *
   * По ней консоль решает, показывать ли пункт «Права»: назначает только
   * тот, у кого есть кому назначать. Ограничением это не является —
   * правило живёт на маршрутах назначения и проверяется там.
   */
  ladderRank?: number;
}

export type Sex = "male" | "female";

/** Возраст на конкретную дату — считается на момент обследования */
/** Возрастная полоса для стратификации: "<25" | "25-34" | "35-44" | "45+" */
export function ageBandOf(age: number | null): string | null {
  if (age === null) return null;
  if (age < 25) return "<25";
  if (age < 35) return "25-34";
  if (age < 45) return "35-44";
  return "45+";
}

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
  /** Сколько попыток выдано; null — не ограничивали */
  attemptsAllowed: number | null;
  attemptsUsed: number;
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
  /**
   * Снята с использования: остаётся в списках и в аналитике, но не
   * предлагается при выборе группы для новой методики или батареи.
   */
  archivedAt: string | null;
}

export interface SurveyGroupWithCounts extends SurveyGroup {
  surveyCount: number;
  publishedCount: number;
  responseCount: number;
  /** Сколько людей вообще прошло хоть одну методику группы */
  patientCount: number;
  /** Сколько случаев риска по методикам группы сейчас не разобрано */
  openCaseCount: number;
  /** Кто ведёт группу. Приходит по доступным группам — чужих в списке нет */
  admins: GroupAdmin[];
  /**
   * Может ли читатель вести эту группу: заводить, снимать, назначать
   * администраторов.
   *
   * Считает сервер, а не экран. Экран проверял роль суперадмина — а право
   * `groups.manage` с тех пор стало выдаваемым, и заведующий отделением,
   * ради которого его заводили, кнопок не видел вовсе, хотя сервер его
   * пропускал. Роль на клиенте известна, состав прав — нет, поэтому ответ
   * приходит вместе с самой группой.
   */
  manageable: boolean;
}

/**
 * Аналитика группы: сколько людей, сколько прохождений, как распределены
 * степени выраженности.
 *
 * Отдельно от аналитики методики: заведующему нужен ответ про отделение
 * целиком, а не про один опросник, и складывать его из десяти запросов на
 * экране значит считать одно и то же разными способами.
 */
export interface GroupAnalytics {
  groupId: string;
  title: string;
  archivedAt: string | null;
  surveyCount: number;
  publishedCount: number;
  /** Начатых прохождений, включая брошенные */
  startedCount: number;
  /** Завершённых прохождений */
  responseCount: number;
  /** Разных людей среди завершённых прохождений */
  patientCount: number;
  /** Доля доведённых до конца, в процентах */
  completionRate: number;
  avgDurationMs: number;
  openCaseCount: number;
  /** Распределение по степеням выраженности — по содержательным шкалам */
  severityBreakdown: { severity: Severity; count: number }[];
  /** Разбивка по методикам группы: где именно набралось */
  surveys: {
    surveyId: string;
    title: string;
    status: SurveyStatus;
    archived: boolean;
    responseCount: number;
    patientCount: number;
    severityBreakdown: { severity: Severity; count: number }[];
  }[];
  /** Прохождения по дням — для линии динамики */
  timeline: { date: string; count: number }[];
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
  /** Пункт, поднявший тревогу; null у сигнала по полосе шкалы */
  questionId: string | null;
  /** Заголовок пункта, а у сигнала по шкале — название шкалы */
  questionTitle: string;
  userId: string | null;
  respondent: string | null;
  label: string;
  severity: RiskSeverity;
  at: string;
  acknowledgedBy: string | null;
  /** Клинический исход разбора; null — разобрана до внедрения исходов */
  outcome: "confirmed" | "not_confirmed" | "needs_followup" | null;
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
  /** Каскад: попадание в полосу назначает эту батарею */
  cascadeBatteryId: string | null;
  cascadeDueDays: number | null;
  /** Протокол наблюдения: «7,30» — повторы через неделю и месяц */
  followUpDays: string | null;
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
  /**
   * Правовой статус текста методики. README честно фиксировал, что тексты
   * требуют очистки прав перед клиническим применением, — но README не
   * мешает выдать методику пациенту.
   */
  rightsStatus?: "own" | "licensed" | "public_domain" | "unclear";
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
  /**
   * Методика снята с использования: не выдаётся, не проходится, не попадает
   * в батареи и киоск — но остаётся во всех уже собранных записях.
   */
  archivedAt?: string | null;
  archivedByName?: string | null;
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
  /**
   * Номер версии методики, которую человек реально видел.
   *
   * Скачок сразу после смены версии — часто артефакт правки ключей, а не
   * изменение состояния. Без этой отметки его читают как динамику.
   */
  versionNo?: number | null;
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
   * Стандартная ошибка одного измерения — полуширина полосы на графике.
   *
   * null, когда считать её не из чего: мала выборка для SD или не считается
   * альфа. Тогда полоса не рисуется вовсе — придуманный интервал хуже, чем
   * его отсутствие, потому что выглядит как знание.
   */
  sem?: number | null;
  /**
   * Коэффициенты приведения баллов старых версий к версии последнего замера.
   *
   * null — приводить нельзя или не нужно: одна версия, малая выборка,
   * нулевой разброс. Отдаются именно коэффициенты и размеры выборок, а не
   * готовые приведённые баллы: приведение опирается на допущение о
   * сопоставимости выборок, и решать, выполняется ли оно, должен человек.
   */
  equated?:
    | {
        fromVersion: number;
        toVersion: number;
        slope: number;
        intercept: number;
        fromN: number;
        toN: number;
      }[]
    | null;
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

/** Строка списка «кто проходил повторно» */
export interface Respondent {
  userId: string;
  fullName: string;
  email: string;
  /** Сколько завершённых прохождений */
  count: number;
  /** Дата последнего замера; null у прохождений без даты сдачи */
  last: string | null;
  /** Подразделение и пол — для фасетов списка */
  unit: string | null;
  sex: "male" | "female" | null;
}

export interface RespondentDynamics {
  userId: string;
  fullName: string;
  email: string;
  /**
   * Пол и возраст — для подсчёта норм на устройстве в режиме обхода.
   *
   * Возраст числом, а не датой рождения: для норм достаточно числа, а дата
   * рождения на планшете, который носят по отделению, — лишние сведения о
   * человеке без единого сценария, которому они нужны.
   */
  sex: Sex | null;
  age: number | null;
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
  /**
   * Назначена лично, а не просто доступна.
   *
   * Общедоступную методику человек проходит, если захочет; назначенную от
   * него ждут, и у неё есть срок. Одним списком без различия не видно ни
   * того ни другого.
   */
  assigned?: boolean;
  /** Срок назначения; null — не ограничивали */
  dueAt?: string | null;
  /** Когда ключи сверены с пособием */
  keysVerifiedAt?: string | null;
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
  /**
   * Удалось ли применить нормировку, объявленную шкалой.
   *
   * Ложь означает, что в `value` лежит сырой балл: нормы для этого пола нет,
   * балл вне таблицы стенов, знаменатель доли нулевой. Полосы интерпретации
   * и пороги достоверности заданы в единицах нормировки и к такому значению
   * не применяются — `band` будет null, а шкала достоверности объявит
   * протокол непроверяемым.
   */
  normalized: boolean;
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

/**
 * Прохождение целиком: ответы по пунктам, баллы, телеметрия.
 *
 * Варианты пункта приходят вместе с ответом, а не отдельным запросом за
 * методикой. Иначе читающий видит `optionIds` — набор идентификаторов, — и
 * чтобы узнать, что человек ответил, должен догрузить методику той версии,
 * которую тот проходил, и сопоставить руками. Ровно этого ему делать и не
 * следует: разбирающий смотрит на прохождение, чтобы прочитать ответы, а не
 * чтобы собрать их из двух источников.
 */
export interface ResponseDetail {
  id: string;
  survey: { id: string; title: string; scoringEnabled: boolean };
  status: ResponseStatus;
  startedAt: string;
  submittedAt: string | null;
  durationMs: number;
  scores: ScoreResult[];
  answers: ResponseDetailAnswer[];
}

export interface ResponseDetailAnswer {
  questionId: string;
  title: string;
  type: QuestionType;
  position: number;
  answered: boolean;
  optionIds: string[] | null;
  /** Варианты пункта в том виде, в каком их видел проходивший */
  options: {
    id: string;
    text: string;
    /** Выбор этого варианта поднимает тревогу немедленно */
    riskFlag: boolean;
    riskSeverity: RiskSeverity | null;
  }[];
  text: string | null;
  number: number | null;
  date: string | null;
  matrix: Record<string, string> | null;
  ranking: string[] | null;
  score: number | null;
  durationMs: number;
  changeCount: number;
  visitCount: number;
  events: { kind: string; elapsedMs: number; at: string; value: string | null }[];
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
  /**
   * Квартили времени ответа.
   *
   * Нужны потому, что min и max — это один самый быстрый и один самый
   * медленный человек, а не разброс: одного отвлёк телефон, и максимум по
   * пункту вырастает вчетверо. График, построенный по краям, показывает
   * выброс, а не то, сколько времени пункт занимает у людей.
   */
  p25DurationMs: number;
  p75DurationMs: number;
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
  /**
   * Нормированные ошибки Гуттмана (7.1): 0 — профиль согласован с трудностью
   * пунктов, ~0.5 — как случайный, ближе к 1 — инвертирован. null — шкала не
   * ключевая или профиль крайний (всё «да» / всё «нет»), где метрика слепа.
   */
  personFit: number | null;
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
  /**
   * Квартили итогового значения.
   *
   * Ящик с усами раньше строился из min/среднего/медианы/max, то есть его
   * коробка была квартилями четырёх сводных чисел, а не выборки. Рисунок
   * получался правдоподобным и неверным: коробка означала «между средним и
   * медианой», хотя читается она как «половина обследованных».
   */
  p25: number;
  p75: number;
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
/**
 * Кто заполняет методику.
 *
 * `informant` — короткая форма для командира, сослуживца или родственника.
 * Отдельный вид, а не второй способ заполнить ту же методику: смешивать
 * самоотчёт и наблюдение со стороны в одной выборке значит испортить и нормы,
 * и оценку надёжности.
 */
export type Administration = "self" | "clinician" | "informant";

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

/** Направление (6.4) */
export type ReferralDestination = "psychiatrist" | "inpatient" | "outpatient" | "commander" | "other";
export type ReferralUrgency = "routine" | "urgent" | "immediate";
export type ReferralStatus = "created" | "accepted" | "completed" | "declined";

export interface Referral {
  id: string;
  userId: string;
  userName: string;
  responseId: string | null;
  alertId: string | null;
  destination: ReferralDestination;
  urgency: ReferralUrgency;
  status: ReferralStatus;
  reason: string | null;
  outcomeNote: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string | null;
}

/** Сводка для консилиума (6.5): всё о пациенте на одной странице */
export interface CaseSummary {
  userId: string;
  fullName: string;
  sex: Sex | null;
  age: number | null;
  unit: string | null;
  surveys: {
    surveyId: string;
    title: string;
    lastAt: string | null;
    count: number;
    scales: {
      code: string;
      title: string;
      lastValue: number;
      normalization: ScaleNormalization;
      bandLabel: string | null;
      severity: Severity | null;
      /** Достоверность сдвига между первым и последним замером */
      reliableChange: { rci: number; significant: boolean; direction: "up" | "down" | "flat" } | null;
    }[];
  }[];
  openAlerts: { id: string; label: string; severity: string; at: string; surveyTitle: string }[];
  conclusions: { responseId: string; surveyTitle: string; text: string; signedAt: string | null; authorName: string }[];
  referrals: Referral[];
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
  /** Сырая доля высокого риска (moderate|severe) */
  rawRiskShare: number;
  /** Стандартизовано по полу×возрасту всей выборки методики; null — не посчитать */
  stdRiskShare: number | null;
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
  /**
   * Кто проходит методику прямо сейчас — черновики свежее получаса.
   * По методике такой список уже есть (`inProgressNow`); здесь он сводный,
   * чтобы дежурный видел всю картину не заходя в каждую методику.
   */
  inProgress: {
    responseId: string;
    userId: string | null;
    surveyId: string;
    surveyTitle: string;
    startedAt: string;
    lastSavedAt: string;
  }[];
}

/**
 * Степени выраженности по неделям — для области с накоплением.
 *
 * Неделя, а не день: результаты приходят неровно, и по дням ряд состоит из
 * нулей с одиночными всплесками — по такому графику не видно ни уровня, ни
 * направления. Неделя — самый короткий шаг, на котором в поликлинике
 * набирается осмысленное число обследований.
 *
 * Счётчики — по прохождениям, а не по шкалам: у методики с восемью
 * субшкалами одно обследование дало бы восемь отметок и перевесило бы
 * восемь обследований по короткому скринингу. Степень прохождения — самая
 * тяжёлая из его шкал: обследование, где хоть что-то тяжёлое, — это срочный
 * случай, а не «в среднем спокойный».
 */
export interface SeverityTrend {
  /** Понедельник недели, YYYY-MM-DD */
  week: string;
  none: number;
  mild: number;
  moderate: number;
  severe: number;
}

export interface SeverityTrendResult {
  weeks: SeverityTrend[];
  /** Сколько прохождений осталось без интерпретации: у шкал нет норм */
  unbanded: number;
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


/* ─────────── случаи риска ─────────── */

/**
 * Откуда взялся сигнал.
 *
 * Два вида, и путать их нельзя: `option` — человек отметил помеченный
 * вариант ответа, `band` — суммарный балл шкалы попал в полосу. У первого
 * есть пункт и отмеченный вариант, у второго — шкала, значение и границы
 * полосы. Общего поля «заголовок» им хватало ровно до вопроса «на каком
 * основании», который и задаёт разбирающий.
 */
export type AlertSignalKind = "option" | "band";

/** Один сигнал внутри случая: какой пункт сработал */
export interface AlertSignal {
  id: string;
  responseId: string;
  /**
   * Откуда сигнал. Приходит явно, а не выводится из `questionId`: экран
   * подписывает строку словом «пункт» или «шкала», и вычислять это из
   * пустоты соседнего поля значит однажды подписать неверно.
   */
  kind: AlertSignalKind;
  /** Пункт, поднявший тревогу; null у сигнала по полосе шкалы */
  questionId: string | null;
  /** Заголовок пункта, а у сигнала по шкале — название шкалы */
  questionTitle: string;
  label: string;
  severity: RiskSeverity;
  at: string;
}

/**
 * Основание сигнала целиком: по какой методике и какому ответу или полосе
 * шкалы система решила, что у человека риск.
 *
 * Приходит отдельным запросом, а не вместе с очередью: очередь показывает
 * тридцать случаев, а основание читают у одного, и тянуть ответы, варианты
 * и баллы на все тридцать значило бы платить за то, чего никто не смотрит.
 */
export interface AlertSignalBasis {
  id: string;
  kind: AlertSignalKind;
  responseId: string;
  /** Методика, по которой поднят сигнал — у случая их может быть несколько */
  surveyId: string;
  surveyTitle: string;
  /** Готовая подпись, записанная в момент срабатывания */
  label: string;
  severity: RiskSeverity;
  at: string;
  /** Прохождение целиком доступно только если методика в зоне ответственности */
  responseSubmittedAt: string | null;

  /* ── kind === "option" ── */
  questionId: string | null;
  /** Номер пункта в методике: по нему пункт ищут в бланке */
  questionNumber: number | null;
  questionTitle: string | null;
  /** Что человек отметил: тексты выбранных вариантов */
  pickedOptions: string[];
  /** Числовой ответ, если сигнал поднял порог по числу */
  answeredNumber: number | null;

  /* ── kind === "band" ── */
  scaleId: string | null;
  scaleCode: string | null;
  scaleTitle: string | null;
  /** Значение в единицах нормировки: стены, T-баллы, доля */
  scaleValue: number | null;
  scaleRawScore: number | null;
  normalization: ScaleNormalization | null;
  bandLabel: string | null;
  /** Границы полосы — чтобы видеть, насколько значение зашло внутрь */
  bandMin: number | null;
  bandMax: number | null;
  bandDescription: string | null;
  bandRecommendation: string | null;
}

/**
 * Случай риска — единица разбора.
 *
 * Тревога поднимается на пункт, но решение принимается о человеке: пять
 * отмеченных пунктов одного обследуемого — один случай.
 */
export interface AlertCase {
  id: string;
  userId: string;
  userName: string;
  unit: string | null;
  surveyId: string;
  surveyTitle: string;

  severity: RiskSeverity;
  openedAt: string;
  lastAlertAt: string;
  /** Сколько сигналов внутри */
  signalCount: number;
  /** Сигналы: приходят с самим случаем — их немного, и без них он бессмыслен */
  signals: AlertSignal[];

  /** Минут в открытом состоянии; для разобранных — сколько провисел */
  minutesOpen: number;
  /** Просрочен по настройке эскалации методики */
  overdue: boolean;

  assignedTo: string | null;
  assignedToName: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  note: string | null;
  outcome: AlertOutcome | null;
  /** Собран автоматически при переходе со старой модели, а не решением специалиста */
  mergedFromLegacy: boolean;
}

export type AlertOutcome = "confirmed" | "not_confirmed" | "needs_followup";

/** Страница списка: курсор вместо номера — список меняется прямо во время разбора */
export interface Page<T> {
  items: T[];
  /** null — больше ничего нет */
  nextCursor: string | null;
  /** Всего подходящих под фильтр; считается отдельно и только на первой странице */
  total?: number;
}

export interface AlertCaseFilters {
  /** Разобранные тоже */
  all?: boolean;
  severity?: RiskSeverity;
  unit?: string;
  /** "me" — мои, "none" — ничьи */
  assigned?: string;
  surveyId?: string;
  search?: string;
}


/** Одна строка очереди работы специалиста */
/**
 * Виды работы в очереди.
 *
 * Отдельный тип, а не строчный union внутри WorkItem: маршрут объявлял свой
 * список видов, клиент — свой, и разошлись они молча. Появилась неявка —
 * сервер начал её слать, а консоль не знала такого вида и рисовала строку
 * без названия. Теперь список один на обе стороны, и добавить вид только с
 * одной из них нельзя.
 */
export type WorkKind =
  | "noshow"
  | "message"
  | "dispensary"
  | "assignment"
  | "referral"
  | "followup";

export interface WorkItem {
  kind: WorkKind;
  id: string;
  userId: string;
  userName: string;
  unit: string | null;
  /** Для случая — название методики, для направления — его статус */
  title: string;
  /** Факты, а не готовая строка: отображение принадлежит клиенту */
  severity?: "moderate" | "severe";
  signals?: number;
  days?: number;
  destination?: string;
  overdue: boolean;
  assignedTo: string | null;
  since: string;
  href: string;
}

export interface Worklist {
  items: WorkItem[];
  total: number;
  truncated: boolean;
  /* полный перебор видов: вкладка забытого вида не нарисуется, а сумма разойдётся с total */
  byKind: Record<WorkKind, number>;
  mine: number;
  /**
   * Очередь построена по кризисному правилу: сначала тяжесть, потом всё
   * остальное. Флаг отдаётся, чтобы экран мог сказать об этом прямо —
   * изменившийся порядок без объяснения читается как сбой.
   */
}


/** Состояние подразделения за период */
export interface UnitReport {
  unit: string;
  from: string | null;
  to: string | null;
  /** Всего людей в подразделении */
  people: number;
  /** Из них обследовано за период */
  measured: number;
  coverage: number;
  responses: number;
  /** Сколько человек хоть раз попало в тяжёлую полосу; null — ячейка подавлена */
  atRisk: number | null;
  smallCellFloor: number;
  surveys: { surveyId: string; title: string; responses: number; people: number }[];
  scales: {
    code: string;
    title: string;
    total: number;
    breakdown: { severity: Severity; count: number | null; percent: number }[];
  }[];
}


/**
 * Личный план безопасности (Стэнли–Браун).
 *
 * Порядок разделов не произвольный: он воспроизводит порядок действий в
 * кризисе. Сначала то, что человек может сделать один, потом отвлечение,
 * потом люди, и лишь затем профессиональная помощь — так план работает даже
 * тогда, когда сил на звонок ещё нет. Ограничение доступа к средствам стоит
 * последним пунктом, но обсуждается всегда: это единственная часть плана,
 * которая снижает риск, а не помогает его пережить.
 */
export interface SafetyPlanContent {
  /** Признаки, по которым человек узнаёт приближение кризиса */
  warningSigns: string[];
  /** Что он может сделать сам */
  copingStrategies: string[];
  /** Занятия и места, которые отвлекают */
  distractions: string[];
  /** Люди, к которым можно обратиться: имя и как связаться */
  people: { name: string; contact: string }[];
  /** Специалисты и дежурные службы */
  professionals: { name: string; contact: string }[];
  /** Что сделано, чтобы ограничить доступ к средствам */
  meansRestriction: string;
  /** Ради чего стоит жить — своими словами */
  reasonsToLive: string[];
}

export interface SafetyPlan {
  id: string;
  version: number;
  content: SafetyPlanContent;
  active: boolean;
  createdAt: string;
  reviewedAt: string | null;
  authorName: string;
}

/* ═══════════ Поддержка решений ═══════════ */

export interface RuleHit {
  id: string;
  ruleTitle: string;
  ruleVersion: number;
  userId: string;
  userName: string;
  surveyId: string;
  responseId: string;
  status: "suggested" | "accepted" | "declined";
  explanation: {
    title: string;
    because: { met: boolean; text: string }[];
    actions: import("./rules").RuleAction[];
  };
  createdAt: string;
}

export interface DutyShiftRow {
  id: string;
  userId: string;
  name: string;
  groupId: string | null;
  startsAt: string;
  endsAt: string;
}

/* ═══════════ Рабочее место ═══════════ */

/**
 * Настройки рабочего места.
 *
 * Живут на сервере, а не в браузере: сотрудник садится за разные машины в
 * отделении, и «моя настройка» не должна означать «настройка этого
 * компьютера». Все поля необязательны — отсутствие значит «как по умолчанию»,
 * а не «выключено».
 */
export interface WorkspacePrefs {
  /** Куда попадать после входа */
  startScreen?: "dashboard" | "worklist" | "alerts" | "patients";
  density?: "cozy" | "compact";
  theme?: "dark" | "light";
  lang?: "uk" | "ru";
  /**
   * Закрытые подсказки.
   *
   * Список закрытых, а не показанных: подсказка по умолчанию видна, и человек,
   * впервые открывший экран на новой машине, увидит её снова — это и нужно.
   * Хранить «показанные» значило бы, что забытая запись навсегда прячет
   * объяснение.
   */
  dismissedHints?: string[];
  /**
   * Когда человек последний раз смотрел сводку «пока меня не было».
   *
   * В профиле, а не в браузере: смена вернулась с другой машины — и сводка
   * должна показать смену, а не «всё с начала времён».
   */
  eventsSeenAt?: string | null;
}

/* ═══════════ Мульти-информант ═══════════ */

export type InformantRole = "commander" | "peer" | "family" | "clinician";

export interface InformantRequestRow {
  id: string;
  role: InformantRole;
  surveyId: string;
  surveyTitle: string;
  note: string | null;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  responseId: string | null;
}

/** Одна перспектива: что видит человек со стороны против самоотчёта */
export interface InformantComparison {
  requestId: string;
  role: InformantRole;
  at: string | null;
  scales: {
    code: string;
    title: string;
    informant: number;
    /** null — этой шкалы в самоотчёте нет */
    self: number | null;
    /** Расхождение; null там, где сравнивать не с чем */
    gap: number | null;
  }[];
}

/* ═══════════ Когорты ═══════════ */

/**
 * Правило отбора когорты.
 *
 * Все условия соединяются «и». Пустое правило — вся доступная выборка, и это
 * осмысленное начало работы: человек сужает, а не собирает с нуля.
 */
export interface CohortSpec {
  sex?: "male" | "female" | null;
  ageMin?: number | null;
  ageMax?: number | null;
  units?: string[];
  /** Методика, по которой смотрим баллы и период */
  surveyId?: string | null;
  from?: string | null;
  to?: string | null;
  /** Условия по шкалам выбранной методики */
  scales?: { code: string; op: ">=" | "<=" | ">" | "<"; value: number }[];
  /** Только те, у кого есть повторный замер: без него динамики нет */
  repeatedOnly?: boolean;
  /** Только те, у кого поднималась тревога риска */
  riskOnly?: boolean;
}

export interface CohortPreview {
  /** Сколько человек подходит; null — когорта слишком мала, чтобы назвать число */
  size: number | null;
  /** Можно ли показывать разбивки: у малой когорты они указывают на людей */
  breakdownAllowed: boolean;
  smallCellFloor: number;
  bySex: { key: string; count: number | null }[];
  byUnit: { key: string; count: number | null }[];
  bySeverity: { key: string; count: number | null }[];
}

export interface CohortRow {
  id: string;
  title: string;
  note: string | null;
  spec: CohortSpec;
  createdAt: string;
}

/* ── Поликлиника: расписание и приёмы ── */

export type SlotKind = "primary" | "repeat" | "any";
export type AppointmentKind = "primary" | "repeat";
export type AppointmentMode = "onsite" | "remote";
export type AppointmentStatus =
  | "booked"
  | "confirmed"
  | "arrived"
  | "in_progress"
  | "done"
  | "no_show"
  | "cancelled";

/** Свободное время у специалиста — то, что видит записывающийся */
export interface FreeSlot {
  id: string;
  specialistId: string;
  specialistName: string;
  /** Кабинет: человеку надо знать, куда идти, ещё до приёма */
  room: string | null;
  startsAt: string;
  endsAt: string;
}

/** Приём в списке — и у пациента, и в «Сегодня» у специалиста */
export interface AppointmentView {
  id: string;
  slotId: string;
  startsAt: string;
  endsAt: string;
  kind: AppointmentKind;
  mode: AppointmentMode;
  meetingUrl: string | null;
  status: AppointmentStatus;
  specialistId: string;
  specialistName: string;
  room: string | null;
  patientId: string;
  /** Имя или код: анонимный аккаунт виден специалисту как «Респондент А-4821» */
  patientName: string;
  /** Причина обращения словами пациента; null — не указал, и это его право */
  reason: string | null;
  bookedAt: string;
  confirmedAt: string | null;
  /** Слот выпал из расписания после правки шаблона — приём цел, но требует решения */
  offSchedule: boolean;
  /**
   * Сколько назначенного человек не сдал к этому приёму.
   *
   * Предупреждаются оба: пациенту — напоминание, специалисту — пометка.
   * Без неё специалист узнаёт о несданной методике в момент, когда собирался
   * её обсуждать, — то есть когда время приёма уже идёт.
   */
  pendingAssignments: number;
  /**
   * Скрининг при записи: сдан или нет; null — отделение его не даёт.
   *
   * Ради этого первичный приём и перестаёт наполовину уходить на заполнение
   * бланков. Специалисту важно знать до приёма, начинать ли с разговора или
   * с анкеты.
   */
  screeningDone: boolean | null;
  /**
   * Кто ведёт этого человека; null — никто.
   *
   * Нужен в списке дня: записаться можно к любому свободному специалисту, и
   * плата за эту доступность — размывание преемственности. Гасит её не
   * запрет, а пометка: незакреплённых видно, а не приходится искать.
   */
  leadSpecialistId: string | null;
}

/** Обычная неделя специалиста */
export interface ScheduleTemplateView {
  id: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
}

/** Исключение из обычной недели */
export interface ScheduleExceptionView {
  id: string;
  date: string;
  kind: "off" | "extra";
  startsAt: string | null;
  endsAt: string | null;
  slotMinutes: number | null;
  note: string | null;
}
