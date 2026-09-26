import { z } from "zod";
import {
  canAssignRole,
  roleRank,
  type BulkSkipReason,
  type BulkUserAction,
  type ImportRow,
  type ImportRowError,
  type Permission,
  type Role,
  type WhoViewedActor,
} from "@quizzy/shared";
import { localClock } from "./suspicious";

/**
 * Люди в техпанели — чистая логика массовых действий, импорта и отчёта
 * «хто переглядав» (участок people2).
 *
 * Здесь нет базы, и это нарочно. Правила «кого можно трогать» проверяются на
 * каждой строке пачки ровно так же, как на одиночном действии, — а значит,
 * должны проверяться тестом без HTTP, строка за строкой. Разбор CSV — тоже:
 * «почему строка 17 с ошибкой» должно отвечаться функцией, а не походом в
 * базу.
 */

/* ═══════════ массовые действия ═══════════ */

export interface BulkActor {
  id: string;
  role: Role;
  /** Ступень лестницы; суперадмин — SUPERADMIN_RANK */
  rank: number;
  perms: ReadonlySet<Permission>;
}

export interface BulkTarget {
  id: string;
  role: Role;
  disabledAt: string | null;
  /** Коды ролей-шаблонов, которые у человека уже есть */
  roleCodes: readonly string[];
}

export interface BulkRole {
  id: string;
  code: string;
  permissions: readonly string[];
}

/**
 * Пропустить ли строку пачки — и почему.
 *
 * Правила — те же, что у одиночных действий, и в том же порядке причин:
 *
 *  • выключить — не себя (routes/opsAccounts.ts, err.cannotDisableSelf), над
 *    суперадмином — только суперадмин, уже выключенную — пропустить;
 *  • включить — над суперадмином только суперадмин, невыключенную пропустить;
 *  • завершить сессии — над суперадмином только суперадмин; свои — нет:
 *    одиночное действие это позволяет, но в пачке «вибрати всіх» задевает и
 *    себя, и человек, нажавший «завершити сесії» на отделении, выкинул бы из
 *    консоли сам себя посреди работы;
 *  • назначить роль-шаблон — правила routes/permissions.ts (PUT
 *    /users/:id/roles) для добавленной роли: пациенту ролей персонала не
 *    дают, суперадмину они ничего не решают, для не-суперадмина — только
 *    ступень лестницы, строго ниже своей и без прав сверх собственных.
 *
 * «Последний суперадмин» здесь не проверяется: это состояние базы, которое
 * меняется по ходу пачки (выключили одного — второй стал последним), и
 * решает его маршрут под замком (lib/accounts.ts, otherActiveSuperadmins).
 */
export function bulkSkip(
  action: BulkUserAction,
  actor: BulkActor,
  target: BulkTarget | null,
  role?: BulkRole | null,
): BulkSkipReason | null {
  if (!target) return "notFound";
  const isSuper = actor.role === "superadmin";
  const locked = target.role === "superadmin" && !isSuper;
  switch (action) {
    case "disable":
      if (target.id === actor.id) return "self";
      if (locked) return "superadminOnly";
      if (target.disabledAt) return "alreadyDisabled";
      return null;
    case "enable":
      if (locked) return "superadminOnly";
      if (!target.disabledAt) return "notDisabled";
      return null;
    case "revoke-sessions":
      if (target.id === actor.id) return "self";
      if (locked) return "superadminOnly";
      return null;
    case "assign-role": {
      if (!role) return "notFound";
      if (target.id === actor.id) return "self";
      if (target.role === "user") return "patient";
      if (target.role === "superadmin") return isSuper ? "superadminTarget" : "superadminOnly";
      if (target.roleCodes.includes(role.code)) return "alreadyHasRole";
      if (!isSuper) {
        if (roleRank(role.code) === 0) return "roleNotInChain";
        if (!canAssignRole(actor.rank, role.code)) return "roleAboveYours";
        if (role.permissions.some((p) => !actor.perms.has(p as Permission))) return "roleGrantsMore";
      }
      return null;
    }
  }
}

/* ═══════════ импорт сотрудников из CSV ═══════════ */

