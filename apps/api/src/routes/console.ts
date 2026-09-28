import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "../lib/audit";
import { serverText } from "@quizzy/shared";
import { forbidden, langOf, parseBody } from "../lib/http";
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
  const lang = langOf(c);
  const items = [];
  for (const cmd of COMMANDS) {
    items.push({
      name: cmd.name,
      usage: cmd.usage,
      // описание — на языке консоли (волна 13); в реестре команд лежит ключ
      summary: serverText(cmd.summary, lang),
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
  const lang = langOf(c);
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
    return c.json({ lines: [serverText("cmd.unknown", lang, { name }), serverText("cmd.typeHelp", lang)], ok: false });
  }

  /*
   * Право команды и права её формы (Command.forms) — то же, что требует
   * HTTP-двойник: `catalog install` ставит методики так же, как ручная
   * задача техпанели, и право у неё то же.
   */
  const needed = [...(cmd.permission ? [cmd.permission] : []), ...(cmd.forms?.[args[0] ?? ""] ?? [])];
  for (const permission of needed) {
    if (await hasPermission(user, permission)) continue;
    await audit(c, {
      action: "console.run",
      outcome: "denied",
      details: { command: cmd.name, permission },
    });
    forbidden("err.permissionRequired", { permission });
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
    const result = await cmd.run({ user, args, lang, c });
    return c.json({ lines: result.lines, ok: true });
  } catch (error) {
    if (error instanceof CommandError) {
      // фразу ошибки собираем здесь, на языке набравшего команду (см. CommandError)
      return c.json({ lines: [error.text(lang)], ok: false });
    }
    /*
     * Отказ общего сервиса (lib/accountClass.ts) уходит тем же ответом, что у
     * HTTP-двойника, — 403 с тем же текстом. Отказ откатывает транзакцию
     * запроса, а с ней и строку «вызов» выше; поэтому попытка пишется ещё
     * раз — отказом, который откат переживает (audit → durable).
     */
    if (error instanceof HTTPException && error.status === 403) {
      await audit(c, {
        action: "console.run",
        outcome: "denied",
        details: { command: cmd.name, args, reason: (error.cause as { key?: string } | undefined)?.key ?? null },
      });
    }
    throw error;
  }
});
