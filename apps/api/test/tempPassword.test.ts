import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, app, db, json, makeUser } from "./fixtures";
import { auditLog } from "../src/db/schema";

/**
 * Временный пароль ограничивает сервер, а не только экран.
 *
 * Внешний разбор 2026-09-26 (P1): пароль, выданный техпанелью (заведение
 * или сброс), видел тот, кто его выдавал, — и консоль открывала вместо
 * рабочего места смену пароля. Но это делал только экран: API отвечал на
 * всё как обычно, и знающий временный пароль читал карты запросами мимо
 * консоли. Теперь, пока пароль не сменён, сервер пускает только к смене
 * пароля, к «кто я» и к настройкам рабочего места; остальное — 403 с кодом
 * `password_change_required`. Выход токена не требует и сторожа не
 * проходит вовсе.
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

describe("временный пароль", () => {
  test("до смены — только смена пароля, «кто я» и настройки; остальное — 403 с кодом", async () => {
    const email = `temp-pass-${crypto.randomUUID()}@test.dev`;
    const person = await makeUser("admin", email, { mustChangePassword: true });
    const session = await login(email);
    expect(session.status).toBe(200);
    const token = session.body.token as string;

    const me = await api("/api/auth/me", token);
    expect(me.status).toBe(200);
    expect(me.body.mustChangePassword).toBe(true);

    const prefs = await api("/api/auth/me/workspace", token, {
      method: "PUT",
      body: JSON.stringify({ density: "compact" }),
    });
    expect(prefs.status).toBe(200);

    /* чтение карт, правка профиля — мимо смены пароля не идут */
    const patients = await api("/api/patients", token);
    expect(patients.status, "API пустил к картам с временным паролем").toBe(403);
    expect(patients.body.code).toBe("password_change_required");
    expect(typeof patients.body.error).toBe("string");

    const profile = await api("/api/auth/me", token, {
      method: "PATCH",
      body: JSON.stringify({ position: "ні" }),
    });
    expect(profile.status).toBe(403);
    expect(profile.body.code).toBe("password_change_required");

    /* отказ — в журнале, с причиной: кто-то ходит в API мимо экрана смены */
    const denied = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "access.denied"), eq(auditLog.actorId, person.id)));
    expect(
      denied.some((r) => (r.details as { reason?: string } | null)?.reason === "password_change_required"),
    ).toBe(true);

    /* смена пароля открывает всё — со следующего входа */
    const changed = await api("/api/auth/password", token, {
      method: "POST",
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "vlasnyi-parol-2026" }),
    });
    expect(changed.status).toBe(200);

    const again = await login(email, "vlasnyi-parol-2026");
    expect(again.status).toBe(200);
    expect(again.body.user.mustChangePassword).toBe(false);
    expect((await api("/api/patients", again.body.token as string)).status).toBe(200);
  });

  test("пациента с временным паролем кабинет тоже не пускает дальше смены", async () => {
    const email = `temp-pass-p-${crypto.randomUUID()}@test.dev`;
    await makeUser("user", email, { mustChangePassword: true });
    const session = await login(email);
    const token = session.body.token as string;

    expect((await api("/api/auth/me", token)).status).toBe(200);
    const mine = await api("/api/me/responses", token);
    expect(mine.status).toBe(403);
    expect(mine.body.code).toBe("password_change_required");

    /* выход — без токена и без сторожа */
    const out = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.body.refreshToken }),
    });
    expect(out.status).toBe(200);
  });

  test("без временного пароля сторож не мешает", async () => {
    const email = `temp-pass-no-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", email);
    const session = await login(email);
    expect((await api("/api/patients", session.body.token as string)).status).toBe(200);
  });
});
