import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { Permission } from "@quizzy/shared";
import { adminA, adminB, api, db, makeUser, root, surveyInA } from "./fixtures";
import { alertCases, auditLog, permissionExceptions, users } from "../src/db/schema";
import { COMMANDS, parseLine } from "../src/lib/commands";

/**
 * Командная консоль.
 *
 * Проверяется ровно то, ради чего консоль вообще допустима в системе с
 * медицинскими данными: она не выполняет ничего, кроме заведённых команд, и
 * не обходит модель прав. Всё остальное в ней — удобство.
 */

describe("разбор строки", () => {
  test("аргумент в кавычках не режется по пробелу", () => {
    // названия отделений бывают из нескольких слов
    expect(parseLine('dept add "Психологічне відділення"')).toEqual({
      name: "dept",
      args: ["add", "Психологічне відділення"],
    });
  });

  test("имя команды не зависит от регистра", () => {
    expect(parseLine("HELP").name).toBe("help");
  });
});

describe("границы консоли", () => {
  test("произвольная строка командой не становится", async () => {
    /*
     * Главная граница: консоль не оболочка. Строка, похожая на команду
     * оболочки, должна упереться в реестр, а не во что-нибудь ещё.
     */
    for (const line of ["ls -la", "rm -rf /", "psql", "bun run seed", "select * from users"]) {
      const res = await api("/api/console/run", root.token, {
        method: "POST",
        body: JSON.stringify({ line }),
        // вывод консоли — на языке запроса (волна 13); проверка ниже читает русский
        headers: { "Accept-Language": "ru" },
      });
      expect(res.status, `«${line}» не отвергнута реестром`).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.lines.join(" ")).toContain("нет такой команды");
    }
  });

  test("каждая команда объявляет право или обходится без него осознанно", () => {
    /*
     * Поле обязательное по типам, но `null` в нём поставить легко и
     * незаметно. Осмысленных команд без права ровно две — те, что
     * рассказывают о самой консоли и о самом спрашивающем; всё, что
     * касается данных, обязано быть закрыто.
     */
    const free = COMMANDS.filter((c) => c.permission === null).map((c) => c.name);
    expect(free.sort(), "появилась команда без права — проверьте, точно ли ей нечего защищать").toEqual([
      "help",
      "whoami",
    ]);
  });
});

