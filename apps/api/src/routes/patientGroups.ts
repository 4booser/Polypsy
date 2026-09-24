import { Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  assignSurveyToPatientGroupSchema,
  patientGroupInputSchema,
  patientGroupMemberSchema,
  patientGroupMembersRemoveSchema,
  type PatientGroupCard,
  type PatientGroupMember,
  type PatientGroupSurvey,
  type PatientGroupWithCounts,
} from "@quizzy/shared";
import { db } from "../db";
import {
  patientGroupFavourites,
  patientGroupMembers,
  patientGroups,
  patientGroupSurveys,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField } from "../lib/crypto";
import { badRequest, notFound, parseBody } from "../lib/http";
import { grantAccess } from "../lib/grantAccess";
import { birthYearOf } from "../lib/privacy";
import {
  accessiblePatientIds,
  assertPatientGroupAccess,
  assertSurveyAccess,
  assertSurveysInUse,
} from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Группы ПАЦИЕНТОВ — рабочие списки специалиста.
 *
 * Не путать с /api/groups: там группы МЕТОДИК, единица разграничения
 * доступа. Здесь — «Моя група», «Група ризику», «Вечірня група»: перечень
 * людей, который врач собрал руками, назвал и снабдил собственным описанием
 * («опис групи (питання до групи)»). Группа пациентов ничего не открывает и
 * ничего не закрывает: кого специалист вправе видеть, по-прежнему решает
 * зона ответственности из lib/scope.ts.
 *
 * Отсюда и права. Весь набор закрыт `patients.read`, а не отдельным правом
 * на группы: всё, что здесь показывается, — это пациенты, их имена и
 * подразделения, то есть ровно то, что открывает `patients.read`. Заводить
 * второе право значило бы, что специалист с доступом к пациентам не может
 * разложить их по вкладкам, — запрет, которого никто не собирался вводить.
 * Единственное исключение — назначение методики на группу: оно раздаёт
 * доступ и закрыто `assignments.manage`, тем же правом, что и поимённая
 * выдача.
 */
export const patientGroupRoutes = new Hono<AppEnv>();

patientGroupRoutes.use("*", requireAuth, requireStaff, requirePermission("patients.read"));

/**
 * Состав группы, ограниченный зоной видимости читателя.
 *
 * `visible` — множество из `accessiblePatientIds`, посчитанное ОДИН раз на
 * запрос и переданное сюда; `null` означает «ограничений нет» (суперадмин).
 * Считать зону внутри помощника было бы удобнее на вид и стоило бы одного
 * вычисления на каждую группу в списке: на экране с восемью вкладками это
 * восемь обходов всех пациентов вместо одного (см. счётчик вызовов в
 * lib/scope.ts — он существует ровно из-за такой истории).
 *
 * Почему состав вообще фильтруется, ведь добавлял их сам владелец. Потому
 * что зона меняется: человека перевели в другое отделение, приём отменили,
 * доступ «разбить стекло» истёк — и список, собранный в марте, в сентябре
 * показывал бы имена людей, которых сотруднику больше видеть не положено.
 * Членство в группе не должно становиться обходным путём к карте.
 */
function membersVisibleTo(visible: Set<string> | null) {
  return (row: { userId: string }) => visible === null || visible.has(row.userId);
}

/**
 * Список групп с числом участников и назначенных методик.
 *
 * Чужих групп в выдаче нет вовсе — не отфильтрованы, а не выбраны: условие
 * по владельцу стоит в запросе. Суперадмин видит все: разбирать, что
 * происходит на экранах сотрудников, ему больше нечем.
 */
