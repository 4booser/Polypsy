import { eq, sql } from "drizzle-orm";
import { t } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { surveys } from "../db/schema";
import { auditSystem } from "./audit";

/**
 * Физическая чистка методики: что уйдёт, что останется, и сама чистка.
 *
 * Логика вынесена из скрипта (src/surveyPurge.ts) сюда, потому что её надо
 * проверять тестом: прежняя редакция жила только в скрипте, и три её ошибки
 * (клиническое ревью волны 12) не ловил никто.
 *
 *  1. Чистка методики А уносила тревоги методики Б. Случай собирает сигналы
 *     разных методик одной зоны и держится за ту, с которой начался; каскад
 *     по alert_cases.survey_id уносил случай, а по risk_alerts.case_id — все
 *     сигналы в нём. Сводка «будет уничтожено» их не считала. Теперь такой
 *     случай ДО удаления переносится на оставшиеся сигналы, сводка называет
 *     их отдельной строкой «сохраняются», а внешний ключ case_id больше не
 *     каскадный (миграция 0107) — промахнись перенос, база откажет, а не
 *     унесёт молча.
 *  2. Запись в журнал шла ДО удаления, и удаление падало на подписанном
 *     заключении (триггер неизменяемости) — в журнале оставалась чистка,
 *     которой не было. Теперь подписанные заключения — отказ до начала, а
 *     удаление и запись журнала — одна транзакция: либо обе, либо ни одной.
 *  3. Скрипт шёл без контекста базы. Под боевой ролью политики строк без
 *     контекста не отдают ничего, и методика «не находилась». Теперь и
 *     сводка, и чистка — под системным контекстом (systemContext).
 */

export interface PurgePlan {
  surveyId: string;
  title: string;
  archivedAt: string | null;
  /** Уничтожается вместе с методикой */
  responses: number;
  alerts: number;
  assignments: number;
  conclusions: number;
  ruleHits: number;
  /** Случаи, в которых нет ничего, кроме сигналов этой методики, — уходят */
  casesRemoved: number;
  /** Случаи, начатые этой методикой, где есть сигналы других, — переносятся на них */
  casesMoved: number;
  /** Сигналы ДРУГИХ методик внутри этих случаев — сохраняются */
  keptSignals: number;
  /** Подписанные заключения по прохождениям этой методики — пока они есть, чистка невозможна */
  signedConclusions: number;
}

export class PurgeRefused extends Error {}

const count = async (q: ReturnType<typeof sql>) =>
  Number(((await db.execute(q)) as unknown as { n: number }[])[0]?.n ?? 0);

/** Сводка: что уйдёт и что останется. Под системным контекстом — см. п. 3 */
export function purgePlan(id: string): Promise<PurgePlan | null> {
  return systemContext(baseDb, () => planOf(id));
}

async function planOf(id: string): Promise<PurgePlan | null> {
  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  if (!survey) return null;
  return {
    surveyId: id,
    title: t(survey.title as never),
    archivedAt: survey.archivedAt,
    responses: await count(sql`select count(*)::int as n from responses where survey_id = ${id}`),
    alerts: await count(sql`select count(*)::int as n from risk_alerts where survey_id = ${id}`),
    assignments: await count(sql`select count(*)::int as n from survey_access where survey_id = ${id}`),
    conclusions: await count(sql`select count(*)::int as n from conclusions c
      join responses r on r.id = c.response_id where r.survey_id = ${id}`),
    ruleHits: await count(sql`select count(*)::int as n from rule_hits where survey_id = ${id}`),
    casesRemoved: await count(sql`select count(*)::int as n from alert_cases ac
      where ac.survey_id = ${id}
        and not exists (select 1 from risk_alerts ra where ra.case_id = ac.id and ra.survey_id <> ${id})`),
    casesMoved: await count(sql`select count(*)::int as n from alert_cases ac
      where ac.survey_id = ${id}
        and exists (select 1 from risk_alerts ra where ra.case_id = ac.id and ra.survey_id <> ${id})`),
    keptSignals: await count(sql`select count(*)::int as n from risk_alerts ra
      join alert_cases ac on ac.id = ra.case_id
      where ac.survey_id = ${id} and ra.survey_id <> ${id}`),
    signedConclusions: await count(sql`select count(*)::int as n from conclusions c
      join responses r on r.id = c.response_id where r.survey_id = ${id} and c.status = 'signed'`),
  };
}

