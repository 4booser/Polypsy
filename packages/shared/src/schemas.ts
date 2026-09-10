import { z } from "zod";

export const roleSchema = z.enum(["superadmin", "admin", "user"]);

/**
 * Текст в конструкторе можно задать строкой или объектом языков.
 * Строка нормализуется в объект на записи — так старые вызовы продолжают
 * работать, а двуязычные методики заводятся сразу как есть.
 */
export const localizedSchema = z.union([
  z.string().max(4000),
  z.object({ uk: z.string().max(4000).optional(), ru: z.string().max(4000).optional() }),
]);

export function normalizeLocalized(
  value: z.infer<typeof localizedSchema> | null | undefined,
  /**
   * Язык, которым помечается простая строка. По умолчанию русский: весь
   * текст, заведённый строкой, написан по-русски. Двуязычные методики
   * передают объект и этого умолчания не касаются.
   */
  defaultLang: "uk" | "ru" = "ru",
): Record<string, string> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() ? { [defaultLang]: value } : null;
  const cleaned = Object.fromEntries(Object.entries(value).filter(([, v]) => v && v.trim()));
  return Object.keys(cleaned).length ? cleaned : null;
}

export const questionTypeSchema = z.enum([
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
]);

export const surveyStatusSchema = z.enum(["draft", "published", "closed"]);
export const scaleAggregationSchema = z.enum(["sum", "average", "count"]);
export const severitySchema = z.enum(["none", "mild", "moderate", "severe"]);
export const logicOperatorSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "lt",
  "gte",
  "lte",
  "contains",
  "answered",
  "not_answered",
]);

/** Типы, у которых обязаны быть варианты ответа */
export const CHOICE_TYPES = ["single", "multiple", "matrix", "ranking"] as const;
/** Типы с числовым ответом */
export const NUMERIC_TYPES = ["scale", "slider", "number"] as const;

export const sexSchema = z.enum(["male", "female"]);

/** ФИО: фамилия и имя обязательны, отчество нет */
const personNameSchema = {
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  middleName: z.string().max(80).nullish(),
};

/** Паспортная часть — её требуют регистрационные бланки всех методик */
const profileFields = {
  sex: sexSchema.nullish(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в формате ГГГГ-ММ-ДД").nullish(),
  unit: z.string().max(160).nullish(),
  position: z.string().max(160).nullish(),
  specialty: z.string().max(160).nullish(),
  rank: z.string().max(120).nullish(),
};

export const profileSchema = z.object({
  sex: sexSchema.nullish(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в формате ГГГГ-ММ-ДД").nullish(),
  unit: z.string().max(160).nullish(),
  position: z.string().max(160).nullish(),
  specialty: z.string().max(160).nullish(),
  rank: z.string().max(120).nullish(),
});

export const updateProfileSchema = profileSchema.extend({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  middleName: z.string().max(80).nullish(),
});

export const registerSchema = z
  .object({
    email: z.string().email(),
    /** Код или токен приглашения — обязателен при закрытой регистрации */
    inviteCode: z.string().max(200).nullish(),
    password: z.string().min(8).max(128),
    /** ФИО обязательно для обычного аккаунта и не хранится у псевдонимизированного */
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
    middleName: z.string().max(80).nullish(),
    /** Псевдонимизированный аккаунт: вместо ФИО показывается код */
    anonymous: z.boolean().default(false),
    /**
     * Телефон. Обязателен для всех, включая аккаунты под кодом.
     *
     * Это меняет смысл слова «анонимный», и на экране регистрации так и
     * написано: аккаунт анонимен ДЛЯ СПЕЦИАЛИСТА — он видит код, а не имя, —
     * но не для учреждения. Обещать полную анонимность и при этом хранить
     * телефон было бы обманом.
     *
     * Взамен закрывается самое опасное место: при сработавшей тревоге есть
     * кому позвонить.
     */
    phone: z.string().min(5).max(30),
    ...profileFields,
    /**
     * Принимается, но игнорируется сервером: роль назначает только администратор.
     * Поле оставлено в схеме, чтобы старые клиенты получали 201, а не 400,
     * а попытка его передать фиксировалась в журнале доступа.
     */
    role: roleSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.anonymous) {
      if (!v.lastName?.trim())
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lastName"], message: "Укажите фамилию" });
      if (!v.firstName?.trim())
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["firstName"], message: "Укажите имя" });
    }
  });

