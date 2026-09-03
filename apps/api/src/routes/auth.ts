import { Hono } from "hono";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
  workspacePrefsSchema,
} from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { responses, users } from "../db/schema";
import { audit } from "../lib/audit";
import { hashPassword, makePseudonym, toPublicUser, verifyPassword } from "../lib/auth";
import { issuePair, revokeAllFor, revokeByToken, rotateRefresh } from "../lib/refresh";
import { clearFailures, isLockedOut, recordFailure } from "../lib/loginGuard";
import { badRequest, conflict, notFound, parseBody, unauthorized } from "../lib/http";
import { normalizePhone, phoneFingerprint } from "../lib/phone";
import { consumeInvite, findUsableInvite } from "../lib/invites";
import { encryptField, encryptPersonFields } from "../lib/crypto";
import { env } from "../env";
import { authorizeUrl, domainAllowed, exchangeCode, googleEnabled } from "../lib/google";
import type { Context } from "hono";
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
  // регистрация — до аутентификации: пишет назначения и доступы системно
  return systemContext(baseDb, () => registerHandler(c));
});

async function registerHandler(c: Context<AppEnv>) {
  const input = await parseBody(c.req.raw, registerSchema);
  const email = input.email.toLowerCase();

  /*
   * Номер приводится к международному виду до проверки на дубликат.
   *
   * Один и тот же телефон человек записывает пятью способами; без
   * нормализации слепой индекс ловил бы не дубликаты, а совпадения
   * написания — то есть почти ничего.
   */
  const phone = normalizePhone(input.phone);
  if (!phone) badRequest("err.phoneInvalid");
  const phoneIndex = phoneFingerprint(phone);

  /*
   * Один человек — один аккаунт. Проверка по слепому индексу: сравнить можно,
   * расшифровывать для этого не нужно.
   *
   * Отказ не говорит, чей это номер, и не подтверждает, что владелец здесь
   * зарегистрирован под другим именем: «номер уже используется» — это всё,
   * что посторонний вправе узнать.
   */
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
          ? "err.inviteExpired"
          : invite.reason === "exhausted"
            ? "err.inviteExhausted"
            : "err.inviteInvalid",
      );
    }
  } else if (!env.openRegistration && !isBootstrap) {
    badRequest("err.inviteRequired");
  }

  /*
   * Дубликаты проверяются ПОСЛЕ права зарегистрироваться, а не до.
   *
   * Раньше порядок был обратный, и закрытая регистрация этих проверок не
   * закрывала. Неаутентифицированный запрос с чужим номером телефона
   * получал три различимых ответа: «номер занят», «почта занята» и «нужно
   * приглашение». По одному номеру телефона это давало ответ на вопрос,
   * состоит ли человек на учёте в психоневрологическом учреждении, — при
   * том что ни войти, ни зарегистрироваться отвечающий не мог.
   *
   * Теперь без приглашения запрос останавливается раньше, чем что-либо
   * узнаёт о существующих людях.
   */
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) conflict("err.emailExists");

  const samePhone = await db.query.users.findFirst({ where: eq(users.phoneIndex, phoneIndex) });
  if (samePhone) conflict("err.phoneExists");

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
      phoneEnc: encryptField(phone),
      phoneIndex,
      // подтверждать нечем: внешнего шлюза нет и не будет
      phoneVerified: false,
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
}

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
    unauthorized("err.tooManyAttempts");
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
    unauthorized("err.invalidCredentials");
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
 * Настройки рабочего места.
 *
 * Отдельным маршрутом, а не полем в PATCH /me: паспортная часть — клинические
 * данные с шифрованием и журналом, а плотность таблиц — нет. Смешивать их
 * значит писать в журнал доступа «правка пациента» при переключении темы.
 */
authRoutes.put("/me/workspace", requireAuth, async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, workspacePrefsSchema);

  // слияние, а не замена: клиент шлёт то, что поменял
  const merged = { ...((user.workspace as object | null) ?? {}), ...input };
  await db.update(users).set({ workspace: merged }).where(eq(users.id, user.id));

  return c.json(merged);
});

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
    unauthorized("err.wrongCurrentPassword");
  }
  if (input.currentPassword === input.newPassword) {
    badRequest("err.samePassword");
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
  if (!raw) unauthorized("err.noRefreshToken");

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
    unauthorized("err.sessionExpired");
  }
  return c.json(outcome.pair);
});

authRoutes.post("/logout", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.refreshToken === "string") await revokeByToken(body.refreshToken);
  return c.json({ ok: true });
});


