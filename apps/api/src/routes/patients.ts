import { Hono } from "hono";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  patientListQuery,
  t,
  type PatientCard,
  type PatientCardConclusion,
  type PatientCardGroup,
  type PatientCardResponse,
  type PatientListItem,
  type PatientListPage,
  type ScaleNormalization,
  type Severity,
  type Sex,
} from "@quizzy/shared";
import { db } from "../db";
import {
  conclusions,
  patientGroupMembers,
  patientGroups,
  responses,
  responseScores,
  scales,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField } from "../lib/crypto";
import { langOf, notFound, parseQuery } from "../lib/http";
import { birthYearOf } from "../lib/privacy";
import {
  accessiblePatientIds,
  assertPatientGroupAccess,
  isSuperadmin,
  surveyScopeFilterFor,
} from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Пациенты зоны видимости и карточка пациента (кадр f19).
 *
 * До этого раздел «Пацієнти» собирался из двух чужих маршрутов, и оба
 * отвечали не на тот вопрос: /api/dynamics/respondents — «кто проходил
 * методики повторно» (обследованные, без вкладки группы), /api/access/patients
 * — «кому можно назначить» (закрыт assignments.manage, то есть правом
 * назначать, а не видеть; без страниц, обрезан сотней). Раздел макета — про
 * всех, кого сотрудник вправе видеть, включая записанного на приём и ещё
 * ничего не прошедшего.
 *
 * Весь набор — под patients.read, как группы пациентов: всё, что здесь
 * показывается, — люди, их имена и подразделения. Зона видимости — из
 * lib/scope.ts, и считается один раз на запрос.
 */
export const patientRoutes = new Hono<AppEnv>();

patientRoutes.use("*", requireAuth, requireStaff, requirePermission("patients.read"));

/**
 * Список: поиск, вкладка группы, страницы `{items, total}`.
 *
 * Постраничность offset-ная и считается в приложении после расшифровки — по
 * той же причине, что у /api/access/patients: ФИО шифровано, упорядочить и
 * найти его в SQL нечем, а открытая копия имени ради удобного запроса
 * обменяла бы защиту персональных данных на пагинацию. Зона сотрудника —
 * сотни человек, не сотни тысяч; расшифровать их дешевле, чем хранить имя
 * открыто.
 *
 * Вкладка группы сужает, а не расширяет: пересечение с зоной остаётся.
 * Чужая группа в параметре — «не найдено» (assertPatientGroupAccess), а не
 * пустой список: пустой список подтверждал бы, что группа с таким
 * идентификатором есть.
 *
 * Телефон в строке есть — как на кадре f05, по решению заказчика
 * (2026-09-25). Прежде он открывался только отдельным действием
 * (GET /api/clinic/patients/:userId/phone); теперь чтение списка само
 * журналируется с пометкой `phones`, и вопрос «кто видел номера» по-прежнему
 * отвечается журналом.
 */
patientRoutes.get("/", async (c) => {
  const user = c.get("user");
  const { q, patientGroup, limit, offset } = parseQuery(c, patientListQuery);
  const visible = await accessiblePatientIds(user);

  let ids: string[] | null = visible === null ? null : [...visible];
  if (patientGroup) {
    await assertPatientGroupAccess(user, patientGroup);
    const members = await db
      .select({ id: patientGroupMembers.patientId })
      .from(patientGroupMembers)
      .where(eq(patientGroupMembers.groupId, patientGroup));
    const inGroup = new Set(members.map((m) => m.id));
    ids = (ids ?? [...inGroup]).filter((id) => inGroup.has(id));
  }

  const rows =
    ids !== null && !ids.length
      ? []
      : await db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            middleName: users.middleName,
            anonymous: users.anonymous,
            pseudonym: users.pseudonym,
            email: users.email,
            unit: users.unit,
            sex: users.sex,
            birthDate: users.birthDate,
            phoneEnc: users.phoneEnc,
            leadSpecialistId: users.leadSpecialistId,
            /*
             * Последняя сдача — одной подвыборкой, а не вторым запросом за
             * теми же людьми: список читается на каждое открытие раздела и
             * на каждую букву поиска.
             */
            lastResponseAt: sql<string | null>`(select max(r.submitted_at) from responses r
              where r.user_id = "users"."id" and r.status = 'completed')`,
          })
          .from(users)
          .where(and(eq(users.role, "user"), ids ? inArray(users.id, ids) : undefined));

  const named = rows.map(
    (r): PatientListItem => ({
      id: r.id,
      name: fullNameOf(r),
      email: r.email,
      unit: r.unit,
      sex: (r.sex as Sex | null) ?? null,
      /* только год: полная дата рождения в списке — лишнее раскрытие */
      birthYear: birthYearOf(decryptField(r.birthDate)),
      phone: decryptField(r.phoneEnc),
      leadSpecialistId: r.leadSpecialistId ?? null,
      lastResponseAt: r.lastResponseAt ? new Date(r.lastResponseAt).toISOString() : null,
    }),
  );
  const matched = (q ? named.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(q)) : named).sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  // чтение списка людей — доступ к персональным данным; имя действия то же,
  // что у прежнего списка: журнал отвечает на вопрос «кто листал пациентов»
  // одной выборкой, каким бы маршрутом ни листали
  await audit(c, {
    action: "access.patient_list",
    details: {
      matched: matched.length,
      returned: Math.min(limit, Math.max(0, matched.length - offset)),
      scoped: visible !== null,
      phones: true,
      ...(patientGroup ? { patientGroupId: patientGroup } : {}),
    },
  });

  const page: PatientListPage = { items: matched.slice(offset, offset + limit), total: matched.length };
  return c.json(page);
});

