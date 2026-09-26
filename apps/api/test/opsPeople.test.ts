import { afterAll, describe, expect, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLog,
  impersonationSessions,
  loginAttempts,
  permissionExceptions,
  staffRoles,
  surveyAccess,
  suspiciousFindings,
  userRecoveryCodes,
  userSecondFactor,
  users as usersTable,
} from "../src/db/schema";
import { invalidatePolicy, writePolicy } from "../src/lib/secondFactor";
import {
  base32Decode,
  base32Encode,
  hotp,
  looksLikeRecovery,
  matchStep,
  newRecoveryCodes,
  stepAt,
  totp,
} from "../src/lib/totp";
import {
  DEFAULT_CONFIG,
  clientFamily,
  failedLoginsByAccount,
  failedLoginsByIp,
  impersonations,
  isNight,
  massReads,
  namedExports,
  newClients,
  nightActivity,
  workingDayOf,
  type JournalEntry,
} from "../src/lib/suspicious";
import { aboutPatient, bulkSkip, groupWhoViewed, parseCsv, validateImport, type BulkActor } from "../src/lib/people";
import { adminA, adminB, api, app, db, json, makeUser, patient, root, surveyInA, type Person } from "./fixtures";

/**
 * Техпанель → «Люди й безпека» (волна 10, участок people2).
 *
 * Главное здесь — обещания, нарушение которых видно только в бою:
 *
 *  1. Вход «от имени» ничего не пишет, не открывает техпанель, живёт
 *     полчаса, и каждое действие под ним — в журнале с обоими людьми, а
 *     цепочка журнала при этом цела.
 *  2. Второй фактор нельзя обойти: знак «пароль верный» — не пропуск, код
 *     не входит дважды, коды восстановления одноразовые, перебор считается.
 *  3. Правила одиночных действий действуют на каждой строке пачки.
 *  4. Импорт — всё или ничего.
 *  5. Отчёт «хто переглядав» собирает про этого пациента и не собирает про
 *     чужого.
 */

const PASSWORD = "secret12345";

async function login(email: string, password = PASSWORD) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await json(res) };
}

async function mfaLogin(mfaToken: string, code: string) {
  const res = await app.request("/api/auth/mfa/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mfaToken, code }),
  });
  return { status: res.status, body: await json(res) };
}

const post = (body: unknown = {}) => ({ method: "POST", body: JSON.stringify(body) });

/** Сотрудник с личным исключением — как такие права и выдают */
async function staffWith(tag: string, ...permissions: string[]): Promise<Person & { email: string }> {
  const email = `pp-${tag}-${crypto.randomUUID()}@test.dev`;
  const person = await makeUser("admin", email);
  for (const permission of permissions) {
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: person.id,
      permission,
      mode: "grant",
      reason: "Проверка участка people2",
      grantedBy: root.id,
    });
  }
  return { ...person, email };
}

/** Включить второй фактор учётке через маршруты — как это делает человек */
async function enableFactor(person: Person): Promise<{ secret: Buffer; codes: string[] }> {
  const setup = await api("/api/auth/mfa/setup", person.token, { method: "POST" });
  expect(setup.status).toBe(200);
  expect(setup.body.otpauthUrl).toStartWith("otpauth://totp/");
  const secret = base32Decode(setup.body.secret);
  const confirm = await api("/api/auth/mfa/confirm", person.token, post({ code: totp(secret, Date.now()) }));
  expect(confirm.status).toBe(200);
  return { secret, codes: confirm.body.recoveryCodes as string[] };
}

/*
 * Политика второго фактора — общее состояние процесса (кэш) и базы. Сюита
 * гоняется одним процессом на все файлы: оставленное включённым требование
 * заперло бы в настройке каждого суперадмина следующих тестов. Поэтому
 * сброс — и в конце каждого теста, что его трогает, и здесь на всякий случай.
 */
afterAll(async () => {
  await writePolicy({ superadmins: false, ops: false }, root.id);
  invalidatePolicy();
});

/* ═══════════ TOTP ═══════════ */

describe("TOTP по RFC 6238", () => {
  /*
   * Векторы приложения B RFC 6238 для SHA-1: ключ — ASCII «12345678901234567890»,
   * восемь цифр. Шесть цифр, которые показывает приложение, — хвост тех же
   * восьми (усечение по модулю 10^digits).
   */
  const SEED = Buffer.from("12345678901234567890", "ascii");
  const VECTORS: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  test("векторы приложения B сходятся цифра в цифру", () => {
    for (const [t, expected] of VECTORS) {
      expect(totp(SEED, t * 1000, 8)).toBe(expected);
      expect(totp(SEED, t * 1000)).toBe(expected.slice(-6));
    }
  });

  test("base32 — туда и обратно, и в том виде, в каком ключ вписывают руками", () => {
    expect(base32Encode(SEED)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv gy3t qojq-gezd gnbv gy3t qojq").equals(SEED)).toBe(true);
    expect(() => base32Decode("GEZD1")).toThrow();
  });

  test("окно ±1 шаг: соседние коды проходят, через шаг — нет", () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    expect(matchStep(SEED, hotp(SEED, s), now)).toBe(s);
    expect(matchStep(SEED, hotp(SEED, s - 1), now)).toBe(s - 1);
    expect(matchStep(SEED, hotp(SEED, s + 1), now)).toBe(s + 1);
    expect(matchStep(SEED, hotp(SEED, s - 2), now)).toBeNull();
    expect(matchStep(SEED, hotp(SEED, s + 2), now)).toBeNull();
    // код, набранный с пробелом, — те же шесть цифр
    const code = hotp(SEED, s);
    expect(matchStep(SEED, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(s);
  });

  test("коды восстановления: десять разных, вида xxxx-xxxx, и отличимы от кода приложения", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
      expect(looksLikeRecovery(c)).toBe(true);
    }
    expect(looksLikeRecovery("123456")).toBe(false);
  });
});

