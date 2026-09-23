/**
 * Демонстрационные группы пациентов и правила поддержки решений.
 *
 * Разделы «Групи» и «Аналітика» появились в консоли раньше, чем в посеве:
 * экраны были, а на стенде и в проде открывались пустыми, и посмотреть на
 * них до первой настоящей группы было не на чем — та же история, ради
 * которой посев заводит отделение и приёмы (см. seedClinic в seed.ts).
 *
 * Отдельным модулем, а не куском seed.ts, по двум причинам. Первая —
 * слияние: посев волны пишут несколько пакетов параллельно, и один файл на
 * всех означал бы конфликт в каждом. Вторая важнее: в прод этот посев едет
 * НЕ через seed.ts. Посев прода не пересоздаётся — база живая, — и
 * единственный штатный путь дополнить его данными — действие demo-fill в
 * обслуживании (.github/workflows/maintenance.yml → demoFill.ts). Значит
 * модуль обязан вызываться и оттуда, и из seed.ts, и оба раза давать один
 * результат.
 *
 * ═══ Почему модуль самонастраивающийся ═══
 *
 * Первая редакция была привязана к посевным сущностям поимённо: почта
 * владельца psy@quizzy.dev, пул patientN@quizzy.dev, демо-методики по
 * украинским названиям, подразделения «1-й батальон» и коды шкал
 * sleep/anxiety/mood с порогами 8/15/10. На стенде, где посев их и заводит,
 * это работало; в проде — нет. Прод посевом не наполняется, и demo-fill там
 * молча печатал «пропущено — нет учётной записи psy@quizzy.dev»: два раздела
 * консоли оставались пустыми на живом экземпляре, то есть ровно там, где их
 * показывают.
 *
 * Поэтому у каждой опоры теперь два пути: посевной, если посевные сущности
 * на месте, и подобранный по живой картотеке, если их нет. Посевной путь
 * оставлен БУКВА В БУКВУ — те же id, названия, состав и пороги: стенд и
 * снимки экрана для обучения не должны меняться от того, что модуль научился
 * работать без него. Отвергнутая альтернатива — заводить в проде недостающие
 * посевные учётки (psy@quizzy.dev и patientN@quizzy.dev): это значит
 * дописать в живую картотеку вымышленных людей БЕЗ пометки, по которой
 * demo-purge их потом уберёт, — то есть навсегда.
 *
 * ═══ Кто владелец ═══
 *
 * patient_groups.owner_id и decision_rules.created_by объявлены ON DELETE
 * RESTRICT (см. 0078_patient_groups.sql и 0042_decision_support.sql): пока
 * группа или правило существуют, их владельца удалить нельзя. Отсюда запрет,
 * который стоит проверять при каждой правке: владельцем НЕЛЬЗЯ ставить
 * вымышленного demo-specialist@demo.local (или любого другого жителя
 * DEMO_DOMAIN). Он выглядит удобным — свой, заводится сам, никого не
 * трогает, — но demo-purge убирает вымышленных одним условием по домену
 * почты, и первая же группа на его имени превратила бы «убрать всех
 * вымышленных» в отказ внешнего ключа. Поэтому в запасном выборе жители
 * DEMO_DOMAIN отсеяны явно.
 *
 * ═══ Идемпотентность ═══
 *
 * Ключи устойчивые, а не случайные: у групп и правил постоянные id (как
 * «dept-psy» у отделения), у состава и назначений — составные первичные
 * ключи. Вставка везде с onConflictDoNothing: повторный прогон seed.ts на
 * заполненной базе и повторный demo-fill на проде не дублируют строк и не
 * падают. Проверка «есть — выходим», как у остальных блоков seed.ts, здесь
 * отвергнута: она защищает только от повтора целиком. Прогон, прерванный
 * между группой и её составом, при следующем запуске не дописал бы ничего,
 * а вставка по ключам дописывает недостающее и не трогает существующее.
 *
 * Назначения — тем же путём, что кнопка «Призначити Групі» (POST
 * /api/patient-groups/:id/surveys): строка в patient_group_surveys плюс
 * поимённые выдачи через lib/grantAccess с пометкой via_patient_group_id.
 * Внутри одного прогона это буквально нажатия кнопки по очереди: человек,
 * стоящий в двух группах с одной методикой, получает её дважды, и пометка
 * «через какую группу» отвечает последним решением — как и у кнопки.
 * Между прогонами перевыдачи нет: выданное ТИМ посевом (пометка одной из
 * его групп) снимается снимком до начала и не трогается. grantAccess при
 * совпадении переписывает срок и сбрасывает счётчик попыток — для кнопки
 * это верно (повторное назначение — новое решение), для повторного
 * demo-fill нет: он сбрасывал бы попытки живым назначениям.
 *
 * ═══ Уборка ═══
 *
 * purgeDemoGroupsRules убирает посеянное по тем же постоянным id. Вызывается
 * из ветки purge demoFill.ts следом за purgeDemoData: группы, собранные из
 * вымышленных людей, после их удаления остались бы строками с пустым
 * составом — демонстрационные данные, которые «убрать всех вымышленных» не
 * убрало. Выданные через группу доступы уходят раньше и сами: survey_access
 * ссылается на человека каскадом.
 *
 * ═══ Язык ═══
 *
 * Название, описание группы, название и заметка правила — простой текст, а
 * не локализованное поле: так они заведены в схеме, потому что их пишет
 * специалист руками на своём языке. Сторож двуязычности (content.test.ts)
 * простой текст не проверяет, и одноязычный посев прошёл бы молча — а
 * описание группы читают чаще всего на карточке. Поэтому описания и заметки
 * несут оба языка подряд: украинский абзац, затем русский. Названия —
 * по-украински, как в макете («Група ризику», «Вечірня група»): вкладка
 * обязана быть короткой, и два языка в ней не помещаются.
 */
