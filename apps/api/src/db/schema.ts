import {
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  time,
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

/**
 * Метка времени. Из базы всегда выходит в ISO.
 *
 * Postgres отдаёт timestamptz текстом вида «2026-08-26 17:00:00+03», а весь
 * остальной код живёт в ISO («2026-08-26T14:00:00.000Z»). Лексикографное
 * сравнение этих форм врёт: пробел меньше «T», поэтому любая метка из базы
 * «меньше» любой ISO-метки того же дня. Это однажды уронило киоск («сеанс
 * истёк» сразу после создания) и молча помечало просроченным каждый шаг
 * маршрута со сроком — включая назначенный на две недели вперёд.
 *
 * Помощник `parseTs` спасал только тех, кто помнил его позвать. Здесь —
 * граница с базой: наружу выходит ровно один вид метки, и сравнить
 * неправильно больше нечего.
 */
const timestampCol = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (value) => new Date(value).toISOString(),
  toDriver: (value) => value,
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    /**
     * Учётная запись только для чтения.
     *
     * Нужна для показов и обучения: человек ходит по консоли настоящими
     * маршрутами и видит настоящие экраны, но ничего не может испортить.
     * Проверка живёт в одном месте — middleware по методу запроса, — потому
     * что перечислять «безопасные» эндпоинты пришлось бы заново после
     * каждой новой фичи, и однажды кто-то забыл бы.
     */
    readOnly: boolean("read_only").notNull().default(false),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    /** Отчество — необязательно, но в медицинском учреждении обычно есть */
    middleName: text("middle_name"),

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
    /**
     * Связь с учётной записью Google: её стабильный идентификатор (sub).
     *
     * Именно sub, а не почта: почту в Google Workspace переназначают
     * уволившемуся сотруднику следующему, и вход по почте отдал бы новому
     * человеку чужую учётную запись вместе с доступом к картам.
     *
     * Связь добавляется к существующей учётной записи и никогда её не
     * создаёт: роль и область видимости назначает человек, а не внешний
     * поставщик входа.
     */
    googleSub: text("google_sub"),

    /*
     * Паспортная часть. Регистрационный бланк каждой методики требует пол,
     * возраст, подразделение, должность, специальность и звание — без них
     * нормы по полу и возрасту неприменимы, а заключение неполно.
     *
     * Дату рождения храним вместо возраста: возраст считается на момент
     * обследования, а не на момент просмотра, иначе старые заключения
     * со временем начали бы врать.
     */
    sex: text("sex", { enum: ["male", "female"] }),
    birthDate: text("birth_date"),
    unit: text("unit"),
    position: text("position"),
    specialty: text("specialty"),
    rank: text("rank"),
    role: text("role", { enum: ["superadmin", "admin", "user"] }).notNull().default("user"),
    /**
     * Настройки рабочего места: стартовый экран, плотность, тема, язык.
     *
     * Хранятся на сервере, а не в браузере: сотрудник садится за разные
     * машины в отделении, и «моя настройка» не должна означать «настройка
     * этого компьютера».
     */
    workspace: jsonb("workspace"),
    /**
     * Телефон. Шифруется, как ФИО.
     *
     * Обязателен для всех, включая учётные записи под кодом: при сработавшей
     * тревоге риска должно быть кому позвонить. Раньше у анонима не было ни
     * имени, ни номера — тревога попадала в разбор, и на этом всё
     * заканчивалось.
     */
    phoneEnc: text("phone_enc"),
    /**
     * Слепой индекс от нормализованного номера.
     *
     * Сравнить можно, расшифровывать для этого не нужно. Ради него один
     * человек не заводит два аккаунта, чтобы «начать с чистого листа».
     */
    phoneIndex: text("phone_index"),
    /**
     * Подтверждения нет и не будет: внешнего шлюза нет, кодом из SMS
     * проверять нечем. Колонка нужна, чтобы специалист видел «номер не
     * подтверждён»: показывать непроверенное как проверенное опаснее, чем не
     * показывать вовсе.
     */
    phoneVerified: boolean("phone_verified").notNull().default(false),
    /**
     * Свой специалист — тот, кто ведёт человека.
     *
     * Закрепляется явно, а не выводится из последнего приёма. Иначе один
     * визит к коллеге на замене молча переназначал бы ведущего, и переписка
     * пациента уходила бы не тому человеку.
     *
     * Не путать с прикреплением к отделению (department_patients): то
     * отвечает «человек обслуживается здесь» и даёт право занять слот
     * повторного приёма, это — «у человека есть ведущий».
     */
    leadSpecialistId: text("lead_specialist_id"),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
    // одна учётная запись Google — одна наша: иначе двое входят как один
    googleSubIdx: uniqueIndex("users_google_sub_idx").on(t.googleSub),
  }),
);

