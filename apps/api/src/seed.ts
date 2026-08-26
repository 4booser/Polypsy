/**
 * Демо-данные: две группы методик, три опросника и синтетические прохождения,
 * чтобы аналитика была не пустой.
 *
 * Методики здесь — авторские демонстрационные, а не клинические инструменты.
 * Формулировки написаны специально для демо: реальные шкалы (PHQ-9, GAD-7, BDI и т.п.)
 * защищены авторским правом и требуют лицензии, поэтому дословно не воспроизводятся.
 * Перед клиническим использованием методики нужно завести через интерфейс,
 * согласовав нормы и формулировки с правообладателем.
 */
import { eq, inArray } from "drizzle-orm";
import { ageAt, answerScore, computeProfile, computeScores, createSurveySchema, normalizeLocalized, t, type Answer } from "@quizzy/shared";
import { client, db } from "./db";
import {
  answerEvents,
  answers,
  batteries,
  batteryAssignments,
  batteryItems,
  groupAdmins,
  responseScores,
  responses,
  riskAlerts,
  surveyAccess,
  surveyGroups,
  schedules,
  surveys,
  users,
  type UserRow,
} from "./db/schema";
import { hashPassword } from "./lib/auth";
import { createVersion, getSurvey } from "./lib/surveys";
import type { CreateSurveyDraft } from "@quizzy/shared";
import { sr45 } from "./instruments/sr45";
import { sadPersons } from "./instruments/sadPersons";
import { minimult } from "./instruments/minimult";
import { mlo } from "./instruments/mlo";

/** Пациенты генерируются пачкой: без объёма аналитику не на чем смотреть */
const PATIENT_POOL: {
  lastName: string;
  firstName: string;
  middleName: string | null;
  sex: "male" | "female";
  birthDate: string;
  unit: string;
  position: string;
  rank: string;
}[] = [
  { lastName: "Гончаренко", firstName: "Тарас", middleName: "Ігорович", sex: "male", birthDate: "1994-03-12", unit: "1-й батальон", position: "Стрелок", rank: "Солдат" },
  { lastName: "Савченко", firstName: "Оксана", middleName: "Миколаївна", sex: "female", birthDate: "1988-11-02", unit: "Медицинская рота", position: "Санитарный инструктор", rank: "Сержант" },
  { lastName: "Ковальчук", firstName: "Андрей", middleName: "Игоревич", sex: "male", birthDate: "1999-07-21", unit: "1-й батальон", position: "Пулемётчик", rank: "Солдат" },
  { lastName: "Мельник", firstName: "Оксана", middleName: "Василівна", sex: "female", birthDate: "1992-01-30", unit: "Узел связи", position: "Связист", rank: "Старший солдат" },
  { lastName: "Бондаренко", firstName: "Сергей", middleName: "Петрович", sex: "male", birthDate: "1979-05-08", unit: "2-й батальон", position: "Командир отделения", rank: "Старший сержант" },
  { lastName: "Шевченко", firstName: "Игорь", middleName: "Миколайович", sex: "male", birthDate: "2003-09-14", unit: "2-й батальон", position: "Стрелок", rank: "Солдат" },
  { lastName: "Гриценко", firstName: "Наталья", middleName: "Олеговна", sex: "female", birthDate: "1996-12-05", unit: "Медицинская рота", position: "Фельдшер", rank: "Сержант" },
  { lastName: "Ткаченко", firstName: "Виталий", middleName: "Романович", sex: "male", birthDate: "1985-04-19", unit: "Рота обеспечения", position: "Водитель", rank: "Солдат" },
  { lastName: "Лисенко", firstName: "Богдан", middleName: "Тарасович", sex: "male", birthDate: "2001-02-27", unit: "1-й батальон", position: "Гранатомётчик", rank: "Солдат" },
  { lastName: "Савченко", firstName: "Ирина", middleName: "Петрівна", sex: "female", birthDate: "1990-08-11", unit: "Штаб", position: "Психолог части", rank: "Лейтенант" },
  { lastName: "Романюк", firstName: "Максим", middleName: "Юрійович", sex: "male", birthDate: "1997-06-03", unit: "2-й батальон", position: "Снайпер", rank: "Старший солдат" },
  { lastName: "Данилюк", firstName: "Артём", middleName: "Сергеевич", sex: "male", birthDate: "1983-10-25", unit: "Рота обеспечения", position: "Механик", rank: "Сержант" },
];

interface AccountSeed {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  role: "superadmin" | "admin" | "user";
  sex?: "male" | "female" | null;
  birthDate?: string | null;
  unit?: string | null;
  position?: string | null;
  specialty?: string | null;
  rank?: string | null;
}

