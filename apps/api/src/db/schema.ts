import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { LocalizedText } from "@quizzy/shared";

/**
 * Временные метки храним как timestamptz: в отличие от SQLite, где всё было
 * строкой, Postgres умеет часовые пояса, и это важно для журнала доступа
 * и телеметрии — они должны оставаться однозначными при смене TZ сервера.
 */
/** Локализованный текст: { uk, ru }. Хранится как jsonb, читается через t() */
const localized = (name: string) => jsonb(name).$type<LocalizedText>();

const timestampCol = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    /** Отчество — необязательно, но в медицинском учреждении обычно есть */
    middleName: text("middle_name"),

    /*
     * Паспортная часть. Регистрационный бланк каждой методики требует пол,
     * возраст, подразделение, должность, специальность и звание — без них
     * нормы по полу и возрасту неприменимы, а заключение неполно.
     *
     * Дату рождения храним вместо возраста: возраст считается на момент
     * обследования, а не на момент просмотра, иначе старые заключения
     * со временем начали бы врать.
     */
    /**
     * Псевдонимизированный аккаунт: имя и фамилия не сохраняются, вместо них
     * показывается код. Пол и дата рождения остаются — они нужны для норм и
     * сами по себе человека не опознают.
     *
     * Это не анонимность: email хранится, потому что по нему выполняется вход.
     */
    anonymous: boolean("anonymous").notNull().default(false),
    /** Код вида «Респондент А-4821», заменяет ФИО у псевдонимизированных */
    pseudonym: text("pseudonym"),

    sex: text("sex", { enum: ["male", "female"] }),
    birthDate: text("birth_date"),
    unit: text("unit"),
    position: text("position"),
    specialty: text("specialty"),
    rank: text("rank"),
    role: text("role", { enum: ["superadmin", "admin", "user"] }).notNull().default("user"),
    createdAt: timestampCol("created_at").notNull().defaultNow(),
  },
  (t) => ({ emailIdx: uniqueIndex("users_email_idx").on(t.email) }),
);

/** Группа опросов — батарея методик */
export const surveyGroups = pgTable(
  "survey_groups",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    color: text("color"),
    position: integer("position").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestampCol("created_at").notNull().defaultNow(),
  },
  (t) => ({ positionIdx: index("groups_position_idx").on(t.position) }),
);

/**
 * Назначение администратора на группу. Суперадмин раздаёт эти связи,
 * администратор видит только те группы, на которые назначен.
 */
export const groupAdmins = pgTable(
  "group_admins",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => surveyGroups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestampCol("added_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    userIdx: index("group_admins_user_idx").on(t.userId),
  }),
);

export const surveys = pgTable(
  "surveys",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").references(() => surveyGroups.id, { onDelete: "set null" }),
    title: localized("title").notNull(),
    description: localized("description"),
    instructions: localized("instructions"),
    /** self — заполняет респондент, clinician — специалист за него */
    administration: text("administration", { enum: ["self", "clinician"] })
      .notNull()
      .default("self"),

    /**
     * Порог «слишком быстрого» ответа для этой методики, миллисекунды.
     * Общий порог не годится: матричный вопрос из четырёх строк требует
     * заметно больше времени, чем «да/нет», и один порог на всё либо
     * пропускает небрежность, либо клевещет на добросовестных.
     */
    tooFastMs: integer("too_fast_ms"),

    /**
     * Через сколько минут неразобранная тревога считается просроченной.
     * null — эскалации нет.
     */
    alertEscalateMinutes: integer("alert_escalate_minutes"),
    status: text("status", { enum: ["draft", "published", "closed", "archived"] })
      .notNull()
      .default("draft"),

    timeLimitSec: integer("time_limit_sec"),
    randomizeQuestions: boolean("randomize_questions").notNull().default(false),
    allowBack: boolean("allow_back").notNull().default(true),
    showProgress: boolean("show_progress").notNull().default(true),
    anonymous: boolean("anonymous").notNull().default(false),
    /** public — видна всем пациентам, restricted — только по назначению */
    visibility: text("visibility", { enum: ["public", "restricted"] })
      .notNull()
      .default("public"),
    allowRetake: boolean("allow_retake").notNull().default(false),
    scoringEnabled: boolean("scoring_enabled").notNull().default(false),

    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Действующая версия — её видят проходящие */
    currentVersionId: text("current_version_id"),
    createdAt: timestampCol("created_at").notNull().defaultNow(),
    updatedAt: timestampCol("updated_at").notNull().defaultNow(),
    publishedAt: timestampCol("published_at"),
  },
  (t) => ({
    statusIdx: index("surveys_status_idx").on(t.status),
    groupIdx: index("surveys_group_idx").on(t.groupId),
  }),
);

