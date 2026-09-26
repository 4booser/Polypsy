import { and, desc, eq, sql } from "drizzle-orm";
import type { OpsAuditChainReport, OpsIntegrityCheck, OpsIntegrityState, OpsRlsReport } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { integrityChecks, users } from "../db/schema";
import { auditSystem } from "./audit";
import { verifyChain } from "./auditVerify";
import { log } from "./log";
import { checkRls } from "./rlsGuard";
import { observeSecrets } from "./secretMarks";

/**
 * Проверки целостности для техпанели (раздел «Цілісність»): политики строк
 * одной кнопкой и цепочка журнала — кнопкой и раз в сутки по расписанию.
 *
 * Обе проверки существовали и раньше — `bun apps/api/src/rlsReport.ts`,
 * `bun run audit:verify`, команды консоли `rls check` и `audit verify`, — но
 * их надо было помнить и запускать. Здесь они получают кнопку, память
 * результатов и расписание.
 */

/*
 * Колонки, по которым таблица считается хранящей данные о человеке, — те же,
 * что у теста покрытия RLS (access.test.ts, «RLS покрывает все клинические
 * таблицы»). Одно определение на две проверки было бы лучше, но тест
 * нарочно держит список у себя: сузить его молча там нельзя, и то же
 * правило действует здесь.
 */
const PERSON_COLUMNS = ["user_id", "response_id", "subject_user_id", "patient_id", "specialist_id", "author_id"];

/**
 * Состояние политик строк на подключении приложения.
 *
 * Сторож rlsGuard отвечает на один вопрос — действуют ли политики для этой
 * роли вообще. Раздел отвечает шире, потому что дыры бывают и при
 * правильной роли:
 *   — политика написана, а RLS на таблице не включён: политика не действует,
 *     и ничем это не заметно — ровно та ошибка, которую делает миграция,
 *     забывшая ENABLE;
 *   — RLS включён, а политик нет: для роли приложения таблица пуста целиком;
 *     бывает задумано, чаще — забыто;
 *   — таблица со ссылкой на человека вообще без RLS;
 *   — у роли остались UPDATE/DELETE на журнале: третий пояс append-only
 *     (привилегии; первые два — приложение и триггер) снят.
 * Ошибкой (ok = false) считаются обход политик ролью и политики без RLS;
 * остальное — предупреждения: у части таблиц без RLS это решение, и
 * отличить его от забывчивости может только человек.
 */
export async function rlsReport(): Promise<OpsRlsReport> {
  const status = await checkRls();

  const tables = await db.execute<{
    name: string;
    rls: boolean;
    forced: boolean;
    policies: number;
    person: boolean;
  }>(sql`
    select c.relname::text as name,
           c.relrowsecurity as rls,
           c.relforcerowsecurity as forced,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
           exists (
             select 1 from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                and a.attname::text in ${PERSON_COLUMNS}
           ) as person
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
     order by 1
  `);

  const [priv] = await db.execute<{ writable: boolean }>(sql`
    select coalesce(
             has_table_privilege(current_user, to_regclass('public.audit_log'), 'UPDATE')
             or has_table_privilege(current_user, to_regclass('public.audit_log'), 'DELETE'),
             false) as writable
  `);

  const list = [...tables];
  const policiesWithoutRls = list.filter((t) => t.policies > 0 && !t.rls).map((t) => t.name);
  const rlsWithoutPolicies = list.filter((t) => t.rls && t.policies === 0).map((t) => t.name);
  const personTablesWithoutRls = list.filter((t) => t.person && !t.rls).map((t) => t.name);

  return {
    at: new Date().toISOString(),
    ok: !status.bypasses && policiesWithoutRls.length === 0,
    role: status.role,
    bypasses: status.bypasses,
    reason: status.reason,
    tables: list.length,
    rlsTables: list.filter((t) => t.rls).length,
    policies: list.reduce((s, t) => s + Number(t.policies), 0),
    policiesWithoutRls,
    rlsWithoutPolicies,
    personTablesWithoutRls,
    forced: list.filter((t) => t.forced).map((t) => t.name),
    auditWritable: Boolean(priv?.writable),
  };
}

/** Результат сверки цепочки для экрана — отчёт verifyChain с меткой времени */
export async function auditChainReport(): Promise<OpsAuditChainReport> {
  const report = await verifyChain();
  return { at: new Date().toISOString(), ...report };
}

/**
 * Записать результат проверки. Контекст — вызывающего: маршрут пишет от
 * суперадмина внутри запроса, планировщик — системой.
 */
export async function recordCheck(
  kind: "audit_chain" | "rls",
  trigger: "manual" | "schedule",
  ok: boolean,
  summary: OpsAuditChainReport | OpsRlsReport,
  actorId: string | null,
): Promise<void> {
  await db.insert(integrityChecks).values({
    id: crypto.randomUUID(),
    kind,
    trigger,
    at: summary.at,
    ok,
    actorId,
    summary: summary as unknown as Record<string, unknown>,
  });
}