const ACCOUNTS: AccountSeed[] = [
  { email: "root@quizzy.dev", password: "root12345", firstName: "Мария", lastName: "Орлова", middleName: "Сергеевна", role: "superadmin" as const },
  { email: "4booser@gmail.com", password: "quizzy12345", firstName: "Системы", lastName: "Администратор", middleName: null, role: "superadmin" as const },
  { email: "psy@quizzy.dev", password: "psy12345", firstName: "Анна", lastName: "Иванова", middleName: "Петровна", role: "admin" as const },
  { email: "psy2@quizzy.dev", password: "psy212345", firstName: "Игорь", lastName: "Смирнов", middleName: "Олегович", role: "admin" as const },
  { email: "user@quizzy.dev", password: "user12345", firstName: "Дмитрий", lastName: "Петров", middleName: "Андреевич", role: "user" as const, sex: "male" as const, birthDate: "1994-03-12", unit: "1-й батальон", position: "Стрелок", specialty: "Стрелок", rank: "Солдат" },
  { email: "user2@quizzy.dev", password: "user212345", firstName: "Елена", lastName: "Ким", middleName: null, role: "user" as const, sex: "female" as const, birthDate: "1988-11-02", unit: "Медицинская рота", position: "Санитарный инструктор", specialty: "Медик", rank: "Сержант" },
];

async function upsertUser(data: AccountSeed) {
  const existing = await db.query.users.findFirst({ where: eq(users.email, data.email) });
  if (existing) return existing;
  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      middleName: data.middleName,
      sex: data.sex ?? null,
      birthDate: data.birthDate ?? null,
      unit: data.unit ?? null,
      position: data.position ?? null,
      specialty: data.specialty ?? null,
      rank: data.rank ?? null,
      passwordHash: await hashPassword(data.password),
      role: data.role,
    })
    .returning();
  return row!;
}

const [root, , psy, psy2, patient, patient2] = await Promise.all(ACCOUNTS.map(upsertUser));

/** Дополнительные пациенты — чтобы аналитика и списки не были вырожденными */
const pool: UserRow[] = [];
for (const [i, p] of PATIENT_POOL.entries()) {
  pool.push(
    await upsertUser({
      email: `patient${i + 1}@quizzy.dev`,
      password: "patient12345",
      role: "user" as const,
      ...p,
    }),
  );
}
console.log(`  пациентов в пуле: ${pool.length}`);

async function upsertGroup(title: string, description: string, color: string, position: number) {
  const existing = await db.query.surveyGroups.findFirst({ where: eq(surveyGroups.title, title) });
  if (existing) return existing;
  const [row] = await db
    .insert(surveyGroups)
    .values({
      id: crypto.randomUUID(),
      title,
      description,
      color,
      position,
      createdBy: root!.id,
    })
    .returning();
  return row!;
}

const intake = await upsertGroup(
  "Приёмное отделение",
  "Первичный скрининг при поступлении",
  "#3b5bfd",
  0,
);
const dynamics = await upsertGroup(
  "Динамическое наблюдение",
  "Повторные замеры в ходе лечения",
  "#16a34a",
  1,
);

// психолог Иванова ведёт приёмное отделение, Смирнов — динамическое наблюдение:
// так видно, что админ группы не видит чужие методики
for (const [group, admin] of [
  [intake, psy!],
  [dynamics, psy2!],
] as const) {
  await db
    .insert(groupAdmins)
    .values({ groupId: group.id, userId: admin.id, addedBy: root!.id })
    .onConflictDoNothing();
}

/** Лайкертовская шкала частоты — общий набор вариантов для матричных пунктов */
const frequency = [
  { text: "Совсем нет", score: 0 },
  { text: "Несколько дней", score: 1 },
  { text: "Больше половины дней", score: 2 },
  { text: "Почти каждый день", score: 3 },
];