/**
 * Версия методики. Содержимое (разделы, шкалы, вопросы) принадлежит версии,
 * а не методике напрямую: правка создаёт новую версию, старые строки остаются
 * жить ради уже собранных ответов.
 *
 * Благодаря этому методику можно править, не уничтожая историю, и любое
 * прохождение всегда интерпретируется той версией, которую человек реально видел.
 */
/**
 * Персональный доступ пациента к методике.
 *
 * Методика с visibility = "restricted" видна только тем, кому доступ выдан явно.
 * Это нужно, когда опросник назначается конкретному человеку, а не выкладывается
 * всем: назначение фиксируется вместе с тем, кто его выдал.
 */
export const surveyAccess = pgTable(
  "survey_access",
  {
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestampCol("granted_at").notNull().defaultNow(),
    /** Срок действия назначения — после него методика снова скрыта */
    expiresAt: timestampCol("expires_at"),
    note: text("note"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.surveyId, t.userId] }),
    userIdx: index("survey_access_user_idx").on(t.userId),
  }),
);

export const surveyVersions = pgTable(
  "survey_versions",
  {
    id: text("id").primaryKey(),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    note: text("note"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestampCol("created_at").notNull().defaultNow(),
  },
  (t) => ({
    surveyIdx: index("versions_survey_idx").on(t.surveyId),
    uniqueVersion: uniqueIndex("versions_survey_number_idx").on(t.surveyId, t.version),
  }),
);

/** Раздел опроса — единица постраничного показа */
export const sections = pgTable(
  "sections",
  {
    id: text("id").primaryKey(),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    /** Версия, которой принадлежит эта строка */
    versionId: text("version_id")
      .notNull()
      .references(() => surveyVersions.id, { onDelete: "cascade" }),
    title: localized("title").notNull(),
    description: localized("description"),
    position: integer("position").notNull().default(0),
  },
  (t) => ({ surveyIdx: index("sections_survey_idx").on(t.surveyId) }),
);

/** Субшкала методики */
export const scales = pgTable(
  "scales",
  {
    id: text("id").primaryKey(),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    /** Версия, которой принадлежит эта строка */
    versionId: text("version_id")
      .notNull()
      .references(() => surveyVersions.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    title: localized("title").notNull(),
    description: localized("description"),
    aggregation: text("aggregation", { enum: ["sum", "average", "count"] })
      .notNull()
      .default("sum"),
    position: integer("position").notNull().default(0),

    /** clinical — содержательная, validity — шкала достоверности */
    kind: text("kind", { enum: ["clinical", "validity"] }).notNull().default("clinical"),
    normalization: text("normalization", { enum: ["raw", "ratio", "tscore", "sten"] })
      .notNull()
      .default("raw"),
    /** Знаменатель доли: 35 у Sr, 10 у шкалы лжи */
    ratioDenominator: doublePrecision("ratio_denominator"),
    validityThreshold: doublePrecision("validity_threshold"),
    validityDirection: text("validity_direction", { enum: ["above", "below"] }),
    validityMessage: localized("validity_message"),
  },
  (t) => ({
    surveyIdx: index("scales_survey_idx").on(t.surveyId),
    // код субшкалы уникален ВНУТРИ ВЕРСИИ: новая версия переиспользует те же коды,
    // и по ним же сопоставляются шкалы разных версий в динамике пациента
    codeIdx: uniqueIndex("scales_version_code_idx").on(t.versionId, t.code),
  }),
);

/** Интерпретационная норма субшкалы */
export const scaleBands = pgTable(
  "scale_bands",
  {
    id: text("id").primaryKey(),
    scaleId: text("scale_id")
      .notNull()
      .references(() => scales.id, { onDelete: "cascade" }),
    minScore: doublePrecision("min_score").notNull(),
    maxScore: doublePrecision("max_score").notNull(),
    label: localized("label").notNull(),
    severity: text("severity", { enum: ["none", "mild", "moderate", "severe"] })
      .notNull()
      .default("none"),
    description: localized("description"),
    /** Порядковая оценка методики; у части шкал она перевёрнута относительно severity */
    grade: integer("grade"),
    /** Клиническая рекомендация: от наблюдения до обязательной госпитализации */
    recommendation: localized("recommendation"),
    position: integer("position").notNull().default(0),
  },
  (t) => ({ scaleIdx: index("bands_scale_idx").on(t.scaleId) }),
);

/**
 * Вклад пункта в шкалу — связь многие-ко-многим.
 *
 * В МЛО и Мини-мульте один пункт работает сразу на несколько шкал, поэтому
 * привязка «вопрос → одна шкала» здесь не годится.
 */
export const scaleItems = pgTable(
  "scale_items",
  {
    scaleId: text("scale_id")
      .notNull()
      .references(() => scales.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    /** «yes» / «no» — режим ключа; null — берётся балл выбранного варианта */
    matchKey: text("match_key"),
    weight: doublePrecision("weight").notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scaleId, t.questionId] }),
    questionIdx: index("scale_items_question_idx").on(t.questionId),
  }),
);

