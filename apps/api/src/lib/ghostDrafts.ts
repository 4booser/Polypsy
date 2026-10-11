/**
 * Черновики-призраки: незданные черновики попыток, которые уже сданы (#197).
 *
 * До волны 21 (#147) автосохранение, дошедшее после сдачи (мобильная
 * дорожка черновика досылает последнюю правку), заводило новый черновик той
 * же попытки — тот же startedAt, что у сданного прохождения, — и поднимало
 * на нём тревогу, иногда в новом случае. Новых таких больше не бывает
 * (PUT /draft отказывает сданной попытке), а созданные на проде остались:
 * висят открытыми тревогами-дублями в очереди дежурного. Писать в них
 * следующая попытка больше не может — автосохранение пишет только в
 * черновик своей попытки, а продолжить призрака GET /draft не предлагает.
 *
 * Почему тревога призрака — дубль, а не новый сигнал. Автосохранение ищет
 * риск тем же движком, что и сдача (lib/risk.ts → detectAnswerRisks; сдача —
 * evaluateSubmission, тот же пакет), поэтому на тех же ответах сданное
 * прохождение подняло свою тревогу на том же пункте, а ранняя тревога
 * черновика той попытки переехала на него при сдаче (adoptDraftAlerts).
 * Здесь это не принимается на веру, а сверяется по данным, у каждого
 * призрака отдельно:
 *   — ответы призрака совпадают с ответами сданного прохождения на тех же
 *     пунктах (у призрака их может быть меньше — снимок раньше последней
 *     правки, — или больше на пунктах, скрытых условием: сдача их
 *     отбрасывает);
 *   — у каждой тревоги призрака есть тревога сданного прохождения на том же
 *     пункте и не легче её.
 *   — черновик сохранён и его тревоги подняты в коротком окне после сдачи
 *     (GHOST_WINDOW): призрак — это последняя правка, дошедшая следом за
 *     сдачей, а не запись через дни. До этой волны PUT /draft писал в любой
 *     черновик пары, и следующая попытка возвратной методики могла писать в
 *     призрак с теми же ответами — её тревога настоящая, а не дубль.
 * Только тогда призрак — копия сданной попытки, и его тревоги — дубли. Иначе
 * (запись позже окна; ответы разошлись; тревога без пары или тяжелее
 * сданной) — «на разбор»: команда его не трогает и показывает, а решает
 * человек.
 *
 * Что делает прогон с --apply с дублем, по призраку и одной транзакцией:
 *   — каждая тревога призрака закрывается как дубль сданной попытки: строка
 *     журнала alert.duplicate_closed в случае тревоги (её видно в разборе
 *     случая — /api/alert-cases/:id/history — и в журнале техпанели) с
 *     исходом duplicate, ссылкой на сигнал сданного прохождения и всем, что
 *     было в строке тревоги; направления и отметки об отправленных
 *     уведомлениях переходят на этот сигнал (как в adoptDraftAlerts; вид
 *     уведомления, который у сигнала уже есть, — в подробности строки
 *     журнала); сама строка удаляется. Перенести её на сданное
 *     прохождение нельзя: пункт там уже занят своим сигналом (один сигнал на
 *     пункт прохождения — уникальный индекс), а два сигнала одного ответа
 *     — ровно то, чего индекс не допускает;
 *   — случай призрака, оставшийся без сигналов и открытый, закрывается с
 *     исходом duplicate — системным действием (автор пуст, строка журнала
 *     alert.acknowledge от системы, как у auditSystem): иначе в очереди
 *     дежурного висел бы случай без единого сигнала. Разобранный случай не
 *     трогается — решение специалиста остаётся;
 *   — черновик удаляется (строкой журнала response.ghost_removed), его
 *     направления переходят на сданное прохождение — как при сдаче.
 * Сданное прохождение и его тревоги не меняются.
 *
 * Под замком пары (lockAttempts) — тем же, что у сдачи и автосохранения, — и
 * с повторной сверкой под ним: автосохранение, пришедшее между сухим
 * разбором и записью, ждёт, а призрак, в который оно успело написать,
 * сверяется заново.
 */
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { inIds } from "../db/ids";
import { alertCases, alertNotifications, answers, referrals, responses, riskAlerts, surveys } from "../db/schema";
import { lockAttempts } from "../routes/responses";
import { auditSystem } from "./audit";
import { caseZoneSql } from "./alertCases";
import { decryptField } from "./crypto";
import { publish } from "./events";