/** Группа опросов — батарея методик */
/*
 * Авторство (`createdBy`) держит запись, а не уносит её.
 *
 * Каскад здесь означал бы, что удаление учётной записи сотрудника стирает
 * все созданные им методики — а с ними, дальше по цепочке, прохождения,
 * баллы и тревоги живых людей. Уволенный психолог не должен уносить с собой
 * клинический архив отделения. RESTRICT заставляет сначала явно передать
 * содержимое, и только потом закрывать учётную запись.
 *
 * Колонки `userId`, наоборот, остаются каскадными: согласия, назначения и
 * токены принадлежат самому человеку и вместе с ним и уходят.
 */
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
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
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
    addedAt: timestampCol("added_at").notNull().default(sql`now()`),
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
    /*
     * Кто заполняет. `informant` — короткая форма для командира, сослуживца
     * или родственника: отдельная методика, а не второй способ заполнить ту
     * же. Смешивать их в одной выборке значило бы испортить и нормы, и альфу.
     */
    administration: text("administration", { enum: ["self", "clinician", "informant"] })
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

    /**
     * Окно, в течение которого новые тревоги прикрепляются к открытому
     * случаю, а не заводят новый. Часы.
     *
     * Разное по методикам не для гибкости ради гибкости: для скрининга
     * суицидального риска повторное срабатывание через сутки — тот же
     * эпизод, а для адаптационного профиля с повтором раз в месяц — уже
     * новый повод. null — общее значение по умолчанию.
     */
    alertCaseWindowHours: integer("alert_case_window_hours"),
  /**
   * Текст немедленных действий при критическом ответе: телефоны доверия,
   * дежурный психолог. Показывается обследуемому сразу после сдачи, если
   * сработала тревога, — в момент, когда он ещё держит устройство в руках.
   */
  safetyPlan: jsonb("safety_plan").$type<LocalizedText>(),
  /**
   * Показывать ли обследуемому его собственную динамику по этой методике.
   * Выключено по умолчанию: график суицидального риска в руках пациента —
   * решение психолога, а не системы.
   */
  showResultsToPatient: boolean("show_results_to_patient").notNull().default(false),
  /*
   * Демонстрационная методика: показывается в обучении и на показах, но не
   * выдаётся пациентам. Флаг был объявлен давно и ничего не значил — списки
   * его не смотрели, и единственной защитой оставалось «(демо)» в названии,
   * то есть внимательность того, кто назначает.
   */
  isDemo: boolean("is_demo").notNull().default(false),
    /*
     * "archived" из перечисления убран намеренно: значение никогда не
     * выставлялось и нигде не проверялось, но выглядело рабочим — рано или
     * поздно кто-то снял бы им методику с использования, ничего при этом не
     * запретив. Снятие живёт в archivedAt ниже.
     */
    status: text("status", { enum: ["draft", "published", "closed"] })
      .notNull()
      .default("draft"),

    /**
     * Методика снята с использования.
     *
     * Удалять методику нельзя: по внешним ключам это уносит все прохождения,
     * баллы и тревоги по ней, то есть клиническую историю живых людей.
     * Снятая методика исчезает из всего, что смотрит вперёд (списки, выдача,
     * батареи, киоск, новые прохождения), и остаётся во всём, что смотрит
     * назад (карта пациента, аналитика, журнал) — иначе в записях появились
     * бы дыры без объяснения.
     */
    archivedAt: timestampCol("archived_at"),
    archivedBy: text("archived_by").references(() => users.id, { onDelete: "set null" }),

    /*
     * Правовой статус текста методики.
     *
     * README честно фиксировал, что тексты требуют очистки прав перед
     * клиническим применением, — но README не мешает выдать методику
     * пациенту. Статус здесь делает это свойством данных: неочищенная
     * методика видна персоналу с пометкой и не публикуется молча.
     *
     * `own` — написана в учреждении, `licensed` — есть договор,
     * `public_domain` — срок охраны истёк или автор открыл, `unclear` —
     * не разобрано.
     */
    rightsStatus: text("rights_status", {
      enum: ["own", "licensed", "public_domain", "unclear"],
    })
      .notNull()
      .default("unclear"),
    /** Источник: пособие, страницы, автор — то, что нужно для сверки и для прав */
    sourceNote: text("source_note"),
    /** Ключи сверены с пособием: кто и когда */
    keysVerifiedAt: timestampCol("keys_verified_at"),
    keysVerifiedBy: text("keys_verified_by").references(() => users.id, { onDelete: "set null" }),

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
      .references(() => users.id, { onDelete: "restrict" }),
    /** Действующая версия — её видят проходящие */
    currentVersionId: text("current_version_id"),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    updatedAt: timestampCol("updated_at").notNull().default(sql`now()`),
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
    grantedAt: timestampCol("granted_at").notNull().default(sql`now()`),
    /** Срок действия назначения — после него методика снова скрыта */
    expiresAt: timestampCol("expires_at"),
    note: text("note"),
    /**
     * Сколько раз можно пройти; null — не ограничивали.
     *
     * Умолчания на уровне базы нет намеренно: оно сделало бы одноразовыми все
     * уже выданные назначения. Единицу подставляет приложение при выдаче
     * нового — там это осознанный выбор. Повторное прохождение той же
     * методики через день портит измерение: человек помнит вопросы.
     */
    attemptsAllowed: integer("attempts_allowed"),
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
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
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

    /*
     * Каскад (6.2): попадание в эту полосу автоматически назначает батарею —
     * скрининг сам вызывает углублённую диагностику, не дожидаясь, пока
     * психолог откроет консоль. Автоматика НАЗНАЧАЕТ, но не интерпретирует:
     * решение о диагнозе остаётся за специалистом.
     */
    cascadeBatteryId: text("cascade_battery_id").references(() => batteries.id, {
      onDelete: "set null",
    }),
    /** Дней на прохождение каскадного назначения */
    cascadeDueDays: integer("cascade_due_days"),

    /*
     * Протокол наблюдения (6.3): повторные замеры этой же методики через
     * заданные интервалы. «7,30» — через неделю и через месяц.
     */
    followUpDays: text("follow_up_days"),
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
    sex: text("sex", { enum: ["male", "female"] }),
    ageMin: integer("age_min"),
    ageMax: integer("age_max"),
    mean: doublePrecision("mean").notNull(),
    sd: doublePrecision("sd").notNull(),
    /**
     * Откуда норма: «пособие НПС, 2016» или «локальная выборка, N=213,
     * 2026-08». Норма без происхождения не интерпретируема: T-балл значит
     * разное относительно мирной популяции и относительно своего госпиталя.
     */
    source: text("source"),
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
    /**
     * Подписи концов шкалы — локализованные.
     *
     * Их читает пациент во время прохождения. Простой строкой они означали
     * один язык: под украинским вопросом стояли русские подписи.
     */
    minLabel: localized("min_label"),
    maxLabel: localized("max_label"),

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
    startedAt: timestampCol("started_at").notNull().default(sql`now()`),
    submittedAt: timestampCol("submitted_at"),
    /** Момент последнего автосохранения черновика */
    lastSavedAt: timestampCol("last_saved_at"),
    /**
     * Идемпотентность офлайн-очереди: клиент генерирует id попытки, и повторная
     * отправка той же попытки (сеть оборвалась после коммита, клиент ретраит)
     * не создаёт второе прохождение — сервер возвращает существующее.
     */
    clientRequestId: text("client_request_id"),

    /*
     * Снэпшоты стратификации НА МОМЕНТ СДАЧИ (принцип П-1 плана):
     * пол и возрастная полоса фиксируются такими, какими были при
     * обследовании — профиль пациента меняется, история нет. Заодно это
     * единственный путь SQL-группировки: дата рождения в users шифрована.
     */
    respondentSex: text("respondent_sex", { enum: ["male", "female"] }),
    /** "<25" | "25-34" | "35-44" | "45+" */
    respondentAgeBand: text("respondent_age_band"),
    /** Язык предъявления контента — психометрический фактор (7.4) */
    lang: text("lang", { enum: ["uk", "ru"] }),
    /**
     * Достоверен ли протокол по шкалам достоверности.
     *
     * Хранится, потому что раньше этот вывод жил только в ответе на отправку
     * и нигде больше: динамика, отчёт по подразделению, когорты и заключения
     * читают сохранённые баллы и не могли узнать, что бланк заполнен
     * недостоверно. Заключение, собранное по проваленной шкале лжи, выглядит
     * точно так же, как собранное по честному протоколу.
     *
     * Ложь означает и «шкала достоверности вышла за порог», и «проверить не
     * удалось, потому что нормировать не вышло»: для читающего заключение
     * это одно и то же — доверять числам нельзя.
     */
    reliable: boolean("reliable").notNull().default(true),
    /**
     * Откуда взялось прохождение.
     *
     * Раньше все были неразличимы, и «пришёл сам» ничем не отличалось от
     * «назначили». Для клинической записи это разные вещи: самообращение —
     * само по себе сведение о человеке, а скрининг при записи нельзя
     * показывать пациенту баллами.
     */
    source: text("source", {
      enum: ["assigned", "self", "kiosk", "clinician", "informant", "intake"],
    }),
    /** Общее время прохождения */
    durationMs: integer("duration_ms").notNull().default(0),
  },
  (t) => ({
    surveyIdx: index("responses_survey_idx").on(t.surveyId),
    userIdx: index("responses_user_idx").on(t.userId),
    submittedIdx: index("responses_submitted_idx").on(t.submittedAt),
    // горячие запросы: список прохождений методики по времени (пагинация)
    // и выборка завершённых по статусу
    surveySubmittedIdx: index("responses_survey_submitted_idx").on(t.surveyId, t.submittedAt),
    clientRequestIdx: uniqueIndex("responses_client_request_idx").on(t.clientRequestId),
    surveyStatusIdx: index("responses_survey_status_idx").on(t.surveyId, t.status),
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
    /**
     * Удалось ли применить нормировку.
     *
     * Хранится, а не вычисляется при чтении: в момент подсчёта известны пол
     * и возраст респондента и та версия норм, что действовала тогда. Через
     * год пол может быть заполнен, нормы пересчитаны, — и вычисленный
     * задним числом ответ соврёт о том, как считалось на самом деле.
     *
     * Ложь означает, что `value` — сырой балл, а `band_label` пуст: полосы
     * заданы в единицах нормировки и к сырому баллу не применимы.
     */
    normalized: boolean("normalized").notNull().default(true),
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
    at: timestampCol("at").notNull().default(sql`now()`),
    /*
     * RESTRICT, а не SET NULL: actor_id входит в хэш записи, и обнуление
     * ссылки при удалении пользователя переписало бы журнал — то есть порвало
     * бы цепочку и сломало audit:verify.
     *
     * Раньше здесь стоял SET NULL, и удаление спасал только триггер
     * неизменяемости: попытка падала с сообщением «UPDATE запрещён», по
     * которому невозможно догадаться, что дело в журнале. Теперь причина
     * названа прямо: у пользователя есть записи в журнале, и он неудаляем.
     */
    actorId: text("actor_id").references(() => users.id, { onDelete: "restrict" }),
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

    /**
     * Хэш-цепочка: seq — сплошная нумерация, entryHash = SHA-256 от
     * (prevHash + канонизированная запись). Правка или удаление любой строки
     * рвёт цепочку у всех последующих — журнал становится доказуемым.
     */
    seq: integer("seq"),
    prevHash: text("prev_hash"),
    entryHash: text("entry_hash"),
  },
  (t) => ({
    atIdx: index("audit_at_idx").on(t.at),
    seqIdx: uniqueIndex("audit_seq_idx").on(t.seq),
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
/**
 * Случай риска — то, что разбирает специалист.
 *
 * Тревога поднимается на каждый отмеченный пункт, и это правильно: важно
 * знать, что именно сработало. Но разбирают не пункты, а человека. Пять
 * отмеченных пунктов одного обследуемого — один случай и одно клиническое
 * решение, а не пять.
 *
 * На стенде с 400 обследуемыми плоский список дал 397 карточек, среди
 * которых один человек встречался пять раз подряд: дежурный не мог ни
 * расставить приоритеты, ни найти нужного. Чем дольше система работала, тем
 * хуже становилась — недопустимо для инструмента, который ловит
 * суицидальный риск.
 *
 * Отсюда же методологическое следствие: калибровка порогов (ROC, PPV)
 * считается по случаям. Пять пунктов одного человека — не пять независимых
 * наблюдений, и складывать их в выборку значило бы завышать объём данных.
 */
export const alertCases = pgTable(
  "alert_cases",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),

    openedAt: timestampCol("opened_at").notNull().default(sql`now()`),
    /** Время последней входящей тревоги: по нему решается, продлевать ли окно */
    lastAlertAt: timestampCol("last_alert_at").notNull().default(sql`now()`),
    /** Самая тяжёлая из входящих: случай не легче худшего своего сигнала */
    severity: text("severity", { enum: ["moderate", "severe"] }).notNull().default("severe"),

    /**
     * Кто взял случай на себя. Двое дежурных не должны разбирать одного
     * человека дважды — а без явной пометки они об этом не узнают.
     */
    assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestampCol("assigned_at"),

    acknowledgedBy: text("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: timestampCol("acknowledged_at"),
    note: text("note"),
    /** Клинический исход разбора — сырьё для калибровки порогов */
    outcome: text("outcome", { enum: ["confirmed", "not_confirmed", "needs_followup"] }),
    /**
     * Случай собран автоматически при переходе со старой модели: исходы по
     * отдельным пунктам могли расходиться, и это надо честно пометить, а не
     * выдавать за решение специалиста.
     */
    mergedFromLegacy: boolean("merged_from_legacy").notNull().default(false),
  },
  (t) => ({
    userIdx: index("alert_cases_user_idx").on(t.userId),
    /*
     * Порядок колонок ровно как в запросе списка: сортировка по времени
     * последнего сигнала, потом по идентификатору. Прежний (acknowledgedAt,
     * lastAlertAt) не использовался ни разу — планировщик всё равно шёл
     * последовательным сканированием, потому что ведущая колонка в сортировке
     * не участвует.
     *
     * Частичный: в списке всегда только неразобранные, и держать в индексе
     * закрытые случаи незачем.
     */
    openIdx: index("alert_cases_open_idx").on(t.lastAlertAt.desc(), t.id.desc()),
    surveyIdx: index("alert_cases_survey_idx").on(t.surveyId),
  }),
);

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
    /**
     * Случай, к которому относится сигнал. Nullable только ради миграции:
     * тревоги, поднятые до перехода, привязываются отдельным шагом.
     */
    caseId: text("case_id").references(() => alertCases.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    severity: text("severity", { enum: ["moderate", "severe"] }).notNull().default("severe"),
    at: timestampCol("at").notNull().default(sql`now()`),
    acknowledgedBy: text("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: timestampCol("acknowledged_at"),
    note: text("note"),
    /**
     * Клинический исход разбора (6.1): подтверждена / не подтверждена /
     * требует наблюдения. Сырьё для ROC-калибровки порогов и PPV скрининга.
     * У тревог, разобранных до внедрения, — честный null.
     */
    outcome: text("outcome", { enum: ["confirmed", "not_confirmed", "needs_followup"] }),
  },
  (t) => ({
    surveyIdx: index("alerts_survey_idx").on(t.surveyId),
    openIdx: index("alerts_open_idx").on(t.acknowledgedAt),
    /*
     * Сигналы всегда читаются пачкой по случаю: и списком, и счётчиком.
     * Без индекса это было последовательное сканирование таблицы на каждый
     * случай на странице — тридцать сканирований на один экран.
     */
    caseIdx: index("alerts_case_idx").on(t.caseId),
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
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
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
    assignedAt: timestampCol("assigned_at").notNull().default(sql`now()`),
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
    startsAt: timestampCol("starts_at").notNull().default(sql`now()`),
    /** Дата окончания: после неё расписание больше не срабатывает */
    endsAt: timestampCol("ends_at"),
    active: boolean("active").notNull().default(true),
    lastRunAt: timestampCol("last_run_at"),
    nextRunAt: timestampCol("next_run_at").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
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
    ranAt: timestampCol("ran_at").notNull().default(sql`now()`),
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
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
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
    at: timestampCol("at").notNull().default(sql`now()`),
  },
  (t) => ({
    emailIdx: index("login_attempts_email_idx").on(t.email, t.at),
  }),
);

/**
 * Ссылки-приглашения.
 *
 * Пациент попадает в систему по ссылке/QR от своего психолога, а не через
 * открытую регистрацию: регистрация «с улицы» в клинической системе означала
 * бы неизвестных людей в списках. Токен хранится хешем: таблица не должна
 * раздавать входы тому, кто до неё дотянулся.
 */
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    /** Короткий код для ручного ввода на планшете (без ссылки) */
    code: text("code").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Батарея, которая назначится при регистрации */
    batteryId: text("battery_id").references(() => batteries.id, { onDelete: "set null" }),
    /** Подразделение, проставляемое новому аккаунту */
    unit: text("unit"),
    note: text("note"),
    maxUses: integer("max_uses").notNull().default(1),
    usedCount: integer("used_count").notNull().default(0),
    expiresAt: timestampCol("expires_at").notNull(),
    revokedAt: timestampCol("revoked_at"),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    hashIdx: uniqueIndex("invites_hash_idx").on(t.tokenHash),
    codeIdx: uniqueIndex("invites_code_idx").on(t.code),
  }),
);