/** Создание учётной записи персонала — доступно только администратору */
/** Учётная запись сотрудника: ФИО обязательно, псевдонимизация не применяется */
export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  ...personNameSchema,
  role: roleSchema,
});

/** Назначение методики конкретному пациенту */
export const grantAccessSchema = z.object({
  userId: z.string().min(1),
  expiresAt: z.string().nullish(),
  note: z.string().max(500).nullish(),
  /**
   * Сколько раз можно пройти. Одна попытка по умолчанию — не потому, что так
   * строже, а потому, что вторая портит измерение: человек помнит вопросы.
   */
  attemptsAllowed: z.number().int().min(1).max(10).default(1),
});

export const batteryInputSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(2000).nullish(),
  groupId: z.string().nullish(),
  strictOrder: z.boolean().default(true),
  archived: z.boolean().default(false),
  items: z
    .array(
      z.object({
        surveyId: z.string().min(1),
        required: z.boolean().default(true),
      }),
    )
    .min(1, "В батарее должна быть хотя бы одна методика"),
});

export const assignBatterySchema = z.object({
  userId: z.string().min(1),
  dueAt: z.string().nullish(),
  note: z.string().max(500).nullish(),
});

export const scheduleInputSchema = z
  .object({
    title: z.string().min(2).max(200),
    batteryId: z.string().min(1),
    scope: z.enum(["unit", "users"]),
    unit: z.string().max(200).nullish(),
    userIds: z.array(z.string()).default([]),
    intervalDays: z.number().int().min(1).max(3650),
    dueDays: z.number().int().min(1).max(365).default(14),
    startsAt: z.string().nullish(),
    endsAt: z.string().nullish(),
    active: z.boolean().default(true),
  })
  .refine((v) => v.scope !== "unit" || !!v.unit?.trim(), {
    message: "Для охвата по подразделению нужно указать подразделение",
    path: ["unit"],
  })
  .refine((v) => v.scope !== "users" || v.userIds.length > 0, {
    message: "Выберите хотя бы одного обследуемого",
    path: ["userIds"],
  });

export const createKioskSessionSchema = z.object({
  title: z.string().min(2).max(200),
  batteryId: z.string().min(1),
  /** Срок жизни сеанса в часах: смена, а не недели */
  ttlHours: z.number().int().min(1).max(72).default(8),
});

export const kioskJoinSchema = z.object({
  lastName: z.string().min(1).max(100),
  firstName: z.string().min(1).max(100),
  middleName: z.string().max(100).nullish(),
  sex: z.enum(["male", "female"]).nullish(),
  birthDate: z.string().nullish(),
  unit: z.string().max(200).nullish(),
});

export const createReferralSchema = z.object({
  userId: z.string().min(1),
  responseId: z.string().nullish(),
  alertId: z.string().nullish(),
  destination: z.enum(["psychiatrist", "inpatient", "outpatient", "commander", "other"]),
  urgency: z.enum(["routine", "urgent", "immediate"]).default("routine"),
  reason: z.string().max(2000).nullish(),
});

export const updateReferralSchema = z.object({
  status: z.enum(["created", "accepted", "completed", "declined"]),
  outcomeNote: z.string().max(2000).nullish(),
});

export const createInviteSchema = z.object({
  batteryId: z.string().nullish(),
  unit: z.string().max(200).nullish(),
  note: z.string().max(500).nullish(),
  maxUses: z.number().int().min(1).max(500).default(1),
  /** Срок в днях от создания */
  ttlDays: z.number().int().min(1).max(365).default(14),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, "Пароль — минимум 10 символов").max(200),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/* ─────────────── Группы ─────────────── */

export const groupInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Цвет задаётся как #RRGGBB")
    .nullish(),
  position: z.number().int().min(0).optional(),
});

