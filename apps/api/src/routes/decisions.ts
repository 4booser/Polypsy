import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { decisionRules, ruleHits, users } from "../db/schema";
import { audit } from "../lib/audit";
import { badRequest, conflict, langOf, notFound, parseBody } from "../lib/http";
import { hitViews } from "../lib/ruleHits";
import { accessibleGroupIds, assertGroupAccess, canAccessGroup, canSeeResult, resultScopeCondition } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const decisionRoutes = new Hono<AppEnv>();
/*
 * Три разных права в одном наборе, и это не разнобой.
 *
 * Правила и срабатывания читает и разбирает тот, кто вообще разбирает риск.
 * Заступить на дежурство — отдельное право: дежурство временная нагрузка,
 * а не свойство должности, и выдаётся исключением на срок смены. Менять сами
 * правила и включать кризисный режим — decisions.manage; раньше это требовало
 * суперадмина, теперь требует права, и суперадмин проходит потому, что
 * обходит справочник целиком.
 */
decisionRoutes.use("*", requireAuth, requireStaff);

/**
 * Поддержка решений и дежурная смена.
 *
 * Правило ничего не делает само: оно порождает предложение с объяснением, а
 * принимает его человек — и это фиксируется. Отклонение фиксируется наравне с
 * принятием: «правило предложило, специалист отказался и вот почему» — такая
 * же часть истории случая, как и согласие.
 */

const conditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scale"),
    surveyId: z.string().nullable(),
    scaleCode: z.string().min(1).max(40),
    metric: z.enum(["raw", "normed"]),
    op: z.enum([">=", "<=", ">", "<"]),
    value: z.number(),
  }),
  z.object({ kind: z.literal("risk"), severity: z.enum(["moderate", "severe"]) }),
  z.object({ kind: z.literal("history"), completedAtLeast: z.number().int().min(0).max(100) }),
]);

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suggest_survey"), surveyId: z.string() }),
  z.object({ kind: z.literal("suggest_pathway"), pathwayId: z.string() }),
  z.object({ kind: z.literal("notify_duty") }),
  z.object({ kind: z.literal("advise"), text: z.string().min(1).max(2000) }),
]);

const ruleSchema = z.object({
  title: z.string().min(1).max(200),
  groupId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(conditionSchema).min(1),
  actions: z.array(actionSchema).min(1),
  note: z.string().max(2000).nullable().optional(),
});

const ruleUpdateSchema = ruleSchema.partial().extend({
  /**
   * Версия, которую видел правящий. Есть — правка ложится, только если
   * правило с тех пор не меняли, иначе 409, и экран перечитывает правило;
   * нет — последняя правка побеждает, как прежде.
   */
  version: z.number().int().positive().optional(),
});

/* ── правила ── */

decisionRoutes.get("/rules", requirePermission("alerts.review"), async (c) => {
  const user = c.get("user");
  const groups = await accessibleGroupIds(user);

  const rows = await db
    .select()
    .from(decisionRules)
    .where(
      groups === null
        ? undefined
        : groups.length
          ? or(isNull(decisionRules.groupId), inArray(decisionRules.groupId, groups))
          : isNull(decisionRules.groupId),
    )
    .orderBy(desc(decisionRules.createdAt));

  return c.json({ items: rows });
});

/*
 * Правило заводит обладатель decisions.manage. Оно действует на все
 * прохождения своей группы и подсказывает клинические шаги — это уровень
 * настройки учреждения, а не рабочий инструмент дежурного.
 *
 * Группа — только та, которой заводящий управляет, как у методики
 * (routes/surveys.ts, assertGroupAccess): иначе он поставил бы правило на
 * прохождения чужой группы, которых сам не видит. Под ролью приложения такую
 * вставку отвергла бы и политика строк decision_rules_access — но пятисоткой;
 * проверка здесь отвечает словами и одинаково при любой роли. Без группы —
 * общее правило, как и прежде (форма модели аналитики группы не выбирает).
 */
decisionRoutes.post("/rules", requirePermission("decisions.manage"), async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, ruleSchema);
  if (input.groupId) await assertGroupAccess(user, input.groupId);

  const id = crypto.randomUUID();
  await db.insert(decisionRules).values({
    id,
    title: input.title,
    groupId: input.groupId ?? null,
    enabled: input.enabled ?? true,
    conditions: input.conditions,
    actions: input.actions,
    note: input.note ?? null,
    createdBy: user.id,
  });

  await audit(c, { action: "rule.save", resourceType: "rule", resourceId: id, details: { created: true } });
  return c.json({ id }, 201);
});

