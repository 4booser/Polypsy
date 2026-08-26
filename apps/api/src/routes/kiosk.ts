import { Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  createKioskSessionSchema,
  kioskJoinSchema,
  submitResponseSchema,
  t,
  type Administration,
  type KioskSession,
  type KioskState,
} from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import {
  batteries,
  batteryAssignments,
  batteryItems,
  kioskParticipants,
  kioskSessions,
  responses,
  surveyAccess,
  surveys,
  users,
} from "../db/schema";
import { audit, auditSystem } from "../lib/audit";
import { fullNameOf, hashPassword } from "../lib/auth";
import { encryptPersonFields } from "../lib/crypto";
import { badRequest, langOf, notFound, parseBody } from "../lib/http";
import { hashInviteToken, newInviteToken } from "../lib/invites";
import { assertGroupAccess } from "../lib/scope";
import { persistSubmission } from "../lib/submission";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";
import { isPast } from "../lib/time";

export const kioskRoutes = new Hono<AppEnv>();

/* ═══════════ Устройство киоска: доступ по токену сеанса ═══════════ */

// у устройства нет пользователя — конвейер работает в системном контексте RLS
kioskRoutes.use("/state/*", async (_c, next) => {
  await systemContext(baseDb, () => next());
});

async function findSession(token: string) {
  const row = await db.query.kioskSessions.findFirst({
    where: eq(kioskSessions.tokenHash, hashInviteToken(token)),
  });
  if (!row) return { row: null, reason: "unknown" as const };
  if (row.closedAt) return { row: null, reason: "closed" as const };
  if (isPast(row.expiresAt)) return { row: null, reason: "expired" as const };
  return { row, reason: null };
}

async function sessionSteps(batteryId: string, lang: "uk" | "ru") {
  const rows = await db
    .select({ item: batteryItems, survey: surveys })
    .from(batteryItems)
    .innerJoin(surveys, eq(surveys.id, batteryItems.surveyId))
    .where(eq(batteryItems.batteryId, batteryId))
    .orderBy(batteryItems.position);
  const steps = [];
  for (const r of rows) {
    const full = await getSurvey(r.item.surveyId, null, lang);
    steps.push({
      surveyId: r.item.surveyId,
      title: t(r.survey.title as never, lang),
      questionCount: full?.questions.filter((q) => q.type !== "info").length ?? 0,
      required: r.item.required,
      administration: r.survey.administration as Administration,
    });
  }
  return steps;
}

kioskRoutes.get("/state/:token", async (c) => {
  const { row, reason } = await findSession(c.req.param("token"));
  if (!row) return c.json<KioskState>({ valid: false, reason: reason ?? "unknown" });
  const battery = await db.query.batteries.findFirst({ where: eq(batteries.id, row.batteryId) });
  return c.json<KioskState>({
    valid: true,
    title: row.title,
    batteryTitle: battery?.title ?? "",
    steps: await sessionSteps(row.batteryId, langOf(c)),
  });
});

/**
 * Вход участника: создаётся учётная запись без пригодного пароля — участник
 * группового обследования не логинится сам, его данные ведёт специалист.
 * Синтетический email нужен только уникальности; наружу он не показывается.
 */
kioskRoutes.post("/state/:token/join", async (c) => {
  const { row } = await findSession(c.req.param("token"));
  if (!row) notFound("Сеанс не действует");
  const input = await parseBody(c.req.raw, kioskJoinSchema);

  const userId = crypto.randomUUID();
  const participantId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email: `kiosk-${userId}@kiosk.local`,
      ...encryptPersonFields({
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        middleName: input.middleName?.trim() || null,
        birthDate: input.birthDate ?? null,
      }),
      sex: input.sex ?? null,
      unit: input.unit ?? null,
      // случайный хеш: под этим аккаунтом нельзя войти — пароль не существует
      passwordHash: await hashPassword(crypto.randomUUID() + crypto.randomUUID()),
      role: "user",
    });
    await tx.insert(kioskParticipants).values({ id: participantId, sessionId: row.id, userId });

    const items = await tx.select().from(batteryItems).where(eq(batteryItems.batteryId, row.batteryId));
    await tx.insert(batteryAssignments).values({
      id: crypto.randomUUID(),
      batteryId: row.batteryId,
      userId,
      assignedBy: row.createdBy,
      note: `Киоск «${row.title}»`,
    });
    await tx
      .insert(surveyAccess)
      .values(
        items.map((item) => ({
          surveyId: item.surveyId,
          userId,
          grantedBy: row.createdBy,
          note: `Киоск «${row.title}»`,
        })),
      )
      .onConflictDoNothing();
  });

  await auditSystem({
    action: "kiosk.join",
    resourceType: "kiosk_session",
    resourceId: row.id,
    subjectUserId: userId,
    details: { sessionTitle: row.title },
  });

  return c.json({ participantId, userId }, 201);
});