/** Кто вошёл по какому приглашению — след для журнала и списков */
export const inviteUses = pgTable(
  "invite_uses",
  {
    inviteId: text("invite_id")
      .notNull()
      .references(() => invites.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    usedAt: timestampCol("used_at").notNull().default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.inviteId, t.userId] }),
  }),
);

/**
 * Сеанс киоска: один планшет — поток обследуемых по очереди.
 *
 * Токен сеанса — узкие права: вход участника и сдача прохождений, ничего из
 * полномочий оператора. В базе токен хешем; на устройстве киоска не остаётся
 * ничего, что стоило бы украсть.
 */
export const kioskSessions = pgTable(
  "kiosk_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    title: text("title").notNull(),
    batteryId: text("battery_id")
      .notNull()
      .references(() => batteries.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestampCol("expires_at").notNull(),
    closedAt: timestampCol("closed_at"),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    hashIdx: uniqueIndex("kiosk_sessions_hash_idx").on(t.tokenHash),
  }),
);

export const kioskParticipants = pgTable(
  "kiosk_participants",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => kioskSessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestampCol("started_at").notNull().default(sql`now()`),
    finishedAt: timestampCol("finished_at"),
  },
  (t) => ({
    sessionIdx: index("kiosk_participants_session_idx").on(t.sessionId),
  }),
);

/**
 * Журнал отправленных уведомлений о тревогах.
 *
 * Идемпотентность рассылки: тревога уведомляется один раз на каждый вид
 * (initial/escalation), сколько бы раз ни прошёл тик. Отдельная таблица, а не
 * колонка в risk_alerts: у одной тревоги несколько событий отправки с разными
 * получателями, и их след нужен целиком.
 */
export const alertNotifications = pgTable(
  "alert_notifications",
  {
    id: text("id").primaryKey(),
    alertId: text("alert_id")
      .notNull()
      .references(() => riskAlerts.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["initial", "escalation"] }).notNull(),
    sentAt: timestampCol("sent_at").notNull().default(sql`now()`),
    /** Кому ушло: email-адреса через запятую (для разбора инцидентов) */
    recipients: text("recipients").notNull(),
    /** none — SMTP не настроен, уведомление только в журнале */
    channel: text("channel", { enum: ["email", "none"] }).notNull(),
  },
  (t) => ({
    alertKindIdx: uniqueIndex("alert_notifications_alert_kind_idx").on(t.alertId, t.kind),
  }),
);

/**
 * Заключение специалиста по прохождению — поверх автоматической интерпретации.
 *
 * Строки append-only: каждая правка — новая версия. Подписанная версия
 * неизменна юридически и физически: следующая правка создаёт version+1
 * черновиком. Текущее заключение — строка с максимальной версией.
 */
