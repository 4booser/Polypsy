import { Hono } from "hono";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  instrumentCode,
  patientListQuery,
  patientNamesQuery,
  polarityOfBands,
  t,
  type PatientCard,
  type PatientCardConclusion,
  type PatientCardGroup,
  type PatientCardResponse,
  type PatientListCounts,
  type PatientListItem,
  type PatientListMeasure,
  type PatientListPage,
  type ScaleNormalization,
  type Severity,
  type Sex,
  type Lang,
} from "@quizzy/shared";
import { db } from "../db";
import {
  conclusions,
  patientGroupMembers,
  patientGroups,
  responses,
  responseScores,
  scaleBands,
  scales,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { bandLabelsIn } from "../lib/bandLabels";
import { fullNameOf } from "../lib/auth";
import { decryptField } from "../lib/crypto";
import { namesOf } from "../lib/names";
import { langOf, notFound, parseQuery } from "../lib/http";
import { birthYearOf } from "../lib/privacy";
import {
  accessibleGroupIds,
  accessiblePatientIds,
  assertPatientAccess,
  assertPatientGroupAccess,
  isSuperadmin,
  patientsInScope,
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
  const lang = langOf(c);
  const { q, patientGroup, lead, limit, offset, view, sort } = parseQuery(c, patientListQuery);
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

  /*
   * «Последняя сдача» — по методикам своей зоны, как и всё о прохождениях.
   * Прежде подвыборка брала любую методику учреждения: сотрудник видел дату
   * сдачи методики чужой группы — сведение о прохождении, которого ему не
   * показывают больше нигде. В бою дату резала политика responses, и один
   * и тот же человек в списке был «сдавал вчера» владельцем базы и «не
   * сдавал» ролью приложения (волна 13, обход всех GET под ролью).
   */
  const groupIds = await accessibleGroupIds(user);
  const ownSurvey =
    groupIds === null
      ? undefined
      : groupIds.length
        ? sql`(s.group_id in ${groupIds} or (s.group_id is null and s.created_by = ${user.id}))`
        : sql`(s.group_id is null and s.created_by = ${user.id})`;
  const lastResponse = ownSurvey
    ? sql<string | null>`(select max(r.submitted_at) from responses r join surveys s on s.id = r.survey_id
        where r.user_id = "users"."id" and r.status = 'completed' and ${ownSurvey})`
    : sql<string | null>`(select max(r.submitted_at) from responses r
        where r.user_id = "users"."id" and r.status = 'completed')`;

  /*
   * Открытые случаи — по методикам зоны читателя, тем же условием, что
   * «последняя сдача»: случай по чужой методике — сведение о прохождении,
   * которого ему не показывают нигде больше. Под ролью приложения то же
   * режет и политика alert_cases. Первым — самый тяжёлый из самых давних:
   * его и разбирать первым; count() over () — сколько их всего.
   */
  const openCaseSql = sql<{ n: number; id: string; at: string; severity: string; assignedTo: string | null } | null>`(
    select json_build_object('n', count(*) over (), 'id', ac.id, 'at', ac.opened_at,
      'severity', ac.severity, 'assignedTo', ac.assigned_to)
    from alert_cases ac join surveys s on s.id = ac.survey_id
    where ac.user_id = "users"."id" and ac.acknowledged_at is null ${ownSurvey ? sql`and ${ownSurvey}` : sql``}
    order by (ac.severity = 'severe') desc, ac.opened_at asc
    limit 1)`;
  /* ближайший записанный приём — только будущий и не отменённый */
  const nextVisitSql = sql<{ at: string; mode: "onsite" | "remote" } | null>`(
    select json_build_object('at', sl.starts_at, 'mode', a.mode)
    from appointments a join slots sl on sl.id = a.slot_id
    where a.patient_id = "users"."id" and a.status in ('booked', 'confirmed') and sl.starts_at >= now()
    order by sl.starts_at asc
    limit 1)`;
  /* неявка — за последние 30 дней: давняя неявка — история, а не повод сейчас */
  const lastNoShowSql = sql<string | null>`(
    select max(sl.starts_at)
    from appointments a join slots sl on sl.id = a.slot_id
    where a.patient_id = "users"."id" and a.status = 'no_show' and sl.starts_at > now() - interval '30 days')`;
  const dispensarySql = sql<{ group: string; due: string } | null>`(
    select json_build_object('group', d.group_label, 'due', d.next_due_at)
    from dispensary d
    where d.patient_id = "users"."id" and d.removed_at is null)`;

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
            lastResponseAt: lastResponse,
            /*
             * Реестр 2.0: почему человек в списке сейчас — подвыборками той
             * же строки, а не запросами за каждым: реестр читается на каждую
             * букву поиска, а подання и порядок «ризик спершу» нужны по ВСЕМ
             * найденным, не только по странице.
             */
            openCase: openCaseSql,
            nextVisit: nextVisitSql,
            lastNoShowAt: lastNoShowSql,
            dispensary: dispensarySql,
          })
          .from(users)
          .where(
            and(
              eq(users.role, "user"),
              ids ? inArray(users.id, ids) : undefined,
              /* «пацієнти цього фахівця» сужают зону, а не расширяют её: пересечение остаётся */
              lead ? eq(users.leadSpecialistId, lead) : undefined,
            ),
          );

  const now = Date.now();
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
      risk: r.openCase
        ? {
            cases: Number(r.openCase.n),
            caseId: r.openCase.id,
            openedAt: iso(r.openCase.at),
            severity: r.openCase.severity === "moderate" ? "moderate" : "severe",
            /* пока идентификатор: имя — ниже, только для строк страницы */
            assigneeName: r.openCase.assignedTo,
          }
        : null,
      nextVisit: r.nextVisit ? { at: iso(r.nextVisit.at), mode: r.nextVisit.mode } : null,
      lastNoShowAt: r.lastNoShowAt ? iso(r.lastNoShowAt) : null,
      dispensary: r.dispensary
        ? {
            groupLabel: r.dispensary.group,
            nextDueAt: iso(r.dispensary.due),
            overdue: Date.parse(r.dispensary.due) < now,
          }
        : null,
    }),
  );
  const found = (q ? named.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(q)) : named).sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  /*
   * Подання «Потребує уваги» и их счётчики — по найденному поиском и
   * вкладкой, до выбора подання: пилюля говорит, сколько людей окажется в
   * списке, если её нажать.
   */
  const staleBefore = now - STALE_DAYS * 86_400_000;
  const inView: Record<NonNullable<typeof view>, (p: PatientListItem) => boolean> = {
    mine: (p) => p.leadSpecialistId === user.id,
    risk: (p) => !!p.risk,
    stale: (p) => !p.lastResponseAt || Date.parse(p.lastResponseAt) < staleBefore,
    unbooked: (p) => !p.nextVisit,
  };
  const counts: PatientListCounts = {
    all: found.length,
    mine: found.filter(inView.mine).length,
    risk: found.filter(inView.risk).length,
    stale: found.filter(inView.stale).length,
    unbooked: found.filter(inView.unbooked).length,
  };
  const matched = view ? found.filter(inView[view]) : found;
  if (sort && sort !== "name") matched.sort(ORDER[sort]);

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
      ...(lead ? { leadSpecialistId: lead } : {}),
    },
  });

  const items = matched.slice(offset, offset + limit);
  /*
   * Имена ведущих и взявших случай, главная шкала последнего замера — только
   * для строк страницы: это расшифровка и баллы, и считать их ради людей,
   * которых на экране нет, незачем.
   */
  const names = await namesOf(items.flatMap((p) => [p.leadSpecialistId, p.risk?.assigneeName]));
  const measures = await measuresOf(
    items.map((p) => p.id),
    ownSurvey,
    lang,
  );
  for (const p of items) {
    p.leadName = p.leadSpecialistId ? (names.get(p.leadSpecialistId) ?? null) : null;
    if (p.risk) p.risk.assigneeName = p.risk.assigneeName ? (names.get(p.risk.assigneeName) ?? null) : null;
    p.measure = measures.get(p.id) ?? null;
  }

  const page: PatientListPage = { items, total: matched.length, counts };
  return c.json(page);
});

