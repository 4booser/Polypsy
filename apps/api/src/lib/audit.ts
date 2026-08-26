import type { Context } from "hono";
import { db } from "../db";
import { auditLog } from "../db/schema";
import type { User } from "@quizzy/shared";

/** Действия журнала. Строковый союз, чтобы опечатка ловилась типами. */
export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.password_change"
  | "auth.refresh_failed"
  | "auth.register"
  | "user.create"
  | "user.role_change"
  | "user.list"
  | "profile.update"
  | "survey.create"
  | "survey.update"
  | "survey.delete"
  | "survey.duplicate"
  | "survey.publish"
  | "survey.key_print"
  | "survey.export"
  | "group.create"
  | "group.update"
  | "group.delete"
  | "group.admin_assign"
  | "group.admin_revoke"
  | "access.grant"
  | "access.revoke"
  | "access.grant_list"
  | "access.patient_list"
  | "response.submit"
  | "alert.list"
  | "alert.acknowledge"
  | "report.render"
  | "response.list"
  | "response.read"
  | "analytics.overview"
  | "analytics.survey"
  | "analytics.export"
  | "analytics.compare"
  | "battery.create"
  | "battery.update"
  | "battery.delete"
  | "battery.assign"
  | "battery.cancel"
  | "battery.assignment_list"
  | "schedule.create"
  | "schedule.update"
  | "schedule.delete"
  | "schedule.run"
  | "analytics.correlations"
  | "audit.read"
  | "access.denied";

interface AuditInput {
  action: AuditAction;
  resourceType?: string;
  resourceId?: string;
  /** Чьи персональные данные затронуты */
  subjectUserId?: string | null;
  outcome?: "success" | "denied" | "error";
  details?: Record<string, unknown>;
  /** Актор, если он ещё не положен в контекст (например, при неудачном логине) */
  actor?: Pick<User, "id" | "email" | "role"> | null;
}

/**
 * Пишет запись в журнал.
 *
 * Дожидаемся записи намеренно: журнал доступа имеет доказательное значение,
 * и «выстрелил и забыл» означал бы, что при падении процесса событие пропадёт,
 * а ответ клиенту уже ушёл.
 *
 * Никогда не бросает: отказ журнала не должен ронять обслуживание пациента,
 * поэтому ошибка уходит в лог процесса.
 */
export async function audit(c: Context, input: AuditInput): Promise<void> {
  try {
    const actor = input.actor ?? (c.get("user") as User | undefined) ?? null;
    await db.insert(auditLog).values({
        id: crypto.randomUUID(),
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? null,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        subjectUserId: input.subjectUserId ?? null,
        outcome: input.outcome ?? "success",
        ip: clientIp(c),
        userAgent: c.req.header("User-Agent") ?? null,
      details: input.details ?? null,
    });
  } catch (err) {
    console.error("[audit] не удалось записать событие", input.action, err);
  }
}

/**
 * Событие без человека-инициатора: сработало расписание, отработал фоновой
 * проход. Актор здесь пуст не по недосмотру, и в журнале это должно читаться
 * именно так, а не как «неизвестно кто».
 */
export async function auditSystem(input: Omit<AuditInput, "actor">): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actorId: null,
      actorEmail: null,
      actorRole: null,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      outcome: input.outcome ?? "success",
      ip: null,
      userAgent: "система",
      details: input.details ?? null,
    });
  } catch (err) {
    console.error("[audit] не удалось записать системное событие", input.action, err);
  }
}

function clientIp(c: Context): string | null {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return c.req.header("X-Real-IP") ?? null;
}
