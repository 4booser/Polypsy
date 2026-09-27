import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import {
  renderCoded,
  serverText,
  type Lang,
  type Permission,
  type ServerTextKey,
  type TextParams,
  type User,
} from "@quizzy/shared";
import { db } from "../db";
import {
  alertCases,
  appointments,
  departments,
  responses,
  slots,
  surveys,
  users,
} from "../db/schema";
import { fullNameOf } from "./auth";
import { hasPermission } from "./permissions";
import { verifyChain } from "./auditVerify";
import { checkRls } from "./rlsGuard";
import { installCatalog } from "./catalogInstall";
import { CATALOG } from "../instruments/catalog";
import { t } from "@quizzy/shared";

/**
 * Командная консоль управления системой.
 *
 * Это НЕ оболочка. Разница здесь не стилистическая: настоящий shell в
 * веб-консоли означает выполнение произвольного кода на машине с
 * медицинскими данными и ключом шифрования — угнанная вкладка администратора
 * отдавала бы всю базу целиком, расшифрованной. Поэтому выполняются только
 * заведённые здесь команды, и добавить новую можно лишь выкатом.
 *
 * Второе свойство, ради которого консоль вообще допустима: **она не обходит
 * модель прав**. У каждой команды своё право, и оно то же самое, которым
 * закрыт соответствующий экран. Консоль — другой способ нажать ту же
 * кнопку, а не запасной вход мимо проверок. Право `console.use` открывает
 * саму консоль и не даёт ничего сверх того, что человеку уже положено:
 * администратор без `users.manage` увидит команду `user role` в списке и
 * получит отказ при попытке её выполнить.
 *
 * Третье: каждый вызов идёт в журнал (и, значит, в поток событий — см.
 * audit.ts). Команда, выполненная в консоли, ничем не отличается в журнале
 * от того же действия, сделанного мышью.
 */

export interface CommandContext {
  user: User;
  args: string[];
  /**
   * Язык вывода — язык запроса (волна 13). Консоль печатала по-русски при
   * любом языке интерфейса: вывод команд набирался здесь же, литералами.
   */
  lang: Lang;
}

export interface CommandResult {
  /** Строки вывода — консоль печатает их как есть */
  lines: string[];
  /** Изменяющая команда: маршрут пишет её в журнал под своим действием */
  mutating: boolean;
}

export interface Command {
  name: string;
  /** Как вызывать: `user role <email> <admin|user>` */
  usage: string;
  /** Ключ словаря сервера: описание команды переводится при отдаче списка */
  summary: ServerTextKey;
  /**
   * Право, без которого команда не выполняется.
   *
   * null — команда не требует ничего сверх `console.use`: она либо
   * рассказывает о самой консоли, либо показывает то, что человек и так о
   * себе знает.
   */
  permission: Permission | null;
  run: (ctx: CommandContext) => Promise<CommandResult>;
}

const ok = (lines: string[], mutating = false): CommandResult => ({ lines, mutating });

/**
 * Ошибка команды: сообщение печатается человеку, а не падает пятисоткой.
 *
 * Несёт ключ и подстановки, а не фразу: фразу собирает маршрут на языке
 * того, кто набрал команду (routes/console.ts) — так же, как отказы
 * сервера собирает один обработчик.
 */
export class CommandError extends Error {
  constructor(
    readonly key: ServerTextKey,
    readonly params?: TextParams,
  ) {
    super(key);
  }

  /** Сообщение на языке вывода; подстановка-ключ («как вызывать») переводится тем же языком */
  text(lang: Lang): string {
    return renderCoded({ code: this.key, params: this.params }, lang);
  }
}

const need = (args: string[], n: number, usage: ServerTextKey) => {
  if (args.length < n) throw new CommandError("cmd.needArgs", { usage });
};

/** Человек по адресу почты; отдельной функцией — её просят три команды */
async function findByEmail(email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (!row) throw new CommandError("cmd.notFound", { email });
  return row;
}

/**
 * Таблица «подпись: значение» с выровненной колонкой значений.
 *
 * Отступ считается по самой длинной подписи на языке вывода: прежде он был
 * набит пробелами руками под русские слова, и перевод съехал бы.
 */