/* ─────────────── Конструктор опроса ─────────────── */

export const riskSeveritySchema = z.enum(["moderate", "severe"]);

export const optionInputSchema = z.object({
  text: localizedSchema,
  score: z.number().default(0),
  kind: z.enum(["option", "row"]).default("option"),
  /** Код для ключа: «yes» / «no» у методик с ответами да/нет */
  keyCode: z.string().max(40).nullish(),
  /** Выбор этого варианта поднимает тревогу немедленно */
  riskFlag: z.boolean().default(false),
  riskLabel: localizedSchema.nullish(),
  riskSeverity: riskSeveritySchema.nullish(),
});

export const bandInputSchema = z
  .object({
    minScore: z.number(),
    maxScore: z.number(),
    label: localizedSchema,
    severity: severitySchema.default("none"),
    description: localizedSchema.nullish(),
    /** Порядковая оценка методики — может быть перевёрнута относительно severity */
    grade: z.number().int().nullish(),
    /** Клиническая рекомендация по этой полосе */
    recommendation: localizedSchema.nullish(),
    /** Каскад: попадание в полосу назначает эту батарею */
    cascadeBatteryId: z.string().nullish(),
    cascadeDueDays: z.number().int().min(1).max(365).nullish(),
    /** Протокол наблюдения: дни повторов через запятую, «7,30» */
    followUpDays: z
      .string()
      .max(100)
      .nullish()
      .refine(
        (v) => !v || v.split(",").every((x) => /^\s*\d{1,3}\s*$/.test(x)),
        "Дни повторов — числа через запятую, например «7,30»",
      ),
  })
  .refine((b) => b.maxScore >= b.minScore, {
    message: "Верхняя граница нормы не может быть меньше нижней",
    path: ["maxScore"],
  });

export const scaleInputSchema = z.object({
  /** Ключ субшкалы, по нему вопросы к ней привязываются */
  code: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z0-9_-]+$/, "Код субшкалы: латиница, цифры, дефис, подчёркивание"),
  title: localizedSchema,
  description: localizedSchema.nullish(),
  aggregation: scaleAggregationSchema.default("sum"),

  kind: z.enum(["clinical", "validity"]).default("clinical"),
  normalization: z.enum(["raw", "ratio", "tscore", "sten"]).default("raw"),
  ratioDenominator: z.number().positive().nullish(),
  validityThreshold: z.number().nullish(),
  validityDirection: z.enum(["above", "below"]).nullish(),
  validityMessage: localizedSchema.nullish(),

  bands: z.array(bandInputSchema).default([]),

  /**
   * Ключ шкалы: какие пункты в неё входят и с каким ожидаемым ответом.
   * Номера — позиции в массиве questions, начиная с 1, как в пособиях.
   */
  key: z
    .array(
      z.object({
        item: z.number().int().min(1),
        matchKey: z.string().max(40).nullish(),
        weight: z.number().default(1),
      }),
    )
    .default([]),

  /** Поправки от других шкал: { from: "K", coefficient: 0.5 } */
  corrections: z
    .array(z.object({ from: z.string().min(1), coefficient: z.number() }))
    .default([]),

  norms: z
    .array(
      z.object({
        sex: sexSchema.nullish(),
        ageMin: z.number().int().nullish(),
        ageMax: z.number().int().nullish(),
        mean: z.number(),
        sd: z.number().positive(),
        source: z.string().max(200).nullish(),
      }),
    )
    .default([]),

  stenTable: z
    .array(
      z.object({
        sex: sexSchema.nullish(),
        ageMin: z.number().int().nullish(),
        ageMax: z.number().int().nullish(),
        rawMin: z.number(),
        rawMax: z.number(),
        sten: z.number().int().min(1).max(10),
      }),
    )
    .default([]),
});

