import { Hono } from "hono";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { t, type WorkKind } from "@quizzy/shared";
import { db } from "../db";
import { currentCrisis } from "../lib/crisis";
import {
  alertCases,
  appointments,
  batteries,
  batteryAssignments,
  pathwayInstances,
  pathwayProgress,
  pathways,
  pathwaySteps,
  referrals,
  slots,
  treatmentGoals,
  surveyAccess,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { recentAlertPatients } from "../lib/noShow";
import { accessiblePatientIds, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Что от меня ждут сегодня.
 *
 * Входящее рассыпано по трём экранам: случаи риска, незакрытые назначения,
 * открытые направления. Дежурный, чтобы понять объём работы, обходит их по
 * очереди и держит картину в голове — а держать её в голове он не обязан.
 *
 * Здесь всё в одном списке, отсортированном по срочности. Не подмена тех
 * экранов: там разбирают, здесь видят, за что взяться.
 */
export const worklistRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 */
worklistRoutes.use("*", requireAuth, requireStaff, requirePermission("patients.read"));

/** Список видов один на сервер и консоль — см. WorkKind */
type Kind = WorkKind;

interface Item {
  kind: Kind;
  id: string;
  userId: string;
  userName: string;
  unit: string | null;
  title: string;
  /*
   * Подробности структурой, а не готовой строкой.
   *
   * Сервер собирал «Срочно · сигналов 3» текстом — и такую строку клиент не
   * может ни перевести, ни переформатировать. Отображение принадлежит
   * клиенту; сервер отдаёт факты.
   */
  severity?: "moderate" | "severe";
  signals?: number;
  /** Сколько дней просрочки или без движения */
  days?: number;
  /** Куда направлен — для направлений */
  destination?: string;
  /** Просрочено по своему правилу: у случая — эскалация, у назначения — срок */
  overdue: boolean;
  /** Кому назначено; null — никому */
  assignedTo: string | null;
  since: string;
  /** Куда вести по нажатию */
  href: string;
}

/*
 * Порядок один на все виды работы: сначала просроченное, потом тяжёлое,
 * потом по давности. Без общего правила список превратился бы в три списка,
 * склеенных подряд, — то есть в то же самое, от чего уходим.
 */
const KIND_WEIGHT: Record<Kind, number> = {
  case: 0,
  /*
   * Неявка идёт сразу за случаем риска, а не в конце.
   *
   * Соблазн положить её к остальному велик: формально это всего лишь
   * несостоявшаяся встреча. Но в психологическом отделе переставший
   * приходить — это чаще ухудшение, чем потеря интереса, и чем позже это
   * заметят, тем меньше от этого пользы.
   */
  noshow: 1,
  pathway: 2,
  goal: 3,
  followup: 4,
  referral: 5,
  assignment: 6,
};

worklistRoutes.get("/", async (c) => {
  const user = c.get("user");
  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);

  const items: Item[] = [];
  const now = Date.now();

  if (surveyIds.length) {
    // 1. Случаи риска — самое срочное по определению
    const caseRows = await db
      .select({
        c: alertCases,
        surveyTitle: surveys.title,
        escalate: surveys.alertEscalateMinutes,
        unit: users.unit,
        firstName: users.firstName,
        lastName: users.lastName,
        middleName: users.middleName,
        anonymous: users.anonymous,
        pseudonym: users.pseudonym,
        signals: sql<number>`(select count(*)::int from risk_alerts ra where ra.case_id = ${alertCases.id})`,
      })
      .from(alertCases)
      .innerJoin(surveys, eq(surveys.id, alertCases.surveyId))
      .innerJoin(users, eq(users.id, alertCases.userId))
      .where(and(inArray(alertCases.surveyId, surveyIds), isNull(alertCases.acknowledgedAt)))
      .limit(300);

    for (const r of caseRows) {
      const minutes = Math.round((now - new Date(r.c.openedAt).getTime()) / 60_000);
      items.push({
        kind: "case",
        id: r.c.id,
        userId: r.c.userId,
        userName: fullNameOf(r as never),
        unit: r.unit,
        title: t(r.surveyTitle as never),
        severity: r.c.severity,
        signals: Number(r.signals),
        overdue: r.escalate !== null && minutes >= r.escalate,
        assignedTo: r.c.assignedTo,
        since: r.c.openedAt,
        href: `/alerts?q=${encodeURIComponent(fullNameOf(r as never))}`,
      });
    }
  }

  /*
   * 2. Неявки.
   *
   * Свои, а не всего отделения: приём — это отношение между двумя людьми, и
   * звонить не пришедшему должен тот, к кому он не пришёл. Отсюда же и
   * область: фильтр по методикам групп здесь ни при чём, приём с методиками
   * не связан вовсе.
   *
   * Берутся только неразобранные — те, где после неявки ничего не сделали:
   * не перезаписали и не отметили, что человек всё-таки был.
   */
  const noShowRows = await db
    .select({
      a: appointments,
      slot: slots,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
      unit: users.unit,
      /* сколько раз подряд не приходил: «второй раз подряд» — другой разговор */
      streak: sql<number>`(
        select count(*)::int from appointments prev
        join slots ps on ps.id = prev.slot_id
        where prev.patient_id = ${appointments.patientId}
          and prev.specialist_id = ${appointments.specialistId}
          and prev.status = 'no_show'
          and ps.starts_at > now() - interval '90 days'
      )`,
    })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .innerJoin(users, eq(users.id, appointments.patientId))
    .where(
      and(
        eq(appointments.specialistId, user.id),
        eq(appointments.status, "no_show"),
        sql`${slots.startsAt} > now() - interval '30 days'`,
        // разобранной считается неявка, после которой человек снова записан
        sql`not exists (
          select 1 from appointments later
          join slots ls on ls.id = later.slot_id
          where later.patient_id = ${appointments.patientId}
            and later.status <> 'cancelled'
            and ls.starts_at > ${slots.startsAt}
        )`,
      ),
    )
    .limit(200);

  const alerted = await recentAlertPatients(noShowRows.map((r) => r.a.patientId));

  for (const r of noShowRows) {
    items.push({
      kind: "noshow",
      id: r.a.id,
      userId: r.a.patientId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: t({ uk: "Не прийшов на прийом", ru: "Не пришёл на приём" } as never),
      signals: Number(r.streak),
      days: Math.max(0, Math.round((now - new Date(r.slot.startsAt).getTime()) / 86_400_000)),
      /*
       * Срочной неявка становится, если за последний месяц у человека
       * срабатывала тревога риска: тогда «перестал приходить» и «стало
       * хуже» — одно событие, увиденное с разных сторон.
       */
      overdue: alerted.has(r.a.patientId),
      assignedTo: r.a.specialistId,
      since: r.slot.startsAt,
      href: `/patients/${r.a.patientId}`,
    });
  }

  // 3. Направления, по которым нет ответа
  const referralRows = await db
    .select({
      r: referrals,
      unit: users.unit,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.userId))
    .where(inArray(referrals.status, ["created", "accepted"]))
    .limit(200);

  for (const r of referralRows) {
    const days = Math.floor((now - new Date(r.r.createdAt).getTime()) / 86_400_000);
    items.push({
      kind: "referral",
      id: r.r.id,
      userId: r.r.userId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: r.r.status,
      // без обратной связи направление тихо теряется — семь дней уже повод
      destination: r.r.destination,
      days,
      overdue: days >= 7 || r.r.urgency === "immediate",
      assignedTo: null,
      since: r.r.createdAt,
      href: `/patients/${r.r.userId}/summary`,
    });
  }

  // 3. Назначения с истёкшим сроком
  const overdueAssignments = await db
    .select({
      a: batteryAssignments,
      batteryTitle: batteries.title,
      unit: users.unit,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(batteryAssignments)
    .innerJoin(batteries, eq(batteries.id, batteryAssignments.batteryId))
    .innerJoin(users, eq(users.id, batteryAssignments.userId))
    .where(
      and(
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
        ne(batteryAssignments.dueAt, sql`null`),
        lt(batteryAssignments.dueAt, new Date().toISOString()),
      ),
    )
    .limit(200);

  for (const r of overdueAssignments) {
    const days = Math.floor((now - new Date(r.a.dueAt!).getTime()) / 86_400_000);
    items.push({
      kind: "assignment",
      id: r.a.id,
      userId: r.a.userId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: r.batteryTitle,
      days,
      overdue: true,
      assignedTo: null,
      since: r.a.dueAt!,
      href: `/patients/${r.a.userId}/summary`,
    });
  }

  /*
   * 4. Просроченные повторы по протоколу наблюдения.
   *
   * Каскад открывает доступ к методике с отложенным сроком и пометкой
   * «Протокол наблюдения». Если срок вышел, а повтора нет — человек выпал
   * из наблюдения, и узнать об этом должен специалист, а не никто.
   */
  const overdueFollowups = await db
    .select({
      userId: surveyAccess.userId,
      surveyId: surveyAccess.surveyId,
      note: surveyAccess.note,
      expiresAt: surveyAccess.expiresAt,
      surveyTitle: surveys.title,
      unit: users.unit,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(surveyAccess)
    .innerJoin(surveys, eq(surveys.id, surveyAccess.surveyId))
    .innerJoin(users, eq(users.id, surveyAccess.userId))
    .where(
      and(
        isNotNull(surveyAccess.expiresAt),
        lt(surveyAccess.expiresAt, new Date().toISOString()),
        sql`${surveyAccess.note} like ${"Протокол наблюдения%"}`,
        // повтора так и не было: последнее прохождение раньше выдачи доступа
        sql`not exists (
          select 1 from responses r
          where r.user_id = ${surveyAccess.userId}
            and r.survey_id = ${surveyAccess.surveyId}
            and r.status = 'completed'
            and r.submitted_at > ${surveyAccess.grantedAt}
        )`,
      ),
    )
    .limit(200);

  for (const r of overdueFollowups) {
    const days = Math.floor((now - new Date(r.expiresAt!).getTime()) / 86_400_000);
    items.push({
      kind: "followup",
      id: `${r.userId}:${r.surveyId}`,
      userId: r.userId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: t(r.surveyTitle as never),
      days,
      overdue: true,
      assignedTo: null,
      since: r.expiresAt!,
      href: `/patients/${r.userId}/summary`,
    });
  }

  /*
   * Просроченные шаги маршрутов. Без этого маршрут был бы отдельным списком,
   * который надо не забыть открыть, — то есть ровно тем, от чего уходим:
   * очередь работы существует, чтобы держать всё входящее в одном месте.
   */
  const allowedPatients = await accessiblePatientIds(user);
  if (!allowedPatients || allowedPatients.size) {
    const overdueSteps = await db
      .select({
        progress: pathwayProgress,
        step: pathwaySteps,
        instance: pathwayInstances,
        pathway: pathways,
        patient: users,
      })
      .from(pathwayProgress)
      .innerJoin(pathwaySteps, eq(pathwaySteps.id, pathwayProgress.stepId))
      .innerJoin(pathwayInstances, eq(pathwayInstances.id, pathwayProgress.instanceId))
      .innerJoin(pathways, eq(pathways.id, pathwayInstances.pathwayId))
      .leftJoin(users, eq(users.id, pathwayInstances.userId))
      .where(
        and(
          eq(pathwayProgress.state, "pending"),
          isNull(pathwayInstances.closedAt),
          isNotNull(pathwayProgress.dueAt),
          sql`${pathwayProgress.dueAt} < now()`,
          allowedPatients ? inArray(pathwayInstances.userId, [...allowedPatients]) : undefined,
        ),
      )
      .limit(200);

    for (const row of overdueSteps) {
      const days = Math.floor((now - new Date(row.progress.dueAt!).getTime()) / 86_400_000);
      items.push({
        kind: "pathway",
        id: row.progress.id,
        userId: row.instance.userId,
        userName: row.patient ? fullNameOf(row.patient) : "—",
        unit: row.patient?.unit ?? null,
        title: `${t(row.pathway.title as never)}: ${t(row.step.title as never)}`,
        days,
        overdue: true,
        assignedTo: null,
        since: row.progress.dueAt!,
        href: `/pathways/${row.instance.id}`,
      });
    }
  }

  /*
   * Просроченные цели лечения. У цели есть срок, и без этого он был бы
   * украшением: никто не открывает карту каждого пациента, чтобы проверить,
   * не прошёл ли третий месяц.
   */
  if (!allowedPatients || allowedPatients.size) {
    const overdueGoals = await db
      .select({ goal: treatmentGoals, survey: surveys, patient: users })
      .from(treatmentGoals)
      .innerJoin(surveys, eq(surveys.id, treatmentGoals.surveyId))
      .leftJoin(users, eq(users.id, treatmentGoals.userId))
      .where(
        and(
          eq(treatmentGoals.status, "open"),
          isNotNull(treatmentGoals.dueAt),
          sql`${treatmentGoals.dueAt} < now()`,
          allowedPatients ? inArray(treatmentGoals.userId, [...allowedPatients]) : undefined,
        ),
      )
      .limit(200);

    for (const row of overdueGoals) {
      const days = Math.floor((now - new Date(row.goal.dueAt!).getTime()) / 86_400_000);
      items.push({
        kind: "goal",
        id: row.goal.id,
        userId: row.goal.userId,
        userName: row.patient ? fullNameOf(row.patient) : "—",
        unit: row.patient?.unit ?? null,
        title: `${t(row.survey.title as never)}: ${row.goal.scaleCode}`,
        days,
        overdue: true,
        assignedTo: null,
        since: row.goal.dueAt!,
        href: `/patients/${row.goal.userId}/summary`,
      });
    }
  }

  /*
   * В кризисном режиме порядок другой: сначала тяжесть, потом всё остальное.
   *
   * В обычный день очередь ведёт по видам работы — случай, шаг маршрута,
   * цель, — и это правильно: так работа не теряется. В массовое поступление
   * то же правило прячет тяжёлого за плановой рутиной.
   *
   * Меняется только порядок. Состав очереди и всё остальное — те же: режим,
   * который заодно что-то скрывает, опаснее любого потока пациентов.
   */
  const crisis = await currentCrisis();
  const byCrisis = (i: Item) => (i.kind === "case" ? 0 : i.overdue ? 1 : 2);

  items.sort((a, b) =>
    crisis.active
      ? byCrisis(a) - byCrisis(b) || (b.days ?? 0) - (a.days ?? 0)
      : Number(b.overdue) - Number(a.overdue) ||
        KIND_WEIGHT[a.kind] - KIND_WEIGHT[b.kind] ||
        a.since.localeCompare(b.since),
  );

  const mine = items.filter((i) => i.assignedTo === user.id).length;
  await audit(c, { action: "worklist.read", details: { total: items.length, mine } });

  return c.json({
    items: items.slice(0, 100),
    total: items.length,
    truncated: items.length > 100,
    /** Порядок очереди сейчас кризисный: сначала тяжесть */
    crisis: crisis.active,
    byKind: {
      case: items.filter((i) => i.kind === "case").length,
      followup: items.filter((i) => i.kind === "followup").length,
      referral: items.filter((i) => i.kind === "referral").length,
      assignment: items.filter((i) => i.kind === "assignment").length,
      pathway: items.filter((i) => i.kind === "pathway").length,
      goal: items.filter((i) => i.kind === "goal").length,
    },
    mine,
  });
});