/**
 * Карточка пациента: персональные данные, «Тести», «Групи», «Заключення» и
 * ведущий — одним ответом, как их показывает кадр f19.
 *
 * Один маршрут вместо четырёх: экран всё равно открывает их вместе, а
 * разложенные по эндпоинтам они означали бы четыре проверки зоны вместо
 * одной — и четыре места, где её можно забыть. Зона считается один раз и
 * используется трижды: для самого человека, для состава его групп и для
 * счётчиков.
 *
 * «Тести» — все сданные прохождения по методикам в зоне ответственности
 * читателя (surveyScopeFilterFor — с разбитым стеклом, если оно разбито
 * ради этого человека). Не все прохождения вообще: карточка ведёт на
 * просмотр прохождения, а тот отвечает 403 на методику вне зоны, и ссылка в
 * пустоту хуже, чем строка, которой нет. Снятые с использования методики
 * остаются: это обратная выборка, клиническая история не должна получать
 * дыр от того, что методику сняли.
 *
 * «Групи» — группы ЧИТАТЕЛЯ, в которых человек состоит: группа пациентов —
 * личный список одного специалиста (см. lib/scope.ts), и чужая группа в
 * карточке выдала бы, что коллега завёл «групу ризику» с этим человеком.
 *
 * «Заключення» — подписанные любого автора (это документы) и черновики
 * только СВОИ: чужой черновик — недописанная мысль коллеги, а не документ.
 *
 * Телефона нет — см. список выше.
 */