export const sectionInputSchema = z.object({
  /** Клиентский ключ для связи вопросов с секцией внутри одного запроса */
  key: z.string().min(1).max(60),
  title: localizedSchema,
  description: localizedSchema.nullish(),
});

export const logicInputSchema = z.object({
  /** Индекс вопроса-источника в массиве questions */
  sourceIndex: z.number().int().min(0),
  operator: logicOperatorSchema,
  value: z.unknown().optional(),
  action: z.enum(["show", "hide"]).default("show"),
});

export const questionInputSchema = z
  .object({
    type: questionTypeSchema,
    title: localizedSchema,
    help: localizedSchema.nullish(),
    required: z.boolean().default(false),
    /** Ключ секции из sections[].key */
    sectionKey: z.string().max(60).nullish(),
    /** Код субшкалы из scales[].code */
    scaleCode: z.string().max(40).nullish(),
    reverseScored: z.boolean().default(false),

    minValue: z.number().nullish(),
    maxValue: z.number().nullish(),
    step: z.number().positive().nullish(),
    minLabel: localizedSchema.nullish(),
    maxLabel: localizedSchema.nullish(),

    randomizeOptions: z.boolean().default(false),
    timeLimitSec: z.number().int().positive().max(3600).nullish(),

    riskThreshold: z.number().nullish(),
    riskLabel: localizedSchema.nullish(),
    riskSeverity: riskSeveritySchema.nullish(),

    options: z.array(optionInputSchema).default([]),
    logic: z.array(logicInputSchema).default([]),
  })
  .superRefine((q, ctx) => {
    const needsOptions = (CHOICE_TYPES as readonly string[]).includes(q.type);
    if (needsOptions) {
      const choices = q.options.filter((o) => o.kind === "option");
      if (choices.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "Нужно минимум 2 варианта ответа",
        });
      }
      if (q.type === "matrix" && q.options.filter((o) => o.kind === "row").length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "У матричного вопроса нужна хотя бы одна строка",
        });
      }
    }

    if ((NUMERIC_TYPES as readonly string[]).includes(q.type)) {
      const min = q.minValue ?? (q.type === "scale" ? 1 : 0);
      const max = q.maxValue ?? (q.type === "scale" ? 5 : 100);
      if (max <= min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxValue"],
          message: "Максимум должен быть больше минимума",
        });
      }
    }

    if (q.type === "info" && q.required) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required"],
        message: "Информационный блок не может быть обязательным",
      });
    }

    if (q.reverseScored && !q.scaleCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reverseScored"],
        message: "Обратный ключ имеет смысл только для вопроса, привязанного к субшкале",
      });
    }
  });

export const surveySettingsSchema = z.object({
  groupId: z.string().nullish(),
  instructions: localizedSchema.nullish(),
  timeLimitSec: z.number().int().positive().max(86400).nullish(),
  randomizeQuestions: z.boolean().default(false),
  allowBack: z.boolean().default(true),
  showProgress: z.boolean().default(true),
  anonymous: z.boolean().default(false),
  visibility: z.enum(["public", "restricted"]).default("public"),
  tooFastMs: z.number().int().min(200).max(120_000).nullish(),
  alertEscalateMinutes: z.number().int().min(1).max(10_080).nullish(),
  safetyPlan: localizedSchema.nullish(),
  showResultsToPatient: z.boolean().nullish(),
  allowRetake: z.boolean().default(false),
  scoringEnabled: z.boolean().default(false),
});

