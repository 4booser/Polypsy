import { Hono } from "hono";
import { z } from "zod";
import { t, } from "@quizzy/shared";
import { db } from "../db";
import { consentTexts, consents } from "../db/schema";
import { currentConsentText } from "../lib/consent";
import { audit } from "../lib/audit";
import { badRequest, conflict, langOf, parseBody } from "../lib/http";
import { requireAuth, requireSuperadmin, type AppEnv } from "../middleware/auth";

export const consentRoutes = new Hono<AppEnv>();

consentRoutes.use("*", requireAuth);

/* действующая редакция — одна точка с проверкой согласия при сдаче (lib/consent.ts) */
const latestText = currentConsentText;

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
    // редакция, которую показывают: её клиент и присылает при принятии
    textId: current.id,
    text: t(current.body as never, langOf(c)),
  });
});

const acceptSchema = z.object({
  /** Редакция, которую человек читал (textId из GET /me) */
  textId: z.string().min(1).max(64).nullish(),
});

/**
 * Принять согласие — на ту редакцию, которую показали.
 *
 * Сервер брал последнюю редакцию, не спрашивая, какую читал человек: текст
 * обновили, пока экран был открыт, — и в документах оказывалось согласие на
 * текст, которого он не видел (волна 12, воспроизведено ревью). Теперь
 * клиент присылает textId показанной редакции; не совпала с действующей —
 * 409, и экран показывает новый текст.
 *
 * Без textId — принимается, как раньше: так шлют уже установленные
 * приложения, и отказ запер бы их на экране согласия до обновления. Такое
 * принятие помечено в журнале (shownTextId: null) — отличить его от
 * подтверждённого можно всегда.
 */
consentRoutes.post("/me/accept", async (c) => {
  const user = c.get("user");
  const current = await latestText();
  if (!current) badRequest("err.consentTextNotConfigured");
  const body = await c.req.json().catch(() => ({}));
  const parsed = acceptSchema.safeParse(body ?? {});
  const shownTextId = parsed.success ? (parsed.data.textId ?? null) : null;
  if (shownTextId && shownTextId !== current.id) {
    await audit(c, {
      action: "consent.accept",
      outcome: "denied",
      resourceType: "consent_text",
      resourceId: current.id,
      subjectUserId: user.id,
      details: { version: current.version, reason: "text_changed", shownTextId },
    });
    conflict("err.consentTextChanged");
  }

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
    details: { version: current.version, shownTextId },
  });
  return c.json({ ok: true });
});

/* ── управление текстом (суперадмин) ── */

/*
 * Английский — необязательным третьим. Согласие — не методика: норм у него
 * нет, и довод, по которому у методик нет английского текста, сюда не
 * дотягивается. Не заполнен — человеку с английским интерфейсом покажут
 * украинский (t() → LANG_FALLBACK), как и прочее содержимое. Пустая строка
 * здесь означает «не задан»: поле формы отправляется всегда.
 */
const textSchema = z.object({
  body: z.object({
    uk: z.string().min(10),
    ru: z.string().min(10),
    en: z
      .string()
      .optional()
      .transform((v) => (v?.trim() ? v : undefined))
      .pipe(z.string().min(10).optional()),
  }),
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
