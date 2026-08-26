import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { changePasswordSchema, loginSchema, registerSchema, updateProfileSchema } from "@quizzy/shared";
import { db } from "../db";
import { users } from "../db/schema";
import { audit } from "../lib/audit";
import { hashPassword, issueToken, makePseudonym, toPublicUser, verifyPassword } from "../lib/auth";
import { issuePair, revokeAllFor, revokeByToken, rotateRefresh } from "../lib/refresh";
import { clearFailures, isLockedOut, recordFailure } from "../lib/loginGuard";
import { badRequest, conflict, parseBody, unauthorized } from "../lib/http";
import { consumeInvite, findUsableInvite } from "../lib/invites";
import { encryptPersonFields } from "../lib/crypto";
import { env } from "../env";
import { requireAuth, type AppEnv } from "../middleware/auth";

export const authRoutes = new Hono<AppEnv>();

/**
 * Самостоятельная регистрация всегда создаёт обычного пользователя.
 * Роль с клиента не принимается: раздавать себе права администратора,
 * имея доступ только к форме регистрации, недопустимо.
 *
 * Единственное исключение — первичная инициализация: если в базе нет ни одного
 * пользователя, первый зарегистрировавшийся становится администратором, иначе
 * свежую установку некому было бы настроить. Дальше учётные записи персонала
 * заводит администратор через POST /api/users.
 */
authRoutes.post("/register", async (c) => {
  const input = await parseBody(c.req.raw, registerSchema);
  const email = input.email.toLowerCase();

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) conflict("Пользователь с таким email уже существует");

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users);
  const isBootstrap = Number(count) === 0;

  // Вход по приглашению: проверяем ДО создания аккаунта. При закрытой
  // регистрации приглашение обязательно — «с улицы» в клиническую систему
  // не попадают. Bootstrap-исключение: самый первый аккаунт создаётся всегда.
  let invite: Awaited<ReturnType<typeof findUsableInvite>> | null = null;
  if (input.inviteCode) {
    invite = await findUsableInvite(input.inviteCode);
    if (!invite.ok) {
      await audit(c, {
        action: "auth.register",
        outcome: "denied",
        details: { email, reason: `invite_${invite.reason}` },
      });
      badRequest(
        invite.reason === "expired"
          ? "Срок приглашения истёк — попросите новое у своего специалиста"
          : invite.reason === "exhausted"
            ? "Приглашение уже использовано"
            : "Приглашение не действует",
      );
    }
  } else if (!env.openRegistration && !isBootstrap) {
    badRequest("Регистрация только по приглашению. Попросите ссылку у своего специалиста");
  }

  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email,
      // у псевдонимизированного аккаунта ФИО не пишется в базу вообще
      ...encryptPersonFields({
        firstName: input.anonymous ? "" : (input.firstName ?? ""),
        lastName: input.anonymous ? "" : (input.lastName ?? ""),
        middleName: input.anonymous ? null : (input.middleName ?? null),
        birthDate: input.birthDate ?? null,
      }),
      anonymous: input.anonymous,
      pseudonym: input.anonymous ? makePseudonym() : null,
      sex: input.sex ?? null,
      birthDate: input.birthDate ?? null,
      // подразделение из приглашения главнее введённого: его задал специалист
      unit: (invite?.ok ? invite.invite.unit : null) ?? input.unit ?? null,
      position: input.position ?? null,
      specialty: input.specialty ?? null,
      rank: input.rank ?? null,
      passwordHash: await hashPassword(input.password),
      role: isBootstrap ? "admin" : "user",
    })
    .returning();

  await audit(c, {
    action: "auth.register",
    resourceType: "user",
    resourceId: row!.id,
    subjectUserId: row!.id,
    actor: toPublicUser(row!),
    details: {
      role: row!.role,
      bootstrap: isBootstrap,
      anonymous: row!.anonymous,
      // фиксируем попытку получить роль с клиента — это сигнал о неправильном
      // использовании API или о попытке эскалации
      requestedRole: input.role ?? null,
    },
  });

  if (invite?.ok) {
    const consumed = await consumeInvite(invite.invite, row!.id);
    if (consumed.ok) {
      await audit(c, {
        action: "invite.use",
        resourceType: "invite",
        resourceId: invite.invite.id,
        subjectUserId: row!.id,
        actor: toPublicUser(row!),
        details: { batteryId: invite.invite.batteryId },
      });
    }
    // гонка на последнем использовании: аккаунт уже создан, назначения нет —
    // это честнее, чем падать после создания; специалист выдаст батарею руками
  }

  const pair = await issuePair(row!);
  return c.json({ ...pair, user: toPublicUser(row!) }, 201);
});

