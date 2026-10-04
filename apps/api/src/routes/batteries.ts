import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  assignBatterySchema,
  batteryInputSchema,
  noteCode,
  renderNote,
  t,
  type Battery,
  type BatteryAssignment,
  type BatteryItem,
  type BatteryStep,
  type Administration,
  type Lang,
} from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import {
  batteries,
  batteryAssignmentItems,
  batteryAssignments,
  batteryItems,
  responses,
  surveyGroups,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { batteryProgress, closeMissed, isExecutable, isOverdue, revokeIssuedAccess, snapshotAssignment } from "../lib/batteries";
import { dayOf, deadlineOf } from "../lib/day";
import { grantAccess } from "../lib/grantAccess";
import { badRequest, conflict, forbidden, langOf, notFound, parseBody } from "../lib/http";
import { accessibleGroupIds, assertBatteryInUse, assertGroupAccess, assertSurveyAccess, isStaff } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { parseTs } from "../lib/time";

/*
 * Язык — общим правилом (lib/http.ts: ?lang, затем Accept-Language).
 *
 * Здесь жило своё: «всё, кроме украинского, — по-русски», и читался только
 * параметр ?lang, которого клиенты не шлют. Названия методик в наборах
 * поэтому приходили русскими на любом интерфейсе, а с английским правило
 * «всё прочее — русский» выдало бы русский и ему.
 */

export const batteryRoutes = new Hono<AppEnv>();

batteryRoutes.use("*", requireAuth);

/**
 * Батарея видна тем же, кому видна её группа.
 *
 * С замком — для путей, которые по прочитанному решают и пишут (внешний
 * разбор 2026-09-30…10-01, #107, #108). Выдача берёт строку FOR SHARE:
 * несколько выдач одного набора друг другу не мешают, а удаление (FOR
 * UPDATE) и архивирование (UPDATE строки) ждут, пока выдача зафиксируется,
 * — и наоборот, выдача, вставшая за ними, читает уже новую строку: набора
 * нет (404) или он архивный (400). Прежде проверки «назначений нет» и «не в
 * архиве» делались до замка, а каскад внешнего ключа уносил назначение, чей
 * id уже отдан клиенту.
 */
async function assertBatteryAccess(
  user: Parameters<typeof accessibleGroupIds>[0],
  batteryId: string,
  lock?: "share" | "no key update" | "update",
) {
  const row = lock
    ? (await db.select().from(batteries).where(eq(batteries.id, batteryId)).for(lock))[0]
    : await db.query.batteries.findFirst({ where: eq(batteries.id, batteryId) });
  if (!row) notFound("err.batteryNotFound");
  if (row.groupId) await assertGroupAccess(user, row.groupId);
  else if (!isStaff(user)) forbidden("err.batteryAccessDenied");
  return row;
}

/** Шаг набора и можно ли его методику сейчас пройти — для расчёта прогресса (lib/batteries.ts) */
type LoadedItem = BatteryItem & { executable: boolean };

/** Шаг набора наружу — без служебного признака расчёта */
function toBatteryItem(i: LoadedItem): BatteryItem {
  return {
    surveyId: i.surveyId,
    title: i.title,
    position: i.position,
    required: i.required,
    administration: i.administration,
    questionCount: i.questionCount,
    medianMinutes: i.medianMinutes,
  };
}

/**
 * Состав — одним запросом на все наборы или назначения: без него список из
 * десяти батарей — это 10 запросов.
 *
 * Два источника с одной формой строки: шаблон (battery_items — список
 * наборов, выдача) и снимок назначения (battery_assignment_items — экран
 * назначений, lib/batteries.ts). Ключ карты — то, по чему спрашивали.
 */
async function loadItemsFrom(
  source:
    | { table: typeof batteryItems; key: typeof batteryItems.batteryId }
    | { table: typeof batteryAssignmentItems; key: typeof batteryAssignmentItems.assignmentId },
  ids: string[],
  lang: Lang,
): Promise<Map<string, LoadedItem[]>> {
  const result = new Map<string, LoadedItem[]>();
  if (!ids.length) return result;

  const rows = await db
    .select({
      key: source.key,
      surveyId: source.table.surveyId,
      position: source.table.position,
      required: source.table.required,
      title: surveys.title,
      administration: surveys.administration,
      status: surveys.status,
      archivedAt: surveys.archivedAt,
      questionCount: sql<number>`(select count(*) from questions q
        where q.version_id = "surveys"."current_version_id" and q.type <> 'info')`,
      // ориентир длительности берём из фактических прохождений, а не из
      // предположений: реальная медиана расходится с ожиданиями в разы
      medianMs: sql<number | null>`(select percentile_cont(0.5) within group (order by r.duration_ms)
        from responses r where r.survey_id = "surveys"."id" and r.status = 'completed' and r.duration_ms > 0)`,
    })
    .from(source.table)
    .innerJoin(surveys, eq(surveys.id, source.table.surveyId))
    .where(inArray(source.key, ids))
    .orderBy(source.key, source.table.position);

  for (const r of rows) {
    const list = result.get(r.key) ?? [];
    list.push({
      surveyId: r.surveyId,
      title: t(r.title, lang),
      position: r.position,
      required: r.required,
      administration: r.administration as Administration,
      questionCount: Number(r.questionCount ?? 0),
      medianMinutes: r.medianMs ? Math.round((Number(r.medianMs) / 60000) * 10) / 10 : null,
      executable: isExecutable(r),
    });
    result.set(r.key, list);
  }
  return result;
}

/** Состав наборов (шаблон) по id набора */
function loadItems(batteryIds: string[], lang: Lang) {
  return loadItemsFrom({ table: batteryItems, key: batteryItems.batteryId }, batteryIds, lang);
}

/** Состав назначений (снимок на момент выдачи) по id назначения */
function loadAssignmentItems(assignmentIds: string[], lang: Lang) {
  return loadItemsFrom({ table: batteryAssignmentItems, key: batteryAssignmentItems.assignmentId }, assignmentIds, lang);
}

/*
 * Права здесь расставлены не файлом, а по смыслу действия, и файл разделён
 * надвое: составить батарею и назначить её — разная работа. Стажёр назначает
 * стандартную батарею, но состав её не меняет; менять состав — методическое
 * решение, и оно влияет на все будущие назначения, а не на одно.
 *
 * requireStaff стоит рядом с правом, а не заменяется им: батареи лежат в
 * одном роутере со своим пользовательским маршрутом /mine, и общего
 * requireStaff на весь роутер быть не может.
 *
 * Проверки isStaff внутри обработчиков оставлены как были: снимать их
 * означало бы править тела вместе с защитой и проверять уже не одно
 * изменение, а два.
 */

/** Список батарей, доступных сотруднику */
batteryRoutes.get("/", requireStaff, requirePermission("batteries.manage"), async (c) => {
  const user = c.get("user");
  if (!isStaff(user)) forbidden("err.staffAccessOnly");
  const lang = langOf(c);
  const groupIds = await accessibleGroupIds(user);

  const rows = await db
    .select({
      battery: batteries,
      groupTitle: surveyGroups.title,
      activeAssignments: sql<number>`(select count(*) from battery_assignments a
        where a.battery_id = "batteries"."id" and a.completed_at is null and a.cancelled_at is null)`,
    })
    .from(batteries)
    .leftJoin(surveyGroups, eq(surveyGroups.id, batteries.groupId))
    .where(
      groupIds === null
        ? undefined
        : groupIds.length
          ? sql`("batteries"."group_id" in ${groupIds} or "batteries"."group_id" is null)`
          : isNull(batteries.groupId),
    )
    .orderBy(desc(batteries.createdAt));

  const items = await loadItems(rows.map((r) => r.battery.id), lang);
  const result: Battery[] = rows.map((r) => ({
    id: r.battery.id,
    title: r.battery.title,
    description: r.battery.description,
    groupId: r.battery.groupId,
    groupTitle: r.groupTitle ? t(r.groupTitle, lang) : null,
    strictOrder: r.battery.strictOrder,
    archived: r.battery.archived,
    createdAt: r.battery.createdAt,
    items: (items.get(r.battery.id) ?? []).map(toBatteryItem),
    activeAssignments: Number(r.activeAssignments ?? 0),
  }));
  return c.json({ items: result });
});

/** Создание батареи */
batteryRoutes.post("/", requireStaff, requirePermission("batteries.manage"), async (c) => {
  const user = c.get("user");
  if (!isStaff(user)) forbidden("err.staffAccessOnly");
  const input = await parseBody(c.req.raw, batteryInputSchema);
  if (input.groupId) await assertGroupAccess(user, input.groupId);
  // право на методику проверяем поштучно: иначе через батарею можно было бы
  // раздать доступ к чужой группе
  for (const item of input.items) await assertSurveyAccess(user, item.surveyId);

  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(batteries).values({
      id,
      title: input.title,
      description: input.description ?? null,
      groupId: input.groupId ?? null,
      strictOrder: input.strictOrder ?? true,
      archived: input.archived ?? false,
      createdBy: user.id,
    });
    await tx.insert(batteryItems).values(
      input.items.map((item, i) => ({
        batteryId: id,
        surveyId: item.surveyId,
        position: i,
        required: item.required ?? true,
      })),
    );
  });

  await audit(c, {
    action: "battery.create",
    resourceType: "battery",
    resourceId: id,
    details: { title: input.title, items: input.items.length },
  });
  return c.json({ id }, 201);
});

