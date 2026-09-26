import { Hono } from "hono";
import type { z } from "zod";
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { auditQuery, type AuditPage } from "@quizzy/shared";
import { parseQuery } from "../lib/http";
import { db } from "../db";
import { auditLog, users } from "../db/schema";
import { audit } from "../lib/audit";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const auditRoutes = new Hono<AppEnv>();

// журнал доступа читает только суперадмин
/*
 * Журнал доступа — под правом, а не под ролью: читать его должен и тот, кто
 * разбирает обходы правил, не будучи суперадмином. Сегодня audit.read есть
 * только у суперадмина, и поведение не меняется.
 */
auditRoutes.use("*", requireAuth, requireStaff, requirePermission("audit.read"));

type AuditQuery = z.output<typeof auditQuery>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Подстановочные знаки LIKE в тексте человека — буквально, а не шаблоном */
function likeText(text: string): string {
  return `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * Граница «по» — включительно по дню.
 *
 * `to=2026-09-26` значит «по 26-е включительно», а сравнение с датой без
 * времени ставит полночь начала дня: день, названный последним, выпадал из
 * отбора целиком — «журнал за сегодня» был пуст всегда. Дата со временем
 * остаётся как есть: тот, кто указал час, указал его точно.
 */
function upperBound(to: string): SQL {
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const next = new Date(`${to}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return lt(auditLog.at, next.toISOString());
  }
  return lte(auditLog.at, to);
}

/**
 * Условия отбора — одни на чтение, выгрузку и счёт.
 *
 * Одной функцией, потому что выгрузка обязана отдать ровно то, что человек
 * видит на экране: выгрузка «текущего отбора» по чуть другим условиям — это
 * документ, который врёт о том, что в нём.
 *
 * Кто и над кем — идентификатором или куском почты: разбирающий помнит
 * почту, а не uuid. «Над кем» по почте ищется через учётки (у записи журнала
 * почты субъекта нет — только его идентификатор), и найденных берётся не
 * больше пятидесяти: «a» в поле субъекта не должно превращаться в условие на
 * весь реестр.
 */
async function filtersOf(query: AuditQuery): Promise<SQL[]> {
  const { action, actorId, subjectUserId, actor, subject, resourceType, outcome, q, from, to } = query;
  const filters: SQL[] = [];
  if (action) filters.push(eq(auditLog.action, action));
  if (actorId) filters.push(eq(auditLog.actorId, actorId));
  if (subjectUserId) filters.push(eq(auditLog.subjectUserId, subjectUserId));
  if (actor) {
    filters.push(UUID.test(actor) ? eq(auditLog.actorId, actor) : ilike(auditLog.actorEmail, likeText(actor)));
  }
  if (subject) {
    if (UUID.test(subject)) filters.push(eq(auditLog.subjectUserId, subject));
    else {
      const found = await db
        .select({ id: users.id })
        .from(users)
        .where(ilike(users.email, likeText(subject)))
        .limit(50);
      /* никого не нашли — пустой отбор, а не «фильтр не применён» */
      filters.push(found.length ? inArray(auditLog.subjectUserId, found.map((f) => f.id)) : sql`false`);
    }
  }
  if (resourceType) filters.push(eq(auditLog.resourceType, resourceType));
  if (outcome) filters.push(eq(auditLog.outcome, outcome));
  if (q) {
    const text = likeText(q);
    filters.push(
      or(
        ilike(auditLog.action, text),
        ilike(auditLog.actorEmail, text),
        ilike(auditLog.resourceType, text),
        ilike(auditLog.resourceId, text),
        ilike(auditLog.subjectUserId, text),
        sql`${auditLog.details}::text ilike ${text}`,
      )!,
    );
  }
  if (from) filters.push(gte(auditLog.at, from));
  if (to) filters.push(upperBound(to));
  return filters;
}

/** То, что отбор записывает о себе в журнал: условия без значений, которые могли бы оказаться ПДн */
function filterNote(query: AuditQuery) {
  const { action, actorId, subjectUserId, actor, subject, resourceType, outcome, q, from, to } = query;
  return {
    action,
    actorId,
    subjectUserId,
    // почта — не секрет в журнале (она в каждой строке), но поиск по куску — это вопрос, а не адрес
    actor: actor ? (UUID.test(actor) ? actor : "text") : undefined,
    subject: subject ? (UUID.test(subject) ? subject : "text") : undefined,
    resourceType,
    outcome,
    text: q ? true : undefined,
    from,
    to,
  };
}

/**
 * Чтение журнала. Записи только читаются: методов правки и удаления нет
 * намеренно — журнал append-only.
 *
 * Само чтение журнала тоже журналируется.
 *
 * Страницы — курсором (`?cursor=`) или, по-старому, смещением: смещение
 * зовут прежние клиенты и тесты, курсор — техпанель. Порядок — по времени и
 * идентификатору: одного времени мало, записи одного запроса ложатся в одну
 * миллисекунду (см. lib/cursor.ts).
 */
