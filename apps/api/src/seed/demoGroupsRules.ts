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
 * Между прогонами перевыдачи нет: выданное ЭТИМ посевом (пометка одной из
 * его групп) снимается снимком до начала и не трогается. grantAccess при
 * совпадении переписывает срок и сбрасывает счётчик попыток — для кнопки
 * это верно (повторное назначение — новое решение), для повторного
 * demo-fill нет: он сбрасывал бы попытки живым назначениям.
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
import { and, eq, inArray, like, or } from "drizzle-orm";
import { t, type RuleAction, type RuleCondition } from "@quizzy/shared";
import { db } from "../db";
import {
  decisionRules,
  patientGroupMembers,
  patientGroups,
  patientGroupSurveys,
  scales,
  surveyAccess,
  surveys,
  users,
} from "../db/schema";
import { grantAccess } from "../lib/grantAccess";

/** Владелец групп и автор правил — психолог приёмного отделения из посева */
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
 * Только они — вымышленные люди demo.local сюда не попадают намеренно. Их
 * заводит и убирает demo-fill/demo-purge, а членство каскадом уходит вместе
 * с человеком: группа, собранная из них, после demo-purge оказалась бы
 * пустой, а строка о ней — осталась.
 */
const POOL_PATTERN = "patient%@quizzy.dev";
const LOGIN_PATIENTS = ["user@quizzy.dev", "user2@quizzy.dev"];

interface GroupSeed {
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
const GROUPS: GroupSeed[] = [
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

interface RuleSeed {
  id: string;
  title: string;
  note: string;
  enabled: boolean;
  survey: SurveyKey;
  /** Одно условие по одной шкале демо-методики: код, метрика, сравнение */
  scaleCode: string;
  op: Extract<RuleCondition, { kind: "scale" }>["op"];
  value: number;
  actions: (ids: Record<SurveyKey, string>) => RuleAction[];
}

/*
 * Пороги — границы полос из seed.ts: «Умеренные нарушения» сна с 8,
 * «Выраженная тревога» с 15, «Умеренное снижение» настроения с 10. Правило
 * на пороге, которого нет в интерпретации, объясняло бы срабатывание
 * числом, которого специалист нигде больше не увидит.
 */
const RULES: RuleSeed[] = [
  {
    id: "demo-rule-sleep",
    title: "Порушення сну → скринінг емоційного стану",
    note:
      "Помірні або виражені порушення сну (шкала «Порушення сну» від 8 балів): запропонувати скринінг емоційного стану — безсоння частіше симптом, ніж діагноз.\n" +
      "Умеренные или выраженные нарушения сна (шкала «Нарушения сна» от 8 баллов): предложить скрининг эмоционального состояния — бессонница чаще симптом, чем диагноз.",
    enabled: true,
    survey: "sleep",
    scaleCode: "sleep",
    op: ">=",
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
    op: ">=",
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
    op: ">=",
    value: 10,
    actions: () => [{ kind: "advise", text: "Контрольний замір через два тижні; за відсутності динаміки — консультація." }],
  },
];

export interface DemoGroupsRulesReport {
  /** Сколько строк ВСТАВЛЕНО за этот прогон; повторный прогон даёт нули */
  groups: number;
  members: number;
  assignments: number;
  grants: number;
  rules: number;
  /** Почему ничего не посеяно: нет владельца или демо-методик */
  skipped: string | null;
}

/**
 * Демо-методика по названию вместе с кодами шкал текущей версии.
 *
 * Коды сверяются, а не берутся на веру: правило на шкалу, которой в методике
 * нет, никогда не сработает, и никто этого не заметит — движок честно
 * напишет «шкалы в этом прохождении нет» в объяснение, которого никто не
 * откроет. Посев обязан упасть здесь, а не молчать.
 */
async function findSurvey(key: SurveyKey): Promise<{ id: string; groupId: string | null; codes: Set<string> } | null> {
  const wanted = SURVEY_TITLES[key];
  const all = await db.select({ id: surveys.id, title: surveys.title, groupId: surveys.groupId, versionId: surveys.currentVersionId }).from(surveys);
  const row = all.find((s) => t(s.title as never) === wanted);
  if (!row) return null;
  if (!row.versionId) throw new Error(`демо-методика «${wanted}» без текущей версии — правила посеять не на что`);
  const codeRows = await db
    .select({ code: scales.code })
    .from(scales)
    .where(and(eq(scales.surveyId, row.id), eq(scales.versionId, row.versionId)));
  return { id: row.id, groupId: row.groupId, codes: new Set(codeRows.map((r) => r.code)) };
}

export async function seedDemoGroupsRules(): Promise<DemoGroupsRulesReport> {
  const report: DemoGroupsRulesReport = { groups: 0, members: 0, assignments: 0, grants: 0, rules: 0, skipped: null };

  const owner = await db.query.users.findFirst({ where: eq(users.email, OWNER_EMAIL) });
  if (!owner) {
    /*
     * Не ошибка, а пропуск: demo-fill на экземпляре без посевных учёток
     * должен наполнить картотеку, а не упасть на необязательной части.
     */
    report.skipped = `нет учётной записи ${OWNER_EMAIL}`;
    console.log(`  группы и правила: пропущено — ${report.skipped}`);
    return report;
  }

  const found = { sleep: await findSurvey("sleep"), emotional: await findSurvey("emotional") };
  const missing = (Object.keys(found) as SurveyKey[]).filter((k) => !found[k]);
  if (missing.length) {
    report.skipped = `нет демо-методик: ${missing.map((k) => SURVEY_TITLES[k]).join(", ")}`;
    console.log(`  группы и правила: пропущено — ${report.skipped}`);
    return report;
  }
  const survey = found as Record<SurveyKey, NonNullable<(typeof found)[SurveyKey]>>;
  const surveyIds: Record<SurveyKey, string> = { sleep: survey.sleep.id, emotional: survey.emotional.id };

  const pool = await db
    .select({ id: users.id, email: users.email, unit: users.unit })
    .from(users)
    .where(and(eq(users.role, "user"), or(like(users.email, POOL_PATTERN), inArray(users.email, LOGIN_PATIENTS))));

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
        .where(inArray(surveyAccess.viaPatientGroupId, GROUPS.map((g) => g.id)))
    ).map((r) => `${r.surveyId}:${r.userId}`),
  );