/* ═══════════ второй фактор: вход и настройка ═══════════ */

describe("второй фактор", () => {
  test("после пароля — второй шаг; знак «пароль верный» не пропуск; код не входит дважды", async () => {
    const person = await staffWith("mfa-flow");
    const { secret } = await enableFactor(person);

    const first = await login(person.email);
    expect(first.status).toBe(200);
    expect(first.body.mfaRequired).toBe(true);
    expect(first.body.token).toBeUndefined();
    expect(first.body.refreshToken).toBeUndefined();

    // знак подписан другим ключом: как access-токен он не принимается
    expect((await api("/api/auth/me", first.body.mfaToken)).status).toBe(401);

    expect((await mfaLogin(first.body.mfaToken, "000000")).status).toBe(401);

    // шаг после того, что приняла настройка, — иначе это был бы повтор
    const step = stepAt(Date.now()) + 1;
    const code = hotp(secret, step);
    const ok = await mfaLogin(first.body.mfaToken, code);
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.refreshToken).toBeTruthy();
    expect(ok.body.user.id).toBe(person.id);

    // тот же код ещё раз — отказ: подсмотренный код в ту же минуту не входит
    const again = await login(person.email);
    expect((await mfaLogin(again.body.mfaToken, code)).status).toBe(401);

    const [replay] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "auth.login_failed"), eq(auditLog.actorId, person.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect((replay!.details as { reason: string }).reason).toBe("mfa_replay");
  });

  test("код восстановления входит один раз", async () => {
    const person = await staffWith("mfa-recovery");
    const { codes } = await enableFactor(person);

    const one = await login(person.email);
    const used = await mfaLogin(one.body.mfaToken, codes[0]!.toUpperCase());
    expect(used.status).toBe(200);

    const two = await login(person.email);
    expect((await mfaLogin(two.body.mfaToken, codes[0]!)).status).toBe(401);
    // остальные девять целы
    expect((await mfaLogin(two.body.mfaToken, codes[1]!)).status).toBe(200);

    const status = await api("/api/auth/mfa", person.token);
    expect(status.body.enabled).toBe(true);
    expect(status.body.recoveryLeft).toBe(8);

    // в базе — хэши, не коды
    const stored = await db.select().from(userRecoveryCodes).where(eq(userRecoveryCodes.userId, person.id));
    expect(stored).toHaveLength(10);
    expect(stored.some((r) => codes.includes(r.codeHash))).toBe(false);
    const [factor] = await db.select().from(userSecondFactor).where(eq(userSecondFactor.userId, person.id));
    expect(factor!.secretEnc).toStartWith("enc1:");
  });

  test("лимит попыток — общий с паролем: пять неверных кодов, и верный уже не входит", async () => {
    const person = await staffWith("mfa-lock");
    const { secret } = await enableFactor(person);
    const start = await login(person.email);
    for (let i = 0; i < 5; i++) expect((await mfaLogin(start.body.mfaToken, "111111")).status).toBe(401);

    const locked = await mfaLogin(start.body.mfaToken, hotp(secret, stepAt(Date.now()) + 1));
    expect(locked.status).toBe(401);
    // и верный пароль не сбрасывает счётчик, пока не введён код
    expect((await login(person.email)).status).toBe(401);
    await db.delete(loginAttempts).where(eq(loginAttempts.email, person.email));
  });

  test("выключить — паролем и кодом; неверный пароль — отказ", async () => {
    const person = await staffWith("mfa-off");
    const { secret } = await enableFactor(person);
    const wrong = await api("/api/auth/mfa/disable", person.token, post({ password: "nope-nope", code: totp(secret, Date.now()) }));
    expect(wrong.status).toBe(401);
    const off = await api(
      "/api/auth/mfa/disable",
      person.token,
      post({ password: PASSWORD, code: hotp(secret, stepAt(Date.now()) + 1) }),
    );
    expect(off.status).toBe(200);
    expect((await api("/api/auth/mfa", person.token)).body.enabled).toBe(false);
    // без фактора вход снова одним шагом
    expect((await login(person.email)).body.token).toBeTruthy();
    await db.delete(loginAttempts).where(eq(loginAttempts.email, person.email));
  });

  test("требование для держателей ops.*: мягкий переход — вход есть, дальше настройки нет", async () => {
    const ops = await staffWith("mfa-policy", "ops.read", "ops.manage");
    const plain = await staffWith("mfa-plain");
    try {
      const put = await api("/api/ops/people/mfa", ops.token, { method: "PUT", body: JSON.stringify({ superadmins: false, ops: true }) });
      expect(put.status).toBe(200);

      // держатель ops без фактора: «кто я» и настройка — да, остальное — нет
      const me = await api("/api/auth/me", ops.token);
      expect(me.status).toBe(200);
      expect(me.body.mfaSetupRequired).toBe(true);
      const blocked = await api("/api/ops/overview", ops.token);
      expect(blocked.status).toBe(403);
      expect(String(blocked.body.error)).toContain("фактор");
      expect((await api("/api/auth/mfa", ops.token)).body.required).toBe(true);

      // сотрудник без ops.* требования не замечает
      expect((await api("/api/auth/me", plain.token)).body.mfaSetupRequired).toBeUndefined();

      // настроил — и дальше проходит тем же токеном
      await enableFactor(ops);
      expect((await api("/api/ops/overview", ops.token)).status).toBe(200);

      // обязательный фактор не выключить
      const off = await api("/api/auth/mfa/disable", ops.token, post({ password: PASSWORD, code: "123456" }));
      expect(off.status).toBe(409);

      const [row] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "security.policy_update"), eq(auditLog.actorId, ops.id)))
        .limit(1);
      expect((row!.details as { mfaOps: boolean }).mfaOps).toBe(true);
    } finally {
      await writePolicy({ superadmins: false, ops: false }, root.id);
    }
  });

  test("сброс чужого фактора — только суперадмину, не себе, в журнал", async () => {
    const person = await staffWith("mfa-reset");
    await enableFactor(person);
    const mgr = await staffWith("mfa-reset-mgr", "users.manage");

    expect((await api(`/api/ops/people/users/${person.id}/mfa-reset`, mgr.token, { method: "POST" })).status).toBe(403);
    expect((await api(`/api/ops/people/users/${root.id}/mfa-reset`, root.token, { method: "POST" })).status).toBe(403);

    const reset = await api(`/api/ops/people/users/${person.id}/mfa-reset`, root.token, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(reset.body.hadFactor).toBe(true);
    expect((await api("/api/auth/mfa", person.token)).body.enabled).toBe(false);
    expect((await login(person.email)).body.token).toBeTruthy();

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "mfa.reset"), eq(auditLog.subjectUserId, person.id)));
    expect(entry?.actorId).toBe(root.id);
  });
});