function aligned(rows: [string, string | number][], gap: number): string[] {
  const width = Math.max(...rows.map(([label]) => label.length + 1)) + gap;
  return rows.map(([label, value]) => `${`${label}:`.padEnd(width)}${value}`);
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    usage: "help",
    summary: "cmd.help.summary",
    permission: null,
    run: async ({ user, lang }) => {
      const lines: string[] = [];
      for (const c of COMMANDS) {
        const allowed = c.permission === null || (await hasPermission(user, c.permission));
        // недоступные показываются, но помечены: список, скрывающий половину
        // себя, заставляет гадать, чего не хватает
        lines.push(`${allowed ? "  " : "× "}${c.usage.padEnd(34)} ${serverText(c.summary, lang)}`);
      }
      lines.push("");
      lines.push(serverText("cmd.help.legend", lang));
      return ok(lines);
    },
  },

  {
    name: "whoami",
    usage: "whoami",
    summary: "cmd.whoami.summary",
    permission: null,
    run: async ({ user, lang }) => {
      const granted: string[] = [];
      for (const c of COMMANDS) {
        if (c.permission && (await hasPermission(user, c.permission))) granted.push(c.permission);
      }
      return ok([
        `${fullNameOf(user as never)} <${user.email}>`,
        serverText("cmd.whoami.class", lang, { role: user.role }),
        serverText("cmd.whoami.perms", lang, {
          list: [...new Set(granted)].sort().join(", ") || serverText("cmd.none", lang),
        }),
      ]);
    },
  },

  {
    name: "stats",
    usage: "stats",
    summary: "cmd.stats.summary",
    permission: "analytics.read",
    run: async ({ lang }) => {
      const one = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
      const today = new Date().toISOString().slice(0, 10);

      const [people, staff, published, done, openCases, todayAppts] = await Promise.all([
        one(db.select({ n: count() }).from(users).where(eq(users.role, "user"))),
        one(db.select({ n: count() }).from(users).where(sql`${users.role} <> 'user'`)),
        one(db.select({ n: count() }).from(surveys).where(eq(surveys.status, "published"))),
        one(db.select({ n: count() }).from(responses).where(eq(responses.status, "completed"))),
        one(db.select({ n: count() }).from(alertCases).where(isNull(alertCases.acknowledgedAt))),
        one(
          db
            .select({ n: count() })
            .from(appointments)
            .innerJoin(slots, eq(slots.id, appointments.slotId))
            .where(and(gte(slots.startsAt, today), sql`${appointments.status} <> 'cancelled'`)),
        ),
      ]);

      return ok(
        aligned(
          [
            [serverText("cmd.stats.people", lang), people],
            [serverText("cmd.stats.staff", lang), staff],
            [serverText("cmd.stats.published", lang), published],
            [serverText("cmd.stats.responses", lang), done],
            [serverText("cmd.stats.openCases", lang), openCases],
            [serverText("cmd.stats.appointments", lang), todayAppts],
          ],
          2,
        ),
      );
    },
  },

  {
    name: "queue",
    usage: "queue",
    summary: "cmd.queue.summary",
    permission: "alerts.review",
    run: async ({ lang }) => {
      const rows = await db
        .select({ severity: alertCases.severity, openedAt: alertCases.openedAt })
        .from(alertCases)
        .where(isNull(alertCases.acknowledgedAt));
      if (!rows.length) return ok([serverText("cmd.queue.empty", lang)]);

      const severe = rows.filter((r) => r.severity === "severe").length;
      const oldest = rows
        .map((r) => new Date(r.openedAt).getTime())
        .reduce((a, b) => Math.min(a, b), Date.now());
      const hours = Math.round((Date.now() - oldest) / 3600_000);
      return ok(
        aligned(
          [
            [serverText("cmd.queue.total", lang), rows.length],
            [serverText("cmd.queue.severe", lang), severe],
            [serverText("cmd.queue.oldest", lang), serverText("cmd.hours", lang, { n: hours })],
          ],
          3,
        ),
      );
    },
  },

  {
    name: "rls",
    usage: "rls check",
    summary: "cmd.rls.summary",
    permission: "audit.read",
    run: async ({ args, lang }) => {
      if (args[0] !== "check") throw new CommandError("cmd.onlyForm", { form: "rls check" });
      const report = await checkRls();
      /*
       * Именно эту проверку хочется иметь под рукой: подключение владельцем
       * базы обходит все политики, при этом всё работает и все экраны
       * рисуются. Отличить это от исправной работы нельзя ничем, кроме
       * такой проверки.
       */
      return ok(
        report.bypasses
          ? [
              serverText("cmd.rls.bypass", lang),
              serverText("cmd.rls.role", lang, { role: report.role }),
              serverText("cmd.rls.reason", lang, { reason: report.reason ?? serverText("cmd.rls.unknownReason", lang) }),
              serverText("cmd.rls.owned", lang, { n: report.ownedWithRls }),
            ]
          : [serverText("cmd.rls.ok", lang, { role: report.role })],
      );
    },
  },

  {
    name: "audit",
    usage: "audit verify",
    summary: "cmd.audit.summary",
    permission: "audit.read",
    run: async ({ args, lang }) => {
      if (args[0] !== "verify") throw new CommandError("cmd.onlyForm", { form: "audit verify" });
      const result = await verifyChain();
      return ok(
        result.ok
          ? [
              serverText("cmd.audit.ok", lang, { n: result.checked }),
              serverText("cmd.audit.head", lang, { hash: result.headHash ?? "—" }),
            ]
          : [
              serverText("cmd.audit.broken", lang, { seq: result.brokenAtSeq ?? "?" }),
              serverText("cmd.audit.checked", lang, { n: result.checked }),
            ],
      );
    },
  },

  {
    name: "catalog",
    usage: "catalog list|install",
    summary: "cmd.catalog.summary",
    permission: "surveys.edit",
    run: async ({ args, lang }) => {
      if (args[0] === "list") {
        const rows = await db.select().from(surveys).where(sql`${surveys.catalogKey} is not null`);
        const installed = new Set(rows.map((r) => r.catalogKey));
        return ok(
          CATALOG.map(
            // название методики — на языке вывода, как её назовёт и каталог на экране
            (e) => `${installed.has(e.key) ? "✓" : "·"} ${e.key.padEnd(10)} ${t(e.draft.title as never, lang)}`,
          ),
        );
      }
      if (args[0] === "install") {
        const report = await installCatalog();
        return ok(
          [
            serverText(report.departmentCreated ? "cmd.catalog.deptCreated" : "cmd.catalog.deptExisted", lang),
            report.installed.length
              ? serverText("cmd.catalog.installed", lang, { list: report.installed.join(", ") })
              : serverText("cmd.catalog.nothingNew", lang),
            report.skipped.length ? serverText("cmd.catalog.skipped", lang, { list: report.skipped.join(", ") }) : "",
          ].filter(Boolean),
          true,
        );
      }
      throw new CommandError("cmd.forms", { forms: "catalog list, catalog install" });
    },
  },

  {
    name: "dept",
    usage: "dept list",
    summary: "cmd.dept.summary",
    permission: "departments.manage",
    run: async ({ args, lang }) => {
      if (args[0] && args[0] !== "list") throw new CommandError("cmd.onlyForm", { form: "dept list" });
      const rows = await db.select().from(departments);
      if (!rows.length) return ok([serverText("cmd.dept.none", lang)]);
      return ok(
        rows.map(
          (d) =>
            `${d.archivedAt ? "×" : " "} ${t(d.title as never, lang).padEnd(32)} ${d.timezone}`,
        ),
      );
    },
  },

  {
    name: "user",
    usage: "user find|role|readonly …",
    summary: "cmd.user.summary",
    permission: "users.manage",
    run: async ({ args, lang }) => {
      const [sub, ...rest] = args;

      if (sub === "find") {
        need(rest, 1, "cmd.usage.userFind");
        const needle = rest[0]!.toLowerCase();
        /*
         * Ищем ТОЛЬКО по почте. Поиск по фамилии выглядел бы удобнее, но
         * ФИО хранится зашифрованным, и чтобы искать по нему, консоли
         * пришлось бы расшифровывать всех подряд. Слепой индекс есть у
         * телефона и заведён под уникальность, а не под подстроку.
         */
        const rows = await db
          .select()
          .from(users)
          .where(sql`${users.email} like ${`%${needle}%`}`)
          .limit(20);
        if (!rows.length) return ok([serverText("cmd.user.nobody", lang)]);
        const readOnly = serverText("cmd.user.readOnly", lang);
        return ok(rows.map((u) => `${u.email.padEnd(36)} ${u.role.padEnd(11)} ${u.readOnly ? readOnly : ""}`));
      }

      if (sub === "role") {
        need(rest, 2, "cmd.usage.userRole");
        const [email, role] = rest as [string, string];
        if (!["superadmin", "admin", "user"].includes(role)) {
          throw new CommandError("cmd.user.roleValues");
        }
        const target = await findByEmail(email);
        await db.update(users).set({ role: role as never }).where(eq(users.id, target.id));
        return ok([`${target.email}: ${target.role} → ${role}`], true);
      }

      if (sub === "readonly") {
        need(rest, 2, "cmd.usage.userReadonly");
        const [email, mode] = rest as [string, string];
        if (mode !== "on" && mode !== "off") throw new CommandError("cmd.user.onOff");
        const target = await findByEmail(email);
        await db.update(users).set({ readOnly: mode === "on" }).where(eq(users.id, target.id));
        return ok(
          [serverText(mode === "on" ? "cmd.user.writeBlocked" : "cmd.user.writeAllowed", lang, { email: target.email })],
          true,
        );
      }

      throw new CommandError("cmd.forms", { forms: "user find, user role, user readonly" });
    },
  },
];

export const COMMAND_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/**
 * Разбор строки на команду и аргументы.
 *
 * Кавычки поддерживаются: названия отделений бывают из нескольких слов, и
 * без них аргумент молча обрезался бы по первому пробелу.
 */
export function parseLine(line: string): { name: string; args: string[] } {
  const tokens = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = tokens.map((tok) =>
    (tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))
      ? tok.slice(1, -1)
      : tok,
  );
  return { name: (clean[0] ?? "").toLowerCase(), args: clean.slice(1) };
}