patientGroupRoutes.get("/", async (c) => {
  const user = c.get("user");
  const visible = await accessiblePatientIds(user);

  const rows = await db
    .select({
      id: patientGroups.id,
      title: patientGroups.title,
      description: patientGroups.description,
      color: patientGroups.color,
      position: patientGroups.position,
      ownerId: patientGroups.ownerId,
      createdAt: patientGroups.createdAt,
      surveyCount: sql<number>`(select count(*)::int from patient_group_surveys pgs
        where pgs.group_id = "patient_groups"."id")`,
      /*
       * «Обрана» — закладка ЧИТАТЕЛЯ, поэтому условие по нему стоит здесь, в
       * подвыборке, а не берётся из строки группы: суперадмин, разбирающий
       * чужие вкладки, видит свои закладки, а не закладки владельца.
       */
      favourite: sql<boolean>`exists (select 1 from patient_group_favourites f
        where f.group_id = "patient_groups"."id" and f.user_id = ${user.id})`,
    })
    .from(patientGroups)
    .where(user.role === "superadmin" ? undefined : eq(patientGroups.ownerId, user.id))
    /*
     * Порядок задан в базе, а не сортировкой на экране: вкладки читает и
     * консоль, и мобильное приложение, и договориться о порядке в одном
     * месте дешевле, чем в двух. «Обрана» — первой, ради этого закладка и
     * ставится; затем как расставили руками; равные позиции разводятся
     * датой — иначе порядок вкладок менялся бы от запроса к запросу.
     */
    .orderBy(
      sql`exists (select 1 from patient_group_favourites f
        where f.group_id = "patient_groups"."id" and f.user_id = ${user.id}) desc`,
      asc(patientGroups.position),
      asc(patientGroups.createdAt),
    );

  /*
   * Состав всех групп одним запросом, а не по запросу на группу: восемь
   * вкладок — это восемь обращений к базе ради одного числа под каждой.
   */
  const memberRows = rows.length
    ? await db
        .select({ groupId: patientGroupMembers.groupId, userId: patientGroupMembers.patientId })
        .from(patientGroupMembers)
        .where(inArray(patientGroupMembers.groupId, rows.map((r) => r.id)))
    : [];

  const counts = new Map<string, number>();
  for (const m of memberRows.filter(membersVisibleTo(visible))) {
    counts.set(m.groupId, (counts.get(m.groupId) ?? 0) + 1);
  }

  const items: PatientGroupWithCounts[] = rows.map((r) => ({
    ...r,
    memberCount: counts.get(r.id) ?? 0,
    surveyCount: Number(r.surveyCount ?? 0),
    favourite: Boolean(r.favourite),
  }));
  return c.json({ items });
});

/** Заведение группы. Владельцем становится тот, кто её завёл, — иначе некому */
patientGroupRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, patientGroupInputSchema);

  const [row] = await db
    .insert(patientGroups)
    .values({
      id: crypto.randomUUID(),
      title: input.title,
      description: input.description ?? null,
      color: input.color ?? null,
      position: input.position ?? 0,
      ownerId: user.id,
    })
    .returning();

  await audit(c, {
    action: "patient_group.create",
    resourceType: "patient_group",
    resourceId: row!.id,
    details: { title: row!.title },
  });
  return c.json(row, 201);
});

/**
 * Карточка группы: описание, «Пацієнти Групи» и «Тести Групи» на одном
 * экране — ровно так, как их показывает макет.
 *
 * Три запроса вместо трёх маршрутов: экран всё равно открывает их вместе, а
 * разложенные по отдельным эндпоинтам они означали бы три проверки доступа
 * вместо одной — и три места, где эту проверку можно забыть.
 */
patientGroupRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const groupId = c.req.param("id");
  await assertPatientGroupAccess(user, groupId);

  const group = await db.query.patientGroups.findFirst({ where: eq(patientGroups.id, groupId) });
  if (!group) notFound("err.patientGroupNotFound");

  const visible = await accessiblePatientIds(user);
  const memberRows = await db
    .select({
      userId: patientGroupMembers.patientId,
      addedAt: patientGroupMembers.addedAt,
      addedBy: patientGroupMembers.addedBy,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      email: users.email,
      unit: users.unit,
      sex: users.sex,
      birthDate: users.birthDate,
      /* телефон — как на кадре f14 (решение заказчика 2026-09-25); чтение состава журналируется */
      phoneEnc: users.phoneEnc,
    })
    .from(patientGroupMembers)
    .innerJoin(users, eq(users.id, patientGroupMembers.patientId))
    .where(eq(patientGroupMembers.groupId, groupId));

  const members: PatientGroupMember[] = memberRows
    .filter(membersVisibleTo(visible))
    .map((r) => ({
      userId: r.userId,
      fullName: fullNameOf(r),
      email: r.email,
      unit: r.unit,
      sex: r.sex,
      /* только год — различить тёзок; полная дата рождения в составе лишняя */
      birthYear: birthYearOf(decryptField(r.birthDate)),
      phone: decryptField(r.phoneEnc),
      addedAt: r.addedAt,
      addedBy: r.addedBy,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const surveyRows = await db
    .select({
      surveyId: patientGroupSurveys.surveyId,
      title: surveys.title,
      description: surveys.description,
      assignedAt: patientGroupSurveys.assignedAt,
      assignedBy: patientGroupSurveys.assignedBy,
      expiresAt: patientGroupSurveys.expiresAt,
      attemptsAllowed: patientGroupSurveys.attemptsAllowed,
      /*
       * Прошедшие считаются по людям, а не по прохождениям: «пять из
       * двенадцати сдали» и «сдали двенадцать раз» — разные ответы, и
       * специалисту нужен первый. Считается по нынешнему составу группы:
       * выбывший участник из знаменателя ушёл, и из числителя обязан уйти
       * тоже, иначе получится «сдали 7 из 5».
       */
      completedCount: sql<number>`(select count(distinct r.user_id)::int from responses r
        where r.survey_id = "patient_group_surveys"."survey_id"
          and r.status = 'completed'
          and r.user_id in (select m.patient_id from patient_group_members m
            where m.group_id = "patient_group_surveys"."group_id"))`,
    })
    .from(patientGroupSurveys)
    .innerJoin(surveys, eq(surveys.id, patientGroupSurveys.surveyId))
    .where(eq(patientGroupSurveys.groupId, groupId))
    .orderBy(asc(patientGroupSurveys.assignedAt));

  /*
   * Список методик группы НЕ сужается зоной видимости методик, в отличие от
   * состава. Это обратная выборка: здесь записано, что специалист однажды
   * назначил, и методика, с тех пор переехавшая в другое отделение или
   * снятая с использования, обязана остаться в записи. Спрятать её значило
   * бы оставить в карточках людей назначения, которым в группе нет
   * основания, — и объяснить их было бы нечем.
   */
  const groupSurveys: PatientGroupSurvey[] = surveyRows.map((r) => ({
    surveyId: r.surveyId,
    title: r.title,
    description: r.description ?? null,
    assignedAt: r.assignedAt,
    assignedBy: r.assignedBy,
    expiresAt: r.expiresAt,
    attemptsAllowed: r.attemptsAllowed,
    completedCount: Number(r.completedCount ?? 0),
  }));

  // чтение поимённого состава — доступ к персональным данным, фиксируем
  await audit(c, {
    action: "patient_group.read",
    resourceType: "patient_group",
    resourceId: groupId,
    details: { members: members.length, surveys: groupSurveys.length, phones: true },
  });

  const card: PatientGroupCard = {
    id: group.id,
    title: group.title,
    description: group.description,
    color: group.color,
    position: group.position,
    ownerId: group.ownerId,
    createdAt: group.createdAt,
    members,
    surveys: groupSurveys,
  };
  return c.json(card);
});

/**
 * Правка названия, описания, цвета и места вкладки.
 *
 * Владельца сменить нельзя — его нет во входной схеме, и это решение.
 * Передача списка коллеге выглядит безобидно, но означает, что человек
 * получает в работу перечень людей, которого не собирал, и отвечает за
 * назначения, которых не делал. Если передача понадобится, у неё будет свой
 * маршрут со своей записью в журнале, а не поле в общей правке.
 */
patientGroupRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const groupId = c.req.param("id");
  await assertPatientGroupAccess(user, groupId);

  const input = await parseBody(c.req.raw, patientGroupInputSchema.partial());
  const [row] = await db
    .update(patientGroups)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description ?? null }),
      ...(input.color !== undefined && { color: input.color ?? null }),
      ...(input.position !== undefined && { position: input.position }),
    })
    .where(eq(patientGroups.id, groupId))
    .returning();
  if (!row) notFound("err.patientGroupNotFound");

  await audit(c, {
    action: "patient_group.update",
    resourceType: "patient_group",
    resourceId: groupId,
  });
  return c.json(row);
});

/* ─────────── Пацієнти Групи ─────────── */

