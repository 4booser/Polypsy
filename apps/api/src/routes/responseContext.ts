import { Hono } from "hono";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { ageAt, explanationFor, t, type StoredExplanation } from "@quizzy/shared";
import type { ResponseAttempt, ResponseContext, ResponseContextSignal, ResponseSource, RuleHit, User } from "@quizzy/shared";
import { db } from "../db";
import {
  decisionRules,
  questions,
  responseScores,
  responses,
  riskAlerts,
  ruleHits,
  scales,
  surveyVersions,
  surveys,
  users,
} from "../db/schema";
import { env } from "../env";
import { alertLabelsIn } from "../lib/alertLabels";
import { audit } from "../lib/audit";
import { bandLabelsIn } from "../lib/bandLabels";
import { fullNameOf } from "../lib/auth";
import { assertClinicalRead, CLINICAL_READ } from "../lib/clinicalRead";
import { decryptField } from "../lib/crypto";
import { langOf, notFound } from "../lib/http";
import { hasPermission } from "../lib/permissions";
import { resultScope } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Обстановка вокруг протокола: кто человек, что о нём открыто, какие ещё
 * попытки этой методики он сдавал и что по этому прохождению предложили
 * правила.
 *
 * Экраны прохождения (Polypsy 2.0: протокол, графики, заключение) рисуют
 * над протоколом шапку пациента со строкой открытого — сигнал с таймером
 * разбора, переход к карточке — и переключатель попыток «19 24.08 · 16 11.09 ·
 * 14 08.10». Сам GET /api/responses/:id этого не несёт намеренно: он открыт и
 * обследуемому, а ему ни ведущий, ни таймер разбора сигналов не нужны.
 *
 * Только чтение и только персоналу: та же проверка, что у заключения
 * (lib/clinicalRead.ts — право читать данные пациентов, методика в зоне).
 * Сигналы и правила — под своими правами (alerts.review), как их собственные
 * списки: без права здесь null, а не пустой список — «сигналов нет» было бы
 * неправдой. Каждое чтение — строка журнала response.read (вид context).
 */
export const responseContextRoutes = new Hono<AppEnv>();

responseContextRoutes.use("*", requireAuth, requireStaff);

responseContextRoutes.get("/:id", requirePermission(CLINICAL_READ), async (c) => {
  const user = c.get("user");
  const lang = langOf(c);
  const response = await db.query.responses.findFirst({ where: eq(responses.id, c.req.param("id")) });
  if (!response) notFound("err.responseNotFound");
  await assertClinicalRead(c, user, response!);
  const r = response!;

  const person = r.userId ? await db.query.users.findFirst({ where: eq(users.id, r.userId) }) : undefined;
  const leadRow = person?.leadSpecialistId
    ? await db.query.users.findFirst({ where: eq(users.id, person.leadSpecialistId) })
    : undefined;

  const patient: ResponseContext["patient"] = person
    ? {
        id: person.id,
        fullName: fullNameOf(person),
        sex: person.sex ?? null,
        age: ageAt(decryptField(person.birthDate), r.submittedAt ?? r.startedAt, env.institutionTz),
        unit: person.unit ?? null,
        lead: leadRow ? { name: fullNameOf(leadRow), mine: leadRow.id === user.id } : null,
      }
    : null;

  const reviewer = await hasPermission(user, "alerts.review");
  const attempts = r.userId ? await attemptsOf(r.userId, r.surveyId, lang) : [];
  const signals = reviewer ? await signalsOf(user, r, lang) : null;
  const hits = reviewer ? await hitsOf(r.id, lang) : null;

  /*
   * Чтение клинических данных — строкой журнала, как у соседних чтений
   * (прохождение по id, динамика, хронология: response.read с видом).
   * Обстановка читает больше самого протокола — баллы и полосы всех попыток
   * методики и открытые сигналы человека по другим замерам, — и без строки
   * это было бы тихое чтение: экран зовёт её сам, без GET /responses/:id.
   * Отказ (не сотрудник, нет права, чужая зона) сюда не доходит.
   */
  await audit(c, {
    action: "response.read",
    resourceType: "response",
    resourceId: r.id,
    subjectUserId: r.userId,
    details: { view: "context", surveyId: r.surveyId, attempts: attempts.length, signals: signals?.length ?? null },
  });

  return c.json({
    source: (r.source as ResponseSource | null) ?? null,
    reliable: r.reliable,
    patient,
    attempts,
    signals,
    hits,
  } satisfies ResponseContext);
});

/**
 * Завершённые попытки методики этим человеком — по возрастанию даты.
 *
 * Баллы — по коду шкалы: id шкалы меняется с версией методики, код — нет
 * (тот же договор, что у динамики). Номер версии — рядом: ответы по пунктам
 * экран сравнивает только внутри одной версии.
 */
