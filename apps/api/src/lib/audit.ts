import type { Context } from "hono";
import { desc, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLog } from "../db/schema";
import type { User } from "@quizzy/shared";
import { currentRequestId, log } from "./log";

/** Действия журнала. Строковый союз, чтобы опечатка ловилась типами. */
export type AuditAction =
  /* поликлиника: каждый переход приёма — событие журнала */
  | "clinic.department_create"
  | "clinic.department_update"
  | "clinic.specialist_profile"
  | "clinic.schedule_update"
  | "clinic.schedule_exception"
  | "clinic.schedule_exception_delete"
  | "clinic.book"
  | "clinic.today"
  | "clinic.confirm"
  | "clinic.reschedule"
  | "clinic.cancel"
  | "clinic.status"
  | "clinic.visit_open"
  | "clinic.report"
  | "report.visit_certificate"
  | "clinic.lead_take"
  | "clinic.lead_release"
  /* права: кто кому что выдал — разбирается по журналу, а не по памяти */
  | "role.create"
  | "role.update"
  | "user.roles_change"
  | "permission.exception"
  | "permission.exception_revoke"
  | "conclusion.batch"
  | "quality.read"
  | "search.notes"
  | "breakglass.open"
  | "breakglass.close"
  | "cohort.preview"
  | "cohort.members"
  | "cohort.save"
  | "cohort.delete"
  | "device.wipe_requested"
  | "device.wiped"
  | "crisis.start"
  | "crisis.end"
  | "informant.invite"
  | "informant.revoke"
  | "informant.submit"
  | "rule.hit"
  | "rule.decide"
  | "rule.save"
  | "duty.assign"
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
  | "survey.archive"
  | "survey.restore"
  | "survey.purge"
  | "survey.duplicate"
  | "survey.publish"
  | "survey.key_print"
  | "survey.export"
  | "survey.import"
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
  | "worklist.read"
  | "alert.acknowledge"
  | "alert.assign"
  | "alert.release"
  | "report.render"
  | "report.unit"
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
  | "invite.create"
  | "invite.revoke"
  | "invite.use"
  | "kiosk.session_create"
  | "kiosk.session_close"
  | "kiosk.join"
  | "kiosk.submit"
  | "alert.notified"
  | "alert.escalated"
  | "conclusion.save"
  | "conclusion.sign"
  | "consent.accept"
  | "consent.text_update"
  | "retention.answer_events"
  | "norms.publish"
  | "analytics.surveillance"
  | "analytics.dif"
  | "analytics.calibration"
  | "analytics.data_quality"
  | "analytics.facets"
  | "referral.list"
  /* консилиум */
  | "conference.open"
  | "conference.opinion"
  | "conference.decide"
  /* цели лечения */
  | "goal.create"
  | "goal.close"
  /* личный план безопасности */
  | "safety.save"
  /* заметки приёма: запись о человеке вне привязки к прохождению */
  | "note.save"
  | "note.sign"
  /* маршруты помощи: заведение шаблона и ведение человека по нему */
  | "pathway.create"
  | "pathway.start"
  | "pathway.step"
  | "pathway.close"
  | "referral.create"
  | "referral.update"
  | "cascade.assign"
  | "cascade.followup"
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
/**
 * Запись с хэш-цепочкой.
 *
 * seq и prevHash берутся под advisory-локом транзакции: без него две
 * параллельные записи взяли бы один prevHash и цепочка раздвоилась бы.
 * Канонизация — фиксированный порядок полей; details сериализуются с
 * отсортированными ключами, иначе один и тот же объект давал бы разные хэши.
 */
const AUDIT_CHAIN_LOCK = 7_154_301;

function canonical(row: Record<string, unknown>): string {
  const ordered = [
    row.id,
    // при чтении из БД метка приходит в другом текстовом виде — нормализуем
    row.at ? new Date(row.at as string).toISOString() : null,
    row.actorId, row.actorEmail, row.actorRole, row.action,
    row.resourceType, row.resourceId, row.subjectUserId, row.outcome,
    row.ip, row.userAgent,
    row.details ? JSON.stringify(row.details, Object.keys(row.details as object).sort()) : null,
  ];
  return JSON.stringify(ordered);
}

export function chainHash(prevHash: string | null, row: Record<string, unknown>): string {
  return new Bun.CryptoHasher("sha256").update((prevHash ?? "genesis") + canonical(row)).digest("hex");
}

async function writeChained(values: Record<string, unknown>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
    // только цепные строки: у записей до внедрения цепочки seq NULL, а
    // NULLS FIRST у DESC-сортировки Postgres подсовывал бы их головой цепочки
    const [head] = await tx
      .select({ seq: auditLog.seq, entryHash: auditLog.entryHash })
      .from(auditLog)
      .where(isNotNull(auditLog.seq))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const seq = (head?.seq ?? 0) + 1;
    const prevHash = head?.entryHash ?? null;
    const at = new Date().toISOString();
    const row = { ...values, at };
    await tx.insert(auditLog).values({
      ...(row as object),
      seq,
      prevHash,
      entryHash: chainHash(prevHash, row),
    } as never);
  });
}

/** Подмешивает номер запроса в подробности события, не затирая своих полей */
function withRequestId(details: Record<string, unknown> | null | undefined) {
  const id = currentRequestId();
  if (!id) return details ?? null;
  return { ...(details ?? {}), requestId: id };
}

export async function audit(c: Context, input: AuditInput): Promise<void> {
  try {
    const actor = input.actor ?? (c.get("user") as User | undefined) ?? null;
    await writeChained({
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
      /*
       * Идентификатор запроса кладём в details, а не отдельной колонкой:
       * колонка изменила бы канонизацию строки, по которой считается хэш, и
       * все прежние записи перестали бы проверяться. Цепочка важнее удобства
       * запроса — а найти по details Postgres умеет.
       */
      details: withRequestId(input.details),
    });
  } catch (err) {
    log.error("audit.write_failed", { action: input.action, error: String(err) });
  }
}

/**
 * Событие без человека-инициатора: сработало расписание, отработал фоновой
 * проход. Актор здесь пуст не по недосмотру, и в журнале это должно читаться
 * именно так, а не как «неизвестно кто».
 */
export async function auditSystem(input: Omit<AuditInput, "actor">): Promise<void> {
  try {
    await writeChained({
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
    log.error("audit.system_write_failed", { action: input.action, error: String(err) });
  }
}

function clientIp(c: Context): string | null {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return c.req.header("X-Real-IP") ?? null;
}
