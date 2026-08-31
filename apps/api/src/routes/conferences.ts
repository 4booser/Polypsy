import { Hono } from "hono";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { caseConferences, conferenceOpinions, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { badRequest, notFound, parseBody } from "../lib/http";
import { accessiblePatientIds } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";
import type { User } from "@quizzy/shared";

export const conferenceRoutes = new Hono<AppEnv>();
conferenceRoutes.use("*", requireAuth, requireStaff);

/**
 * Консилиум по случаю.
 *
 * Решение принимали в кабинете и записывали в тетрадь; через полгода
 * восстановить, кто что предлагал и почему решили именно так, было
 * невозможно.
 *
 * Особое мнение хранится отдельным видом записи, а не примечанием к общему
 * протоколу: в клинике несогласие участника должно быть видно, иначе
 * протокол выглядит единогласным, каким он не был.
 */

async function assertPatient(staff: User, userId: string) {
  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("err.patientNotFound");
}

async function load(conferenceId: string) {
  const [row] = await db
    .select({ conference: caseConferences, patient: users })
    .from(caseConferences)
    .leftJoin(users, eq(users.id, caseConferences.userId))
    .where(eq(caseConferences.id, conferenceId));
  return row;
}

async function opinionsOf(conferenceIds: string[]) {
  if (!conferenceIds.length) return [];
  return db
    .select({ opinion: conferenceOpinions, author: users })
    .from(conferenceOpinions)
    .leftJoin(users, eq(users.id, conferenceOpinions.authorId))
    .where(inArray(conferenceOpinions.conferenceId, conferenceIds))
    .orderBy(asc(conferenceOpinions.createdAt));
}

conferenceRoutes.get("/patients/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");
  await assertPatient(staff, userId);

  const rows = await db
    .select({ conference: caseConferences, decidedBy: users })
    .from(caseConferences)
    .leftJoin(users, eq(users.id, caseConferences.decidedBy))
    .where(eq(caseConferences.userId, userId))
    .orderBy(desc(caseConferences.createdAt));

  const opinions = await opinionsOf(rows.map((r) => r.conference.id));

  return c.json({
    items: rows.map(({ conference, decidedBy }) => ({
      id: conference.id,
      reason: conference.reason,
      status: conference.status,
      decision: conference.decision ? decryptField(conference.decision) : null,
      decidedAt: conference.decidedAt,
      decidedByName: decidedBy ? fullNameOf(decidedBy) : null,
      createdAt: conference.createdAt,
      opinions: opinions
        .filter((o) => o.opinion.conferenceId === conference.id)
        .map(({ opinion, author }) => ({
          id: opinion.id,
          kind: opinion.kind,
          text: decryptField(opinion.text) ?? "",
          authorName: author ? fullNameOf(author) : "—",
          createdAt: opinion.createdAt,
        })),
    })),
  });
});

conferenceRoutes.post("/patients/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");
  await assertPatient(staff, userId);

  const input = await parseBody(c.req.raw, z.object({ reason: z.string().min(1).max(500) }));

  const id = crypto.randomUUID();
  await db.insert(caseConferences).values({
    id,
    userId,
    reason: input.reason.trim(),
    createdBy: staff.id,
  });

  await audit(c, {
    action: "conference.open",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { conferenceId: id },
  });

  return c.json({ id }, 201);
});

conferenceRoutes.post("/:id/opinions", async (c) => {
  const staff = c.get("user");
  const row = await load(c.req.param("id"));
  if (!row) notFound("err.conferenceNotFound");
  await assertPatient(staff, row.conference.userId);
  if (row.conference.status !== "open") badRequest("err.conferenceClosed");

  const input = await parseBody(
    c.req.raw,
    z.object({ text: z.string().min(1).max(4000), kind: z.enum(["opinion", "dissent"]).optional() }),
  );

  /*
   * Одно мнение каждого вида от одного участника. Второе — это правка, а не
   * новое мнение: протокол, в котором один человек высказался трижды,
   * читается как спор с самим собой.
   */
  const [saved] = await db
    .insert(conferenceOpinions)
    .values({
      id: crypto.randomUUID(),
      conferenceId: row.conference.id,
      authorId: staff.id,
      kind: input.kind ?? "opinion",
      text: encryptField(input.text)!,
    })
    .onConflictDoUpdate({
      target: [conferenceOpinions.conferenceId, conferenceOpinions.authorId, conferenceOpinions.kind],
      set: { text: encryptField(input.text)!, createdAt: new Date().toISOString() },
    })
    .returning({ id: conferenceOpinions.id });

  await audit(c, {
    action: "conference.opinion",
    resourceType: "user",
    resourceId: row.conference.userId,
    subjectUserId: row.conference.userId,
    details: { conferenceId: row.conference.id, kind: input.kind ?? "opinion" },
  });

  return c.json({ id: saved!.id }, 201);
});

conferenceRoutes.post("/:id/decide", async (c) => {
  const staff = c.get("user");
  const row = await load(c.req.param("id"));
  if (!row) notFound("err.conferenceNotFound");
  await assertPatient(staff, row.conference.userId);
  if (row.conference.status !== "open") badRequest("err.conferenceClosed");

  const input = await parseBody(
    c.req.raw,
    z.object({ decision: z.string().min(1).max(4000), cancel: z.boolean().optional() }),
  );

  const opinions = await opinionsOf([row.conference.id]);
  /*
   * Решение без единого мнения — это не консилиум, а запись одного человека.
   * Такую следует делать заметкой приёма, и отказ здесь честнее, чем
   * протокол, в котором никто не высказался.
   */
  if (!opinions.length && !input.cancel) badRequest("err.noOpinionsExpressed");

  await db
    .update(caseConferences)
    .set({
      status: input.cancel ? "cancelled" : "decided",
      decision: encryptField(input.decision)!,
      decidedAt: new Date().toISOString(),
      decidedBy: staff.id,
    })
    .where(eq(caseConferences.id, row.conference.id));

  await audit(c, {
    action: "conference.decide",
    resourceType: "user",
    resourceId: row.conference.userId,
    subjectUserId: row.conference.userId,
    details: {
      conferenceId: row.conference.id,
      opinions: opinions.length,
      dissents: opinions.filter((o) => o.opinion.kind === "dissent").length,
    },
  });

  return c.json({ ok: true });
});