/* ═══════════ вход «от имени» ═══════════ */

describe("вход «от имени»", () => {
  const reason = "Жалоба: не видит пациента в своём списке";

  test("только суперадмину; не под суперадмином и не под собой; причина обязательна", async () => {
    const mgr = await staffWith("imp-mgr", "users.manage", "ops.read", "ops.manage", "audit.read");
    expect((await api(`/api/ops/people/impersonate/${adminA.id}`, mgr.token, post({ reason }))).status).toBe(403);

    const other = await makeUser("superadmin", `pp-imp-super-${crypto.randomUUID()}@test.dev`);
    const underSuper = await api(`/api/ops/people/impersonate/${other.id}`, root.token, post({ reason }));
    expect(underSuper.status).toBe(403);
    expect((await api(`/api/ops/people/impersonate/${root.id}`, root.token, post({ reason }))).status).toBe(403);
    expect((await api(`/api/ops/people/impersonate/${adminA.id}`, root.token, post({ reason: "надо" }))).status).toBe(400);

    const [denied] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "impersonation.start"), eq(auditLog.subjectUserId, other.id)));
    expect(denied?.outcome).toBe("denied");
  });

  test("смотрит его глазами, ничего не пишет, техпанель закрыта, каждое действие — с обоими людьми", async () => {
    const person = await makeUser("user", `pp-imp-pat-${crypto.randomUUID()}@test.dev`);
    await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });

    const start = await api(`/api/ops/people/impersonate/${adminA.id}`, root.token, post({ reason }));
    expect(start.status).toBe(201);
    expect(start.body.refreshToken).toBeUndefined();
    const token = start.body.token as string;

    // короткий срок — в самом токене
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(30 * 60);
    expect(claims.act.sub).toBe(root.id);
    expect(claims.sub).toBe(adminA.id);

    const me = await api("/api/auth/me", token);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(adminA.id);
    expect(me.body.impersonation.actorId).toBe(root.id);
    expect(me.body.impersonation.reason).toBe(reason);

    // видит то, что видит он: карточка пациента его зоны открывается
    expect((await api(`/api/patients/${person.id}/card`, token)).status).toBe(200);

    // любая запись — 403 с понятной ошибкой
    const write = await api("/api/patient-groups", token, post({ title: "Не мой список" }));
    expect(write.status).toBe(403);
    expect(String(write.body.error)).toContain("від імені");
    expect((await api("/api/auth/me", token, { method: "PATCH", body: JSON.stringify({ unit: "x" }) })).status).toBe(403);

    // техпанель и журнал — нет, хотя у него самого users.manage мог бы быть
    expect((await api("/api/ops/users", token)).status).toBe(403);
    expect((await api("/api/ops/people/suspicious", token)).status).toBe(403);
    expect((await api("/api/audit", token)).status).toBe(403);
    // и выдать себе новый токен нечем: выдача — запись
    expect((await api(`/api/ops/people/impersonate/${adminB.id}`, token, post({ reason }))).status).toBe(403);

    // в журнале: действующее лицо — суперадмин, «от имени» — плоскими полями
    const [card] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "patient.card_read"), eq(auditLog.subjectUserId, person.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(card!.actorId).toBe(root.id);
    expect((card!.details as { asUserId: string }).asUserId).toBe(adminA.id);
    const views = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "impersonation.view"), sql`${auditLog.details}->>'impersonation' = ${start.body.sessionId}`));
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((v) => v.actorId === root.id && v.subjectUserId === adminA.id)).toBe(true);

    // цепочка журнала цела — новые поля её не ломают
    const verify = await api("/api/audit/verify", root.token);
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);

    // «вийти» гасит сразу — своим токеном
    const end = await api(`/api/ops/people/impersonate/${start.body.sessionId}/end`, root.token, { method: "POST" });
    expect(end.body.ended).toBe(true);
    expect((await api("/api/auth/me", token)).status).toBe(401);
  });

  test("истёкшая сессия и выход самого суперадмина гасят токен «от имени»", async () => {
    const start = await api(`/api/ops/people/impersonate/${adminB.id}`, root.token, post({ reason }));
    expect(start.status).toBe(201);
    await db
      .update(impersonationSessions)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(impersonationSessions.id, start.body.sessionId));
    expect((await api("/api/auth/me", start.body.token)).status).toBe(401);

    const boss = await makeUser("superadmin", `pp-imp-boss-${crypto.randomUUID()}@test.dev`);
    const second = await api(`/api/ops/people/impersonate/${adminB.id}`, boss.token, post({ reason }));
    expect((await api("/api/auth/me", second.body.token)).status).toBe(200);
    // суперадмин вышел отовсюду — граница его токенов сдвинулась
    await db.update(usersTable).set({ tokensValidFrom: new Date(Date.now() + 1000).toISOString() }).where(eq(usersTable.id, boss.id));
    expect((await api("/api/auth/me", second.body.token)).status).toBe(401);
  });
});