describe("права", () => {
  test("без права на команду она не выполняется, хотя консоль открыта", async () => {
    /*
     * Ровно то, ради чего у каждой команды своё право: консоль — другой
     * способ нажать ту же кнопку, а не запасной вход мимо проверок. Если бы
     * `console.use` открывало все команды разом, оно стало бы правом «всё»
     * под безобидным названием.
     */
    const email = `console-target-${crypto.randomUUID()}@test`;
    const target = await makeUser("user", email);

    // у обычного администратора группы нет права users.manage
    const denied = await api("/api/console/run", adminA.token, {
      method: "POST",
      body: JSON.stringify({ line: `user role ${email} admin` }),
    });
    expect([403, 401]).toContain(denied.status);

    const [after] = await db.select().from(users).where(eq(users.id, target.id));
    expect(after!.role, "команда без права всё-таки изменила класс учётной записи").toBe("user");
  });

  test("с правом команда выполняется", async () => {
    const email = `console-ok-${crypto.randomUUID()}@test`;
    const target = await makeUser("user", email);
    const res = await api<{ ok: boolean; lines: string[] }>("/api/console/run", root.token, {
      method: "POST",
      body: JSON.stringify({ line: `user role ${email} admin` }),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok, res.body.lines.join(" ")).toBe(true);

    const [after] = await db.select().from(users).where(eq(users.id, target.id));
    expect(after!.role).toBe("admin");
  });

  test("список команд помечает недоступные, а не прячет их", async () => {
    const res = await api<{ items: { name: string; allowed: boolean }[] }>(
      "/api/console/commands",
      adminA.token,
    );
    expect(res.status).toBe(200);
    const byName = new Map(res.body.items.map((i) => [i.name, i]));
    expect(byName.size).toBe(COMMANDS.length);
    expect(byName.get("help")!.allowed).toBe(true);
  });
});

describe("журнал", () => {
  test("вызов записывается до выполнения, включая отклонённый", async () => {
    /*
     * Команда может не дойти до конца — упасть, зависнуть, оборвать
     * соединение, — и именно такие попытки интереснее всего при разборе.
     * Журнал только успешных вызовов отвечает на вопрос «что получилось»,
     * тогда как спрашивают обычно «что пытались сделать».
     */
    const marker = `нетакой-${crypto.randomUUID().slice(0, 8)}`;
    await api("/api/console/run", root.token, {
      method: "POST",
      body: JSON.stringify({ line: marker }),
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "console.run"));
    const mine = rows.find((r) => JSON.stringify(r.details ?? {}).includes(marker));
    expect(mine, "неизвестная команда нигде не записана — подбор перебором был бы не виден").toBeDefined();
    expect(mine!.outcome).toBe("denied");
  });

  test("отказ по праву тоже записывается", async () => {
    const email = `console-den-${crypto.randomUUID()}@test`;
    await makeUser("user", email);
    await api("/api/console/run", adminA.token, {
      method: "POST",
      body: JSON.stringify({ line: `user role ${email} admin` }),
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "console.run"));
    const denied = rows.filter((r) => r.outcome === "denied");
    expect(
      denied.some((r) => JSON.stringify(r.details ?? {}).includes("users.manage")),
      "отказ по праву не записан — попытки расширить свои возможности не видны",
    ).toBe(true);
  });
});

describe("каждая команда — через проверку своего HTTP-двойника (волна 15)", () => {
  /*
   * Внешний разбор 2026-09-27, п. 1: `user role` обходил правила смены
   * класса, записанные в маршруте. Тот же вопрос задан каждой команде —
   * «чего требует её HTTP-двойник» — и где консоль требовала меньше, она
   * требует теперь то же (таблица — в отчёте волны 15):
   *   stats         — обзор техпанели, ops.read (числа по системе целиком);
   *   rls check     — проверка политик в обзоре техпанели, ops.read;
   *   catalog install — ручная задача техпанели, ops.read + ops.manage;
   *   queue         — очередь случаев, alerts.review и зона lib/scope.ts.
   * Смена класса и «только чтение» — в accountClass.test.ts.
   */
  const run = (token: string, line: string) =>
    api<{ ok: boolean; lines: string[]; error?: string }>("/api/console/run", token, {
      method: "POST",
      body: JSON.stringify({ line }),
      headers: { "Accept-Language": "ru" },
    });

  /** Сотрудник-«психолог» (есть console.use, analytics.read, surveys.edit) с добавленными правами */
  async function staffWith(perms: Permission[]) {
    const person = await makeUser("admin", `console-twin-${crypto.randomUUID()}@test`);
    for (const permission of perms) {
      await db.insert(permissionExceptions).values({
        id: crypto.randomUUID(),
        userId: person.id,
        permission,
        mode: "grant",
        reason: "Проверка консоли",
        grantedBy: root.id,
      });
    }
    return person;
  }

  test("stats — числа по системе целиком, поэтому право обзора техпанели, а не аналитики", async () => {
    // analytics.read у «психолога» есть: прежде его хватало
    const analyst = await staffWith([]);
    const denied = await run(analyst.token, "stats");
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("ops.read");

    const ops = await staffWith(["ops.read"]);
    const allowed = await run(ops.token, "stats");
    expect(allowed.body.ok, allowed.body.lines?.join(" ")).toBe(true);
  });

  test("rls check — право обзора техпанели, а не журнала", async () => {
    const auditor = await staffWith(["audit.read"]);
    expect((await run(auditor.token, "rls check")).status).toBe(403);
    const ops = await staffWith(["ops.read"]);
    expect((await run(ops.token, "rls check")).body.ok).toBe(true);
  });

  test("catalog install — то же право, что у ручной задачи техпанели; catalog list — прежнее", async () => {
    // surveys.edit у «психолога» есть — на просмотр каталога его хватает
    const editor = await staffWith([]);
    expect((await run(editor.token, "catalog list")).body.ok).toBe(true);

    const install = await run(editor.token, "catalog install");
    expect(install.status).toBe(403);
    expect(install.body.error).toContain("ops.");

    const onlyRead = await staffWith(["ops.read"]);
    const half = await run(onlyRead.token, "catalog install");
    expect(half.status).toBe(403);
    expect(half.body.error).toContain("ops.manage");
  });

  describe("queue — только своя зона, как очередь на экране", () => {
    const made: string[] = [];
    afterAll(async () => {
      // живых случаев в общей очереди не оставляем
      if (made.length) await db.delete(alertCases).where(inArray(alertCases.id, made));
    });

    const total = async (token: string): Promise<number> => {
      const res = await run(token, "queue");
      expect(res.body.ok, res.body.lines?.join(" ")).toBe(true);
      const line = res.body.lines.find((l) => l.startsWith("всего"));
      return line ? Number(line.replace(/\D+/g, "")) : 0;
    };

    test("случай методики группы А не виден в счётчике заведующего группы Б", async () => {
      const beforeA = await total(adminA.token);
      const beforeB = await total(adminB.token);

      const person = await makeUser("user", `console-q-${crypto.randomUUID()}@test`);
      const id = crypto.randomUUID();
      await db.insert(alertCases).values({ id, userId: person.id, surveyId: surveyInA, severity: "severe" });
      made.push(id);

      expect(await total(adminA.token)).toBe(beforeA + 1);
      expect(await total(adminB.token), "консоль показала чужой зоне случай группы А").toBe(beforeB);
    });
  });
});
