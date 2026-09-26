import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpsKeysReport, OpsReencryptJob, OpsSqlResult } from "@quizzy/shared";
import { api, db, eq, makeUser, patient, root, sql, users, type Person } from "./fixtures";
import { rlsRoleUrl, underAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { dbContext } from "../src/db/context";
import {
  appointments,
  auditLog,
  departments,
  integrityChecks,
  patientNotes,
  permissionExceptions,
  securityJobs,
  slots,
  specialistProfiles,
  visitRecordings,
} from "../src/db/schema";
import { verifyChain } from "../src/lib/auditVerify";
import { decryptField, encryptField, reloadKeysForTests } from "../src/lib/crypto";
import {
  lastAuditChainCheck,
  recordCheck,
  reportChainBroken,
  rlsReport,
  runScheduledAuditCheck,
} from "../src/lib/integrity";
import { encryptedColumns } from "../src/lib/keyInventory";
import { startReencrypt } from "../src/lib/keyRotation";
import { normalizePhone, phoneFingerprint } from "../src/lib/phone";
import { readAudio } from "../src/lib/recordings";
import { observeSecrets, secretStatuses } from "../src/lib/secretMarks";
import { runReadOnly, screenQuery } from "../src/lib/sqlConsole";

/**
 * Техпанель, участок безопасности: «Ключі й секрети», «Цілісність»,
 * «SQL (читання)».
 *
 * Главное здесь — не «экран что-то показывает», а три утверждения, на
 * которых держится доверие к разделу:
 *   — ни один из трёх разделов не открывается никаким правом, только ролью
 *     суперадмина, и проверяет это сервер;
 *   — SQL-консоль не способна изменить базу, даже если первый пояс (разбор
 *     текста) пропустит лишнее, и каждый её запрос лежит в журнале с
 *     причиной;
 *   — ротация ключа доводит до конца то, что обещает: после перешифровки
 *     на старом ключе не остаётся ни значения, ни файла записи приёма, и
 *     всё по-прежнему читается.
 */

const OLD_KEY = `v1:${Buffer.alloc(32, 9).toString("base64")}`; // как в preload.ts
const NEW_KEY = `v2:${Buffer.alloc(32, 7).toString("base64")}`;

let delegate: Person;
const post = (path: string, token: string, body: unknown = {}) =>
  api(path, token, { method: "POST", body: JSON.stringify(body) });

const sqlAs = (token: string, query: string, reason = "разбор теста") =>
  post("/api/ops/sec/sql", token, { query, reason }) as Promise<{ status: number; body: OpsSqlResult }>;

beforeAll(async () => {
  /*
   * Администратор, которому выдано ВСЁ, что можно выдать правом: ops.read,
   * ops.manage, журнал и учётки. Именно он — главный отрицательный случай:
   * раздел, открывающийся правом, однажды откроется тому, кому право дали
   * «на неделю, для разбора».
   */
  delegate = await makeUser("admin", `sec-delegate-${crypto.randomUUID()}@test`);
  for (const permission of ["ops.read", "ops.manage", "audit.read", "users.manage", "console.use"]) {
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: delegate.id,
      permission,
      mode: "grant",
      reason: "проверка: техпанель безопасности не открывается правом",
      grantedBy: root.id,
    });
  }
});

/* ═══════════ доступ ═══════════ */