  /* ─────────── группы ─────────── */

  for (const g of GROUPS) {
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

    const members = pool.filter((p) => (p.unit !== null && g.units.includes(p.unit)) || g.extra.includes(p.email));
    if (members.length) {
      const added = await db
        .insert(patientGroupMembers)
        .values(members.map((m) => ({ groupId: g.id, patientId: m.id, addedBy: owner.id })))
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
            surveyId: surveyIds[s.key],
            assignedBy: owner.id,
            expiresAt,
            attemptsAllowed: s.attemptsAllowed,
          })
          .onConflictDoNothing()
          .returning({ surveyId: patientGroupSurveys.surveyId });
        report.assignments += assigned.length;

        const targets = members.filter((m) => !already.has(`${surveyIds[s.key]}:${m.id}`));
        if (!targets.length) return;
        await grantAccess(
          tx as never,
          targets.map((m) => ({
            surveyId: surveyIds[s.key],
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

  for (const r of RULES) {
    const target = survey[r.survey];
    if (!target.codes.has(r.scaleCode)) {
      throw new Error(`в методике «${SURVEY_TITLES[r.survey]}» нет шкалы ${r.scaleCode} — правило «${r.title}» не сработало бы никогда`);
    }
    const conditions: RuleCondition[] = [
      { kind: "scale", surveyId: target.id, scaleCode: r.scaleCode, metric: "raw", op: r.op, value: r.value },
    ];
    const inserted = await db
      .insert(decisionRules)
      .values({
        id: r.id,
        title: r.title,
        /* правило той же группы методик, что и методика: общее (null)
           срабатывало бы и на методики других отделений */
        groupId: target.groupId,
        enabled: r.enabled,
        conditions,
        actions: r.actions(surveyIds),
        note: r.note,
        createdBy: owner.id,
      })
      .onConflictDoNothing()
      .returning({ id: decisionRules.id });
    report.rules += inserted.length;
  }

  const disabled = RULES.filter((r) => !r.enabled).length;
  console.log(
    `  группы пациентов: ${GROUPS.length} (новых ${report.groups}), состав +${report.members}, назначений +${report.assignments}, выдач +${report.grants}; ` +
      `правил: ${RULES.length} (новых ${report.rules}, выключено ${disabled})`,
  );
  return report;
}