/**
 * «Додати пацієнта» — одного или списком (`userIds`; старая форма `userId`
 * принимается по-прежнему, см. схему).
 *
 * Две проверки, и ни одна не лишняя. `assertPatientGroupAccess` — группа
 * моя; зона видимости — каждый человек в моей зоне ответственности. Без
 * второй собственная группа стала бы способом узнать ФИО и почту кого
 * угодно по идентификатору: добавил — и получил его в составе. Ту же пару
 * условий повторяет политика строк (миграция 0078), потому что здесь правило
 * выражается в SQL без потерь.
 *
 * Список проверяется ЦЕЛИКОМ до первой записи: пять галочек и одна кнопка —
 * одно решение, и «троих добавил, на четвёртом отказал» оставило бы экран в
 * состоянии, которого человек не выбирал. Зона при этом считается один раз
 * на запрос, а не на каждого из списка.
 *
 * Повторное добавление — не ошибка, а «уже там». Специалист жмёт кнопку
 * второй раз не по невнимательности, а потому что не помнит, добавлял ли он
 * этого человека на прошлой неделе; отказ ответил бы ему не на тот вопрос.
 */
patientGroupRoutes.post("/:id/members", async (c) => {
  const user = c.get("user");
  const groupId = c.req.param("id");
  await assertPatientGroupAccess(user, groupId);

  const input = await parseBody(c.req.raw, patientGroupMemberSchema);
  const userIds = [...new Set([...(input.userIds ?? []), ...(input.userId ? [input.userId] : [])])];

  const visible = await accessiblePatientIds(user);
  for (const id of userIds) if (visible !== null && !visible.has(id)) notFound("err.userNotFound");

  const targets = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(inArray(users.id, userIds));
  const roleOf = new Map(targets.map((u) => [u.id, u.role]));
  for (const id of userIds) {
    const role = roleOf.get(id);
    if (!role) notFound("err.userNotFound");
    /*
     * В группу пациентов кладут пациентов. Сотрудник здесь означал бы, что
     * следующее назначение «на всю группу» выдаст методику ему — а методики
     * назначаются обследуемым, и поимённая выдача это уже проверяет.
     */
    if (role !== "user") badRequest("err.assignOnlyToPatient");
  }

  await db
    .insert(patientGroupMembers)
    .values(userIds.map((patientId) => ({ groupId, patientId, addedBy: user.id })))
    .onConflictDoNothing();

  // поимённо: у каждого человека должна остаться своя строка в журнале
  for (const userId of userIds) {
    await audit(c, {
      action: "patient_group.member_add",
      resourceType: "patient_group",
      resourceId: groupId,
      subjectUserId: userId,
    });
  }
  return c.json({ groupId, userIds }, 201);
});

/**
 * Убрать из группы списком — те же галочки, что и при добавлении.
 *
 * Выданные назначения остаются — см. поимённый DELETE ниже, правило одно.
 * Убираются те из списка, кто в группе есть; если не нашёлся никто —
 * «не найдено», как и у поимённого: пустой успех означал бы, что экран
 * показывал состав, которого в базе не было.
 */
patientGroupRoutes.delete("/:id/members", async (c) => {
  const user = c.get("user");
  const groupId = c.req.param("id");
  await assertPatientGroupAccess(user, groupId);

  const input = await parseBody(c.req.raw, patientGroupMembersRemoveSchema);
  const deleted = await db
    .delete(patientGroupMembers)
    .where(
      and(eq(patientGroupMembers.groupId, groupId), inArray(patientGroupMembers.patientId, input.userIds)),
    )
    .returning({ userId: patientGroupMembers.patientId });
  if (deleted.length === 0) notFound("err.patientGroupMemberNotFound");

  for (const { userId } of deleted) {
    await audit(c, {
      action: "patient_group.member_remove",
      resourceType: "patient_group",
      resourceId: groupId,
      subjectUserId: userId,
    });
  }
  return c.json({ groupId, removed: deleted.length });
});

/**
 * Убрать человека из группы.
 *
 * Выданные ему назначения при этом остаются. Это не недосмотр: методику ему
 * назначили по-настоящему, срок идёт, он мог её начать — и снятие вместе с
 * составом означало бы, что пациент теряет доступ посреди прохождения из-за
 * действия, о котором он не знает. Отобрать назначение можно там же, где его
 * выдают: DELETE /api/access/surveys/:id/grants/:userId.
 */
