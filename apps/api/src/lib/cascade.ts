import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ScoreResult } from "@quizzy/shared";
import { db } from "../db";
import {
  batteries,
  batteryAssignments,
  batteryItems,
  scaleBands,
  scales,
  surveyAccess,
  surveys,
} from "../db/schema";
import { auditSystem } from "./audit";
import { batterySurveysInUse } from "./scope";
import { log } from "./log";

/**
 * Каскадные назначения и протоколы наблюдения (6.2, 6.3).
 *
 * После подсчёта профиля смотрим, в какие полосы легли баллы, и выполняем
 * то, что психолог заранее прописал на полосе: назначить углублённую
 * батарею и/или поставить повторные замеры.
 *
 * Три правила, которые делают это безопасным:
 *   1. Автоматика назначает, но не интерпретирует — никаких диагнозов.
 *   2. Идемпотентность: если такое назначение уже висит незакрытым,
 *      второе не создаётся — повторная сдача не плодит задания.
 *   3. Каскад не может назначить методику, из которой сам вызван, —
 *      бесконечная петля «прошёл → назначено то же самое» невозможна.
 *
 * Ошибки не пробрасываются: сданное прохождение не должно откатываться
 * из-за неудачного каскада.
 */

export interface CascadeOutcome {
  assignedBatteries: string[];
  scheduledFollowUps: number;
}

export async function runCascades(
  surveyId: string,
  userId: string | null,
  scores: ScoreResult[],
): Promise<CascadeOutcome> {
  const outcome: CascadeOutcome = { assignedBatteries: [], scheduledFollowUps: 0 };
  if (!userId || scores.length === 0) return outcome;

  try {
    // полосы, в которые фактически попали баллы
    const bandLabels = scores.filter((s) => s.band).map((s) => ({ scaleId: s.scaleId, label: s.band!.label }));
    if (!bandLabels.length) return outcome;

    const bandRows = await db
      .select({ band: scaleBands, scaleId: scales.id })
      .from(scaleBands)
      .innerJoin(scales, eq(scales.id, scaleBands.scaleId))
      .where(inArray(scaleBands.scaleId, [...new Set(bandLabels.map((b) => b.scaleId))]));

    const hit = bandRows.filter((r) =>
      bandLabels.some(
        (b) =>
          b.scaleId === r.scaleId &&
          // label в базе локализован, у ScoreResult уже разрешён — сравниваем по обоим
          (typeof r.band.label === "string"
            ? r.band.label === b.label
            : Object.values(r.band.label as Record<string, string>).includes(b.label)),
      ),
    );

    for (const { band } of hit) {
      if (band.cascadeBatteryId) {
        await assignCascade(band.cascadeBatteryId, userId, surveyId, band.cascadeDueDays, outcome);
      }
      if (band.followUpDays?.trim()) {
        outcome.scheduledFollowUps += await scheduleFollowUps(
          surveyId,
          userId,
          band.followUpDays,
        );
      }
    }
  } catch (error) {
    log.error("cascade.failed", { surveyId, error: String(error) });
  }
  return outcome;
}

async function assignCascade(
  batteryId: string,
  userId: string,
  fromSurveyId: string,
  dueDays: number | null,
  outcome: CascadeOutcome,
): Promise<void> {
  const battery = await db.query.batteries.findFirst({ where: eq(batteries.id, batteryId) });
  if (!battery || battery.archived) return;

  const items = await db.select().from(batteryItems).where(eq(batteryItems.batteryId, batteryId));
  if (!items.length) return;

  // петля: батарея, содержащая методику-источник, назначала бы себя вечно
  if (items.some((i) => i.surveyId === fromSurveyId)) {
    log.warn("cascade.loop", { batteryId, reason: "батарея содержит методику-источник" });
    return;
  }

  // идемпотентность: незакрытое назначение той же батареи уже есть
  const existing = await db
    .select({ id: batteryAssignments.id })
    .from(batteryAssignments)
    .where(
      and(
        eq(batteryAssignments.batteryId, batteryId),
        eq(batteryAssignments.userId, userId),
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
      ),
    );
  if (existing.length) return;

  // снятые методики каскад не выдаёт; если снята вся батарея — каскада нет
  const inUse = new Set(await batterySurveysInUse(batteryId));
  const grantable = items.filter((i) => inUse.has(i.surveyId));
  if (!grantable.length) {
    log.warn("cascade.skipped", { batteryId, reason: "все методики сняты с использования" });
    return;
  }

  const [source] = await db.select({ title: surveys.title }).from(surveys).where(eq(surveys.id, fromSurveyId));
  const dueAt = dueDays ? new Date(Date.now() + dueDays * 86_400_000).toISOString() : null;

  await db.transaction(async (tx) => {
    await tx.insert(batteryAssignments).values({
      id: crypto.randomUUID(),
      batteryId,
      userId,
      assignedBy: battery.createdBy,
      dueAt,
      note: "Каскад по результату скрининга",
    });
    await tx
      .insert(surveyAccess)
      .values(
        grantable.map((item) => ({
          surveyId: item.surveyId,
          userId,
          grantedBy: battery.createdBy,
          expiresAt: dueAt,
          note: "Каскад по результату скрининга",
        })),
      )
      .onConflictDoNothing();
  });

  outcome.assignedBatteries.push(battery.title);
  await auditSystem({
    action: "cascade.assign",
    resourceType: "battery",
    resourceId: batteryId,
    subjectUserId: userId,
    details: { fromSurveyId, sourceTitle: source?.title ?? null, dueDays },
  });
}

/**
 * Повторные замеры той же методики. Реализованы как персональные доступы с
 * отложенным сроком: полноценное расписание здесь избыточно — интервалы
 * привязаны к конкретному прохождению конкретного человека.
 */
async function scheduleFollowUps(
  surveyId: string,
  userId: string,
  spec: string,
): Promise<number> {
  const days = spec
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((d) => Number.isFinite(d) && d > 0 && d <= 365);
  if (!days.length) return 0;

  // доступ открывается сразу и держится до последнего повтора: закрывать и
  // переоткрывать по расписанию значило бы плодить фоновые задания там, где
  // достаточно одного срока
  const maxDay = Math.max(...days);
  await db
    .insert(surveyAccess)
    .values({
      surveyId,
      userId,
      grantedBy: userId,
      expiresAt: new Date(Date.now() + (maxDay + 14) * 86_400_000).toISOString(),
      note: `Протокол наблюдения: повтор через ${days.join(", ")} дн.`,
    })
    .onConflictDoNothing();

  await auditSystem({
    action: "cascade.followup",
    resourceType: "survey",
    resourceId: surveyId,
    subjectUserId: userId,
    details: { days },
  });
  return days.length;
}