/* ═══════════ подозрительная активность: правила ═══════════ */

let seq = 0;
function entry(partial: Partial<JournalEntry> & Pick<JournalEntry, "action" | "at">): JournalEntry {
  seq++;
  return {
    id: `e-${String(seq).padStart(6, "0")}`,
    actorId: null,
    actorEmail: null,
    actorRole: null,
    resourceType: null,
    resourceId: null,
    subjectUserId: null,
    outcome: "success",
    ip: null,
    userAgent: null,
    details: null,
    ...partial,
  };
}
const at = (base: string, minutes: number) => new Date(new Date(base).getTime() + minutes * 60_000).toISOString();
const DAY = "2026-09-24T09:00:00.000Z"; // 12:00 по Киеву
const NIGHT = "2026-09-24T23:00:00.000Z"; // 02:00 по Киеву

describe("правила подозрительной активности — на подставном журнале", () => {
  test("неудачные входы по учётке: пять за четверть часа — одна серия; четыре — ничего", () => {
    const fail = (m: number, email = "x@test") =>
      entry({ action: "auth.login_failed", outcome: "denied", at: at(DAY, m), details: { email, reason: "wrong_password" } });
    expect(failedLoginsByAccount([0, 2, 4, 6].map((m) => fail(m)))).toHaveLength(0);
    const five = [0, 2, 4, 6, 8].map((m) => fail(m));
    const found = failedLoginsByAccount(five);
    expect(found).toHaveLength(1);
    expect(found[0]!.hits).toBe(5);
    // вторая серия через час — отдельное срабатывание, серия внутри — одно, а не шесть окон
    const two = failedLoginsByAccount([...five, ...[70, 71, 72, 73, 74, 75].map((m) => fail(m))]);
    expect(two).toHaveLength(2);
    expect(two[1]!.hits).toBe(6);
  });

  test("по адресу — нужны и число, и разные учётки: смена за одним NAT не атака", () => {
    const fail = (m: number, email: string) =>
      entry({ action: "auth.login_failed", outcome: "denied", at: at(DAY, m), ip: "10.0.0.1", details: { email } });
    const twoAccounts = Array.from({ length: 10 }, (_, i) => fail(i, i % 2 ? "a@test" : "b@test"));
    expect(failedLoginsByIp(twoAccounts)).toHaveLength(0);
    const spray = Array.from({ length: 10 }, (_, i) => fail(i, `u${i % 3}@test`));
    const found = failedLoginsByIp(spray);
    expect(found).toHaveLength(1);
    expect(found[0]!.details.accounts).toBe(3);
  });

  test("новый клиент: другое семейство браузера и системы — да, обновление браузера — нет, первый вход — нет", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
    const macNew = mac.replace("Chrome/128.0", "Chrome/129.0");
    const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
    expect(clientFamily(mac)).toBe("Chrome · macOS");
    expect(clientFamily(win)).toBe("Firefox · Windows");
    const loginAs = (m: number, ua: string, actorId = "u1") =>
      entry({ action: "auth.login", at: at(DAY, m), actorId, actorEmail: `${actorId}@test`, userAgent: ua });
    const old = loginAs(-10_000, mac);
    expect(newClients([loginAs(0, macNew)], [old])).toHaveLength(0);
    const fresh = loginAs(0, win);
    const found = newClients([fresh], [old, fresh]);
    expect(found).toHaveLength(1);
    expect(found[0]!.details.client).toBe("Firefox · Windows");
    expect(newClients([loginAs(0, win, "u2")], [])).toHaveLength(0);
  });

  test("массовые чтения: 25 разных пациентов за 15 минут — да; 24 — нет; 25 раз одного — нет", () => {
    const read = (m: number, subject: string) =>
      entry({ action: "patient.card_read", at: at(DAY, m / 2), actorId: "doc", actorRole: "admin", subjectUserId: subject });
    expect(massReads(Array.from({ length: 24 }, (_, i) => read(i, `p${i}`)))).toHaveLength(0);
    const found = massReads(Array.from({ length: 25 }, (_, i) => read(i, `p${i}`)));
    expect(found).toHaveLength(1);
    expect(found[0]!.hits).toBe(25);
    expect(massReads(Array.from({ length: 25 }, (_, i) => read(i, "same")))).toHaveLength(0);
  });

  test("ночь: три чтения вне рабочих часов — да; два — нет; днём — нет; свои данные — не в счёт", () => {
    const read = (base: string, m: number, actorId = "doc", role = "admin", subject = "p1") =>
      entry({ action: "response.read", at: at(base, m), actorId, actorRole: role, subjectUserId: subject });
    expect(isNight(NIGHT, DEFAULT_CONFIG)).toBe(true);
    expect(isNight(DAY, DEFAULT_CONFIG)).toBe(false);
    expect(nightActivity([0, 5].map((m) => read(NIGHT, m)))).toHaveLength(0);
    const found = nightActivity([0, 5, 10].map((m) => read(NIGHT, m)));
    expect(found).toHaveLength(1);
    // 02:00 четверга по Киеву — это ночь среды
    expect(found[0]!.details.night).toBe("2026-09-24");
    expect(nightActivity([0, 5, 10].map((m) => read(DAY, m)))).toHaveLength(0);
    expect(nightActivity([0, 5, 10].map((m) => read(NIGHT, m, "p1", "user", "p1")))).toHaveLength(0);
  });

  test("рабочие часы — из расписаний с часом запаса; нет расписаний — константа", () => {
    expect(workingDayOf("08:00", "18:30")).toEqual({ day: { from: "07:00", to: "19:30" }, source: "schedule" });
    expect(workingDayOf(null, null).source).toBe("default");
  });

  test("выгрузка с именами и вход «от имени» — каждое событие отдельно", () => {
    const named = entry({ action: "analytics.export", at: DAY, actorId: "a", details: { includesUserIds: true, subjects: 12 } });
    const anon = entry({ action: "analytics.export", at: DAY, actorId: "a", details: { includesUserIds: false, profile: "deidentified" } });
    expect(namedExports([named, anon]).map((f) => f.fingerprint)).toEqual([`namedExport:${named.id}`]);
    const imp = entry({ action: "impersonation.start", at: DAY, actorId: "root", subjectUserId: "doc", details: { reason: "жалоба" } });
    expect(impersonations([imp])[0]!.subjectId).toBe("doc");
  });
});

