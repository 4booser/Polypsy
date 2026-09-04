import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../lib/audit";
import { forbidden, parseBody } from "../lib/http";
import { hasPermission } from "../lib/permissions";
import { COMMANDS, COMMAND_BY_NAME, CommandError, parseLine } from "../lib/commands";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Командная консоль.
 *
 * Выглядит и работает как терминал, но оболочкой не является: выполняются
 * только команды из реестра (см. lib/commands.ts). Настоящий shell здесь
 * означал бы выполнение произвольного кода на машине с медицинскими данными
 * и ключом шифрования — угнанная вкладка администратора отдавала бы всю
 * базу расшифрованной.
 *
 * Право `console.use` открывает саму консоль и НЕ даёт ничего сверх того,
 * что человеку уже положено: у каждой команды своё право, то же самое,
 * которым закрыт соответствующий экран. Иначе консоль стала бы запасным
 * входом мимо модели прав, и разбирать пришлось бы две модели вместо одной.
 */
export const consoleRoutes = new Hono<AppEnv>();

consoleRoutes.use("*", requireAuth, requireStaff, requirePermission("console.use"));

/** Список команд — для подсказки и дополнения по Tab на клиенте */
consoleRoutes.get("/commands", async (c) => {
  const user = c.get("user");
  const items = [];
  for (const cmd of COMMANDS) {
    items.push({
      name: cmd.name,
      usage: cmd.usage,
      summary: cmd.summary,
      permission: cmd.permission,
      // недоступные не прячем: список, скрывающий половину себя, заставляет
      // гадать, чего не хватает, вместо того чтобы это назвать
      allowed: cmd.permission === null || (await hasPermission(user, cmd.permission)),
    });
  }
  return c.json({ items });
});

consoleRoutes.post("/run", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, z.object({ line: z.string().min(1).max(500) }));
  const { name, args } = parseLine(input.line);

  const cmd = COMMAND_BY_NAME.get(name);
  if (!cmd) {
    /*
     * Неизвестная команда — не ошибка сервера и не отказ доступа. Печатаем
     * подсказку так же, как её напечатал бы терминал, и пишем в журнал:
     * подбор команд перебором должен быть виден.
     */
    await audit(c, {
      action: "console.run",
      outcome: "denied",
      details: { command: name, known: false },
    });
    return c.json({ lines: [`нет такой команды: ${name}`, "наберите help"], ok: false });
  }

  if (cmd.permission && !(await hasPermission(user, cmd.permission))) {
    await audit(c, {
      action: "console.run",
      outcome: "denied",
      details: { command: cmd.name, permission: cmd.permission },
    });
    forbidden("err.permissionRequired", { permission: cmd.permission });
  }

  /*
   * Запись в журнал ДО выполнения, а не после.
   *
   * Команда может не дойти до конца — упасть, зависнуть, оборвать
   * соединение, — и именно такие попытки интереснее всего при разборе.
   * Журнал, в который попадают только успешные вызовы, отвечает на вопрос
   * «что получилось», тогда как спрашивают обычно «что пытались сделать».
   *
   * В подробности идёт разобранная команда с аргументами, а не сырая
   * строка: так в журнале не окажется того, что человек напечатал и стёр,
   * а разбор по имени команды остаётся возможным.
   */
  await audit(c, {
    action: "console.run",
    details: { command: cmd.name, args },
  });

  try {
    const result = await cmd.run({ user, args });
    return c.json({ lines: result.lines, ok: true });
  } catch (error) {
    if (error instanceof CommandError) {
      return c.json({ lines: [error.message], ok: false });
    }
    throw error;
  }
});
