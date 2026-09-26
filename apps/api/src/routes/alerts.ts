import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { queryInt, t } from "@quizzy/shared";
import type { RiskAlert } from "@quizzy/shared";
import { db } from "../db";
import { questions, riskAlerts, scales, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { badRequestDetail, langOf, parseQuery } from "../lib/http";
import { fullNameOf } from "../lib/auth";
import { surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { z } from "zod";

export const alertRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 */
alertRoutes.use("*", requireAuth, requireStaff, requirePermission("alerts.review"));

/**
 * Параметры плоского списка — строго, как у очереди случаев.
 *
 * Список отдавал ВСЕ тревоги зоны одним ответом: на сотнях открытых случаев
 * это тысячи строк, которые никто не читает, но каждый раз расшифровывает и
 * тащит по сети (внешний разбор: «сотни карточек без пагинации»). Теперь —
 * страница с курсором; умолчание 200 оставлено щедрым, чтобы прежние
 * вызывающие без параметров получали то же, что раньше, на обычном объёме.
 */
const alertListQuery = z
  .object({
    all: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["0", "1"]).optional()),
    limit: queryInt(1, 500, 200),
    cursor: z.string().max(200).optional(),
  })
  .strict();

/** Курсор «время + идентификатор»: у тревог одного прохождения время совпадает до миллисекунды */
function decodeAlertCursor(raw: string): { at: string; id: string } {
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const [at, id] = parts;
  if (parts.length !== 2 || !at || Number.isNaN(Date.parse(at)) || !id || !/^[A-Za-z0-9-]{1,64}$/.test(id)) {
    badRequestDetail("cursor: курсор повреждён — начните список заново");
  }
  return { at: at!, id: id! };
}

/** Тревоги по методикам, доступным этому сотруднику. По умолчанию — только неразобранные. */
alertRoutes.get("/", async (c) => {
  // язык читателя: t() без него отдаёт украинский всегда
  const lang = langOf(c);
  const user = c.get("user");
  const q = parseQuery(c, alertListQuery);
  const includeAcknowledged = q.all === "1";
  const cursor = q.cursor ? decodeAlertCursor(q.cursor) : null;

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (surveyIds.length === 0) return c.json({ items: [], nextCursor: null });

  const rows = await db
    .select({
      alert: riskAlerts,
      surveyTitle: surveys.title,
      escalateMinutes: surveys.alertEscalateMinutes,
      questionTitle: questions.title,
      scaleTitle: scales.title,
      respondentFirst: users.firstName,
      respondentLast: users.lastName,
      respondentMiddle: users.middleName,
    })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    /*
     * Левое соединение, а не внутреннее: у сигнала по полосе шкалы пункта
     * нет, и внутреннее выбросило бы его из списка тревог целиком.
     */
    .leftJoin(questions, eq(questions.id, riskAlerts.questionId))
    .leftJoin(scales, eq(scales.id, riskAlerts.scaleId))
    .leftJoin(users, eq(users.id, riskAlerts.userId))
    // условия строим средствами drizzle: подстановка массива в шаблон sql``
    // зависит от драйвера и легко ломается при смене СУБД
    .where(
      and(
        inArray(riskAlerts.surveyId, surveyIds),
        includeAcknowledged ? undefined : isNull(riskAlerts.acknowledgedAt),
        cursor
          ? sql`(date_trunc('milliseconds', ${riskAlerts.at}), ${riskAlerts.id}) < (${cursor.at}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(sql`date_trunc('milliseconds', ${riskAlerts.at})`), desc(riskAlerts.id))
    .limit(q.limit + 1);

  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);

  const ackIds = page.map((r) => r.alert.acknowledgedBy).filter((id): id is string => !!id);
  const ackNames = new Map<string, string>();
  if (ackIds.length) {
    const ackRows = await db.select().from(users).where(inArray(users.id, ackIds));
    for (const u of ackRows) ackNames.set(u.id, fullNameOf(u));
  }

  const now = Date.now();
  const result: RiskAlert[] = page.map((r) => {
    /*
     * Просроченность считаем на чтении, а не фоновым заданием: правило зависит
     * только от времени и настройки методики, и лишний планировщик здесь
     * добавил бы точку отказа, ничего не дав.
     */
    const openedMs = r.alert.acknowledgedAt
      ? new Date(r.alert.acknowledgedAt).getTime() - new Date(r.alert.at).getTime()
      : now - new Date(r.alert.at).getTime();
    const minutesOpen = Math.max(0, Math.round(openedMs / 60_000));
    const overdue =
      !r.alert.acknowledgedAt &&
      r.escalateMinutes !== null &&
      minutesOpen >= r.escalateMinutes;

    return {
    id: r.alert.id,
    responseId: r.alert.responseId,
    surveyId: r.alert.surveyId,
    surveyTitle: t(r.surveyTitle as never, lang),
    questionId: r.alert.questionId,
    // у сигнала по шкале здесь стоит название шкалы: поле одно, и
    // оставлять его пустым значило бы показать тревогу без повода
    questionTitle: t((r.questionTitle ?? r.scaleTitle) as never, lang),
    userId: r.alert.userId,
    respondent: r.respondentLast ? fullNameOf({ firstName: r.respondentFirst!, lastName: r.respondentLast, middleName: r.respondentMiddle }) : null,
    label: r.alert.label,
    severity: r.alert.severity,
    at: r.alert.at,
    acknowledgedBy: r.alert.acknowledgedBy,
    outcome: r.alert.outcome,
    acknowledgedByName: r.alert.acknowledgedBy ? (ackNames.get(r.alert.acknowledgedBy) ?? null) : null,
    acknowledgedAt: r.alert.acknowledgedAt,
    note: r.alert.note,
    minutesOpen,
    overdue,
    };
  });

  /*
   * Просроченные больше не поднимаются наверх пересортировкой.
   *
   * Сортировка в приложении работала, пока список отдавался целиком. На
   * странице она наводила бы порядок среди двухсот выбранных и ничего не
   * могла бы сделать с двести первым — та же ловушка, что была у очереди
   * случаев. А в ключ курсора просроченность не берётся: она зависит от
   * текущего времени, и строка, ставшая просроченной между страницами,
   * переехала бы через границу. Порядок — по времени, пометка — на строке;
   * разбирают по очереди случаев, где просроченные считаются в SQL.
   */

  await audit(c, {
    action: "alert.list",
    details: {
      count: result.length,
      overdue: result.filter((a) => a.overdue).length,
      includeAcknowledged,
    },
  });
  const last = page[page.length - 1];
  return c.json({
    items: result,
    nextCursor:
      hasMore && last ? Buffer.from(`${last.alert.at}|${last.alert.id}`).toString("base64url") : null,
  });
});

/*
 * Разбор отдельной тревоги убран намеренно.
 *
 * Решение принимается о человеке и живёт на случае (`/api/alert-cases`).
 * Пока путей было два, один и тот же сигнал мог получить один исход в
 * составе случая и другой сам по себе — а по этим исходам калибруются
 * пороги скрининга. Два источника истины о клиническом решении недопустимы.
 *
 * Список ниже остаётся: он показывает, какие именно пункты сработали, и это
 * нужно при разборе. Но он только читает.
 */