auditRoutes.get("/", async (c) => {
  const query = parseQuery(c, auditQuery);
  const { limit, offset } = query;
  const filters = await filtersOf(query);
  const where = filters.length ? and(...filters) : undefined;

  const cursor = decodeCursor(query.cursor);
  const page = cursor
    ? and(where, or(lt(auditLog.at, cursor.at), and(eq(auditLog.at, cursor.at), lt(auditLog.id, cursor.id))))
    : where;

  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(page)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(limit + 1)
      .offset(cursor ? 0 : offset),
    db.select({ total: sql<number>`count(*)` }).from(auditLog).where(where),
  ]);
  const entries = rows.slice(0, limit);
  const last = entries[entries.length - 1];

  await audit(c, {
    action: "audit.read",
    details: { filters: filterNote(query), returned: entries.length },
  });

  const body: AuditPage = {
    entries: entries as AuditPage["entries"],
    total: Number(total ?? 0),
    offset,
    limit,
    nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.id) : null,
  };
  return c.json(body);
});

/**
 * Выгрузка текущего отбора в CSV.
 *
 * На сервере, а не склейкой на экране: экран держит одну страницу, а
 * выгрузка нужна целиком — и её надо ограничить и записать в журнал там, где
 * это нельзя обойти. Потолок — десять тысяч строк: больше за раз не
 * разбирают глазами, а выгрузка без потолка — это способ вынести журнал
 * целиком одним запросом. Упёрлась в потолок — заголовок X-Truncated и
 * отметка в журнале; сузить период человек может сам.
 *
 * Сама выгрузка — строка журнала (audit.export): журнал уезжает за пределы
 * системы, и «кто и когда выгружал журнал» — вопрос того же рода, что «кто
 * выгружал прохождения».
 *
 * Ячейки, начинающиеся с «=», «+», «-», «@», экранируются апострофом:
 * подробности журнала несут свободный текст (причины, названия), и
 * табличный редактор выполнил бы такую ячейку как формулу у того, кто
 * откроет файл.
 */
export const AUDIT_EXPORT_MAX = 10_000;

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

auditRoutes.get("/export.csv", async (c) => {
  const query = parseQuery(c, auditQuery);
  const filters = await filtersOf(query);
  const where = filters.length ? and(...filters) : undefined;

  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(AUDIT_EXPORT_MAX + 1);
  const truncated = rows.length > AUDIT_EXPORT_MAX;
  const shown = rows.slice(0, AUDIT_EXPORT_MAX);

  await audit(c, {
    action: "audit.export",
    details: { format: "csv", filters: filterNote(query), rows: shown.length, truncated },
  });

  const header = [
    "seq",
    "at",
    "actor_id",
    "actor_email",
    "actor_role",
    "action",
    "outcome",
    "resource_type",
    "resource_id",
    "subject_user_id",
    "ip",
    "user_agent",
    "details",
    "entry_hash",
  ];
  const lines = shown.map((r) =>
    [
      r.seq,
      r.at,
      r.actorId,
      r.actorEmail,
      r.actorRole,
      r.action,
      r.outcome,
      r.resourceType,
      r.resourceId,
      r.subjectUserId,
      r.ip,
      r.userAgent,
      r.details,
      r.entryHash,
    ]
      .map(csvCell)
      .join(","),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(`﻿${[header.join(","), ...lines].join("\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${stamp}.csv"`,
      "Cache-Control": "no-store",
      ...(truncated ? { "X-Truncated": "1" } : {}),
    },
  });
});

/** Сводка по журналу: какие действия и кто чаще всего */
auditRoutes.get("/summary", async (c) => {
  const byAction = await db
    .select({ action: auditLog.action, count: sql<number>`count(*)` })
    .from(auditLog)
    .groupBy(auditLog.action)
    .orderBy(desc(sql`count(*)`));

  const byActor = await db
    .select({ actorEmail: auditLog.actorEmail, count: sql<number>`count(*)` })
    .from(auditLog)
    .groupBy(auditLog.actorEmail)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const [{ denied } = { denied: 0 }] = await db
    .select({ denied: sql<number>`count(*)` })
    .from(auditLog)
    .where(eq(auditLog.outcome, "denied"));

  await audit(c, { action: "audit.read", details: { view: "summary" } });

  return c.json({
    byAction: byAction.map((r) => ({ action: r.action, count: Number(r.count) })),
    byActor: byActor.map((r) => ({ actorEmail: r.actorEmail ?? "—", count: Number(r.count) })),
    deniedCount: Number(denied ?? 0),
  });
});

/**
 * Проверка цепочки журнала. Головной хэш из отчёта стоит время от времени
 * записывать вовне (распечатать, отправить) — тогда подделка даже всей
 * таблицы целиком обнаружима сверкой с внешней копией.
 *
 * Проверка читает журнал целиком — и пишется в журнал сама, как любое
 * чтение (техпанель, волна 10). Запись идёт ПОСЛЕ прохода: иначе проверка
 * проверяла бы и собственную строку, а та ещё не зафиксирована.
 */
auditRoutes.get("/verify", async (c) => {
  const { verifyChain } = await import("../lib/auditVerify");
  const report = await verifyChain();
  await audit(c, {
    action: "audit.read",
    details: { view: "verify", ok: report.ok, checked: report.checked, brokenAtSeq: report.brokenAtSeq },
  });
  return c.json(report, report.ok ? 200 : 409);
});
