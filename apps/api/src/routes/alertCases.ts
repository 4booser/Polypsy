import { Hono } from "hono";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { t, type AlertCase, type AlertSignal, type Page } from "@quizzy/shared";
import { db } from "../db";
import { alertCases, auditLog, questions, riskAlerts, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseQuery } from "../lib/http";
import { canAccessSurvey, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";
import { z } from "zod";

/**
 * Случаи риска — то, что разбирает дежурный специалист.
 *
 * Список курсорный: на четырёхстах открытых случаях отдавать всё разом
 * бессмысленно, а нумерованные страницы врут — список меняется прямо во
 * время разбора, и «страница 3» через минуту показывает другое.
 */
export const alertCaseRoutes = new Hono<AppEnv>();

alertCaseRoutes.use("*", requireAuth, requireStaff);

/** Сколько сигналов показывать внутри случая сразу */
const SIGNALS_PREVIEW = 12;

const listQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 30))
    .pipe(z.number().int().min(1).max(100)),
  // курсор — база64 от «метка времени + идентификатор»: около 90 знаков
  cursor: z.string().max(200).optional(),
  all: z.string().optional(),
  severity: z.enum(["moderate", "severe"]).optional(),
  unit: z.string().max(120).optional(),
  assigned: z.string().max(80).optional(),
  surveyId: z.string().max(80).optional(),
  search: z.string().max(120).optional(),
});

/**
 * Курсор — «время последней тревоги + идентификатор».
 *
 * Одного времени мало: у случаев, заведённых в одну секунду, порядок между
 * страницами разъехался бы и часть записей человек бы не увидел вовсе.
 */
function encodeCursor(row: { lastAlertAt: string; id: string }): string {
  return Buffer.from(`${row.lastAlertAt}|${row.id}`).toString("base64url");
}
function decodeCursor(raw: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(raw, "base64url").toString().split("|");
    return at && id ? { at, id } : null;
  } catch {
    return null;
  }
}