describe("доступ к разделам безопасности", () => {
  const routes: [string, string][] = [
    ["GET", "/api/ops/sec/keys"],
    ["GET", "/api/ops/sec/keys/job"],
    ["POST", "/api/ops/sec/keys/reencrypt"],
    ["POST", "/api/ops/sec/keys/reindex-phones"],
    ["GET", "/api/ops/sec/integrity"],
    ["POST", "/api/ops/sec/integrity/rls"],
    ["POST", "/api/ops/sec/integrity/audit"],
    ["GET", "/api/ops/sec/sql"],
    ["POST", "/api/ops/sec/sql"],
  ];

  test("администратор с ops.read, ops.manage, audit.read и users.manage получает 403 везде", async () => {
    const statuses: string[] = [];
    for (const [method, path] of routes) {
      const res = await api(path, delegate.token, {
        method,
        ...(method === "POST" ? { body: JSON.stringify({ query: "select 1", reason: "попытка" }) } : {}),
      });
      if (res.status !== 403) statuses.push(`${method} ${path} → ${res.status}`);
    }
    expect(statuses).toEqual([]);
  });

  test("пациент получает 403 везде", async () => {
    for (const [method, path] of routes) {
      const res = await api(path, patient.token, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  test("отказ пишется в журнал", async () => {
    await api("/api/ops/sec/sql", delegate.token);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.actorId} = ${delegate.id} and ${auditLog.action} = 'access.denied'`)
      .limit(1);
    expect(row?.outcome).toBe("denied");
  });

  test("суперадмину разделы открыты", async () => {
    for (const path of ["/api/ops/sec/keys", "/api/ops/sec/integrity", "/api/ops/sec/sql"]) {
      expect((await api(path, root.token)).status, path).toBe(200);
    }
  });
});

/* ═══════════ SQL (читання) ═══════════ */

describe("SQL-консоль: первый пояс — разбор текста", () => {
  const refused = (q: string) => {
    const s = screenQuery(q);
    return s.ok ? null : s.code;
  };

  test("чтение проходит, в том числе с опасными словами внутри строк и комментариев", () => {
    expect(refused("select 1")).toBeNull();
    expect(refused("select 1;")).toBeNull();
    expect(refused("  (select 1)  ")).toBeNull();
    expect(refused("with x as (select 1) select * from x")).toBeNull();
    expect(refused("select 'delete; drop table users' as t -- ; commit\n")).toBeNull();
    expect(refused("select $q$ ; delete $q$ /* ; update */")).toBeNull();
    expect(refused("explain analyze select 1")).toBeNull();
    expect(refused("show statement_timeout")).toBeNull();
    expect(refused("table survey_groups")).toBeNull();
    expect(refused("select updated_at, created_at from users")).toBeNull();
  });

  test("несколько операторов — отказ", () => {
    expect(refused("select 1; select 2")).toBe("multiple_statements");
    expect(refused("COMMIT; DELETE FROM users")).toBe("multiple_statements");
    expect(refused("select 1; -- хвост\n delete from users")).toBe("multiple_statements");
  });

  test("запись и DDL — отказ", () => {
    expect(refused("delete from users")).toBe("not_read");
    expect(refused("INSERT INTO users (id) values ('x')")).toBe("not_read");
    expect(refused("update users set role = 'superadmin'")).toBe("not_read");
    expect(refused("create table x (a int)")).toBe("not_read");
    expect(refused("drop table users")).toBe("not_read");
    expect(refused("SET TRANSACTION READ WRITE")).toBe("not_read");
    expect(refused("with d as (delete from users returning 1) select * from d")).toBe("write_keyword");
    expect(refused("select * into temp t from users")).toBe("write_keyword");
    expect(refused("select * from users for share")).toBe("row_lock");
  });

  test("функции с побочным эффектом — отказ, в том числе спрятанные кавычками", () => {
    expect(refused("select nextval('s')")).toBe("side_effect");
    expect(refused(`select "nextval"('s')`)).toBe("side_effect");
    expect(refused("select pg_advisory_lock(7154301)")).toBe("side_effect");
    expect(refused("select pg_terminate_backend(pid) from pg_stat_activity")).toBe("side_effect");
    expect(refused("select set_config('transaction_read_only', 'off', true)")).toBe("side_effect");
    expect(refused("select query_to_xml('delete from users', true, true, '')")).toBe("side_effect");
  });

  test("пустой запрос и подстановки — отказ", () => {
    expect(refused("   ")).toBe("empty");
    expect(refused("-- только комментарий")).toBe("not_read");
    expect(refused("select $1::int")).toBe("placeholder");
  });
});

describe("SQL-консоль: второй пояс — база сама не даёт записать", () => {
  /*
   * Разбор выше обходится — SQL слишком богат. Поэтому то же самое
   * посылается прямо исполнителю, мимо разбора: запрет обязан держаться на
   * протоколе и транзакции, а не на регулярных выражениях.
   */
  beforeAll(async () => {
    await db.execute(sql`create sequence if not exists ops_sec_probe_seq`);
  });

  test("два оператора не проходят расширенный протокол, строк не убывает", async () => {
    const before = await db.$count(users);
    const res = await runReadOnly("commit; delete from users", { userId: root.id });
    expect(res.status).toBe("error");
    expect(res.status === "error" && res.code).toBe("42601");
    expect(await db.$count(users)).toBe(before);
  });

  test("запись, DDL и nextval упираются в READ ONLY", async () => {
    for (const q of [
      "delete from push_tokens",
      "create table ops_sec_nope (a int)",
      "select nextval('ops_sec_probe_seq')",
      "with d as (delete from users returning 1) select * from d",
    ]) {
      const res = await runReadOnly(q, { userId: root.id });
      expect(res.status === "error" && res.code, q).toBe("25006");
    }
    const [seq] = await db.execute<{ is_called: boolean }>(sql`select is_called from ops_sec_probe_seq`);
    expect(seq?.is_called).toBe(false);
  });

  test("включить запись обратно внутри транзакции нельзя", async () => {
    const a = await runReadOnly("set transaction read write", { userId: root.id });
    expect(a.status === "error" && a.code).toBe("25001");
    const b = await runReadOnly("select set_config('transaction_read_only', 'off', true)", { userId: root.id });
    expect(b.status === "error" && b.code).toBe("25001");
  });

  test("лимит строк: лишняя строка — признак «обрезано»", async () => {
    const res = await runReadOnly("select generate_series(1, 10) as n", { userId: root.id, maxRows: 3 });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.rowCount).toBe(3);
    expect(res.truncated).toBe(true);
    expect(res.rows.map((r) => r[0])).toEqual(["1", "2", "3"]);
    expect(res.columns).toEqual([{ name: "n", type: "int4", masked: undefined }]);
  });

  test("лимит времени", async () => {
    const res = await runReadOnly("select pg_sleep(3)", { userId: root.id, timeoutMs: 200 });
    expect(res.status === "error" && res.code).toBe("57014");
  });

  test("под ролью приложения действуют политики строк с контекстом суперадмина", async () => {
    const url = await rlsRoleUrl();
    const res = await runReadOnly("select current_user::text as who, count(*)::int as n from users", {
      userId: root.id,
      url,
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.rows[0]?.[0]).toBe("quizzy_rls_test");
    // суперадмину учётные записи видны; без контекста политика отдала бы ноль
    expect(Number(res.rows[0]?.[1])).toBeGreaterThan(0);
  });
});

describe("SQL-консоль: маршрут", () => {
  test("чтение: строки, время, шифрованные поля остаются шифртекстом", async () => {
    const res = await sqlAs(root.token, `select email, last_name from users where id = '${root.id}'`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    if (res.body.status !== "ok") return;
    expect(res.body.rowCount).toBe(1);
    expect(res.body.rows[0]?.[0]).toBe("root@test");
    expect(res.body.rows[0]?.[1]?.startsWith("enc1:")).toBe(true);
    expect(typeof res.body.ms).toBe("number");
  });

  test("хэш пароля не показывается и под другим именем", async () => {
    const res = await sqlAs(root.token, `select password_hash as x, email from users where id = '${root.id}'`);
    expect(res.body.status).toBe("ok");
    if (res.body.status !== "ok") return;
    expect(res.body.columns[0]?.masked).toBe(true);
    expect(res.body.rows[0]?.[0]).toBe("•••");
    expect(res.body.rows[0]?.[1]).toBe("root@test");
  });

  test("лимит строк по умолчанию — 500", async () => {
    const res = await sqlAs(root.token, "select generate_series(1, 2000)");
    expect(res.body.status === "ok" && res.body.rowCount).toBe(500);
    expect(res.body.status === "ok" && res.body.truncated).toBe(true);
  });

  test("EXPLAIN отдаёт план", async () => {
    const res = await sqlAs(root.token, "explain select 1");
    expect(res.body.status === "ok" && res.body.rowCount).toBeGreaterThan(0);
  });

  test("без причины запрос не принимается", async () => {
    const res = await post("/api/ops/sec/sql", root.token, { query: "select 1", reason: " " });
    expect(res.status).toBe(400);
  });

  test("каждый запрос — строка журнала с причиной, текстом и числом строк; отказы тоже", async () => {
    const tag = crypto.randomUUID();
    await sqlAs(root.token, "select generate_series(1, 7)", `разбор ${tag}`);
    await sqlAs(root.token, "commit; delete from users", `попытка ${tag}`);
    await sqlAs(root.token, "select nonexistent_column from users", `ошибка ${tag}`);

    const rows = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'sec.sql_query' and ${auditLog.details}->>'reason' like ${`%${tag}`}`);
    const by = (prefix: string) => rows.find((r) => String(r.details?.reason).startsWith(prefix));

    expect(by("разбор")?.outcome).toBe("success");
    expect(by("разбор")?.details?.rows).toBe(7);
    expect(by("разбор")?.details?.query).toBe("select generate_series(1, 7)");
    expect(by("разбор")?.actorId).toBe(root.id);

    expect(by("попытка")?.outcome).toBe("denied");
    expect(by("попытка")?.details?.refused).toBe("multiple_statements");

    expect(by("ошибка")?.outcome).toBe("error");
    expect(by("ошибка")?.details?.error).toBe("42703");
  });

  test("экран узнаёт роль, под которой идёт запрос", async () => {
    const res = await api("/api/ops/sec/sql", root.token);
    expect(res.body.role).toBeTruthy();
    // тесты ходят владельцем базы — сторож обязан это назвать
    expect(res.body.bypassesRls).toBe(true);
    expect(res.body.maxRows).toBe(500);
  });
});

/* ═══════════ Ключі й секрети ═══════════ */

async function keys(): Promise<OpsKeysReport> {
  const res = await api<OpsKeysReport>("/api/ops/sec/keys", root.token);
  expect(res.status).toBe(200);
  return res.body;
}

/*
 * Проход перешифровывает всю базу, а база у сюиты общая: в CI до этого файла
 * успевают пройти десятки других, и проход там длится дольше пяти секунд
 * bun по умолчанию. Отсюда явный запас у тестов прохода и у хука, который
 * возвращает сюиту на v1 (REENCRYPT_MS), и ожидание до тридцати секунд:
 * опоздавшее ожидание иначе дочитывало чужое задание из следующих тестов и
 * падало «между тестами».
 */
const REENCRYPT_MS = 60_000;

async function waitJob(): Promise<OpsReencryptJob> {
  for (let i = 0; i < 1200; i++) {
    const { body } = await api<{ job: OpsReencryptJob | null }>("/api/ops/sec/keys/job", root.token);
    if (body.job && body.job.status !== "running") return body.job;
    await Bun.sleep(25);
  }
  throw new Error("перешифровка не закончилась за тридцать секунд");
}

/** Файл записи приёма, как его писали до заголовков: iv, тег, тело — ключом v1 */
function legacyAudio(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 9), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

describe("ключи: опись", () => {
  test("версии ключа в данных, основной ключ, образец открывается", async () => {
    const report = await keys();
    expect(report.encryption).toBe(true);
    expect(report.activeKey).toBe("v1");
    expect(report.loadedKeys).toEqual(["v1"]);
    const v1 = report.keys.find((k) => k.id === "v1")!;
    expect(v1.active).toBe(true);
    expect(v1.loaded).toBe(true);
    expect(v1.values).toBeGreaterThan(0);
    expect(v1.opens).toBe(true);
    const lastName = report.columns.find((c) => c.table === "users" && c.column === "last_name")!;
    expect(lastName.byKey.v1).toBeGreaterThan(0);
    expect(lastName.rewrappable).toBe(true);
  });

  test("значения на ключе, которого нет в окружении, — потеря, и она названа", async () => {
    const lost = await makeUser("user", `sec-lost-${crypto.randomUUID()}@test`);
    await db.update(users).set({ middleName: "enc1:v9:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBB" }).where(eq(users.id, lost.id));
    try {
      const report = await keys();
      const v9 = report.keys.find((k) => k.id === "v9")!;
      expect(v9.loaded).toBe(false);
      expect(v9.values).toBe(1);
      expect(report.lostTotal).toBeGreaterThanOrEqual(1);
    } finally {
      await db.update(users).set({ middleName: null }).where(eq(users.id, lost.id));
    }
  });

  test("опись полна: значения enc1: вне неё в базе не лежат", async () => {
    /*
     * Страж правила имени (см. lib/keyInventory.ts): шифрованная колонка
     * называется *_enc, а старые имена перечислены поимённо. Проверка идёт по
     * всем текстовым колонкам базы — дорогая для боя, дешёвая для тестовой.
     */
    const registered = new Set((await encryptedColumns()).map((c) => `${c.table}.${c.column}`));
    const all = await db.execute<{ t: string; c: string }>(sql`
      select c.relname::text as t, a.attname::text as c
        from pg_class c join pg_attribute a on a.attrelid = c.oid
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
         and a.attnum > 0 and not a.attisdropped and a.atttypid in ('text'::regtype, 'varchar'::regtype)`);
    const outside: string[] = [];
    for (const { t, c } of all) {
      if (registered.has(`${t}.${c}`) || t === "audit_log") continue;
      const [row] = await db.execute<{ n: number }>(
        sql.raw(`select count(*)::int as n from "${t}" where "${c}" like 'enc1:%'`),
      );
      if (Number(row?.n)) outside.push(`${t}.${c}`);
    }
    expect(outside).toEqual([]);
  });

  test("ни ключей, ни секретов в ответе", async () => {
    process.env.METRICS_TOKEN = "metrics-token-for-sec-test-0123456789";
    try {
      const text = JSON.stringify(await keys());
      expect(text).not.toContain(Buffer.alloc(32, 9).toString("base64"));
      expect(text).not.toContain(process.env.JWT_SECRET!);
      expect(text).not.toContain("metrics-token-for-sec-test");
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });
});

describe("секреты: смена замечается", () => {
  test("новое значение — новая дата и строка журнала", async () => {
    await observeSecrets();
    const before = (await secretStatuses()).find((s) => s.name === "METRICS_TOKEN")!;

    process.env.METRICS_TOKEN = `sec-test-${crypto.randomUUID()}`;
    try {
      await observeSecrets(new Date(Date.now() + 1000));
      const after = (await secretStatuses()).find((s) => s.name === "METRICS_TOKEN")!;
      expect(after.state).toBe("set");
      expect(after.seenSince! > before.seenSince!).toBe(true);
      expect(after.trackedSince).toBe(before.trackedSince);
    } finally {
      delete process.env.METRICS_TOKEN;
      await observeSecrets(new Date(Date.now() + 2000));
    }
    const [row] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'sec.secret_changed' and ${auditLog.resourceId} = 'METRICS_TOKEN'`)
      .limit(1);
    expect(row).toBeDefined();
    // в журнале нет ни значения, ни отпечатка
    expect(JSON.stringify(row?.details)).not.toContain("sec-test-");
  });

  test("стандартное значение для разработки названо прямо", async () => {
    const statuses = await secretStatuses();
    // PHONE_INDEX_SECRET в тестах не задан — стоит dev-значение из env.ts
    expect(statuses.find((s) => s.name === "PHONE_INDEX_SECRET")?.state).toBe("default");
    expect(statuses.find((s) => s.name === "JWT_SECRET")?.state).toBe("set");
  });
});

describe("ротация ключа: перешифровка на основной", () => {
  let dir: string;
  let legacyPath: string;
  let headedPath: string;
  const audio = Buffer.from("запис прийому: тестові байти");
  const signedNoteId = crypto.randomUUID();

  beforeAll(async () => {
    /*
     * Две записи приёма на диске: старая, без заголовка, и с заголовком v1.
     * Первая — самый коварный случай: она читается ОСНОВНЫМ ключом и
     * ломается в момент, когда основным становится новый.
     */
    dir = await mkdtemp(join(tmpdir(), "quizzy-sec-"));
    legacyPath = join(dir, "legacy.enc");
    headedPath = join(dir, "headed.enc");
    await writeFile(legacyPath, legacyAudio(audio));
    await writeFile(headedPath, Buffer.concat([Buffer.from("enc1:v1:"), legacyAudio(audio)]));

    const departmentId = crypto.randomUUID();
    await db.insert(departments).values({ id: departmentId, title: { uk: "Ротація", ru: "Ротация" }, timezone: "Europe/Kyiv" });
    const doctor = await makeUser("admin", `sec-doc-${crypto.randomUUID()}@test`);
    const person = await makeUser("user", `sec-p-${crypto.randomUUID()}@test`);

    /*
     * Подписанная заметка приёма: триггер неизменяемости (0034) до миграции
     * 0092 не пускал к ней даже перешифровку, и ротация падала на первой же.
     */
    await db.insert(patientNotes).values({
      id: signedNoteId,
      userId: person.id,
      version: 1,
      text: encryptField("підписаний запис прийому")!,
      status: "signed",
      createdBy: doctor.id,
      signedAt: new Date().toISOString(),
    } as never);
    await db.insert(specialistProfiles).values({ userId: doctor.id, departmentId });
    for (const path of [legacyPath, headedPath]) {
      const slotId = crypto.randomUUID();
      await db.insert(slots).values({
        id: slotId,
        departmentId,
        specialistId: doctor.id,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 3000_000).toISOString(),
        kind: "primary",
      });
      const appointmentId = crypto.randomUUID();
      await db.insert(appointments).values({
        id: appointmentId,
        slotId,
        patientId: person.id,
        specialistId: doctor.id,
        kind: "primary",
        status: "done",
        bookedBy: doctor.id,
      });
      await db.insert(visitRecordings).values({
        id: crypto.randomUUID(),
        appointmentId,
        patientId: person.id,
        specialistId: doctor.id,
        audioPath: path,
      } as never);
    }
  });

  afterAll(async () => {
    /*
     * Вернуть сюиту на v1, что бы ни случилось выше: остальные файлы
     * тестов ждут значений «enc1:v1:». Оба ключа загружены, основной — v1,
     * проход переводит всё обратно; только потом v2 выгружается.
     */
    reloadKeysForTests(`${OLD_KEY},${NEW_KEY}`);
    const back = await startReencrypt({ id: root.id, email: "root@test" });
    if (back.started) await back.done;
    reloadKeysForTests(OLD_KEY);
    await rm(dir, { recursive: true, force: true });
    // обратный проход идёт по всей базе — тот же запас, что у теста прохода
  }, REENCRYPT_MS);

  test("новый ключ основным: старое видно как «перешифровать», файл без заголовка тоже", async () => {
    reloadKeysForTests(`${NEW_KEY},${OLD_KEY}`);
    const report = await keys();
    expect(report.activeKey).toBe("v2");
    expect(report.loadedKeys).toEqual(["v2", "v1"]);
    const v1 = report.keys.find((k) => k.id === "v1")!;
    expect(v1.active).toBe(false);
    expect(v1.values).toBeGreaterThan(0);
    expect(v1.files).toBeGreaterThanOrEqual(1);
    expect(report.files.legacy).toBeGreaterThanOrEqual(1);
    expect(report.staleTotal).toBeGreaterThan(0);
  });

  test("перешифровка идёт фоном, доходит до конца и оставляет старый ключ пустым", async () => {
    const start = await post("/api/ops/sec/keys/reencrypt", root.token);
    expect(start.status).toBe(202);
    expect(start.body.job.targetKey).toBe("v2");

    const job = await waitJob();
    expect(job.status).toBe("done");
    expect(job.processed).toBeGreaterThan(0);

    const report = await keys();
    const v1 = report.keys.find((k) => k.id === "v1");
    expect(v1?.values ?? 0).toBe(0);
    expect(v1?.files ?? 0).toBe(0);
    expect(report.files.legacy).toBe(0);
    expect(report.plainTotal).toBe(0);
    expect(report.keys.find((k) => k.id === "v2")?.opens).toBe(true);

    // всё читается: поля — новым ключом, файлы — тоже, байт в байт
    const [me] = await db.select().from(users).where(eq(users.id, root.id));
    expect(me!.lastName.startsWith("enc1:v2:")).toBe(true);
    expect(decryptField(me!.lastName)).toBe("root");
    expect((await readFile(legacyPath)).subarray(0, 8).toString()).toBe("enc1:v2:");
    expect((await readAudio(legacyPath)).equals(audio)).toBe(true);
    expect((await readAudio(headedPath)).equals(audio)).toBe(true);

    // подписанная заметка перешифрована и осталась подписанной
    const [note] = await db.select().from(patientNotes).where(eq(patientNotes.id, signedNoteId));
    expect(note!.text.startsWith("enc1:v2:")).toBe(true);
    expect(decryptField(note!.text)).toBe("підписаний запис прийому");
    expect(note!.status).toBe("signed");

    // шаг журналирован: запуск — от человека, итог — от системы
    const actions = (
      await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(sql`${auditLog.resourceId} = ${job.id}`)
    ).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["sec.reencrypt_start", "sec.reencrypt_done"]));
  }, REENCRYPT_MS);

  test("служебный режим меняет у подписанной заметки только шифртекст", async () => {
    /*
     * Обход триггера для перешифровки нарочно узкий: статус, автор, время
     * подписи — прежний отказ, даже в служебном режиме. Удаление — тоже.
     */
    const attempt = (change: string) =>
      baseDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.maintenance', '1', true)`);
        await tx.execute(sql.raw(`${change} '${signedNoteId}'`));
      });
    await expect(attempt("update patient_notes set status = 'draft' where id =")).rejects.toThrow(/неизменяема/);
    await expect(attempt("delete from patient_notes where id =")).rejects.toThrow(/неизменяема/);
    // без служебного режима не проходит и правка текста
    await expect(
      (async () => {
        await db.execute(sql`update patient_notes set text = text where id = ${signedNoteId}`);
      })(),
    ).rejects.toThrow(/неизменяема/);
  });

  test("повторный проход ничего не трогает", async () => {
    const start = await post("/api/ops/sec/keys/reencrypt", root.token);
    expect(start.status).toBe(202);
    const job = await waitJob();
    expect(job.status).toBe("done");
    // просмотренное сверх нерасшифрованного — перешифрованное; его быть не должно
    expect(job.processed - job.skipped).toBe(0);
  }, REENCRYPT_MS);

  test("проход, чей процесс умер, показан оборванным и не держит запуск", async () => {
    const id = crypto.randomUUID();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await db.insert(securityJobs).values({
      id,
      kind: "reencrypt",
      status: "running",
      startedAt: new Date().toISOString(),
      heartbeatAt: stale,
      targetKey: "v2",
    });
    const { body } = await api<{ job: OpsReencryptJob }>("/api/ops/sec/keys/job", root.token);
    expect(body.job.id).toBe(id);
    expect(body.job.status).toBe("interrupted");
    await db.update(securityJobs).set({ status: "failed", finishedAt: stale }).where(eq(securityJobs.id, id));
  });
});

