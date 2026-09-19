import { Hono } from "hono";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { diffVersions, normalizeLocalized, t, validateSurvey, type Issue, renderError } from "@quizzy/shared";
import {
  createSurveySchema,
  moveSurveySchema,
  surveyGetQuery,
  surveyListQuery,
  updateSurveySchema,
  type SurveyFull,
  type SurveyKeySheet,
  type SurveyListItem,
  type SurveyListPage,
} from "@quizzy/shared";
import { db } from "../db";
import { responses, surveyVersions, surveys } from "../db/schema";
import { badRequest, forbidden, langOf, notFound, parseBody, parseQuery } from "../lib/http";
import { attachContent, createVersion, getSurvey, surveyToDraft } from "../lib/surveys";
import { audit } from "../lib/audit";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { hasPermission } from "../lib/permissions";
import {
  assertGroupAccess,
  assertSurveyAccess,
  assertSurveyFolderAccess,
  isStaff,
  surveyInUse,
  surveyScopeFilter,
} from "../lib/scope";
import { patientVisibilityFilter } from "./access";
import { hasGrant } from "../lib/scope";

/**
 * Приводит сохранённую методику к виду, который понимает валидатор.
 *
 * Сохранённая методика хранит ключ ссылками на вопросы и поправки ссылками на
 * шкалы, а валидатор работает с номерами пунктов и кодами шкал, как в пособии.
 * Без этого перевода проверка молча считала бы поправки битыми.
 */
function toValidatable(survey: SurveyFull | null) {
  if (!survey) return { questions: [], scales: [] };
  const indexById = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  return {
    questions: survey.questions,
    scales: survey.scales.map((s) => ({
      ...s,
      key: s.items.flatMap((i) => {
        const item = indexById.get(i.questionId);
        return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
      }),
      corrections: s.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
    })),
  };
}

export const surveyRoutes = new Hono<AppEnv>();

surveyRoutes.use("*", requireAuth);

/** Пользователю видны только опубликованные методики, админу — все */
/**
 * Правовой статус и отметка о сверке ключей.
 *
 * Меняет суперадмин: это не настройка методики, а утверждение учреждения о
 * том, что тексты можно применять и что ключи сверены с пособием. Такое
 * утверждение не должен делать тот, кто методику завёл.
 */
surveyRoutes.patch("/:id/rights", async (c) => {
  const user = c.get("user");
  if (user.role !== "superadmin") forbidden("err.rightsSuperadminOnly");

  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, c.req.param("id")) });
  if (!survey) notFound("err.surveyNotFound");

  const body = await c.req.json().catch(() => ({}));
  const status = ["own", "licensed", "public_domain", "unclear"].includes(body?.rightsStatus)
    ? (body.rightsStatus as "own" | "licensed" | "public_domain" | "unclear")
    : survey.rightsStatus;

  const verified = body?.keysVerified === true;
  await db
    .update(surveys)
    .set({
      rightsStatus: status,
      sourceNote: typeof body.sourceNote === "string" ? body.sourceNote.trim() || null : survey.sourceNote,
      isDemo: typeof body.isDemo === "boolean" ? body.isDemo : survey.isDemo,
      keysVerifiedAt: verified ? new Date().toISOString() : survey.keysVerifiedAt,
      keysVerifiedBy: verified ? user.id : survey.keysVerifiedBy,
    })
    .where(eq(surveys.id, survey.id));

  await audit(c, {
    action: "survey.update",
    resourceType: "survey",
    resourceId: survey.id,
    details: { rightsStatus: status, keysVerified: verified },
  });

  return c.json({ ok: true });
});

/**
 * Каталог методик: весь список или страница.
 *
 * Без ?limit= — весь список, как и было: так его зовут все выборы методики в
 * консоли и мобильное приложение, и они о страницах знать не должны. С
 * ?limit= и ?offset= — страница, и в ответе `total` по тем же условиям:
 * макет показывает «сторінка 1 з 10», и число страниц считается из него.
 *
 * Почему offset, а не курсор, как у прохождений (см. surveyListQuery в
 * shared/schemas.ts): курсор знает только «дальше», а макету нужны «назад»
 * и «из скольких». Съезд offset при вставках между страницами — беда живого
 * потока, а каталог меняется несколько раз в месяц.
 *
 * ?folder=, ?status=, ?q= — фильтры экрана каталога: папка (или `root` —
 * методики вне папок), вкладки «Опубліковані / Неопубліковані» (несколько
 * статусов — через запятую), поиск по названию. Все действуют поверх зоны
 * видимости, а не вместо неё: чужая папка в ?folder= даёт пустую страницу,
 * а не чужие методики.
 *
 * ?archived=1 — снятые с использования вместе с остальными, ?archived=only —
 * только они: вкладка «Зняті» иначе просила бы весь список и отсеивала
 * сама, и её страница с total считались бы не по тому, что на экране.
 */
