import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { MfaPolicy, Role } from "@quizzy/shared";
import { db } from "../db";
import { securityPolicy, userRecoveryCodes, userSecondFactor } from "../db/schema";
import { decryptField, encryptField } from "./crypto";
import { permissionsOf } from "./permissions";
import {
  base32Decode,
  base32Encode,
  looksLikeRecovery,
  matchStep,
  newRecoveryCodes,
  newSecret,
  otpauthUrl,
  recoveryHash,
} from "./totp";

/**
 * Второй фактор: хранение, проверка, политика «обязательно для …».
 *
 * Решение заказчика 2026-09-26: суперадмину и держателям ops.read /
 * ops.manage — второй фактор TOTP, без новых зависимостей, секрет —
 * шифрованным полем, десять одноразовых кодов восстановления, окно ±1 шаг и
 * защита от повтора кода. Требование — настройкой, с мягким переходом: пока
 * фактор не настроен, человек входит, но дальше настройки не проходит.
 *
 * Математика TOTP — в lib/totp.ts (чистая, с векторами RFC); здесь — база.
 * Лимит попыток — общий с паролем (lib/loginGuard.ts): его ставит маршрут,
 * потому что только маршрут знает почту, по которой считается порог.
 */

/* ─────────── состояние фактора ─────────── */

export async function factorOf(userId: string) {
  return db.query.userSecondFactor.findFirst({ where: eq(userSecondFactor.userId, userId) });
}

/** Включён ли фактор — то есть подтверждён кодом */
export async function factorEnabled(userId: string): Promise<boolean> {
  const row = await factorOf(userId);
  return Boolean(row?.confirmedAt);
}

export async function recoveryLeft(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
  return Number(row?.n ?? 0);
}

/* ─────────── настройка ─────────── */

/**
 * Начать настройку: новый секрет, ещё не требуемый на входе.
 *
 * Повторное начало перезаписывает прежний неподтверждённый секрет, а не
 * копит их: человек, закрывший окно с QR и открывший его снова, должен
 * получить код, который совпадёт с тем, что он отсканирует теперь. Уже
 * включённый фактор так не перезаписывается — для этого его выключают
 * паролем и кодом (иначе угнанной сессии хватило бы, чтобы пересадить
 * второй фактор на свой телефон).
 */
export async function beginSetup(
  userId: string,
  account: string,
): Promise<{ ok: true; secret: string; otpauthUrl: string } | { ok: false }> {
  const existing = await factorOf(userId);
  if (existing?.confirmedAt) return { ok: false };
  const secret = base32Encode(newSecret());
  const secretEnc = encryptField(secret)!;
  await db
    .insert(userSecondFactor)
    .values({ userId, secretEnc })
    .onConflictDoUpdate({
      target: userSecondFactor.userId,
      set: { secretEnc, confirmedAt: null, lastStep: null, createdAt: new Date().toISOString() },
    });
  return { ok: true, secret, otpauthUrl: otpauthUrl(account, secret) };
}

function secretOf(row: { secretEnc: string }): Buffer {
  return base32Decode(decryptField(row.secretEnc) ?? "");
}

/**
 * Подтвердить настройку кодом и выдать коды восстановления.
 *
 * Коды возвращаются ОДИН раз — в ответ этому вызову; в базе остаются только
 * хэши. Прежние коды (если фактор включали раньше) удаляются: листок с
 * прошлого раза не должен продолжать открывать учётку.
 */
export async function confirmSetup(
  userId: string,
  code: string,
  nowMs = Date.now(),
): Promise<{ ok: true; codes: string[] } | { ok: false; reason: "noPending" | "invalid" }> {
  const row = await factorOf(userId);
  if (!row || row.confirmedAt) return { ok: false, reason: "noPending" };
  const step = matchStep(secretOf(row), code, nowMs);
  if (step === null) return { ok: false, reason: "invalid" };

  const confirmed = await db
    .update(userSecondFactor)
    .set({ confirmedAt: new Date(nowMs).toISOString(), lastStep: step })
    .where(and(eq(userSecondFactor.userId, userId), isNull(userSecondFactor.confirmedAt)))
    .returning({ userId: userSecondFactor.userId });
  if (!confirmed.length) return { ok: false, reason: "noPending" };

  const codes = newRecoveryCodes();
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  await db
    .insert(userRecoveryCodes)
    .values(codes.map((c) => ({ id: crypto.randomUUID(), userId, codeHash: recoveryHash(userId, c) })));
  return { ok: true, codes };
}