import { and, eq, inArray, isNotNull, like, not, or } from "drizzle-orm";
import { t, type LocalizedText, type RuleAction, type RuleCondition } from "@quizzy/shared";
import { db } from "../db";
import {
  decisionRules,
  patientGroupMembers,
  patientGroups,
  patientGroupSurveys,
  questions,
  riskAlerts,
  scaleBands,
  scales,
  surveyAccess,
  surveys,
  users,
} from "../db/schema";
import { DEMO_DOMAIN } from "../lib/demoFill";
import { grantAccess } from "../lib/grantAccess";

/** Владелец групп и автор правил на стенде — психолог приёмного отделения из посева */
const OWNER_EMAIL = "psy@quizzy.dev";

/** Демо-методики ищутся по украинскому названию — так же, как upsertSurvey в seed.ts */
const SURVEY_TITLES = {
  sleep: "Якість сну (демо)",
  emotional: "Скринінг емоційного стану (демо)",
} as const;
type SurveyKey = keyof typeof SURVEY_TITLES;

/**
 * Пул пациентов посева: patientN@quizzy.dev и две учётки для входа.
 *
 * Если он на месте — группы собираются по нему, как и раньше. Если нет (живой
 * экземпляр), в дело идут вымышленные люди demo-fill: см. autoPlan ниже.
 */
const POOL_PATTERN = "patient%@quizzy.dev";
const LOGIN_PATIENTS = ["user@quizzy.dev", "user2@quizzy.dev"];

/**
 * Предел на подобранный состав.
 *
 * demo-fill заводит до 500 человек, и группа из пятисот строк на экране
 * вкладок — не демонстрация, а список, который никто не прокрутит. Тридцать
 * — примерно столько же, сколько даёт пул посева, и ровно столько помещается
 * в разговор «вот группа, вот её тесты».
 */
const AUTO_LIMIT = 30;

/* ═════════════ посевной путь: те же группы и правила, что и были ═════════════ */

interface SeededGroup {
  id: string;
  title: string;
  description: string;
  color: string;
  position: number;
  /** Подразделения посева, чьи пациенты входят целиком */
  units: string[];
  /** Поимённые добавления — ради пересечений между группами */
  extra: string[];
  /** Методики группы: срок в днях и число попыток — как в форме назначения */
  surveys: { key: SurveyKey; dueDays: number; attemptsAllowed: number }[];
}

/*
 * Подразделения — из PATIENT_POOL в seed.ts. Пересечения заданы поимённо:
 * человек из 1-го батальона стоит и в плановом скрининге, и в группе риска,
 * а фельдшер медроты — и в риске, и в вечерней группе. Без пересечений
 * вкладки на экране пациентов ничем не отличались бы от фильтра по
 * подразделению.
 */
const SEEDED_GROUPS: SeededGroup[] = [
  {
    id: "demo-pg-1bn",
    title: "1-й батальйон",
    description:
      "Плановий скринінг емоційного стану особового складу 1-го батальйону та роти забезпечення після ротації. Питання до групи: як змінилися сон і тривога за два тижні після повернення.\n" +
      "Плановый скрининг эмоционального состояния личного состава 1-го батальона и роты обеспечения после ротации. Вопрос к группе: как изменились сон и тревога за две недели после возвращения.",
    color: "#3b5bfd",
    position: 0,
    units: ["1-й батальон", "Рота обеспечения"],
    extra: [],
    surveys: [{ key: "emotional", dueDays: 14, attemptsAllowed: 1 }],
  },
  {
    id: "demo-pg-risk",
    title: "Група ризику",
    description:
      "Ті, у кого за скринінгом виражена тривога або критичний пункт. Питання до групи: чи є динаміка після консультації, чи потрібне направлення до психіатра.\n" +
      "Те, у кого по скринингу выраженная тревога или критический пункт. Вопрос к группе: есть ли динамика после консультации, нужно ли направление к психиатру.",
    color: "#dc2626",
    position: 1,
    units: ["2-й батальон"],
    extra: ["patient1@quizzy.dev", "patient9@quizzy.dev", "patient7@quizzy.dev", "user2@quizzy.dev"],
    surveys: [
      { key: "emotional", dueDays: 7, attemptsAllowed: 2 },
      { key: "sleep", dueDays: 7, attemptsAllowed: 2 },
    ],
  },
  {
    id: "demo-pg-evening",
    title: "Вечірня група",
    description:
      "Вечірні заняття з гігієни сну для медичної роти, вузла зв'язку та штабу. Питання до групи: скільки годин сну і що заважає засинати.\n" +
      "Вечерние занятия по гигиене сна для медицинской роты, узла связи и штаба. Вопрос к группе: сколько часов сна и что мешает засыпать.",
    color: "#16a34a",
    position: 2,
    units: ["Медицинская рота", "Узел связи", "Штаб"],
    extra: ["patient3@quizzy.dev", "patient8@quizzy.dev"],
    surveys: [{ key: "sleep", dueDays: 30, attemptsAllowed: 3 }],
  },
];

