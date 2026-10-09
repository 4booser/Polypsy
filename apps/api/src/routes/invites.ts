import { Hono } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { createInviteSchema, inviteListQuery, t, type Invite, type InvitePreview, type Page } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { batteries, invites, inviteUses, specialistProfiles, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { afterCursor, decodeExactCursor, encodeCursor, exactAt } from "../lib/cursor";
import { fullNameOf } from "../lib/auth";
import { badRequest, forbidden, langOf, notFound, parseBody, parseQuery } from "../lib/http";
import { findUsableInvite, hashInviteToken, newInviteCode, newInviteToken } from "../lib/invites";
import { assertGroupAccess, assertSurveyAccess, isStaff, isSuperadmin } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const inviteRoutes = new Hono<AppEnv>();

/**
 * Предпросмотр — единственный публичный маршрут: человек по ссылке ещё не
 * зарегистрирован. Наружу уходит только название батареи и подразделение,
 * никаких имён и внутренних id.
 */
inviteRoutes.get("/preview/:token", async (c) => {
  /*
   * Системным контекстом, как регистрация по той же ссылке (routes/auth.ts):
   * маршрут публичный, контекста запроса у него нет, а без контекста
   * политики не дают ничего. Под ролью приложения каждое действующее
   * приглашение отвечало «ссылка недействительна» (unknown) — ещё до ввода
   * пароля, то есть человек по ссылке врача не мог даже начать. Сюита этого
   * не видела: владелец политики обходит (волна 13, прогон части сюиты под
   * ролью приложения). Что уходит наружу — решает код ниже, а не роль.
   */
  const preview = await systemContext(baseDb, () => invitePreview(c.req.param("token"), langOf(c)));
  return c.json<InvitePreview>(preview);
});

async function invitePreview(token: string, lang: ReturnType<typeof langOf>): Promise<InvitePreview> {
  const lookup = await findUsableInvite(token);
  if (!lookup.ok) return { valid: false, reason: lookup.reason };
  const battery = lookup.invite.batteryId
    ? await db.query.batteries.findFirst({ where: eq(batteries.id, lookup.invite.batteryId) })
    : null;
  /*
   * Название методики — наружу, имя врача — нет.
   *
   * Человек до регистрации вправе знать, что его ждёт: «Депрессия по Беку»
   * на экране до ввода пароля честнее пустой формы. Имя закреплённого врача
   * к этому вопросу не относится, а ссылка ходит по почте и мессенджерам —
   * состав психологического отдела из неё узнавать незачем.
   */
  const survey = lookup.invite.surveyId
    ? await db.query.surveys.findFirst({ where: eq(surveys.id, lookup.invite.surveyId) })
    : null;
  return {
    valid: true,
    batteryTitle: battery?.title ?? null,
    surveyTitle: survey ? t(survey.title as never, lang) : null,
    unit: lookup.invite.unit,
  };
}

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 *
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
inviteRoutes.use("*", requireAuth, requireStaff, requirePermission("invites.manage"));

/** Приглашение привязано к батарее — права на него идут от группы батареи */
async function assertInviteBattery(user: Parameters<typeof assertGroupAccess>[0], batteryId: string | null) {
  if (!batteryId) {
    if (!isStaff(user)) forbidden("err.forStaffOnly");
    return;
  }
  const battery = await db.query.batteries.findFirst({ where: eq(batteries.id, batteryId) });
  if (!battery) notFound("err.batteryNotFound");
  if (battery.groupId) await assertGroupAccess(user, battery.groupId);
}

/**
 * Приглашение своё, если своё то, к чему оно ведёт: батарея — по её группе,
 * методика — по её группе.
 *
 * Прежде видимость и отзыв спрашивали только батарею, а приглашение с
 * методикой (без батареи) считалось «ничьим» — и администратор любой группы
 * видел в своём списке ссылки чужих групп и мог их отозвать. Выписать такую
 * ссылку он не мог (при создании методика проверяется), а увидеть и
 * погасить — мог. Нашлось сравнением ответов владельцем и ролью приложения
 * (волна 13): под ролью у чужой строки пропадало название методики — его
 * прятала политика surveys, — а сама строка оставалась.
 */
async function assertInviteScope(
  user: Parameters<typeof assertGroupAccess>[0],
  invite: { batteryId: string | null; surveyId: string | null; createdBy: string },
) {
  await assertInviteBattery(user, invite.batteryId);
  if (invite.surveyId) await assertSurveyAccess(user, invite.surveyId);
  if (!invite.batteryId && !invite.surveyId) await assertInviteDepartment(user, invite.createdBy);
}

/*
 * Приглашение без набора и без методики (или чей набор удалён) ни к чему не
 * ведёт, и области по группе у него нет. Прежде его видел и гасил любой
 * сотрудник с invites.manage — в том числе выписанное суперадмином (#51).
 * Решение владельца 2026-10-09: такое приглашение принадлежит отделению
 * выписавшего — видят и отзывают его выписавший, сотрудники того же
 * отделения и суперадмин. Отделение — по профилю специалиста; профили видны
 * всем сотрудникам (политика specialist_profiles), так что asSystem не нужен,
 * и оба отделения читаются одним запросом.
 */
async function assertInviteDepartment(user: Parameters<typeof assertGroupAccess>[0], createdBy: string) {
  if (isSuperadmin(user) || createdBy === user.id) return;
  const rows = await db
    .select({ userId: specialistProfiles.userId, departmentId: specialistProfiles.departmentId })
    .from(specialistProfiles)
    .where(inArray(specialistProfiles.userId, [user.id, createdBy]));
  const mine = rows.find((r) => r.userId === user.id)?.departmentId ?? null;
  const theirs = rows.find((r) => r.userId === createdBy)?.departmentId ?? null;
  if (!mine || mine !== theirs) forbidden("err.inviteOtherDepartment");
}

/**
 * Выписанные приглашения — страницами (`?limit=&cursor=`), свежие сверху.
 *
 * Прежде список отдавался целиком, и видимость проверялась на каждой строке
 * отдельно: за каждое приглашение, когда-либо выписанное в учреждении, —
 * свой поход за батареей и за правом на её группу. Приглашения копятся
 * годами, и экран становился тем медленнее, чем дольше отделение работает.
 *
 * Видимость по-прежнему решает проверка области (assertInviteScope) — то есть область
 * ответственности из lib/scope.ts, а не второе правило в SQL рядом с ней, —
 * но вердикт запоминается на пару «батарея, методика»: их десятки, приглашений тысячи.
 * Страница собирается кусками, пока не наберётся limit видимых и ещё одно —
 * чтобы знать, что за ней есть продолжение.
 */
inviteRoutes.get("/", async (c) => {
  const user = c.get("user");
  const { limit, cursor: rawCursor } = parseQuery(c, inviteListQuery);
  let scanFrom = decodeExactCursor(rawCursor);

  const verdicts = new Map<string, boolean>();
  const canSee = async (row: { batteryId: string | null; surveyId: string | null; createdBy: string }): Promise<boolean> => {
    // приглашение без набора и методики решается по выписавшему — он в ключе
    const key = `${row.batteryId ?? ""}|${row.surveyId ?? ""}|${row.batteryId || row.surveyId ? "" : row.createdBy}`;
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    let ok = true;
    try {
      await assertInviteScope(user, row);
    } catch {
      // чужие приглашения не показываем
      ok = false;
    }
    verdicts.set(key, ok);
    return ok;
  };

  const picked: { r: typeof invites.$inferSelect; at: string }[] = [];
  let more = false;
  const CHUNK = Math.max(limit + 1, 100);
  for (;;) {
    const chunk = await db
      .select({ r: invites, at: exactAt(invites.createdAt) })
      .from(invites)
      .where(afterCursor(invites.createdAt, invites.id, scanFrom))
      .orderBy(desc(invites.createdAt), desc(invites.id))
      .limit(CHUNK);
    for (const row of chunk) {
      if (!(await canSee(row.r))) continue;
      if (picked.length === limit) {
        more = true;
        break;
      }
      picked.push(row);
    }
    if (more || chunk.length < CHUNK) break;
    const tail = chunk[chunk.length - 1]!;
    scanFrom = { at: tail.at, id: tail.r.id };
  }
  const visible = picked.map((p) => p.r);
  const lastPicked = picked[picked.length - 1];

  const batteryIds = [...new Set(visible.map((r) => r.batteryId).filter((x): x is string => !!x))];
  const batteryRows = batteryIds.length
    ? await db.select().from(batteries).where(inArray(batteries.id, batteryIds))
    : [];
  const titleOf = new Map(batteryRows.map((b) => [b.id, b.title]));

  const surveyIds = [...new Set(visible.map((r) => r.surveyId).filter((x): x is string => !!x))];
  const surveyRows = surveyIds.length
    ? await db.select({ id: surveys.id, title: surveys.title }).from(surveys).where(inArray(surveys.id, surveyIds))
    : [];
  const lang = langOf(c);
  const surveyTitleOf = new Map(surveyRows.map((s) => [s.id, t(s.title as never, lang)]));

  /*
   * Имена врачей берутся одним запросом вместе с именами выписавших: и те и
   * другие — строки users, и разделять их значило бы сходить в ту же таблицу
   * дважды за тем же самым.
   */
  const creatorIds = [
    ...new Set([
      ...visible.map((r) => r.createdBy),
      ...visible.map((r) => r.specialistId).filter((x): x is string => !!x),
    ]),
  ];
  const creators = creatorIds.length
    ? await db.select().from(users).where(inArray(users.id, creatorIds))
    : [];
  const creatorOf = new Map(creators.map((u) => [u.id, fullNameOf(u)]));

  const useRows = visible.length
    ? await db
        .select({ use: inviteUses, user: users })
        .from(inviteUses)
        .innerJoin(users, eq(users.id, inviteUses.userId))
        .where(inArray(inviteUses.inviteId, visible.map((r) => r.id)))
    : [];

  const result: Invite[] = visible.map((r) => ({
    id: r.id,
    code: r.code,
    batteryId: r.batteryId,
    batteryTitle: r.batteryId ? (titleOf.get(r.batteryId) ?? null) : null,
    surveyId: r.surveyId,
    surveyTitle: r.surveyId ? (surveyTitleOf.get(r.surveyId) ?? null) : null,
    specialistId: r.specialistId,
    specialistName: r.specialistId ? (creatorOf.get(r.specialistId) ?? null) : null,
    unit: r.unit,
    note: r.note,
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
    createdByName: creatorOf.get(r.createdBy) ?? "—",
    uses: useRows
      .filter((u) => u.use.inviteId === r.id)
      .map((u) => ({ userId: u.user.id, fullName: fullNameOf(u.user), usedAt: u.use.usedAt })),
  }));
  return c.json({
    items: result,
    nextCursor: more && lastPicked ? encodeCursor(lastPicked.at, lastPicked.r.id) : null,
  } satisfies Page<Invite>);
});

/** Создание: токен показывается ОДИН раз — дальше в базе только хеш */
inviteRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, createInviteSchema);
  await assertInviteBattery(user, input.batteryId ?? null);

  /*
   * Набор ИЛИ методика, но не оба сразу.
   *
   * Набор — это несколько опросников; «набор и ещё одна методика» даёт
   * назначение, состав которого не виден ни из приглашения, ни из карты.
   */
  if (input.batteryId && input.surveyId) badRequest("err.inviteBatteryOrSurvey");

  /* методика выдаётся из своей зоны — как и при обычном назначении */
  if (input.surveyId) await assertSurveyAccess(user, input.surveyId);

  /*
   * Врач по умолчанию — тот, кто выписывает: ссылку под случай выписывают
   * себе. Указанный явно проверяется на то, что он вообще специалист: иначе
   * приглашение закрепило бы человека за пациентом.
   */
  const specialistId = input.specialistId ?? user.id;
  const [specialist] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, specialistId))
    .limit(1);
  if (!specialist || !isStaff(specialist as never)) badRequest("err.specialistNotFound");

  const rawToken = newInviteToken();
  const id = crypto.randomUUID();
  const code = newInviteCode();
  await db.insert(invites).values({
    id,
    tokenHash: hashInviteToken(rawToken),
    code,
    createdBy: user.id,
    batteryId: input.batteryId ?? null,
    surveyId: input.surveyId ?? null,
    specialistId,
    unit: input.unit ?? null,
    note: input.note ?? null,
    maxUses: input.maxUses ?? 1,
    expiresAt: new Date(Date.now() + (input.ttlDays ?? 14) * 86_400_000).toISOString(),
  });

  await audit(c, {
    action: "invite.create",
    resourceType: "invite",
    resourceId: id,
    details: {
      batteryId: input.batteryId ?? null,
      surveyId: input.surveyId ?? null,
      specialistId,
      maxUses: input.maxUses ?? 1,
      ttlDays: input.ttlDays ?? 14,
    },
  });
  return c.json({ id, token: rawToken, code }, 201);
});

inviteRoutes.post("/:id/revoke", async (c) => {
  const user = c.get("user");
  const row = await db.query.invites.findFirst({ where: eq(invites.id, c.req.param("id")) });
  if (!row) notFound("err.inviteNotFound");
  await assertInviteScope(user, row);

  await db.update(invites).set({ revokedAt: new Date().toISOString() }).where(eq(invites.id, row.id));
  await audit(c, {
    action: "invite.revoke",
    resourceType: "invite",
    resourceId: row.id,
    details: { usedCount: row.usedCount },
  });
  return c.json({ ok: true });
});