alertCaseRoutes.get("/", async (c) => {
  const user = c.get("user");
  const q = parseQuery(c, listQuery);

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return c.json({ items: [], nextCursor: null, total: 0 } satisfies Page<AlertCase>);

  const filters: SQL[] = [inArray(alertCases.surveyId, surveyIds)];
  if (q.all !== "1") filters.push(isNull(alertCases.acknowledgedAt));
  if (q.severity) filters.push(eq(alertCases.severity, q.severity));
  if (q.surveyId) filters.push(eq(alertCases.surveyId, q.surveyId));
  if (q.assigned === "me") filters.push(eq(alertCases.assignedTo, user.id));
  else if (q.assigned === "none") filters.push(isNull(alertCases.assignedTo));
  else if (q.assigned) filters.push(eq(alertCases.assignedTo, q.assigned));
  if (q.unit) filters.push(eq(users.unit, q.unit));

  /*
   * Поиск по фамилии идёт по расшифрованным данным в приложении, а не SQL:
   * ФИО хранится зашифрованным, и LIKE по шифртексту ничего не найдёт.
   * Поэтому при поиске выбираем шире и фильтруем после расшифровки — на
   * четырёхстах случаях это доли миллисекунды, а компромисс честнее, чем
   * заводить незашифрованную копию имени ради удобного запроса.
   */
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (cursor) {
    filters.push(
      or(
        lt(alertCases.lastAlertAt, cursor.at),
        and(eq(alertCases.lastAlertAt, cursor.at), lt(alertCases.id, cursor.id)),
      )!,
    );
  }

  const where = and(...filters);
  const overfetch = q.search ? 400 : q.limit + 1;

  const rows = await db
    .select({
      c: alertCases,
      surveyTitle: surveys.title,
      escalateMinutes: surveys.alertEscalateMinutes,
      unit: users.unit,
      // имена полей ровно как ждёт fullNameOf: он же расшифровывает и умеет
      // про псевдонимы, дублировать эту логику здесь незачем
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
      signalCount: sql<number>`(select count(*)::int from risk_alerts ra where ra.case_id = ${alertCases.id})`,
    })
    .from(alertCases)
    .innerJoin(surveys, eq(surveys.id, alertCases.surveyId))
    .innerJoin(users, eq(users.id, alertCases.userId))
    .where(where)
    .orderBy(desc(alertCases.lastAlertAt), desc(alertCases.id))
    .limit(overfetch);

  const named = rows.map((r) => ({ ...r, userName: fullNameOf(r as never) }));
  const needle = q.search?.trim().toLowerCase();
  const matched = needle
    ? named.filter((r) => r.userName.toLowerCase().includes(needle))
    : named;

  const page = matched.slice(0, q.limit);
  const hasMore = matched.length > q.limit;

  // сигналы одним запросом на страницу, а не по запросу на случай
  const caseIds = page.map((r) => r.c.id);
  const signalsByCase = new Map<string, AlertSignal[]>();
  if (caseIds.length) {
    const sig = await db
      .select({ a: riskAlerts, questionTitle: questions.title })
      .from(riskAlerts)
      .innerJoin(questions, eq(questions.id, riskAlerts.questionId))
      .where(inArray(riskAlerts.caseId, caseIds))
      .orderBy(desc(riskAlerts.at));
    for (const s of sig) {
      const list = signalsByCase.get(s.a.caseId!) ?? [];
      if (list.length < SIGNALS_PREVIEW) {
        list.push({
          id: s.a.id,
          responseId: s.a.responseId,
          questionId: s.a.questionId,
          questionTitle: t(s.questionTitle as never),
          label: s.a.label,
          severity: s.a.severity,
          at: s.a.at,
        });
      }
      signalsByCase.set(s.a.caseId!, list);
    }
  }

  const staffIds = [
    ...new Set(page.flatMap((r) => [r.c.assignedTo, r.c.acknowledgedBy]).filter((x): x is string => !!x)),
  ];
  const staffNames = new Map<string, string>();
  if (staffIds.length) {
    for (const u of await db.select().from(users).where(inArray(users.id, staffIds))) {
      staffNames.set(u.id, fullNameOf(u));
    }
  }

  const now = Date.now();
  const items: AlertCase[] = page.map((r) => {
    /*
     * Просроченность считается на чтении: правило зависит только от времени
     * и настройки методики, а фоновое задание добавило бы точку отказа,
     * ничего не дав.
     */
    const openedMs = r.c.acknowledgedAt
      ? new Date(r.c.acknowledgedAt).getTime() - new Date(r.c.openedAt).getTime()
      : now - new Date(r.c.openedAt).getTime();
    const minutesOpen = Math.max(0, Math.round(openedMs / 60_000));

    return {
      id: r.c.id,
      userId: r.c.userId,
      userName: r.userName,
      unit: r.unit,
      surveyId: r.c.surveyId,
      surveyTitle: t(r.surveyTitle as never),
      severity: r.c.severity,
      openedAt: r.c.openedAt,
      lastAlertAt: r.c.lastAlertAt,
      signalCount: Number(r.signalCount ?? 0),
      signals: signalsByCase.get(r.c.id) ?? [],
      minutesOpen,
      overdue: !r.c.acknowledgedAt && r.escalateMinutes !== null && minutesOpen >= r.escalateMinutes,
      assignedTo: r.c.assignedTo,
      assignedToName: r.c.assignedTo ? (staffNames.get(r.c.assignedTo) ?? null) : null,
      acknowledgedBy: r.c.acknowledgedBy,
      acknowledgedByName: r.c.acknowledgedBy ? (staffNames.get(r.c.acknowledgedBy) ?? null) : null,
      acknowledgedAt: r.c.acknowledgedAt,
      note: r.c.note,
      outcome: r.c.outcome,
      mergedFromLegacy: r.c.mergedFromLegacy,
    };
  });

  // просроченные первыми: их и надо разбирать раньше всех
  items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.lastAlertAt.localeCompare(a.lastAlertAt));

  // общее число — только на первой странице: считать его на каждой лишняя работа
  let total: number | undefined;
  if (!cursor && !needle) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(alertCases)
      .innerJoin(users, eq(users.id, alertCases.userId))
      .where(where);
    total = row?.n ?? 0;
  }

  await audit(c, {
    action: "alert.list",
    details: { returned: items.length, filters: { ...q, cursor: undefined } },
  });

  const last = page[page.length - 1];
  return c.json({
    items,
    nextCursor: hasMore && last ? encodeCursor({ lastAlertAt: last.c.lastAlertAt, id: last.c.id }) : null,
    total,
  } satisfies Page<AlertCase>);
});

/** Подразделения, встречающиеся среди случаев — для фильтра */
alertCaseRoutes.get("/units", async (c) => {
  const scope = await surveyScopeFilter(c.get("user"));
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const ids = scoped.map((s) => s.id);
  if (!ids.length) return c.json({ items: [] });

  const rows = await db
    .selectDistinct({ unit: users.unit })
    .from(alertCases)
    .innerJoin(users, eq(users.id, alertCases.userId))
    .where(and(inArray(alertCases.surveyId, ids), isNotNull(users.unit)));
  return c.json({ items: rows.map((r) => r.unit).filter(Boolean).sort() });
});