export interface GhostAlert {
  id: string;
  questionId: string | null;
  severity: "moderate" | "severe";
  /** Когда поднята */
  at: string;
  caseId: string | null;
  acknowledged: boolean;
  /** Сигнал сданного прохождения на том же пункте, если есть */
  pair: { id: string; severity: "moderate" | "severe"; caseId: string | null } | null;
}

export interface Ghost {
  id: string;
  /** Сданное прохождение той же попытки */
  submittedId: string;
  surveyId: string;
  userId: string;
  startedAt: string;
  lastSavedAt: string | null;
  submittedAt: string | null;
  /** duplicate — копия сданной попытки; review — решает человек */
  verdict: "duplicate" | "review";
  /** Почему на разбор: запись позже окна после сдачи, ответы разошлись, тревога без пары, тревога тяжелее сданной */
  reason: "late" | "answers" | "unpaired" | "stronger" | null;
  alerts: GhostAlert[];
}

export interface GhostReport {
  ghosts: Ghost[];
  /** Что сделано (только с apply) */
  removed: number;
  closedAlerts: number;
  closedCases: number;
}

/**
 * Окно после сдачи, в котором приходит призрак: [−1 мин; +10 мин] от
 * submittedAt.
 *
 * Призрак — последняя правка дорожки черновика (мобилка, offline/draftLane),
 * которая была в пути или стояла следом в момент сдачи: на дорожке в пути
 * одно сохранение, следующее уходит сразу за ним, а на сервере оно ждёт
 * замка пары (lockAttempts) не дольше транзакции сдачи — предел оператора
 * минута (REQUEST_STATEMENT_TIMEOUT_MS). То есть секунды, в худшем случае
 * около минуты. Десять минут — запас на порядок. Запись следующей попытки
 * приходит со следующим сеансом — через часы и дни.
 *
 * Минута до — сбитые часы устройства: submittedAt — это startedAt +
 * durationMs с телефона, и completionTime принимает его с тем же запасом.
 * Он же делает окно строгим в другую сторону: попытка, сданная из
 * офлайн-очереди или продолженная после перерыва, датирована моментом
 * окончания на устройстве, и её призрак окажется «на разбор» — это ошибка
 * в безопасную сторону: решает человек.
 */
export const GHOST_WINDOW = { beforeMs: 60_000, afterMs: 10 * 60_000 };

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const rank = (s: string) => (s === "severe" ? 2 : 1);

/** Пары «призрак → сданное прохождение той же попытки» — запрос из #197; с id — один призрак */
async function findPairs(id?: string): Promise<Row[]> {
  return (await db.execute(sql`
    select d.id, d.survey_id, d.user_id, d.started_at, d.last_saved_at,
           r.id as submitted_id, r.submitted_at
      from responses d
      join lateral (
        select r.id, r.submitted_at
          from responses r
         where r.survey_id = d.survey_id and r.user_id = d.user_id
           and r.status <> 'in_progress' and r.started_at = d.started_at
         order by r.submitted_at desc nulls last, r.id desc
         limit 1
      ) r on true
     where d.status = 'in_progress' ${id ? sql`and d.id = ${id}` : sql``}
     order by d.started_at, d.id`)) as unknown as Row[];
}

/** Ответ без телеметрии — то, по чему ищется риск и что видит специалист */
function answerKey(a: typeof answers.$inferSelect): string {
  const empty = <T>(v: T[] | null | undefined) => (v && v.length ? v : null);
  const matrix = a.matrix ? Object.entries(a.matrix).sort(([x], [y]) => x.localeCompare(y)) : null;
  return JSON.stringify([
    empty(a.optionIds ? [...a.optionIds].sort() : null),
    matrix && matrix.length ? matrix : null,
    empty(a.ranking),
    a.number,
    a.date || null,
    decryptField(a.text) || null,
    a.skipped,
  ]);
}

