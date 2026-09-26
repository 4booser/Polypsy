import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { auditLog, departments, scheduleTemplates, suspiciousFindings } from "../db/schema";
import { log } from "./log";
import { registerJob, trackJob } from "./opsJobs";
import { DEFAULT_CONFIG, WATCHED_ACTIONS, detectAll, workingDayOf, type Finding, type JournalEntry, type RuleConfig } from "./suspicious";

/**
 * Проверка подозрительной активности по расписанию — задача реестра opsJobs.
 *
 * Раз в пять минут читает журнал за последние сутки (только действия, которые
 * смотрят правила, — WATCHED_ACTIONS), гонит его через правила
 * (lib/suspicious.ts) и складывает срабатывания в suspicious_findings.
 * Сутки, а не «с прошлого прохода»: серия неудачных входов, начавшаяся до
 * прохода и продолжившаяся после, должна остаться одной серией, а не двумя
 * половинами. Повторный проход по тем же суткам ничего не дублирует —
 * срабатывание узнаётся по отпечатку и обновляется (серия выросла).
 *
 * Разобранное («розібрано») при обновлении разобранным и остаётся: серия,
 * которую признали безобидной, не должна возвращаться в список каждые пять
 * минут. Новая серия после паузы — новое срабатывание с новым отпечатком.
 */

export const SCAN_INTERVAL_MS = 5 * 60_000;
const LOOKBACK_MS = 24 * 3_600_000;
const HISTORY_DAYS = 90;
export const SUSPICIOUS_JOB = "people.suspicious";

let lastScanAt: number | null = null;

export function lastScan(): string | null {
  return lastScanAt === null ? null : new Date(lastScanAt).toISOString();
}

/**
 * Настройки правил: рабочий день — из расписаний специалистов, пояс — из
 * отделения (departments.timezone). Отделений несколько — берётся первое
 * действующее: одно учреждение — один город; разные города — это разные
 * экземпляры системы (волна 8).
 */
export async function ruleConfig(): Promise<RuleConfig> {
  const [dept] = await db
    .select({ timezone: departments.timezone })
    .from(departments)
    .where(isNull(departments.archivedAt))
    .orderBy(asc(departments.createdAt))
    .limit(1);
  const [hours] = await db
    .select({
      from: sql<string | null>`to_char(min(${scheduleTemplates.startsAt}), 'HH24:MI')`,
      to: sql<string | null>`to_char(max(${scheduleTemplates.endsAt}), 'HH24:MI')`,
    })
    .from(scheduleTemplates);
  const { day, source } = workingDayOf(hours?.from ?? null, hours?.to ?? null);
  return { ...DEFAULT_CONFIG, workingDay: day, hoursSource: source, timezone: dept?.timezone ?? DEFAULT_CONFIG.timezone };
}

function toEntry(r: typeof auditLog.$inferSelect): JournalEntry {
  return {
    id: r.id,
    at: r.at,
    actorId: r.actorId,
    actorEmail: r.actorEmail,
    actorRole: r.actorRole,
    action: r.action,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    subjectUserId: r.subjectUserId,
    outcome: r.outcome,
    ip: r.ip,
    userAgent: r.userAgent,
    details: r.details ?? null,
  };
}

/** Сохранить срабатывания: новые — строкой, известные — обновить серию */
export async function storeFindings(findings: readonly Finding[]): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const f of findings) {
    const [row] = await db
      .insert(suspiciousFindings)
      .values({
        id: crypto.randomUUID(),
        rule: f.rule,
        fingerprint: f.fingerprint,
        actorId: f.actorId,
        actorEmail: f.actorEmail,
        subjectId: f.subjectId,
        ip: f.ip,
        windowFrom: f.windowFrom,
        windowTo: f.windowTo,
        hits: f.hits,
        details: f.details,
      })
      .onConflictDoUpdate({
        target: suspiciousFindings.fingerprint,
        set: {
          windowTo: f.windowTo,
          hits: f.hits,
          details: f.details,
          updatedAt: new Date().toISOString(),
        },
        /* не трогаем то, что не изменилось: updated_at иначе врал бы «серия выросла» */
        setWhere: sql`${suspiciousFindings.hits} <> ${f.hits} or ${suspiciousFindings.windowTo} <> ${f.windowTo}`,
      })
      .returning({ inserted: sql<boolean>`xmax = 0` });
    if (row?.inserted) created++;
    else if (row) updated++;
  }
  return { created, updated };
}

/**
 * Один проход проверки. Системным контекстом: журнал и срабатывания под
 * политиками строк, а у задачи по расписанию человека нет.
 */
export async function scanSuspicious(now = Date.now()): Promise<{ found: number; created: number; updated: number }> {
  const result = await systemContext(baseDb, async () => {
    const since = new Date(now - LOOKBACK_MS).toISOString();
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(gte(auditLog.at, since), inArray(auditLog.action, [...WATCHED_ACTIONS])))
      .orderBy(asc(auditLog.at));
    const entries = rows.map(toEntry);

    /* история входов — только тех, кто входил в проверяемые сутки */
    const loginActors = [...new Set(entries.filter((e) => e.action === "auth.login" && e.actorId).map((e) => e.actorId!))];
    const history = loginActors.length
      ? (
          await db
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, "auth.login"),
                eq(auditLog.outcome, "success"),
                inArray(auditLog.actorId, loginActors),
                isNotNull(auditLog.actorId),
                gte(auditLog.at, new Date(now - HISTORY_DAYS * 86_400_000).toISOString()),
              ),
            )
        ).map(toEntry)
      : [];

    const findings = detectAll(entries, history, await ruleConfig());
    const stored = await storeFindings(findings);
    return { found: findings.length, ...stored };
  });
  lastScanAt = now;
  return result;
}

/**
 * Задача планировщика — через реестр opsJobs (участок ops): её такты,
 * длительность и ошибки видны во вкладке «Фонові задачі» наравне с
 * рассыльщиком и чисткой.
 */
export function startSuspiciousWatch(intervalMs = SCAN_INTERVAL_MS): () => void {
  registerJob(SUSPICIOUS_JOB, intervalMs);
  const tick = () => {
    void trackJob(SUSPICIOUS_JOB, () => scanSuspicious()).catch((error) =>
      log.warn("suspicious.scan_failed", { error: String(error) }),
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

/* ─────────── крючок для оповещений ─────────── */

/**
 * Новые, ещё не оповещённые срабатывания.
 *
 * Для параллельного участка оповещений (obs2b): признак «новое» — пустой
 * notified_at, и подключиться к нему можно, не трогая правил. Оповещатель
 * забирает эти строки и отмечает отправленные через markNotified — тогда
 * одно срабатывание не уйдёт дважды, сколько бы проходов ни было. Разобранное
 * до отправки не отправляется: его уже увидели.
 */
export async function unnotifiedFindings(limit = 100) {
  return db
    .select()
    .from(suspiciousFindings)
    .where(and(isNull(suspiciousFindings.notifiedAt), isNull(suspiciousFindings.resolvedAt)))
    .orderBy(asc(suspiciousFindings.detectedAt))
    .limit(limit);
}

export async function markNotified(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await db
    .update(suspiciousFindings)
    .set({ notifiedAt: new Date().toISOString() })
    .where(inArray(suspiciousFindings.id, [...ids]));
}