async function attemptsOf(userId: string, surveyId: string, lang: ReturnType<typeof langOf>): Promise<ResponseAttempt[]> {
  const rows = await db
    .select({ id: responses.id, submittedAt: responses.submittedAt, version: surveyVersions.version })
    .from(responses)
    .leftJoin(surveyVersions, eq(surveyVersions.id, responses.versionId))
    .where(and(eq(responses.userId, userId), eq(responses.surveyId, surveyId), eq(responses.status, "completed")))
    .orderBy(asc(responses.submittedAt), asc(responses.id));
  if (!rows.length) return [];
  const scoreRows = await db
    .select({
      responseId: responseScores.responseId,
      code: scales.code,
      value: responseScores.rawScore,
      scaleId: responseScores.scaleId,
      band: responseScores.bandLabel,
      severity: responseScores.severity,
      position: scales.position,
    })
    .from(responseScores)
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(inArray(responseScores.responseId, rows.map((x) => x.id)))
    .orderBy(asc(scales.position));
  // слово полосы — на языке читателя, а не на языке прохождения (lib/bandLabels.ts)
  const bandIn = await bandLabelsIn(lang, scoreRows.map((s) => s.scaleId));
  const byResponse = new Map<string, ResponseAttempt["scores"]>();
  for (const s of scoreRows) {
    const list = byResponse.get(s.responseId) ?? [];
    list.push({ code: s.code, value: s.value, band: bandIn(s.scaleId, s.band ?? null), severity: s.severity ?? null });
    byResponse.set(s.responseId, list);
  }
  return rows
    .filter((x) => x.submittedAt)
    .map((x) => ({
      id: x.id,
      submittedAt: x.submittedAt!,
      versionNumber: x.version ?? null,
      scores: byResponse.get(x.id) ?? [],
    }));
}

/**
 * Сигналы для строки открытого: все сигналы этого прохождения (и
 * разобранные — экран говорит «розібрано», а не молчит) и открытые сигналы
 * того же человека по другим замерам. Зона — та же, что у списка сигналов
 * (lib/scope.ts, resultScopeCondition): свои методики целиком, методики
 * библиотеки — о человеке зоны читающего.
 */
async function signalsOf(
  user: User,
  r: { id: string; userId: string | null },
  lang: ReturnType<typeof langOf>,
): Promise<ResponseContextSignal[]> {
  const seen = await resultScope(user);
  const reviewer = users;
  const rows = await db
    .select({
      alert: riskAlerts,
      surveyTitle: surveys.title,
      escalateMinutes: surveys.alertEscalateMinutes,
      questionTitle: questions.title,
    })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    .leftJoin(questions, eq(questions.id, riskAlerts.questionId))
    .where(
      and(
        seen(riskAlerts.surveyId, riskAlerts.userId),
        r.userId
          ? or(eq(riskAlerts.responseId, r.id), and(eq(riskAlerts.userId, r.userId), isNull(riskAlerts.acknowledgedAt)))
          : eq(riskAlerts.responseId, r.id),
      ),
    )
    .orderBy(desc(riskAlerts.at), desc(riskAlerts.id))
    .limit(50);
  const reviewerIds = rows.map((x) => x.alert.acknowledgedBy).filter((x): x is string => !!x);
  const names = new Map<string, string>();
  if (reviewerIds.length) {
    for (const u of await db.select().from(reviewer).where(inArray(reviewer.id, reviewerIds))) names.set(u.id, fullNameOf(u));
  }
  // подпись — на языке читателя: снимок записан на языке прохождения (lib/alertLabels.ts)
  const labelOf = await alertLabelsIn(lang, rows.map((x) => x.alert));
  const now = Date.now();
  return rows
    .map(({ alert: a, surveyTitle, escalateMinutes }) => {
      const until = a.acknowledgedAt ? Date.parse(a.acknowledgedAt) : now;
      const minutesOpen = Math.max(0, Math.round((until - Date.parse(a.at)) / 60_000));
      return {
        id: a.id,
        label: labelOf(a),
        severity: a.severity,
        at: a.at,
        here: a.responseId === r.id,
        questionId: a.questionId,
        surveyTitle: t(surveyTitle as never, lang),
        minutesOpen,
        escalateMinutes: escalateMinutes ?? null,
        overdue: !a.acknowledgedAt && escalateMinutes !== null && minutesOpen >= escalateMinutes,
        reviewedAt: a.acknowledgedAt,
        reviewedByName: a.acknowledgedBy ? (names.get(a.acknowledgedBy) ?? null) : null,
        outcome: a.outcome,
      };
    })
    .sort((x, y) => Number(x.reviewedAt !== null) - Number(y.reviewedAt !== null));
}

/** Срабатывания правил по этому прохождению — во всех состояниях, свежие первыми */
async function hitsOf(responseId: string, lang: ReturnType<typeof langOf>): Promise<RuleHit[]> {
  const rows = await db
    .select({ hit: ruleHits, rule: decisionRules, patient: users })
    .from(ruleHits)
    .innerJoin(decisionRules, eq(decisionRules.id, ruleHits.ruleId))
    .leftJoin(users, eq(users.id, ruleHits.userId))
    .where(eq(ruleHits.responseId, responseId))
    .orderBy(desc(ruleHits.createdAt))
    .limit(50);
  return rows.map((x) => ({
    id: x.hit.id,
    ruleTitle: x.rule.title,
    ruleVersion: x.hit.ruleVersion,
    userId: x.hit.userId,
    userName: x.patient ? fullNameOf(x.patient) : "—",
    surveyId: x.hit.surveyId,
    responseId: x.hit.responseId,
    status: x.hit.status as RuleHit["status"],
    explanation: explanationFor(x.hit.explanation as StoredExplanation, lang),
    createdAt: x.hit.createdAt,
  }));
}