/** Контент методики для раннера киоска */
kioskRoutes.get("/state/:token/surveys/:surveyId", async (c) => {
  const { row } = await findSession(c.req.param("token"));
  if (!row) notFound("Сеанс не действует");
  const surveyId = c.req.param("surveyId");
  const items = await db
    .select()
    .from(batteryItems)
    .where(and(eq(batteryItems.batteryId, row.batteryId), eq(batteryItems.surveyId, surveyId)));
  if (!items.length) notFound("Методика не входит в сеанс");
  const survey = await getSurvey(surveyId, null, langOf(c));
  if (!survey) notFound("Методика не найдена");
  return c.json(survey);
});

/** Сдача от имени участника: тот же конвейер, что и обычная сдача */
kioskRoutes.post("/state/:token/submit", async (c) => {
  const { row } = await findSession(c.req.param("token"));
  if (!row) notFound("Сеанс не действует");

  const body = await c.req.json();
  const participantId = typeof body?.participantId === "string" ? body.participantId : "";
  const surveyId = typeof body?.surveyId === "string" ? body.surveyId : "";
  const input = submitResponseSchema.parse(body);

  const participant = await db.query.kioskParticipants.findFirst({
    where: and(eq(kioskParticipants.id, participantId), eq(kioskParticipants.sessionId, row.id)),
  });
  if (!participant) notFound("Участник не найден в этом сеансе");

  const inBattery = await db
    .select()
    .from(batteryItems)
    .where(and(eq(batteryItems.batteryId, row.batteryId), eq(batteryItems.surveyId, surveyId)));
  if (!inBattery.length) badRequest("Методика не входит в сеанс");

  const survey = await getSurvey(surveyId, null, langOf(c));
  if (!survey) notFound("Методика не найдена");
  if (survey.administration !== "self") badRequest("Методику заполняет специалист — на киоске она недоступна");

  const subject = (await db.query.users.findFirst({ where: eq(users.id, participant.userId) }))!;
  const result = await persistSubmission(survey, subject, input, {
    filledBySelf: true,
    lang: langOf(c),
  });

  // участник закончил, если закрылось назначение батареи
  const [assignment] = await db
    .select()
    .from(batteryAssignments)
    .where(
      and(
        eq(batteryAssignments.userId, participant.userId),
        eq(batteryAssignments.batteryId, row.batteryId),
        isNull(batteryAssignments.cancelledAt),
      ),
    );
  if (assignment?.completedAt && !participant.finishedAt) {
    await db
      .update(kioskParticipants)
      .set({ finishedAt: new Date().toISOString() })
      .where(eq(kioskParticipants.id, participant.id));
  }

  await auditSystem({
    action: "kiosk.submit",
    resourceType: "response",
    resourceId: result.responseId,
    subjectUserId: participant.userId,
    details: { sessionId: row.id, surveyId },
  });

  return c.json(
    {
      id: result.responseId,
      finished: !!assignment?.completedAt,
      reliable: result.profile.reliable,
      warnings: result.profile.warnings,
      safetyPlan: result.risksTriggered > 0 ? survey.safetyPlan : null,
    },
    201,
  );
});

/* ═══════════ Консоль: управление сеансами ═══════════ */

kioskRoutes.use("/sessions", requireAuth, requireStaff);
kioskRoutes.use("/sessions/*", requireAuth, requireStaff);

async function assertSessionBattery(user: Parameters<typeof assertGroupAccess>[0], batteryId: string) {
  const battery = await db.query.batteries.findFirst({ where: eq(batteries.id, batteryId) });
  if (!battery) notFound("Батарея не найдена");
  if (battery.groupId) await assertGroupAccess(user, battery.groupId);
  return battery;
}