const emotional: CreateSurveyDraft = {
  title: "Скрининг эмоционального состояния (демо)",
  description: "Оценка выраженности тревоги и сниженного настроения за последние две недели",
  instructions:
    "Отвечайте, ориентируясь на своё состояние за последние 14 дней. Здесь нет правильных и неправильных ответов — важна ваша собственная оценка.",
  groupId: intake.id,
  scoringEnabled: true,
  showProgress: true,
  allowBack: true,
  allowRetake: true,
  timeLimitSec: 900,
  sections: [
    { key: "anx", title: "Тревога", description: "Как часто вас беспокоило следующее" },
    { key: "mood", title: "Настроение", description: null },
    { key: "ctx", title: "Контекст", description: null },
  ],
  scales: [
    {
      code: "anxiety",
      title: "Тревога",
      description: "Суммарный балл по пунктам тревожного спектра",
      aggregation: "sum",
      bands: [
        { minScore: 0, maxScore: 4, label: "Норма", severity: "none", description: "Признаков тревожного расстройства не выявлено" },
        { minScore: 5, maxScore: 9, label: "Лёгкая тревога", severity: "mild", description: "Рекомендовано наблюдение" },
        { minScore: 10, maxScore: 14, label: "Умеренная тревога", severity: "moderate", description: "Показана консультация специалиста" },
        { minScore: 15, maxScore: 21, label: "Выраженная тревога", severity: "severe", description: "Требуется консультация врача-психиатра" },
      ],
    },
    {
      code: "mood",
      title: "Сниженное настроение",
      aggregation: "sum",
      description: null,
      bands: [
        { minScore: 0, maxScore: 4, label: "Норма", severity: "none", description: null },
        { minScore: 5, maxScore: 9, label: "Лёгкое снижение", severity: "mild", description: null },
        { minScore: 10, maxScore: 14, label: "Умеренное снижение", severity: "moderate", description: null },
        { minScore: 15, maxScore: 18, label: "Выраженное снижение", severity: "severe", description: null },
      ],
    },
  ],
  questions: [
    {
      type: "matrix",
      title: "Как часто за последние две недели вас беспокоило:",
      sectionKey: "anx",
      scaleCode: "anxiety",
      required: true,
      options: [
        ...frequency.map((f) => ({ ...f, kind: "option" as const })),
        { text: "Ощущение нервозности или взвинченности", score: 0, kind: "row" as const },
        { text: "Неспособность остановить беспокойство", score: 0, kind: "row" as const },
        { text: "Беспокойство по разным поводам", score: 0, kind: "row" as const },
        { text: "Трудности с расслаблением", score: 0, kind: "row" as const },
      ],
    },
    {
      type: "scale",
      title: "Насколько сильно тревога мешала вам в повседневных делах?",
      help: "0 — совсем не мешала, 10 — делала обычные дела почти невозможными",
      sectionKey: "anx",
      scaleCode: "anxiety",
      required: true,
      minValue: 0,
      maxValue: 10,
      step: 1,
      minLabel: "Не мешала",
      maxLabel: "Мешала критически",
      options: [],
    },
    {
      type: "matrix",
      title: "Как часто за последние две недели вы отмечали:",
      sectionKey: "mood",
      scaleCode: "mood",
      required: true,
      options: [
        ...frequency.map((f) => ({ ...f, kind: "option" as const })),
        { text: "Подавленность или безнадёжность", score: 0, kind: "row" as const },
        { text: "Потерю интереса к обычным занятиям", score: 0, kind: "row" as const },
        { text: "Утомляемость или нехватку сил", score: 0, kind: "row" as const },
      ],
    },
    {
      // Пункт с обратным ключом: формулировка положительная, поэтому согласие
      // должно снижать балл по шкале «снижение настроения». Баллы вариантов
      // растут по силе согласия, а reverseScored инвертирует их внутри диапазона 0–3.
      type: "single",
      title: "Насколько вы согласны: «В последние две недели я чувствовал(а) себя бодрым и полным сил»?",
      help: "Пункт с обратным ключом — он уравновешивает склонность соглашаться со всеми утверждениями подряд",
      sectionKey: "mood",
      scaleCode: "mood",
      reverseScored: true,
      required: true,
      options: [
        { text: "Совсем не согласен", score: 0, kind: "option" as const },
        { text: "Скорее не согласен", score: 1, kind: "option" as const },
        { text: "Скорее согласен", score: 2, kind: "option" as const },
        { text: "Полностью согласен", score: 3, kind: "option" as const },
      ],
    },
    {
      // критический пункт: положительный ответ поднимает тревогу немедленно,
      // не дожидаясь конца прохождения и подсчёта баллов
      type: "single",
      title: "Появлялись ли у вас мысли о том, что вам лучше не жить?",
      help: "Если такие мысли есть — сообщите об этом лечащему врачу",
      sectionKey: "ctx",
      required: true,
      options: [
        { text: "Нет", score: 0, kind: "option" as const },
        {
          text: "Изредка",
          score: 2,
          kind: "option" as const,
          riskFlag: true,
          riskLabel: "Эпизодические мысли о нежелании жить",
          riskSeverity: "moderate" as const,
        },
        {
          text: "Часто",
          score: 3,
          kind: "option" as const,
          riskFlag: true,
          riskLabel: "Частые мысли о нежелании жить — требуется срочный осмотр",
          riskSeverity: "severe" as const,
        },
      ],
    },
    {
      type: "yesno",
      title: "Обращались ли вы ранее к психологу или психотерапевту?",
      sectionKey: "ctx",
      required: true,
      options: [
        { text: "Да", score: 0, kind: "option" as const },
        { text: "Нет", score: 0, kind: "option" as const },
      ],
    },
    {
      type: "longtext",
      title: "Что, по вашему мнению, сильнее всего влияет на ваше состояние?",
      sectionKey: "ctx",
      required: false,
      // показывается только тем, кто ответил «Да» на предыдущий вопрос
      logic: [{ sourceIndex: 5, operator: "answered" as const, action: "show" as const }],
      options: [],
    },
  ],
};

