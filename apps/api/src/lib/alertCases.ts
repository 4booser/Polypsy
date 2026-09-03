import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alertCases, surveys } from "../db/schema";

/**
 * Открытие и продление случая риска.
 *
 * Тревога поднимается на каждый отмеченный пункт — так и надо, важно знать,
 * что именно сработало. Но разбирают не пункты, а человека: пять отмеченных
 * пунктов одного обследуемого — один случай и одно клиническое решение.
 */

/** Сколько часов новые тревоги считаются тем же эпизодом, если методика не сказала иначе */
export const DEFAULT_CASE_WINDOW_HOURS = 72;

type Tx = {
  select: (typeof import("../db").db)["select"];
  insert: (typeof import("../db").db)["insert"];
  update: (typeof import("../db").db)["update"];
  query: (typeof import("../db").db)["query"];
};

/**
 * Находит открытый случай человека по методике или заводит новый.
 *
 * Продлевается только **неразобранный** случай: если специалист уже принял
 * решение, новая тревога — это новый повод к нему вернуться, а не строка в
 * закрытой записи. Иначе разобранный случай тихо «оживал» бы, и было бы
 * непонятно, к чему относится записанный исход.
 *
 * Второе условие — окно времени. Повторное срабатывание через сутки у
 * скрининга суицидального риска и через месяц у адаптационного профиля —
 * разные вещи, поэтому окно настраивается на методике.
 */
export async function attachToCase(
  tx: Tx,
  params: {
    userId: string | null;
    surveyId: string;
    severity: "moderate" | "severe";
    at: string;
  },
): Promise<string | null> {
  // анонимное прохождение случая не заводит: разбирать некого
  if (!params.userId) return null;

  const survey = await tx.query.surveys.findFirst({
    where: eq(surveys.id, params.surveyId),
    columns: { alertCaseWindowHours: true },
  });
  const windowHours = survey?.alertCaseWindowHours ?? DEFAULT_CASE_WINDOW_HOURS;

  /*
   * Случай ищется по ЧЕЛОВЕКУ, а не по паре «человек + методика».
   *
   * Так и написано на экране разбора: «Случай — это человек, а не отдельный
   * пункт. Решение принимается один раз обо всех его сигналах». Код же
   * искал по методике тоже — и человек, у которого риск сработал по двум
   * опросникам, висел в очереди дважды и требовал двух решений. Второе
   * принималось в отрыве от первого: разбирающий мог не знать, что этот же
   * человек уже разобран.
   *
   * Окно берётся от методики нового сигнала — она и определяет, через
   * сколько повтор считается новым обращением.
   */
  const [open] = await tx
    .select({ id: alertCases.id, severity: alertCases.severity })
    .from(alertCases)
    .where(
      and(
        eq(alertCases.userId, params.userId),
        isNull(alertCases.acknowledgedAt),
        sql`${alertCases.lastAlertAt} > ${params.at}::timestamptz - make_interval(hours => ${windowHours})`,
      ),
    )
    .orderBy(desc(alertCases.lastAlertAt))
    .limit(1);

  if (open) {
    await tx
      .update(alertCases)
      .set({
        lastAlertAt: params.at,
        // случай не легче худшего своего сигнала
        ...(params.severity === "severe" && open.severity !== "severe"
          ? { severity: "severe" as const }
          : {}),
      })
      .where(eq(alertCases.id, open.id));
    return open.id;
  }

  const id = crypto.randomUUID();
  await tx.insert(alertCases).values({
    id,
    userId: params.userId,
    surveyId: params.surveyId,
    openedAt: params.at,
    lastAlertAt: params.at,
    severity: params.severity,
  });
  return id;
}