/** Поправка одной шкалы на другую: Hs = Hs + 0,5·K */
export const scaleCorrections = pgTable(
  "scale_corrections",
  {
    targetScaleId: text("target_scale_id")
      .notNull()
      .references(() => scales.id, { onDelete: "cascade" }),
    sourceScaleId: text("source_scale_id")
      .notNull()
      .references(() => scales.id, { onDelete: "cascade" }),
    coefficient: doublePrecision("coefficient").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.targetScaleId, t.sourceScaleId] }) }),
);

/** Норма для перевода в T-баллы: своя для каждого пола и возрастной группы */
export const scaleNorms = pgTable(
  "scale_norms",
  {
    id: text("id").primaryKey(),
    scaleId: text("scale_id")
      .notNull()
      .references(() => scales.id, { onDelete: "cascade" }),
    /**
     * Псевдонимизированный аккаунт: имя и фамилия не сохраняются, вместо них
     * показывается код. Пол и дата рождения остаются — они нужны для норм и
     * сами по себе человека не опознают.
     *
     * Это не анонимность: email хранится, потому что по нему выполняется вход.
     */
    anonymous: boolean("anonymous").notNull().default(false),
    /** Код вида «Респондент А-4821», заменяет ФИО у псевдонимизированных */
    pseudonym: text("pseudonym"),

    sex: text("sex", { enum: ["male", "female"] }),
    ageMin: integer("age_min"),
    ageMax: integer("age_max"),
    mean: doublePrecision("mean").notNull(),
    sd: doublePrecision("sd").notNull(),
  },
  (t) => ({ scaleIdx: index("norms_scale_idx").on(t.scaleId) }),
);

/** Таблица перевода сырых баллов в стены */
export const stenRows = pgTable(
  "sten_rows",
  {
    id: text("id").primaryKey(),
    scaleId: text("scale_id")
      .notNull()
      .references(() => scales.id, { onDelete: "cascade" }),
    /**
     * Псевдонимизированный аккаунт: имя и фамилия не сохраняются, вместо них
     * показывается код. Пол и дата рождения остаются — они нужны для норм и
     * сами по себе человека не опознают.
     *
     * Это не анонимность: email хранится, потому что по нему выполняется вход.
     */
    anonymous: boolean("anonymous").notNull().default(false),
    /** Код вида «Респондент А-4821», заменяет ФИО у псевдонимизированных */
    pseudonym: text("pseudonym"),

    sex: text("sex", { enum: ["male", "female"] }),
    ageMin: integer("age_min"),
    ageMax: integer("age_max"),
    rawMin: doublePrecision("raw_min").notNull(),
    rawMax: doublePrecision("raw_max").notNull(),
    sten: integer("sten").notNull(),
  },
  (t) => ({ scaleIdx: index("sten_scale_idx").on(t.scaleId) }),
);