const sleep: CreateSurveyDraft = {
  // назначается персонально: видна только тем пациентам, кому её выдали
  visibility: "restricted",
  title: "Качество сна (демо)",
  description: "Короткий опрос о режиме и качестве сна",
  instructions: "Оцените свой сон за последнюю неделю.",
  groupId: intake.id,
  scoringEnabled: true,
  allowRetake: true,
  showProgress: true,
  sections: [],
  scales: [
    {
      code: "sleep",
      title: "Нарушения сна",
      aggregation: "sum",
      description: null,
      bands: [
        { minScore: 0, maxScore: 3, label: "Сон в норме", severity: "none", description: null },
        { minScore: 4, maxScore: 7, label: "Лёгкие нарушения", severity: "mild", description: null },
        { minScore: 8, maxScore: 12, label: "Умеренные нарушения", severity: "moderate", description: null },
        { minScore: 13, maxScore: 20, label: "Выраженные нарушения", severity: "severe", description: null },
      ],
    },
  ],
  questions: [
    {
      type: "number",
      title: "Сколько часов в среднем вы спите за ночь?",
      required: true,
      minValue: 0,
      maxValue: 14,
      step: 1,
      options: [],
    },
    {
      type: "scale",
      title: "Насколько сильно недосып мешает вам днём?",
      minValue: 0,
      maxValue: 10,
      step: 1,
      scaleCode: "sleep",
      required: true,
      // значение от 9 и выше — повод показать пациента специалисту
      riskThreshold: 9,
      riskLabel: "Крайне выраженное влияние недосыпа на дневное функционирование",
      riskSeverity: "moderate" as const,
      options: [],
    },
    {
      type: "slider",
      title: "Оцените качество сна",
      minValue: 0,
      maxValue: 10,
      step: 1,
      minLabel: "Очень плохо",
      maxLabel: "Отлично",
      scaleCode: "sleep",
      reverseScored: true,
      required: true,
      options: [],
    },
    {
      type: "multiple",
      title: "Что мешает вам засыпать?",
      help: "Можно выбрать несколько вариантов",
      scaleCode: "sleep",
      required: false,
      options: [
        { text: "Навязчивые мысли", score: 2, kind: "option" as const },
        { text: "Шум", score: 1, kind: "option" as const },
        { text: "Боль или дискомфорт", score: 2, kind: "option" as const },
        { text: "Гаджеты перед сном", score: 1, kind: "option" as const },
        { text: "Ничего не мешает", score: 0, kind: "option" as const },
      ],
    },
    {
      type: "ranking",
      title: "Расставьте по важности то, что помогло бы улучшить ваш сон",
      required: false,
      options: [
        { text: "Режим дня", score: 0, kind: "option" as const },
        { text: "Физическая активность", score: 0, kind: "option" as const },
        { text: "Работа с тревогой", score: 0, kind: "option" as const },
        { text: "Отказ от кофеина", score: 0, kind: "option" as const },
      ],
    },
  ],
};

const followUp: CreateSurveyDraft = {
  title: "Контрольный замер состояния (демо)",
  description: "Повторная оценка динамики на фоне терапии",
  groupId: dynamics.id,
  scoringEnabled: true,
  allowRetake: true,
  anonymous: false,
  sections: [],
  scales: [
    {
      code: "wellbeing",
      title: "Самочувствие",
      aggregation: "average",
      description: null,
      bands: [
        { minScore: 0, maxScore: 3, label: "Низкое", severity: "severe", description: null },
        { minScore: 3.01, maxScore: 6, label: "Среднее", severity: "moderate", description: null },
        { minScore: 6.01, maxScore: 10, label: "Хорошее", severity: "none", description: null },
      ],
    },
  ],
  questions: [
    {
      type: "scale",
      title: "Как вы оцениваете своё самочувствие сегодня?",
      minValue: 0,
      maxValue: 10,
      step: 1,
      scaleCode: "wellbeing",
      required: true,
      options: [],
    },
    {
      type: "scale",
      title: "Насколько вы удовлетворены результатами лечения?",
      minValue: 0,
      maxValue: 10,
      step: 1,
      scaleCode: "wellbeing",
      required: true,
      options: [],
    },
    {
      type: "text",
      title: "Что изменилось с прошлого визита?",
      required: false,
      options: [],
    },
  ],
};