describe("подозрительная активность: проверка по журналу и разбор", () => {
  test("серия неудачных входов находится проверкой, одна строка на серию; «розібрано» — с комментарием и в журнал", async () => {
    const email = `pp-brute-${crypto.randomUUID()}@test.dev`;
    for (let i = 0; i < 5; i++) await login(email, "wrong-password");
    const mgr = await staffWith("susp-no-audit", "users.manage");
    expect((await api("/api/ops/people/suspicious", mgr.token)).status).toBe(403);

    const scan = await api("/api/ops/people/suspicious/scan", root.token, { method: "POST" });
    expect(scan.status).toBe(200);
    // повторный проход по тем же суткам не дублирует
    await api("/api/ops/people/suspicious/scan", root.token, { method: "POST" });
    const mine = await db
      .select()
      .from(suspiciousFindings)
      .where(and(eq(suspiciousFindings.rule, "failedLoginsAccount"), eq(suspiciousFindings.actorEmail, email)));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.hits).toBeGreaterThanOrEqual(5);
    // признак «новое» для оповещений
    expect(mine[0]!.notifiedAt).toBeNull();

    const list = await api("/api/ops/people/suspicious?status=open", root.token);
    expect(list.body.items.some((f: { id: string }) => f.id === mine[0]!.id)).toBe(true);
    expect(list.body.thresholds.failedPerAccount).toBe(5);

    expect((await api(`/api/ops/people/suspicious/${mine[0]!.id}/resolve`, root.token, post({ comment: "" }))).status).toBe(400);
    const done = await api(`/api/ops/people/suspicious/${mine[0]!.id}/resolve`, root.token, post({ comment: "Забыл пароль, звонил" }));
    expect(done.status).toBe(200);
    expect((await api(`/api/ops/people/suspicious/${mine[0]!.id}/resolve`, root.token, post({ comment: "ещё раз" }))).status).toBe(409);
    const [entryRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "suspicious.resolve"), eq(auditLog.resourceId, mine[0]!.id)));
    expect(entryRow?.actorId).toBe(root.id);
    await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
  });

  test("вход «от имени» попадает в список срабатываний", async () => {
    const start = await api(`/api/ops/people/impersonate/${adminB.id}`, root.token, post({ reason: "Проверка правила подозрительного" }));
    await api("/api/ops/people/suspicious/scan", root.token, { method: "POST" });
    const rows = await db.select().from(suspiciousFindings).where(eq(suspiciousFindings.rule, "impersonation"));
    expect(rows.some((r) => (r.details as { session?: string }).session === start.body.sessionId)).toBe(true);
  });
});

/* ═══════════ временные доступы ═══════════ */