interface SeededRule {
  id: string;
  title: string;
  note: string;
  enabled: boolean;
  survey: SurveyKey;
  /** Одно условие по одной шкале демо-методики: код, метрика, сравнение */
  scaleCode: string;
  value: number;
  actions: (ids: Record<SurveyKey, string>) => RuleAction[];
}

/*
 * Пороги — границы полос из seed.ts: «Умеренные нарушения» сна с 8,
 * «Выраженная тревога» с 15, «Умеренное снижение» настроения с 10. Правило
 * на пороге, которого нет в интерпретации, объясняло бы срабатывание
 * числом, которого специалист нигде больше не увидит.
 */
const SEEDED_RULES: SeededRule[] = [
  {
    id: "demo-rule-sleep",
    title: "Порушення сну → скринінг емоційного стану",
    note:
      "Помірні або виражені порушення сну (шкала «Порушення сну» від 8 балів): запропонувати скринінг емоційного стану — безсоння частіше симптом, ніж діагноз.\n" +
      "Умеренные или выраженные нарушения сна (шкала «Нарушения сна» от 8 баллов): предложить скрининг эмоционального состояния — бессонница чаще симптом, чем диагноз.",
    enabled: true,
    survey: "sleep",
    scaleCode: "sleep",
    value: 8,
    actions: (ids) => [
      { kind: "suggest_survey", surveyId: ids.emotional },
      { kind: "advise", text: "Розпитати про режим дня та засинання; запропонувати скринінг емоційного стану." },
    ],
  },
  {
    id: "demo-rule-anxiety",
    title: "Виражена тривога → повідомити чергового",
    note:
      "Шкала «Тривога» від 15 балів — полоса «Виражена тривога»: повідомити чергового та запланувати консультацію лікаря-психіатра.\n" +
      "Шкала «Тревога» от 15 баллов — полоса «Выраженная тревога»: уведомить дежурного и запланировать консультацию врача-психиатра.",
    enabled: true,
    survey: "emotional",
    scaleCode: "anxiety",
    value: 15,
    actions: () => [
      { kind: "notify_duty" },
      { kind: "advise", text: "Консультація лікаря-психіатра; до консультації — щоденний контакт." },
    ],
  },
  {
    id: "demo-rule-mood",
    title: "Знижений настрій → контрольний замір",
    note:
      "Вимкнена до узгодження порогу з відділенням: 10 балів за шкалою «Знижений настрій» на демо-даних дає спрацьовування майже на кожному проходженні.\n" +
      "Выключена до согласования порога с отделением: 10 баллов по шкале «Сниженное настроение» на демо-данных срабатывает почти на каждом прохождении.",
    enabled: false,
    survey: "emotional",
    scaleCode: "mood",
    value: 10,
    actions: () => [{ kind: "advise", text: "Контрольний замір через два тижні; за відсутності динаміки — консультація." }],
  },
];

/* ═════════════ подобранный путь: id, которые модуль заводит без посева ═════════════ */

/*
 * У подобранных групп и правил СВОИ постоянные id, а не те же, что у
 * посевных. Переиспользовать «demo-pg-risk» было бы короче, но тогда
 * экземпляр, на котором посевные учётки появились позже (перенос стенда,
 * восстановление из выгрузки), получил бы группу с посевным id и подобранным
 * названием — и никакой повторный прогон её уже не выправил бы: вставка идёт
 * с onConflictDoNothing и существующие строки не трогает. Разные id делают
 * два пути независимыми, а purgeDemoGroupsRules убирает оба набора.
 */
const AUTO_GROUP_IDS = {
  unit: "demo-pg-auto-unit",
  risk: "demo-pg-auto-risk",
  rest: "demo-pg-auto-rest",
} as const;
const AUTO_RULE_IDS = ["demo-rule-auto-1", "demo-rule-auto-2", "demo-rule-auto-3"] as const;

/** Всё, что модуль когда-либо заводит: по этим ключам работает уборка */
const ALL_GROUP_IDS = [...SEEDED_GROUPS.map((g) => g.id), ...Object.values(AUTO_GROUP_IDS)];
const ALL_RULE_IDS = [...SEEDED_RULES.map((r) => r.id), ...AUTO_RULE_IDS];

/* ═════════════ разбор картотеки ═════════════ */

interface Patient {
  id: string;
  email: string;
  unit: string | null;
}

interface Owner {
  id: string;
  email: string;
  /** Почему выбран именно он — печатается в журнал обслуживания */
  why: string;
}

/** Полоса шкалы: нужна нижняя граница как порог и название как объяснение */
interface Band {
  minScore: number;
  label: LocalizedText | string;
}