/**
 * Замена состава батареи целиком.
 *
 * Действует на будущие назначения. Выданные хранят свой состав
 * (battery_assignment_items) и правкой не меняются: добавленный шаг у них не
 * появится, убранный не исчезнет — иначе человек видел бы шаг, доступа на
 * который ему никто не выдавал, а завершённое обследование переписывалось
 * бы задним числом (внешний разбор 2026-09-28). Сколько открытых назначений
 * осталось на прежнем составе — в журнал: методист, который хочет довыдать
 * шаг уже назначенным, назначит набор заново или выдаст методику руками.
 */
batteryRoutes.put("/:id", requireStaff, requirePermission("batteries.manage"), async (c) => {
  const user = c.get("user");
  const batteryId = c.req.param("id");
  await assertBatteryAccess(user, batteryId);
  const input = await parseBody(c.req.raw, batteryInputSchema);
  if (input.groupId) await assertGroupAccess(user, input.groupId);
  for (const item of input.items) await assertSurveyAccess(user, item.surveyId);

  const [{ open } = { open: 0 }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(batteryAssignments)
    .where(
      and(
        eq(batteryAssignments.batteryId, batteryId),
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
      ),
    );

  await db.transaction(async (tx) => {
    await tx
      .update(batteries)
      .set({
        title: input.title,
        description: input.description ?? null,
        groupId: input.groupId ?? null,
        strictOrder: input.strictOrder ?? true,
        archived: input.archived ?? false,
      })
      .where(eq(batteries.id, batteryId));
    await tx.delete(batteryItems).where(eq(batteryItems.batteryId, batteryId));
    await tx.insert(batteryItems).values(
      input.items.map((item, i) => ({
        batteryId,
        surveyId: item.surveyId,
        position: i,
        required: item.required ?? true,
      })),
    );
  });

  await audit(c, {
    action: "battery.update",
    resourceType: "battery",
    resourceId: batteryId,
    // открытые назначения остались на прежнем составе — см. докблок
    details: { title: input.title, items: input.items.length, openAssignmentsKept: Number(open) },
  });
  return c.json({ ok: true });
});

batteryRoutes.delete("/:id", requireStaff, requirePermission("batteries.manage"), async (c) => {
  const user = c.get("user");
  const batteryId = c.req.param("id");
  // FOR UPDATE: выдача, стоящая за этим замком, после удаления не найдёт набора
  const row = await assertBatteryAccess(user, batteryId, "update");

  /*
   * Любое назначение — не только открытое — держит батарею от удаления.
   * Завершённое назначение это запись о том, что человек реально проходил
   * этот набор; каскад стёр бы её вместе с батареей, и в карте осталось бы
   * прохождение без объяснения, откуда оно взялось. Отработавшая батарея
   * отправляется в архив, а не в утиль.
   *
   * Счёт — под замком строки набора (см. assertBatteryAccess), а внешний
   * ключ назначений с миграции 0119 RESTRICT: удаление с историей падает и в
   * базе, мимо маршрута.
   */
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(batteryAssignments)
    .where(eq(batteryAssignments.batteryId, batteryId));
  if (Number(count) > 0)
    badRequest("err.batteryHasAssignments", { count: Number(count) });

  await db.delete(batteries).where(eq(batteries.id, batteryId));
  await audit(c, {
    action: "battery.delete",
    resourceType: "battery",
    resourceId: batteryId,
    details: { title: row.title },
  });
  return c.body(null, 204);
});

async function loadAssignments(where: SQL | undefined, lang: Lang) {
  const rows = await db
    .select({
      assignment: batteryAssignments,
      battery: batteries,
      user: users,
    })
    .from(batteryAssignments)
    .innerJoin(batteries, eq(batteries.id, batteryAssignments.batteryId))
    .innerJoin(users, eq(users.id, batteryAssignments.userId))
    .where(where)
    .orderBy(desc(batteryAssignments.assignedAt));

  // состав — снимок самого назначения, не текущий шаблон набора (lib/batteries.ts)
  const items = await loadAssignmentItems(rows.map((r) => r.assignment.id), lang);
  const userIds = [...new Set(rows.map((r) => r.user.id))];
  const completions = userIds.length
    ? await db
        .select({
          userId: responses.userId,
          surveyId: responses.surveyId,
          responseId: responses.id,
          submittedAt: responses.submittedAt,
        })
        .from(responses)
        .where(and(inArray(responses.userId, userIds), eq(responses.status, "completed")))
    : [];

  const nowMs = Date.now();
  const result: BatteryAssignment[] = rows.map((r) => {
    const list = items.get(r.assignment.id) ?? [];
    const mine = completions
      .filter((x) => x.userId === r.user.id && x.submittedAt)
      .map((x) => ({ surveyId: x.surveyId, responseId: x.responseId, submittedAt: x.submittedAt! }));
    /*
     * Прогресс — тем же расчётом, что допуск к сдаче и завершение
     * назначения (lib/batteries.ts, batteryProgress): экран не может
     * показать «откроется позже» там, где сервер пустит, или «пройдено» там,
     * где назначение не закроется.
     */
    const progress = batteryProgress(list, r.battery.strictOrder, r.assignment.assignedAt, mine);
    const steps: BatteryStep[] = progress.steps.map((s) => ({
      ...toBatteryItem(s),
      state: s.state,
      responseId: s.responseId,
      submittedAt: s.submittedAt,
    }));
    return {
      id: r.assignment.id,
      batteryId: r.battery.id,
      batteryTitle: r.battery.title,
      userId: r.user.id,
      userName: fullNameOf(r.user),
      assignedAt: r.assignment.assignedAt,
      dueAt: r.assignment.dueAt,
      completedAt: r.assignment.completedAt,
      cancelledAt: r.assignment.cancelledAt,
      // пометку сервера (каскад, расписание, приглашение, пропуск) — фразой на языке запроса
      note: renderNote(r.assignment.note, lang),
      overdue:
        !!r.assignment.dueAt &&
        !r.assignment.completedAt &&
        !r.assignment.cancelledAt &&
        parseTs(r.assignment.dueAt) < nowMs,
      doneRequired: progress.doneRequired,
      totalRequired: progress.totalRequired,
      steps,
    };
  });
  return result;
}

/** Назначения по батарее */
batteryRoutes.get("/:id/assignments", requireStaff, requirePermission("assignments.manage"), async (c) => {
  const user = c.get("user");
  const batteryId = c.req.param("id");
  await assertBatteryAccess(user, batteryId);
  const result = await loadAssignments(
    eq(batteryAssignments.batteryId, batteryId),
    langOf(c),
  );
  await audit(c, {
    action: "battery.assignment_list",
    resourceType: "battery",
    resourceId: batteryId,
    details: { assignments: result.length },
  });
  return c.json({ items: result });
});

/**
 * Назначение батареи обследуемому.
 *
 * Заодно выдаётся доступ к каждой методике набора: правила видимости живут в
 * survey_access, и обходить их отдельной веткой для батарей значило бы завести
 * второй источник истины о том, кто что видит.
 */
batteryRoutes.post("/:id/assign", requireStaff, requirePermission("assignments.manage"), async (c) => {
  const user = c.get("user");
  const batteryId = c.req.param("id");
  // FOR SHARE: архивность и само существование набора проверяются по строке под замком
  const battery = await assertBatteryAccess(user, batteryId, "share");
  if (battery.archived) badRequest("err.batteryArchived");
  await assertBatteryInUse(batteryId);
  const input = await parseBody(c.req.raw, assignBatterySchema);

  const target = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!target) notFound("err.examineeNotFound");
  // набор выдаётся обследуемому — как и доступ к методике (routes/access.ts):
  // назначение сотруднику открывало бы ему методики мимо зоны
  if (target.role !== "user") badRequest("err.assignOnlyToPatient");

  const items = await db.select().from(batteryItems).where(eq(batteryItems.batteryId, batteryId));
  if (!items.length) badRequest("err.batteryEmpty");

  // срок из поля даты — «до конца этого дня» по поясу учреждения, а не полночь по Гринвичу (lib/day.ts)
  const dueAt = deadlineOf(input.dueAt);

  /*
   * Повторное назначение при открытом первом.
   *
   * Уникальный индекс держит одно активное назначение набора на человека, и
   * вставка второго падала нарушением индекса — сотрудник видел 500.
   * Открытое и не просроченное — это «уже назначено», 409 со сроком.
   * Просроченное — это пропуск: оно закрывается с отметкой, и назначение
   * выдаётся заново. Правило одно на расписание, ручное назначение и каскад
   * (lib/batteries.ts, isOverdue и closeMissed).
   */
  const [open] = await db
    .select()
    .from(batteryAssignments)
    .where(
      and(
        eq(batteryAssignments.batteryId, batteryId),
        eq(batteryAssignments.userId, input.userId),
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
      ),
    );
  const now = new Date();
  if (open && !isOverdue(open, now)) {
    conflict("err.batteryAlreadyAssigned", { due: open.dueAt ? (dayOf(open.dueAt) ?? "—") : "—" });
  }

  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    if (open) await closeMissed(tx, [open.id], noteCode("note.missed.reassigned"), now);
    await tx.insert(batteryAssignments).values({
      id,
      batteryId,
      userId: input.userId,
      assignedBy: user.id,
      dueAt,
      note: input.note ?? null,
    });
    // состав назначения — снимок на момент выдачи (lib/batteries.ts)
    await snapshotAssignment(tx, id, items);
    /*
     * Доступ — через grantAccess с term "extend": истёкший продлевается,
     * более долгий не укорачивается. Прежде стояло onConflictDoNothing
     * («назначение поверх существующего доступа не должно его отзывать»), и
     * истёкший доступ оставался истёкшим: набор назначен, а методика из него
     * пациенту не открывается.
     */
    await grantAccess(
      tx as never,
      items.map((item) => ({
        surveyId: item.surveyId,
        userId: input.userId,
        grantedBy: user.id,
        expiresAt: dueAt,
        note: noteCode("note.battery", { title: battery.title }),
        // происхождение доступа — это назначение: по нему отмена знает, что снимать
        viaAssignmentId: id,
      })),
      { term: "extend" },
    );
  });

  await audit(c, {
    action: "battery.assign",
    resourceType: "battery",
    resourceId: batteryId,
    subjectUserId: input.userId,
    details: { surveys: items.length, dueAt, ...(open ? { replacedOverdue: open.id } : {}) },
  });
  return c.json({ id }, 201);
});