/**
 * Разрыв цепочки — не «ещё одна строка в таблице проверок».
 *
 * Пишется в журнал отдельным действием и в лог процесса уровнем error. Имя
 * действия (sec.audit_chain_broken) и события лога (sec.audit_chain_broken) —
 * опора для оповещений (участок obs2 волны 10): им не нужно разбирать
 * details, достаточно подписаться на имя. Второй признак — последняя
 * запись integrity_checks с ok = false (lastAuditChainCheck ниже).
 *
 * Журнал с разорванной цепочкой продолжает принимать записи: новая запись
 * цепляется к текущей голове, и сама запись о разрыве окажется в цепочке
 * после места поломки — то есть проверяемой.
 */
export async function reportChainBroken(report: OpsAuditChainReport, trigger: "manual" | "schedule"): Promise<void> {
  log.error("sec.audit_chain_broken", {
    brokenAtSeq: report.brokenAtSeq,
    checked: report.checked,
    trigger,
  });
  await auditSystem({
    action: "sec.audit_chain_broken",
    resourceType: "audit_log",
    resourceId: report.brokenAtSeq === null ? undefined : String(report.brokenAtSeq),
    outcome: "error",
    details: { brokenAtSeq: report.brokenAtSeq, checked: report.checked, trigger },
  });
}

/** Сутки между плановыми сверками; пять минут — допуск на дрожание часового тика */
const DAY_MS = 86_400_000;
const SLACK_MS = 5 * 60_000;

/**
 * Плановая сверка цепочки — не чаще раза в сутки.
 *
 * Тик планировщика часовой, и сутки отмеряет сама задача: по времени
 * последней плановой сверки в integrity_checks, а не по счётчику тиков в
 * памяти. Счётчик обнулялся бы каждым перезапуском, и процесс, который
 * перезапускают чаще раза в сутки (обновления), не сверял бы журнал никогда.
 */
export async function runScheduledAuditCheck(now = new Date()): Promise<OpsAuditChainReport | null> {
  return systemContext(baseDb, async () => {
    const [last] = await db
      .select({ at: integrityChecks.at })
      .from(integrityChecks)
      .where(and(eq(integrityChecks.kind, "audit_chain"), eq(integrityChecks.trigger, "schedule")))
      .orderBy(desc(integrityChecks.at))
      .limit(1);
    if (last && now.getTime() - new Date(last.at).getTime() < DAY_MS - SLACK_MS) return null;

    const report = await auditChainReport();
    await recordCheck("audit_chain", "schedule", report.ok, report, null);
    if (report.ok) {
      await auditSystem({
        action: "sec.audit_check",
        resourceType: "audit_log",
        details: { trigger: "schedule", ok: true, checked: report.checked, headSeq: report.headSeq },
      });
    } else {
      await reportChainBroken(report, "schedule");
    }
    return report;
  });
}

/**
 * Задача планировщика для участка безопасности: отметки секретов каждый
 * тик (дёшево — пять строк), сверка журнала раз в сутки.
 */
export async function securityTick(now = new Date()): Promise<void> {
  await systemContext(baseDb, () => observeSecrets(now));
  await runScheduledAuditCheck(now);
}

type CheckRow = { at: string; trigger: "manual" | "schedule"; ok: boolean; summary: unknown; email: string | null };

async function lastCheck(kind: "audit_chain" | "rls", trigger?: "manual" | "schedule"): Promise<CheckRow | null> {
  const [row] = await db
    .select({
      at: integrityChecks.at,
      trigger: integrityChecks.trigger,
      ok: integrityChecks.ok,
      summary: integrityChecks.summary,
      email: users.email,
    })
    .from(integrityChecks)
    .leftJoin(users, eq(users.id, integrityChecks.actorId))
    .where(trigger ? and(eq(integrityChecks.kind, kind), eq(integrityChecks.trigger, trigger)) : eq(integrityChecks.kind, kind))
    .orderBy(desc(integrityChecks.at))
    .limit(1);
  return row ?? null;
}

function asCheck<T>(row: CheckRow | null): OpsIntegrityCheck<T> | null {
  if (!row) return null;
  return { at: row.at, trigger: row.trigger, ok: row.ok, actorEmail: row.email, summary: row.summary as T };
}

/**
 * Последняя сверка цепочки — любым путём, кнопкой или по расписанию.
 *
 * Признак для оповещений (участок obs2): `ok === false` у последней
 * проверки означает, что журнал на момент проверки был порван, и никакая
 * более поздняя проверка этого не опровергла. Контекст — вызывающего
 * (таблица под политикой: система или суперадмин).
 */
export async function lastAuditChainCheck(): Promise<OpsIntegrityCheck<OpsAuditChainReport> | null> {
  return asCheck<OpsAuditChainReport>(await lastCheck("audit_chain"));
}

/** Что показывает раздел: последние результаты обеих проверок и расписание */
export async function integrityState(now = new Date()): Promise<OpsIntegrityState> {
  const scheduled = asCheck<OpsAuditChainReport>(await lastCheck("audit_chain", "schedule"));
  return {
    rls: asCheck<OpsRlsReport>(await lastCheck("rls")),
    audit: asCheck<OpsAuditChainReport>(await lastCheck("audit_chain")),
    auditScheduled: scheduled,
    scheduleHours: 24,
    nextScheduledAfter: scheduled
      ? new Date(new Date(scheduled.at).getTime() + DAY_MS - SLACK_MS).toISOString()
      : now.toISOString(),
  };
}