/**
 * Раскрытие учётной записи под кодом.
 *
 * Необратимо, и об этом сказано до нажатия. Пройденные под кодом методики
 * привязываются к имени — обратной операции нет: карта уже собрана, и
 * притворяться, что данные исчезли, было бы обманом.
 *
 * Раскрытие добавляет имя, а не контакты: телефон был указан при регистрации,
 * потому что он обязателен для всех.
 */
authRoutes.post("/me/reveal", requireAuth, async (c) => {
  const user = c.get("user");
  const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  if (!row) notFound("err.userNotFound");
  if (!row.anonymous) badRequest("err.alreadyNamed");

  const input = await parseBody(
    c.req.raw,
    z.object({
      firstName: z.string().min(1).max(80),
      lastName: z.string().min(1).max(80),
      middleName: z.string().max(80).nullish(),
    }),
  );

  /*
   * Сколько уже пройдено — считается здесь и возвращается в ответе, чтобы
   * клиент мог назвать это число в предупреждении ДО нажатия. Считать его на
   * клиенте значило бы показать «0 методик» тому, кто прошёл двенадцать.
   */
  const [passed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(responses)
    .where(and(eq(responses.userId, user.id), eq(responses.status, "completed")));

  await db
    .update(users)
    .set({
      anonymous: false,
      ...encryptPersonFields({
        firstName: input.firstName,
        lastName: input.lastName,
        middleName: input.middleName ?? null,
        birthDate: null,
      }),
      // дату рождения не трогаем: она хранилась и под кодом
      birthDate: row.birthDate,
    })
    .where(eq(users.id, user.id));

  await audit(c, {
    action: "account.reveal",
    resourceType: "user",
    resourceId: user.id,
    subjectUserId: user.id,
    details: { responsesLinked: Number(passed?.n ?? 0), pseudonym: row.pseudonym },
  });

  const fresh = (await db.query.users.findFirst({ where: eq(users.id, user.id) }))!;
  return c.json({ user: toPublicUser(fresh), responsesLinked: Number(passed?.n ?? 0) });
});

/* ═══════════ Вход через Google ═══════════ */

/**
 * Три правила, на которых здесь всё держится.
 *
 * **Google не создаёт учётных записей.** Роль и область видимости — кого
 * сотрудник вправе видеть — назначает человек. Учётная запись, заведённая
 * входом извне, либо бесправна и бесполезна, либо получает права по
 * умолчанию, и тогда доступ к картам раздаёт внешний поставщик.
 *
 * **Google не входит в учётную запись под кодом.** Анонимность здесь
 * означает, что специалист видит «Респондент А-4821» вместо имени. Связать
 * такую запись с Google — значит подставить в неё настоящее имя и почту,
 * то есть отменить ровно то, ради чего она заведена.
 *
 * **Пароль остаётся.** Это дополнительная дверь, а не замена: в учреждении,
 * где работают по записи, потеря доступа из-за сбоя у внешнего поставщика —
 * это несостоявшийся приём.
 */

/** Состояние между началом входа и возвратом: живёт минуты, в памяти процесса */
const pending = new Map<string, { verifier: string; at: number; linkUserId?: string }>();

/*
 * Хранится в памяти, а не в базе, намеренно: запись живёт минуты и не нужна
 * после возврата. Плата — перезапуск сервера роняет начатые входы; человек
 * нажимает «войти» ещё раз. Обратная плата, забытые строки в базе, дороже.
 */
function rememberState(verifier: string, linkUserId?: string): string {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  for (const [key, value] of pending) if (Date.now() - value.at > 600_000) pending.delete(key);
  pending.set(state, { verifier, at: Date.now(), linkUserId });
  return state;
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = new Bun.CryptoHasher("sha256").update(verifier).digest();
  return Buffer.from(digest).toString("base64url");
}

function newVerifier(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** Настроен ли способ — консоль спрашивает, чтобы не рисовать кнопку в никуда */
authRoutes.get("/google/status", (c) => c.json({ enabled: googleEnabled() }));

authRoutes.get("/google/start", async (c) => {
  if (!googleEnabled()) notFound("err.googleDisabled");
  const verifier = newVerifier();
  const state = rememberState(verifier);
  return c.redirect(authorizeUrl(state, await challengeOf(verifier)));
});

/**
 * Связывание с уже открытой учётной записью.
 *
 * Отдельный вход, потому что здесь мы знаем, кого связываем: идентификатор
 * кладётся в состояние и на возврате берётся оттуда, а не из того, что
 * прислал браузер. Иначе связать Google можно было бы с чужой записью,
 * подсунув её идентификатор в адресе.
 */
authRoutes.post("/google/link", requireAuth, async (c) => {
  /*
   * Отдаём адрес, а не перенаправляем.
   *
   * Маршрут закрыт `requireAuth`, то есть требует заголовка Authorization.
   * Консоль хранит токен в localStorage и шлёт его заголовком — обычная
   * ссылка такого заголовка не несёт, и переход браузером всегда получал
   * 401. Связать учётную запись было нельзя вовсе, а значит и вход через
   * Google не мог завершиться ничем, кроме «не привязано».
   *
   * Ровно об этой ловушке предупреждает комментарий в api.ts клиента —
   * и я в неё всё равно попал.
   */
  if (!googleEnabled()) notFound("err.googleDisabled");
  const user = c.get("user");
  if (user.anonymous) badRequest("err.googleAnonymous");
  const verifier = newVerifier();
  const state = rememberState(verifier, user.id);
  return c.json({ url: authorizeUrl(state, await challengeOf(verifier)) });
});

authRoutes.post("/google/unlink", requireAuth, async (c) => {
  const user = c.get("user");
  await db.update(users).set({ googleSub: null }).where(eq(users.id, user.id));
  await audit(c, {
    action: "auth.google_unlinked",
    resourceType: "user",
    resourceId: user.id,
    actor: user,
  });
  return c.json({ ok: true });
});

authRoutes.get("/google/callback", async (c) => {
  if (!googleEnabled()) notFound("err.googleDisabled");

  const code = c.req.query("code");
  const state = c.req.query("state");
  const saved = state ? pending.get(state) : undefined;
  if (state) pending.delete(state);
  if (!code || !saved) unauthorized("err.googleState");

  let identity: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    identity = await exchangeCode(code, saved.verifier);
  } catch {
    unauthorized("err.googleExchange");
  }

  /*
   * Непроверенную почту не принимаем. Google отдаёт её и для записей, где
   * адрес просто вписан, — а мы по адресу ищем, к какой учётной записи
   * привязываться.
   */
  if (!identity.emailVerified) unauthorized("err.googleUnverified");
  if (!domainAllowed(identity.email)) unauthorized("err.googleDomain");

  // ── связывание с открытой учётной записью ──
  if (saved.linkUserId) {
    const taken = await db.query.users.findFirst({
      where: eq(users.googleSub, identity.sub),
    });
    if (taken && taken.id !== saved.linkUserId) conflict("err.googleTaken");
    await db
      .update(users)
      .set({ googleSub: identity.sub })
      .where(eq(users.id, saved.linkUserId));
    const linked = await db.query.users.findFirst({ where: eq(users.id, saved.linkUserId) });
    await audit(c, {
      action: "auth.google_linked",
      resourceType: "user",
      resourceId: saved.linkUserId,
      actor: linked ? toPublicUser(linked) : null,
      details: { email: identity.email },
    });
    return c.redirect(`${env.consoleUrl ?? ""}/?google=linked`);
  }

  // ── вход ──
  const row = await db.query.users.findFirst({ where: eq(users.googleSub, identity.sub) });
  if (!row) {
    /*
     * Учётная запись не создаётся. Ответ намеренно один и тот же и для
     * «такого человека нет», и для «есть, но Google не связан»: иначе по
     * коду отказа можно перебирать, кто в учреждении есть.
     */
    await audit(c, {
      action: "auth.google_denied",
      outcome: "denied",
      details: { email: identity.email, reason: "not_linked" },
    });
    unauthorized("err.googleNotLinked");
  }
  if (row.anonymous) unauthorized("err.googleAnonymous");

  await audit(c, {
    action: "auth.login",
    resourceType: "user",
    resourceId: row.id,
    actor: toPublicUser(row),
    details: { via: "google" },
  });

  const pair = await issuePair(row);
  /*
   * Пара уезжает в адресе возврата, а не в теле: сюда человек приходит
   * переходом браузера, а не запросом из кода, и вернуть JSON некому.
   * Консоль забирает значения из адреса и сразу его чистит.
   */
  const back = new URL(`${env.consoleUrl || ""}/auth/google`, "http://localhost");
  back.searchParams.set("token", pair.token);
  back.searchParams.set("refresh", pair.refreshToken);
  return c.redirect(env.consoleUrl ? back.toString() : `${back.pathname}${back.search}`);
});