authRoutes.post("/login", async (c) => {
  const input = await parseBody(c.req.raw, loginSchema);
  const email = input.email.toLowerCase();

  // до проверки пароля: заблокированный email не тратит argon2 и не даёт
  // перебирать дальше. Ответ такой же, как на неверный пароль, плюс задержка
  if (await isLockedOut(email)) {
    await audit(c, {
      action: "auth.login_failed",
      outcome: "denied",
      details: { email, reason: "locked_out" },
    });
    unauthorized("Слишком много попыток. Подождите 15 минут");
  }

  const row = await db.query.users.findFirst({ where: eq(users.email, email) });

  if (!row || !(await verifyPassword(input.password, row.passwordHash))) {
    await recordFailure(email, c.req.header("X-Forwarded-For") ?? null);
    await audit(c, {
      action: "auth.login_failed",
      outcome: "denied",
      resourceType: "user",
      resourceId: row?.id,
      actor: row ? toPublicUser(row) : null,
      // пароль в журнал не попадает никогда — только сам факт и email
      details: { email, reason: row ? "wrong_password" : "unknown_email" },
    });
    unauthorized("Неверный email или пароль");
  }

  await clearFailures(email);

  await audit(c, {
    action: "auth.login",
    resourceType: "user",
    resourceId: row.id,
    actor: toPublicUser(row),
  });

  const pair = await issuePair(row);
  return c.json({ ...pair, user: toPublicUser(row) });
});

authRoutes.get("/me", requireAuth, (c) => c.json(c.get("user")));

/**
 * Заполнение паспортной части. Пациент правит свою сам: пол и дата рождения
 * нужны для норм, а служебные поля — для заключения.
 */
authRoutes.patch("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, updateProfileSchema);

  // псевдонимизированный аккаунт не может внести ФИО задним числом:
  // иначе смысл режима терялся бы одним запросом
  const nameEditable = !user.anonymous;
  const changes = encryptPersonFields({
      ...(nameEditable && input.firstName !== undefined && { firstName: input.firstName }),
      ...(nameEditable && input.lastName !== undefined && { lastName: input.lastName }),
      ...(nameEditable && input.middleName !== undefined && { middleName: input.middleName ?? null }),
      ...(input.sex !== undefined && { sex: input.sex ?? null }),
      ...(input.birthDate !== undefined && { birthDate: input.birthDate ?? null }),
      ...(input.unit !== undefined && { unit: input.unit ?? null }),
      ...(input.position !== undefined && { position: input.position ?? null }),
      ...(input.specialty !== undefined && { specialty: input.specialty ?? null }),
      ...(input.rank !== undefined && { rank: input.rank ?? null }),
  });

  // после фильтрации могло не остаться ничего — например, псевдонимизированный
  // прислал только ФИО. Пустая правка не ошибка, просто ничего не меняется
  if (Object.keys(changes).length === 0) {
    await audit(c, {
      action: "profile.update",
      resourceType: "user",
      resourceId: user.id,
      subjectUserId: user.id,
      details: { fields: Object.keys(input), applied: 0, reason: "нечего менять" },
    });
    return c.json(user);
  }

  const [row] = await db.update(users).set(changes).where(eq(users.id, user.id)).returning();

  await audit(c, {
    action: "profile.update",
    resourceType: "user",
    resourceId: user.id,
    subjectUserId: user.id,
    details: { fields: Object.keys(input), applied: Object.keys(changes).length },
  });

  return c.json(toPublicUser(row!));
});

/**
 * Смена собственного пароля.
 *
 * Требует текущий пароль: угнанный токен не должен позволять перехватить
 * учётную запись насовсем. До появления refresh-токенов (этап 0.4 плана)
 * смена пароля не отзывает уже выданные токены — это честно зафиксировано
 * в журнале самим фактом события.
 */
authRoutes.post("/password", requireAuth, async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, changePasswordSchema);

  const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  if (!row || !(await verifyPassword(input.currentPassword, row.passwordHash))) {
    await audit(c, {
      action: "auth.password_change",
      outcome: "denied",
      resourceType: "user",
      resourceId: user.id,
      details: { reason: "wrong_current_password" },
    });
    unauthorized("Текущий пароль не подходит");
  }
  if (input.currentPassword === input.newPassword) {
    badRequest("Новый пароль совпадает с текущим");
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.newPassword) })
    .where(eq(users.id, user.id));

  // угнанная сессия не должна переживать смену пароля
  const revoked = await revokeAllFor(user.id);

  await audit(c, {
    action: "auth.password_change",
    resourceType: "user",
    resourceId: user.id,
    subjectUserId: user.id,
    details: { revokedSessions: revoked },
  });
  return c.json({ ok: true });
});

/**
 * Обмен refresh-токена. Повторное предъявление погашенного токена гасит всю
 * семью — этот случай пишется в журнал как подозрение на кражу.
 */
authRoutes.post("/refresh", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const raw = typeof body?.refreshToken === "string" ? body.refreshToken : "";
  if (!raw) unauthorized("Нет refresh-токена");

  const outcome = await rotateRefresh(raw);
  if (!outcome.ok) {
    await audit(c, {
      action: "auth.refresh_failed",
      outcome: "denied",
      resourceType: "user",
      resourceId: outcome.userId,
      subjectUserId: outcome.userId ?? null,
      details: { reason: outcome.reason },
    });
    unauthorized("Сессия истекла, войдите заново");
  }
  return c.json(outcome.pair);
});

authRoutes.post("/logout", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.refreshToken === "string") await revokeByToken(body.refreshToken);
  return c.json({ ok: true });
});