describe("ротация обратно: сюита снова на v1", () => {
  test("на выгруженном v2 не осталось ни значения, ни файла", async () => {
    // проверка самого возврата: соседние файлы тестов ждут «enc1:v1:»
    const report = await keys();
    expect(report.activeKey).toBe("v1");
    expect(report.keys.find((k) => k.id === "v2")?.values ?? 0).toBe(0);
    expect(report.keys.find((k) => k.id === "v2")?.files ?? 0).toBe(0);
  });
});

describe("телефоны: переиндексация", () => {
  test("один номер у двух учётных записей — индекс у старшей, дубль посчитан, не пятисотка", async () => {
    const phone = `+38050${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const older = await makeUser("user", `sec-ph-a-${crypto.randomUUID()}@test`, {
      phoneEnc: encryptField(phone),
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const younger = await makeUser("user", `sec-ph-b-${crypto.randomUUID()}@test`, { phoneEnc: encryptField(phone) });

    const res = await post("/api/ops/sec/keys/reindex-phones", root.token);
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toBeGreaterThanOrEqual(1);

    const index = async (id: string) =>
      (await db.select({ i: users.phoneIndex }).from(users).where(eq(users.id, id)))[0]?.i ?? null;
    expect(await index(older.id)).toBe(phoneFingerprint(normalizePhone(phone)!));
    expect(await index(younger.id)).toBeNull();
  });

  test("кнопка пересчитывает индекс и пишет в журнал", async () => {
    const res = await post("/api/ops/sec/keys/reindex-phones", root.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'sec.phone_reindex' and ${auditLog.actorId} = ${root.id}`)
      .limit(1);
    expect(row?.details?.total).toBe(res.body.total);
  });
});