/**
 * Снятие назначения: запись сохраняется, проставляется отметка отмены — и
 * снимается доступ, который это назначение выдало (lib/batteries.ts,
 * revokeIssuedAccess: своё происхождение, нет другого открытого назначения с
 * той же методикой; ручная выдача и группа не трогаются).
 *
 * Отметка — условием UPDATE (ещё не снято, не завершено): повторная отмена
 * или отмена уже завершённого доступ не трогает — завершённое выдано и
 * пройдено, его доступ живёт до срока, как и прежде. Порядок «строка
 * назначения → строки доступа» тот же, что у сдачи (holdCompletable), чтобы
 * сдача и отмена не ждали друг друга по кругу. Снятие доступа — системной
 * ролью: это следствие действия над назначением, к которому сотрудник
 * допущен, а строки доступа методик могут лежать вне его зоны чтения.
 */
batteryRoutes.post("/assignments/:assignmentId/cancel", requireStaff, requirePermission("assignments.manage"), async (c) => {
  const user = c.get("user");
  const assignmentId = c.req.param("assignmentId");
  const row = await db.query.batteryAssignments.findFirst({
    where: eq(batteryAssignments.id, assignmentId),
  });
  if (!row) notFound("err.assignmentNotFound");
  await assertBatteryAccess(user, row.batteryId);

  const cancelled = await db
    .update(batteryAssignments)
    .set({ cancelledAt: new Date().toISOString() })
    .where(
      and(
        eq(batteryAssignments.id, assignmentId),
        isNull(batteryAssignments.cancelledAt),
        isNull(batteryAssignments.completedAt),
      ),
    )
    .returning({ id: batteryAssignments.id });
  const access = cancelled.length
    ? await asSystem(() => revokeIssuedAccess({ id: assignmentId, userId: row.userId }))
    : { revoked: 0, kept: 0 };

  await audit(c, {
    action: "battery.cancel",
    resourceType: "battery",
    resourceId: row.batteryId,
    subjectUserId: row.userId,
    details: { assignmentId, accessRevoked: access.revoked, accessKept: access.kept },
  });
  return c.json({ ok: true });
});

/** Мои батареи — то, что видит обследуемый в приложении */
batteryRoutes.get("/mine", async (c) => {
  const user = c.get("user");
  const result = await loadAssignments(
    and(eq(batteryAssignments.userId, user.id), isNull(batteryAssignments.cancelledAt)),
    langOf(c),
  );
  return c.json({ items: result });
});