patientRoutes.get("/:id/card", async (c) => {
  const user = c.get("user");
  const lang = langOf(c);
  const patientId = c.req.param("id");

  /*
   * Зона — до всего остального, и «не найдено», а не «нельзя»: 403 подтвердил
   * бы, что человек с таким идентификатором в системе есть.
   */
  const visible = await accessiblePatientIds(user);
  if (visible !== null && !visible.has(patientId)) notFound("err.userNotFound");

  const person = await db.query.users.findFirst({ where: eq(users.id, patientId) });
  if (!person || person.role !== "user") notFound("err.userNotFound");

  /* ── Тести ── */
  const scope = await surveyScopeFilterFor(user, patientId);
  const scoped = await db.select({ id: surveys.id, title: surveys.title }).from(surveys).where(scope);
  const titleOf = new Map(scoped.map((s) => [s.id, t(s.title as never, lang)]));

  const responseRows = titleOf.size
    ? await db
        .select()
        .from(responses)
        .where(
          and(
            eq(responses.userId, patientId),
            eq(responses.status, "completed"),
            inArray(responses.surveyId, [...titleOf.keys()]),
          ),
        )
        .orderBy(desc(responses.submittedAt))
    : [];
  const responseIds = responseRows.map((r) => r.id);

  const scoreRows = responseIds.length
    ? await db
        .select({ score: responseScores, scale: scales })
        .from(responseScores)
        .innerJoin(scales, eq(scales.id, responseScores.scaleId))
        .where(inArray(responseScores.responseId, responseIds))
        .orderBy(asc(scales.position))
    : [];
  const scoresByResponse = new Map<string, PatientCardResponse["scales"]>();
  for (const { score, scale } of scoreRows) {
    /*
     * Только содержательные шкалы: вердикт шкал достоверности уже сложен в
     * `reliable`, а их баллы рядом с клиническими читались бы как ещё один
     * результат.
     */
    if (scale.kind !== "clinical") continue;
    const list = scoresByResponse.get(score.responseId) ?? [];
    list.push({
      code: scale.code,
      title: t(scale.title as never, lang),
      value: score.value,
      normalization: score.normalization as ScaleNormalization,
      percent: score.percent,
      bandLabel: score.bandLabel,
      severity: (score.severity as Severity | null) ?? null,
    });
    scoresByResponse.set(score.responseId, list);
  }
  const cardResponses: PatientCardResponse[] = responseRows.map((r) => ({
    responseId: r.id,
    surveyId: r.surveyId,
    surveyTitle: titleOf.get(r.surveyId) ?? "—",
    submittedAt: r.submittedAt,
    reliable: r.reliable,
    scales: scoresByResponse.get(r.id) ?? [],
  }));

  /* ── Групи ── */
  const groupRows = await db
    .select({
      group: patientGroups,
      surveyCount: sql<number>`(select count(*)::int from patient_group_surveys pgs
        where pgs.group_id = "patient_groups"."id")`,
    })
    .from(patientGroupMembers)
    .innerJoin(patientGroups, eq(patientGroups.id, patientGroupMembers.groupId))
    .where(
      and(
        eq(patientGroupMembers.patientId, patientId),
        isSuperadmin(user) ? undefined : eq(patientGroups.ownerId, user.id),
      ),
    )
    .orderBy(asc(patientGroups.position), asc(patientGroups.createdAt));

  // состав всех его групп одним запросом — счётчик считается по зоне, как на вкладке
  const memberRows = groupRows.length
    ? await db
        .select({ groupId: patientGroupMembers.groupId, userId: patientGroupMembers.patientId })
        .from(patientGroupMembers)
        .where(inArray(patientGroupMembers.groupId, groupRows.map((g) => g.group.id)))
    : [];
  const memberCounts = new Map<string, number>();
  for (const m of memberRows) {
    if (visible !== null && !visible.has(m.userId)) continue;
    memberCounts.set(m.groupId, (memberCounts.get(m.groupId) ?? 0) + 1);
  }
  const groups: PatientCardGroup[] = groupRows.map((g) => ({
    id: g.group.id,
    title: g.group.title,
    description: g.group.description,
    color: g.group.color,
    memberCount: memberCounts.get(g.group.id) ?? 0,
    surveyCount: Number(g.surveyCount ?? 0),
  }));

  /* ── Заключення ── */
  const conclusionRows = responseIds.length
    ? await db
        .select({ row: conclusions, author: users })
        .from(conclusions)
        .leftJoin(users, eq(users.id, conclusions.createdBy))
        .where(
          and(
            inArray(conclusions.responseId, responseIds),
            or(eq(conclusions.status, "signed"), eq(conclusions.createdBy, user.id)),
          ),
        )
        .orderBy(desc(conclusions.version))
    : [];
  /*
   * По каждому прохождению — последняя подписанная версия и, если поверх неё
   * начат свой черновик, он. Две подписанные версии одного заключения на
   * карточке — верный способ, чтобы читали ту, что сверху, а не ту, что
   * верна; черновик ниже подписанной — устаревшая мысль, а не документ.
   */
  const latestSigned = new Map<string, (typeof conclusionRows)[number]>();
  const ownDraft = new Map<string, (typeof conclusionRows)[number]>();
  for (const r of conclusionRows) {
    if (r.row.status === "signed") {
      if (!latestSigned.has(r.row.responseId)) latestSigned.set(r.row.responseId, r);
    } else if (!ownDraft.has(r.row.responseId)) ownDraft.set(r.row.responseId, r);
  }
  const bySubmitted = new Map(responseRows.map((r) => [r.id, r]));
  const cardConclusions: PatientCardConclusion[] = [...latestSigned.values(), ...ownDraft.values()]
    .filter(
      (r) =>
        r.row.status === "signed" ||
        r.row.version > (latestSigned.get(r.row.responseId)?.row.version ?? 0),
    )
    .map((r) => {
      const response = bySubmitted.get(r.row.responseId);
      return {
        id: r.row.id,
        responseId: r.row.responseId,
        surveyId: response?.surveyId ?? "",
        surveyTitle: titleOf.get(response?.surveyId ?? "") ?? "—",
        version: r.row.version,
        status: r.row.status,
        text: decryptField(r.row.text) ?? "",
        createdAt: r.row.createdAt,
        signedAt: r.row.signedAt,
        authorName: r.author ? fullNameOf(r.author) : "—",
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  /* ── ведущий ── */
  const leadRow = person.leadSpecialistId
    ? await db.query.users.findFirst({ where: eq(users.id, person.leadSpecialistId) })
    : null;

  // открытие карточки — чтение персональных данных, как открытие карты
  await audit(c, {
    action: "patient.card_read",
    resourceType: "user",
    resourceId: patientId,
    subjectUserId: patientId,
    details: {
      responses: cardResponses.length,
      groups: groups.length,
      conclusions: cardConclusions.length,
      phone: person.phoneEnc !== null,
    },
  });

  const card: PatientCard = {
    id: person.id,
    firstName: person.anonymous ? "" : (decryptField(person.firstName) ?? ""),
    lastName: person.anonymous ? "" : (decryptField(person.lastName) ?? ""),
    middleName: person.anonymous ? null : decryptField(person.middleName),
    fullName: fullNameOf(person),
    anonymous: person.anonymous,
    pseudonym: person.pseudonym,
    email: person.email,
    sex: (person.sex as Sex | null) ?? null,
    birthDate: decryptField(person.birthDate),
    phone: decryptField(person.phoneEnc),
    unit: person.unit,
    position: person.position,
    specialty: person.specialty,
    rank: person.rank,
    createdAt: person.createdAt,
    lead: leadRow
      ? { specialistId: leadRow.id, name: fullNameOf(leadRow), mine: leadRow.id === user.id }
      : null,
    responses: cardResponses,
    groups,
    conclusions: cardConclusions,
  };
  return c.json(card);
});