/**
 * Консилиум по случаю.
 *
 * Сводка для консилиума в системе была, а самого процесса — нет: решение
 * принимали в кабинете и записывали в тетрадь. Через полгода восстановить,
 * кто что предлагал и почему решили именно так, было невозможно.
 *
 * Здесь фиксируются мнения участников и итоговое решение. Особое мнение —
 * отдельный вид записи, а не примечание: в клинике несогласие участника
 * должно быть видно, а не растворяться в общем протоколе.
 */
export const caseConferences = pgTable(
  "case_conferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Повод: что вынесли на обсуждение */
    reason: text("reason").notNull(),
    status: text("status", { enum: ["open", "decided", "cancelled"] })
      .notNull()
      .default("open"),
    /** Шифруется: итоговое решение — клинический текст */
    decision: text("decision"),
    decidedAt: timestampCol("decided_at"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "restrict" }),
    pathwayInstanceId: text("pathway_instance_id").references(() => pathwayInstances.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    userIdx: index("case_conferences_user_idx").on(t.userId),
    openIdx: index("case_conferences_open_idx").on(t.createdAt).where(sql`status = 'open'`),
  }),
);

/** Мнение участника: обычное или особое */
export const conferenceOpinions = pgTable(
  "conference_opinions",
  {
    id: text("id").primaryKey(),
    conferenceId: text("conference_id")
      .notNull()
      .references(() => caseConferences.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Шифруется вместе с текстом решения */
    text: text("text").notNull(),
    kind: text("kind", { enum: ["opinion", "dissent"] }).notNull().default("opinion"),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    conferenceIdx: index("conference_opinions_conference_idx").on(t.conferenceId, t.createdAt),
    oncePerAuthor: uniqueIndex("conference_opinions_once").on(t.conferenceId, t.authorId, t.kind),
  }),
);

/**
 * Токен устройства для пуш-уведомлений.
 *
 * До этого мобильное приложение молчало: назначили обследование — человек
 * узнавал, когда сам заходил. Для повторных замеров по расписанию это
 * означало, что половина просто не приходит.
 *
 * Токен принадлежит паре «человек + устройство»: у одного бывает телефон и
 * планшет, и выключенный на одном не должен глушить второй.
 */
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    platform: text("platform", { enum: ["ios", "android", "web"] }).notNull(),
    /** Когда устройство последний раз выходило на связь: мёртвые чистятся */
    lastSeenAt: timestampCol("last_seen_at").notNull().default(sql`now()`),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    tokenIdx: uniqueIndex("push_tokens_token_idx").on(t.token),
    userIdx: index("push_tokens_user_idx").on(t.userId),
  }),
);

/**
 * Отправленные пуши.
 *
 * Та же роль, что у alert_notifications для почты: идемпотентность и
 * доказательство отправки. Уведомление о тревоге, ушедшее дважды, приучает
 * игнорировать уведомления — а это дороже, чем не отправить вовсе.
 */
export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Ключ события: `assignment:<id>`, `alert:<id>` — по нему и дедупликация */
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull(),
    sentAt: timestampCol("sent_at").notNull().default(sql`now()`),
    ok: boolean("ok").notNull().default(true),
    error: text("error"),
  },
  (t) => ({
    uniqueEvent: uniqueIndex("push_deliveries_unique").on(t.userId, t.eventKey),
    sentIdx: index("push_deliveries_sent_idx").on(t.sentAt),
  }),
);

/**
 * Цель лечения.
 *
 * Ядро measurement-based care: цель формулируется измеримо и привязывается к
 * шкале, а не к ощущению. «Стало полегче» нельзя ни проверить, ни передать
 * коллеге; «ЛАП выше 4 к третьему месяцу» — можно.
 *
 * Достоверность изменения (RCI) в системе уже считается; цель встраивает её
 * в контур: видно не только «стало лучше», но и «изменение больше ошибки
 * измерения», а это разные утверждения.
 */
export const treatmentGoals = pgTable(
  "treatment_goals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    /** Код шкалы: он переживает смену версии методики, в отличие от id */
    scaleCode: text("scale_code").notNull(),
    /** Куда должно двигаться значение */
    direction: text("direction", { enum: ["down", "up"] }).notNull(),
    targetValue: doublePrecision("target_value").notNull(),
    /** Значение на момент постановки цели — точка отсчёта для RCI */
    baselineValue: doublePrecision("baseline_value"),
    dueAt: timestampCol("due_at"),
    status: text("status", { enum: ["open", "met", "missed", "cancelled"] })
      .notNull()
      .default("open"),
    note: text("note"),
    pathwayInstanceId: text("pathway_instance_id").references(() => pathwayInstances.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    closedAt: timestampCol("closed_at"),
  },
  (t) => ({
    userIdx: index("treatment_goals_user_idx").on(t.userId),
    openIdx: index("treatment_goals_open_idx").on(t.dueAt).where(sql`status = 'open'`),
  }),
);

/**
 * Личный план безопасности (Стэнли–Браун).
 *
 * У методики уже есть `safetyPlan` — текст немедленных действий, одинаковый
 * для всех, кто попал в полосу риска. Это инструкция инструмента. Здесь —
 * другое: план конкретного человека, составленный с ним в кабинете, его
 * словами и с его телефонами.
 *
 * Шифруется целиком: это самый чувствительный документ в системе. Хранится
 * версиями — план пересматривают, и предыдущая редакция должна остаться.
 */
export const safetyPlans = pgTable(
  "safety_plans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Шифрованный JSON с разделами плана */
    content: text("content").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    /** Когда план последний раз пересматривали вместе с человеком */
    reviewedAt: timestampCol("reviewed_at"),
  },
  (t) => ({
    userVersionIdx: uniqueIndex("safety_plans_user_version_idx").on(t.userId, t.version),
    activeIdx: index("safety_plans_active_idx").on(t.userId).where(sql`active`),
  }),
);

/**
 * Заметка приёма.
 *
 * Заключение привязано к прохождению — оно отвечает на вопрос «что показала
 * методика». Приём бывает и без методики: беседа, наблюдение, звонок
 * командиру. Такую запись некуда было положить, и она уходила в тетрадь.
 *
 * Устройство повторяет заключения намеренно: версии, подпись, шифрование.
 * Подписанное неизменно — правка создаёт новую версию.
 */
export const patientNotes = pgTable(
  "patient_notes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Приём, наблюдение, разбор случая, консультация */
    kind: text("kind", { enum: ["intake", "session", "observation", "consult"] })
      .notNull()
      .default("session"),
    /** Шифруется: клинический текст о человеке */
    text: text("text").notNull(),
    status: text("status", { enum: ["draft", "signed"] }).notNull().default("draft"),
    /** Необязательная привязка к маршруту: заметка как шаг пути */
    pathwayInstanceId: text("pathway_instance_id").references(() => pathwayInstances.id, {
      onDelete: "set null",
    }),
    /**
     * Приём, на котором запись сделана: заметка становится протоколом приёма.
     *
     * Необязательна намеренно: запись о человеке бывает и вне приёма —
     * наблюдение, разбор случая, консультация коллеги. Сделать привязку
     * обязательной значило бы отобрать у половины клинических записей место,
     * где они живут.
     */
    appointmentId: text("appointment_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    signedAt: timestampCol("signed_at"),
    signedBy: text("signed_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => ({
    userVersionIdx: uniqueIndex("patient_notes_user_version_idx").on(t.userId, t.version),
    userIdx: index("patient_notes_user_idx").on(t.userId, t.createdAt),
  }),
);

/**
 * Маршрут помощи — шаблон пути от скрининга до исхода.
 *
 * Скрининг, углублённое обследование, решение, вмешательство, повторный
 * замер — всё это в системе уже есть по отдельности и связывается в голове
 * специалиста. Маршрут делает связь явной, и тогда видно главное: кто застрял
 * и на каком шаге. Сегодня «отправили к психиатру и забыли» обнаруживается
 * случайно.
 */
