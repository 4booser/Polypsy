import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { renderError } from "@quizzy/shared";
import { app, db, json, makeUser } from "./fixtures";
import { users } from "../src/db/schema";
import { normalizePhone, phoneFingerprint } from "../src/lib/phone";
import { env } from "../src/env";

/**
 * Регистрация без приглашения в бою закрыта, и закрыта на деле (#155).
 *
 * Было так: env.ts по умолчанию считал её открытой, а docker-compose.yml
 * переменную OPEN_REGISTRATION в контейнер api не передавал. Строка
 * «OPEN_REGISTRATION=0» в .env.docker, как велит RUNBOOK, не меняла ничего,
 * и посторонний заводил учётку пациента, а по ответам «номер занят» (409) и
 * «создан» (201) узнавал, состоит ли человек с этим номером на учёте.
 *
 * Три звена, и проверяется каждое: compose передаёт переменную; без неё в
 * production регистрация закрыта; закрытая отвечает одинаково, чей бы номер
 * и чью бы почту ни прислали.
 */

const API = resolve(import.meta.dir, "..");
const ROOT = resolve(API, "../..");
const LONG = (c: string) => c.repeat(40);

const PROD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://nobody@localhost:5432/nowhere",
  JWT_SECRET: LONG("j"),
  PHONE_INDEX_SECRET: LONG("p"),
  EXPORT_SECRET: LONG("e"),
  SEARCH_INDEX_SECRET: LONG("s"),
  ENCRYPTION_KEY: `v1:${Buffer.alloc(32, 7).toString("base64")}`,
};

/**
 * Конфигурация читается один раз при загрузке модуля — поэтому отдельным
 * процессом, с окружением, каким его увидит сервер.
 */