interface BandedScale {
  code: string;
  title: LocalizedText | string;
  /** Полосы по возрастанию нижней границы */
  bands: Band[];
}

interface Method {
  id: string;
  title: LocalizedText | string;
  /** Группа методик: правило заводится в ней же, а не общим */
  groupId: string | null;
  versionId: string;
  /** Шкалы действующей версии по порядку, у каждой — её полосы */
  scales: BandedScale[];
  /** Число вопросов действующей версии — по нему идёт отбор двух методик */
  questionCount: number;
}

interface GroupPlan {
  id: string;
  title: string;
  description: string;
  color: string;
  position: number;
  members: Patient[];
  surveys: { surveyId: string; dueDays: number; attemptsAllowed: number }[];
}

interface RulePlan {
  id: string;
  title: string;
  note: string;
  enabled: boolean;
  surveyId: string;
  groupId: string | null;
  scaleCode: string;
  value: number;
  actions: RuleAction[];
}

interface Plan {
  groups: GroupPlan[];
  rules: RulePlan[];
  /** Названия методик, на которых собран посев — для вывода */
  methods: string[];
  /** Чем собран этот план: посевом или подбором по картотеке */
  source: string;
}

/**
 * Кому принадлежат группы и кто автор правил.
 *
 * Порядок: посевной психолог, если он есть; иначе самый ранний по created_at
 * настоящий администратор картотеки; иначе суперадминистратор. «Самый ранний»
 * вместо «любой» — чтобы повторный прогон и прогон на копии базы выбирали
 * одного и того же человека: случайный (или «первый, кого вернула база»)
 * владелец означал бы, что после восстановления из выгрузки группы принадлежат
 * кому-то другому.
 *
 * Жители DEMO_DOMAIN отсеяны: на них стоит RESTRICT, см. докблок модуля.
 */
async function resolveOwner(): Promise<Owner | null> {
  const seeded = await db.query.users.findFirst({ where: eq(users.email, OWNER_EMAIL) });
  if (seeded) return { id: seeded.id, email: seeded.email, why: "учётная запись посева" };

  for (const role of ["admin", "superadmin"] as const) {
    const [row] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.role, role), not(like(users.email, `%@${DEMO_DOMAIN}`))))
      .orderBy(users.createdAt, users.id)
      .limit(1);
    if (row) {
      return { id: row.id, email: row.email, why: `${OWNER_EMAIL} нет; самый ранний ${role} картотеки` };
    }
  }
  return null;
}

/** Пул посева: patientN@quizzy.dev и учётки входа */
async function seededPool(): Promise<Patient[]> {
  return await db
    .select({ id: users.id, email: users.email, unit: users.unit })
    .from(users)
    .where(and(eq(users.role, "user"), or(like(users.email, POOL_PATTERN), inArray(users.email, LOGIN_PATIENTS))));
}

/**
 * Вымышленные люди demo-fill — запасной состав групп.
 *
 * Порядок по почте, а не по created_at: коды у них вида demo-001…demo-120 с
 * ведущими нулями, и почта сортируется ровно в том же порядке, в каком их
 * заводят. Время создания у пачки, заведённой одним прогоном, различается
 * миллисекундами и при переносе базы не сохраняется вовсе.
 */
async function demoPool(): Promise<Patient[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, unit: users.unit })
    .from(users)
    .where(and(eq(users.role, "user"), like(users.email, `%@${DEMO_DOMAIN}`)));
  return rows.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)).slice(0, AUTO_LIMIT);
}

/** Шкалы и полосы действующей версии методики плюс число её вопросов */
async function loadMethod(row: {
  id: string;
  title: LocalizedText | string;
  groupId: string | null;
  versionId: string;
}): Promise<Method> {
  const scaleRows = await db
    .select({ id: scales.id, code: scales.code, title: scales.title, position: scales.position })
    .from(scales)
    .where(eq(scales.versionId, row.versionId));
  const bandRows = scaleRows.length
    ? await db
        .select({ scaleId: scaleBands.scaleId, minScore: scaleBands.minScore, label: scaleBands.label })
        .from(scaleBands)
        .where(inArray(scaleBands.scaleId, scaleRows.map((s) => s.id)))
    : [];
  const questionRows = await db
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.versionId, row.versionId));

  /* Сортировка в TS, а не в SQL: порядок ORDER BY зависит от collation базы,
     а выбор методик и порогов обязан совпадать на стенде и в проде. */
  const byPosition = [...scaleRows].sort((a, b) => a.position - b.position || (a.code < b.code ? -1 : 1));
  return {
    id: row.id,
    title: row.title,
    groupId: row.groupId,
    versionId: row.versionId,
    questionCount: questionRows.length,
    scales: byPosition.map((s) => ({
      code: s.code,
      title: s.title,
      bands: bandRows
        .filter((b) => b.scaleId === s.id)
        .sort((a, b) => a.minScore - b.minScore)
        .map((b) => ({ minScore: b.minScore, label: b.label })),
    })),
  };
}