export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    /** Версия, которой принадлежит эта строка */
    versionId: text("version_id")
      .notNull()
      .references(() => surveyVersions.id, { onDelete: "cascade" }),
    sectionId: text("section_id").references(() => sections.id, { onDelete: "set null" }),
    type: text("type", {
      enum: [
        "single",
        "multiple",
        "scale",
        "slider",
        "matrix",
        "ranking",
        "yesno",
        "number",
        "text",
        "longtext",
        "date",
        "info",
      ],
    }).notNull(),
    title: localized("title").notNull(),
    help: localized("help"),
    required: boolean("required").notNull().default(false),
    position: integer("position").notNull().default(0),

    scaleId: text("scale_id").references(() => scales.id, { onDelete: "set null" }),
    reverseScored: boolean("reverse_scored").notNull().default(false),

    minValue: doublePrecision("min_value"),
    maxValue: doublePrecision("max_value"),
    step: doublePrecision("step"),
    minLabel: text("min_label"),
    maxLabel: text("max_label"),

    randomizeOptions: boolean("randomize_options").notNull().default(false),
    timeLimitSec: integer("time_limit_sec"),
    /** Для числовых вопросов: значение не ниже порога поднимает тревогу */
    riskThreshold: doublePrecision("risk_threshold"),
    riskLabel: localized("risk_label"),
    riskSeverity: text("risk_severity", { enum: ["moderate", "severe"] }),
  },
  (t) => ({
    surveyIdx: index("questions_survey_idx").on(t.surveyId),
    sectionIdx: index("questions_section_idx").on(t.sectionId),
  }),
);

export const options = pgTable(
  "options",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    text: localized("text").notNull(),
    score: doublePrecision("score").notNull().default(0),
    kind: text("kind", { enum: ["option", "row"] }).notNull().default("option"),
    position: integer("position").notNull().default(0),
    /** Код для ключа: «yes» / «no». Ключ ссылается на код, а не на порядок */
    keyCode: text("key_code"),
    /** Выбор этого варианта поднимает тревогу немедленно, не дожидаясь подсчёта */
    riskFlag: boolean("risk_flag").notNull().default(false),
    riskLabel: localized("risk_label"),
    riskSeverity: text("risk_severity", { enum: ["moderate", "severe"] }),
  },
  (t) => ({ questionIdx: index("options_question_idx").on(t.questionId) }),
);

/** Правило условного показа вопроса */
export const questionLogic = pgTable(
  "question_logic",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    sourceQuestionId: text("source_question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    operator: text("operator", {
      enum: ["eq", "neq", "gt", "lt", "gte", "lte", "contains", "answered", "not_answered"],
    }).notNull(),
    value: jsonb("value"),
    action: text("action", { enum: ["show", "hide"] }).notNull().default("show"),
  },
  (t) => ({ questionIdx: index("logic_question_idx").on(t.questionId) }),
);

export const responses = pgTable(
  "responses",
  {
    id: text("id").primaryKey(),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    /** null для анонимных методик */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status", { enum: ["in_progress", "completed", "abandoned"] })
      .notNull()
      .default("completed"),
    /** Версия методики, которую респондент реально видел */
    versionId: text("version_id").references(() => surveyVersions.id, { onDelete: "set null" }),
    startedAt: timestampCol("started_at").notNull().defaultNow(),
    submittedAt: timestampCol("submitted_at"),
    /** Момент последнего автосохранения черновика */
    lastSavedAt: timestampCol("last_saved_at"),
    /** Общее время прохождения */
    durationMs: integer("duration_ms").notNull().default(0),
  },
  (t) => ({
    surveyIdx: index("responses_survey_idx").on(t.surveyId),
    userIdx: index("responses_user_idx").on(t.userId),
    submittedIdx: index("responses_submitted_idx").on(t.submittedAt),
  }),
);