export const pathways = pgTable(
  "pathways",
  {
    id: text("id").primaryKey(),
    title: localized("title").notNull(),
    description: localized("description"),
    groupId: text("group_id").references(() => surveyGroups.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({ groupIdx: index("pathways_group_idx").on(t.groupId) }),
);

/** Шаг шаблона: что должно произойти и в какой срок от начала маршрута */
export const pathwaySteps = pgTable(
  "pathway_steps",
  {
    id: text("id").primaryKey(),
    pathwayId: text("pathway_id")
      .notNull()
      .references(() => pathways.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: localized("title").notNull(),
    /**
     * Чем шаг закрывается: прохождением методики, батареей, направлением
     * или действием специалиста с записью. Решение — отдельный вид: оно
     * требует исхода, а не отметки «сделано».
     */
    kind: text("kind", { enum: ["survey", "battery", "referral", "action", "decision"] }).notNull(),
    surveyId: text("survey_id").references(() => surveys.id, { onDelete: "set null" }),
    batteryId: text("battery_id").references(() => batteries.id, { onDelete: "set null" }),
    /** Срок в днях от начала маршрута; null — без срока */
    dueDays: integer("due_days"),
    required: boolean("required").notNull().default(true),
  },
  (t) => ({ pathwayIdx: index("pathway_steps_pathway_idx").on(t.pathwayId, t.position) }),
);

/** Человек на маршруте */
export const pathwayInstances = pgTable(
  "pathway_instances",
  {
    id: text("id").primaryKey(),
    pathwayId: text("pathway_id")
      .notNull()
      .references(() => pathways.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestampCol("started_at").notNull().default(sql`now()`),
    startedBy: text("started_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    closedAt: timestampCol("closed_at"),
    closedBy: text("closed_by").references(() => users.id, { onDelete: "restrict" }),
    /** Чем кончилось: снят с наблюдения, направлен, продолжает наблюдение */
    outcome: text("outcome", { enum: ["resolved", "referred", "ongoing", "dropped"] }),
    note: text("note"),
  },
  (t) => ({
    userIdx: index("pathway_instances_user_idx").on(t.userId),
    openIdx: index("pathway_instances_open_idx")
      .on(t.startedAt)
      .where(sql`closed_at is null`),
  }),
);

/** Состояние конкретного шага у конкретного человека */
export const pathwayProgress = pgTable(
  "pathway_progress",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => pathwayInstances.id, { onDelete: "cascade" }),
    stepId: text("step_id")
      .notNull()
      .references(() => pathwaySteps.id, { onDelete: "cascade" }),
    dueAt: timestampCol("due_at"),
    state: text("state", { enum: ["pending", "done", "skipped"] }).notNull().default("pending"),
    doneAt: timestampCol("done_at"),
    doneBy: text("done_by").references(() => users.id, { onDelete: "restrict" }),
    /** Чем закрыт шаг: прохождение, направление или запись специалиста */
    responseId: text("response_id").references(() => responses.id, { onDelete: "set null" }),
    referralId: text("referral_id").references(() => referrals.id, { onDelete: "set null" }),
    note: text("note"),
  },
  (t) => ({
    instanceIdx: index("pathway_progress_instance_idx").on(t.instanceId),
    dueIdx: index("pathway_progress_due_idx").on(t.dueAt).where(sql`state = 'pending'`),
    uniqueStep: uniqueIndex("pathway_progress_unique").on(t.instanceId, t.stepId),
  }),
);

/**
 * Сохранённые виды: именованный срез экрана.
 *
 * Фильтры уже живут в адресе и передаются ссылкой, но каждый раз собирать
 * «мои просроченные по третьей роте» заново — работа, которую можно снять.
 * Хранятся параметры, а не данные: вид, открытый другим сотрудником,
 * покажет ему только то, что он и так вправе видеть.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Экран: alerts, patients, referrals… */
    scope: text("scope").notNull(),
    name: text("name").notNull(),
    /** Параметры адреса среза — то, что стоит после «?» */
    params: text("params").notNull(),
    /** Общий вид виден всем сотрудникам, личный — только владельцу */
    shared: boolean("shared").notNull().default(false),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    ownerScopeIdx: index("saved_views_owner_scope_idx").on(t.ownerId, t.scope),
    uniqueName: uniqueIndex("saved_views_unique_name").on(t.ownerId, t.scope, t.name),
  }),
);

export const conclusions = pgTable(
  "conclusions",
  {
    id: text("id").primaryKey(),
    responseId: text("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    status: text("status", { enum: ["draft", "signed"] }).notNull().default("draft"),
    // автор и подписавший — часть самого документа, стереть их нельзя
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    signedAt: timestampCol("signed_at"),
    /** Обращение, к которому относится запись; необязательно — см. episodes */
    episodeId: text("episode_id"),
    signedBy: text("signed_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => ({
    responseVersionIdx: uniqueIndex("conclusions_response_version_idx").on(t.responseId, t.version),
  }),
);

/**
 * Информированное согласие.
 *
 * Версии текста — append-only: правка текста создаёт новую версию, и у
 * каждого принятия зафиксировано, КАКОЙ текст человек видел. Согласие без
 * привязки к версии текста юридически пусто.
 */
export const consentTexts = pgTable(
  "consent_texts",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull(),
    /** Локализованный текст согласия */
    body: jsonb("body").$type<LocalizedText>().notNull(),
    // составитель — часть документа: обнулить его нельзя (см. 0031)
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    versionIdx: uniqueIndex("consent_texts_version_idx").on(t.version),
  }),
);

export const consents = pgTable(
  "consents",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    consentTextId: text("consent_text_id")
      .notNull()
      .references(() => consentTexts.id, { onDelete: "restrict" }),
    acceptedAt: timestampCol("accepted_at").notNull().default(sql`now()`),
    ip: text("ip"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.consentTextId] }),
  }),
);

/**
 * Направление (6.4): куда специалист отправил пациента по итогам обследования.
 *
 * Замыкает контур с другой стороны, чем исход тревоги: исход отвечает
 * «подтвердился ли риск», направление — «что с этим сделали». Статусы
 * меняются вперёд и не переписываются задним числом: история направления —
 * часть клинической записи.
 */
export const referrals = pgTable(
  "referrals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Прохождение-основание, если направление выписано по результату */
    responseId: text("response_id").references(() => responses.id, { onDelete: "set null" }),
    /** Тревога-основание, если направление выписано при разборе */
    alertId: text("alert_id").references(() => riskAlerts.id, { onDelete: "set null" }),
    destination: text("destination", {
      enum: ["psychiatrist", "inpatient", "outpatient", "commander", "other"],
    }).notNull(),
    urgency: text("urgency", { enum: ["routine", "urgent", "immediate"] })
      .notNull()
      .default("routine"),
    status: text("status", { enum: ["created", "accepted", "completed", "declined"] })
      .notNull()
      .default("created"),
    reason: text("reason"),
    /** Что ответила принимающая сторона */
    outcomeNote: text("outcome_note"),
    // составитель — часть документа: обнулить его нельзя (см. 0031)
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    /** Обращение, к которому относится запись; необязательно — см. episodes */
    episodeId: text("episode_id"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => ({
    userIdx: index("referrals_user_idx").on(t.userId),
    statusIdx: index("referrals_status_idx").on(t.status),
  }),
);

export type ReferralRow = typeof referrals.$inferSelect;

export type ConclusionRow = typeof conclusions.$inferSelect;

export type KioskSessionRow = typeof kioskSessions.$inferSelect;

export type InviteRow = typeof invites.$inferSelect;

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

/**
 * Присутствие сотрудника на экране.
 *
 * Строка живёт до следующего пульса: читаются только свежие записи, старые
 * вычищаются тем же запросом. Хранить это в памяти процесса нельзя —
 * инстансов API может быть несколько.
 */
export const presence = pgTable(
  "presence",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    seenAt: timestampCol("seen_at").notNull().default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.resource] }),
    resourceIdx: index("presence_resource_idx").on(t.resource, t.seenAt),
  }),
);

/* ═══════════ Поддержка решений ═══════════ */

/**
 * Правило поддержки решений.
 *
 * Система предлагает, человек решает. Правило не выполняет действий — оно
 * порождает предложение с объяснением, а принимает его специалист, и это
 * фиксируется. Иначе ответственность растворяется между правилом и врачом.
 */
export const decisionRules = pgTable(
  "decision_rules",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    groupId: text("group_id").references(() => surveyGroups.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    conditions: jsonb("conditions").notNull(),
    actions: jsonb("actions").notNull(),
    version: integer("version").notNull().default(1),
    note: text("note"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    updatedAt: timestampCol("updated_at").notNull().default(sql`now()`),
  },
  (t) => ({
    groupIdx: index("decision_rules_group_idx").on(t.groupId, t.enabled),
  }),
);

/** Срабатывание правила: предложение с объяснением и решением человека */
export const ruleHits = pgTable(
  "rule_hits",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => decisionRules.id, { onDelete: "cascade" }),
    /*
     * Версия правила на момент срабатывания. Правило потом поправят, а
     * объяснение должно остаться верным для того случая, который уже разобрали.
     */
    ruleVersion: integer("rule_version").notNull(),
    responseId: text("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    explanation: jsonb("explanation").notNull(),
    status: text("status").notNull().default("suggested"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestampCol("decided_at"),
    decisionNote: text("decision_note"),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    statusIdx: index("rule_hits_status_idx").on(t.status, t.createdAt),
    userIdx: index("rule_hits_user_idx").on(t.userId, t.createdAt),
  }),
);