/**
 * Разбор CSV (RFC 4180): кавычки, удвоенные кавычки, переводы строк внутри
 * кавычек. Разделитель — запятая, точка с запятой или табуляция: Excel с
 * украинской локалью сохраняет «CSV» через точку с запятой, и файл, который
 * человек только что выгрузил из таблицы, должен читаться, а не давать одну
 * колонку на всё.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  /* пустые строки (хвост файла, пропуски) — не строки данных */
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function detectDelimiter(line: string): string {
  const counts = [",", ";", "\t"].map((d) => ({ d, n: line.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 0 ? counts[0]!.d : ",";
}

export type ImportField = "lastName" | "firstName" | "middleName" | "email" | "role" | "roleTemplate" | "position" | "unit";

/** Колонки шаблона — в этом порядке их выгружает экран («Шаблон CSV») */
export const IMPORT_COLUMNS: readonly { field: ImportField; header: string; required: boolean }[] = [
  { field: "lastName", header: "last_name", required: true },
  { field: "firstName", header: "first_name", required: true },
  { field: "middleName", header: "middle_name", required: false },
  { field: "email", header: "email", required: true },
  { field: "role", header: "role", required: false },
  { field: "roleTemplate", header: "role_template", required: false },
  { field: "position", header: "position", required: false },
  { field: "unit", header: "unit", required: false },
];

/*
 * Заголовки по-людски тоже понимаются: таблицу отдела кадров не
 * переименовывают в last_name ради импорта. Сравнение — без регистра,
 * пробелов, дефисов и подчёркиваний, апостроф любого вида.
 */
const HEADER_ALIASES: Record<string, ImportField> = {
  lastname: "lastName",
  surname: "lastName",
  прізвище: "lastName",
  фамилия: "lastName",
  firstname: "firstName",
  "ім'я": "firstName",
  імя: "firstName",
  имя: "firstName",
  middlename: "middleName",
  patronymic: "middleName",
  побатькові: "middleName",
  отчество: "middleName",
  email: "email",
  пошта: "email",
  почта: "email",
  логін: "email",
  логин: "email",
  login: "email",
  role: "role",
  роль: "role",
  roletemplate: "roleTemplate",
  рольшаблон: "roleTemplate",
  шаблонролі: "roleTemplate",
  шаблонроли: "roleTemplate",
  position: "position",
  посада: "position",
  должность: "position",
  unit: "unit",
  підрозділ: "unit",
  подразделение: "unit",
};

export function headerField(raw: string): ImportField | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/[\s_-]/g, "");
  return HEADER_ALIASES[key] ?? null;
}

/**
 * Роль из ячейки. Импорт — для персонала: пусто — «адміністратор» (обычный
 * сотрудник консоли), суперадмин — словом. Пациентов так не заводят: у них
 * своя дверь (приглашение, регистрация), и роль «пацієнт» в файле
 * сотрудников — скорее ошибка столбца, чем намерение.
 */
export function roleFrom(raw: string): Role | "patient" | null {
  const v = raw.trim().toLowerCase();
  if (!v || ["admin", "адмін", "адміністратор", "админ", "администратор", "staff", "співробітник", "сотрудник"].includes(v)) {
    return "admin";
  }
  if (["superadmin", "суперадмін", "суперадміністратор", "суперадмин", "суперадминистратор"].includes(v)) return "superadmin";
  if (["user", "patient", "пацієнт", "пациент"].includes(v)) return "patient";
  return null;
}

const emailSchema = z.string().email();

export interface ImportContext {
  /** Почты, которые уже заняты в системе, — в нижнем регистре */
  takenEmails: ReadonlySet<string>;
  /** Коды ролей-шаблонов: есть ли такая и вправе ли импортирующий её выдать */
  templates: ReadonlyMap<string, { allowed: boolean }>;
  actorIsSuper: boolean;
}

/**
 * Разобрать файл и проверить каждую строку.
 *
 * Ошибки — по строкам, списком кодов, а не первой попавшейся: человек
 * исправляет файл за один заход, а не по одной ошибке за загрузку.
 * Дубликат почты внутри файла — ошибка у второй и дальше строк: первая
 * строка с этой почтой ни в чём не виновата.
 */
export function validateImport(
  csv: string,
  ctx: ImportContext,
): { rows: ImportRow[]; unknownColumns: string[]; missingColumns: string[] } {
  const table = parseCsv(csv);
  const header = table[0] ?? [];
  const fieldAt = header.map(headerField);
  const unknownColumns = header.filter((_, i) => fieldAt[i] === null).map((h) => h.trim()).filter(Boolean);
  const missingColumns = IMPORT_COLUMNS.filter((c) => c.required && !fieldAt.includes(c.field)).map((c) => c.header);

  const seen = new Set<string>();
  const rows: ImportRow[] = table.slice(1).map((cells, i) => {
    const get = (f: ImportField) => {
      const at = fieldAt.indexOf(f);
      return at < 0 ? "" : (cells[at] ?? "").trim();
    };
    const row: ImportRow = {
      line: i + 2,
      lastName: get("lastName"),
      firstName: get("firstName"),
      middleName: get("middleName"),
      email: get("email").toLowerCase(),
      role: get("role"),
      roleTemplate: get("roleTemplate"),
      position: get("position"),
      unit: get("unit"),
      errors: [],
    };
    const errors: ImportRowError[] = [];
    if (!row.lastName) errors.push("lastNameRequired");
    if (!row.firstName) errors.push("firstNameRequired");
    if (!row.email) errors.push("emailRequired");
    else if (!emailSchema.safeParse(row.email).success) errors.push("emailInvalid");
    else if (ctx.takenEmails.has(row.email)) errors.push("emailTaken");
    else if (seen.has(row.email)) errors.push("emailDuplicate");
    if (row.email) seen.add(row.email);

    const role = roleFrom(row.role);
    if (role === null) errors.push("roleUnknown");
    else if (role === "patient" || (role === "superadmin" && !ctx.actorIsSuper)) errors.push("roleNotAllowed");

    if (row.roleTemplate) {
      const tpl = ctx.templates.get(row.roleTemplate);
      if (!tpl) errors.push("roleTemplateUnknown");
      else if (!tpl.allowed) errors.push("roleTemplateAboveYours");
    }
    row.errors = errors;
    return row;
  });
  return { rows, unknownColumns, missingColumns };
}

/* ═══════════ отчёт «хто переглядав» ═══════════ */

export interface SubjectEntry {
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  subjectUserId: string | null;
  details: Record<string, unknown> | null;
}

/**
 * Попадает ли строка журнала в отчёт о пациенте.
 *
 * Любая строка, где он субъект (карта, прохождения, заключения, записи
 * приёма, выгрузки, звонок по телефону), или где под его именем смотрели
 * («от имени» — details.asUserId). Кроме его собственных действий — отчёт
 * отвечает «кто смотрел мои данные», а не «что делал я», — и кроме строк
 * без человека (система, расписание): у них нет сотрудника, которого можно
 * назвать.
 */
export function aboutPatient(e: SubjectEntry, patientId: string): boolean {
  if (!e.actorId || e.actorId === patientId) return false;
  return e.subjectUserId === patientId || e.details?.asUserId === patientId;
}

/**
 * Сгруппировать по сотруднику и дню.
 *
 * День — по часам учреждения, а не UTC: чтение в 01:30 по Киеву — это
 * сегодняшняя ночь, и в отчёте для пациента оно должно стоять сегодняшним
 * днём. Сотрудники — по числу действий (кто смотрел больше — сверху), дни —
 * от свежих к старым, действия дня — по числу.
 */
export function groupWhoViewed(
  entries: readonly SubjectEntry[],
  patientId: string,
  timezone: string,
  names: ReadonlyMap<string, string>,
): WhoViewedActor[] {
  const actors = new Map<string, WhoViewedActor>();
  for (const e of entries) {
    if (!aboutPatient(e, patientId)) continue;
    const actorId = e.actorId!;
    let actor = actors.get(actorId);
    if (!actor) {
      actor = {
        actorId,
        actorEmail: e.actorEmail,
        actorName: names.get(actorId) ?? null,
        actorRole: e.actorRole,
        total: 0,
        days: [],
      };
      actors.set(actorId, actor);
    }
    actor.total++;
    const day = localClock(e.at, timezone).date;
    let bucket = actor.days.find((d) => d.day === day);
    if (!bucket) {
      bucket = { day, actions: [] };
      actor.days.push(bucket);
    }
    const asUserEmail = e.details?.asUserId ? ((e.details.asEmail as string | undefined) ?? String(e.details.asUserId)) : null;
    let act = bucket.actions.find((a) => a.action === e.action && a.asUserEmail === asUserEmail);
    if (!act) {
      act = { action: e.action, count: 0, first: e.at, last: e.at, asUserEmail };
      bucket.actions.push(act);
    }
    act.count++;
    if (e.at < act.first) act.first = e.at;
    if (e.at > act.last) act.last = e.at;
  }
  const out = [...actors.values()];
  for (const a of out) {
    a.days.sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : 0));
    for (const d of a.days) d.actions.sort((x, y) => y.count - x.count || x.action.localeCompare(y.action));
  }
  out.sort((x, y) => y.total - x.total || (x.actorEmail ?? "").localeCompare(y.actorEmail ?? ""));
  return out;
}