export const answers = pgTable(
  "answers",
  {
    id: text("id").primaryKey(),
    responseId: text("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),

    optionIds: jsonb("option_ids").$type<string[]>(),
    text: text("text"),
    number: doublePrecision("number"),
    date: text("date"),
    matrix: jsonb("matrix").$type<Record<string, string>>(),
    ranking: jsonb("ranking").$type<string[]>(),
    skipped: boolean("skipped").notNull().default(false),

    /** Балл, посчитанный на момент отправки — храним, чтобы правка методики не меняла историю */
    score: doublePrecision("score"),

    /** Телеметрия */
    durationMs: integer("duration_ms").notNull().default(0),
    changeCount: integer("change_count").notNull().default(0),
    visitCount: integer("visit_count").notNull().default(1),
  },
  (t) => ({
    responseIdx: index("answers_response_idx").on(t.responseId),
    questionIdx: index("answers_question_idx").on(t.questionId),
  }),
);

/**
 * Лента событий ответа: каждое переключение с точной меткой времени.
 *
 * Из неё восстанавливается процесс, а не только итог: когда респондент впервые
 * выбрал вариант, сколько раз передумал и через сколько после показа вопроса.
 * Таблица растёт быстрее остальных — по ней стоит настроить срок хранения.
 */
export const answerEvents = pgTable(
  "answer_events",
  {
    id: text("id").primaryKey(),
    responseId: text("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    /** Порядковый номер события внутри прохождения — восстанавливает точный порядок */
    sequence: integer("sequence").notNull(),
    kind: text("kind", { enum: ["shown", "set", "change", "clear", "leave"] }).notNull(),
    /** Миллисекунды от момента показа вопроса */
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    at: timestampCol("at").notNull(),
    /** Значение на момент события — форма зависит от типа вопроса */
    value: jsonb("value"),
  },
  (t) => ({
    responseIdx: index("events_response_idx").on(t.responseId),
    questionIdx: index("events_question_idx").on(t.questionId),
  }),
);

/** Замороженный результат по субшкале на момент прохождения */
export const responseScores = pgTable(
  "response_scores",
  {
    id: text("id").primaryKey(),
    responseId: text("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    scaleId: text("scale_id")
      .notNull()
      .references(() => scales.id, { onDelete: "cascade" }),
    rawScore: doublePrecision("raw_score").notNull(),
    /**
     * Итоговое значение после поправок и нормирования: доля, T-балл или стен.
     * Хранится отдельно от сырого балла, потому что полосы норм заданы именно
     * на нём — у СР-45 сырой балл 0–35, а полосы на доле 0–1.
     */
    value: doublePrecision("value").notNull().default(0),
    normalization: text("normalization", { enum: ["raw", "ratio", "tscore", "sten"] })
      .notNull()
      .default("raw"),
    maxScore: doublePrecision("max_score").notNull(),
    percent: doublePrecision("percent").notNull(),
    bandLabel: text("band_label"),
    severity: text("severity", { enum: ["none", "mild", "moderate", "severe"] }),
  },
  (t) => ({
    responseIdx: index("scores_response_idx").on(t.responseId),
    scaleIdx: index("scores_scale_idx").on(t.scaleId),
  }),
);

/**
 * Журнал доступа. Append-only: записи не редактируются и не удаляются,
 * иначе журнал теряет доказательную силу.
 *
 * Логируются и чтения данных пациентов, а не только изменения — для
 * медицинских данных именно доступ к чужой карте является событием,
 * которое нужно уметь предъявить.
 *
 * actorEmail денормализован намеренно: запись должна оставаться читаемой
 * после удаления учётной записи.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: timestampCol("at").notNull().defaultNow(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    /** Чьи персональные данные затронуты — пациент, а не тот, кто смотрел */
    subjectUserId: text("subject_user_id"),
    outcome: text("outcome", { enum: ["success", "denied", "error"] })
      .notNull()
      .default("success"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => ({
    atIdx: index("audit_at_idx").on(t.at),
    actorIdx: index("audit_actor_idx").on(t.actorId),
    actionIdx: index("audit_action_idx").on(t.action),
    subjectIdx: index("audit_subject_idx").on(t.subjectUserId),
  }),
);

export type AuditRow = typeof auditLog.$inferSelect;

/**
 * Тревога по критическому пункту. Создаётся сразу при сохранении ответа,
 * в том числе при автосохранении черновика: если человек отметил пункт про
 * суицидальные мысли, персонал должен узнать об этом до конца прохождения.
 */
export const riskAlerts = pgTable(
  "risk_alerts",
  {
    id: text("id").primaryKey(),
    responseId: text("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    label: text("label").notNull(),
    severity: text("severity", { enum: ["moderate", "severe"] }).notNull().default("severe"),
    at: timestampCol("at").notNull().defaultNow(),
    acknowledgedBy: text("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: timestampCol("acknowledged_at"),
    note: text("note"),
  },
  (t) => ({
    surveyIdx: index("alerts_survey_idx").on(t.surveyId),
    openIdx: index("alerts_open_idx").on(t.acknowledgedAt),
    // одна тревога на пункт в рамках прохождения, иначе автосохранение
    // плодило бы дубликаты при каждом сохранении
    uniquePerAnswer: uniqueIndex("alerts_response_question_idx").on(t.responseId, t.questionId),
  }),
);


/**
 * Батарея — набор методик, назначаемый целиком.
 *
 * На практике обследование почти никогда не состоит из одной методики: идёт
 * связка из скрининга, основного опросника и уточняющего. Назначать их по
 * одной значит полагаться на то, что психолог не забудет ни одну и выдаст в
 * нужном порядке.
 */
export const batteries = pgTable(
  "batteries",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    /** Батарея живёт в группе — из неё же берутся права на неё */
    groupId: text("group_id").references(() => surveyGroups.id, { onDelete: "cascade" }),
    /** Порядок обязателен: методики влияют друг на друга через утомление */
    strictOrder: boolean("strict_order").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestampCol("created_at").notNull().defaultNow(),
  },
  (t) => ({
    groupIdx: index("batteries_group_idx").on(t.groupId),
  }),
);

export const batteryItems = pgTable(
  "battery_items",
  {
    batteryId: text("battery_id")
      .notNull()
      .references(() => batteries.id, { onDelete: "cascade" }),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    /** Необязательную методику можно пропустить, батарея всё равно завершится */
    required: boolean("required").notNull().default(true),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.batteryId, t.surveyId] }),
    orderIdx: index("battery_items_order_idx").on(t.batteryId, t.position),
  }),
);