async function loadCase(user: { id: string; role: string }, id: string) {
  const row = await db.query.alertCases.findFirst({ where: eq(alertCases.id, id) });
  if (!row) notFound("Случай не найден");
  if (!(await canAccessSurvey(user as never, row.surveyId))) notFound("Случай не найден");
  return row;
}

/**
 * Кто и что делал со случаем.
 *
 * Отдельного журнала передач нет намеренно: всё уже пишется в журнал
 * доступа, и вторая запись о том же означала бы два источника истины о
 * клиническом решении. Здесь просто выборка по этому случаю.
 *
 * Нужно это при передаче смены: заступивший видит, кто брал случай, кто
 * отпускал и почему он до сих пор открыт.
 */
alertCaseRoutes.get("/:id/history", async (c) => {
  const user = c.get("user");
  const row = await loadCase(user, c.req.param("id"));

  const rows = await db
    .select({ entry: auditLog, actor: users })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(eq(auditLog.resourceId, row.id), eq(auditLog.resourceType, "alert_case")))
    .orderBy(desc(auditLog.at))
    .limit(50);

  return c.json({
    items: rows.map((r) => ({
      action: r.entry.action,
      at: r.entry.at,
      actorName: r.actor ? fullNameOf(r.actor) : (r.entry.actorEmail ?? "—"),
      details: r.entry.details,
    })),
  });
});

/**
 * Взять случай на себя или отпустить.
 *
 * Без явной пометки двое дежурных разбирают одного человека дважды и узнают
 * об этом только из журнала.
 */
alertCaseRoutes.post("/:id/assign", async (c) => {
  const user = c.get("user");
  const row = await loadCase(user, c.req.param("id"));
  if (row.acknowledgedAt) badRequest("Случай уже разобран");

  const body = await c.req.json().catch(() => ({}));
  const release = body?.release === true;

  if (!release && row.assignedTo && row.assignedTo !== user.id) {
    badRequest("Случай уже взят другим специалистом");
  }

  const [updated] = await db
    .update(alertCases)
    .set(
      release
        ? { assignedTo: null, assignedAt: null }
        : { assignedTo: user.id, assignedAt: new Date().toISOString() },
    )
    .where(eq(alertCases.id, row.id))
    .returning();

  await audit(c, {
    action: release ? "alert.release" : "alert.assign",
    resourceType: "alert_case",
    resourceId: row.id,
    subjectUserId: row.userId,
  });
  return c.json(updated);
});

/**
 * Разбор случая: одно клиническое решение о человеке.
 *
 * Исход ставится на случай целиком — специалист решает про человека, а не
 * про каждый сработавший пункт по отдельности. Это же делает калибровку
 * порогов методологически корректной: пять пунктов одного обследуемого не
 * пять независимых наблюдений.
 */
alertCaseRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const row = await loadCase(user, c.req.param("id"));

  const body = await c.req.json().catch(() => ({}));
  const outcome = ["confirmed", "not_confirmed", "needs_followup"].includes(body?.outcome)
    ? (body.outcome as "confirmed" | "not_confirmed" | "needs_followup")
    : null;
  if (!outcome) badRequest("Нужен исход разбора: подтверждён, не подтверждён или требует наблюдения");

  const at = new Date().toISOString();
  const note = typeof body?.note === "string" ? body.note.slice(0, 2000) : null;

  await db.transaction(async (tx) => {
    await tx
      .update(alertCases)
      .set({ acknowledgedBy: user.id, acknowledgedAt: at, note, outcome })
      .where(eq(alertCases.id, row.id));

    /*
     * Сигналы внутри случая помечаются разобранными тем же решением: они не
     * должны остаться «висящими» в старых выборках и счётчиках, которые
     * смотрят на risk_alerts напрямую.
     */
    await tx
      .update(riskAlerts)
      .set({ acknowledgedBy: user.id, acknowledgedAt: at, outcome })
      .where(and(eq(riskAlerts.caseId, row.id), isNull(riskAlerts.acknowledgedAt)));
  });

  await audit(c, {
    action: "alert.acknowledge",
    resourceType: "alert_case",
    resourceId: row.id,
    subjectUserId: row.userId,
    details: { outcome, note },
  });

  return c.json({ id: row.id, outcome, acknowledgedAt: at });
});