kioskRoutes.post("/sessions", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, createKioskSessionSchema);
  const battery = await assertSessionBattery(user, input.batteryId);
  if (battery.archived) badRequest("Батарея в архиве");

  const rawToken = newInviteToken();
  const id = crypto.randomUUID();
  await db.insert(kioskSessions).values({
    id,
    tokenHash: hashInviteToken(rawToken),
    title: input.title,
    batteryId: input.batteryId,
    createdBy: user.id,
    expiresAt: new Date(Date.now() + (input.ttlHours ?? 8) * 3_600_000).toISOString(),
  });

  await audit(c, {
    action: "kiosk.session_create",
    resourceType: "kiosk_session",
    resourceId: id,
    details: { title: input.title, batteryId: input.batteryId, ttlHours: input.ttlHours ?? 8 },
  });
  // токен показывается один раз — как у приглашений
  return c.json({ id, token: rawToken }, 201);
});

kioskRoutes.get("/sessions", async (c) => {
  const user = c.get("user");
  const rows = await db.select().from(kioskSessions).orderBy(desc(kioskSessions.createdAt));

  const visible: (typeof kioskSessions.$inferSelect)[] = [];
  for (const row of rows) {
    try {
      await assertSessionBattery(user, row.batteryId);
      visible.push(row);
    } catch {
      /* чужие сеансы скрыты */
    }
  }

  const batteryIds = [...new Set(visible.map((r) => r.batteryId))];
  const batteryRows = batteryIds.length
    ? await db.select().from(batteries).where(inArray(batteries.id, batteryIds))
    : [];
  const titleOf = new Map(batteryRows.map((b) => [b.id, b.title]));

  const creators = await db
    .select()
    .from(users)
    .where(inArray(users.id, [...new Set(visible.map((r) => r.createdBy))]));
  const creatorOf = new Map(creators.map((u) => [u.id, fullNameOf(u)]));

  const result: KioskSession[] = [];
  for (const row of visible) {
    result.push({
      id: row.id,
      title: row.title,
      batteryId: row.batteryId,
      batteryTitle: titleOf.get(row.batteryId) ?? "—",
      expiresAt: row.expiresAt,
      closedAt: row.closedAt,
      createdAt: row.createdAt,
      createdByName: creatorOf.get(row.createdBy) ?? "—",
      participants: await participantStates(row.id, row.batteryId),
    });
  }
  return c.json(result);
});

async function participantStates(sessionId: string, batteryId: string) {
  const rows = await db
    .select({ p: kioskParticipants, u: users })
    .from(kioskParticipants)
    .innerJoin(users, eq(users.id, kioskParticipants.userId))
    .where(eq(kioskParticipants.sessionId, sessionId))
    .orderBy(desc(kioskParticipants.startedAt));
  if (!rows.length) return [];

  const required = await db
    .select()
    .from(batteryItems)
    .where(and(eq(batteryItems.batteryId, batteryId), eq(batteryItems.required, true)));
  const done = await db
    .select({ userId: responses.userId, surveyId: responses.surveyId })
    .from(responses)
    .where(
      and(
        inArray(responses.userId, rows.map((r) => r.u.id)),
        inArray(responses.surveyId, required.map((i) => i.surveyId)),
        eq(responses.status, "completed"),
      ),
    );

  return rows.map((r) => ({
    id: r.p.id,
    displayName: fullNameOf(r.u),
    startedAt: r.p.startedAt,
    finishedAt: r.p.finishedAt,
    doneRequired: new Set(done.filter((d) => d.userId === r.u.id).map((d) => d.surveyId)).size,
    totalRequired: required.length,
  }));
}

kioskRoutes.post("/sessions/:id/close", async (c) => {
  const user = c.get("user");
  const row = await db.query.kioskSessions.findFirst({ where: eq(kioskSessions.id, c.req.param("id")) });
  if (!row) notFound("Сеанс не найден");
  await assertSessionBattery(user, row.batteryId);

  await db.update(kioskSessions).set({ closedAt: new Date().toISOString() }).where(eq(kioskSessions.id, row.id));
  await audit(c, {
    action: "kiosk.session_close",
    resourceType: "kiosk_session",
    resourceId: row.id,
    details: { title: row.title },
  });
  return c.json({ ok: true });
});