async function openRegistration(patch: Record<string, string | undefined>): Promise<{ ok: boolean; out: string }> {
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  for (const [k, v] of Object.entries({ ...PROD, ...patch })) if (v !== undefined) environment[k] = v;
  const code = `const { env } = await import(${JSON.stringify(`${API}/src/env.ts`)}); console.log("OPEN=" + env.openRegistration)`;
  const proc = Bun.spawn(["bun", "-e", code], { cwd: API, env: environment, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { ok: (await proc.exited) === 0, out: `${out}${err}` };
}

describe("OPEN_REGISTRATION: умолчание и значения", () => {
  test("production без переменной и с пустой — закрыта", async () => {
    // пустая — это ровно то, что compose передаёт, когда в .env.docker её нет
    for (const value of [undefined, "", "  "]) {
      const res = await openRegistration({ OPEN_REGISTRATION: value });
      expect(res.ok, res.out).toBe(true);
      expect(res.out, `OPEN_REGISTRATION=${JSON.stringify(value)}`).toContain("OPEN=false");
    }
  });

  test("production: 0/false — закрыта, 1/true — открыта", async () => {
    for (const [value, open] of [
      ["0", false],
      ["false", false],
      ["1", true],
      ["TRUE", true],
    ] as const) {
      const res = await openRegistration({ OPEN_REGISTRATION: value });
      expect(res.out, `OPEN_REGISTRATION=${value}`).toContain(`OPEN=${open}`);
    }
  });

  test("вне production умолчание прежнее — открыта; 0 закрывает", async () => {
    const dev = await openRegistration({ NODE_ENV: "development", OPEN_REGISTRATION: undefined });
    expect(dev.out).toContain("OPEN=true");
    const devEmpty = await openRegistration({ NODE_ENV: "development", OPEN_REGISTRATION: "" });
    expect(devEmpty.out).toContain("OPEN=true");
    const devOff = await openRegistration({ NODE_ENV: "development", OPEN_REGISTRATION: "0" });
    expect(devOff.out).toContain("OPEN=false");
  });

  test("непонятное значение — отказ запуска, а не «открыто»", async () => {
    // прежде всё, кроме 0 и false, читалось как «да»: «OPEN_REGISTRATION=нет»
    // открывало регистрацию
    const res = await openRegistration({ OPEN_REGISTRATION: "нет" });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("OPEN_REGISTRATION");
    expect(res.out).not.toContain("OPEN=");
  });

  test("compose передаёт переменную в контейнер api, пример окружения её называет", () => {
    const compose = readFileSync(`${ROOT}/docker-compose.yml`, "utf8");
    const api = compose.slice(compose.indexOf("\n  api:\n"), compose.indexOf("\n  whisper-model:\n"));
    expect(api, "OPEN_REGISTRATION не объявлена у api в docker-compose.yml").toContain(
      "      OPEN_REGISTRATION: ${OPEN_REGISTRATION",
    );
    expect(readFileSync(`${ROOT}/.env.docker.example`, "utf8")).toMatch(/^OPEN_REGISTRATION=0$/m);
  });
});

async function register(body: Record<string, unknown>) {
  const res = await app.request("/api/auth/register?lang=uk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await json<Record<string, unknown>>(res) };
}

/**
 * Что увидит спрашивающий: код ответа, состав тела и всё в нём, кроме
 * номера запроса — он свой у каждого запроса и о людях ничего не говорит.
 */
const seen = (r: { status: number; body: Record<string, unknown> }) => {
  const { requestId, ...rest } = r.body ?? {};
  return JSON.stringify([r.status, Object.keys(r.body ?? {}).sort(), typeof requestId, rest]);
};

describe("закрытая регистрация: один ответ на известного и неизвестного", () => {
  test("номер на учёте, почта на учёте, ничего не известно — ответ байт в байт один", async () => {
    const knownEmail = `known-${crypto.randomUUID()}@example.org`;
    const settled = await makeUser("user", knownEmail);
    const tail = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    const knownPhone = `+38067${tail}`;
    await db
      .update(users)
      // отпечаток — от нормализованного номера, как в маршруте
      .set({ phoneIndex: phoneFingerprint(normalizePhone(knownPhone)!) })
      .where(eq(users.id, settled.id));

    const person = { password: "secret12345", firstName: "Проба", lastName: "Пробин" };
    const fresh = () => `probe-${crypto.randomUUID()}@example.org`;
    const unknownPhone = `+38093${tail}`;

    const wasOpen = env.openRegistration;
    const setOpen = (v: boolean) => {
      (env as { openRegistration: boolean }).openRegistration = v;
    };
    try {
      // Контроль: открытая регистрация — оракул, и проверка его видит.
      // Без этого «ответы совпали» ниже могло бы значить, что ответы
      // одинаковы всегда, например потому что запрос не доходит до маршрута.
      setOpen(true);
      const openKnown = await register({ ...person, email: fresh(), phone: knownPhone });
      expect(openKnown.status).toBe(409);
      const openKnownEmail = await register({ ...person, email: knownEmail, phone: unknownPhone });
      expect(openKnownEmail.status).toBe(409);

      setOpen(false);
      const byPhone = await register({ ...person, email: fresh(), phone: knownPhone });
      const byEmail = await register({ ...person, email: knownEmail, phone: `+38095${tail}` });
      const nobody = await register({ ...person, email: fresh(), phone: `+38098${tail}` });

      expect(nobody.status).toBe(400);
      expect(nobody.body.error).toBe(renderError("err.inviteRequired", "uk"));
      expect(seen(byPhone), "ответ на номер с учёта отличается от ответа на неизвестный").toBe(seen(nobody));
      expect(seen(byEmail), "ответ на почту с учёта отличается от ответа на неизвестную").toBe(seen(nobody));

      // и ничего не заведено
      const created = await db.query.users.findFirst({
        where: eq(users.phoneIndex, phoneFingerprint(normalizePhone(`+38098${tail}`)!)),
      });
      expect(created).toBeUndefined();
    } finally {
      setOpen(wasOpen);
    }
  }, 30_000);
});