async function upsertSurvey(draft: CreateSurveyDraft, status: "published" | "draft") {
  // прогоняем через ту же схему, что и API: демо-методики обязаны быть валидными
  const input = createSurveySchema.parse(draft);
  // ищем по украинскому варианту названия: title теперь локализован
  const wanted = typeof input.title === "string" ? input.title : (input.title.uk ?? input.title.ru ?? "");
  const all = await db.select().from(surveys);
  const existing = all.find((s) => t(s.title as never) === wanted);
  if (existing) return existing;

  const [row] = await db
    .insert(surveys)
    .values({
      id: crypto.randomUUID(),
      groupId: input.groupId ?? null,
      title: normalizeLocalized(input.title)!,
      description: normalizeLocalized(input.description),
      instructions: normalizeLocalized(input.instructions),
      administration: input.administration,
      safetyPlan: normalizeLocalized(input.safetyPlan),
      status,
      publishedAt: status === "published" ? new Date().toISOString() : null,
      timeLimitSec: input.timeLimitSec ?? null,
      randomizeQuestions: input.randomizeQuestions ?? false,
      allowBack: input.allowBack ?? true,
      showProgress: input.showProgress ?? true,
      anonymous: input.anonymous ?? false,
      visibility: input.visibility ?? "public",
      allowRetake: input.allowRetake ?? false,
      scoringEnabled: input.scoringEnabled ?? false,
      createdBy: psy!.id,
    })
    .returning();

  const versionId = await createVersion(row!.id, input, psy!.id, "Первая версия");
  console.log(`  методика: ${t(input.title as never)}`);
  return { ...row!, currentVersionId: versionId };
}

const emotionalRow = await upsertSurvey(emotional, "published");
const sleepRow = await upsertSurvey(sleep, "published");
const followUpRow = await upsertSurvey(followUp, "published");

// методики из пособий НДЦ ГП ЗСУ — на них проверяется движок подсчёта
const sr45Row = await upsertSurvey({ ...sr45, groupId: intake.id }, "published");
const sadPersonsRow = await upsertSurvey({ ...sadPersons, groupId: intake.id }, "published");
const minimultRow = await upsertSurvey({ ...minimult, groupId: intake.id }, "published");
const mloRow = await upsertSurvey({ ...mlo, groupId: intake.id }, "published");

/* ─────────────── Синтетические прохождения ─────────────── */

/** Детерминированный псевдослучайный генератор — сид воспроизводим между запусками */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const random = makeRandom(42);
const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)]!;