/** Дежурная смена: кто сейчас принимает тревоги */
export const dutyShifts = pgTable(
  "duty_shifts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => surveyGroups.id, { onDelete: "cascade" }),
    startsAt: timestampCol("starts_at").notNull(),
    endsAt: timestampCol("ends_at").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    windowIdx: index("duty_shifts_window_idx").on(t.startsAt, t.endsAt),
  }),
);

/**
 * Запрос к информанту.
 *
 * Имя информанта не хранится намеренно: оценка командира не должна
 * превращаться в личное дело того, кто её дал. Хранится роль — именно она и
 * несёт смысл при сравнении перспектив.
 */
export const informantRequests = pgTable(
  "informant_requests",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    /** commander | peer | family | clinician */
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    note: text("note"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestampCol("expires_at").notNull(),
    responseId: text("response_id").references(() => responses.id, { onDelete: "set null" }),
    usedAt: timestampCol("used_at"),
    revokedAt: timestampCol("revoked_at"),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    hashIdx: uniqueIndex("informant_requests_hash_idx").on(t.tokenHash),
    patientIdx: index("informant_requests_patient_idx").on(t.patientId, t.createdAt),
  }),
);

/**
 * Кризисный режим учреждения: массовое поступление.
 *
 * Период, а не флаг: история включений — часть журнала. Открытый период
 * ровно один, это держит частичный уникальный индекс — два одновременных
 * «кризиса» означали бы, что выключение одного не выключает режим.
 */
export const crisisPeriods = pgTable("crisis_periods", {
  id: text("id").primaryKey(),
  reason: text("reason").notNull(),
  startedBy: text("started_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  startedAt: timestampCol("started_at").notNull().default(sql`now()`),
  endedBy: text("ended_by").references(() => users.id, { onDelete: "set null" }),
  endedAt: timestampCol("ended_at"),
});

/**
 * Устройство с установленным приложением.
 *
 * Нужно ради удалённого стирания: планшет носят по отделению, и потерять его
 * проще, чем ноутбук, а на нём лежит кэш обхода — имена, баллы, планы
 * безопасности.
 *
 * Ограничение честное и важное: стирание срабатывает, когда устройство в
 * следующий раз выйдет на связь. Устройство, которое больше не включат, этой
 * командой не очистить — от этого защищает шифрование хранилища и блокировка
 * экрана.
 */
export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label"),
    platform: text("platform"),
    lastSeenAt: timestampCol("last_seen_at").notNull().default(sql`now()`),
    wipeRequestedAt: timestampCol("wipe_requested_at"),
    wipeRequestedBy: text("wipe_requested_by").references(() => users.id, { onDelete: "set null" }),
    wipedAt: timestampCol("wiped_at"),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    userIdx: index("devices_user_idx").on(t.userId, t.lastSeenAt),
  }),
);

/**
 * Сохранённая когорта.
 *
 * Хранится правило отбора, а не список людей: «мужчины 20–30 с низким ЛАП»
 * через месяц — это другие люди, и наблюдать во времени надо правило.
 * Замороженный список отвечал бы на вопрос «кто подходил в день сохранения»,
 * который никто не задаёт.
 */
export const cohorts = pgTable(
  "cohorts",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    spec: jsonb("spec").notNull(),
    note: text("note"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    updatedAt: timestampCol("updated_at").notNull().default(sql`now()`),
  },
  (t) => ({
    authorIdx: index("cohorts_author_idx").on(t.createdBy, t.createdAt),
  }),
);

/**
 * Слепой индекс записей.
 *
 * Строка на каждый отпечаток слова. Ни текста, ни порядка слов здесь нет —
 * только «в этой записи встречается основа с таким отпечатком».
 */
export const noteSearch = pgTable(
  "note_search",
  {
    noteId: text("note_id").notNull(),
    /** note | conclusion — из какой сущности запись */
    kind: text("kind").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fp: text("fp").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.noteId, t.fp] }),
    fpIdx: index("note_search_fp_idx").on(t.fp),
    userIdx: index("note_search_user_idx").on(t.userId),
  }),
);

/**
 * Доступ в обход правил — «разбить стекло».
 *
 * Выдаётся сотрудником самому себе, но с обоснованием, на срок и громко:
 * запись в журнале и уведомление тем, кто отвечает за данные. Тихого варианта
 * нет намеренно — тихий обход правил это не обход, а дыра.
 */
export const breakGlass = pgTable(
  "break_glass",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    patientId: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    grantedAt: timestampCol("granted_at").notNull().default(sql`now()`),
    expiresAt: timestampCol("expires_at").notNull(),
    revokedAt: timestampCol("revoked_at"),
    revokedBy: text("revoked_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    actorIdx: index("break_glass_actor_idx").on(t.actorId, t.expiresAt),
    patientIdx: index("break_glass_patient_idx").on(t.patientId, t.grantedAt),
  }),
);

/* ── права: роли-шаблоны и личные исключения ──
 *
 * Три оси доступа не смешиваются: users.readOnly отвечает «может ли вообще
 * писать», эти таблицы — «что может делать», group_admins — «над кем».
 * Область здесь не переопределяется: она берётся оттуда, где была.
 */

export const roles = pgTable("roles", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  title: localized("title").notNull(),
  /** Встроенную роль нельзя удалить: на ней держится бэкфилл */
  isBuiltin: boolean("is_builtin").notNull().default(false),
  createdAt: timestampCol("created_at").notNull().default(sql`now()`),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    /** Код права, а не ссылка: справочник живёт в коде, см. shared/permissions */
    permission: text("permission").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permission] }) }),
);

export const staffRoles = pgTable(
  "staff_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    /** NULL — область берётся из group_admins, как и раньше */
    groupId: text("group_id").references(() => surveyGroups.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestampCol("granted_at").notNull().default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.roleId] }),
    roleIdx: index("staff_roles_role_idx").on(t.roleId),
  }),
);

export const permissionExceptions = pgTable(
  "permission_exceptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    /** grant добавляет, revoke отнимает; отнятое побеждает добавленное */
    mode: text("mode", { enum: ["grant", "revoke"] }).notNull(),
    /**
     * Причина обязательна и пишется словами.
     *
     * Список превратился бы в «выбрать первое», а написанное словами читают.
     * Через год именно по причине понятно, было ли исключение осмысленным.
     */
    reason: text("reason").notNull(),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedAt: timestampCol("granted_at").notNull().default(sql`now()`),
    /** Срок обязателен по смыслу, но не по схеме: бессрочное исключение
     *  заводится осознанно и видно в списке как бессрочное */
    expiresAt: timestampCol("expires_at"),
    revokedAt: timestampCol("revoked_at"),
  },
  (t) => ({
    userIdx: index("permission_exceptions_user_idx").on(t.userId, t.permission),
  }),
);

/* ═══════════════════════════════════════════════════════════════════
   Поликлиника: отделения, расписание, приёмы
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Отделение — организационная единица приёма.
 *
 * Часовой пояс лежит здесь, а не в настройках приложения, и это не
 * перестраховка. Расписание задаётся стенными часами: «приём с девяти до
 * часу». Слоты генерируются на восемь недель вперёд, то есть заведомо через
 * перевод часов. Сгенерируй их сложением UTC-смещения — и половина осени
 * уедет на час, причём молча: даты правдоподобные, приёмы не те.
 *
 * Пояс на отделении, а не на системе, потому что несколько экземпляров одной
 * системы — это разные учреждения (см. волну 8), а в одном учреждении
 * отделения могут оказаться в разных городах.
 */
export const departments = pgTable("departments", {
  id: text("id").primaryKey(),
  title: jsonb("title").notNull(),
  /** IANA-имя, не смещение: смещение устаревает дважды в год */
  timezone: text("timezone").notNull().default("Europe/Kyiv"),
  /**
   * Методика, которую отделение даёт при записи на первичный приём.
   *
   * null — не даёт вовсе, и это нормальное состояние: скрининг заводится
   * осознанно, а не появляется сам. Отделение, а не система: чем встречают
   * человека — решение отделения, и оно у разных отделений разное.
   */
  screeningSurveyId: text("screening_survey_id"),
  createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  archivedAt: timestampCol("archived_at"),
});