decisionRoutes.patch("/rules/:id", requirePermission("decisions.manage"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const { version: seen, ...input } = await parseBody(c.req.raw, ruleUpdateSchema);

  /*
   * Правило вне зоны — «не найдено»: перечень (GET /rules) его не показывает,
   * и под ролью приложения политика строк прячет его так же. Зона — та же:
   * общее правило или группа, которой правящий управляет.
   */
  const row = await db.query.decisionRules.findFirst({ where: eq(decisionRules.id, id) });
  if (!row || (row.groupId !== null && !(await canAccessGroup(user, row.groupId)))) notFound("err.ruleNotFound");
  // перенести правило можно только в свою группу — как и завести (POST /rules)
  if (input.groupId) await assertGroupAccess(user, input.groupId);

  /*
   * Правка поднимает версию. Срабатывания хранят версию, при которой сработали:
   * правило потом поправят, а объяснение должно остаться верным для случая,
   * который уже разобрали.
   *
   * Версия поднимается в самой базе, и сверка с увиденной — тем же
   * оператором: две правки, прочитавшие одну версию, прежде обе писали
   * «версия + 1» от неё — номер повторялся, а вторая молча стирала первую.
   * Теперь вторая ждёт замка строки, видит новую версию и получает 409.
   */
  const [saved] = await db
    .update(decisionRules)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
      ...(input.actions !== undefined ? { actions: input.actions } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      version: sql`${decisionRules.version} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(decisionRules.id, id), seen !== undefined ? eq(decisionRules.version, seen) : undefined))
    .returning({ version: decisionRules.version });
  if (!saved) conflict("err.ruleChanged");

  await audit(c, { action: "rule.save", resourceType: "rule", resourceId: id, details: { version: saved.version } });
  return c.json({ ok: true, version: saved.version });
});

/* ── срабатывания ── */

decisionRoutes.get("/hits", requirePermission("alerts.review"), async (c) => {
  const user = c.get("user");
  // срабатывания — как прохождения, по которым они сработали: свои методики целиком, библиотека — люди зоны (lib/scope.ts)
  const visible = await resultScopeCondition(user);

  const status = c.req.query("status") ?? "suggested";
  /*
   * ?userId= — предложения по одному человеку: ящик назначения в его карточке
   * показывает «Рекомендовано: PHQ-9 — PHQ-2 = 4 від 12.10» и назначает одним
   * нажатием. Зона — та же (resultScopeCondition): параметр только сужает.
   */
  const userId = c.req.query("userId")?.trim() || null;
  const rows = await db
    .select({ hit: ruleHits, rule: decisionRules, patient: users })
    .from(ruleHits)
    .innerJoin(decisionRules, eq(decisionRules.id, ruleHits.ruleId))
    .leftJoin(users, eq(users.id, ruleHits.userId))
    .where(
      and(
        visible?.(ruleHits.surveyId, ruleHits.userId),
        eq(ruleHits.status, status),
        userId ? eq(ruleHits.userId, userId) : undefined,
      ),
    )
    .orderBy(desc(ruleHits.createdAt))
    .limit(100);

  /*
   * Объяснение хранится кодами и становится текстом здесь — на языке того,
   * кто читает предложение (волна 13). Записи, сделанные до кодов, несут
   * готовый русский текст и показываются как есть: см. explanationFor. Что
   * предложено и что с ним уже сделано — lib/ruleHits.ts.
   */
  return c.json({ items: await hitViews(rows, langOf(c)) });
});

const decisionSchema = z.object({
  status: z.enum(["accepted", "declined"]),
  note: z.string().max(2000).nullable().optional(),
});

decisionRoutes.patch("/hits/:id", requirePermission("alerts.review"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const input = await parseBody(c.req.raw, decisionSchema);

  const row = await db.query.ruleHits.findFirst({ where: eq(ruleHits.id, id) });
  if (!row) notFound("err.hitNotFound");
  /*
   * Зона — как у списка срабатываний (resultScopeCondition) и у политики
   * строк rule_hits: решение по сигналу чужой группы методик — и по сигналу
   * методики библиотеки о человеке вне зоны — для сотрудника не существует
   * (волна 16, проход по маршрутам с чужими id). Владельцем базы сюда
   * записывалось решение по любому срабатыванию по известному id.
   */
  if (!(await canSeeResult(user, row!))) notFound("err.hitNotFound");
  // решено раньше — тот же исход, что проигранная гонка: состояние сменилось,
  // пока человек смотрел на устаревший список; 409 — клиент его перечитает
  if (row!.status !== "suggested") conflict("err.hitAlreadyDecided");

  /*
   * Отклонение требует объяснения, принятие — нет. Принять предложение
   * значит согласиться с уже написанным объяснением правила; отклонить —
   * возразить ему, и возражение должно быть записано, иначе разобрать потом,
   * почему сигнал проигнорировали, будет не по чему.
   */
  if (input.status === "declined" && !input.note?.trim()) {
    badRequest("err.declineNeedsNote");
  }

  /*
   * Решение — одним условием с записью (внешний разбор 2026-09-29, #104).
   *
   * «Ещё предложено» проверялось чтением, а UPDATE искал строку только по
   * id. Два одновременных PATCH — «принять» и «отклонить» — оба читали
   * «предложено», оба писали, оба получали 200, и в строке оставалось
   * решение второго с его заметкой поверх первого; журнал при этом нёс обе
   * записи. Теперь UPDATE записывает, только если строка всё ещё
   * «предложено»: второй запрос ждёт замка строки, после чужого коммита
   * условие не сходится, строки нет — 409. Последовательный повтор по уже
   * решённому остаётся 400 (проверка выше): это не гонка, а повтор.
   */
  const [decided] = await db
    .update(ruleHits)
    .set({
      status: input.status,
      decidedBy: user.id,
      decidedAt: new Date().toISOString(),
      decisionNote: input.note?.trim() || null,
    })
    .where(and(eq(ruleHits.id, id), eq(ruleHits.status, "suggested")))
    .returning({ id: ruleHits.id });
  if (!decided) conflict("err.hitDecidedMeanwhile");

  await audit(c, {
    action: "rule.decide",
    resourceType: "rule_hit",
    resourceId: id,
    subjectUserId: row!.userId,
    details: { status: input.status },
  });

  return c.json({ ok: true });
});

/* ── дежурная смена ── */

const _shiftSchema = z.object({
  userId: z.string(),
  groupId: z.string().nullable().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
});

