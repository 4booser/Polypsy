import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import {
  mfaCodeSchema,
  mfaDisableSchema,
  mfaLoginSchema,
  renderError,
  type ErrorKey,
  type MfaSetup,
  type MfaStatus,
} from "@quizzy/shared";
import { baseDb, db } from "../db";
import { asSystem, systemContext } from "../db/context";
import { users } from "../db/schema";
import { touchLastSeen } from "../lib/accounts";
import { audit } from "../lib/audit";
import { readMfaToken, toPublicUser, verifyPassword } from "../lib/auth";
import { langOf, parseBody, unauthorized } from "../lib/http";
import { currentRequestId } from "../lib/log";
import { clearFailures, isLockedOut, recordFailure } from "../lib/loginGuard";
import { issuePair } from "../lib/refresh";
import {
  beginSetup,
  checkFactor,
  confirmSetup,
  factorOf,
  readPolicy,
  recoveryLeft,
  removeFactor,
  requiredBecause,
} from "../lib/secondFactor";
import { requireAuth, type AppEnv } from "../middleware/auth";

/**
 * Второй фактор своей учётки и второй шаг входа (/api/auth/mfa).
 *
 * Решение заказчика 2026-09-26 (участок people2): TOTP для суперадминов и
 * держателей ops.read / ops.manage. Настройка — в «Обліковому записі»:
 * включить, подтвердить кодом, увидеть коды восстановления один раз,
 * выключить паролем и кодом. Вход — после пароля второй шаг «код із
 * застосунку» (POST /login здесь же): и веб, и мобильное приложение.
 *
 * Отдельным файлом, а не в routes/auth.ts: там вход и токены, здесь —
 * фактор, и у фактора своя таблица, своя политика и свой сторож. В
 * routes/auth.ts — одна развилка: верный пароль при включённом факторе
 * отвечает не парой токенов, а просьбой о коде.
 *
 * Лимит попыток — общий с паролем (lib/loginGuard.ts, пять за пятнадцать
 * минут по почте): неверный код — такая же неудача входа, как неверный
 * пароль. Иначе знающий пароль перебирал бы миллион кодов без счёта.
 */
export const mfaRoutes = new Hono<AppEnv>();

/**
 * Отказ ответом, а не исключением.
 *
 * Та же причина, что у входа (routes/auth.ts): исключение откатило бы
 * транзакцию запроса вместе с тем, что отказ обязан оставить, — отметкой в
 * счётчике попыток и строкой журнала. Перебор кодов перестал бы считаться,
 * и снаружи этого не было бы видно.
 */
function refuse(c: Context<AppEnv>, status: 400 | 401 | 403 | 409, key: ErrorKey) {
  return c.json({ error: renderError(key, langOf(c)), requestId: currentRequestId() }, status);
}

function clientIp(c: Context): string | null {
  return c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? c.req.header("X-Real-IP") ?? null;
}

/* ─────────── второй шаг входа ─────────── */

/*
 * Системный контекст — как у входа паролем: кто входит, выясняется здесь, и
 * всё, чего касается шаг (учётка, фактор, счётчик попыток, журнал, refresh),
 * лежит под политиками строк.
 */
mfaRoutes.post("/login", async (c) => {
  const outcome = await systemContext(baseDb, () => mfaLogin(c));
  if (typeof outcome === "string") unauthorized(outcome);
  return outcome;
});

async function mfaLogin(c: Context<AppEnv>): Promise<Response | ErrorKey> {
  const input = await parseBody(c.req.raw, mfaLoginSchema);
  const step = await readMfaToken(input.mfaToken);
  if (!step) return "err.mfaTokenInvalid";
  const row = await db.query.users.findFirst({ where: eq(users.id, step.sub) });
  if (!row) return "err.mfaTokenInvalid";
  const actor = toPublicUser(row);

  /* выключили между шагами — дверь закрыта и здесь, теми же словами */
  if (row.disabledAt) {
    await audit(c, {
      action: "auth.login_failed",
      outcome: "denied",
      resourceType: "user",
      resourceId: row.id,
      actor,
      details: { email: row.email, reason: "disabled", step: "mfa" },
    });
    return "err.accountDisabled";
  }

  if (await isLockedOut(row.email)) {
    await audit(c, {
      action: "auth.login_failed",
      outcome: "denied",
      resourceType: "user",
      resourceId: row.id,
      actor,
      details: { email: row.email, reason: "locked_out", step: "mfa" },
    });
    return "err.tooManyAttempts";
  }

  const check = await checkFactor(row.id, input.code);
  if (!check.ok) {
    await recordFailure(row.email, clientIp(c));
    await audit(c, {
      action: "auth.login_failed",
      outcome: "denied",
      resourceType: "user",
      resourceId: row.id,
      actor,
      // сам код в журнал не попадает — только причина
      details: { email: row.email, reason: `mfa_${check.reason}`, via: step.via },
    });
    return "err.mfaInvalidCode";
  }

  await clearFailures(row.email);
  await audit(c, {
    action: "auth.login",
    resourceType: "user",
    resourceId: row.id,
    actor,
    details: { via: step.via, mfa: check.via, ...(check.via === "recovery" ? { recoveryLeft: check.recoveryLeft } : {}) },
  });
  await touchLastSeen(row.id);
  const pair = await issuePair(row);
  return c.json({ ...pair, user: actor });
}

