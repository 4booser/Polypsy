import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { conclusions, responses, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { badRequest, conflict, notFound, parseBody } from "../lib/http";
import { canAccessSurvey } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";
import type { User } from "@quizzy/shared";

export const conclusionRoutes = new Hono<AppEnv>();

conclusionRoutes.use("*", requireAuth, requireStaff);

const saveSchema = z.object({
  text: z.string().min(1).max(20_000),
  /**
   * Версия, которую редактор показывал в момент правки. 0 — «заключения ещё
   * не было». Присылают её не всегда (старые клиенты), поэтому поле
   * необязательное: без него работает прежнее «последний победил».
   */
  baseVersion: z.number().int().min(0).optional(),
});

const signSchema = z.object({
  /** Подписывают конкретную версию, а не «последнюю» — см. lockConclusion */
  version: z.number().int().min(1),
});

/**
 * Блокировка заключения на время транзакции.
 *
 * Каждый запрос и так идёт в транзакции (её открывает RLS-контекст), но
 * изоляция READ COMMITTED: два одновременных сохранения прочитают одну и ту же
 * последнюю версию и оба посчитают следующей вторую. Уникальный индекс не даст
 * их записать, но пользователь получит пятисотку вместо понятного ответа.
 *
 * Блокировка именно консультативная, а не `select … for update`: строки может
 * ещё не быть вовсе, а первую версию создают ровно так же наперегонки.
 */
async function lockConclusion(responseId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`conclusion:${responseId}`}))`);
}

async function assertResponse(user: User, responseId: string) {
  const response = await db.query.responses.findFirst({ where: eq(responses.id, responseId) });
  if (!response) notFound("Прохождение не найдено");
  if (!(await canAccessSurvey(user, response.surveyId))) notFound("Прохождение не найдено");
  return response;
}

async function history(responseId: string) {
  const rows = await db
    .select({ row: conclusions, author: users })
    .from(conclusions)
    .leftJoin(users, eq(users.id, conclusions.createdBy))
    .where(eq(conclusions.responseId, responseId))
    .orderBy(desc(conclusions.version));
  return rows.map(({ row, author }) => ({
    id: row.id,
    version: row.version,
    text: decryptField(row.text) ?? "",
    status: row.status,
    createdAt: row.createdAt,
    authorName: author ? fullNameOf(author) : "—",
    signedAt: row.signedAt,
  }));
}

conclusionRoutes.get("/responses/:id/conclusion", async (c) => {
  await assertResponse(c.get("user"), c.req.param("id"));
  const versions = await history(c.req.param("id"));
  return c.json({ current: versions[0] ?? null, versions });
});

/**
 * Сохранение текста. Пока последняя версия — черновик, она правится на
 * месте; после подписи правка создаёт новую версию: подписанное неизменно.
 */
conclusionRoutes.put("/responses/:id/conclusion", async (c) => {
  const user = c.get("user");
  const responseId = c.req.param("id");
  await assertResponse(c.get("user"), responseId);
  const input = await parseBody(c.req.raw, saveSchema);
  await lockConclusion(responseId);

  const [latest] = await db
    .select()
    .from(conclusions)
    .where(eq(conclusions.responseId, responseId))
    .orderBy(desc(conclusions.version))
    .limit(1);

  /*
   * Правку сверяем с тем, что редактор показывал. Иначе двое, открывших
   * заключение одновременно, молча затрут работу друг друга: победит тот, кто
   * нажал «сохранить» вторым, а первый об этом не узнает.
   */
  if (input.baseVersion !== undefined && input.baseVersion !== (latest?.version ?? 0)) {
    conflict(
      `Заключение изменилось: сейчас версия ${latest?.version ?? 0}, а правка велась поверх ${input.baseVersion}. Обновите текст.`,
    );
  }

  if (latest && latest.status === "draft") {
    await db
      .update(conclusions)
      .set({ text: encryptField(input.text)!, createdBy: user.id, createdAt: new Date().toISOString() })
      .where(eq(conclusions.id, latest.id));
  } else {
    await db.insert(conclusions).values({
      id: crypto.randomUUID(),
      responseId,
      version: (latest?.version ?? 0) + 1,
      text: encryptField(input.text)!,
      createdBy: user.id,
    });
  }

  await audit(c, {
    action: "conclusion.save",
    resourceType: "response",
    resourceId: responseId,
    details: { length: input.text.length, newVersion: !latest || latest.status !== "draft" },
  });
  const versions = await history(responseId);
  return c.json({ current: versions[0], versions });
});

/**
 * Подпись фиксирует снимок. Подписывает только автор осознанным действием;
 * дальше текст менять нельзя — только новая версия поверх.
 */
conclusionRoutes.post("/responses/:id/conclusion/sign", async (c) => {
  const user = c.get("user");
  const responseId = c.req.param("id");
  await assertResponse(c.get("user"), responseId);
  const input = await parseBody(c.req.raw, signSchema);
  await lockConclusion(responseId);

  const [latest] = await db
    .select()
    .from(conclusions)
    .where(eq(conclusions.responseId, responseId))
    .orderBy(desc(conclusions.version))
    .limit(1);
  if (!latest) notFound("Заключения ещё нет");
  if (latest.status === "signed") badRequest("Последняя версия уже подписана");
  /*
   * Подпись удостоверяет конкретный текст. Без сверки версии сохранение,
   * прошедшее между открытием экрана и нажатием «подписать», подставило бы
   * под подпись текст, которого подписывающий не видел.
   */
  if (latest.version !== input.version) {
    conflict(
      `Текст изменился после открытия: сейчас версия ${latest.version}, подписывалась ${input.version}. Перечитайте заключение.`,
    );
  }

  await db
    .update(conclusions)
    .set({ status: "signed", signedAt: new Date().toISOString(), signedBy: user.id })
    .where(eq(conclusions.id, latest.id));

  await audit(c, {
    action: "conclusion.sign",
    resourceType: "response",
    resourceId: responseId,
    details: { version: latest.version },
  });
  const versions = await history(responseId);
  return c.json({ current: versions[0], versions });
});
