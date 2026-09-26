import { Hono } from "hono";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ageAt, respondentDynamicsQuery, respondentQuery, t } from "@quizzy/shared";
import type { RespondentDynamics, ScaleDynamics, ScaleNormalization, Sex } from "@quizzy/shared";
import { db } from "../db";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { langOf } from "../lib/http";
import { responseScores, responses, scales, surveys, surveyVersions, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { alphasOf, basisOf, changeOverSeries, normativeSamples } from "../lib/changeBasis";
import { decryptField } from "../lib/crypto";
import { notFound, parseQuery } from "../lib/http";
import { percentileOf } from "../lib/norms";
import { birthYearOf } from "../lib/privacy";
import { accessiblePatientIds, surveyScopeFilter, surveyScopeFilterFor } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const dynamicsRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 */
dynamicsRoutes.use("*", requireAuth, requireStaff, requirePermission("patients.read"));

/**
 * Кто проходил методики повторно — в зоне ответственности сотрудника.
 *
 * Свёртка делается в базе, а не в приложении: раньше сюда выбирались все
 * завершённые прохождения со стыковкой к пользователям — на двадцати тысячах
 * замеров это двадцать тысяч строк в память ради подсчёта, который база
 * делает одной группировкой.
 *
 * Расшифровываются только те, кто попал на страницу: ФИО зашифровано, и
 * расшифровка всей выборки ради сортировки была бы самой дорогой частью
 * запроса.
 */

dynamicsRoutes.get("/respondents", async (c) => {
  const scope = await surveyScopeFilter(c.get("user"));
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return c.json({ items: [], nextCursor: null, total: 0 });

  // ?limit=abc давал NaN, который уезжал в .limit() и ронял запрос пятисоткой
  const { limit, cursor: rawCursor, search } = parseQuery(c, respondentQuery);
  const cursor = decodeCursor(rawCursor);

  const base = and(
    inArray(responses.surveyId, surveyIds),
    eq(responses.status, "completed"),
    isNotNull(responses.userId),
  );

  /*
   * При поиске выбираем шире и фильтруем после расшифровки: LIKE по
   * шифртексту ничего не найдёт. На реальных объёмах это несколько тысяч
   * расшифровок — дешевле, чем держать открытую копию имени в базе.
   */
  const rows = await db
    .select({
      userId: responses.userId,
      count: sql<number>`count(*)::int`,
      last: sql<string>`max(${responses.submittedAt})`,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
      email: users.email,
      // подразделение и пол — для фасетов списка: фильтровать по ним нужно
      // постоянно, а второй запрос за теми же людьми был бы чистой тратой
      unit: users.unit,
      sex: users.sex,
      /*
       * Год рождения — чтобы различить тёзок.
       *
       * В списке из ста двадцати человек одинаковые ФИО встречаются: имена
       * в стране не бесконечны, и в поликлинике это обычное дело. Различить
       * их было нечем — одинаковые строки, разные люди, и открыть карту не
       * того стоит ровно того, чего такая система обязана не допускать.
       * В регистратуре различают годом рождения; здесь тоже.
       */
      birthDate: users.birthDate,
      /* телефон — в мета-строке списка, как на кадре f05 (решение заказчика 2026-09-25) */
      phoneEnc: users.phoneEnc,
    })
    .from(responses)
    .innerJoin(users, eq(users.id, responses.userId))
    .where(base)
    .groupBy(
      responses.userId,
      users.firstName,
      users.lastName,
      users.middleName,
      users.anonymous,
      users.pseudonym,
      users.email,
      users.unit,
      users.sex,
      users.birthDate,
      users.phoneEnc,
    )
    /*
     * Курсор проверяется на агрегате, а не на строках прохождений.
     *
     * Условие в WHERE отсекало бы отдельные замеры, но у человека есть и
     * более старые — и он выпадал бы на следующей странице снова, уже с
     * меньшим максимумом. Пагинация по группам обязана фильтровать по тому
     * же значению, по которому сортирует.
     *
     * В курсоре ДВА поля: время последнего замера и идентификатор человека.
     * Одного времени мало — оно повторяется. Двое обследованных в одну
     * минуту (обычное дело: приём идёт потоком, замеры сдают подряд)
     * попадали на границу страницы, и условие «строго раньше курсора»
     * выбрасывало обоих: один показывался, второй не попадал НИ НА ОДНУ
     * страницу. Список молча терял людей, и заметить это можно было только
     * по несовпадению с общим числом.
     */
    .having(
      cursor
        ? sql`(max(${responses.submittedAt}), ${responses.userId}) < (${cursor.at}::timestamptz, ${cursor.id})`
        : sql`true`,
    )
    .orderBy(sql`max(${responses.submittedAt}) desc`, sql`${responses.userId} desc`)
    .limit(search ? 2000 : limit + 1);

  const named = rows.map((r) => ({
    userId: r.userId!,
    fullName: fullNameOf(r as never),
    email: r.email,
    count: Number(r.count),
    last: r.last,
    unit: r.unit,
    sex: r.sex as "male" | "female" | null,
    /* только год: полная дата рождения в списке — лишнее раскрытие */
    birthYear: birthYearOf(decryptField(r.birthDate)),
    phone: decryptField(r.phoneEnc),
  }));
  const matched = search
    ? named.filter((r) => `${r.fullName} ${r.email}`.toLowerCase().includes(search))
    : named;

  const items = matched.slice(0, limit);
  const hasMore = matched.length > limit;

  let total: number | undefined;
  if (!cursor && !search) {
    const [row] = await db
      .select({ n: sql<number>`count(distinct ${responses.userId})::int` })
      .from(responses)
      .where(base);
    total = row?.n ?? 0;
  }

  /*
   * С телефонами список стал чтением контактов людей, и журнал обязан это
   * знать: то же имя действия, что у /api/patients, — «кто листал пациентов»
   * отвечается одной выборкой, каким бы маршрутом ни листали.
   */
  await audit(c, {
    action: "access.patient_list",
    details: { returned: items.length, phones: true, via: "respondents" },
  });

  const last = items[items.length - 1];
  return c.json({
    items,
    // курсор — время последнего замера и человек: время повторяется
    nextCursor: hasMore && last ? encodeCursor(last.last, last.userId) : null,
    total,
  });
});

/**
 * Динамика одного пациента: как менялись баллы по субшкалам от замера к замеру.
 *
 * Субшкалы разных версий методики сопоставляются по коду, а не по id —
 * иначе правка методики разрывала бы график пополам.
 */
dynamicsRoutes.get("/respondents/:userId", async (c) => {
  // язык читателя: t() без него отдаёт украинский всегда
  const lang = langOf(c);
  const staff = c.get("user");
  const userId = c.req.param("userId");
  const { survey: onlySurvey } = parseQuery(c, respondentDynamicsQuery);

  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("err.patientNotFound");

  /*
   * Зона ответственности — до всего остального. Раньше маршрут возвращал ФИО
   * и email по любому существующему идентификатору: достаточно было иметь
   * хоть одну свою методику, чтобы получить карточку чужого пациента с
   * пустым списком замеров.
   */
  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("err.patientNotFound");

  /*
   * ?survey=<id> сужает всё, что ниже, до одной методики — и выборку для
   * перцентиля и SD, и подсчёт альфы, самый дорогой шаг маршрута (до трёхсот
   * прохождений с ответами на каждую методику человека). Графики одного
   * прохождения просят ровно одну методику, и считать ради неё остальные
   * девять — чистая трата.
   *
   * Сужение — внутри зоны, а не вместо неё: методика вне зоны сотрудника
   * отвечает тем же пустым списком, что и методика, которой человек не
   * проходил. Отказ «нет доступа» рассказал бы, что такая методика у
   * человека есть.
   */
  const scope = await surveyScopeFilterFor(staff, userId);
  const scoped = await db
    .select()
    .from(surveys)
    .where(onlySurvey ? and(scope, eq(surveys.id, onlySurvey)) : scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) {
    return c.json({
      userId,
      fullName: fullNameOf(patient),
      email: patient.email,
      sex: (patient.sex as Sex | null) ?? null,
      age: ageAt(decryptField(patient.birthDate), new Date().toISOString()),
      surveys: [],
    } satisfies RespondentDynamics);
  }

  const responseRows = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.userId, userId),
        eq(responses.status, "completed"),
        inArray(responses.surveyId, surveyIds),
      ),
    )
    .orderBy(asc(responses.submittedAt));

  if (!responseRows.length) {
    return c.json({
      userId,
      fullName: fullNameOf(patient),
      email: patient.email,
      sex: (patient.sex as Sex | null) ?? null,
      age: ageAt(decryptField(patient.birthDate), new Date().toISOString()),
      surveys: [],
    } satisfies RespondentDynamics);
  }

  const scoreRows = await db
    .select()
    .from(responseScores)
    .where(inArray(responseScores.responseId, responseRows.map((r) => r.id)));

  const scaleRows = await db
    .select()
    .from(scales)
    .where(inArray(scales.id, [...new Set(scoreRows.map((s) => s.scaleId))]));
  const scaleById = new Map(scaleRows.map((s) => [s.id, s]));

  /*
   * Нормативная выборка — баллы той же шкалы той же методики В ТЕХ ЖЕ
   * ЕДИНИЦАХ: той же версии и той же нормировки (lib/changeBasis.ts).
   *
   * Прежде ключом были методика и код шкалы, и выборка смешивала версии.
   * Пока нормировка у версий одна, это неточность; когда её меняют (была
   * доля 0–1, стал T-балл 20–80) — это выборка в двух единицах сразу. SD
   * такой смеси — разброс между единицами, а не между людьми, и RCI по нему
   * объявлял «в пределах погрешности» почти любой сдвиг; перцентиль T-балла
   * среди долей выходил около ста при любом значении. Приводить всю выборку
   * к одной версии ради этого незачем: у точки своя версия, и сравнивать её
   * надо со своими. Из этой же выборки считаются моменты для приведения
   * версий друг к другу.
   */
  const sampleByKey = await normativeSamples(surveyIds);

  const scoresByResponse = new Map<string, typeof scoreRows>();
  for (const s of scoreRows) {
    const list = scoresByResponse.get(s.responseId) ?? [];
    list.push(s);
    scoresByResponse.set(s.responseId, list);
  }

  /*
   * Номера версий методик, которые человек видел. Одним запросом по уже
   * известным идентификаторам: запрашивать версию на каждый замер — это
   * столько же обращений, сколько у человека прохождений.
   */
  const versionIds = [...new Set(responseRows.map((r) => r.versionId).filter(Boolean))] as string[];
  const versionNoById = new Map<string, number>();
  if (versionIds.length) {
    const versions = await db
      .select({ id: surveyVersions.id, version: surveyVersions.version })
      .from(surveyVersions)
      .where(inArray(surveyVersions.id, versionIds));
    for (const v of versions) versionNoById.set(v.id, v.version);
  }

  const bySurvey = new Map<string, typeof responseRows>();
  for (const r of responseRows) {
    const list = bySurvey.get(r.surveyId) ?? [];
    list.push(r);
    bySurvey.set(r.surveyId, list);
  }

  /*
   * Альфа для RCI — по каждой версии, которую человек видел, по её вопросам
   * и по её свежим прохождениям (lib/changeBasis.ts, alphasOf). Прежде
   * бралось триста самых старых прохождений методики и сверялось с вопросами
   * действующей версии: после правки методики старые ответы не находили
   * своих вопросов, и RCI пропадал навсегда.
   */
  const alphas = await alphasOf(
    responseRows
      .filter((r): r is typeof r & { versionId: string } => !!r.versionId)
      .map((r) => ({ surveyId: r.surveyId, versionId: r.versionId })),
  );
  const versionIdOf = new Map(responseRows.map((r) => [r.id, r.versionId ?? null]));
  const reliableOf = new Map(responseRows.map((r) => [r.id, r.reliable]));

  const result: RespondentDynamics = {
    userId,
    fullName: fullNameOf(patient),
    email: patient.email,
    /*
     * Пол и возраст — для подсчёта норм на устройстве в режиме обхода.
     * Возраст числом: для норм достаточно, а дата рождения на планшете,
     * который носят по отделению, — лишние сведения без единого сценария.
     */
    sex: (patient.sex as Sex | null) ?? null,
    age: ageAt(decryptField(patient.birthDate), new Date().toISOString()),
    surveys: [...bySurvey.entries()].map(([surveyId, list]) => {
      const survey = scoped.find((s) => s.id === surveyId)!;

      // группируем по КОДУ шкалы: id меняется от версии к версии
      const byCode = new Map<string, ScaleDynamics>();
      for (const response of list) {
        for (const score of scoresByResponse.get(response.id) ?? []) {
          const scale = scaleById.get(score.scaleId);
          if (!scale) continue;
          const basis = basisOf(response.versionId ?? null, score);
          const entry = byCode.get(scale.code) ?? {
            scaleId: scale.id,
            code: scale.code,
            title: t(scale.title as never, lang),
            points: [],
            delta: null,
            direction: null,
            reliableChange: null,
          };
          entry.points.push({
            responseId: response.id,
            submittedAt: response.submittedAt ?? response.startedAt,
            /*
             * Номер версии методики, которую человек реально видел. Скачок
             * после смены версии — часто артефакт правки ключей, а не
             * изменение состояния; без этой отметки его читают как динамику.
             */
            versionNo: versionNoById.get(response.versionId ?? "") ?? null,
            rawScore: score.value,
            maxScore: score.maxScore,
            percent: score.percent,
            bandLabel: score.bandLabel,
            severity: score.severity,
            /*
             * Сравниваем однородное с однородным.
             *
             * Выборка набрана из `score.value` — нормированных значений
             * (стены, T-баллы, доли), а перцентиль запрашивался для
             * `score.rawScore`. Для МЛО это сырой 0–57 против стенов 1–10:
             * пациент со стеном 1 («крайне низкий уровень», группа риска)
             * имел сырой балл выше любого стена в выборке и получал
             * перцентиль около ста. Худший возможный результат
             * показывался как лучший.
             *
             * И выборка — той же версии и нормировки (см. basisOf); у
             * ненормированного балла её нет, и перцентиля тоже: сырой балл
             * среди T-баллов — то же сравнение в двух единицах.
             */
            percentile: score.normalized
              ? percentileOf(score.value, sampleByKey.get(`${surveyId}:${scale.code}:${basis}`) ?? [])
              : null,
            /*
             * Единицы и достоверность точки — наружу: без них экран не
             * отличит сырой балл от T-балла той же шкалы и вычтет одно из
             * другого (response/model.ts, shiftOf).
             */
            normalized: score.normalized,
            normalization: score.normalization as ScaleNormalization,
            reliable: response.reliable,
          });
          byCode.set(scale.code, entry);
        }
      }

      for (const [code, entry] of byCode.entries()) {
        entry.points.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

        /*
         * Приведение, изменение и RCI — одним правилом с экраном прохождения
         * и сводкой случая (lib/changeBasis.ts, changeOverSeries).
         *
         * Версия иммутабельна, и это правильно, но баллы разных версий
         * формально несравнимы, а график рисует их в один ряд. Коэффициенты
         * приведения к версии последнего замера отдаются вместе с баллами, а
         * не вместо них: приведение опирается на допущение о сопоставимости
         * выборок, и знает о нём только человек, который помнит, менялся ли
         * контингент.
         *
         * Изменение и RCI считаются только между СРАВНИМЫМИ концами ряда:
         * одна версия или приведение именно первой к последней, одни единицы,
         * оба протокола достоверны. Прежде хватало одного удачного
         * коэффициента на весь ряд — при трёх версиях первая вычиталась из
         * последней неприведённой — и сырой балл без норм вычитался из
         * T-балла той же версии: «достоверное изменение» там, где изменился
         * инструмент или единицы. Теперь прочерк и причина (incomparable).
         *
         * SEM — ошибка одного измерения в единицах последнего замера, для
         * полосы на графике. Именно SEM, а не Sdiff: Sdiff — ошибка РАЗНОСТИ
         * двух замеров, и рисовать её вокруг каждой точки значит завысить
         * неопределённость в полтора раза.
         */
        const change = changeOverSeries(
          entry.points.map((p) => ({
            value: p.rawScore,
            versionId: versionIdOf.get(p.responseId) ?? null,
            versionNo: p.versionNo ?? null,
            normalized: p.normalized ?? true,
            normalization: p.normalization ?? "raw",
            reliable: reliableOf.get(p.responseId) ?? true,
          })),
          { surveyId, code, samples: sampleByKey, alphas },
        );
        entry.delta = change.delta;
        entry.direction = change.direction;
        entry.reliableChange = change.reliableChange;
        entry.incomparable = change.incomparable;
        entry.equated = change.equated;
        entry.sem = change.sem;
      }

      return {
        surveyId,
        title: t(survey.title as never, lang),
        responseCount: list.length,
        firstAt: list[0]?.submittedAt ?? null,
        lastAt: list[list.length - 1]?.submittedAt ?? null,
        scales: [...byCode.values()],
      };
    }),
  };

  await audit(c, {
    action: "response.read",
    resourceType: "respondent",
    resourceId: userId,
    subjectUserId: userId,
    // сужение по методике — тоже в журнал: «смотрел динамику PHQ-9» и «смотрел всю карту» — разные чтения
    details: { view: "dynamics", surveys: result.surveys.length, ...(onlySurvey ? { survey: onlySurvey } : {}) },
  });

  return c.json(result);
});
