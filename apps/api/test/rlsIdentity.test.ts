import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type postgres from "postgres";
import { adminA, api, db, makeUser, patient, root, surveyInA, type Person } from "./fixtures";
import { pushTokens, refreshTokens, savedViews } from "../src/db/schema";

/**
 * Политики строк на учётном контуре.
 *
 * Сетка RLS ставилась по клиническим данным и прошла мимо семи таблиц, среди
 * которых users: ФИО и дата рождения (шифрованные), почта, телефон, слепой
 * индекс телефона, хеш пароля. Маршрут, забывший скоуп, отдавал их целиком —
 * страховки под ним не было.
 *
 * Проверяется в двух режимах, и это здесь главное. Тесты ходят в базу
 * ВЛАДЕЛЬЦЕМ, а владелец в PostgreSQL политики обходит: зелёная сюита
 * доказывала бы только то, что ничего не сломалось в dev. Поэтому часть
 * проверок идёт отдельным подключением роли без прав владельца — как в бою,
 * — а часть поднимает ПРИЛОЖЕНИЕ ЦЕЛИКОМ такой ролью и пробует войти.
 * Вторая часть важнее первой: неверная политика на users ломает не выборку,
 * а вход, и ломает его только в бою.
 */

const API = resolve(import.meta.dir, "..");
const RLS_ROLE = "quizzy_rls_test";
const PASSWORD = "secret12345";

let rlsSql: ReturnType<typeof postgres>;
let owner: Person;
let stranger: Person;
let appUserEmail: string;