export const batteryAssignments = pgTable(
  "battery_assignments",
  {
    id: text("id").primaryKey(),
    batteryId: text("battery_id")
      .notNull()
      .references(() => batteries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedBy: text("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestampCol("assigned_at").notNull().defaultNow(),
    /** Срок, к которому батарея должна быть пройдена */
    dueAt: timestampCol("due_at"),
    /** Проставляется, когда пройдены все обязательные методики */
    completedAt: timestampCol("completed_at"),
    /** Отменённое назначение сохраняется: снимать назначения молча нельзя */
    cancelledAt: timestampCol("cancelled_at"),
    note: text("note"),
  },
  (t) => ({
    userIdx: index("battery_assignments_user_idx").on(t.userId),
    batteryIdx: index("battery_assignments_battery_idx").on(t.batteryId),
    // одно активное назначение на человека; повтор — это новое назначение
    // после отмены или завершения, поэтому уникальность неполная
    activeIdx: uniqueIndex("battery_assignments_active_idx")
      .on(t.batteryId, t.userId)
      .where(sql`completed_at is null and cancelled_at is null`),
  }),
);

export type BatteryRow = typeof batteries.$inferSelect;
export type BatteryItemRow = typeof batteryItems.$inferSelect;
export type BatteryAssignmentRow = typeof batteryAssignments.$inferSelect;


/**
 * Расписание повторных обследований.
 *
 * Расписание работает только с батареями. Отдельная ветка «расписание на одну
 * методику» завела бы второй путь выдачи заданий со своими правилами доступа и
 * своим прогрессом; батарея из одной методики решает ту же задачу, не удваивая
 * механику.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    batteryId: text("battery_id")
      .notNull()
      .references(() => batteries.id, { onDelete: "cascade" }),
    /** Кого охватывает: подразделение целиком или поимённый список */
    scope: text("scope", { enum: ["unit", "users"] }).notNull(),
    /** Название подразделения для scope = unit */
    unit: text("unit"),
    /** Период повтора в днях */
    intervalDays: integer("interval_days").notNull(),
    /** Сколько дней даётся на прохождение с момента выдачи */
    dueDays: integer("due_days").notNull().default(14),
    startsAt: timestampCol("starts_at").notNull().defaultNow(),
    /** Дата окончания: после неё расписание больше не срабатывает */
    endsAt: timestampCol("ends_at"),
    active: boolean("active").notNull().default(true),
    lastRunAt: timestampCol("last_run_at"),
    nextRunAt: timestampCol("next_run_at").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestampCol("created_at").notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("schedules_due_idx").on(t.active, t.nextRunAt),
  }),
);