patientGroupRoutes.delete("/:id/members/:userId", async (c) => {
  const user = c.get("user");
  const groupId = c.req.param("id");
  const userId = c.req.param("userId");
  await assertPatientGroupAccess(user, groupId);

  const deleted = await db
    .delete(patientGroupMembers)
    .where(
      and(eq(patientGroupMembers.groupId, groupId), eq(patientGroupMembers.patientId, userId)),
    )
    .returning();
  if (deleted.length === 0) notFound("err.patientGroupMemberNotFound");

  await audit(c, {
    action: "patient_group.member_remove",
    resourceType: "patient_group",
    resourceId: groupId,
    subjectUserId: userId,
  });
  return c.body(null, 204);
});

/* ─────────── «Обрана» ─────────── */

/**
 * Закладка читателя на группу — вкладка, которую он держит первой.
 *
 * Закладка — свойство пары «читатель — группа», а не самой группы: почему
 * так — в миграции 0084. Ставится только на свою группу (у суперадмина —
 * на любую видимую): чужая отвечает «не найдено», иначе закладка по
 * идентификатору выдавала бы существование чужого личного списка.
 * Повторное «обрати» — не ошибка и не вторая строка, как и повторное
 * «додати пацієнта».
 */
patientGroupRoutes.put("/:id/favourite", async (c) => {
  const user = c.get("user");
  const groupId = c.req.param("id");
  await assertPatientGroupAccess(user, groupId);

  await db.insert(patientGroupFavourites).values({ userId: user.id, groupId }).onConflictDoNothing();
  await audit(c, { action: "patient_group.favourite", resourceType: "patient_group", resourceId: groupId });
  return c.json({ groupId, favourite: true });
});

patientGroupRoutes.delete("/:id/favourite", async (c) => {
  const user = c.get("user");
  const groupId = c.req.param("id");
  await assertPatientGroupAccess(user, groupId);

  await db
    .delete(patientGroupFavourites)
    .where(and(eq(patientGroupFavourites.userId, user.id), eq(patientGroupFavourites.groupId, groupId)));
  await audit(c, { action: "patient_group.unfavourite", resourceType: "patient_group", resourceId: groupId });
  return c.body(null, 204);
});

/* ─────────── Тести Групи ─────────── */

/**
 * Назначить методику НА ВСЮ ГРУППУ — кнопка «Призначити Пацієнту/Групі».
 *
 * ═══ Запрет, который здесь снят ═══
 *
 * В плане системы (раздел «Назначение методики: одному, со сроком и числом
 * попыток») массовое назначение было запрещено осознанно, дословно:
 * «массовое назначение превращает методику в рассылку и обесценивает её».
 * Довод настоящий: методика, пришедшая списком, читается человеком как
 * формальность, заполняется небрежно — и портит не только собственное
 * измерение, но и нормы, которые по этим ответам считаются.
 *
 * Запрет снят решением ЗАКАЗЧИКА: в макете, по которому переделывается
 * консоль, «Групи» — равноправный раздел меню рядом с «Пацієнти», у группы
 * есть свои «Тести Групи», а на экране методики стоит кнопка «Призначити
 * Пацієнту/Групі». Работа так и устроена: вечерняя группа из восьми человек
 * получает один и тот же опросник, и выдавать его восемью одинаковыми
 * действиями — не осторожность, а бессмыслица.
 *
 * ═══ Что из этого следует — и что здесь сделано, чтобы довод не пропал ═══
 *
 * 1. Групповое назначение разворачивается в ОБЫЧНЫЕ поимённые назначения,
 *    через тот же lib/grantAccess.ts, что и ручная выдача. Никакого второго
 *    вида доступа «по группе», который проверялся бы отдельно: у каждого
 *    человека своя строка в survey_access, свой срок, своё число попыток и
 *    свой счётчик израсходованных. Продлить одному, не трогая остальных,
 *    можно ровно так же, как если бы методику выдали адресно.
 * 2. В карте каждого человека видно, что методика пришла ЧЕРЕЗ ГРУППУ, а не
 *    адресно: `via_patient_group_id`. Разбирая через полгода, почему человек
 *    прошёл методику, которую ему лично никто не назначал, разбирающий
 *    получает ответ из данных, а не из догадки. Именно это условие и делает
 *    снятие запрета обратимым: если рассылка всё-таки начнётся, её видно
 *    будет одним запросом.
 * 3. Действие пишется в журнал одной записью с числом адресатов
 *    (`patient_group.assign`) — плюс поимённые. Без сводной записи массовая
 *    выдача растворилась бы среди обычных назначений и перестала бы
 *    отличаться от повседневной работы.
 * 4. Группа не становится каналом обхода доступа: методика обязана быть в
 *    зоне ответственности назначающего (`assertSurveyAccess`), а получают её
 *    только те участники, которые сейчас в его зоне видимости. Человек,
 *    выбывший из зоны, назначения не получает — иначе группа позволяла бы
 *    дотянуться до тех, кого сотруднику больше видеть не положено.
 *
 * Чего здесь НЕТ и не появится по этому решению: повторяющегося назначения
 * по расписанию. Второй запрет из того же абзаца плана заказчик не снимал, и
 * довод против него — «повторяющееся требует решать, что делать с
 * пропущенными, и тихо копит просрочку» — в силе.
 */