/** Опубликованные методики с действующей версией — сырьё подобранного пути */
async function publishedMethods(): Promise<Method[]> {
  const rows = await db
    .select({ id: surveys.id, title: surveys.title, groupId: surveys.groupId, versionId: surveys.currentVersionId })
    .from(surveys)
    .where(and(eq(surveys.status, "published"), isNotNull(surveys.currentVersionId)));
  const out: Method[] = [];
  for (const r of rows) {
    out.push(await loadMethod({ id: r.id, title: r.title, groupId: r.groupId, versionId: r.versionId! }));
  }
  return out;
}

/**
 * Демо-методика по названию — так же, как её заводит upsertSurvey в seed.ts.
 *
 * Отсутствие действующей версии здесь ошибка, а не пропуск: методика с таким
 * названием в базе есть, значит посев по ней уже проходил, и молчаливый
 * пропуск скрыл бы наполовину выполненный посев.
 */
async function findByTitle(key: SurveyKey): Promise<Method | null> {
  const wanted = SURVEY_TITLES[key];
  const rows = await db
    .select({ id: surveys.id, title: surveys.title, groupId: surveys.groupId, versionId: surveys.currentVersionId })
    .from(surveys);
  const row = rows.find((s) => t(s.title as never) === wanted);
  if (!row) return null;
  if (!row.versionId) throw new Error(`демо-методика «${wanted}» без текущей версии — правила посеять не на что`);
  return await loadMethod({ id: row.id, title: row.title, groupId: row.groupId, versionId: row.versionId });
}

/* ═════════════ планы ═════════════ */

/** Посевной план — буква в букву тот, что был до самонастройки */
function seededPlan(pool: Patient[], method: Record<SurveyKey, Method>): Plan {
  const ids: Record<SurveyKey, string> = { sleep: method.sleep.id, emotional: method.emotional.id };
  const groups = SEEDED_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    color: g.color,
    position: g.position,
    members: pool.filter((p) => (p.unit !== null && g.units.includes(p.unit)) || g.extra.includes(p.email)),
    surveys: g.surveys.map((s) => ({ surveyId: ids[s.key], dueDays: s.dueDays, attemptsAllowed: s.attemptsAllowed })),
  }));
  const rules = SEEDED_RULES.map((r) => {
    const target = method[r.survey];
    if (!target.scales.some((s) => s.code === r.scaleCode)) {
      /*
       * Коды сверяются, а не берутся на веру: правило на шкалу, которой в
       * методике нет, никогда не сработает, и никто этого не заметит —
       * движок честно напишет «шкалы в этом прохождении нет» в объяснение,
       * которого никто не откроет. Посев обязан упасть здесь, а не молчать.
       */
      throw new Error(
        `в методике «${SURVEY_TITLES[r.survey]}» нет шкалы ${r.scaleCode} — правило «${r.title}» не сработало бы никогда`,
      );
    }
    return {
      id: r.id,
      title: r.title,
      note: r.note,
      enabled: r.enabled,
      surveyId: target.id,
      groupId: target.groupId,
      scaleCode: r.scaleCode,
      value: r.value,
      actions: r.actions(ids),
    };
  });
  return { groups, rules, methods: Object.values(SURVEY_TITLES), source: "пул посева" };
}

/**
 * Полоса, с которой начинается значимый результат.
 *
 * Берётся примерно из середины лестницы и мимо нуля. Середина — потому что
 * первая полоса почти всегда «Норма», а последняя — редкий край: правило на
 * норме срабатывало бы на каждом прохождении, правило на краю — никогда, и
 * оба одинаково бесполезны для показа. Мимо нуля — потому что нижняя граница
 * нормы и есть ноль, а порог «от 0 балів» это не порог.
 *
 * Порог берётся именно с ГРАНИЦЫ ПОЛОСЫ, а не подбирается числом: правило на
 * пороге, которого нет в интерпретации, объясняло бы срабатывание числом,
 * которого специалист нигде больше не увидит.
 */
function significantBand(bands: Band[]): Band | null {
  if (!bands.length) return null;
  const from = Math.min(Math.floor(bands.length / 2), bands.length - 1);
  return bands.slice(from).find((b) => b.minScore > 0) ?? bands.findLast((b) => b.minScore > 0) ?? null;
}

/** Шкалы с полосами, годные под правило, в порядке методик и позиций */
function ruleScales(methods: Method[]): { method: Method; scale: BandedScale; band: Band }[] {
  const out: { method: Method; scale: BandedScale; band: Band }[] = [];
  for (const m of methods) {
    for (const s of m.scales) {
      const band = significantBand(s.bands);
      if (band) out.push({ method: m, scale: s, band });
    }
  }
  return out;
}

/** Как называется подразделение у тех, у кого его не записали */
const NO_UNIT = "Без підрозділу";

/** Кто из подобранного состава уже засветился тревогой — из них и собрана группа риска */
async function alertedAmong(pool: Patient[]): Promise<Set<string>> {
  if (!pool.length) return new Set();
  const rows = await db
    .select({ userId: riskAlerts.userId })
    .from(riskAlerts)
    .where(inArray(riskAlerts.userId, pool.map((p) => p.id)));
  return new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null));
}

