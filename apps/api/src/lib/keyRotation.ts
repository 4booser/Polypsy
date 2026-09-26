import { desc, eq, sql } from "drizzle-orm";
import type { OpsReencryptJob } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { dbContext, systemContext } from "../db/context";
import { securityJobs, users } from "../db/schema";
import { auditSystem } from "./audit";
import { activeKey } from "./crypto";
import { rewrapAll } from "./encryptBackfill";
import { keyInventory } from "./keyInventory";
import { log } from "./log";

/**
 * Перешифровка на основной ключ — фоновым заданием техпанели.
 *
 * Шаг 3 ротации по RUNBOOK: новый ключ уже основной, старый ещё в списке, и
 * всё, что лежит на старом, надо перевести на новый. Сам проход — тот же,
 * что у `bun run db:encrypt` (lib/encryptBackfill, rewrapAll); здесь только
 * то, что нужно заданию: запуск из запроса, ход в базе, одна перешифровка
 * за раз и след в журнале.
 */

/** Сердцебиение старше этого — процесс, который вёл проход, умер */
const STALE_MS = 2 * 60_000;
/** Ключ advisory-лока: проверка «не идёт ли уже» и запись задания — атомарно */
const REENCRYPT_LOCK = 7_154_509;

function view(
  row: typeof securityJobs.$inferSelect,
  startedByEmail: string | null,
  now = Date.now(),
): OpsReencryptJob {
  /*
   * «Шёл, но перестал отзываться» показывается как оборванный, а не как
   * идущий. Процесс, упавший посреди прохода, не успевает отметить конец, и
   * без этого экран до скончания века рисовал бы «перешифровка идёт» и не
   * давал бы запустить новую.
   */
  const interrupted = row.status === "running" && now - new Date(row.heartbeatAt).getTime() > STALE_MS;
  return {
    id: row.id,
    status: interrupted ? "interrupted" : row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    startedBy: startedByEmail,
    targetKey: row.targetKey,
    total: row.total,
    processed: row.processed,
    skipped: row.skipped,
    error: row.error,
  };
}

/** Последнее задание перешифровки. Контекст — вызывающего */
export async function latestReencrypt(): Promise<OpsReencryptJob | null> {
  const [row] = await db
    .select({ job: securityJobs, email: users.email })
    .from(securityJobs)
    .leftJoin(users, eq(users.id, securityJobs.startedBy))
    .where(eq(securityJobs.kind, "reencrypt"))
    .orderBy(desc(securityJobs.startedAt))
    .limit(1);
  return row ? view(row.job, row.email ?? null) : null;
}

export type StartOutcome =
  | { started: true; job: OpsReencryptJob; done: Promise<void> }
  | { started: false; reason: "running"; job: OpsReencryptJob }
  | { started: false; reason: "no_key" };

/**
 * Запустить перешифровку. Возвращается сразу после записи задания; сам
 * проход — `done`, маршрут его не ждёт, тест ждёт.
 *
 * Всё — вне транзакции запроса (dbContext.exit): задание обязано быть
 * записано и видно до того, как проход начнёт отмечать ход, а транзакция
 * запроса закоммитится только с ответом. Проход же живёт дольше запроса и
 * ходит своими транзакциями, по одной на порцию.
 */
export function startReencrypt(actor: { id: string; email: string }): Promise<StartOutcome> {
  return dbContext.exit(async (): Promise<StartOutcome> => {
    const target = activeKey()?.id ?? null;
    if (!target) return { started: false, reason: "no_key" };

    const created = await systemContext(baseDb, async () => {
      await db.execute(sql`select pg_advisory_xact_lock(${REENCRYPT_LOCK})`);
      const current = await latestReencrypt();
      if (current && current.status === "running") return { kind: "running" as const, job: current };

      /*
       * «Всего» — всё, что лежит не на основном ключе, включая то, что
       * расшифровать нечем: такие значения проход тоже просмотрит и отметит
       * как нерасшифрованные, и ход дойдёт до конца, а не застынет на 97 %.
       */
      const inventory = await keyInventory();
      const id = crypto.randomUUID();
      const [row] = await db
        .insert(securityJobs)
        .values({
          id,
          kind: "reencrypt",
          status: "running",
          startedBy: actor.id,
          targetKey: target,
          total: inventory.staleTotal + inventory.lostTotal,
        })
        .returning();
      return { kind: "created" as const, row: row! };
    });

    if (created.kind === "running") return { started: false, reason: "running", job: created.job };

    const jobId = created.row.id;
    const done = runReencrypt(jobId, target);
    return { started: true, job: view(created.row, actor.email), done };
  });
}

async function runReencrypt(jobId: string, target: string): Promise<void> {
  const mark = (patch: Partial<typeof securityJobs.$inferInsert>) =>
    systemContext(baseDb, () => db.update(securityJobs).set(patch).where(eq(securityJobs.id, jobId)));

  try {
    const totals = await rewrapAll(async ({ processed, skipped }) => {
      await systemContext(baseDb, () =>
        db
          .update(securityJobs)
          .set({
            processed: sql`${securityJobs.processed} + ${processed}`,
            skipped: sql`${securityJobs.skipped} + ${skipped}`,
            heartbeatAt: new Date().toISOString(),
          })
          .where(eq(securityJobs.id, jobId)),
      );
    });
    const finishedAt = new Date().toISOString();
    await mark({ status: "done", finishedAt, heartbeatAt: finishedAt });
    await systemContext(baseDb, () =>
      auditSystem({
        action: "sec.reencrypt_done",
        resourceType: "security_job",
        resourceId: jobId,
        outcome: totals.skipped || totals.filesUnreadable ? "error" : "success",
        details: { targetKey: target, ...totals },
      }),
    );
  } catch (error) {
    log.error("sec.reencrypt_failed", { jobId, error: String(error) });
    const finishedAt = new Date().toISOString();
    await mark({ status: "failed", finishedAt, heartbeatAt: finishedAt, error: String(error).slice(0, 500) }).catch(
      (e) => log.error("sec.reencrypt_mark_failed", { jobId, error: String(e) }),
    );
    await systemContext(baseDb, () =>
      auditSystem({
        action: "sec.reencrypt_done",
        resourceType: "security_job",
        resourceId: jobId,
        outcome: "error",
        details: { targetKey: target, error: String(error).slice(0, 300) },
      }),
    ).catch(() => {});
  }
}