/* ═══════════ Цілісність ═══════════ */

/** Выполнить fn в транзакции владельца и откатить: для «нарочно сломанного» */
async function inRolledBack<T>(fn: () => Promise<T>): Promise<T> {
  let out: T | undefined;
  await baseDb
    .transaction(async (tx) => {
      out = await dbContext.run(tx as never, fn);
      throw new Error("rollback");
    })
    .catch((e) => {
      if (String(e).includes("rollback")) return;
      throw e;
    });
  return out as T;
}

describe("целостность: политики строк", () => {
  test("кнопка: владелец базы назван обходом, таблицы и политики сосчитаны", async () => {
    const res = await post("/api/ops/sec/integrity/rls", root.token);
    expect(res.status).toBe(200);
    expect(res.body.bypasses).toBe(true);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBeTruthy();
    expect(res.body.tables).toBeGreaterThan(40);
    expect(res.body.policies).toBeGreaterThan(40);
    expect(res.body.policiesWithoutRls).toEqual([]);
    expect(res.body.rlsTables).toBeGreaterThan(0);

    const state = await api("/api/ops/sec/integrity", root.token);
    expect(state.body.rls.summary.role).toBe(res.body.role);
    expect(state.body.rls.actorEmail).toBe("root@test");
  });

  test("политика без включённого RLS и таблица с человеком без RLS — находятся", async () => {
    const report = await inRolledBack(async () => {
      await db.execute(sql`create table ops_sec_probe (id text primary key, user_id text)`);
      await db.execute(sql`create policy ops_sec_probe_p on ops_sec_probe using (true)`);
      return rlsReport();
    });
    expect(report.policiesWithoutRls).toContain("ops_sec_probe");
    expect(report.personTablesWithoutRls).toContain("ops_sec_probe");
    expect(report.ok).toBe(false);
  });

  test("под ролью приложения обхода нет и сетка цела", async () => {
    const out = await underAppRole<{ report: { bypasses: boolean; ok: boolean; policiesWithoutRls: string[]; auditWritable: boolean } }>(`
      const { rlsReport } = await import(${JSON.stringify(`${import.meta.dir}/../src/lib/integrity.ts`)});
      out.report = await rlsReport();
    `);
    expect(out.error).toBeUndefined();
    expect(out.rlsActive).toBe(true);
    expect(out.report?.bypasses).toBe(false);
    expect(out.report?.policiesWithoutRls).toEqual([]);
    expect(out.report?.ok).toBe(true);
  });
});

