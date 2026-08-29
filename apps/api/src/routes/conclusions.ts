import { Hono } from "hono";
import { aliasedTable, and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { t } from "@quizzy/shared";
import { db } from "../db";
import { conclusions, responses, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { badRequest, conflict, langOf, notFound, parseBody, parseQuery } from "../lib/http";
import { canAccessSurvey, surveyScopeFilter } from "../lib/scope";

/*
 * Псевдоним таблицы пользователей для автора заключения: в одном запросе
 * участвуют и пациент, и подписавший, и без псевдонима join склеил бы их.
 */
const authorTable = aliasedTable(users, "conclusion_author");

const batchQuery = z.object({
  unit: z.string().max(200).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
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

/**
 * Пакет заключений: подразделение за период одним документом.
 *
 * Отчёты подшивают в дело, и печатать их по одному — это открыть карту,
 * нажать печать, дождаться, вернуться, и так семьдесят раз. Здесь один запрос
 * отдаёт всё, что подписано за период, в порядке подшивки.
 *
 * Только подписанные. Черновик заключения — это мысль вслух, и попасть в дело
 * он не должен: подшитый черновик потом не отличить от решения.
 */
conclusionRoutes.get("/batch", async (c) => {
  const user = c.get("user");
  const { unit, from, to } = parseQuery(c, batchQuery);
  const lang = langOf(c);

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id, title: surveys.title }).from(surveys).where(scope);
  const titleOf = new Map(scoped.map((s) => [s.id, t(s.title as never, lang)]));
  if (!scoped.length) return c.json({ items: [], unit: unit ?? null });

  const rows = await db
    .select({ row: conclusions, response: responses, patient: users, author: authorTable })
    .from(conclusions)
    .innerJoin(responses, eq(responses.id, conclusions.responseId))
    .leftJoin(users, eq(users.id, responses.userId))
    .leftJoin(authorTable, eq(authorTable.id, conclusions.createdBy))
    .where(
      and(
        eq(conclusions.status, "signed"),
        inArray(responses.surveyId, [...titleOf.keys()]),
        from ? gte(conclusions.signedAt, from) : undefined,
        to ? lte(conclusions.signedAt, to) : undefined,
        unit ? eq(users.unit, unit) : undefined,
      ),
    )
    .orderBy(asc(users.lastName), asc(conclusions.signedAt));

  /*
   * Только последняя подписанная версия по каждому прохождению. Подшивать в
   * дело две версии одного заключения — верный способ, чтобы потом читали ту,
   * что сверху, а не ту, что верна.
   */
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const seen = latest.get(r.row.responseId);
    if (!seen || seen.row.version < r.row.version) latest.set(r.row.responseId, r);
  }

  await audit(c, {
    action: "conclusion.batch",
    details: { unit: unit ?? null, from: from ?? null, to: to ?? null, count: latest.size },
  });

  return c.json({
    unit: unit ?? null,
    from: from ?? null,
    to: to ?? null,
    items: [...latest.values()].map((r) => ({
      id: r.row.id,
      responseId: r.row.responseId,
      version: r.row.version,
      signedAt: r.row.signedAt,
      text: decryptField(r.row.text) ?? "",
      authorName: r.author ? fullNameOf(r.author) : "—",
      patientName: r.patient ? fullNameOf(r.patient) : "—",
      unit: r.patient?.unit ?? null,
      surveyTitle: titleOf.get(r.response.surveyId) ?? "—",
      submittedAt: r.response.submittedAt,
    })),
  });
});