beforeAll(async () => {
  const pg = (await import("postgres")).default;
  const admin = pg(process.env.DATABASE_URL!, { max: 1 });
  await admin.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = '${RLS_ROLE}') then
      create role ${RLS_ROLE} login;
    end if;
  end $$`);
  await admin.unsafe(`grant usage on schema public to ${RLS_ROLE}`);
  await admin.unsafe(`grant select, insert, update, delete on all tables in schema public to ${RLS_ROLE}`);
  await admin.unsafe(`grant usage, select on all sequences in schema public to ${RLS_ROLE}`);
  await admin.end();

  const url = new URL(process.env.DATABASE_URL!);
  url.username = RLS_ROLE;
  url.password = "";
  rlsSql = pg(url.toString(), { max: 2 });

  owner = await makeUser("user", `rls-own-${crypto.randomUUID()}@test.dev`);
  stranger = await makeUser("user", `rls-other-${crypto.randomUUID()}@test.dev`);
  appUserEmail = `rls-app-${crypto.randomUUID()}@test.dev`;
  await makeUser("user", appUserEmail);

  // строки, которые политики должны различать по владельцу
  await db.insert(pushTokens).values([
    { id: crypto.randomUUID(), userId: owner.id, token: `t-${crypto.randomUUID()}`, platform: "web" },
    { id: crypto.randomUUID(), userId: stranger.id, token: `t-${crypto.randomUUID()}`, platform: "web" },
  ]);
  await db.insert(savedViews).values([
    { id: crypto.randomUUID(), ownerId: owner.id, scope: "rls", name: "своё", params: "{}", shared: false },
    { id: crypto.randomUUID(), ownerId: stranger.id, scope: "rls", name: "чужое", params: "{}", shared: false },
    { id: crypto.randomUUID(), ownerId: stranger.id, scope: "rls", name: "общее", params: "{}", shared: true },
  ]);
  await db.insert(refreshTokens).values({
    id: crypto.randomUUID(),
    userId: stranger.id,
    tokenHash: `h-${crypto.randomUUID()}`,
    familyId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  /*
   * Хотя бы одна запись в журнале — своя, а не «наверняка кто-то уже писал».
   * Опора на записи соседних файлов означала бы проверку порядка запуска:
   * этот файл вполне может выполниться первым.
   */
  await api("/api/cohorts/preview", adminA.token, { method: "POST", body: "{}" });
});

afterAll(async () => {
  await rlsSql?.end({ timeout: 3 }).catch(() => {});
});

/** Один запрос ролью без прав владельца, в транзакции с заданным контекстом */
async function as<T = { n: number }>(
  identity: { userId?: string; role?: string },
  query: string,
): Promise<T[]> {
  return rlsSql.begin(async (tx: postgres.TransactionSql) => {
    await tx`select set_config('app.user_id', ${identity.userId ?? ""}, true),
                    set_config('app.role', ${identity.role ?? ""}, true)`;
    return tx.unsafe(query);
  }) as never;
}

const count = async (identity: Parameters<typeof as>[0], query: string): Promise<number> =>
  Number((await as<{ n: number }>(identity, query))[0]?.n ?? NaN);

describe("users", () => {
  const all = "select count(*)::int n from users";

  test("без контекста — ни одной строки", async () => {
    /*
     * Забытый requireAuth в новом маршруте должен упираться в пустую выборку,
     * а не в список всех пациентов учреждения с телефонами.
     */
    expect(await count({}, all)).toBe(0);
  });

  test("пациент видит только себя", async () => {
    const mine = await count({ userId: owner.id, role: "user" }, all);
    expect(mine).toBe(1);

    const [row] = await as<{ id: string }>({ userId: owner.id, role: "user" }, "select id from users");
    expect(row?.id).toBe(owner.id);
  });

  test("персонал видит учётные записи", async () => {
    // обратная проверка: политика, не пускающая никого, «защищает» тем, что
    // ломает работу, и такую находят не тестом, а звонком из регистратуры
    const staff = await count({ userId: adminA.id, role: "admin" }, all);
    expect(staff).toBeGreaterThan(1);
  });

  test("пациент не правит чужую строку", async () => {
    const changed = await as<{ id: string }>(
      { userId: owner.id, role: "user" },
      `update users set unit = 'взломано' where id = '${stranger.id}' returning id`,
    );
    expect(changed).toHaveLength(0);
  });

  test("пациент не назначает себе роль администратора", async () => {
    /*
     * Свою строку он правит законно — это профиль. Опасна одна колонка:
     * роль. Прикладной код её не отдаёт, и ровно на такой случай — «а если
     * однажды отдаст» — существует WITH CHECK.
     */
    const attempt = as(
      { userId: owner.id, role: "user" },
      `update users set role = 'admin' where id = '${owner.id}'`,
    );
    await expect((async () => { await attempt; })()).rejects.toThrow(/row-level security|policy/i);
  });
});

describe("group_admins", () => {
  /*
   * Самое опасное место из семи. Политика rls_admin_sees_survey, на которой
   * держится половина остальных политик, читает именно эту таблицу: вписать
   * себя администратором группы значит получить доступ ко всем её методикам,
   * прохождениям и заключениям разом.
   */
  test("пациент не вписывает себя в администраторы группы", async () => {
    const [group] = await as<{ id: string }>({ role: "system" }, "select id from survey_groups limit 1");
    const attempt = as(
      { userId: owner.id, role: "user" },
      `insert into group_admins (group_id, user_id, added_by)
       values ('${group!.id}', '${owner.id}', '${owner.id}')`,
    );
    await expect((async () => { await attempt; })()).rejects.toThrow(/row-level security|policy/i);
  });

  test("администратор не вписывает себя в чужую группу", async () => {
    // раздача прав — дело суперадмина; политика говорит то же самое
    const [group] = await as<{ id: string }>({ role: "system" }, "select id from survey_groups limit 1");
    const attempt = as(
      { userId: adminA.id, role: "admin" },
      `insert into group_admins (group_id, user_id, added_by)
       values ('${group!.id}', '${stranger.id}', '${adminA.id}')`,
    );
    await expect((async () => { await attempt; })()).rejects.toThrow(/row-level security|policy/i);
  });

  test("свои назначения видны — на них держится зона ответственности", async () => {
    const own = await count(
      { userId: adminA.id, role: "admin" },
      `select count(*)::int n from group_admins where user_id = '${adminA.id}'`,
    );
    expect(own).toBeGreaterThan(0);
  });
});

describe("журнал доступа", () => {
  const all = "select count(*)::int n from audit_log";

  test("пациенту журнал не виден", async () => {
    expect(await count({ userId: owner.id, role: "user" }, all)).toBe(0);
  });

  test("но записывать в него пациент обязан уметь", async () => {
    /*
     * Иначе действие пациента не попадает в журнал — а это половина того,
     * что в журнале вообще есть. Голову хэш-цепочки для этого читает
     * SECURITY DEFINER-функция: обычная выборка из контекста пациента
     * вернула бы «цепочки нет», и запись упёрлась бы в уникальный индекс.
     */
    const [head] = await as<{ seq: number | null }>(
      { userId: owner.id, role: "user" },
      "select seq from audit_chain_head()",
    );
    expect(Number(head?.seq ?? 0)).toBeGreaterThan(0);
  });

  test("правка и удаление записей не разрешены никому", async () => {
    const changed = await as(
      { role: "system" },
      "update audit_log set action = 'подделка' where seq is not null returning id",
    ).catch(() => []);
    expect(changed).toHaveLength(0);
  });

  test("персоналу журнал виден: право audit.read выдаётся не только суперадмину", async () => {
    expect(await count({ userId: adminA.id, role: "admin" }, all)).toBeGreaterThan(0);
    expect(await count({ userId: root.id, role: "superadmin" }, all)).toBeGreaterThan(0);
  });
});

describe("сессии и попытки входа", () => {
  test("пациент не видит чужих refresh-токенов", async () => {
    const mine = await count(
      { userId: owner.id, role: "user" },
      "select count(*)::int n from refresh_tokens",
    );
    const total = await count({ role: "system" }, "select count(*)::int n from refresh_tokens");
    expect(total).toBeGreaterThan(0);
    expect(mine).toBeLessThan(total);
  });

  test("пациент не гасит чужие сессии", async () => {
    const revoked = await as<{ id: string }>(
      { userId: owner.id, role: "user" },
      `update refresh_tokens set revoked_at = now() where user_id = '${stranger.id}' returning id`,
    );
    expect(revoked).toHaveLength(0);
  });

  test("счётчик неудачных попыток входа — только системе", async () => {
    /*
     * Это перечень существующих учётных записей, ради нераскрытия которого
     * на входе специально выравнивается время ответа. Маршрута, который его
     * показывает, нет — значит и в таблицу смотреть никому, кроме входа.
     */
    const staff = await count(
      { userId: adminA.id, role: "admin" },
      "select count(*)::int n from login_attempts",
    );
    expect(staff).toBe(0);
  });
});

describe("приглашения, устройства, сохранённые виды", () => {
  test("пациент не читает приглашения", async () => {
    expect(await count({ userId: owner.id, role: "user" }, "select count(*)::int n from invites")).toBe(0);
  });

  test("устройства — свои и только свои", async () => {
    const mine = await count(
      { userId: owner.id, role: "user" },
      "select count(*)::int n from push_tokens",
    );
    expect(mine).toBe(1);
  });

  test("сохранённый вид: свой и общий видны, чужой личный — нет", async () => {
    const names = (
      await as<{ name: string }>(
        { userId: owner.id, role: "user" },
        "select name from saved_views where scope = 'rls'",
      )
    ).map((r) => r.name);
    expect(names.sort()).toEqual(["общее", "своё"]);
  });
});

/**
 * Приложение целиком под ролью приложения.
 *
 * Отдельным процессом, потому что подключение к базе у приложения одно на
 * процесс и выбирается при загрузке модуля. Без этой проверки любая ошибка в
 * политике на users выглядела бы как зелёная сюита: владелец политики
 * обходит, и в dev всё работает. Ломается — вход, и только в бою.
 */
describe("вход под ролью приложения (как в бою)", () => {
  let result: {
    rlsActive?: boolean;
    login?: number;
    me?: number;
    submit?: number;
    afterLogout?: number;
    error?: string;
  } = {};

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = RLS_ROLE;
    url.password = "";

    const script = `
      const { app } = await import(${JSON.stringify(`${API}/src/app.ts`)});
      const { checkRls } = await import(${JSON.stringify(`${API}/src/lib/rlsGuard.ts`)});
      const out = {};
      try {
        out.rlsActive = !(await checkRls()).bypasses;

        const login = await app.request("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: ${JSON.stringify(appUserEmail)}, password: ${JSON.stringify(PASSWORD)} }),
        });
        out.login = login.status;
        const pair = await login.json();

        const auth = { Authorization: "Bearer " + pair.token, "Content-Type": "application/json" };
        out.me = (await app.request("/api/auth/me", { headers: auth })).status;

        // сдача методики: пишет прохождение, ответы, баллы и запись журнала
        // из контекста пациента — то есть проверяет и цепочку журнала
        const survey = await (await app.request("/api/surveys/${surveyInA}", { headers: auth })).json();
        const answers = survey.questions
          .filter((q) => q.type !== "info" && q.options.length)
          .map((q) => ({ questionId: q.id, optionIds: [q.options[1]?.id ?? q.options[0].id], durationMs: 2000, changeCount: 0, visitCount: 1 }));
        const submit = await app.request("/api/surveys/${surveyInA}/responses", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ startedAt: new Date(Date.now() - 60000).toISOString(), durationMs: 60000, events: [], answers }),
        });
        out.submit = submit.status;

        await app.request("/api/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: pair.refreshToken }),
        });
        out.afterLogout = (await app.request("/api/auth/me", { headers: auth })).status;
      } catch (e) {
        out.error = String(e);
      }
      console.log("RESULT:" + JSON.stringify(out));
      process.exit(0);
    `;

    const proc = Bun.spawn(["bun", "-e", script], {
      cwd: API,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url.toString(),
        JWT_SECRET: process.env.JWT_SECRET ?? "",
        ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "",
        SCHEDULER_ENABLED: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const line = `${out}${err}`.split("\n").find((l) => l.startsWith("RESULT:"));
    result = line ? JSON.parse(line.slice("RESULT:".length)) : { error: `${out}${err}`.slice(0, 2000) };
  });

  test("политики для этой роли действительно действуют", async () => {
    // иначе всё, что ниже, проверяло бы обход политик, а не их работу
    expect(result.error ?? "").toBe("");
    expect(result.rlsActive).toBe(true);
  });

  test("вход по паролю работает", () => {
    expect(result.login).toBe(200);
  });

  test("«кто я» работает: строка пользователя читается системным контекстом", () => {
    expect(result.me).toBe(200);
  });

  test("пациент сдаёт методику — и запись в журнал проходит", () => {
    expect(result.submit).toBe(201);
  });

  test("выход отзывает токен и под политиками тоже", () => {
    // сдвиг метки — это UPDATE по users из открытого маршрута; под
    // политиками он проходит только потому, что выход объявлен системным
    expect(result.afterLogout).toBe(401);
  });
});

describe("владелец базы политики обходит", () => {
  test("та же выборка владельцем возвращает всех — потому и нужна роль без прав", async () => {
    /*
     * Это не придирка к чистоте: dev и тестовая сюита ходят владельцем, для
     * которого политик нет вовсе. Проверка существует, чтобы разница между
     * режимами была записана, а не подразумевалась.
     */
    const { users } = await import("../src/db/schema");
    const rows = await db.select({ id: users.id }).from(users);
    expect(rows.length).toBeGreaterThan(1);
    expect(patient.id).toBeTruthy();
  });
});