surveyRoutes.get("/", async (c) => {
  const user = c.get("user");
  const query = parseQuery(c, surveyListQuery);

  const filters = [];
  if (!isStaff(user)) {
    // пациент видит опубликованные общедоступные плюс назначенные лично ему
    filters.push(patientVisibilityFilter(user.id));
    /*
     * Демонстрационные методики пациенту не выдаются. Раньше единственной
     * защитой было «(демо)» в названии — то есть внимательность того, кто
     * назначает.
     */
    filters.push(eq(surveys.isDemo, false));
  } else {
    // сотрудник видит только методики своих групп
    const scope = await surveyScopeFilter(user);
    if (scope) filters.push(scope);
  }
  if (query.groupId) filters.push(eq(surveys.groupId, query.groupId));
  // снятые с использования показываются только по явному запросу сотрудника;
  // пациенту параметр не даёт ничего — ему и в работе видно не всё
  const archivedMode = isStaff(user) ? query.archived : undefined;
  if (archivedMode === "only") filters.push(isNotNull(surveys.archivedAt));
  else if (archivedMode !== "1") filters.push(surveyInUse);

  if (query.folder === "root") {
    filters.push(isNull(surveys.folderId));
  } else if (query.folder && query.q) {
    /*
     * Поиск из папки — по её поддереву, а не по одному уровню. Каталог
     * разложен по годам и месяцам, и человек, стоя в «Тести за 2023», ищет
     * методику, которая лежит в «Лютий 2023» внутри; уровень нашёл бы
     * пустоту. Без ?q= папка по-прежнему показывает только свой уровень:
     * вложенные папки экран рисует отдельно, и методики из них здесь были
     * бы дублями.
     *
     * Поддерево собирает рекурсивный CTE по parent_id: глубина раскладки
     * заранее не ограничена, и заготовленное число JOIN однажды промолчало
     * бы о слишком глубокой папке.
     */
    filters.push(
      sql`${surveys.folderId} in (
        with recursive subtree as (
          select id from survey_folders where id = ${query.folder}
          union all
          select f.id from survey_folders f join subtree s on f.parent_id = s.id
        )
        select id from subtree)`,
    );
  } else if (query.folder) {
    filters.push(eq(surveys.folderId, query.folder));
  }
  if (query.status) filters.push(inArray(surveys.status, query.status));
  if (query.q) {
    /*
     * Поиск — ILIKE по названию на обоих языках, а не слепой индекс из
     * lib/searchIndex.ts: тот существует ради шифрованных записей, а
     * названия методик лежат открыто, и их сотни, не тысячи. Подстановочные
     * знаки экранируются: «100%» в запросе — это проценты, а не «всё».
     */
    const pattern = `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    filters.push(
      sql`(${surveys.title}->>'uk' ilike ${pattern} escape '\\' or ${surveys.title}->>'ru' ilike ${pattern} escape '\\')`,
    );
  }
  const where = filters.length ? and(...filters) : undefined;

  const listing = db
    .select({
      survey: surveys,
      // подзапросы пишем с алиасами и полной квалификацией внешней колонки:
      // drizzle рендерит surveys.id как "id", а внутри подзапроса это имя перехватила бы
      // одноимённая колонка вложенной таблицы
      questionCount: sql<number>`(select count(*) from questions q where q.survey_id = "surveys"."id")`,
      responseCount: sql<number>`(select count(*) from responses r where r.survey_id = "surveys"."id" and r.status = 'completed')`,
      completedByMe: sql<number>`(select count(*) from responses r where r.survey_id = "surveys"."id" and r.user_id = ${user.id} and r.status = 'completed')`,
      /*
       * Назначена лично или доступна всем — это разные вещи для того, кто
       * смотрит список.
       *
       * Общедоступную методику человек проходит, если захочет; назначенную от
       * него ждут, и у неё есть срок. Показывать их одним списком без
       * различия значит не показать ни того ни другого: назначенное теряется
       * среди доступного, а доступное выглядит обязательным.
       */
      assignedAt: sql<string | null>`(
        select sa.granted_at from survey_access sa
        where sa.survey_id = "surveys"."id" and sa.user_id = ${user.id}
          and (sa.expires_at is null or sa.expires_at > now())
        limit 1)`,
      dueAt: sql<string | null>`(
        select sa.expires_at from survey_access sa
        where sa.survey_id = "surveys"."id" and sa.user_id = ${user.id}
          and (sa.expires_at is null or sa.expires_at > now())
        limit 1)`,
    })
    .from(surveys)
    .where(where)
    /*
     * Идентификатор вторым ключом — ради страниц. Postgres не обещает
     * порядка среди равных created_at, и посев кладёт десятки методик одной
     * секундой: без второго ключа одна и та же методика могла бы попасть на
     * две страницы, а другая — ни на одну, и по списку этого не видно.
     */
    .orderBy(desc(surveys.createdAt), desc(surveys.id))
    .$dynamic();
  const rows = await (query.limit === undefined
    ? listing
    : listing.limit(query.limit).offset(query.offset));

  /*
   * total считается вторым запросом и только когда просили страницу: без
   * страницы он равен длине списка, и обходить таблицу ещё раз ради того
   * же числа незачем.
   */
  const total =
    query.limit === undefined
      ? rows.length
      : Number((await db.select({ n: sql<number>`count(*)::int` }).from(surveys).where(where))[0]?.n ?? 0);

  const list: SurveyListItem[] = rows.map((r) => ({
    ...r.survey,
    title: t(r.survey.title as never, langOf(c)),
    description: r.survey.description ? t(r.survey.description as never, langOf(c)) : null,
    instructions: r.survey.instructions ? t(r.survey.instructions as never, langOf(c)) : null,
    safetyPlan: r.survey.safetyPlan ? t(r.survey.safetyPlan as never, langOf(c)) : null,
    rightsStatus: r.survey.rightsStatus,
    isDemo: r.survey.isDemo,
    keysVerifiedAt: r.survey.keysVerifiedAt,
    questionCount: Number(r.questionCount ?? 0),
    responseCount: Number(r.responseCount ?? 0),
    completedByMe: Number(r.completedByMe ?? 0) > 0,
    assigned: r.assignedAt !== null,
    dueAt: r.dueAt,
  }));
  return c.json({ items: list, total } satisfies SurveyListPage);
});

/**
 * Методика с содержимым. ?version=N — содержимое конкретной версии.
 *
 * Просмотр пройденного теста показывает ту версию, которую человек проходил:
 * правка методики создаёт новую версию с новыми пунктами и границами полос,
 * и действующая версия рядом со старыми ответами — правдоподобные, но чужие
 * числа. Права на версию — те же, что на методику: версия не отдельная
 * сущность, а её прошлое.
 */
surveyRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const query = parseQuery(c, surveyGetQuery);
  // raw=1 отдаёт локализованные объекты целиком — этим живёт конструктор
  const raw = query.raw === "1" && isStaff(user);
  const survey = await getSurvey(c.req.param("id"), null, langOf(c), raw);
  if (!survey) notFound("err.surveyNotFound");
  if (!isStaff(user)) {
    if (survey.status !== "published") notFound("err.surveyNotFound");
    if (survey.administration !== "self") notFound("err.surveyNotFound");
    if (survey.visibility === "restricted" && !(await hasGrant(user.id, survey.id))) {
      notFound("err.surveyNotFound");
    }
  } else {
    await assertSurveyAccess(user, survey.id);
  }
  if (query.version === undefined || query.version === survey.versionNumber) return c.json(survey);

  /*
   * Версия ищется только после проверки прав и только среди версий ЭТОЙ
   * методики. Иначе по ответу «версии нет / версия есть» можно было бы
   * пересчитать версии методики, которую человеку видеть не положено, а по
   * id версии — прочитать содержимое чужой.
   */
  const [versionRow] = await db
    .select({ id: surveyVersions.id })
    .from(surveyVersions)
    .where(and(eq(surveyVersions.surveyId, survey.id), eq(surveyVersions.version, query.version)));
  if (!versionRow) notFound("err.surveyVersionNotFound");
  const versioned = await getSurvey(survey.id, versionRow.id, langOf(c), raw);
  if (!versioned) notFound("err.surveyVersionNotFound");
  return c.json(versioned);
});

/**
 * Проверка методики без сохранения — конструктор зовёт её перед публикацией.
 * Отдельным маршрутом, чтобы можно было проверить черновик, ничего не записав.
 */
surveyRoutes.post("/validate", requireStaff, requirePermission("surveys.edit"), async (c) => {
  const input = await parseBody(c.req.raw, createSurveySchema);
  return c.json({ issues: validateSurvey(input) });
});

surveyRoutes.post("/", requireStaff, requirePermission("surveys.edit"), async (c) => {
  const input = await parseBody(c.req.raw, createSurveySchema);
  // методику нельзя положить в чужую группу
  if (input.groupId) await assertGroupAccess(c.get("user"), input.groupId);
  /*
   * «+» на экране папки: методика заводится сразу в ней. Папка обязана быть
   * из той же группы, иначе её не увидят те, кто увидит методику. Базу это
   * правило тоже держит (составной ключ, миграция 0080), но отказ отсюда
   * объясняет, а отказ базы — пятисотка. Методика без группы (null) под
   * это же условие не проходит: у неё нет каталога, а значит, и полки.
   */
  if (input.folderId) {
    const folder = await assertSurveyFolderAccess(c.get("user"), input.folderId);
    if (folder.groupId !== (input.groupId ?? null)) badRequest("err.surveyFolderOtherGroup");
  }

  const [row] = await db
    .insert(surveys)
    .values({
      id: crypto.randomUUID(),
      groupId: input.groupId ?? null,
      folderId: input.folderId ?? null,
      title: normalizeLocalized(input.title)!,
      description: normalizeLocalized(input.description),
      instructions: normalizeLocalized(input.instructions),
      administration: input.administration,
      timeLimitSec: input.timeLimitSec ?? null,
      randomizeQuestions: input.randomizeQuestions ?? false,
      allowBack: input.allowBack ?? true,
      showProgress: input.showProgress ?? true,
      anonymous: input.anonymous ?? false,
      visibility: input.visibility ?? "public",
      allowRetake: input.allowRetake ?? false,
      scoringEnabled: input.scoringEnabled ?? false,
      tooFastMs: input.tooFastMs ?? null,
      alertEscalateMinutes: input.alertEscalateMinutes ?? null,
      safetyPlan: normalizeLocalized(input.safetyPlan),
      showResultsToPatient: input.showResultsToPatient ?? false,
      createdBy: c.get("user").id,
    })
    .returning();

  await createVersion(row!.id, input, c.get("user").id, "Первая версия");
  await audit(c, {
    action: "survey.create",
    resourceType: "survey",
    resourceId: row!.id,
    details: { title: t(row!.title as never), questions: input.questions.length },
  });
  const [full] = await attachContent([row!]);
  return c.json({ ...full, issues: validateSurvey(input) satisfies Issue[] }, 201);
});

surveyRoutes.patch("/:id", requireStaff, requirePermission("surveys.edit"), async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);
  const input = await parseBody(c.req.raw, updateSurveySchema);
  if (input.groupId) await assertGroupAccess(c.get("user"), input.groupId);

  const existing = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  if (!existing) notFound("err.surveyNotFound");

  /*
   * Смена статуса — это публикация или снятие с использования, и закрыта она
   * своим правом, а не правом на правку.
   *
   * Проверка стоит внутри обработчика, а не строкой middleware, потому что
   * маршрут один: правка и публикация приезжают одним PATCH. Закрыть весь
   * маршрут правом surveys.publish значило бы запретить стажёру править
   * черновик; оставить публикацию под surveys.edit значило бы, что право
   * «публиковать» не закрывает публикацию — и экран прав врал бы, обещая
   * разделение, которого нет.
   */
  if (input.status !== undefined && input.status !== existing.status) {
    if (!(await hasPermission(c.get("user"), "surveys.publish"))) {
      forbidden("err.permissionRequired", { permission: "surveys.publish" });
    }
  }

  const changesContent = !!(input.questions || input.sections || input.scales);

  const goingLive = input.status === "published" && existing.status !== "published";

  /*
   * Смена группы снимает методику с полки. Папка живёт в группе, и в новой
   * группе этой папки нет; оставить указатель значило бы показать
   * сотрудникам нового отделения папку, которой им не видно, — а база такой
   * строки и не примет: составной ключ (folder_id, group_id) её отвергнет
   * пятисоткой. Обнуляется той же строкой UPDATE, чтобы ключ не сработал
   * раньше. Снятие в личные черновики (groupId: null) — тоже уход из группы.
   */
  const leavesGroup = input.groupId !== undefined && (input.groupId ?? null) !== existing.groupId;

  /*
   * Публикация со структурными ошибками запрещена: методика, которая не может
   * быть корректно посчитана, не должна попадать к пациентам. Черновик с
   * ошибками сохранить можно — это нормальное состояние незаконченной работы.
   */
  if (input.status === "published") {
    const full = changesContent
      ? { questions: input.questions ?? [], scales: input.scales ?? [] }
      : toValidatable(await getSurvey(id, null, "uk", true));
    const errors = validateSurvey(full as never).filter((i) => i.level === "error");
    if (errors.length) {
      badRequest("err.surveyPublishErrors", {
        count: errors.length,
        details: errors.map((e) => `${e.where}: ${e.message}`).join("; "),
      });
    }
  }
  const [row] = await db
    .update(surveys)
    .set({
      ...(input.title !== undefined && { title: normalizeLocalized(input.title)! }),
      ...(input.description !== undefined && { description: normalizeLocalized(input.description) }),
      ...(input.instructions !== undefined && { instructions: normalizeLocalized(input.instructions) }),
      ...(input.groupId !== undefined && { groupId: input.groupId ?? null }),
      ...(leavesGroup && { folderId: null }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.timeLimitSec !== undefined && { timeLimitSec: input.timeLimitSec ?? null }),
      ...(input.randomizeQuestions !== undefined && { randomizeQuestions: input.randomizeQuestions }),
      ...(input.allowBack !== undefined && { allowBack: input.allowBack }),
      ...(input.showProgress !== undefined && { showProgress: input.showProgress }),
      ...(input.anonymous !== undefined && { anonymous: input.anonymous }),
      ...(input.administration !== undefined && { administration: input.administration }),
      ...(input.visibility !== undefined && { visibility: input.visibility }),
      ...(input.allowRetake !== undefined && { allowRetake: input.allowRetake }),
      ...(input.scoringEnabled !== undefined && { scoringEnabled: input.scoringEnabled }),
      ...(input.tooFastMs !== undefined && { tooFastMs: input.tooFastMs ?? null }),
      ...(input.alertEscalateMinutes !== undefined && { alertEscalateMinutes: input.alertEscalateMinutes ?? null }),
      ...(input.safetyPlan !== undefined && { safetyPlan: normalizeLocalized(input.safetyPlan) }),
      ...(input.showResultsToPatient !== undefined && { showResultsToPatient: input.showResultsToPatient ?? false }),
      ...(goingLive && { publishedAt: new Date().toISOString() }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(surveys.id, id))
    .returning();

  if (changesContent) {
    // правка не трогает старые строки: создаётся новая версия, а уже собранные
    // прохождения продолжают ссылаться на ту версию, которую респондент видел
    await createVersion(
      id,
      {
        sections: input.sections ?? [],
        scales: input.scales ?? [],
        questions: input.questions ?? [],
      },
      c.get("user").id,
      input.versionNote,
    );
  }

  await audit(c, {
    action: goingLive ? "survey.publish" : "survey.update",
    resourceType: "survey",
    resourceId: id,
    details: { status: row!.status, contentChanged: changesContent },
  });

  // перечитываем строку: currentVersionId выставляется внутри createVersion,
  // и без этого ответ вернул бы содержимое прежней версии
  const fresh = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  const [full] = await attachContent([fresh ?? row!]);
  return c.json(full);
});

/** Копия методики — штатный способ «отредактировать» методику, по которой уже есть данные */
surveyRoutes.post("/:id/duplicate", requireStaff, requirePermission("surveys.edit"), async (c) => {
  await assertSurveyAccess(c.get("user"), c.req.param("id"));
  const source = await getSurvey(c.req.param("id"));
  if (!source) notFound("err.surveyNotFound");

  const [row] = await db
    .insert(surveys)
    .values({
      id: crypto.randomUUID(),
      groupId: source.groupId,
      // копия ложится рядом с оригиналом: искать её в корне каталога незачем
      folderId: source.folderId,
      title: { uk: `${source.title} (копія)`, ru: `${source.title} (копия)` } as Record<string, string>,
      description: source.description ? { uk: source.description } : null,
      instructions: source.instructions ? { uk: source.instructions } : null,
      status: "draft",
      timeLimitSec: source.timeLimitSec,
      randomizeQuestions: source.randomizeQuestions,
      allowBack: source.allowBack,
      showProgress: source.showProgress,
      anonymous: source.anonymous,
      visibility: source.visibility,
      administration: source.administration,
      allowRetake: source.allowRetake,
      scoringEnabled: source.scoringEnabled,
      createdBy: c.get("user").id,
    })
    .returning();

  const sectionKeyById = new Map(source.sections.map((s) => [s.id, s.id]));
  const questionIndexById = new Map(source.questions.map((q, i) => [q.id, i]));

  await createVersion(
    row!.id,
    {
    sections: source.sections.map((s) => ({
      key: s.id,
      title: s.title,
      description: s.description,
    })),
    // копия сохраняет всю механику шкал, иначе она перестанет считаться
    scales: source.scales.map((s) => ({
      code: s.code,
      title: s.title,
      description: s.description,
      aggregation: s.aggregation,
      kind: s.kind,
      normalization: s.normalization,
      ratioDenominator: s.ratioDenominator,
      validityThreshold: s.validityThreshold,
      validityDirection: s.validityDirection,
      validityMessage: s.validityMessage,
      bands: s.bands.map((b) => ({
        minScore: b.minScore,
        maxScore: b.maxScore,
        label: b.label,
        severity: b.severity,
        description: b.description,
        grade: b.grade,
        recommendation: b.recommendation,
      })),
      key: s.items.flatMap((i) => {
        const idx = questionIndexById.get(i.questionId);
        return idx === undefined ? [] : [{ item: idx + 1, matchKey: i.matchKey, weight: i.weight }];
      }),
      corrections: s.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
      norms: s.norms,
      stenTable: s.stenTable,
    })),
    questions: source.questions.map((q) => ({
      type: q.type,
      title: q.title,
      help: q.help,
      required: q.required,
      sectionKey: q.sectionId ? (sectionKeyById.get(q.sectionId) ?? null) : null,
      scaleCode: source.scales.find((s) => s.id === q.scaleId)?.code ?? null,
      reverseScored: q.reverseScored,
      minValue: q.minValue,
      maxValue: q.maxValue,
      step: q.step,
      minLabel: q.minLabel,
      maxLabel: q.maxLabel,
      randomizeOptions: q.randomizeOptions,
      timeLimitSec: q.timeLimitSec,
      riskThreshold: q.riskThreshold,
      riskLabel: q.riskLabel,
      riskSeverity: q.riskSeverity,
      options: q.options.map((o) => ({
        text: o.text,
        score: o.score,
        kind: o.kind,
        riskFlag: o.riskFlag,
        riskLabel: o.riskLabel,
        riskSeverity: o.riskSeverity,
      })),
      logic: q.logic.flatMap((rule) => {
        const sourceIndex = questionIndexById.get(rule.sourceQuestionId);
        return sourceIndex === undefined
          ? []
          : [{ sourceIndex, operator: rule.operator, value: rule.value, action: rule.action }];
      }),
    })),
    },
    c.get("user").id,
    `Копия «${source.title}»`,
  );

  await audit(c, {
    action: "survey.duplicate",
    resourceType: "survey",
    resourceId: row!.id,
    details: { sourceId: source.id },
  });

  const [full] = await attachContent([row!]);
  return c.json(full, 201);
});

/**
 * Перенос методики в папку каталога — или в корень (null).
 *
 * Свой маршрут, а не поле в общей правке. Перенос — действие каталога, а не
 * правка методики: у него своя запись в журнале (survey.move), он не создаёт
 * версию и не трогает updatedAt. Положить folderId в PATCH значило бы, что
 * конструктор, сохраняя черновик целиком, молча переставлял бы методику по
 * полкам — и разбирать по журналу, кто её переложил, было бы нечем.
 *
 * Папка обязана быть из группы методики. Проверка здесь — ради понятного
 * отказа; держит правило база (составной ключ, миграция 0080), и обойти его
 * другим маршрутом или скриптом нельзя. Методика без группы под условие не
 * проходит: null не равен группе папки, и это правильно — у личного
 * черновика нет каталога.
 */
surveyRoutes.put("/:id/folder", requireStaff, requirePermission("surveys.edit"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await assertSurveyAccess(user, id);
  const input = await parseBody(c.req.raw, moveSurveySchema);

  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  if (!survey) notFound("err.surveyNotFound");

  if (input.folderId) {
    const folder = await assertSurveyFolderAccess(user, input.folderId);
    if (folder.groupId !== survey.groupId) badRequest("err.surveyFolderOtherGroup");
  }

  await db.update(surveys).set({ folderId: input.folderId }).where(eq(surveys.id, id));
  await audit(c, {
    action: "survey.move",
    resourceType: "survey",
    resourceId: id,
    details: { from: survey.folderId, to: input.folderId },
  });
  return c.json({ id, folderId: input.folderId });
});

/** История версий методики со счётчиком прохождений на каждой */
surveyRoutes.get("/:id/versions", requireStaff, requirePermission("surveys.read"), async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);

  const rows = await db
    .select({
      id: surveyVersions.id,
      surveyId: surveyVersions.surveyId,
      version: surveyVersions.version,
      note: surveyVersions.note,
      createdBy: surveyVersions.createdBy,
      createdAt: surveyVersions.createdAt,
      responseCount: sql<number>`(select count(*) from responses r where r.version_id = "survey_versions"."id")`,
    })
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, id))
    .orderBy(desc(surveyVersions.version));

  return c.json({ items: rows.map((r) => ({ ...r, responseCount: Number(r.responseCount ?? 0) })) });
});

/**
 * Что изменилось между двумя версиями.
 *
 * Правка создаёт новую версию, старые прохождения остаются на прежней. Через
 * полгода, глядя на две группы результатов, нужно уметь ответить: они
 * сопоставимы или между ними переписали ключ? Ответ — здесь.
 */
surveyRoutes.get("/:id/versions/:a/diff/:b", requireStaff, requirePermission("surveys.read"), async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);

  const [before, after] = await Promise.all([
    getSurvey(id, c.req.param("a"), langOf(c)),
    getSurvey(id, c.req.param("b"), langOf(c)),
  ]);
  if (!before || !after) notFound("err.surveyVersionNotFound");

  return c.json({
    before: { versionId: before.versionId, versionNumber: before.versionNumber },
    after: { versionId: after.versionId, versionNumber: after.versionNumber },
    ...diffVersions(before, after),
  });
});

/**
 * Печать ключей методики для сверки с пособием.
 *
 * Структурная проверка ловит форму, но не содержание: если при переносе
 * перепутаны 47 и 74, она промолчит. Единственный способ поймать такое —
 * положить рядом распечатку ключей и оригинал, поэтому ключи выводятся
 * ровно в том виде, в каком они напечатаны в пособии.
 */
surveyRoutes.get("/:id/key", requireStaff, requirePermission("surveys.read"), async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);
  const survey = await getSurvey(id, null, langOf(c));
  if (!survey) notFound("err.surveyNotFound");

  const indexById = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  const compress = (nums: number[]) => nums.sort((a, b) => a - b).join(", ");

  /*
   * Колонки ключа — по кодам ответов, которые встречаются в вариантах
   * методики, а не по списку «да/нет». Ключ хранит код (matchKey), и код
   * этот — любой: у методики с ответами «так / ні / не знаю» третий код
   * раньше не попадал ни в одну колонку и выпадал из печати молча — ровно
   * то, чего распечатка для сверки с пособием допускать не должна.
   *
   * Порядок — по первому появлению в вариантах: так колонки стоят, как
   * ответы в бланке. Код, которого ждёт ключ, но нет ни у одного варианта,
   * тоже становится колонкой: это ошибка ключа, и на печати её должно быть
   * видно, а не спрятано.
   */
  const keyCodes: SurveyKeySheet["keyCodes"] = [];
  const seenCode = new Set<string>();
  for (const q of survey.questions) {
    for (const o of q.options) {
      if (o.kind !== "option" || !o.keyCode || seenCode.has(o.keyCode)) continue;
      seenCode.add(o.keyCode);
      keyCodes.push({ code: o.keyCode, label: o.text });
    }
  }
  for (const scale of survey.scales) {
    for (const item of scale.items) {
      if (!item.matchKey || seenCode.has(item.matchKey)) continue;
      seenCode.add(item.matchKey);
      keyCodes.push({ code: item.matchKey, label: item.matchKey });
    }
  }

  const scales = survey.scales.map((scale): SurveyKeySheet["scales"][number] => {
    const itemsFor = (code: string | null) =>
      compress(
        scale.items
          .filter((i) => i.matchKey === code)
          .flatMap((i) => {
            const n = indexById.get(i.questionId);
            return n === undefined ? [] : [n];
          }),
      );
    return {
      code: scale.code,
      title: scale.title,
      kind: scale.kind,
      normalization: scale.normalization,
      itemCount: scale.items.length,
      keys: keyCodes.map((k) => ({ code: k.code, label: k.label, items: itemsFor(k.code) })),
      yes: itemsFor("yes"),
      no: itemsFor("no"),
      scored: itemsFor(null),
      corrections: scale.corrections.map((x) => `${x.sourceScaleCode} × ${x.coefficient}`).join(", "),
      norms: scale.norms.map((n) => `${n.sex ?? "любой"}: M=${n.mean}, δ=${n.sd}`).join("; "),
      stens: scale.stenTable
        .sort((a, b) => a.sten - b.sten)
        .map((r) => `${r.sten}: ${r.rawMin}–${r.rawMax >= 999 ? "∞" : r.rawMax}`)
        .join("  "),
      bands: scale.bands.map((b) => `${b.minScore}–${b.maxScore} → ${b.label}`).join("; "),
    };
  });

  await audit(c, { action: "survey.key_print", resourceType: "survey", resourceId: id });

  return c.json({
    surveyId: id,
    title: survey.title,
    version: survey.versionNumber,
    questionCount: survey.questions.length,
    questions: survey.questions.map((q, i) => ({ n: i + 1, title: q.title })),
    keyCodes,
    scales,
  } satisfies SurveyKeySheet);
});

/** Выгрузка методики в том виде, в каком её принимает конструктор */
surveyRoutes.get("/:id/export", requireStaff, requirePermission("surveys.read"), async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);
  const survey = await getSurvey(id, null, "uk", true);
  if (!survey) notFound("err.surveyNotFound");

  const draft = surveyToDraft(survey);

  await audit(c, { action: "survey.export", resourceType: "survey", resourceId: id });
  return c.json(draft);
});

/**
 * Импорт методики из файла экспорта.
 *
 * Файл — тот же формат, что отдаёт export (ключи по номерам пунктов),
 * поэтому конвейер совпадает с посевом: схема → структурный валидатор →
 * createVersion. Методика с ошибками валидатора не создаётся вовсе:
 * «импортировалось, но считает неправильно» — худший исход из возможных.
 * Импортированное всегда черновик: публикация — осознанное действие после
 * сверки ключей.
 */
surveyRoutes.post("/import", requireStaff, requirePermission("surveys.edit"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") badRequest("err.jsonExportExpected");

  const { formatVersion, groupId, ...raw } = body as Record<string, unknown>;
  if (formatVersion !== undefined && formatVersion !== 1) {
    badRequest("err.unknownFormatVersion", { version: String(formatVersion) });
  }
  if (groupId) await assertGroupAccess(user, String(groupId));

  const parsed = createSurveySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    badRequest("err.importParseFailed", { path: first?.path.join(".") ?? "", message: first?.message ?? "" });
  }
  const input = parsed.data;

  const issues = validateSurvey(input);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    // 422 с полным списком: чинить файл, а не половину методики в базе
    /*
       Отдаётся напрямую, а не через помощник отказа: вместе с текстом уходит
       список замечаний, и терять его нельзя — по нему чинят файл. Текст при
       этом всё равно переводится: язык здесь тот же, что и у всех остальных
       отказов.
    */
    return c.json({ error: renderError("err.structureErrors", langOf(c)), issues }, 422);
  }

  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupId ? String(groupId) : null,
    title: normalizeLocalized(input.title),
    description: normalizeLocalized(input.description),
    instructions: normalizeLocalized(input.instructions),
    administration: input.administration,
    status: "draft",
    timeLimitSec: input.timeLimitSec ?? null,
    randomizeQuestions: input.randomizeQuestions ?? false,
    allowBack: input.allowBack ?? true,
    showProgress: input.showProgress ?? true,
    anonymous: input.anonymous ?? false,
    visibility: input.visibility ?? "public",
    allowRetake: input.allowRetake ?? false,
    scoringEnabled: input.scoringEnabled ?? false,
    tooFastMs: input.tooFastMs ?? null,
    alertEscalateMinutes: input.alertEscalateMinutes ?? null,
    safetyPlan: normalizeLocalized(input.safetyPlan),
    createdBy: user.id,
  } as never);
  await createVersion(id, input, user.id, "Импорт из файла");

  await audit(c, {
    action: "survey.import",
    resourceType: "survey",
    resourceId: id,
    details: {
      title: t(normalizeLocalized(input.title) as never),
      questions: input.questions.length,
      scales: (input.scales ?? []).length,
      warnings: issues.length,
    },
  });
  return c.json({ id, issues }, 201);
});

/**
 * Снятие методики с использования.
 *
 * Метод оставлен DELETE ради совместимости с клиентами, но данные не
 * удаляются: строка `surveys` связана каскадом с прохождениями, баллами,
 * тревогами и назначениями, и настоящее удаление уносило бы клиническую
 * историю живых людей — необратимо и по нажатию одной кнопки.
 *
 * Физическое удаление возможно только с сервера: `bun run survey:purge`,
 * и только для уже снятой методики.
 */
surveyRoutes.delete("/:id", requireStaff, requirePermission("surveys.publish"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await assertSurveyAccess(user, id);

  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  if (!survey) notFound("err.surveyNotFound");
  if (survey.archivedAt) badRequest("err.surveyAlreadyArchived");

  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(responses)
    .where(eq(responses.surveyId, id));
  const responseCount = counted?.count ?? 0;

  await db
    .update(surveys)
    .set({ archivedAt: new Date().toISOString(), archivedBy: user.id })
    .where(eq(surveys.id, id));

  await audit(c, {
    action: "survey.archive",
    resourceType: "survey",
    resourceId: id,
    // число прохождений в журнале: по нему видно, что именно было выведено
    // из оборота, даже если методику потом вычистят с сервера
    details: { title: t(survey.title as never), responses: responseCount },
  });
  return c.body(null, 204);
});

/** Возврат методики в работу. Снятие — решение обратимое, в этом и смысл. */
surveyRoutes.post("/:id/restore", requireStaff, requirePermission("surveys.publish"), async (c) => {
  const id = c.req.param("id");
  await assertSurveyAccess(c.get("user"), id);

  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  if (!survey) notFound("err.surveyNotFound");
  if (!survey.archivedAt) badRequest("err.surveyNotArchived");

  await db.update(surveys).set({ archivedAt: null, archivedBy: null }).where(eq(surveys.id, id));
  await audit(c, {
    action: "survey.restore",
    resourceType: "survey",
    resourceId: id,
    details: { title: t(survey.title as never) },
  });
  return c.body(null, 204);
});