patientGroupRoutes.post(
  "/:id/surveys",
  requirePermission("assignments.manage"),
  async (c) => {
    const user = c.get("user");
    const groupId = c.req.param("id");
    await assertPatientGroupAccess(user, groupId);

    const input = await parseBody(c.req.raw, assignSurveyToPatientGroupSchema);
    await assertSurveyAccess(user, input.surveyId);
    await assertSurveysInUse([input.surveyId]);

    /*
     * Адресаты — нынешний состав, пересечённый с зоной видимости. Зона
     * считается один раз: она же нужна и для проверки, и для выборки.
     */
    const visible = await accessiblePatientIds(user);
    const memberRows = await db
      .select({ userId: patientGroupMembers.patientId })
      .from(patientGroupMembers)
      .where(eq(patientGroupMembers.groupId, groupId));
    const targets = memberRows.filter(membersVisibleTo(visible)).map((m) => m.userId);

    /*
     * Пустая группа — отказ, а не тихий успех. «Назначено» при нуле
     * адресатов специалист прочитает как сделанную работу и вернётся к
     * группе через две недели с вопросом, почему никто не сдал.
     */
    if (!targets.length) badRequest("err.patientGroupEmpty");

    await db.transaction(async (tx) => {
      /*
       * Запись о решении и его последствия — одной транзакцией. Иначе
       * возможна половина: методика значится в «Тести Групи», а назначений
       * нет (или наоборот), и обе половины выглядят рабочими по отдельности.
       */
      await tx
        .insert(patientGroupSurveys)
        .values({
          groupId,
          surveyId: input.surveyId,
          assignedBy: user.id,
          expiresAt: input.expiresAt ?? null,
          attemptsAllowed: input.attemptsAllowed,
        })
        .onConflictDoUpdate({
          target: [patientGroupSurveys.groupId, patientGroupSurveys.surveyId],
          /*
           * Повторное назначение той же методики группе — это НОВОЕ решение
           * с новыми условиями, а не «уже есть». Ровно та же логика, что и в
           * lib/grantAccess.ts: «ничего не делать при совпадении» оставило бы
           * группе прошлогодний срок, и повторный замер, ради которого всё и
           * затевалось, был бы невозможен.
           */
          set: {
            assignedBy: user.id,
            assignedAt: sql`now()`,
            expiresAt: input.expiresAt ?? null,
            attemptsAllowed: input.attemptsAllowed,
          },
        });

      await grantAccess(tx as never, targets.map((userId) => ({
        surveyId: input.surveyId,
        userId,
        grantedBy: user.id,
        expiresAt: input.expiresAt ?? null,
        note: input.note ?? null,
        attemptsAllowed: input.attemptsAllowed,
        viaPatientGroupId: groupId,
      })));
    });

    await audit(c, {
      action: "patient_group.assign",
      resourceType: "patient_group",
      resourceId: groupId,
      details: { surveyId: input.surveyId, recipients: targets.length },
    });
    /*
     * Поимённые записи — тем же именем, что и ручная выдача: иначе выборка
     * «что назначали этому человеку» по журналу давала бы неполный ответ в
     * зависимости от того, каким способом методику выдали.
     */
    for (const userId of targets) {
      await audit(c, {
        action: "access.grant",
        resourceType: "survey",
        resourceId: input.surveyId,
        subjectUserId: userId,
        details: { viaPatientGroupId: groupId, expiresAt: input.expiresAt ?? null },
      });
    }

    return c.json({ groupId, surveyId: input.surveyId, recipients: targets.length }, 201);
  },
);