export const createSurveySchema = z
  .object({
    title: localizedSchema,
    description: localizedSchema.nullish(),
    administration: z.enum(["self", "clinician", "informant"]).default("self"),
    sections: z.array(sectionInputSchema).default([]),
    scales: z.array(scaleInputSchema).default([]),
    questions: z.array(questionInputSchema).default([]),
  })
  .merge(surveySettingsSchema.partial())
  .superRefine((s, ctx) => {
    const sectionKeys = new Set(s.sections.map((x) => x.key));
    if (sectionKeys.size !== s.sections.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: "Ключи секций должны быть уникальны" });
    }

    const scaleCodes = new Set(s.scales.map((x) => x.code));
    if (scaleCodes.size !== s.scales.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scales"], message: "Коды субшкал должны быть уникальны" });
    }

    s.questions.forEach((q, i) => {
      if (q.sectionKey && !sectionKeys.has(q.sectionKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", i, "sectionKey"],
          message: `Секция «${q.sectionKey}» не описана в sections`,
        });
      }
      if (q.scaleCode && !scaleCodes.has(q.scaleCode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", i, "scaleCode"],
          message: `Субшкала «${q.scaleCode}» не описана в scales`,
        });
      }
      q.logic.forEach((rule, j) => {
        if (rule.sourceIndex >= s.questions.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["questions", i, "logic", j, "sourceIndex"],
            message: "Условие ссылается на несуществующий вопрос",
          });
        }
        if (rule.sourceIndex >= i) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["questions", i, "logic", j, "sourceIndex"],
            message: "Условие может ссылаться только на предыдущий вопрос",
          });
        }
      });
    });
  });

export const updateSurveySchema = z
  .object({
    title: localizedSchema.optional(),
    description: localizedSchema.nullish(),
    administration: z.enum(["self", "clinician", "informant"]).optional(),
    status: surveyStatusSchema.optional(),
    sections: z.array(sectionInputSchema).optional(),
    scales: z.array(scaleInputSchema).optional(),
    questions: z.array(questionInputSchema).optional(),
    /** Комментарий к новой версии — что именно поменяли */
    versionNote: z.string().max(500).optional(),
  })
  .merge(surveySettingsSchema.partial());

/* ─────────────── Прохождение ─────────────── */

export const answerSchema = z.object({
  questionId: z.string().min(1),
  optionIds: z.array(z.string()).optional(),
  text: z.string().max(10000).optional(),
  number: z.number().optional(),
  date: z.string().optional(),
  matrix: z.record(z.string(), z.string()).optional(),
  ranking: z.array(z.string()).optional(),
  skipped: z.boolean().optional(),

  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  changeCount: z.number().int().min(0).max(10000).optional(),
  visitCount: z.number().int().min(0).max(10000).optional(),
});

/** Автосохранение черновика прохождения */
export const draftSchema = z.object({
  answers: z.array(answerSchema),
  startedAt: z.string(),
  durationMs: z.number().int().min(0).max(86_400_000),
  events: z.array(z.unknown()).max(5000).default([]),
});

/** Событие ленты: показ вопроса, выбор, смена, сброс, уход с вопроса */
export const answerEventSchema = z.object({
  questionId: z.string().min(1),
  sequence: z.number().int().min(0),
  kind: z.enum(["shown", "set", "change", "clear", "leave"]),
  elapsedMs: z.number().int().min(0).max(86_400_000),
  at: z.string(),
  value: z.unknown().optional(),
});