/**
 * Чистка. Отказ (PurgeRefused) — до первого изменения; всё остальное — одной
 * транзакцией под системным контекстом, журнал в той же транзакции.
 */
export function purgeSurvey(id: string, confirmTitle: string): Promise<PurgePlan> {
  return systemContext(baseDb, async () => {
    const plan = await planOf(id);
    if (!plan) throw new PurgeRefused(`Методика ${id} не найдена`);
    // снятие с использования — обязательный предварительный шаг: между решением
    // и необратимым действием должен быть промежуток, в котором можно передумать
    if (!plan.archivedAt) throw new PurgeRefused(`«${plan.title}» в работе. Сначала снимите её с использования в консоли.`);
    if (confirmTitle !== plan.title) throw new PurgeRefused("Название не совпало — чистка не начата.");
    /*
     * Подписанное заключение неизменяемо (триггер 0015), и удалить его вместе
     * с прохождением база не даст. Узнавать об этом посреди чистки — значит
     * получить откат и, в прежней редакции, запись журнала о том, чего не было.
     */
    if (plan.signedConclusions) {
      throw new PurgeRefused(
        `Есть подписанные заключения по этой методике: ${plan.signedConclusions}. Подписанное заключение — документ; чистка невозможна, пока оно есть.`,
      );
    }

    /*
     * Случаи, которые переживут чистку, — те, где есть сигналы других
     * методик. Они переходят на самую раннюю из оставшихся: зона та же (случай
     * собирает сигналы одной зоны, см. lib/alertCases.ts), значит, видимость
     * случая не меняется. Тяжесть и время — по оставшимся сигналам: сигналы
     * этой методики исчезнут, и случай не должен выглядеть тяжелее или
     * старше того, что в нём останется.
     */
    await db.execute(sql`
      update alert_cases ac
      set survey_id = x.survey_id, opened_at = x.first_at, last_alert_at = x.last_at, severity = x.severity
      from (
        select ra.case_id,
               (array_agg(ra.survey_id order by ra.at, ra.id))[1] as survey_id,
               min(ra.at) as first_at,
               max(ra.at) as last_at,
               case when bool_or(ra.severity = 'severe') then 'severe' else 'moderate' end as severity
        from risk_alerts ra
        join alert_cases c on c.id = ra.case_id
        where c.survey_id = ${id} and ra.survey_id <> ${id}
        group by ra.case_id
      ) x
      where ac.id = x.case_id`);

    // случаи других методик, из которых уйдут сигналы этой, — пересчитать после
    const touched = (
      (await db.execute(sql`select distinct ra.case_id as id from risk_alerts ra
        join alert_cases c on c.id = ra.case_id
        where ra.survey_id = ${id} and c.survey_id <> ${id}`)) as unknown as { id: string }[]
    ).map((r) => r.id);

    await db.delete(surveys).where(eq(surveys.id, id));

    if (touched.length) {
      const ids = sql.join(
        touched.map((x) => sql`${x}`),
        sql`, `,
      );
      await db.execute(sql`
        update alert_cases ac
        set last_alert_at = x.last_at, severity = x.severity
        from (
          select ra.case_id, max(ra.at) as last_at,
                 case when bool_or(ra.severity = 'severe') then 'severe' else 'moderate' end as severity
          from risk_alerts ra where ra.case_id in (${ids}) group by ra.case_id
        ) x
        where ac.id = x.case_id`);
    }

    const startedAt = new Date(Date.now() - 1000).toISOString();
    await auditSystem({
      action: "survey.purge",
      resourceType: "survey",
      resourceId: id,
      details: {
        title: plan.title,
        archivedAt: plan.archivedAt,
        responses: plan.responses,
        alerts: plan.alerts,
        assignments: plan.assignments,
        conclusions: plan.conclusions,
        ruleHits: plan.ruleHits,
        casesRemoved: plan.casesRemoved,
        casesMoved: plan.casesMoved,
        keptSignals: plan.keptSignals,
      },
    });
    /*
     * auditSystem глотает свою ошибку (фоновым проходам так и надо). Чистке
     * нет: необратимое действие без следа в журнале — ровно то, от чего
     * журнал заведён. Запись проверяется в той же транзакции, и без неё всё
     * откатывается.
     */
    const logged = await count(sql`select count(*)::int as n from audit_log
      where action = 'survey.purge' and resource_id = ${id} and at >= ${startedAt}::timestamptz`);
    if (!logged) throw new Error("Запись о чистке не легла в журнал — чистка отменена.");
    return plan;
  });
}