async function generateResponses(surveyId: string, count: number) {
  const survey = await getSurvey(surveyId);
  if (!survey) return;

  const existing = await db.select().from(responses).where(eq(responses.surveyId, surveyId));
  if (existing.length > 0) return;

  const respondents = [patient!.id, patient2!.id];

  for (let i = 0; i < count; i++) {
    const abandoned = random() < 0.15;
    // ~12% заполняют небрежно: отвечают почти мгновенно и одним и тем же вариантом
    const careless = !abandoned && random() < 0.12;
    const daysAgo = Math.floor(random() * 30);
    const startedAt = new Date(Date.now() - daysAgo * 86_400_000 - Math.floor(random() * 8) * 3_600_000);

    const generated: Answer[] = [];
    for (const question of survey.questions) {
      if (question.type === "info") continue;
      // у брошенных прохождений заполнена только первая половина
      if (abandoned && generated.length > survey.questions.length / 2) break;

      const answer: Answer = {
        questionId: question.id,
        durationMs: careless
          ? Math.round(300 + random() * 900)
          : Math.round(2000 + random() * 18000),
        changeCount: careless ? 0 : random() < 0.25 ? Math.ceil(random() * 3) : 0,
        visitCount: random() < 0.15 ? 2 : 1,
      };

      const choices = question.options.filter((o) => o.kind === "option");
      const rows = question.options.filter((o) => o.kind === "row");

      switch (question.type) {
        case "single":
        case "yesno":
          answer.optionIds = [careless ? choices[0]!.id : pick(choices).id];
          break;
        case "multiple":
          answer.optionIds = choices.filter(() => random() < 0.4).map((o) => o.id);
          if (!answer.optionIds.length) answer.optionIds = [pick(choices).id];
          break;
        case "matrix":
          // «прямая линия»: один и тот же столбец во всех строках
          answer.matrix = Object.fromEntries(
            rows.map((r) => [r.id, careless ? choices[0]!.id : pick(choices).id]),
          );
          break;
        case "ranking":
          answer.ranking = [...choices].sort(() => random() - 0.5).map((o) => o.id);
          break;
        case "scale":
        case "slider":
        case "number": {
          const min = question.minValue ?? 0;
          const max = question.maxValue ?? 10;
          answer.number = careless ? min : Math.round(min + random() * (max - min));
          break;
        }
        case "text":
        case "longtext":
          if (random() < 0.5) {
            answer.text = pick([
              "Стало заметно легче засыпать",
              "Тревога уменьшилась, но остаётся утомляемость",
              "Существенных изменений не отмечаю",
              "Помогают прогулки и режим",
            ]);
          } else {
            answer.skipped = true;
          }
          break;
        default:
          answer.skipped = true;
      }
      generated.push(answer);
    }

    const scores = survey.scoringEnabled ? computeScores(survey, generated) : [];
    const responseId = crypto.randomUUID();
    const durationMs = generated.reduce((sum, a) => sum + (a.durationMs ?? 0), 0);

    await db.transaction(async (tx) => {
      await tx.insert(responses)
        .values({
          id: responseId,
          surveyId,
          userId: survey.anonymous ? null : pick(respondents),
          versionId: survey.versionId,
          status: abandoned ? "abandoned" : "completed",
          startedAt: startedAt.toISOString(),
          submittedAt: abandoned ? null : new Date(startedAt.getTime() + durationMs).toISOString(),
          durationMs,
        });

      let sequence = 0;
      let clock = startedAt.getTime();

      for (const answer of generated) {
        const question = survey.questions.find((q) => q.id === answer.questionId)!;

        // лента событий: показ → раздумье → выбор → возможные переключения
        const spent = answer.durationMs ?? 0;
        const thinkMs = Math.round(spent * (0.3 + random() * 0.4));
        const pushEvent = async (kind: "shown" | "set" | "change" | "leave", elapsedMs: number) => {
          await tx.insert(answerEvents)
            .values({
              id: crypto.randomUUID(),
              responseId,
              questionId: answer.questionId,
              sequence: sequence++,
              kind,
              elapsedMs,
              at: new Date(clock + elapsedMs).toISOString(),
              value: kind === "shown" || kind === "leave" ? null : (answer.optionIds ?? answer.number ?? null),
            });
        };

        await pushEvent("shown", 0);
        if (!answer.skipped) {
          await pushEvent("set", thinkMs);
          for (let i = 0; i < (answer.changeCount ?? 0); i++) {
            await pushEvent("change", Math.min(spent, thinkMs + Math.round((spent - thinkMs) * ((i + 1) / 4))));
          }
        }
        await pushEvent("leave", spent);
        clock += spent;
        await tx.insert(answers)
          .values({
            id: crypto.randomUUID(),
            responseId,
            questionId: answer.questionId,
            optionIds: answer.optionIds ?? null,
            text: answer.text ?? null,
            number: answer.number ?? null,
            matrix: answer.matrix ?? null,
            ranking: answer.ranking ?? null,
            skipped: answer.skipped ?? false,
            score: survey.scoringEnabled ? answerScore(question, answer) : null,
            durationMs: answer.durationMs ?? 0,
            changeCount: answer.changeCount ?? 0,
            visitCount: answer.visitCount ?? 1,
          });
      }

      if (!abandoned) {
        for (const score of scores) {
          await tx.insert(responseScores)
            .values({
              id: crypto.randomUUID(),
              responseId,
              scaleId: score.scaleId,
              rawScore: score.rawScore,
              maxScore: score.maxScore,
              percent: score.percent,
              bandLabel: score.band?.label ?? null,
              severity: score.band?.severity ?? null,
            });
        }
      }
    });
  }
  console.log(`  прохождений сгенерировано: ${count}`);
}

/**
 * Прохождения методик, заданных ключом.
 *
 * Профили распределены по уровням риска, а не равномерно случайны: иначе все
 * попадали бы в среднюю полосу и интерпретационные нормы нечем было бы проверить.
 */