/**
 * План по живой картотеке: три группы и три правила без посевных сущностей.
 *
 * Группы — самое населённое подразделение, группа риска и остаток. Пересечения
 * между ними не украшение, а смысл вкладок: без них вкладка ничем не
 * отличалась бы от фильтра по подразделению, и показывать было бы нечего.
 * Риск пересекается и с подразделением, и с остатком, потому что тревоги
 * случаются в любом из них.
 *
 * Если тревог в картотеке ещё нет (наполнение без прохождений), группа риска
 * набирается вторым по численности подразделением. Отвергнутая альтернатива —
 * оставить её пустой: пустая вкладка выглядит поломкой, а не «пока никого».
 */
async function autoPlan(pool: Patient[], methods: Method[]): Promise<Plan> {
  /* методики уже отобраны парой (см. buildPlan): лёгкая — скрининг, тяжёлая
     — та, на которую он направляет */
  const light = methods[0]!;
  const heavy = methods[1]!;
  const unitOf = (p: Patient) => p.unit ?? NO_UNIT;

  const tally = new Map<string, number>();
  for (const p of pool) tally.set(unitOf(p), (tally.get(unitOf(p)) ?? 0) + 1);
  /* при равной численности — по названию: иначе состав групп менялся бы от
     порядка строк, который база не обещает */
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([u]) => u);
  const topUnit = ranked[0] ?? NO_UNIT;
  const secondUnit = ranked[1] ?? topUnit;

  const alerted = await alertedAmong(pool);
  const inTop = pool.filter((p) => unitOf(p) === topUnit);
  const rest = pool.filter((p) => unitOf(p) !== topUnit);
  const byAlert = pool.filter((p) => alerted.has(p.id));
  const risk = byAlert.length ? byAlert : pool.filter((p) => unitOf(p) === secondUnit);
  const riskByAlert = byAlert.length > 0;

  const groups: GroupPlan[] = [
    {
      id: AUTO_GROUP_IDS.unit,
      title: topUnit,
      description:
        `Плановий скринінг підрозділу «${topUnit}»: ${inTop.length} осіб. Питання до групи: як змінилися сон і тривога за останні два тижні.\n` +
        `Плановый скрининг подразделения «${topUnit}»: ${inTop.length} человек. Вопросы к группе: как изменились сон и тревога за последние две недели.`,
      color: "#3b5bfd",
      position: 0,
      members: inTop,
      surveys: [{ surveyId: heavy.id, dueDays: 14, attemptsAllowed: 1 }],
    },
    {
      id: AUTO_GROUP_IDS.risk,
      title: "Група ризику",
      description: riskByAlert
        ? "Ті, у кого за скринінгом спрацювала тривога або критичний пункт. Питання до групи: чи є динаміка після консультації, чи потрібне направлення до психіатра.\n" +
          "Те, у кого по скринингу сработала тревога или критический пункт. Вопросы к группе: есть ли динамика после консультации, нужно ли направление к психиатру."
        : `Тривог у картотеці ще немає, тому група набрана за чисельністю: підрозділ «${secondUnit}». Питання до групи: чи є скарги на сон і тривогу.\n` +
          `Тревог в картотеке пока нет, поэтому группа набрана по численности: подразделение «${secondUnit}». Вопросы к группе: есть ли жалобы на сон и тревогу.`,
      color: "#dc2626",
      position: 1,
      members: risk,
      surveys: [
        { surveyId: heavy.id, dueDays: 7, attemptsAllowed: 2 },
        { surveyId: light.id, dueDays: 7, attemptsAllowed: 2 },
      ],
    },
    {
      id: AUTO_GROUP_IDS.rest,
      title: "Інші підрозділи",
      description:
        `Решта картотеки поза «${topUnit}»: ${rest.length} осіб. Питання до групи: скільки годин сну і що заважає засинати.\n` +
        `Остальные подразделения вне «${topUnit}»: ${rest.length} человек. Вопросы к группе: сколько часов сна и что мешает засыпать.`,
      color: "#16a34a",
      position: 2,
      members: rest,
      surveys: [{ surveyId: light.id, dueDays: 30, attemptsAllowed: 3 }],
    },
  ];

  return {
    groups,
    rules: autoRules([light, heavy]),
    methods: methods.map((m) => t(m.title as never)),
    source: "подбор по картотеке",
  };
}

/**
 * Три правила на реальных шкалах подобранных методик.
 *
 * Роль у каждого своя и задана порядком, а не кодом шкалы: первое предлагает
 * вторую методику, второе поднимает дежурного, третье выключено. Выключенное
 * правило в посеве не забывчивость: экран правил обязан показать, что
 * правило можно держать написанным и не включённым, — иначе нечем объяснить
 * колонку «увімкнено».
 *
 * Пороги — нижние границы значимых полос (см. significantBand), названия и
 * пояснения собраны из названий шкал и полос: специалист, открывший правило,
 * читает те же слова, что стоят в интерпретации его методики.
 */