describe("временные доступы", () => {
  test("действующие со сроком и истёкшие за 30 дней; продлевает только суперадмин; отозванное — нет", async () => {
    const person = await makeUser("admin", `pp-grant-${crypto.randomUUID()}@test.dev`);
    const soon = await api(`/api/permissions/users/${person.id}/exceptions`, root.token, {
      method: "POST",
      body: JSON.stringify({ permission: "conclusions.sign", mode: "grant", reason: "Замещает наставника в отпуске", days: 3 }),
    });
    const pastId = crypto.randomUUID();
    await db.insert(permissionExceptions).values({
      id: pastId,
      userId: person.id,
      permission: "ops.read",
      mode: "grant",
      reason: "Разбор сбоя на прошлой неделе",
      grantedBy: root.id,
      expiresAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });

    const mgr = await staffWith("grants-mgr", "users.manage");
    const view = await api("/api/ops/people/grants", mgr.token);
    expect(view.status).toBe(200);
    expect(view.body.active.some((g: { id: string }) => g.id === soon.body.id)).toBe(true);
    expect(view.body.expired.some((g: { id: string }) => g.id === pastId)).toBe(true);

    expect((await api(`/api/ops/people/grants/${soon.body.id}/extend`, mgr.token, post({ days: 7 }))).status).toBe(403);
    const ext = await api(`/api/ops/people/grants/${pastId}/extend`, root.token, post({ days: 7 }));
    expect(ext.status).toBe(200);
    // истёкший продлевается от сегодня, а не от старого срока
    expect(new Date(ext.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const card = await api(`/api/permissions/users/${person.id}`, root.token);
    expect(card.body.effective).toContain("ops.read");

    await api(`/api/permissions/exceptions/${soon.body.id}/revoke`, root.token, { method: "POST" });
    expect((await api(`/api/ops/people/grants/${soon.body.id}/extend`, root.token, post({ days: 7 }))).status).toBe(400);

    const [entryRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "permission.exception_extend"), eq(auditLog.subjectUserId, person.id)));
    expect((entryRow!.details as { days: number }).days).toBe(7);
  });
});

/* ═══════════ массовые действия ═══════════ */