/** «Без заміру 30+ днів» */
const STALE_DAYS = 30;

const iso = (v: string) => new Date(v).toISOString();

/**
 * Порядки реестра. «Ризик спершу»: открытый случай (тяжёлый, потом давний),
 * неявка за месяц, просроченный контрольный осмотр, остальные — по ПІБ.
 * Пустое (нет замера, нет приёма) — в конце при любом порядке.
 */
const ORDER: Record<"risk" | "last" | "next", (a: PatientListItem, b: PatientListItem) => number> = {
  risk: (a, b) => {
    const rank = (p: PatientListItem) =>
      p.risk ? (p.risk.severity === "severe" ? 0 : 1) : p.lastNoShowAt ? 2 : p.dispensary?.overdue ? 3 : 4;
    return (
      rank(a) - rank(b) ||
      (a.risk && b.risk ? a.risk.openedAt.localeCompare(b.risk.openedAt) : 0) ||
      a.name.localeCompare(b.name)
    );
  },
  last: (a, b) =>
    a.lastResponseAt === b.lastResponseAt
      ? a.name.localeCompare(b.name)
      : !a.lastResponseAt
        ? 1
        : !b.lastResponseAt
          ? -1
          : b.lastResponseAt.localeCompare(a.lastResponseAt),
  next: (a, b) =>
    (a.nextVisit?.at ?? "") === (b.nextVisit?.at ?? "")
      ? a.name.localeCompare(b.name)
      : !a.nextVisit
        ? 1
        : !b.nextVisit
          ? -1
          : a.nextVisit.at.localeCompare(b.nextVisit.at),
};

