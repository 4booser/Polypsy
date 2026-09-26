import type { Context } from "hono";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { ErrorKey, ImpersonationInfo, ImpersonationStart, User } from "@quizzy/shared";
import { db } from "../db";
import { impersonationSessions, users } from "../db/schema";
import { audit } from "./audit";
import { fullNameOf, issuedAfterRevocation, issueImpersonationToken, type TokenClaims } from "./auth";
import { forbidden } from "./http";

/**
 * Вход «от имени» — посмотреть систему так, как её видит человек.
 *
 * Решение заказчика 2026-09-26: «посмотреть как видит он» — только чтение, с
 * баннером и отдельной строкой журнала, только суперадмину и проверкой на
 * сервере. Типичный случай — «врач говорит, что не видит пациента»: чтобы
 * понять, в чём дело, надо увидеть его экран, а просить у врача пароль —
 * значит учить людей отдавать пароли.
 *
 * Как устроено:
 *
 *  • Токен — обычный access-токен человека, под которым смотрят (sub), с
 *    пометкой act = суперадмин и номером сессии (lib/auth.ts). Поэтому всё,
 *    что решает «что видно» — политики строк, зона видимости, права, — видит
 *    ровно этого человека: смотрим его глазами, а не глазами суперадмина с
 *    подменённым именем.
 *  • Срок — полчаса, и refresh-токена нет вовсе: продлить нечем, выдать себе
 *    новый нечем (выдача — запись, а запись под таким токеном запрещена).
 *  • Любая запись — 403 с понятной ошибкой; техпанель и журнал — 403. Отказ
 *    приходит из middleware, раньше любого обработчика: перечень «безопасных
 *    маршрутов» устарел бы с первой новой возможностью, а метод запроса — нет.
 *  • Каждое действие — строка журнала с обоими людьми: действующее лицо —
 *    суперадмин (actor_*), «от чьего имени» — плоские поля details.asUserId и
 *    details.impersonation. Плоские — потому что канонизация хэш-цепочки
 *    сортирует ключи details через список-заменитель JSON.stringify, а он
 *    действует и на вложенные объекты: вложенное поле с именем, которого нет
 *    на верхнем уровне, в хэш не попало бы, и его правку задним числом
 *    проверка цепочки не заметила бы. Колонку не добавляем по той же причине,
 *    что requestId (lib/audit.ts): она поменяла бы канонизацию всех строк.
 *  • subject_user_id — тот, чьи данные затронуты, как и везде: открыл
 *    суперадмин под врачом карту пациента — субъект пациент, и отчёт «хто
 *    переглядав» (для пациента) эту строку найдёт. Если у действия своего
 *    субъекта нет — субъектом ставится тот, под кем смотрят: «что делали от
 *    моего имени» тоже вопрос, который задают журналу.
 *  • Под другим суперадмином смотреть нельзя: это был бы способ действовать
 *    его правами без следа в его собственной сессии; себя — бессмысленно.
 */

export const IMPERSONATION_TTL_MS = 30 * 60_000;

type Refusal = { ok: false; error: ErrorKey };