async function generateKeyed(surveyId: string, respondents: string[], perPatient: number) {
  const survey = await getSurvey(surveyId);
  if (!survey) return;
  const existing = await db.select().from(responses).where(eq(responses.surveyId, surveyId));
  if (existing.length > 0) return;

  // доля ответов «в сторону риска»: от почти нулевой до высокой
  const severityMix = [0.05, 0.12, 0.2, 0.3, 0.42, 0.55, 0.68, 0.82];

  // демография обследуемых нужна для нормирования: без пола норма по полу
  // не находится и T-балл молча подменяется сырым — на демо-данных это
  // выглядит как «нормы не работают»
  const people = new Map(
    (await db.select().from(users).where(inArray(users.id, respondents))).map((u) => [u.id, u]),
  );

  let made = 0;
  for (const [index, userId] of respondents.entries()) {
    for (let visit = 0; visit < perPatient; visit++) {
      const riskShare = severityMix[(index + visit) % severityMix.length]!;
      const startedAt = new Date(Date.now() - (perPatient - visit) * 9 * 86_400_000 - index * 3_600_000);

      const generated: Answer[] = [];
      for (const question of survey.questions) {
        if (question.type === "info") continue;
        // ключ шкалы Sr определяет, какой ответ считается «в сторону риска»
        const keyed = survey.scales
          .filter((sc) => sc.kind === "clinical")
          .flatMap((sc) => sc.items)
          .find((it) => it.questionId === question.id);
        const riskyKey = keyed?.matchKey ?? "yes";
        const safeKey = riskyKey === "yes" ? "no" : "yes";
        const choose = random() < riskShare ? riskyKey : safeKey;
        const option = question.options.find((o) => o.keyCode === choose) ?? question.options[0]!;

        generated.push({
          questionId: question.id,
          optionIds: [option.id],
          durationMs: Math.round(1800 + random() * 9000),
          changeCount: random() < 0.2 ? 1 : 0,
          visitCount: 1,
        });
      }

      const person = people.get(userId);
      const profile = computeProfile(survey, generated, {
        sex: person?.sex ?? null,
        age: ageAt(person?.birthDate ?? null, startedAt.toISOString()),
      });
      const responseId = crypto.randomUUID();
      const durationMs = generated.reduce((sum, a) => sum + (a.durationMs ?? 0), 0);

      await db.transaction(async (tx) => {
        await tx.insert(responses).values({
          id: responseId,
          surveyId,
          userId,
          versionId: survey.versionId,
          status: "completed",
          startedAt: startedAt.toISOString(),
          submittedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
          durationMs,
        });

        for (const a of generated) {
          const question = survey.questions.find((q) => q.id === a.questionId)!;
          await tx.insert(answers).values({
            id: crypto.randomUUID(),
            responseId,
            questionId: a.questionId,
            optionIds: a.optionIds ?? null,
            skipped: false,
            score: answerScore(question, a),
            durationMs: a.durationMs ?? 0,
            changeCount: a.changeCount ?? 0,
            visitCount: 1,
          });

          // тревоги по критическим пунктам — так же, как при реальном прохождении
          const picked = new Set(a.optionIds ?? []);
          const risky = question.options.find((o) => o.riskFlag && picked.has(o.id));
          if (risky) {
            await tx
              .insert(riskAlerts)
              .values({
                id: crypto.randomUUID(),
                responseId,
                surveyId,
                questionId: question.id,
                userId,
                label: risky.riskLabel ?? question.title,
                severity: risky.riskSeverity ?? "severe",
                at: startedAt.toISOString(),
              })
              .onConflictDoNothing();
          }
        }

        for (const score of profile.scores) {
          await tx.insert(responseScores).values({
            id: crypto.randomUUID(),
            responseId,
            scaleId: score.scaleId,
            rawScore: score.rawScore,
            value: score.value,
            normalization: score.normalization,
            maxScore: score.maxScore,
            percent: score.percent,
            bandLabel: score.band?.label ?? null,
            severity: score.band?.severity ?? null,
          });
        }
      });
      made++;
    }
  }
  console.log(`  прохождений по ключу: ${made}`);
}

await generateResponses(emotionalRow.id, 46);
await generateResponses(sleepRow.id, 28);
await generateSeries(followUpRow.id, [patient!.id, patient2!.id], 5);

const poolIds = pool.map((p) => p.id);
await generateKeyed(sr45Row.id, poolIds, 3);
await generateKeyed(sadPersonsRow.id, poolIds.slice(0, 8), 1);
await generateKeyed(minimultRow.id, poolIds, 2);
await generateKeyed(mloRow.id, poolIds.slice(0, 10), 1);

/**
 * Повторные замеры одного пациента с направленным трендом — чтобы график
 * динамики показывал улучшение на фоне терапии, а не случайный шум.
 */