export const submitResponseSchema = z.object({
  /** Ид попытки для идемпотентного повтора из офлайн-очереди */
  clientRequestId: z.string().max(64).nullish(),
  answers: z.array(answerSchema),
  startedAt: z.string(),
  durationMs: z.number().int().min(0).max(86_400_000),
  status: z.enum(["completed", "abandoned"]).default("completed"),
  /** Полная лента событий — из неё восстанавливается процесс ответа */
  events: z.array(answerEventSchema).max(5000).default([]),
  /**
   * Кого обследовали, если методику заполняет специалист.
   * Только для методик с administration = "clinician".
   */
  onBehalfOf: z.string().nullish(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type GrantAccessInput = z.infer<typeof grantAccessSchema>;
export type BatteryInput = z.input<typeof batteryInputSchema>;
export type AssignBatteryInput = z.infer<typeof assignBatterySchema>;
export type ScheduleInput = z.input<typeof scheduleInputSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreateInviteInput = z.input<typeof createInviteSchema>;
export type CreateReferralInput = z.input<typeof createReferralSchema>;
export type UpdateReferralInput = z.infer<typeof updateReferralSchema>;
export type CreateKioskSessionInput = z.input<typeof createKioskSessionSchema>;
export type KioskJoinInput = z.infer<typeof kioskJoinSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type GroupInput = z.infer<typeof groupInputSchema>;
export type OptionInput = z.infer<typeof optionInputSchema>;
export type BandInput = z.infer<typeof bandInputSchema>;
export type ScaleInput = z.infer<typeof scaleInputSchema>;
export type SectionInput = z.infer<typeof sectionInputSchema>;
export type LogicInput = z.infer<typeof logicInputSchema>;
export type QuestionInput = z.infer<typeof questionInputSchema>;
export type CreateSurveyInput = z.infer<typeof createSurveySchema>;
export type UpdateSurveyInput = z.infer<typeof updateSurveySchema>;
export type AnswerInput = z.infer<typeof answerSchema>;
export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;
export type AnswerEventInput = z.infer<typeof answerEventSchema>;

/**
 * Типы «до применения умолчаний» — удобны, когда методика описывается литералом
 * в коде или в сидах: не нужно перечислять поля, у которых есть default.
 */
export type CreateSurveyDraft = z.input<typeof createSurveySchema>;
export type QuestionDraft = z.input<typeof questionInputSchema>;
export type ScaleDraft = z.input<typeof scaleInputSchema>;


/* ─────────── query-параметры ─────────── */

/**
 * Дата в запросе — календарный день (ГГГГ-ММ-ДД) или полный ISO-момент.
 * Проверяется не только формат, но и существование даты: «2026-02-31»
 * формату соответствует, а в сравнении с меткой времени ведёт себя
 * непредсказуемо.
 */
export const queryDate = z.string().refine(
  (v) => {
    if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v)) return false;
    const parsed = new Date(v);
    if (Number.isNaN(parsed.getTime())) return false;
    /*
     * Обратная сверка обязательна: Date.parse("2026-02-31") не падает, а
     * молча превращает дату в 3 марта. Отчёт «с 31 февраля» построился бы
     * по чужому периоду, и никто бы этого не заметил.
     */
    return parsed.toISOString().slice(0, 10) === v.slice(0, 10);
  },
  { message: "ожидается существующая дата ГГГГ-ММ-ДД" },
);

/** Числовой параметр из строки запроса с границами */
export const queryInt = (min: number, max: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

/**
 * Параметр из закрытого списка.
 *
 * Молчаливый откат к значению по умолчанию здесь недопустим: опечатка в
 * `?profile=deidentifed` отдавала бы ПОЛНУЮ выгрузку с именами вместо
 * обезличенной, и запросивший был бы уверен в обратном. Неизвестное значение —
 * отказ с перечислением допустимых.
 */
export const queryEnum = <const T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v))
    .pipe(z.enum(values as unknown as [T[number], ...T[number][]]));

/** Флаг вида ?all=1 — присутствие со значением 1/true */
export const queryFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

export const dateRangeQuery = z.object({
  from: queryDate.optional(),
  to: queryDate.optional(),
});

export const auditQuery = dateRangeQuery.extend({
  limit: queryInt(1, 500, 100),
  offset: queryInt(0, 1_000_000, 0),
  action: z.string().max(64).optional(),
  actorId: z.string().uuid().optional(),
  subjectUserId: z.string().uuid().optional(),
});

export const exportQuery = z.object({
  profile: queryEnum(["full", "deidentified", "anonymous"], "full"),
  lang: queryEnum(["uk", "ru"], "ru"),
  /**
   * Зачем выгружают.
   *
   * Необязательно для машины и обязательно по смыслу: выгрузка клинических
   * данных — это событие, которое через год кто-то будет разбирать, и «кто и
   * когда» без «зачем» не отвечает ни на один вопрос разбора.
   */
  purpose: z.string().max(300).optional(),
});