/* ─────────── своя учётка ─────────── */

mfaRoutes.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const row = await factorOf(user.id);
  const policy = await readPolicy();
  const body: MfaStatus = {
    enabled: Boolean(row?.confirmedAt),
    pending: Boolean(row && !row.confirmedAt),
    confirmedAt: row?.confirmedAt ?? null,
    recoveryLeft: row?.confirmedAt ? await recoveryLeft(user.id) : 0,
    required: Boolean(await asSystem(() => requiredBecause(user, policy))),
  };
  return c.json(body);
});

/**
 * Начать настройку — секрет и адрес для QR.
 *
 * Секрет уходит в ответе строкой: не у всех телефон сканирует экран, и
 * ключ переписывают руками. Ответ не кэшируется нигде по дороге — это такой
 * же секрет, как пароль.
 */
mfaRoutes.post("/setup", requireAuth, async (c) => {
  const user = c.get("user");
  const started = await beginSetup(user.id, user.email);
  if (!started.ok) return refuse(c, 409, "err.mfaAlreadyEnabled");
  await audit(c, { action: "mfa.setup", resourceType: "user", resourceId: user.id, subjectUserId: user.id });
  c.header("Cache-Control", "no-store");
  const body: MfaSetup = { secret: started.secret, otpauthUrl: started.otpauthUrl };
  return c.json(body);
});

/** Подтвердить кодом — и получить коды восстановления, единственный раз */
mfaRoutes.post("/confirm", requireAuth, async (c) => {
  const user = c.get("user");
  const { code } = await parseBody(c.req.raw, mfaCodeSchema);
  const done = await confirmSetup(user.id, code);
  if (!done.ok) {
    await audit(c, {
      action: "mfa.enable",
      outcome: "denied",
      resourceType: "user",
      resourceId: user.id,
      subjectUserId: user.id,
      details: { reason: done.reason },
    });
    return refuse(c, done.reason === "noPending" ? 409 : 400, done.reason === "noPending" ? "err.mfaNoPending" : "err.mfaInvalidCode");
  }
  await audit(c, { action: "mfa.enable", resourceType: "user", resourceId: user.id, subjectUserId: user.id });
  c.header("Cache-Control", "no-store");
  return c.json({ recoveryCodes: done.codes });
});

/**
 * Выключить — паролем и кодом.
 *
 * Оба сразу, потому что это снятие второго замка: угнанного получасового
 * токена для этого быть достаточно не должно (как для отвязки Google), а
 * одного пароля — тоже, иначе второй фактор защищал бы только вход, но не
 * себя. Неудача считается в тот же лимит попыток, что и вход.
 *
 * Если фактор обязателен по политике — выключить нельзя: сторож тут же
 * запер бы человека на экране настройки, и «выключить» значило бы «потерять
 * доступ до следующей настройки».
 */
mfaRoutes.post("/disable", requireAuth, async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, mfaDisableSchema);
  const policy = await readPolicy();
  if (await asSystem(() => requiredBecause(user, policy))) return refuse(c, 409, "err.mfaRequiredByPolicy");

  if (await asSystem(() => isLockedOut(user.email))) return refuse(c, 401, "err.tooManyAttempts");
  const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  const passwordOk = Boolean(row && (await verifyPassword(input.password, row.passwordHash)));
  const check = passwordOk ? await checkFactor(user.id, input.code) : null;
  if (!passwordOk || !check?.ok) {
    await asSystem(() => recordFailure(user.email, clientIp(c)));
    await audit(c, {
      action: "mfa.disable",
      outcome: "denied",
      resourceType: "user",
      resourceId: user.id,
      subjectUserId: user.id,
      details: { reason: passwordOk ? `mfa_${check && !check.ok ? check.reason : "invalid"}` : "wrong_password" },
    });
    return refuse(c, 401, passwordOk ? "err.mfaInvalidCode" : "err.wrongCurrentPassword");
  }
  await removeFactor(user.id);
  await audit(c, { action: "mfa.disable", resourceType: "user", resourceId: user.id, subjectUserId: user.id });
  return c.json({ ok: true });
});