async function generateSeries(surveyId: string, patients: string[], visits: number) {
  const survey = await getSurvey(surveyId);
  if (!survey) return;
  const existing = await db.select().from(responses).where(eq(responses.surveyId, surveyId));
  if (existing.length > 0) return;

  for (const userId of patients) {
    for (let visit = 0; visit < visits; visit++) {
      const startedAt = new Date(Date.now() - (visits - visit) * 7 * 86_400_000);
      const generated: Answer[] = [];

      for (const question of survey.questions) {
        if (question.type === "info") continue;
        const answer: Answer = {
          questionId: question.id,
          durationMs: Math.round(3000 + random() * 9000),
          changeCount: random() < 0.2 ? 1 : 0,
          visitCount: 1,
        };
        if (question.type === "scale") {
          // самочувствие растёт от визита к визиту с небольшим разбросом
          const base = 3 + (visit / Math.max(1, visits - 1)) * 5;
          const min = question.minValue ?? 0;
          const max = question.maxValue ?? 10;
          answer.number = Math.max(min, Math.min(max, Math.round(base + (random() - 0.5) * 2)));
        } else if (question.type === "text") {
          answer.text = pick(["Стало легче", "Сон выровнялся", "Без изменений", "Тревоги меньше"]);
        } else {
          answer.skipped = true;
        }
        generated.push(answer);
      }

      const scores = computeScores(survey, generated);
      const responseId = crypto.randomUUID();
      const durationMs = generated.reduce((sum, a) => sum + (a.durationMs ?? 0), 0);

      await db.transaction(async (tx) => {
        await tx.insert(responses)
          .values({
            id: responseId,
            surveyId,
            userId,
            versionId: survey.versionId,
            status: "completed",
            startedAt: startedAt.toISOString(),
            submittedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
            durationMs,
          });

        for (const answer of generated) {
          const question = survey.questions.find((q) => q.id === answer.questionId)!;
          await tx.insert(answers)
            .values({
              id: crypto.randomUUID(),
              responseId,
              questionId: answer.questionId,
              number: answer.number ?? null,
              text: answer.text ?? null,
              skipped: answer.skipped ?? false,
              score: answerScore(question, answer),
              durationMs: answer.durationMs ?? 0,
              changeCount: answer.changeCount ?? 0,
              visitCount: 1,
            });
        }

        for (const score of scores) {
          await tx.insert(responseScores)
            .values({
              id: crypto.randomUUID(),
              responseId,
              scaleId: score.scaleId,
              rawScore: score.rawScore,
              maxScore: score.maxScore,
              percent: score.percent,
              bandLabel: score.band?.label ?? null,
              severity: score.band?.severity ?? null,
            });
        }
      });
    }
  }
  console.log(`  серия повторных замеров: ${patients.length} пациентов × ${visits} визитов`);
}


/* ─────────────── Батарея методик ─────────────── */

/**
 * Демонстрационная батарея: скрининг руками клинициста, затем два опросника,
 * которые обследуемый заполняет сам. Смешанный режим здесь намеренный — это
 * тот случай, ради которого режим проведения доезжает до карточки на экране.
 */
async function seedBattery() {
  const title = "Входное обследование";
  const existing = await db.query.batteries.findFirst({ where: eq(batteries.title, title) });
  if (existing) return existing;

  const id = crypto.randomUUID();
  await db.insert(batteries).values({
    id,
    title,
    description: "Скрининг риска, затем основные опросники",
    groupId: intake.id,
    strictOrder: true,
    createdBy: psy!.id,
  });
  await db.insert(batteryItems).values([
    { batteryId: id, surveyId: sadPersonsRow.id, position: 0, required: true },
    { batteryId: id, surveyId: sr45Row.id, position: 1, required: true },
    { batteryId: id, surveyId: minimultRow.id, position: 2, required: false },
  ]);

  // назначаем первым трём пациентам пула, одному — с просроченным сроком,
  // чтобы на экране было видно и обычное состояние, и просрочку
  const targets = pool.slice(0, 3);
  const surveyIds = [sadPersonsRow.id, sr45Row.id, minimultRow.id];
  for (const [i, patient] of targets.entries()) {
    const dueAt = new Date(Date.now() + (i === 0 ? -3 : 14) * 86400_000).toISOString();
    await db.insert(batteryAssignments).values({
      id: crypto.randomUUID(),
      batteryId: id,
      userId: patient.id,
      assignedBy: psy!.id,
      dueAt,
      note: i === 0 ? "плановое, срок прошёл" : "плановое",
    });
    await db
      .insert(surveyAccess)
      .values(
        surveyIds.map((surveyId) => ({
          surveyId,
          userId: patient.id,
          grantedBy: psy!.id,
          expiresAt: dueAt,
          note: `Батарея «${title}»`,
        })),
      )
      .onConflictDoNothing();
  }
  console.log(`  батарея: ${title} · назначена ${targets.length} пациентам`);
  return { id };
}

const demoBattery = await seedBattery();

/**
 * Демонстрационное расписание: плановый повтор по подразделению.
 *
 * Заведомо выключено. Включённое расписание при первом же старте сервера
 * выдало бы задания всему батальону, и посев демо-данных превратился бы в
 * рассылку заданий живым людям.
 */
async function seedSchedule() {
  const title = "Плановый замер 1-го батальона";
  const existing = await db.query.schedules.findFirst({ where: eq(schedules.title, title) });
  if (existing) return;

  const startsAt = new Date();
  await db.insert(schedules).values({
    id: crypto.randomUUID(),
    title,
    batteryId: demoBattery.id,
    scope: "unit",
    unit: "1-й батальон",
    intervalDays: 90,
    dueDays: 14,
    startsAt: startsAt.toISOString(),
    nextRunAt: startsAt.toISOString(),
    active: false,
    createdBy: psy!.id,
  });
  console.log(`  расписание: ${title} (выключено)`);
}

await seedSchedule();

console.log("\nГотово. Учётные записи:");
for (const a of ACCOUNTS) console.log(`  ${a.role.padEnd(5)} ${a.email} / ${a.password}`);

// закрываем пул: без этого процесс сида не завершится
await client.end();