describe("массовые действия", () => {
  const actor = (role: BulkActor["role"], rank: number, perms: string[] = []): BulkActor => ({
    id: "me",
    role,
    rank,
    perms: new Set(perms) as never,
  });

  test("правила одиночных — на каждой строке (чистая функция)", () => {
    const admin = actor("admin", 3, ["patients.read"]);
    const t = (id: string, role: "admin" | "user" | "superadmin", disabledAt: string | null = null, roleCodes: string[] = []) => ({
      id,
      role,
      disabledAt,
      roleCodes,
    });
    expect(bulkSkip("disable", admin, t("me", "admin"))).toBe("self");
    expect(bulkSkip("disable", admin, t("s", "superadmin"))).toBe("superadminOnly");
    expect(bulkSkip("disable", admin, t("x", "admin", "2026-01-01"))).toBe("alreadyDisabled");
    expect(bulkSkip("enable", admin, t("x", "admin"))).toBe("notDisabled");
    expect(bulkSkip("disable", admin, null)).toBe("notFound");
    const specialist = { id: "r", code: "specialist", permissions: ["patients.read"] };
    const head = { id: "h", code: "head", permissions: ["patients.read"] };
    expect(bulkSkip("assign-role", admin, t("p", "user"), specialist)).toBe("patient");
    expect(bulkSkip("assign-role", admin, t("x", "admin", null, ["specialist"]), specialist)).toBe("alreadyHasRole");
    expect(bulkSkip("assign-role", actor("admin", 2, ["patients.read"]), t("x", "admin"), head)).toBe("roleAboveYours");
    expect(bulkSkip("assign-role", admin, t("x", "admin"), { ...specialist, permissions: ["users.manage"] })).toBe("roleGrantsMore");
    expect(bulkSkip("assign-role", admin, t("x", "admin"), { id: "b", code: "psychologist", permissions: [] })).toBe("roleNotInChain");
    expect(bulkSkip("assign-role", admin, t("x", "admin"), specialist)).toBeNull();
  });

  test("выключить пачкой: себя, суперадмина и уже выключенного — пропустить с причиной, остальных — сделать", async () => {
    const mgr = await staffWith("bulk-mgr", "users.manage");
    const a = await makeUser("admin", `pp-bulk-a-${crypto.randomUUID()}@test.dev`);
    const b = await makeUser("user", `pp-bulk-b-${crypto.randomUUID()}@test.dev`);
    const off = await makeUser("user", `pp-bulk-off-${crypto.randomUUID()}@test.dev`, { disabledAt: new Date().toISOString() });

    const res = await api(
      "/api/ops/people/users/bulk",
      mgr.token,
      post({ action: "disable", reason: "Уволены приказом", ids: [a.id, b.id, mgr.id, root.id, off.id, crypto.randomUUID()] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.done.map((d: { id: string }) => d.id).sort()).toEqual([a.id, b.id].sort());
    const reasons = Object.fromEntries(res.body.skipped.map((s: { id: string; reason: string }) => [s.id, s.reason]));
    expect(reasons[mgr.id]).toBe("self");
    expect(reasons[root.id]).toBe("superadminOnly");
    expect(reasons[off.id]).toBe("alreadyDisabled");
    expect(Object.values(reasons)).toContain("notFound");

    // выключение действует сразу, как одиночное
    expect((await api("/api/auth/me", a.token)).status).toBe(401);
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.action, "user.disable"), eq(auditLog.subjectUserId, a.id)));
    expect((row!.details as { bulk: string }).bulk).toBeTruthy();
    const [summary] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.bulk"), sql`${auditLog.details}->>'bulk' = ${(row!.details as { bulk: string }).bulk}`));
    expect((summary!.details as { done: number; skipped: number }).done).toBe(2);

    const back = await api("/api/ops/people/users/bulk", mgr.token, post({ action: "enable", ids: [a.id, b.id] }));
    expect(back.body.done).toHaveLength(2);
  });

  test("назначить роль-шаблон пачкой: пациенту и себе — нет; не назначающему — отказ", async () => {
    const x = await makeUser("admin", `pp-bulk-role-${crypto.randomUUID()}@test.dev`);
    const res = await api(
      "/api/ops/people/users/bulk",
      root.token,
      post({ action: "assign-role", roleId: "role-specialist", ids: [x.id, patient.id, root.id] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.done.map((d: { id: string }) => d.id)).toEqual([x.id]);
    expect(res.body.skipped.map((s: { reason: string }) => s.reason).sort()).toEqual(["patient", "self"]);
    const roles = await db.select().from(staffRoles).where(and(eq(staffRoles.userId, x.id), eq(staffRoles.roleId, "role-specialist")));
    expect(roles).toHaveLength(1);

    const mgr = await staffWith("bulk-role-mgr", "users.manage");
    const denied = await api("/api/ops/people/users/bulk", mgr.token, post({ action: "assign-role", roleId: "role-specialist", ids: [x.id] }));
    expect(denied.status).toBe(403);
  });

  test("«вибрати всіх у відборі» — ровно то, что показывает список", async () => {
    const mark = crypto.randomUUID().slice(0, 8);
    for (let i = 0; i < 3; i++) await makeUser("user", `pp-sel-${mark}-${i}@test.dev`);
    const list = await api(`/api/ops/users?q=pp-sel-${mark}&per=100`, root.token);
    const ids = await api(`/api/ops/people/users/ids?q=pp-sel-${mark}`, root.token);
    expect(ids.body.total).toBe(3);
    expect(ids.body.ids.sort()).toEqual(list.body.items.map((u: { id: string }) => u.id).sort());
  });
});

/* ═══════════ импорт ═══════════ */

describe("импорт сотрудников из CSV", () => {
  test("разбор: кавычки, точка с запятой, заголовки по-украински", () => {
    const rows = parseCsv('Прізвище;Ім’я;Пошта\n"Коваль; старший";Іван;ivan@test.dev\n\n');
    expect(rows).toEqual([
      ["Прізвище", "Ім’я", "Пошта"],
      ["Коваль; старший", "Іван", "ivan@test.dev"],
    ]);
    const { rows: checked, missingColumns } = validateImport(rows.map((r) => r.join(";")).join("\n").replace("Коваль; старший", "Коваль"), {
      takenEmails: new Set(),
      templates: new Map(),
      actorIsSuper: false,
    });
    expect(missingColumns).toEqual([]);
    expect(checked[0]!.errors).toEqual([]);
  });

  test("ошибки по строкам: почта занята, дубль, роль неизвестна, пусто в обязательном; нікого не створено", async () => {
    const good = `pp-imp-good-${crypto.randomUUID()}@test.dev`;
    const dup = `pp-imp-dup-${crypto.randomUUID()}@test.dev`;
    const taken = `pp-imp-taken-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", taken);
    const csv = [
      "last_name,first_name,middle_name,email,role,role_template,position,unit",
      `Коваленко,Олена,,${good},,,психолог,1 відділення`,
      `Бондар,Петро,,${taken.toUpperCase()},,,,`,
      `Шевчук,Анна,,${dup},,,,`,
      `Шевчук,Анна,,${dup},,,,`,
      `Мельник,Ігор,,pp-imp-role-${crypto.randomUUID()}@test.dev,boss,,,`,
      `,Марія,,pp-imp-empty-${crypto.randomUUID()}@test.dev,,,,`,
      `Ткач,Олег,,pp-imp-tpl-${crypto.randomUUID()}@test.dev,,no-such-role,,`,
      `Лисенко,Ніна,,pp-imp-super-${crypto.randomUUID()}@test.dev,superadmin,,,`,
    ].join("\n");

    const mgr = await staffWith("import-mgr", "users.manage");
    const preview = await api("/api/ops/people/users/import/preview", mgr.token, post({ csv }));
    expect(preview.status).toBe(200);
    const errs = Object.fromEntries(preview.body.rows.map((r: { line: number; errors: string[] }) => [r.line, r.errors]));
    expect(errs[2]).toEqual([]);
    expect(errs[3]).toEqual(["emailTaken"]);
    expect(errs[4]).toEqual([]);
    expect(errs[5]).toEqual(["emailDuplicate"]);
    expect(errs[6]).toEqual(["roleUnknown"]);
    expect(errs[7]).toEqual(["lastNameRequired"]);
    expect(errs[8]).toEqual(["roleTemplateUnknown"]);
    expect(errs[9]).toEqual(["roleNotAllowed"]);
    expect(preview.body.valid).toBe(2);

    const refused = await api("/api/ops/people/users/import", mgr.token, post({ csv }));
    expect(refused.status).toBe(400);
    expect(refused.body.preview.rows).toHaveLength(8);
    expect(await db.select().from(usersTable).where(eq(usersTable.email, good))).toHaveLength(0);
  });

  test("чистый файл — одной пачкой: временные пароли один раз, смена при входе, роль-шаблон выдана", async () => {
    const a = `pp-imp-a-${crypto.randomUUID()}@test.dev`;
    const b = `pp-imp-b-${crypto.randomUUID()}@test.dev`;
    const csv = `last_name,first_name,email,role_template,position\nКоваленко,Олена,${a},specialist,психолог\nГнатюк,Павло,${b},,`;
    const res = await api("/api/ops/people/users/import", root.token, post({ csv }));
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    const olena = res.body.created.find((p: { email: string }) => p.email === a);
    expect(olena.password).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);

    const signed = await login(a, olena.password);
    expect(signed.status).toBe(200);
    expect(signed.body.user.mustChangePassword).toBe(true);
    expect(signed.body.user.position).toBe("психолог");
    const roles = await db.select().from(staffRoles).where(eq(staffRoles.userId, olena.id));
    expect(roles.map((r) => r.roleId)).toContain("role-specialist");

    // в журнале — факт и почта, пароля нет
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.action, "user.create"), eq(auditLog.subjectUserId, olena.id)));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.details)).not.toContain(olena.password);
  });
});

/* ═══════════ хто переглядав ═══════════ */

describe("отчёт «хто переглядав»", () => {
  test("собирает про этого пациента по сотрудникам и дням, не собирает про чужого и его собственные действия", async () => {
    const mine = await makeUser("user", `pp-who-${crypto.randomUUID()}@test.dev`);
    const other = await makeUser("user", `pp-who-other-${crypto.randomUUID()}@test.dev`);
    for (const p of [mine, other]) await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: p.id, grantedBy: adminA.id });

    await api(`/api/patients/${mine.id}/card`, adminA.token);
    await api(`/api/patients/${mine.id}/card`, adminA.token);
    await api(`/api/patients/${other.id}/card`, adminA.token);
    await api(`/api/patients/${mine.id}/card`, root.token);
    // собственное действие пациента о себе — не «кто смотрел»
    await api("/api/auth/me", mine.token, { method: "PATCH", body: JSON.stringify({ unit: "Рота" }) });

    expect((await api(`/api/ops/people/who-viewed?patientId=${mine.id}&from=2026-01-01&to=2030-01-01`, adminA.token)).status).toBe(403);

    const today = new Date().toISOString().slice(0, 10);
    const res = await api(`/api/ops/people/who-viewed?patientId=${mine.id}&from=2026-01-01&to=2030-01-01`, root.token);
    expect(res.status).toBe(200);
    const byActor = new Map(res.body.actors.map((a: { actorId: string }) => [a.actorId, a]));
    expect([...byActor.keys()]).not.toContain(mine.id);
    const a = byActor.get(adminA.id) as { total: number; days: { day: string; actions: { action: string; count: number }[] }[] };
    expect(a.total).toBeGreaterThanOrEqual(2);
    expect(a.days[0]!.actions.find((x) => x.action === "patient.card_read")?.count).toBe(2);
    expect(Math.abs(new Date(a.days[0]!.day).getTime() - new Date(today).getTime())).toBeLessThanOrEqual(86_400_000);
    expect(byActor.get(root.id)).toBeTruthy();

    // сам отчёт — строка журнала о пациенте
    const [report] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "audit.subject_report"), eq(auditLog.subjectUserId, mine.id)));
    expect(report?.actorId).toBe(root.id);

    // период вне событий — пусто
    const empty = await api(`/api/ops/people/who-viewed?patientId=${mine.id}&from=2020-01-01&to=2020-01-31`, root.token);
    expect(empty.body.actors).toEqual([]);
  });

  test("группировка — чистая функция: «от имени» отдельной строкой, свои действия не в счёт", () => {
    const e = (at: string, actorId: string, details: Record<string, unknown> | null = null, subject = "p") => ({
      at,
      actorId,
      actorEmail: `${actorId}@t`,
      actorRole: "admin",
      action: "patient.card_read",
      subjectUserId: subject,
      details,
    });
    const rows = [
      e("2026-09-24T09:00:00.000Z", "doc"),
      e("2026-09-24T10:00:00.000Z", "root", { asUserId: "doc", asEmail: "doc@t" }),
      e("2026-09-24T11:00:00.000Z", "p"),
      e("2026-09-24T12:00:00.000Z", "doc", null, "someone-else"),
    ];
    expect(aboutPatient(rows[2]!, "p")).toBe(false);
    const grouped = groupWhoViewed(rows, "p", "Europe/Kyiv", new Map());
    expect(grouped.map((g) => g.actorId).sort()).toEqual(["doc", "root"]);
    const viaRoot = grouped.find((g) => g.actorId === "root")!;
    expect(viaRoot.days[0]!.actions[0]!.asUserEmail).toBe("doc@t");
  });

  test("поиск пациента — только пациенты, под audit.read", async () => {
    const res = await api(`/api/ops/people/patients?q=${encodeURIComponent("p@test")}`, root.token);
    expect(res.status).toBe(200);
    expect(res.body.items.some((p: { id: string }) => p.id === patient.id)).toBe(true);
    expect(res.body.items.every((p: { id: string }) => p.id !== adminA.id)).toBe(true);
  });
});

/* ═══════════ политики строк ═══════════ */

describe("новые таблицы — под политиками строк", () => {
  test("RLS включён и политика есть на каждой", async () => {
    const tables = ["user_second_factor", "user_recovery_codes", "security_policy", "impersonation_sessions", "suspicious_findings"];
    const rows = await db.execute<{ relname: string; relrowsecurity: boolean; n: number }>(sql`
      select c.relname, c.relrowsecurity,
             (select count(*)::int from pg_policies p where p.tablename = c.relname) as n
      from pg_class c
      where c.relname in (${sql.join(
        tables.map((t) => sql`${t}`),
        sql`, `,
      )})
    `);
    const byName = new Map([...rows].map((r) => [String(r.relname), r]));
    for (const t of tables) {
      expect(byName.get(t)?.relrowsecurity, `RLS выключен на ${t}`).toBe(true);
      expect(Number(byName.get(t)?.n), `нет политики на ${t}`).toBeGreaterThan(0);
    }
  });
});
