import { Hono } from "hono";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  ageAt,
  createReferralSchema,
  reliableChange,
  t,
  updateReferralSchema,
  type CaseSummary,
  type Referral,
  type ScaleNormalization,
  type Severity,
  type Sex,
} from "@quizzy/shared";
import { db } from "../db";
import {
  conclusions,
  referrals,
  responseScores,
  responses,
  riskAlerts,
  scales,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField } from "../lib/crypto";
import { badRequest, notFound, parseBody } from "../lib/http";
import { round, variance } from "../lib/stats";
import { surveyScopeFilter } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const referralRoutes = new Hono<AppEnv>();

referralRoutes.use("*", requireAuth, requireStaff);

/** Статусы движутся вперёд: принятое направление нельзя «отменить» задним числом */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  created: ["accepted", "declined"],
  accepted: ["completed", "declined"],
  completed: [],
  declined: [],
};

async function serialize(rows: (typeof referrals.$inferSelect)[]): Promise<Referral[]> {
  if (!rows.length) return [];
  const ids = [...new Set([...rows.map((r) => r.userId), ...rows.map((r) => r.createdBy)])];
  const people = await db.select().from(users).where(inArray(users.id, ids));
  const nameOf = new Map(people.map((u) => [u.id, fullNameOf(u)]));
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    userName: nameOf.get(r.userId) ?? "—",
    responseId: r.responseId,
    alertId: r.alertId,
    destination: r.destination,
    urgency: r.urgency,
    status: r.status,
    reason: r.reason,
    outcomeNote: r.outcomeNote,
    createdByName: nameOf.get(r.createdBy) ?? "—",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** Направления в зоне ответственности: открытые сверху */
referralRoutes.get("/", async (c) => {
  const all = c.req.query("all") === "1";
  const rows = await db
    .select()
    .from(referrals)
    .where(all ? undefined : ne(referrals.status, "completed"))
    .orderBy(desc(referrals.createdAt))
    .limit(200);

  await audit(c, { action: "referral.list", details: { count: rows.length, all } });
  return c.json(await serialize(rows));
});

referralRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, createReferralSchema);

  const target = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!target) notFound("Пациент не найден");
  if (target.role !== "user") badRequest("Направление выписывается пациенту");

  const id = crypto.randomUUID();
  await db.insert(referrals).values({
    id,
    userId: input.userId,
    responseId: input.responseId ?? null,
    alertId: input.alertId ?? null,
    destination: input.destination,
    urgency: input.urgency ?? "routine",
    reason: input.reason ?? null,
    createdBy: user.id,
  });

  await audit(c, {
    action: "referral.create",
    resourceType: "referral",
    resourceId: id,
    subjectUserId: input.userId,
    details: { destination: input.destination, urgency: input.urgency ?? "routine" },
  });
  const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
  return c.json((await serialize([row!]))[0], 201);
});

referralRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await db.query.referrals.findFirst({ where: eq(referrals.id, id) });
  if (!existing) notFound("Направление не найдено");

  const input = await parseBody(c.req.raw, updateReferralSchema);
  if (!ALLOWED_TRANSITIONS[existing.status]?.includes(input.status)) {
    badRequest(
      `Из состояния «${existing.status}» нельзя перейти в «${input.status}»: история направления не переписывается`,
    );
  }

  await db
    .update(referrals)
    .set({
      status: input.status,
      outcomeNote: input.outcomeNote ?? existing.outcomeNote,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(referrals.id, id));

  await audit(c, {
    action: "referral.update",
    resourceType: "referral",
    resourceId: id,
    subjectUserId: existing.userId,
    details: { from: existing.status, to: input.status },
  });
  const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
  return c.json((await serialize([row!]))[0]);
});

/**
 * Сводка для консилиума (6.5).
 *
 * Всё о пациенте на одной странице: последние баллы с достоверностью сдвига,
 * открытые тревоги, подписанные заключения, направления. Собирается из уже
 * существующих кусков — новизна здесь не в данных, а в том, что их не надо
 * собирать по семи экранам за минуту до заседания.
 */