export const facetQuery = z.object({
  facet: queryEnum(["sex", "age", "sexAge", "lang", "unit"], "sexAge"),
});

export const cohortQuery = z.object({
  by: queryEnum(["unit", "sex", "ageGroup", "month", "rank"], "unit"),
});

export const respondentQuery = z.object({
  limit: queryInt(1, 200, 50),
  cursor: z.string().max(200).optional(),
  /** Поиск идёт по расшифрованным ФИО уже в приложении — здесь только длина */
  search: z.string().max(120).optional().transform((v) => (v ?? "").trim().toLowerCase()),
});

export const responseListQuery = z.object({
  limit: queryInt(1, 200, 50),
  /*
   * Курсор непрозрачен: внутри пара «время и идентификатор».
   *
   * Раньше здесь стояла голая дата, и на границе страницы терялись все
   * прохождения с той же меткой времени — а при групповом обследовании они
   * совпадают до миллисекунды. Клиент курсор не разбирает: получил и вернул.
   */
  before: z.string().max(200).optional(),
});

/** Настройки рабочего места; каждое поле необязательно и правится отдельно */
export const workspacePrefsSchema = z.object({
  startScreen: z.enum(["dashboard", "worklist", "alerts", "patients"]).optional(),
  density: z.enum(["cozy", "compact"]).optional(),
  theme: z.enum(["dark", "light"]).optional(),
  lang: z.enum(["uk", "ru"]).optional(),
  dismissedHints: z.array(z.string().max(60)).max(100).optional(),
  eventsSeenAt: z.string().nullable().optional(),
});

/* ── Поликлиника: расписание и приёмы ── */

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "время в виде ЧЧ:ММ");

export const scheduleTemplateSchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    startsAt: timeOfDay,
    endsAt: timeOfDay,
    slotMinutes: z.number().int().min(5).max(480),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: "приём не может кончаться раньше, чем начался",
    path: ["endsAt"],
  });

export const scheduleExceptionSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(["off", "extra"]),
    startsAt: timeOfDay.nullish(),
    endsAt: timeOfDay.nullish(),
    slotMinutes: z.number().int().min(5).max(480).nullish(),
    note: z.string().max(500).nullish(),
  })
  .refine((v) => v.kind !== "extra" || (v.startsAt && v.endsAt), {
    message: "дополнительный день без часов бессмыслен: непонятно, что добавлять",
    path: ["startsAt"],
  })
  .refine((v) => !v.startsAt || !v.endsAt || v.endsAt > v.startsAt, {
    message: "интервал не может кончаться раньше, чем начался",
    path: ["endsAt"],
  });

export const bookAppointmentSchema = z.object({
  slotId: z.string().min(1),
  /**
   * Кого записываем. Пустое — себя: пациент из мобилки не знает и не должен
   * знать своего идентификатора, а подставить чужой было бы способом
   * записать за другого.
   */
  patientId: z.string().min(1).nullish(),
  mode: z.enum(["onsite", "remote"]).default("onsite"),
  meetingUrl: z.string().url().max(500).nullish(),
  /** Причина обращения словами пациента; необязательна намеренно */
  reason: z.string().max(2000).nullish(),
});

export const rescheduleAppointmentSchema = z.object({
  slotId: z.string().min(1),
});

export const cancelAppointmentSchema = z.object({
  reason: z.string().max(500).nullish(),
});

export const specialistProfileSchema = z.object({
  departmentId: z.string().min(1),
  position: z.string().max(200).nullish(),
  room: z.string().max(50).nullish(),
  defaultSlotMinutes: z.number().int().min(5).max(480).default(50),
  acceptsBookings: z.boolean().default(true),
});

export const departmentSchema = z.object({
  title: localizedSchema,
  /** IANA-имя пояса: смещение устаревает дважды в год */
  timezone: z.string().min(1).max(80).default("Europe/Kyiv"),
  /** Методика, которую дают при записи на первичный приём; null — не дают */
  screeningSurveyId: z.string().nullish(),
});