export const scheduleTargets = pgTable(
  "schedule_targets",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scheduleId, t.userId] }),
  }),
);

/**
 * Журнал срабатываний.
 *
 * Нужен отдельно от назначений: если срабатывание никого не охватило, по одним
 * назначениям не отличить «расписание отработало вхолостую» от «расписание не
 * запускалось», а это разные неисправности.
 */
export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    ranAt: timestampCol("ran_at").notNull().defaultNow(),
    /** Сколько назначений создано */
    assigned: integer("assigned").notNull().default(0),
    /** Сколько пропущено: у человека уже висит незакрытое назначение */
    skipped: integer("skipped").notNull().default(0),
    note: text("note"),
  },
  (t) => ({
    scheduleIdx: index("schedule_runs_schedule_idx").on(t.scheduleId, t.ranAt),
  }),
);

/**
 * Refresh-токены.
 *
 * Access-токен короткий и его не отозвать — компрометация живёт минуты.
 * Refresh хранится ХЕШЕМ (утечка таблицы не даёт токенов) и одноразов:
 * каждое обновление выдаёт новый и гасит старый. Повторное предъявление
 * погашенного токена — признак кражи, по нему отзывается вся семья.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** Семья: цепочка перевыпусков одного логина, отзывается целиком */
    familyId: text("family_id").notNull(),
    createdAt: timestampCol("created_at").notNull().defaultNow(),
    expiresAt: timestampCol("expires_at").notNull(),
    /** Погашен обычной ротацией */
    rotatedAt: timestampCol("rotated_at"),
    /** Отозван: logout, смена пароля, обнаружение повторного предъявления */
    revokedAt: timestampCol("revoked_at"),
  },
  (t) => ({
    hashIdx: uniqueIndex("refresh_tokens_hash_idx").on(t.tokenHash),
    userIdx: index("refresh_tokens_user_idx").on(t.userId),
    familyIdx: index("refresh_tokens_family_idx").on(t.familyId),
  }),
);

/**
 * Неудачные попытки входа — для rate limiting и lockout.
 * Таблица, а не память процесса: переживает рестарт и работает при репликах.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    ip: text("ip"),
    at: timestampCol("at").notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index("login_attempts_email_idx").on(t.email, t.at),
  }),
);

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;

export type ScheduleRow = typeof schedules.$inferSelect;
export type ScheduleRunRow = typeof scheduleRuns.$inferSelect;

export type ScaleItemRow = typeof scaleItems.$inferSelect;
export type ScaleCorrectionRow = typeof scaleCorrections.$inferSelect;
export type ScaleNormRow = typeof scaleNorms.$inferSelect;
export type StenRowRow = typeof stenRows.$inferSelect;
export type SurveyAccessRow = typeof surveyAccess.$inferSelect;
export type SurveyVersionRow = typeof surveyVersions.$inferSelect;
export type RiskAlertRow = typeof riskAlerts.$inferSelect;
export type GroupAdminRow = typeof groupAdmins.$inferSelect;
export type AnswerEventRow = typeof answerEvents.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SurveyGroupRow = typeof surveyGroups.$inferSelect;
export type SurveyRow = typeof surveys.$inferSelect;
export type SectionRow = typeof sections.$inferSelect;
export type ScaleRow = typeof scales.$inferSelect;
export type ScaleBandRow = typeof scaleBands.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type OptionRow = typeof options.$inferSelect;
export type LogicRow = typeof questionLogic.$inferSelect;
export type ResponseRow = typeof responses.$inferSelect;
export type AnswerRow = typeof answers.$inferSelect;
export type ResponseScoreRow = typeof responseScores.$inferSelect;