/** Начать: проверки, строка сессии, токен. Право суперадмина проверяет маршрут */
export async function startImpersonation(
  actor: User,
  targetId: string,
  reason: string,
): Promise<{ ok: true; start: ImpersonationStart } | Refusal> {
  if (actor.impersonation) return { ok: false, error: "err.impersonationReadOnly" };
  if (targetId === actor.id) return { ok: false, error: "err.impersonateSelf" };
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
  if (!target) return { ok: false, error: "err.userNotFound" };
  if (target.role === "superadmin") return { ok: false, error: "err.impersonateSuperadmin" };
  /* выключенную учётку сторож на каждом запросе всё равно не пустил бы — говорим сразу */
  if (target.disabledAt) return { ok: false, error: "err.impersonateDisabled" };

  const sessionId = crypto.randomUUID();
  const expiresAtMs = Date.now() + IMPERSONATION_TTL_MS;
  await db.insert(impersonationSessions).values({
    id: sessionId,
    actorId: actor.id,
    subjectId: target.id,
    reason,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  const token = await issueImpersonationToken({
    subjectId: target.id,
    subjectRole: target.role,
    actorId: actor.id,
    sessionId,
    reason,
    expiresAtMs,
  });
  return {
    ok: true,
    start: {
      token,
      sessionId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      subject: { id: target.id, email: target.email, fullName: fullNameOf(target), role: target.role },
    },
  };
}

/** Закончить свою сессию. Чужую — нельзя: гасит её только тот, кто начал */
export async function endImpersonation(sessionId: string, actorId: string) {
  const [row] = await db
    .update(impersonationSessions)
    .set({ endedAt: new Date().toISOString() })
    .where(
      and(
        eq(impersonationSessions.id, sessionId),
        eq(impersonationSessions.actorId, actorId),
        isNull(impersonationSessions.endedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Проверить токен «от имени» — для middleware, системным контекстом.
 *
 * Действует, пока жива сессия (не закончена и не истекла) и пока жив сам
 * суперадмин: выключили его, сменил он пароль или вышел — граница его
 * токенов сдвинулась, и то, что он смотрит, гаснет вместе с его сессией.
 * Граница того, ПОД КЕМ смотрят, здесь не проверяется намеренно: выйди врач
 * из своей сессии — суперадмину, разбирающему его жалобу, это смотреть не
 * мешает.
 */
export async function resolveImpersonation(claims: TokenClaims): Promise<ImpersonationInfo | ErrorKey> {
  if (!claims.act?.sub || !claims.imp) return "err.impersonationEnded";
  const session = await db.query.impersonationSessions.findFirst({
    where: and(
      eq(impersonationSessions.id, claims.imp),
      isNull(impersonationSessions.endedAt),
      gt(impersonationSessions.expiresAt, new Date().toISOString()),
    ),
  });
  if (!session || session.actorId !== claims.act.sub || session.subjectId !== claims.sub) {
    return "err.impersonationEnded";
  }
  const actor = await db.query.users.findFirst({ where: eq(users.id, session.actorId) });
  if (!actor || actor.role !== "superadmin" || actor.disabledAt) return "err.impersonationEnded";
  if (!issuedAfterRevocation(claims, actor.tokensValidFrom)) return "err.impersonationEnded";
  return {
    sessionId: session.id,
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: fullNameOf(actor),
    reason: session.reason,
    expiresAt: session.expiresAt,
  };
}

/*
 * Склейка одинаковых просмотров.
 *
 * Консоль под чужим именем опрашивает счётчики раз в минуту (тревоги,
 * очередь, приём) — полчаса такого просмотра давали бы полторы сотни
 * одинаковых строк, и среди них тонула бы та одна, ради которой журнал и
 * читают: «открыл карту такого-то». Поэтому один и тот же адрес с тем же
 * методом в одной сессии пишется не чаще раза в пять минут, а сама строка
 * говорит, что склеивает серию (glued). Любой новый адрес пишется сразу.
 * Память процесса: после перезапуска первая же строка напишется снова — это
 * лишняя строка, а не пропущенная.
 */
const GLUE_MS = 5 * 60_000;
const lastView = new Map<string, number>();

function shouldLog(key: string, now: number): boolean {
  const last = lastView.get(key);
  if (last !== undefined && now - last < GLUE_MS) return false;
  if (lastView.size > 5000) {
    for (const [k, at] of lastView) if (now - at >= GLUE_MS) lastView.delete(k);
  }
  lastView.set(key, now);
  return true;
}

/** Путь к техпанели и журналу: под чужим именем туда не ходят */
export function isOpsPath(path: string): boolean {
  return path === "/api/ops" || path.startsWith("/api/ops/") || path === "/api/audit" || path.startsWith("/api/audit/");
}

/**
 * Правила токена «от имени» — вызывается из requireAuth до обработчика.
 *
 * Отказ бросается до транзакции запроса (как у учётки «только просмотр»),
 * поэтому строка журнала об отказе остаётся: «под чужим именем пытались
 * записать» — ровно то, что журнал должен помнить.
 */
export async function guardImpersonated(c: Context, user: User): Promise<void> {
  const imp = user.impersonation!;
  const method = c.req.method.toUpperCase();
  const path = c.req.path;
  if (isOpsPath(path)) {
    await audit(c, {
      action: "access.denied",
      outcome: "denied",
      resourceType: "route",
      resourceId: path,
      details: { method, reason: "impersonation_no_ops" },
    });
    forbidden("err.impersonationNoOps");
  }
  if (method !== "GET" && method !== "HEAD") {
    await audit(c, {
      action: "access.denied",
      outcome: "denied",
      resourceType: "route",
      resourceId: path,
      details: { method, reason: "impersonation_read_only" },
    });
    forbidden("err.impersonationReadOnly");
  }
  if (shouldLog(`${imp.sessionId}|${method}|${path}`, Date.now())) {
    await audit(c, {
      action: "impersonation.view",
      resourceType: "route",
      resourceId: path,
      details: { method, glued: "5m" },
    });
  }
}
