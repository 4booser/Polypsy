import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { noteSearch, patientNotes, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { indexOf } from "../lib/searchIndex";
import { badRequest, conflict, notFound, parseBody } from "../lib/http";
import { accessiblePatientIds } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";
import type { User } from "@quizzy/shared";

export const noteRoutes = new Hono<AppEnv>();
noteRoutes.use("*", requireAuth, requireStaff);

/**
 * Заметки приёма.
 *
 * Заключение отвечает на вопрос «что показала методика»; приём бывает и без
 * методики — беседа, наблюдение, звонок командиру. Раньше такую запись было
 * некуда положить, и она уходила в тетрадь, где её не видит ни второй
 * специалист, ни консилиум.
 *
 * Устройство повторяет заключения: версии, подпись, шифрование, сверка
 * версии при правке и подписи. Повторяется намеренно — эти два документа
 * живут по одним правилам, и расхождение в правилах было бы источником
 * ошибок, а не разнообразия.
 */

const saveSchema = z.object({
  text: z.string().min(1).max(20_000),
  kind: z.enum(["intake", "session", "observation", "consult"]).optional(),
  pathwayInstanceId: z.string().uuid().nullable().optional(),
  /** Версия, поверх которой правили; 0 — заметок ещё не было */
  baseVersion: z.number().int().min(0).optional(),
});

const signSchema = z.object({ version: z.number().int().min(1) });

async function assertPatient(staff: User, userId: string) {
  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("Пациент не найден");
  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("Пациент не найден");
  return patient;
}

/** Блокировка на время транзакции — та же причина, что у заключений */
async function lockNotes(userId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`note:${userId}`}))`);
}

async function history(userId: string) {
  const rows = await db
    .select({ row: patientNotes, author: users })
    .from(patientNotes)
    .leftJoin(users, eq(users.id, patientNotes.createdBy))
    .where(eq(patientNotes.userId, userId))
    .orderBy(desc(patientNotes.version));

  return rows.map(({ row, author }) => ({
    id: row.id,
    version: row.version,
    kind: row.kind,
    text: decryptField(row.text) ?? "",
    status: row.status,
    createdAt: row.createdAt,
    authorName: author ? fullNameOf(author) : "—",
    signedAt: row.signedAt,
    pathwayInstanceId: row.pathwayInstanceId,
  }));
}

noteRoutes.get("/patients/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");
  await assertPatient(staff, userId);

  const versions = await history(userId);

  await audit(c, {
    action: "response.read",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { view: "notes", count: versions.length },
  });

  return c.json({ current: versions[0] ?? null, versions });
});

noteRoutes.put("/patients/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");
  await assertPatient(staff, userId);
  const input = await parseBody(c.req.raw, saveSchema);
  await lockNotes(userId);

  const [latest] = await db
    .select()
    .from(patientNotes)
    .where(eq(patientNotes.userId, userId))
    .orderBy(desc(patientNotes.version))
    .limit(1);

  if (input.baseVersion !== undefined && input.baseVersion !== (latest?.version ?? 0)) {
    conflict(
      `Заметки изменились: сейчас версия ${latest?.version ?? 0}, а правка велась поверх ${input.baseVersion}. Обновите текст.`,
    );
  }

  /*
   * Слепой индекс переписывается целиком на каждое сохранение: правка меняет
   * состав слов, и дописывать новые, не убирая старые, значит находить запись
   * по словам, которых в ней уже нет.
   */
  const reindex = async (noteId: string) => {
    await db.delete(noteSearch).where(eq(noteSearch.noteId, noteId));
    const rows = indexOf(input.text).map((fp) => ({ noteId, kind: "note", userId, fp }));
    if (rows.length) await db.insert(noteSearch).values(rows).onConflictDoNothing();
  };

  if (latest && latest.status === "draft") {
    await db
      .update(patientNotes)
      .set({
        text: encryptField(input.text)!,
        kind: input.kind ?? latest.kind,
        pathwayInstanceId: input.pathwayInstanceId ?? latest.pathwayInstanceId,
        createdBy: staff.id,
        createdAt: new Date().toISOString(),
      })
      .where(eq(patientNotes.id, latest.id));
    await reindex(latest.id);
  } else {
    const id = crypto.randomUUID();
    await db.insert(patientNotes).values({
      id,
      userId,
      version: (latest?.version ?? 0) + 1,
      kind: input.kind ?? "session",
      text: encryptField(input.text)!,
      pathwayInstanceId: input.pathwayInstanceId ?? null,
      createdBy: staff.id,
    });
    await reindex(id);
  }

  await audit(c, {
    action: "note.save",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { length: input.text.length, newVersion: !latest || latest.status !== "draft" },
  });

  const versions = await history(userId);
  return c.json({ current: versions[0], versions });
});

noteRoutes.post("/patients/:userId/sign", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");
  await assertPatient(staff, userId);
  const input = await parseBody(c.req.raw, signSchema);
  await lockNotes(userId);

  const [latest] = await db
    .select()
    .from(patientNotes)
    .where(eq(patientNotes.userId, userId))
    .orderBy(desc(patientNotes.version))
    .limit(1);
  if (!latest) notFound("Заметки ещё нет");
  if (latest.status === "signed") badRequest("Последняя версия уже подписана");
  if (latest.version !== input.version) {
    conflict(
      `Текст изменился после открытия: сейчас версия ${latest.version}, подписывалась ${input.version}. Перечитайте запись.`,
    );
  }

  await db
    .update(patientNotes)
    .set({ status: "signed", signedAt: new Date().toISOString(), signedBy: staff.id })
    .where(eq(patientNotes.id, latest.id));

  await audit(c, {
    action: "note.sign",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { version: latest.version },
  });

  const versions = await history(userId);
  return c.json({ current: versions[0], versions });
});