/** Сверка призраков с их сданными прохождениями — только чтение */
async function inspect(pairs: Row[]): Promise<Ghost[]> {
  if (!pairs.length) return [];
  const ids = pairs.flatMap((p) => [String(p.id), String(p.submitted_id)]);
  const answerRows = await db.select().from(answers).where(inIds(answers.responseId, ids));
  const alertRows = await db.select().from(riskAlerts).where(inIds(riskAlerts.responseId, ids));

  return pairs.map((p) => {
    const ghostId = String(p.id);
    const submittedId = String(p.submitted_id);
    const submitted = new Map(
      answerRows.filter((a) => a.responseId === submittedId).map((a) => [a.questionId, answerKey(a)]),
    );
    const answersMatch = answerRows
      .filter((a) => a.responseId === ghostId)
      .every((a) => !submitted.has(a.questionId) || submitted.get(a.questionId) === answerKey(a));
    const signals = new Map(
      alertRows.filter((a) => a.responseId === submittedId && a.questionId).map((a) => [a.questionId!, a]),
    );
    const alerts: GhostAlert[] = alertRows
      .filter((a) => a.responseId === ghostId)
      .map((a) => {
        const pair = a.questionId ? signals.get(a.questionId) : undefined;
        return {
          id: a.id,
          questionId: a.questionId,
          severity: a.severity,
          at: iso(a.at)!,
          caseId: a.caseId,
          acknowledged: a.acknowledgedAt !== null,
          pair: pair ? { id: pair.id, severity: pair.severity, caseId: pair.caseId } : null,
        };
      });
    const sent = p.submitted_at == null ? null : Date.parse(String(iso(p.submitted_at)));
    const inWindow = (t: string | null) =>
      sent !== null && t !== null && Date.parse(t) >= sent - GHOST_WINDOW.beforeMs && Date.parse(t) <= sent + GHOST_WINDOW.afterMs;
    const late = !inWindow(iso(p.last_saved_at)) || alerts.some((a) => !inWindow(a.at));
    const reason: Ghost["reason"] = late
      ? "late"
      : !answersMatch
        ? "answers"
        : alerts.some((a) => !a.pair)
        ? "unpaired"
          : alerts.some((a) => rank(a.pair!.severity) < rank(a.severity))
            ? "stronger"
            : null;
    return {
      id: ghostId,
      submittedId,
      surveyId: String(p.survey_id),
      userId: String(p.user_id),
      startedAt: iso(p.started_at)!,
      lastSavedAt: iso(p.last_saved_at),
      submittedAt: iso(p.submitted_at),
      verdict: reason ? "review" : "duplicate",
      reason,
      alerts,
    };
  });
}