function autoRules(methods: Method[]): RulePlan[] {
  const picked = ruleScales(methods).slice(0, AUTO_RULE_IDS.length);
  return picked.map((p, i) => {
    const other = methods.find((m) => m.id !== p.method.id) ?? p.method;
    const scaleUk = t(p.scale.title as never, "uk");
    const scaleRu = t(p.scale.title as never, "ru");
    const bandUk = t(p.band.label as never, "uk");
    const bandRu = t(p.band.label as never, "ru");
    const value = p.band.minScore;

    const actions: RuleAction[] =
      i === 0
        ? [
            { kind: "suggest_survey", surveyId: other.id },
            { kind: "advise", text: `Розпитати про скарги за шкалою «${scaleUk}»; запропонувати другу методику.` },
          ]
        : i === 1
          ? [
              { kind: "notify_duty" },
              { kind: "advise", text: "Консультація лікаря-психіатра; до консультації — щоденний контакт." },
            ]
          : [{ kind: "advise", text: "Контрольний замір через два тижні; за відсутності динаміки — консультація." }];

    const doneUk =
      i === 0
        ? `запропонувати методику «${t(other.title as never, "uk")}»`
        : i === 1
          ? "повідомити чергового"
          : "контрольний замір через два тижні";
    const doneRu =
      i === 0
        ? `предложить методику «${t(other.title as never, "ru")}»`
        : i === 1
          ? "уведомить дежурного"
          : "контрольный замер через две недели";

    const off = i === 2;
    return {
      id: AUTO_RULE_IDS[i]!,
      title: `${scaleUk}: ${bandUk} → ${doneUk}`,
      note:
        (off ? "Вимкнене до узгодження порогу з відділенням. " : "") +
        `Шкала «${scaleUk}» від ${value} балів і вище — полоса «${bandUk}»: ${doneUk}. ` +
        "Поріг узятий з межі полоси: правило на порозі, якого немає в інтерпретації, пояснювало б спрацювання числом, якого фахівець більше ніде не побачить.\n" +
        (off ? "Выключено до согласования порога с отделением. " : "") +
        `Шкала «${scaleRu}» от ${value} баллов и выше — полоса «${bandRu}»: ${doneRu}. ` +
        "Порог взят с границы полосы: правило на пороге, которого нет в интерпретации, объясняло бы срабатывание числом, которого специалист больше нигде не увидит.",
      enabled: !off,
      surveyId: p.method.id,
      groupId: p.method.groupId,
      scaleCode: p.scale.code,
      value,
      actions,
    };
  });
}

/* ═════════════ посев ═════════════ */

export interface DemoGroupsRulesReport {
  /** Сколько строк ВСТАВЛЕНО за этот прогон; повторный прогон даёт нули */
  groups: number;
  members: number;
  assignments: number;
  grants: number;
  rules: number;
  /** Почему ничего не посеяно: нет владельца, состава или методик */
  skipped: string | null;
}

/**
 * Что сеять: посевной план, если посевные сущности на месте, иначе подобранный.
 *
 * Возвращает либо план, либо причину пропуска — строкой для журнала
 * обслуживания. Пропуск здесь не ошибка: demo-fill на экземпляре, где нет ни
 * пула, ни вымышленных людей, должен наполнить картотеку, а не упасть на
 * необязательной части.
 */
async function buildPlan(): Promise<Plan | string> {
  const pool = await seededPool();
  if (pool.length) {
    const found = { sleep: await findByTitle("sleep"), emotional: await findByTitle("emotional") };
    const missing = (Object.keys(found) as SurveyKey[]).filter((k) => !found[k]);
    if (!missing.length) return seededPlan(pool, found as Record<SurveyKey, Method>);
  }

  const auto = await demoPool();
  if (!auto.length) return `нет состава: ни пула ${POOL_PATTERN} с демо-методиками, ни вымышленных @${DEMO_DOMAIN}`;
  const banded = (await publishedMethods())
    .filter((m) => m.scales.some((s) => s.bands.length))
    .sort((a, b) => a.questionCount - b.questionCount || (a.id < b.id ? -1 : 1))
    .slice(0, 2);
  if (banded.length < 2) return "нет двух опубликованных методик со шкалами и полосами";
  return await autoPlan(auto, banded);
}