/** Выключить: секрет и коды удаляются — повторное включение начнёт с чистого листа */
export async function removeFactor(userId: string): Promise<boolean> {
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  const gone = await db
    .delete(userSecondFactor)
    .where(eq(userSecondFactor.userId, userId))
    .returning({ userId: userSecondFactor.userId });
  return gone.length > 0;
}

/* ─────────── проверка кода ─────────── */

export type FactorCheck =
  | { ok: true; via: "totp" | "recovery"; recoveryLeft: number | null }
  | { ok: false; reason: "none" | "invalid" | "replay" };

/**
 * Проверить код из приложения или код восстановления.
 *
 * Повтор кода закрыт условием самого UPDATE: шаг принимается, только если он
 * строго больше записанного. Подсмотренный код того же шага, отправленный
 * вторым запросом в ту же минуту, упирается в «replay» — и ровно так же два
 * одновременных запроса с одним кодом: прошёл только один. Проверка чтением
 * («записанный шаг меньше?») была бы гоночной по той же причине, что и
 * погашение refresh-токена (lib/refresh.ts, claimRotation).
 *
 * Код восстановления гасится тем же приёмом: условие «ещё не использован» в
 * UPDATE. Различаются они по виду ввода (шесть цифр против «xxxx-xxxx»), а
 * не отдельным полем формы: на экране входа одно поле, и человек с
 * потерянным телефоном вводит туда то, что у него есть.
 */