describe("целостность: цепочка журнала", () => {
  test("кнопка: цепочка цела, записи сосчитаны, голова названа", async () => {
    const res = await post("/api/ops/sec/integrity/audit", root.token);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checked).toBeGreaterThan(0);
    expect(res.body.headSeq).toBeGreaterThan(0);
    expect(res.body.headHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("правка задним числом находится с номером записи", async () => {
    const [target] = await db.execute<{ seq: number }>(
      sql`select seq from audit_log where seq is not null order by seq desc offset 3 limit 1`,
    );
    const seq = Number(target!.seq);
    const report = await inRolledBack(async () => {
      await db.execute(sql`alter table audit_log disable trigger audit_log_immutable`);
      await db.execute(sql`update audit_log set details = '{"подмена": true}'::jsonb where seq = ${seq}`);
      return verifyChain();
    });
    expect(report.ok).toBe(false);
    expect(report.brokenAtSeq).toBe(seq);
    expect(report.checked).toBe(seq - 1);

    // откат вернул всё как было: цепочка снова цела
    expect((await verifyChain()).ok).toBe(true);
  });

  test("по расписанию: раз в сутки, результат виден разделу", async () => {
    const now = new Date(Date.now() + 60_000);
    const first = await runScheduledAuditCheck(now);
    expect(first?.ok).toBe(true);
    // тот же день — не повторяется
    expect(await runScheduledAuditCheck(new Date(now.getTime() + 3600_000))).toBeNull();
    // через сутки — снова
    const next = await runScheduledAuditCheck(new Date(now.getTime() + 25 * 3600_000));
    expect(next?.ok).toBe(true);

    const state = await api("/api/ops/sec/integrity", root.token);
    expect(state.body.auditScheduled.trigger).toBe("schedule");
    expect(state.body.auditScheduled.ok).toBe(true);
    expect(state.body.scheduleHours).toBe(24);
  });

  test("разрыв: запись в журнал и признак «последняя проверка провалена»", async () => {
    const broken = { at: new Date(Date.now() + 26 * 3600_000).toISOString(), ok: false, checked: 41, legacy: 0, brokenAtSeq: 42, headSeq: null, headHash: null };
    await baseDb.transaction((tx) =>
      dbContext.run(tx as never, async () => {
        await recordCheck("audit_chain", "schedule", false, broken, null);
        await reportChainBroken(broken, "schedule");
      }),
    );
    const last = await lastAuditChainCheck();
    expect(last?.ok).toBe(false);
    expect(last?.summary.brokenAtSeq).toBe(42);

    const [row] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'sec.audit_chain_broken' and ${auditLog.resourceId} = '42'`)
      .limit(1);
    expect(row?.outcome).toBe("error");

    // убрать искусственный провал, чтобы раздел у соседних тестов не показывал его
    await db.delete(integrityChecks).where(eq(integrityChecks.at, broken.at));
  });
});