/**
 * Главная шкала последнего замера по каждому человеку страницы и её ход.
 *
 * «Последний замер» — свежайшее из двенадцати последних прохождений по
 * методикам зоны читателя, у которого ровно одна клиническая шкала с
 * полосой тяжести (скрининг); нет такого — свежайшее с любой полосой; нет и
 * его — свежайшее вообще (личностный опросник без полос о состоянии не
 * говорит, но лучше он, чем пустая ячейка). Главная шкала — первая по
 * порядку методики среди клинических с полосой. Ход — до трёх последних
 * значений этой шкалы той же методики.
 */
async function measuresOf(
  userIds: string[],
  ownSurvey: SQL | undefined,
  lang: Lang,
): Promise<Map<string, PatientListMeasure>> {
  const out = new Map<string, PatientListMeasure>();
  if (!userIds.length) return out;
  const rows = await db.execute<{
    user_id: string;
    response_id: string;
    survey_id: string;
    survey_title: unknown;
    submitted_at: string;
    scale_id: string;
    code: string;
    position: number;
    kind: string;
    value: number;
    severity: string | null;
    band_label: string | null;
    normalization: string;
  }>(sql`
    with recent as (
      select r.id, r.user_id, r.survey_id, r.submitted_at,
        row_number() over (partition by r.user_id order by r.submitted_at desc) as rn
      from responses r join surveys s on s.id = r.survey_id
      where r.user_id in ${userIds} and r.status = 'completed' and r.submitted_at is not null
        ${ownSurvey ? sql`and ${ownSurvey}` : sql``}
    )
    select rc.user_id, rc.id as response_id, rc.survey_id, sv.title as survey_title, rc.submitted_at,
      sc.id as scale_id, sc.code, sc.position, sc.kind, rs.value, rs.severity, rs.band_label,
      rs.normalization
    from recent rc
      join surveys sv on sv.id = rc.survey_id
      join response_scores rs on rs.response_id = rc.id
      join scales sc on sc.id = rs.scale_id
    where rc.rn <= 12
    order by rc.user_id, rc.submitted_at asc, sc.position asc`);

  type Row = (typeof rows)[number];
  const byUser = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(r);
    byUser.set(r.user_id, list);
  }

  const picks = new Map<string, { main: Row; values: number[] }>();
  for (const [userId, list] of byUser) {
    const newest = [...new Set(list.map((r) => r.response_id))].reverse();
    const clinical = (responseId: string) => list.filter((r) => r.response_id === responseId && r.kind === "clinical");
    const banded = (responseId: string) => clinical(responseId).filter((r) => r.severity !== null);
    /*
     * Скрининг с одним итогом (PHQ-9, GAD-7, PCL-5) говорит о состоянии
     * одним числом — он и стоит в строке. Профиль из десятка шкал (Міні-мульт)
     * одним числом не пересказать: первая его шкала в строке выдала бы
     * случайное за главное. Он — только если скрининга не было.
     */
    const chosen =
      newest.map((id) => banded(id)).find((b) => b.length === 1)?.[0] ??
      newest.map((id) => banded(id)[0]).find((m) => m !== undefined) ??
      (newest[0] ? clinical(newest[0])[0] : undefined);
    if (!chosen) continue;
    const series = list.filter(
      (r) => r.survey_id === chosen.survey_id && r.code === chosen.code && String(r.submitted_at) <= String(chosen.submitted_at),
    );
    picks.set(userId, {
      main: chosen,
      values: series.slice(-3).map((r) => Math.round(Number(r.value) * 10) / 10),
    });
  }

  const scaleIds = [...new Set([...picks.values()].map((p) => p.main.scale_id))];
  const bandRows = scaleIds.length
    ? await db
        .select({
          scaleId: scaleBands.scaleId,
          minScore: scaleBands.minScore,
          maxScore: scaleBands.maxScore,
          severity: scaleBands.severity,
        })
        .from(scaleBands)
        .where(inArray(scaleBands.scaleId, scaleIds))
    : [];
  const betterOf = new Map<string, "down" | "up" | null>();
  for (const id of scaleIds) {
    const higherWorse = polarityOfBands(bandRows.filter((b) => b.scaleId === id));
    betterOf.set(id, higherWorse === null ? null : higherWorse ? "down" : "up");
  }

  // слово полосы — на языке читателя, а не на языке прохождения (lib/bandLabels.ts)
  const bandIn = await bandLabelsIn(lang, scaleIds);
  for (const [userId, { main, values }] of picks) {
    const title = t(main.survey_title as never, lang);
    out.set(userId, {
      surveyId: main.survey_id,
      /* нет кода в названии — само название: код шкалы («F», «sleep») о методике не говорит */
      code: instrumentCode(title, title),
      title,
      values,
      at: iso(String(main.submitted_at)),
      severity: (main.severity as PatientListMeasure["severity"]) ?? null,
      bandLabel: bandIn(main.scale_id, main.band_label),
      normalization: main.normalization as ScaleNormalization,
      better: betterOf.get(main.scale_id) ?? null,
    });
  }
  return out;
}