export async function checkFactor(userId: string, input: string, nowMs = Date.now()): Promise<FactorCheck> {
  const row = await factorOf(userId);
  if (!row?.confirmedAt) return { ok: false, reason: "none" };

  if (looksLikeRecovery(input)) {
    const used = await db
      .update(userRecoveryCodes)
      .set({ usedAt: new Date(nowMs).toISOString() })
      .where(
        and(
          eq(userRecoveryCodes.userId, userId),
          eq(userRecoveryCodes.codeHash, recoveryHash(userId, input)),
          isNull(userRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: userRecoveryCodes.id });
    if (!used.length) return { ok: false, reason: "invalid" };
    return { ok: true, via: "recovery", recoveryLeft: await recoveryLeft(userId) };
  }

  const step = matchStep(secretOf(row), input, nowMs);
  if (step === null) return { ok: false, reason: "invalid" };
  const claimed = await db
    .update(userSecondFactor)
    .set({ lastStep: step })
    .where(
      and(
        eq(userSecondFactor.userId, userId),
        or(isNull(userSecondFactor.lastStep), lt(userSecondFactor.lastStep, step)),
      ),
    )
    .returning({ userId: userSecondFactor.userId });
  if (!claimed.length) return { ok: false, reason: "replay" };
  return { ok: true, via: "totp", recoveryLeft: null };
}

/* ─────────── политика ─────────── */

/*
 * Политика читается на КАЖДОМ запросе (сторож в middleware/auth.ts), а
 * меняется раз в год. Кэш процесса на десять секунд: без него каждый клик
 * консоли стоил бы лишнего похода в базу, а десять секунд между «включил
 * требование» и «оно действует» — ничто. Смена через маршрут сбрасывает кэш
 * сразу; на соседней реплике — через десять секунд.
 */
const POLICY_TTL_MS = 10_000;
let cached: { at: number; policy: MfaPolicy & { updatedById: string | null } } | null = null;

export function invalidatePolicy(): void {
  cached = null;
}

export async function readPolicy(): Promise<MfaPolicy & { updatedById: string | null }> {
  if (cached && Date.now() - cached.at < POLICY_TTL_MS) return cached.policy;
  /*
   * Без соединения с users: сторож читает политику вне контекста, а users под
   * политиками строк — почта автора пришла бы пустой и так и легла бы в кэш.
   * Почту автора досылает маршрут раздела, у которого контекст есть.
   */
  const [row] = await db
    .select({
      superadmins: securityPolicy.mfaSuperadmins,
      ops: securityPolicy.mfaOps,
      updatedAt: securityPolicy.updatedAt,
      updatedById: securityPolicy.updatedBy,
    })
    .from(securityPolicy)
    .where(eq(securityPolicy.id, 1));
  /* строки нет (миграция откатана руками) — политика «ничего не требовать», а не падение входа */
  const policy = row
    ? {
        superadmins: row.superadmins,
        ops: row.ops,
        updatedAt: row.updatedAt,
        updatedByEmail: null,
        updatedById: row.updatedById ?? null,
      }
    : { superadmins: false, ops: false, updatedAt: null, updatedByEmail: null, updatedById: null };
  cached = { at: Date.now(), policy };
  return policy;
}

export async function writePolicy(input: { superadmins: boolean; ops: boolean }, byId: string): Promise<void> {
  await db
    .insert(securityPolicy)
    .values({ id: 1, mfaSuperadmins: input.superadmins, mfaOps: input.ops, updatedBy: byId })
    .onConflictDoUpdate({
      target: securityPolicy.id,
      set: {
        mfaSuperadmins: input.superadmins,
        mfaOps: input.ops,
        updatedBy: byId,
        updatedAt: new Date().toISOString(),
      },
    });
  invalidatePolicy();
}

/**
 * Включено ли требование хоть для кого-то — из кэша, без транзакции.
 *
 * Сторож на каждом запросе спрашивает сначала это: когда требование
 * выключено (обычное состояние), он не открывает системной транзакции вовсе —
 * иначе каждый клик консоли стоил бы лишних BEGIN и COMMIT ради ответа
 * «ничего не требуется». Политика читается и без контекста: её строка
 * открыта на чтение всем (миграция 0094).
 */
export async function policyActive(): Promise<boolean> {
  const policy = await readPolicy();
  return policy.superadmins || policy.ops;
}

/**
 * Почему второй фактор нужен этому человеку по политике; null — не нужен.
 *
 * Суперадмин держит все права (permissionsOf обходит для него справочник),
 * значит, и ops.* — требование «для держателей ops» распространяется на него
 * тоже, даже если отдельный флаг «для суперадминов» выключен. Это не
 * побочный эффект, а смысл: суперадмин открывает техпанель по определению.
 */
export async function requiredBecause(
  user: { id: string; role: Role },
  policy: Pick<MfaPolicy, "superadmins" | "ops">,
): Promise<"superadmin" | "ops" | null> {
  if (user.role === "superadmin" && policy.superadmins) return "superadmin";
  if (!policy.ops || user.role === "user") return null;
  if (user.role === "superadmin") return "ops";
  const perms = await permissionsOf(user as never);
  return perms.has("ops.read") || perms.has("ops.manage") ? "ops" : null;
}

/**
 * Сторож мягкого перехода: требуется, а не настроен.
 *
 * Сначала — политика из кэша: когда требование выключено (обычное состояние),
 * сторож стоит ничего. Права и фактор читаются только тогда, когда вопрос
 * вообще имеет смысл.
 */
export async function setupRequired(user: { id: string; role: Role }): Promise<boolean> {
  const policy = await readPolicy();
  if (!policy.superadmins && !policy.ops) return false;
  if (!(await requiredBecause(user, policy))) return false;
  return !(await factorEnabled(user.id));
}

/**
 * Куда пускать, пока второй фактор обязателен и не настроен.
 *
 * Ровно то, без чего настроить его нельзя: сама настройка, «кто я» (консоль
 * по нему и понимает, что надо открыть настройку), смена временного пароля
 * (она может совпасть по времени) и тема рабочего места. Всё прочее — отказ
 * err.mfaSetupRequired, одинаковый в вебе и мобилке. Выход сторож не
 * задевает: он без токена (routes/auth.ts).
 */
export function allowedDuringSetup(method: string, path: string): boolean {
  if (path === "/api/auth/mfa" || path.startsWith("/api/auth/mfa/")) return true;
  if (method === "GET" && path === "/api/auth/me") return true;
  if (method === "POST" && path === "/api/auth/password") return true;
  if (method === "PUT" && path === "/api/auth/me/workspace") return true;
  return false;
}