/**
 * Прикрепление пациента к отделению — «человек обслуживается здесь».
 *
 * Это не то же, что закреплённый специалист (users.leadSpecialistId). Слова
 * похожи, сущности разные, и склеить их в одну колонку — самая вероятная
 * ошибка этой волны. Прикрепление даёт право занять слот повторного приёма;
 * закрепление отвечает, кто «свой».
 *
 * Создаётся самой записью на первичный приём: отдельного действия, о котором
 * надо помнить, нет — человек с телефона доходит до приёма без участия
 * сотрудника, и ровно ради этого всё затевалось.
 */
export const departmentPatients = pgTable(
  "department_patients",
  {
    departmentId: text("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    patientId: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attachedAt: timestampCol("attached_at").notNull().default(sql`now()`),
    /** Записался сам или прикрепил сотрудник — разные истории, разный разбор */
    attachedVia: text("attached_via", { enum: ["visit", "staff"] }).notNull(),
    detachedAt: timestampCol("detached_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.departmentId, t.patientId] }),
    patientIdx: index("department_patients_patient_idx").on(t.patientId),
  }),
);

/**
 * Профиль специалиста: где принимает и как долго длится приём по умолчанию.
 *
 * Отдельная таблица, а не колонки в users: специалистом человек становится и
 * перестаёт быть, а учётная запись у него одна. Строка появляется, когда его
 * заводят в отделение, и исчезает, когда он уходит, — записи при этом
 * навсегда остаются за автором.
 */
export const specialistProfiles = pgTable(
  "specialist_profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    departmentId: text("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    position: text("position"),
    room: text("room"),
    /** Длительность приёма по умолчанию; шаблон недели может её переопределить */
    defaultSlotMinutes: integer("default_slot_minutes").notNull().default(50),
    /** Принимает ли сейчас: снятая галочка убирает из списка записи, не трогая прошлое */
    acceptsBookings: boolean("accepts_bookings").notNull().default(true),
  },
  (t) => ({
    departmentIdx: index("specialist_profiles_department_idx").on(t.departmentId),
  }),
);

/**
 * Обычная неделя специалиста. Из неё генерируются слоты.
 *
 * Время хранится как стенное (`time`), а не как метка: «с девяти» означает
 * девять по часам на стене и в марте, и в ноябре. Перевод в настоящий момент
 * происходит при генерации, через часовой пояс отделения.
 */
export const scheduleTemplates = pgTable(
  "schedule_templates",
  {
    id: text("id").primaryKey(),
    specialistId: text("specialist_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 1 — понедельник, 7 — воскресенье (ISO, как в date_part('isodow')) */
    weekday: integer("weekday").notNull(),
    startsAt: time("starts_at").notNull(),
    endsAt: time("ends_at").notNull(),
    slotMinutes: integer("slot_minutes").notNull(),
    kind: text("kind", { enum: ["primary", "repeat", "any"] }).notNull().default("any"),
    capacity: integer("capacity").notNull().default(1),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    specialistIdx: index("schedule_templates_specialist_idx").on(t.specialistId, t.weekday),
  }),
);

/**
 * Исключение из обычной недели: отпуск, замена, дополнительный день.
 *
 * Перекрывает шаблон на конкретную дату. `off` убирает приём целиком или на
 * часть дня, `extra` добавляет часы, которых в шаблоне нет.
 */
