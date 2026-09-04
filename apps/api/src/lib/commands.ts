import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import type { Permission, User } from "@quizzy/shared";
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
  summary: string;
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

/** Ошибка команды: сообщение печатается человеку, а не падает пятисоткой */
export class CommandError extends Error {}

const need = (args: string[], n: number, usage: string) => {
  if (args.length < n) throw new CommandError(`нужно больше аргументов: ${usage}`);
};

/** Человек по адресу почты; отдельной функцией — её просят три команды */
async function findByEmail(email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (!row) throw new CommandError(`не найден: ${email}`);
  return row;
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    usage: "help",
    summary: "Список команд",
    permission: null,
    run: async ({ user }) => {
      const lines: string[] = [];
      for (const c of COMMANDS) {
        const allowed = c.permission === null || (await hasPermission(user, c.permission));
        // недоступные показываются, но помечены: список, скрывающий половину
        // себя, заставляет гадать, чего не хватает
        lines.push(`${allowed ? "  " : "× "}${c.usage.padEnd(34)} ${c.summary}`);
      }
      lines.push("");
      lines.push("× — команда есть, но у вас нет права на неё");
      return ok(lines);
    },
  },

  {
    name: "whoami",
    usage: "whoami",
    summary: "Кто вы и что вам можно",
    permission: null,
    run: async ({ user }) => {
      const granted: string[] = [];
      for (const c of COMMANDS) {
        if (c.permission && (await hasPermission(user, c.permission))) granted.push(c.permission);
      }
      return ok([
        `${fullNameOf(user as never)} <${user.email}>`,
        `класс учётной записи: ${user.role}`,
        `права на команды: ${[...new Set(granted)].sort().join(", ") || "нет"}`,
      ]);
    },
  },

  {
    name: "stats",
    usage: "stats",
    summary: "Состояние системы в числах",
    permission: "analytics.read",
    run: async () => {
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

      return ok([
        `обследуемых:        ${people}`,
        `сотрудников:        ${staff}`,
        `методик (опубл.):   ${published}`,
        `прохождений:        ${done}`,
        `случаев в разборе:  ${openCases}`,
        `приёмов с сегодня:  ${todayAppts}`,
      ]);
    },
  },

  {
    name: "queue",
    usage: "queue",
    summary: "Очередь разбора: сколько и как давно висит",
    permission: "alerts.review",
    run: async () => {
      const rows = await db
        .select({ severity: alertCases.severity, openedAt: alertCases.openedAt })
        .from(alertCases)
        .where(isNull(alertCases.acknowledgedAt));
      if (!rows.length) return ok(["очередь пуста"]);

      const severe = rows.filter((r) => r.severity === "severe").length;
      const oldest = rows
        .map((r) => new Date(r.openedAt).getTime())
        .reduce((a, b) => Math.min(a, b), Date.now());
      const hours = Math.round((Date.now() - oldest) / 3600_000);
      return ok([
        `всего:            ${rows.length}`,
        `из них тяжёлых:   ${severe}`,
        `самый давний:     ${hours} ч`,
      ]);
    },
  },

  {
    name: "rls",
    usage: "rls check",
    summary: "Действуют ли политики строк на этом подключении",
    permission: "audit.read",
    run: async ({ args }) => {
      if (args[0] !== "check") throw new CommandError("единственная форма: rls check");
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
              "ПОЛИТИКИ НЕ ДЕЙСТВУЮТ на этом подключении",
              `роль: ${report.role}`,
              `причина: ${report.reason ?? "неизвестна"}`,
              `таблиц с включённой RLS во владении: ${report.ownedWithRls}`,
            ]
          : [`политики строк действуют; роль: ${report.role}`],
      );
    },
  },

  {
    name: "audit",
    usage: "audit verify",
    summary: "Сверить хеш-цепочку журнала",
    permission: "audit.read",
    run: async ({ args }) => {
      if (args[0] !== "verify") throw new CommandError("единственная форма: audit verify");
      const result = await verifyChain();
      return ok(
        result.ok
          ? [`цепочка цела, записей: ${result.checked}`, `головной хэш: ${result.headHash ?? "—"}`]
          : [`ЦЕПОЧКА НАРУШЕНА на записи ${result.brokenAtSeq ?? "?"}`, `проверено: ${result.checked}`],
      );
    },
  },

  {
    name: "catalog",
    usage: "catalog list|install",
    summary: "Общий каталог методик",
    permission: "surveys.edit",
    run: async ({ args }) => {
      if (args[0] === "list") {
        const rows = await db.select().from(surveys).where(sql`${surveys.catalogKey} is not null`);
        const installed = new Set(rows.map((r) => r.catalogKey));
        return ok(
          CATALOG.map(
            (e) => `${installed.has(e.key) ? "✓" : "·"} ${e.key.padEnd(10)} ${t(e.draft.title as never, "uk")}`,
          ),
        );
      }
      if (args[0] === "install") {
        const report = await installCatalog();
        return ok(
          [
            report.departmentCreated ? "отделение заведено" : "отделение уже было",
            report.installed.length ? `поставлено: ${report.installed.join(", ")}` : "новых методик нет",
            report.skipped.length ? `уже стояли: ${report.skipped.join(", ")}` : "",
          ].filter(Boolean),
          true,
        );
      }
      throw new CommandError("формы: catalog list, catalog install");
    },
  },

  {
    name: "dept",
    usage: "dept list",
    summary: "Отделения",
    permission: "departments.manage",
    run: async ({ args }) => {
      if (args[0] && args[0] !== "list") throw new CommandError("единственная форма: dept list");
      const rows = await db.select().from(departments);
      if (!rows.length) return ok(["отделений нет"]);
      return ok(
        rows.map(
          (d) =>
            `${d.archivedAt ? "×" : " "} ${t(d.title as never, "uk").padEnd(32)} ${d.timezone}`,
        ),
      );
    },
  },

  {
    name: "user",
    usage: "user find|role|readonly …",
    summary: "Учётные записи: найти, сменить класс, запретить запись",
    permission: "users.manage",
    run: async ({ args }) => {
      const [sub, ...rest] = args;

      if (sub === "find") {
        need(rest, 1, "user find <часть почты>");
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
        if (!rows.length) return ok(["никого"]);
        return ok(
          rows.map((u) => `${u.email.padEnd(36)} ${u.role.padEnd(11)} ${u.readOnly ? "только чтение" : ""}`),
        );
      }

      if (sub === "role") {
        need(rest, 2, "user role <почта> <superadmin|admin|user>");
        const [email, role] = rest as [string, string];
        if (!["superadmin", "admin", "user"].includes(role)) {
          throw new CommandError("класс: superadmin, admin или user");
        }
        const target = await findByEmail(email);
        await db.update(users).set({ role: role as never }).where(eq(users.id, target.id));
        return ok([`${target.email}: ${target.role} → ${role}`], true);
      }

      if (sub === "readonly") {
        need(rest, 2, "user readonly <почта> <on|off>");
        const [email, mode] = rest as [string, string];
        if (mode !== "on" && mode !== "off") throw new CommandError("значение: on или off");
        const target = await findByEmail(email);
        await db.update(users).set({ readOnly: mode === "on" }).where(eq(users.id, target.id));
        return ok([`${target.email}: запись ${mode === "on" ? "запрещена" : "разрешена"}`], true);
      }

      throw new CommandError("формы: user find, user role, user readonly");
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