referralRoutes.get("/summary/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");

  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("Пациент не найден");

  const scope = await surveyScopeFilter(staff);
  const scoped = await db.select().from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) notFound("Пациент не найден");

  const own = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.userId, userId),
        eq(responses.status, "completed"),
        inArray(responses.surveyId, surveyIds),
      ),
    )
    .orderBy(responses.submittedAt);

  const scoreRows = own.length
    ? await db
        .select({ score: responseScores, code: scales.code, title: scales.title, kind: scales.kind })
        .from(responseScores)
        .innerJoin(scales, eq(scales.id, responseScores.scaleId))
        .where(inArray(responseScores.responseId, own.map((r) => r.id)))
    : [];

  const bySurvey = new Map<string, typeof own>();
  for (const r of own) {
    const list = bySurvey.get(r.surveyId) ?? [];
    list.push(r);
    bySurvey.set(r.surveyId, list);
  }

  const summarySurveys: CaseSummary["surveys"] = [...bySurvey.entries()].map(([surveyId, list]) => {
    const survey = scoped.find((s) => s.id === surveyId)!;
    const responseIds = new Set(list.map((r) => r.id));
    const own2 = scoreRows.filter((s) => responseIds.has(s.score.responseId) && s.kind === "clinical");

    const byCode = new Map<string, typeof own2>();
    for (const s of own2) {
      const arr = byCode.get(s.code) ?? [];
      arr.push(s);
      byCode.set(s.code, arr);
    }

    return {
      surveyId,
      title: t(survey.title as never, "ru"),
      lastAt: list[list.length - 1]?.submittedAt ?? null,
      count: list.length,
      scales: [...byCode.entries()].map(([code, rows]) => {
        // порядок замеров — по времени сдачи
        const ordered = rows
          .map((r) => ({ ...r, at: list.find((x) => x.id === r.score.responseId)?.submittedAt ?? "" }))
          .sort((a, b) => a.at.localeCompare(b.at));
        const first = ordered[0]!;
        const last = ordered[ordered.length - 1]!;

        // RCI: SD по всей выборке шкалы, надёжность консервативно 0.8 —
        // точная альфа считается в аналитике, здесь важен порядок величины
        let rc: CaseSummary["surveys"][number]["scales"][number]["reliableChange"] = null;
        if (ordered.length >= 2) {
          const sample = scoreRows.filter((s) => s.code === code).map((s) => s.score.value);
          const sd = Math.sqrt(variance(sample));
          const computed = reliableChange(first.score.value, last.score.value, sd, 0.8);
          if (computed) {
            rc = { rci: computed.rci, significant: computed.significant, direction: computed.direction };
          }
        }

        return {
          code,
          title: t(last.title as never, "ru"),
          lastValue: round(last.score.value, 2),
          normalization: last.score.normalization as ScaleNormalization,
          bandLabel: last.score.bandLabel,
          severity: last.score.severity as Severity | null,
          reliableChange: rc,
        };
      }),
    };
  });

  const alertRows = await db
    .select({ alert: riskAlerts, surveyTitle: surveys.title })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    .where(and(eq(riskAlerts.userId, userId), inArray(riskAlerts.surveyId, surveyIds)))
    .orderBy(desc(riskAlerts.at))
    .limit(20);

  const conclusionRows = own.length
    ? await db
        .select({ row: conclusions, author: users, surveyId: responses.surveyId })
        .from(conclusions)
        .innerJoin(responses, eq(responses.id, conclusions.responseId))
        .leftJoin(users, eq(users.id, conclusions.signedBy))
        .where(
          and(
            inArray(conclusions.responseId, own.map((r) => r.id)),
            eq(conclusions.status, "signed"),
          ),
        )
        .orderBy(desc(conclusions.version))
    : [];

  const referralRows = await db
    .select()
    .from(referrals)
    .where(eq(referrals.userId, userId))
    .orderBy(desc(referrals.createdAt));

  const summary: CaseSummary = {
    userId,
    fullName: fullNameOf(patient),
    sex: patient.sex as Sex | null,
    age: ageAt(decryptField(patient.birthDate), new Date().toISOString()),
    unit: patient.unit,
    surveys: summarySurveys,
    openAlerts: alertRows
      .filter((a) => !a.alert.acknowledgedAt)
      .map((a) => ({
        id: a.alert.id,
        label: a.alert.label,
        severity: a.alert.severity,
        at: a.alert.at,
        surveyTitle: t(a.surveyTitle as never, "ru"),
      })),
    conclusions: conclusionRows.map((c2) => ({
      responseId: c2.row.responseId,
      surveyTitle: t(scoped.find((s) => s.id === c2.surveyId)?.title as never, "ru"),
      text: decryptField(c2.row.text) ?? "",
      signedAt: c2.row.signedAt,
      authorName: c2.author ? fullNameOf(c2.author) : "—",
    })),
    referrals: await serialize(referralRows),
  };

  // сводка — доступ ко всей карте пациента разом, самое чувствительное чтение
  await audit(c, {
    action: "response.read",
    resourceType: "respondent",
    resourceId: userId,
    subjectUserId: userId,
    details: { view: "case_summary", surveys: summary.surveys.length },
  });

  return c.json(summary);
});