export const scheduleExceptions = pgTable(
  "schedule_exceptions",
  {
    id: text("id").primaryKey(),
    specialistId: text("specialist_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    kind: text("kind", { enum: ["off", "extra"] }).notNull(),
    /** null на обоих концах при kind=off означает «весь день» */
    startsAt: time("starts_at"),
    endsAt: time("ends_at"),
    slotMinutes: integer("slot_minutes"),
    note: text("note"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    specialistIdx: index("schedule_exceptions_specialist_idx").on(t.specialistId, t.date),
  }),
);

/**
 * Слот приёма — конкретное время у конкретного специалиста.
 *
 * Занятости здесь нет намеренно. Занят слот или нет — это число живых
 * приёмов против вместимости, и хранить рядом ещё и признак значило бы
 * завести второй источник правды, который рано или поздно разойдётся с
 * первым: отменённый приём забыли бы вычесть, и слот остался бы «занятым»
 * навсегда. `status` отвечает на другой вопрос — открыт ли слот для записи
 * вообще.
 *
 * `capacity` заложена сразу, хотя групповая работа отложена: слот на одного —
 * частный случай слота на многих, а обратный переход означал бы переписать
 * запись, расписание и все экраны. Стоит одну колонку.
 */
export const slots = pgTable(
  "slots",
  {
    id: text("id").primaryKey(),
    specialistId: text("specialist_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    departmentId: text("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    startsAt: timestampCol("starts_at").notNull(),
    endsAt: timestampCol("ends_at").notNull(),
    kind: text("kind", { enum: ["primary", "repeat", "any"] }).notNull().default("any"),
    capacity: integer("capacity").notNull().default(1),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    /**
     * Слот, который больше не попадает в расписание, но занят.
     *
     * Специалист сузил приёмные часы, а на выпавшее время уже кто-то записан.
     * Слот остаётся и подсвечивается: переносить или оставить решает человек.
     * Молчаливая отмена чужого приёма недопустима, а «изменил шаблон задним
     * числом» — самый вероятный способ её устроить.
     */
    offSchedule: boolean("off_schedule").notNull().default(false),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
  },
  (t) => ({
    /*
     * Идемпотентность генерации держится на этом индексе: повторный прогон
     * не плодит дубликаты, потому что дубликат физически невозможен.
     */
    uniq: uniqueIndex("slots_specialist_start_uniq").on(t.specialistId, t.startsAt),
    lookupIdx: index("slots_lookup_idx").on(t.departmentId, t.startsAt),
  }),
);

/**
 * Приём.
 *
 * Каждый переход статуса — в журнал: booked → confirmed → arrived →
 * in_progress → done, плюс no_show и cancelled.
 *
 * Неявка — не строка статистики, а повод: слот кончился, статус остался
 * booked, приём уходит в no_show и попадает в очередь работы отдельной
 * задачей. В психологическом отделе переставший приходить — это чаще
 * ухудшение, чем потеря интереса.
 */
export const appointments = pgTable(
  "appointments",
  {
    id: text("id").primaryKey(),
    slotId: text("slot_id")
      .notNull()
      .references(() => slots.id, { onDelete: "cascade" }),
    patientId: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    specialistId: text("specialist_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["primary", "repeat"] }).notNull(),
    /** Очно или дистанционно; своей видеосвязи не пишем, ссылка на стороннюю встречу */
    mode: text("mode", { enum: ["onsite", "remote"] }).notNull().default("onsite"),
    meetingUrl: text("meeting_url"),
    status: text("status", {
      enum: ["booked", "confirmed", "arrived", "in_progress", "done", "no_show", "cancelled"],
    })
      .notNull()
      .default("booked"),
    /**
     * Причина обращения словами пациента — шифруется как остальные записи о
     * человеке. Это текст пациента, а не диагноз: в карточке он подписан «со
     * слов пациента» и лежит отдельно от клинических записей.
     */
    reasonEnc: text("reason_enc"),
    /** Записал сам или сотрудник — видно в журнале и в карточке приёма */
    bookedBy: text("booked_by").references(() => users.id, { onDelete: "set null" }),
    bookedAt: timestampCol("booked_at").notNull().default(sql`now()`),
    confirmedAt: timestampCol("confirmed_at"),
    arrivedAt: timestampCol("arrived_at"),
    startedAt: timestampCol("started_at"),
    finishedAt: timestampCol("finished_at"),
    cancelledAt: timestampCol("cancelled_at"),
    cancelledBy: text("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    /** Отмена позже чем за сутки видна специалисту так же, как неявка */
    cancelledLate: boolean("cancelled_late").notNull().default(false),
    /**
     * Обращение, к которому относится приём.
     *
     * Необязательно: приём вне эпизода — это нормально, а не ошибка. Человек
     * может прийти один раз и не начать обращения вовсе.
     */
    episodeId: text("episode_id"),
  },
  (t) => ({
    slotIdx: index("appointments_slot_idx").on(t.slotId),
    patientIdx: index("appointments_patient_idx").on(t.patientId, t.bookedAt.desc()),
    specialistIdx: index("appointments_specialist_idx").on(t.specialistId),
    /*
     * Один человек — один живой приём в слоте. Частичный индекс, потому что
     * отменённый приём не должен мешать записаться снова: передумал, вернулся
     * через час — это нормальная история, а не попытка занять два места.
     */
    liveUniq: uniqueIndex("appointments_slot_patient_live_uniq")
      .on(t.slotId, t.patientId)
      .where(sql`status <> 'cancelled'`),
  }),
);

/**
 * Шаблоны заключений и заметок, справочник формулировок.
 *
 * Отделение пишет одни и те же обороты десятками раз. Каждый раз набирать их
 * заново — это не только время, но и разнобой: одно и то же состояние в двух
 * заключениях описано разными словами, и сравнить их потом нельзя.
 */
export const textTemplates = pgTable(
  "text_templates",
  {
    id: text("id").primaryKey(),
    /**
     * Чья библиотека. null — общая для учреждения: часть формулировок
     * одинакова везде, и заводить их в каждом отделении заново значит
     * получить пять расходящихся копий.
     */
    departmentId: text("department_id").references(() => departments.id, { onDelete: "cascade" }),
    /**
     * Шаблон подставляется целиком, формулировка — в место курсора. Это
     * разное поведение, а не разное оформление, поэтому вид хранится.
     */
    kind: text("kind", { enum: ["conclusion", "note", "phrase"] }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    archivedAt: timestampCol("archived_at"),
  },
  (t) => ({
    lookupIdx: index("text_templates_lookup_idx").on(t.kind, t.departmentId),
  }),
);

/**
 * Переписка пациента со своим специалистом.
 *
 * Асинхронная и с честными границами: ответ в рабочее время, это не
 * экстренная связь. Обещание круглосуточного ответа в психологическом отделе
 * опаснее отсутствия переписки вовсе — человек в кризис напишет и будет
 * ждать вместо того, чтобы позвонить.
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    specialistId: text("specialist_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    lastMessageAt: timestampCol("last_message_at").notNull().default(sql`now()`),
    closedAt: timestampCol("closed_at"),
  },
  (t) => ({
    /**
     * Один разговор на пару. Переписка — это не заявки: второй тред с тем же
     * человеком означал бы потерять контекст ровно там, где он и нужен.
     */
    pairUniq: uniqueIndex("threads_pair_uniq").on(t.patientId, t.specialistId),
    specialistIdx: index("threads_specialist_idx").on(t.specialistId, t.lastMessageAt.desc()),
    patientIdx: index("threads_patient_idx").on(t.patientId, t.lastMessageAt.desc()),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Шифруется как остальные клинические записи: человек пишет сюда о своём
     * состоянии, и это такие же сведения о нём, как заметка приёма.
     */
    textEnc: text("text_enc").notNull(),
    sentAt: timestampCol("sent_at").notNull().default(sql`now()`),
    readAt: timestampCol("read_at"),
  },
  (t) => ({
    threadIdx: index("messages_thread_idx").on(t.threadId, t.sentAt),
  }),
);

/**
 * Запись приёма голосом.
 *
 * Самые чувствительные данные в системе: не «результат методики», а разговор
 * человека о себе целиком. Отсюда всё устройство этой таблицы — согласие на
 * конкретный приём, файл вне базы, стенограмма под шифрованием и след
 * удаления.
 */
export const visitRecordings = pgTable(
  "visit_recordings",
  {
    id: text("id").primaryKey(),
    appointmentId: text("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    patientId: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    specialistId: text("specialist_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * Согласие на запись ИМЕННО ЭТОГО приёма.
     *
     * Не галочка в общем согласии, подписанном год назад: согласие на запись
     * разговора даётся в тот разговор, который записывают. Без отметки запись
     * не начинается, и это проверяет сервер, а не кнопка.
     */
    consentAt: timestampCol("consent_at"),
    /**
     * Кто отметил согласие. Пациент со своего устройства — сам; на приёме без
     * телефона отмечает специалист, и тогда по журналу видно, что согласие
     * получено голосом, а не нажатием пациента.
     */
    consentBy: text("consent_by").references(() => users.id, { onDelete: "set null" }),

    startedAt: timestampCol("started_at"),
    endedAt: timestampCol("ended_at"),
    durationMs: integer("duration_ms"),

    /**
     * Путь к зашифрованному файлу. Само аудио в базе не лежит: часовой приём
     * — десятки мегабайт, и класть их в строку значит превратить бэкап базы
     * в неподъёмный.
     */
    audioPath: text("audio_path"),
    audioBytes: integer("audio_bytes"),

    /** Расшифровка. Шифруется как остальные клинические записи */
    transcriptEnc: text("transcript_enc"),
    /** Чем расшифровано: без этого через год не понять, почему одна стенограмма лучше другой */
    transcriptEngine: text("transcript_engine"),
    transcriptAt: timestampCol("transcript_at"),

    status: text("status", {
      enum: [
        "consent_pending",
        "ready",
        "recording",
        "uploaded",
        "transcribing",
        "done",
        "failed",
        "discarded",
      ],
    })
      .notNull()
      .default("consent_pending"),
    failure: text("failure"),

    createdAt: timestampCol("created_at").notNull().default(sql`now()`),
    /**
     * Удаление: файл стирается, строка остаётся. Иначе не видно, что запись
     * была и её убрали, — а это ровно то, что нужно знать при разборе.
     */
    discardedAt: timestampCol("discarded_at"),
    discardedBy: text("discarded_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /**
     * Одна запись на приём. Две дорожки одного разговора — это две версии
     * того, что было сказано, и выбирать между ними некому.
     */
    appointmentUniq: uniqueIndex("visit_recordings_appointment_uniq").on(t.appointmentId),
    queueIdx: index("visit_recordings_status_idx").on(t.status),
  }),
);

/**
 * Эпизод обслуживания: одно обращение целиком.
 *
 * Приёмы, прохождения, заключения и направления лежали рядом, но не были
 * связаны: чтобы понять, «с чем человек приходил в марте и чем это
 * кончилось», приходилось складывать хронологию в голове. Эпизод делает
 * обращение единицей, у которой есть повод, ход и исход.
 */
export const episodes = pgTable(
  "episodes",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Кто ведёт обращение.
     *
     * Не то же, что ведущий специалист человека: человека ведёт один, а
     * обращений у него бывает несколько, и вести их могут разные люди.
     */
    leadSpecialistId: text("lead_specialist_id").references(() => users.id, {
      onDelete: "set null",
    }),
    departmentId: text("department_id").references(() => departments.id, { onDelete: "set null" }),

    openedAt: timestampCol("opened_at").notNull().default(sql`now()`),
    closedAt: timestampCol("closed_at"),

    /** Повод словами: «после командировки», «направлен командиром» */
    reasonEnc: text("reason_enc"),
    /** Исход при закрытии — тоже словами */
    outcomeEnc: text("outcome_enc"),
    outcomeKind: text("outcome_kind", {
      enum: ["improved", "stable", "worse", "referred", "dropped", "transferred"],
    }),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    patientIdx: index("episodes_patient_idx").on(t.patientId, t.openedAt.desc()),
  }),
);

/**
 * Диспансерное наблюдение.
 *
 * Человек на учёте должен показываться раз в столько-то месяцев. Сейчас это
 * держат в голове и в бумажном журнале, а значит теряют: просрочка не видна
 * никому, пока кто-нибудь случайно не вспомнит.
 */
export const dispensary = pgTable(
  "dispensary",
  {
    patientId: text("patient_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Группа учёта — словами учреждения, а не кодом. Разряды у отделений
     * разные, и справочник в коде устарел бы в первом же учреждении.
     */
    groupLabel: text("group_label").notNull(),
    /**
     * Раз в сколько месяцев показываться. Без умолчания в коде: срок задаёт
     * специалист, а «раз в квартал по умолчанию» стало бы правилом, которого
     * никто не принимал.
     */
    intervalMonths: integer("interval_months").notNull(),
    lastSeenAt: timestampCol("last_seen_at"),
    nextDueAt: timestampCol("next_due_at").notNull(),
    note: text("note"),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestampCol("added_at").notNull().default(sql`now()`),
    removedAt: timestampCol("removed_at"),
    removedBy: text("removed_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({ dueIdx: index("dispensary_due_idx").on(t.nextDueAt) }),
);