/** Закрыть дубль: журнал, ссылки на сигнал сданной попытки, удаление. Внутри транзакции призрака. */
async function closeDuplicate(ghost: Ghost): Promise<{ alerts: number; cases: number }> {
  const at = new Date().toISOString();
  const full = ghost.alerts.length
    ? await db.select().from(riskAlerts).where(inArray(riskAlerts.id, ghost.alerts.map((a) => a.id)))
    : [];
  const byId = new Map(full.map((a) => [a.id, a]));
  let cases = 0;

  for (const alert of ghost.alerts) {
    const row = byId.get(alert.id)!;
    await db.update(referrals).set({ alertId: alert.pair!.id }).where(eq(referrals.alertId, alert.id));
    /*
     * Отметки об отправленных уведомлениях — на сигнал сданного прохождения,
     * как в adoptDraftAlerts: дежурному об этом ответе уже писали, и
     * рассыльщик не должен писать о нём снова. Вид, который у сигнала уже
     * есть (один на вид — уникальный индекс), перенести некуда: он уходит с
     * тревогой каскадом, а что было — остаётся в строке журнала ниже.
     */
    const moved = await db.execute(sql`
      update ${alertNotifications} set alert_id = ${alert.pair!.id}
       where alert_id = ${alert.id}
         and kind not in (select kind from ${alertNotifications} where alert_id = ${alert.pair!.id})
      returning kind`);
    const dropped = await db
      .select({ kind: alertNotifications.kind, sentAt: alertNotifications.sentAt, channel: alertNotifications.channel })
      .from(alertNotifications)
      .where(eq(alertNotifications.alertId, alert.id));
    await db.delete(riskAlerts).where(eq(riskAlerts.id, alert.id));
    /*
     * Случай, оставшийся без сигналов, — из очереди: открытым он висел бы у
     * дежурного пустой строкой. Под замком случая (как attachCaseRow): сигнал,
     * дописываемый в него в эту минуту, ждёт, а случай с ним не закрывается.
     */
    let caseClosed = false;
    if (row.caseId && row.caseId !== alert.pair!.caseId) {
      await db.execute(sql`
        select pg_advisory_xact_lock(hashtextextended('alert_case|' || c.user_id || '|' || ${caseZoneSql(surveys.groupId, surveys.createdBy)}, 0))
          from ${alertCases} c join ${surveys} on ${surveys.id} = c.survey_id
         where c.id = ${row.caseId}`);
      // автор пуст — системное действие, как у auditSystem; исход — дубль, а не клиническое решение
      const closed = await db
        .update(alertCases)
        .set({ acknowledgedAt: at, acknowledgedBy: null, outcome: "duplicate" })
        .where(
          and(
            eq(alertCases.id, row.caseId),
            isNull(alertCases.acknowledgedAt),
            notExists(db.select({ one: sql`1` }).from(riskAlerts).where(eq(riskAlerts.caseId, row.caseId))),
          ),
        )
        .returning({ id: alertCases.id });
      caseClosed = closed.length > 0;
      if (caseClosed) {
        // разбор случая — той же строкой журнала, что у дежурного (alertCases.ts, PATCH), только от системы
        await auditSystem({
          action: "alert.acknowledge",
          resourceType: "alert_case",
          resourceId: row.caseId,
          subjectUserId: ghost.userId,
          details: { outcome: "duplicate", note: null, by: "ghost-drafts", duplicateOf: alert.pair!.id },
        });
      }
    }
    /*
     * Строка журнала — в случае тревоги: там её ищут, разбирая случай. Всё,
     * что было в строке тревоги, кроме подписи (это текст пункта — он и так
     * у сигнала сданного прохождения), — здесь: строки больше нет.
     */
    await auditSystem({
      action: "alert.duplicate_closed",
      resourceType: row.caseId ?? alert.pair!.caseId ? "alert_case" : "risk_alert",
      resourceId: row.caseId ?? alert.pair!.caseId ?? row.id,
      subjectUserId: ghost.userId,
      details: {
        outcome: "duplicate",
        alertId: row.id,
        duplicateOf: alert.pair!.id,
        ghostResponseId: ghost.id,
        responseId: ghost.submittedId,
        surveyId: ghost.surveyId,
        questionId: row.questionId,
        severity: row.severity,
        raisedAt: row.at,
        caseId: row.caseId,
        acknowledgedAt: row.acknowledgedAt,
        acknowledgedBy: row.acknowledgedBy,
        previousOutcome: row.outcome,
        caseClosed,
        notificationsMoved: (moved as unknown as { kind: string }[]).map((n) => n.kind),
        notificationsDropped: dropped,
      },
    });
    if (caseClosed) cases += 1;
  }

  await db.update(referrals).set({ responseId: ghost.submittedId }).where(eq(referrals.responseId, ghost.id));
  const [answered] = (await db.execute(
    sql`select count(*)::int as n from ${answers} where ${answers.responseId} = ${ghost.id}`,
  )) as unknown as { n: number }[];
  await db.delete(responses).where(and(eq(responses.id, ghost.id), eq(responses.status, "in_progress")));
  await auditSystem({
    action: "response.ghost_removed",
    resourceType: "response",
    resourceId: ghost.id,
    subjectUserId: ghost.userId,
    details: {
      surveyId: ghost.surveyId,
      submittedId: ghost.submittedId,
      startedAt: ghost.startedAt,
      lastSavedAt: ghost.lastSavedAt,
      answers: answered?.n ?? 0,
      alerts: ghost.alerts.map((a) => a.id),
    },
  });
  // очередь и карта у открытых консолей перечитываются по событию, как после разбора
  await publish(db, { kind: "case.changed", surveyIds: [ghost.surveyId], userId: ghost.userId, at });
  return { alerts: ghost.alerts.length, cases };
}

/**
 * Найти призраков и — с apply — закрыть дубли.
 *
 * Без apply — сухой прогон: одна читающая транзакция, ничего не меняется.
 * С apply — каждый призрак своей транзакцией под замком пары и с повторной
 * сверкой: сбой одного не откатывает остальных, а призрак, в который успело
 * написать автосохранение, сверяется по тому, что в нём теперь.
 */
export async function ghostDrafts(options: { apply: boolean }): Promise<GhostReport> {
  const ghosts = await systemContext(baseDb, async () => inspect(await findPairs()));
  const report: GhostReport = { ghosts, removed: 0, closedAlerts: 0, closedCases: 0 };
  if (!options.apply) return report;

  for (const seen of ghosts.filter((g) => g.verdict === "duplicate")) {
    const done = await systemContext(baseDb, async () => {
      await lockAttempts(seen.surveyId, seen.userId);
      const [now] = await inspect(await findPairs(seen.id));
      if (!now || now.verdict !== "duplicate") return null;
      return closeDuplicate(now);
    });
    if (!done) continue;
    report.removed += 1;
    report.closedAlerts += done.alerts;
    report.closedCases += done.cases;
  }
  return report;
}
