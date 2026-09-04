import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { adminA, api, db, makeUser, root } from "./fixtures";
import { auditLog, users } from "../src/db/schema";
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