/**
 * Имена людей зоны по идентификаторам — без карточки (волна 27).
 *
 * Поле «Пацієнт» в условиях выборки статистики (pages/statistics/parts.tsx)
 * показывает имя человека из сохранённого фильтра — и ради одного имени
 * читало карточку: «Тести», «Групи», «Заключення», телефон и строку
 * patient.card_read на каждую выборку с таким фильтром при каждом
 * открытии страницы. Журнал говорил «открывал карточку» о том, кто карточку
 * не открывал.
 *
 * Здесь — только имя, и по тому же правилу, что у выбора пациента
 * (GET /api/access/patients, PatientPicker): чтение имён людей пишется
 * в журнал как access.patient_list. Зона — та же, что у карточки и у
 * проверки фильтра выборки (patientsInScope, assertFilterRefs): человек вне
 * зоны и не пациент в ответ не попадают вовсе — не «нет такого», а нет
 * строки, как у списка.
 */
patientRoutes.get("/names", async (c) => {
  const user = c.get("user");
  const { ids } = parseQuery(c, patientNamesQuery);
  const visible = await patientsInScope(user, ids);
  const asked = visible === null ? ids : ids.filter((id) => visible.has(id));
  const rows = asked.length
    ? await db
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          middleName: users.middleName,
          anonymous: users.anonymous,
          pseudonym: users.pseudonym,
        })
        .from(users)
        .where(and(inArray(users.id, asked), eq(users.role, "user")))
    : [];
  const items = rows.map((r) => ({ id: r.id, fullName: fullNameOf(r) }));
  await audit(c, {
    action: "access.patient_list",
    details: { returned: items.length, asked: ids.length, via: "names" },
  });
  return c.json({ items });
});

/**
 * Карточка пациента: персональные данные, «Тести», «Групи», «Заключення» и
 * ведущий — одним ответом, как их показывает кадр f19.
 *
 * Один маршрут вместо четырёх: экран всё равно открывает их вместе, а
 * разложенные по эндпоинтам они означали бы четыре проверки зоны вместо
 * одной — и четыре места, где её можно забыть. Зона спрашивается дважды и
 * только о названных людях (patientsInScope, #181): о самом человеке и о
 * составе его групп для счётчиков. Всю зону ради одной карточки не строим —
 * на учреждении в пять тысяч пациентов это секунды на каждое открытие.
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
  await assertPatientAccess(user, patientId);

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
  const bandIn = await bandLabelsIn(lang, scoreRows.map((r) => r.score.scaleId));
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
      bandLabel: bandIn(score.scaleId, score.bandLabel),
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
  const visible = memberRows.length ? await patientsInScope(user, memberRows.map((m) => m.userId)) : null;
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
