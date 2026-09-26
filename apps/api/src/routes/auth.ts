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
import { issuePair, revokeAllFor, revokeByToken, rotateRefresh, type IssuedPair } from "../lib/refresh";
import { clearFailures, isLockedOut, recordFailure } from "../lib/loginGuard";
import { touchLastSeen } from "../lib/accounts";
import { badRequest, conflict, notFound, parseBody, unauthorized } from "../lib/http";
import { normalizePhone, phoneFingerprint } from "../lib/phone";
import { consumeInvite, findUsableInvite } from "../lib/invites";
import { encryptField, encryptPersonFields } from "../lib/crypto";
import { env } from "../env";
import { authorizeUrl, domainAllowed, exchangeCode, googleEnabled } from "../lib/google";
import type { Context } from "hono";
import { requireAuth, type AppEnv } from "../middleware/auth";

export const authRoutes = new Hono<AppEnv>();

/*
 * Хеш, с которым сверяется пароль для несуществующего адреса.
 *
 * Настоящий argon2-хеш от случайной строки: совпасть с ним нельзя, а время
 * проверки такое же, как у настоящей учётной записи. Ради этого он и нужен —
 * чтобы по времени ответа нельзя было узнать, есть ли такой человек.
 */
const DUMMY_HASH = await hashPassword(crypto.randomUUID() + crypto.randomUUID());

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
  let isBootstrap = Number(count) === 0;

  /*
   * «Первый» проверяется ещё раз — под замком и только на пустой базе.
   *
   * Весь запрос идёт одной транзакцией (см. db/context), но на уровне READ
   * COMMITTED это гонку не закрывает: две регистрации, начатые в одну
   * секунду на свежей установке, обе видят пустую таблицу — чужая вставка
   * ещё не закоммичена — и обе получают роль администратора. На свежем
   * экземпляре это не теоретическая гонка: ссылку на регистрацию дают сразу
   * нескольким сотрудникам, и второй администратор, которого никто не
   * заводил, останется администратором навсегда.
   *
   * Замок берётся только при count = 0, то есть ровно один раз за жизнь
   * установки: обычная регистрация не должна ждать чужого argon2 внутри
   * той же транзакции. Проигравший ждёт коммита победителя (лок
   * транзакционный, снимается вместе с ним), затем пересчитывает — новый
   * оператор в READ COMMITTED берёт свежий снимок и видит вставку — и
   * становится обычным пользователем.
   *
   * Частичный уникальный индекс был бы строже, но потребовал бы колонки-метки
   * «заведён как первый»: администраторов в системе много, и запретить второго
   * индексом по role нельзя.
   */
  if (isBootstrap) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext('auth:bootstrap'))`);
    const [{ count: after } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    isBootstrap = Number(after) === 0;
  }

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
      /*
       * Дата рождения НЕ повторяется здесь, и это не пропуск поля.
       *
       * Она уже ушла выше через encryptPersonFields — шифртекстом. Строка
       * `birthDate: input.birthDate ?? null` стояла ровно тут, ниже по тому
       * же объектному литералу, и перезаписывала шифртекст открытой датой:
       * последнее вхождение ключа выигрывает. То есть шифрование даты
       * рождения работало везде, кроме единственного места, где эта дата
       * появляется, — при регистрации. Дублировать поле рядом с вызовом,
       * который его шифрует, нельзя в принципе; проверено тестом.
       */
      // подразделение из приглашения главнее введённого: его задал специалист
      unit: (invite?.ok ? invite.invite.unit : null) ?? input.unit ?? null,
      position: input.position ?? null,
      specialty: input.specialty ?? null,
      rank: input.rank ?? null,
      locality: input.locality || null,
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

/*
 * Вход идёт системным контекстом — как и регистрация.
 *
 * Всё, к чему он прикасается, лежит под политиками строк: учётная запись,
 * счётчик неудачных попыток, журнал, refresh-токены. Контекста у входа быть
 * не может — роль мы узнаём как раз из найденной строки, — поэтому он
 * объявляется системным явно. Без этого вход в бою (роль quizzy_app) не
 * нашёл бы ни одной учётной записи и отвечал бы «неверные учётные данные»
 * на верный пароль.
 *
 * Отказ бросается СНАРУЖИ транзакции, и это не стилистика.
 *
 * Системный контекст — это транзакция, а исключение из транзакции
 * откатывает её целиком. Брошенный внутри `unauthorized` унёс бы с собой
 * ровно то, что неудачный вход обязан оставить: отметку в счётчике попыток
 * и запись журнала. Защита от перебора перестала бы работать совсем, и
 * незаметно: снаружи ответ тот же самый. Поэтому обработчик возвращает
 * причину отказа, а бросает её вызывающий — когда транзакция уже
 * зафиксирована.
 */
type LoginRefusal = "err.tooManyAttempts" | "err.invalidCredentials" | "err.accountDisabled";

authRoutes.post("/login", async (c) => {
  const outcome = await systemContext(baseDb, () => loginHandler(c));
  if (typeof outcome === "string") unauthorized(outcome);
  return outcome;
});

async function loginHandler(c: Context<AppEnv>): Promise<Response | LoginRefusal> {
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
    return "err.tooManyAttempts";
  }

  const row = await db.query.users.findFirst({ where: eq(users.email, email) });

  /*
   * Пароль проверяется всегда, даже для неизвестного адреса.
   *
   * Короткое замыкание не вызывало argon2, когда учётной записи нет, и
   * ответ приходил за миллисекунды вместо сотни с лишним. Тело ответа
   * одинаковое, а время — нет: перебор списка адресов одним заведомо
   * неверным паролем отделял существующие учётные записи от несуществующих
   * с первой попытки, до всякой блокировки.
   */
  const hash = row?.passwordHash ?? DUMMY_HASH;
  const ok = await verifyPassword(input.password, hash);

  if (!row || !ok) {
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
    return "err.invalidCredentials";
  }

  /*
   * Выключенная учётка (техпанель, миграция 0088) — отказ своими словами, и
   * только ПОСЛЕ проверки пароля.
   *
   * До проверки отказ выдавал бы любому, кто знает адрес, что такая учётка
   * есть и её выключили, — то есть ровно то, что на входе прячут
   * выравниванием времени ответа. После — его прочтёт только тот, кто знает
   * пароль, то есть сам человек; ему и надо понять, что пароль верный, а
   * дверь закрыта, и идти к администратору, а не пробовать ещё пять раз.
   * Неудачей для счётчика попыток это не считается: пароль был верный.
   */
  if (row.disabledAt) {
    await audit(c, {
      action: "auth.login_failed",
      outcome: "denied",
      resourceType: "user",
      resourceId: row.id,
      actor: toPublicUser(row),
      details: { email, reason: "disabled" },
    });
    return "err.accountDisabled";
  }

  await clearFailures(email);

  await audit(c, {
    action: "auth.login",
    resourceType: "user",
    resourceId: row.id,
    actor: toPublicUser(row),
  });

  await touchLastSeen(row.id);
  const pair = await issuePair(row);
  return c.json({ ...pair, user: toPublicUser(row) });
}

/**
 * Кто я и что мне можно назначать.
 *
 * Ступень лестницы должностей отдаётся вместе с профилем, а не отдельным
 * запросом: по ней консоль решает, показывать ли пункт «Права». Без неё
 * пункт стоял бы у всех, включая специалиста, — а специалист не назначает
 * никого, и меню обещало бы ему то, чего сервер не даст.
 *
 * Тем же порядком отдаётся право выписывать приглашения: вкладка
 * «Приглашения» стоит на главном экране, и показывать её тому, кому сервер
 * откажет, значит обещать работу, которой не будет.
 *
 * Само правило это НЕ ограничивает: оно живёт на маршрутах назначения и
 * приглашений и проверяется там. Здесь только подсказка меню.
 */
authRoutes.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const { hasPermission, ladderRankOf } = await import("../lib/permissions");
  return c.json({
    ...user,
    ladderRank: await ladderRankOf(user),
    canInvite: await hasPermission(user, "invites.manage"),
  });
});

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
      // пустая строка — «убрал», а не населённый пункт с пустым названием
      ...(input.locality !== undefined && { locality: input.locality || null }),
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
 * учётную запись насовсем.
 *
 * Смена пароля обрывает все сеансы: и refresh-семьи, и уже выданные
 * access-токены (см. revokeAllFor). Иначе смена пароля — единственное, что
 * человек делает, заподозрив чужой доступ, — оставляла бы этому доступу ещё
 * полчаса.
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

  /*
   * Смена пароля снимает и отметку «пароль временный» (техпанель, 0088):
   * пароль, выданный администратором, заменён своим — консоль больше не
   * должна требовать смены при входе.
   */
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.newPassword), mustChangePassword: false })
    .where(eq(users.id, user.id));

  // угнанная сессия не должна переживать смену пароля
  const revoked = await revokeAllFor(user.id);

  await audit(c, {
    action: "auth.password_change",
    resourceType: "user",
    resourceId: user.id,
    subjectUserId: user.id,
    details: { revokedSessions: revoked, wasTemporary: row.mustChangePassword },
  });
  return c.json({ ok: true });
});

/**
 * Обмен refresh-токена. Повторное предъявление погашенного токена гасит всю
 * семью — этот случай пишется в журнал как подозрение на кражу.
 */
/*
 * Отказ — снаружи транзакции, по той же причине, что и у входа, и здесь она
 * дороже: повторное предъявление погашенного токена ГАСИТ ВСЮ СЕМЬЮ. Это
 * запись. Брошенное изнутри транзакции исключение откатило бы её вместе с
 * ответом — обнаружение кражи срабатывало бы и тут же отменялось само,
 * оставляя вору живую цепочку.
 */
authRoutes.post("/refresh", async (c) => {
  const outcome = await systemContext(baseDb, () => refreshHandler(c));
  if (typeof outcome === "string") unauthorized(outcome);
  return outcome;
});

async function refreshHandler(
  c: Context<AppEnv>,
): Promise<Response | "err.noRefreshToken" | "err.sessionExpired" | "err.accountDisabled"> {
  const body = await c.req.json().catch(() => ({}));
  const raw = typeof body?.refreshToken === "string" ? body.refreshToken : "";
  if (!raw) return "err.noRefreshToken";

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
    /* выключенной учётке — тот же текст, что на входе и на живом токене (см. rotateRefresh) */
    return outcome.reason === "disabled" ? "err.accountDisabled" : "err.sessionExpired";
  }
  /* обмен пары — и есть «был в системе»: раз в полчаса работы, не на каждый запрос */
  await touchLastSeen(outcome.userId);
  return c.json(outcome.pair);
}

/**
 * Выход.
 *
 * Гасит семью refresh-токенов И сдвигает границу действительности
 * access-токенов (см. revokeByToken): до этого «выйти» означало лишь, что
 * больше не продлить, — а уже выданный access-токен из localStorage ещё до
 * получаса открывал карты кому угодно, кто сядет за тот же компьютер.
 *
 * Системный контекст: маршрут открыт, аутентификации у него нет, а трогает
 * он таблицы под политиками строк.
 */
authRoutes.post("/logout", async (c) =>
  systemContext(baseDb, async () => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.refreshToken === "string") await revokeByToken(body.refreshToken);
    return c.json({ ok: true });
  }),
);


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
      /*
       * Дата рождения не упоминается вовсе: она хранилась и под кодом, и
       * трогать её раскрытие не должно. Раньше она передавалась в
       * encryptPersonFields как null, а затем возвращалась на место строкой
       * ниже — то есть тем самым «перезаписать после шифрования», из-за
       * которого дата уходила в базу открытой при регистрации.
       * encryptPersonFields пропускает ключи со значением undefined, поэтому
       * достаточно о поле не говорить.
       */
      ...encryptPersonFields({
        firstName: input.firstName,
        lastName: input.lastName,
        middleName: input.middleName ?? null,
      }),
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
  /*
   * Просроченное убирается, и размер ограничен.
   *
   * Маршрут начала входа открыт без аутентификации, а полный проход по
   * карте на каждой вставке делает расход процессора квадратичным от
   * частоты запросов. Потолок превращает поток запросов в вытеснение
   * старых записей вместо неограниченного роста.
   */
  for (const [key, value] of pending) if (Date.now() - value.at > 600_000) pending.delete(key);
  while (pending.size >= 5000) pending.delete(pending.keys().next().value as string);
  pending.set(state, { verifier, at: Date.now(), linkUserId });
  return state;
}

/**
 * Cookie, привязывающая начатый вход к этому браузеру.
 *
 * Без неё `state` доказывает только, что мы его когда-то выдавали, — а
 * выдаём мы его кому угодно: маршрут начала входа открыт. Злоумышленник мог
 * получить свой `state` и `code`, не давая им дойти до сервера, и привести
 * сотрудника по этому адресу: сервер выдал бы пару для ЕГО учётной записи,
 * а консоль молча её приняла бы. Сотрудник продолжал бы работать, будучи
 * залогинен в чужую запись, и заметки с заключениями уходили бы туда, куда
 * у злоумышленника есть доступ.
 *
 * HttpOnly и SameSite=Lax: cookie не читается скриптом и не уезжает с
 * чужого сайта, но переживает возврат от Google (переход верхнего уровня).
 */
const STATE_COOKIE = "quizzy_oauth_state";

function setStateCookie(c: Context, state: string): void {
  const secure = (env.consoleUrl ?? "").startsWith("https") ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; Path=/api/auth/google; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
    { append: true },
  );
}

function stateCookieOf(c: Context): string | null {
  const raw = c.req.header("Cookie") ?? "";
  const found = raw.split(";").map((x) => x.trim().split("="));
  return found.find(([k]) => k === STATE_COOKIE)?.[1] ?? null;
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = new Bun.CryptoHasher("sha256").update(verifier).digest();
  return Buffer.from(digest).toString("base64url");
}

function newVerifier(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/**
 * Одноразовая передача пары токенов консоли.
 *
 * Живёт тридцать секунд и обменивается ровно один раз. В памяти процесса —
 * как и состояние входа: запись нужна на один переход браузера, и хранить
 * её в базе значило бы копить там мусор ради секунд.
 */
const handoffs = new Map<string, { pair: IssuedPair; at: number }>();

function handoff(pair: IssuedPair): string {
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  for (const [key, value] of handoffs) if (Date.now() - value.at > 30_000) handoffs.delete(key);
  handoffs.set(code, { pair, at: Date.now() });
  return code;
}

/**
 * Обмен кода на пару. Только POST: код не должен уезжать в адресе второй раз.
 */
authRoutes.post("/google/exchange", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  const saved = body.code ? handoffs.get(body.code) : undefined;
  if (body.code) handoffs.delete(body.code);
  if (!saved || Date.now() - saved.at > 30_000) unauthorized("err.googleState");
  return c.json(saved.pair);
});

/** Настроен ли способ — консоль спрашивает, чтобы не рисовать кнопку в никуда */
/*
 * Что этот сервер предлагает на входе.
 *
 * Адрес остался прежним ради тех, кто уже его спрашивает, но отвечает он
 * теперь про способы входа целиком: настроен ли Google и можно ли завести
 * учётную запись самому. Экран входа обязан знать оба ответа ДО того, как
 * что-то нарисует: кнопка, ведущая в отказ, хуже отсутствующей.
 */
authRoutes.get("/google/status", (c) =>
  c.json({ enabled: googleEnabled(), openRegistration: env.openRegistration }),
);

authRoutes.get("/google/start", async (c) => {
  if (!googleEnabled()) notFound("err.googleDisabled");
  const verifier = newVerifier();
  const state = rememberState(verifier);
  setStateCookie(c, state);
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
  setStateCookie(c, state);
  return c.json({ url: authorizeUrl(state, await challengeOf(verifier)) });
});

authRoutes.post("/google/unlink", requireAuth, async (c) => {
  const user = c.get("user");
  /*
   * Требуется текущий пароль — как при его смене.
   *
   * Отвязать Google значит снять второй ключ от учётной записи (а следом
   * привязать свой). Это операция того же класса, что смена пароля, и
   * угнанного получасового токена доступа для неё быть не должно
   * достаточно.
   */
  const body = (await c.req.json().catch(() => ({}))) as { password?: string };
  const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  if (!row || !(await verifyPassword(body.password ?? "", row.passwordHash))) {
    unauthorized("err.invalidCredentials");
  }

  await db.update(users).set({ googleSub: null }).where(eq(users.id, user.id));
  await audit(c, {
    action: "auth.google_unlinked",
    resourceType: "user",
    resourceId: user.id,
    actor: user,
  });
  return c.json({ ok: true });
});

/*
 * Возврат от Google — тоже вход, и тоже до всякого контекста: кто именно
 * вернулся, выясняется здесь. Системный контекст по той же причине, что и у
 * входа паролем (см. выше).
 */
authRoutes.get("/google/callback", async (c) => {
  const outcome = await systemContext(baseDb, () => googleCallback(c));
  if (typeof outcome === "string") unauthorized(outcome);
  return outcome;
});

async function googleCallback(
  c: Context<AppEnv>,
): Promise<Response | "err.googleNotLinked" | "err.accountDisabled"> {
  if (!googleEnabled()) notFound("err.googleDisabled");

  const code = c.req.query("code");
  const state = c.req.query("state");
  const saved = state ? pending.get(state) : undefined;
  if (state) pending.delete(state);
  /*
   * Состояние должно совпасть и с выданным нами, и с тем, что лежит в
   * cookie этого браузера. Первое доказывает, что вход начинали мы; второе
   * — что начинал его ЭТОТ человек, а не тот, кто привёл его по ссылке.
   */
  if (!code || !saved || stateCookieOf(c) !== state) unauthorized("err.googleState");

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
    /*
     * Отказ возвращается, а не бросается: он идёт ПОСЛЕ записи в журнал, а
     * исключение из системной транзакции откатило бы её вместе с записью.
     * Отказы выше бросаются как были — до них ничего не записано.
     */
    return "err.googleNotLinked";
  }
  if (row.anonymous) unauthorized("err.googleAnonymous");
  /*
   * Выключенная учётка не входит и через Google: вторая дверь, открытая мимо
   * выключения, сделала бы его декоративным. Отказ — после записи в журнал,
   * поэтому возвращается, а не бросается (см. ниже про системную транзакцию).
   */
  if (row.disabledAt) {
    await audit(c, {
      action: "auth.login_failed",
      outcome: "denied",
      resourceType: "user",
      resourceId: row.id,
      actor: toPublicUser(row),
      details: { via: "google", reason: "disabled" },
    });
    return "err.accountDisabled";
  }

  await audit(c, {
    action: "auth.login",
    resourceType: "user",
    resourceId: row.id,
    actor: toPublicUser(row),
    details: { via: "google" },
  });

  await touchLastSeen(row.id);
  const pair = await issuePair(row);
  /*
   * В адресе — одноразовый код, а не сама пара токенов.
   *
   * Прежде уезжали токены: refresh живёт тридцать дней и не привязан ни к
   * устройству, ни к адресу. Адрес возврата попадает в историю браузера
   * общего компьютера в кабинете, в журнал обратного прокси и в заголовок
   * Referer первого же подзапроса — то есть кто угодно с доступом к
   * журналам получал месячный доступ к учётной записи специалиста. Чистка
   * адреса на клиенте от этого не спасает: она случается позже, чем адрес
   * отдан браузеру.
   *
   * Код живёт тридцать секунд и обменивается один раз. Даже попав в журнал,
   * он бесполезен: к моменту, когда журнал прочтут, его уже нет.
   */
  const handoffCode = handoff(pair);
  const back = new URL(`${env.consoleUrl || ""}/auth/google`, "http://localhost");
  back.searchParams.set("code", handoffCode);
  return c.redirect(env.consoleUrl ? back.toString() : `${back.pathname}${back.search}`);
}
