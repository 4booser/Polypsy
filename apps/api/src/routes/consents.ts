import { Hono } from "hono";
import { desc, } from "drizzle-orm";
import { z } from "zod";
import { t, } from "@quizzy/shared";
import { db } from "../db";
import { consentTexts, consents } from "../db/schema";
import { audit } from "../lib/audit";
import { badRequest, langOf, parseBody } from "../lib/http";
import { requireAuth, requireSuperadmin, type AppEnv } from "../middleware/auth";

export const consentRoutes = new Hono<AppEnv>();

consentRoutes.use("*", requireAuth);

async function latestText() {
  const [row] = await db.select().from(consentTexts).orderBy(desc(consentTexts.version)).limit(1);
  return row ?? null;
}

/**
 * Статус согласия текущего пользователя.
 *
 * Новая версия текста «сбрасывает» согласие: принявший старую редакцию
 * увидит экран заново — иначе правка текста ничего бы не значила.
 */
consentRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const current = await latestText();
  if (!current) return c.json({ required: false, accepted: true, text: null, version: null });

  const existing = await db.query.consents.findFirst({
    where: (row, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(row.userId, user.id), eqOp(row.consentTextId, current.id)),
  });

  return c.json({
    required: true,
    accepted: !!existing,
    version: current.version,
    text: t(current.body as never, langOf(c)),
  });
});

consentRoutes.post("/me/accept", async (c) => {
  const user = c.get("user");
  const current = await latestText();
  if (!current) badRequest("err.consentTextNotConfigured");

  await db
    .insert(consents)
    .values({
      userId: user.id,
      consentTextId: current.id,
      ip: c.req.header("X-Forwarded-For") ?? null,
    })
    .onConflictDoNothing();

  await audit(c, {
    action: "consent.accept",
    resourceType: "consent_text",
    resourceId: current.id,
    subjectUserId: user.id,
    details: { version: current.version },
  });
  return c.json({ ok: true });
});

/* ── управление текстом (суперадмин) ── */

const textSchema = z.object({
  body: z.object({ uk: z.string().min(10), ru: z.string().min(10) }),
});

consentRoutes.get("/text", requireSuperadmin, async (c) => {
  const current = await latestText();
  return c.json(current ? { version: current.version, body: current.body, createdAt: current.createdAt } : null);
});

consentRoutes.put("/text", requireSuperadmin, async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, textSchema);
  const current = await latestText();

  const id = crypto.randomUUID();
  const version = (current?.version ?? 0) + 1;
  await db.insert(consentTexts).values({
    id,
    version,
    body: input.body,
    createdBy: user.id,
  });

  await audit(c, {
    action: "consent.text_update",
    resourceType: "consent_text",
    resourceId: id,
    details: { version },
  });
  return c.json({ version });
});