export async function seedDemoGroupsRules(): Promise<DemoGroupsRulesReport> {
  const report: DemoGroupsRulesReport = { groups: 0, members: 0, assignments: 0, grants: 0, rules: 0, skipped: null };

  const owner = await resolveOwner();
  if (!owner) {
    report.skipped = `в картотеке нет ни ${OWNER_EMAIL}, ни настоящего администратора`;
    console.log(`  группы и правила: пропущено — ${report.skipped}`);
    return report;
  }

  const built = await buildPlan();
  if (typeof built === "string") {
    report.skipped = built;
    console.log(`  группы и правила: пропущено — ${report.skipped}`);
    return report;
  }
  const plan = built;
  console.log(
    `  группы и правила: владелец ${owner.email} (${owner.why}); состав — ${plan.source}; ` +
      `методики — ${plan.methods.join(", ")}`,
  );

  /*
   * Что уже выдано ЭТИМ посевом — по пометке via_patient_group_id одной из
   * его групп. Снимок до прогона, а не проверка перед каждой выдачей: см.
   * докблок модуля — внутри прогона вторая группа перевыдаёт методику
   * общему участнику, как вторая кнопка, а между прогонами не трогает.
   */
  const already = new Set(
    (
      await db
        .select({ surveyId: surveyAccess.surveyId, userId: surveyAccess.userId })
        .from(surveyAccess)
        .where(inArray(surveyAccess.viaPatientGroupId, plan.groups.map((g) => g.id)))
    ).map((r) => `${r.surveyId}:${r.userId}`),
  );

  /* ─────────── группы ─────────── */

  for (const g of plan.groups) {
    const inserted = await db
      .insert(patientGroups)
      .values({
        id: g.id,
        title: g.title,
        description: g.description,
        color: g.color,
        position: g.position,
        ownerId: owner.id,
      })
      .onConflictDoNothing()
      .returning({ id: patientGroups.id });
    report.groups += inserted.length;

    if (g.members.length) {
      const added = await db
        .insert(patientGroupMembers)
        .values(g.members.map((m) => ({ groupId: g.id, patientId: m.id, addedBy: owner.id })))
        .onConflictDoNothing()
        .returning({ patientId: patientGroupMembers.patientId });
      report.members += added.length;
    }

    for (const s of g.surveys) {
      const expiresAt = new Date(Date.now() + s.dueDays * 86_400_000).toISOString();
      /*
       * Решение и его последствия — одной транзакцией, как в маршруте:
       * методика в «Тести Групи» без назначений (или наоборот) выглядела бы
       * рабочей с обеих сторон по отдельности.
       */
      await db.transaction(async (tx) => {
        const assigned = await tx
          .insert(patientGroupSurveys)
          .values({
            groupId: g.id,
            surveyId: s.surveyId,
            assignedBy: owner.id,
            expiresAt,
            attemptsAllowed: s.attemptsAllowed,
          })
          .onConflictDoNothing()
          .returning({ surveyId: patientGroupSurveys.surveyId });
        report.assignments += assigned.length;

        const targets = g.members.filter((m) => !already.has(`${s.surveyId}:${m.id}`));
        if (!targets.length) return;
        await grantAccess(
          tx as never,
          targets.map((m) => ({
            surveyId: s.surveyId,
            userId: m.id,
            grantedBy: owner.id,
            expiresAt,
            note: `Група «${g.title}»`,
            attemptsAllowed: s.attemptsAllowed,
            viaPatientGroupId: g.id,
          })),
        );
        report.grants += targets.length;
      });
    }
  }

  /* ─────────── правила ─────────── */

  for (const r of plan.rules) {
    const conditions: RuleCondition[] = [
      /* сравнение всегда «не меньше»: порог — нижняя граница полосы, и
         попадание в полосу это и есть «набрал столько или больше» */
      { kind: "scale", surveyId: r.surveyId, scaleCode: r.scaleCode, metric: "raw", op: ">=", value: r.value },
    ];
    const inserted = await db
      .insert(decisionRules)
      .values({
        id: r.id,
        title: r.title,
        /* правило той же группы методик, что и методика: общее (null)
           срабатывало бы и на методики других отделений */
        groupId: r.groupId,
        enabled: r.enabled,
        conditions,
        actions: r.actions,
        note: r.note,
        createdBy: owner.id,
      })
      .onConflictDoNothing()
      .returning({ id: decisionRules.id });
    report.rules += inserted.length;
  }

  const disabled = plan.rules.filter((r) => !r.enabled).length;
  console.log(
    `  группы пациентов: ${plan.groups.length} (новых ${report.groups}), состав +${report.members}, назначений +${report.assignments}, выдач +${report.grants}; ` +
      `правил: ${plan.rules.length} (новых ${report.rules}, выключено ${disabled})`,
  );
  return report;
}

/**
 * Убрать демонстрационные группы и правила.
 *
 * Зовётся из ветки purge demoFill.ts следом за purgeDemoData. Демонстрационные
 * группы — такие же вымышленные данные, как люди: собранные из вымышленных,
 * после их удаления они остались бы строками с пустым составом, и «убрать всех
 * вымышленных» убрало бы не всех. demo-fill заводит их заново.
 *
 * Удаляются только по постоянным id модуля: группа, которую специалист завёл
 * руками, названием от посевной не отличается, а идентификатором отличается
 * всегда.
 *
 * Состав и назначения группы не перечислены здесь намеренно: у обеих таблиц
 * внешний ключ на patient_groups объявлен ON DELETE CASCADE (миграция 0078), и
 * повторять его в коде значило бы завести второе описание того же правила —
 * которое однажды разойдётся с первым. Выданные через группу доступы
 * удаления группы не переживают только вместе с людьми: survey_access
 * ссылается на человека каскадом, а на группу — ON DELETE SET NULL, и
 * назначение, которое человек уже начал проходить, остаётся у него.
 */
export async function purgeDemoGroupsRules(): Promise<{ groups: number; rules: number }> {
  const rules = await db
    .delete(decisionRules)
    .where(inArray(decisionRules.id, ALL_RULE_IDS))
    .returning({ id: decisionRules.id });
  const groups = await db
    .delete(patientGroups)
    .where(inArray(patientGroups.id, ALL_GROUP_IDS))
    .returning({ id: patientGroups.id });
  return { groups: groups.length, rules: rules.length };
}
