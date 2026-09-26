import type { ClinicalTrace, ClinicalTraceKey, OpsUserRow, Permission, Role, UiKey } from "@quizzy/shared";

/*
 * Чистая логика техпанели: какие вкладки кому, как назвать действие журнала,
 * что держит учётку, какой пароль выдать. Отдельно от экранов — ради
 * проверок (apps/web/test/opsModel.test.ts): правило «вкладка по своему
 * праву» и перечень «что держит» должны проверяться без браузера.
 */

/* ─────────── вкладки и дверь в панель ─────────── */

export interface OpsTab {
  to: string;
  key: UiKey;
  permission: Permission;
  end?: boolean;
}

/**
 * Вкладки техпанели — каждая по своему праву.
 *
 * Решение заказчика 2026-09-26: панель — «для супер тех админа», но о людях
 * и о системе в ней разные работы. Наблюдаемость — ops.read, учётки и
 * сессии — users.manage, журнал — audit.read. Панель открывается, если есть
 * хоть одно из трёх, и показывает только те вкладки, на которые пустит
 * сервер: вкладка, ведущая в отказ, хуже отсутствующей.
 *
 * Порядок — порядок на экране: сначала о системе, потом о людях. Первая
 * доступная вкладка и есть «куда вести» тому, кто открыл /ops (opsHome).
 */
export const OPS_TABS: readonly OpsTab[] = [
  { to: "/ops", key: "ops.tab.overview", permission: "ops.read", end: true },
  { to: "/ops/requests", key: "ops.tab.requests", permission: "ops.read" },
  { to: "/ops/errors", key: "ops.tab.errors", permission: "ops.read" },
  { to: "/ops/logs", key: "ops.tab.logs", permission: "ops.read" },
  { to: "/ops/db", key: "ops.tab.db", permission: "ops.read" },
  { to: "/ops/jobs", key: "ops.tab.jobs", permission: "ops.read" },
  { to: "/ops/users", key: "ops.tab.users", permission: "users.manage" },
  { to: "/ops/sessions", key: "ops.tab.sessions", permission: "users.manage" },
  { to: "/ops/audit", key: "ops.tab.audit", permission: "audit.read" },
];

export type Can = (permission: Permission) => boolean;

export function opsTabs(can: Can): OpsTab[] {
  return OPS_TABS.filter((t) => can(t.permission));
}

/** Пускать ли в панель вовсе — то же правило решает пункт бургера */
export function canOpenOps(can: Can): boolean {
  return opsTabs(can).length > 0;
}

/** Первая доступная вкладка: туда ведёт /ops тому, у кого нет наблюдаемости */
export function opsHome(can: Can): string | null {
  return opsTabs(can)[0]?.to ?? null;
}

/* ─────────── роли ─────────── */

export const ROLE_KEY: Record<Role, UiKey> = {
  superadmin: "adm.roleSuper",
  admin: "adm.roleAdmin",
  user: "adm.rolePatient",
};

/**
 * Куда ведёт имя в строке: сотрудник — в карточку сотрудника, пациент — в
 * карточку пациента. Одна карточка на человека, как во всей консоли.
 */
export function personHref(row: Pick<OpsUserRow, "id" | "role">): string {
  return row.role === "user" ? `/patients/${row.id}` : `/staff/${row.id}`;
}

/* ─────────── что держит учётку ─────────── */

export type HoldKey = ClinicalTraceKey | "journal";

export interface Hold {
  key: HoldKey;
  count: number;
}

/**
 * Порядок источников — тот же, что у сервера (lib/accounts.ts, TRACE_SOURCES):
 * сначала то, о чём спросят первым, — прохождения и заключения.
 */
export const TRACE_ORDER: readonly ClinicalTraceKey[] = [
  "responses",
  "conclusions",
  "notes",
  "cases",
  "surveys",
  "referrals",
  "appointments",
  "episodes",
  "safetyPlans",
  "recordings",
  "consents",
  "threads",
  "dispensary",
];

/** Ненулевые источники следа */
export function traceParts(trace: ClinicalTrace): Hold[] {
  return TRACE_ORDER.filter((k) => (trace[k] ?? 0) > 0).map((k) => ({ key: k, count: trace[k] }));
}

/**
 * Что держит учётку от удаления: след и журнал.
 *
 * Экран считает это сам, по строке списка, — чтобы пункт «Видалити» у
 * учётки со следом сразу объяснял, почему нельзя, а не вёл в подтверждение
 * и отказ. Решает всё равно сервер (DELETE отвечает 409 теми же holds).
 */
export function holdsOfRow(row: Pick<OpsUserRow, "trace" | "journalEntries">): Hold[] {
  const holds = traceParts(row.trace);
  if (row.journalEntries > 0) holds.push({ key: "journal", count: row.journalEntries });
  return holds;
}

export function holdKey(key: HoldKey): UiKey {
  return `ops.hold.${key}` as UiKey;
}

/* ─────────── временный пароль ─────────── */

/*
 * Алфавит — тот же, что у сервера (lib/accounts.ts): без 0/O и 1/l/I.
 * Пароль диктуют и переписывают с экрана, и «это ноль или буква?» стоит
 * попытки входа из пяти до блокировки.
 */
export const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Временный пароль для новой учётки — четыре группы по четыре знака.
 *
 * Генерирует экран, а не сервер, потому что заведение идёт штатным POST
 * /api/users, который принимает пароль, а не выдаёт его. Источник —
 * crypto.getRandomValues, с отбраковкой: остаток от деления 256 на 56
 * смещал бы выбор к первым знакам.
 */
export function generatePassword(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const out: string[] = [];
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  while (out.length < 16) {
    for (const b of random(new Uint8Array(32))) {
      if (b >= limit) continue;
      out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]!);
      if (out.length === 16) break;
    }
  }
  return [0, 4, 8, 12].map((i) => out.slice(i, i + 4).join("")).join("-");
}

/* ─────────── журнал ─────────── */

/**
 * Действия журнала человеческими словами.
 *
 * Карта переехала сюда из прежнего экрана «Журнал доступу» (pages/Audit.tsx,
 * снят в пользу вкладки техпанели) и пополнена действиями над учётками.
 * Незнакомое действие показывается кодом — лучше сырой код, чем пустая
 * ячейка: код хотя бы ищется в исходниках.
 */
export const AUDIT_ACTION_KEY: Readonly<Record<string, UiKey>> = {
  "auth.login": "act.auth_login",
  "auth.login_failed": "act.auth_login_failed",
  "auth.register": "act.auth_register",
  "auth.password_change": "ops.act.passwordChange",
  "auth.refresh_failed": "ops.act.refreshFailed",
  "user.create": "act.user_create",
  "user.list": "act.user_list",
  "user.role_change": "ops.act.roleChange",
  "user.disable": "ops.act.disable",
  "user.enable": "ops.act.enable",
  "user.delete": "ops.act.delete",
  "user.password_reset": "ops.act.passwordReset",
  "user.sessions_revoke": "ops.act.sessionsRevoke",
  "session.list": "ops.act.sessionList",
  "session.revoke": "ops.act.sessionRevoke",
  "permission.exception": "ops.act.permissionException",
  "permission.exception_revoke": "ops.act.permissionExceptionRevoke",
  "user.roles_change": "ops.act.rolesChange",
  "survey.create": "act.survey_create",
  "survey.catalog_update": "act.survey_catalog_update",
  "survey.update": "act.survey_update",
  "survey.publish": "act.survey_publish",
  "survey.duplicate": "act.survey_duplicate",
  "group.create": "act.group_create",
  "group.admin_assign": "act.group_admin_assign",
  "group.admin_revoke": "act.group_admin_revoke",
  "access.grant": "act.access_grant",
  "access.revoke": "act.access_revoke",
  "access.grant_list": "act.access_grant_list",
  "access.denied": "act.access_denied",
  "response.submit": "act.response_submit",
  "response.list": "act.response_list",
  "response.read": "act.response_read",
  "patient.card_read": "ops.act.patientCard",
  "analytics.overview": "act.analytics_overview",
  "analytics.survey": "act.analytics_survey",
  "analytics.export": "act.analytics_export",
  "report.render": "act.report_render",
  "alert.list": "act.alert_list",
  "alert.acknowledge": "act.alert_acknowledge",
  "audit.read": "act.audit_read",
  "audit.export": "ops.act.auditExport",
  "device.wipe_requested": "ops.act.deviceWipe",
  /*
   * Действий ниже код больше не пишет, но журнал вечен: строки с ними лежат
   * в нём с тех времён, когда писал, и читаться они должны словами, как
   * читались на прежнем экране.
   */
  "survey.delete": "act.survey_delete",
  "response.draft": "act.response_draft",
};

export function actionLabel(action: string, ut: (key: UiKey) => string): string {
  const key = AUDIT_ACTION_KEY[action];
  return key ? ut(key) : action;
}

/**
 * Пункты выбора «дія»: сперва то, что разбирают чаще, — доступ к картам,
 * выгрузки, отказы и входы, — затем действия над учётками. Действие, которого
 * здесь нет, но которое пришло в адресе, выбор добавляет сам (AuditLog.tsx).
 */
export const AUDIT_ACTION_CHOICES: readonly string[] = [
  "response.read",
  "patient.card_read",
  "analytics.export",
  "access.grant",
  "access.denied",
  "auth.login_failed",
  "auth.login",
  "user.create",
  "user.role_change",
  "user.disable",
  "user.enable",
  "user.delete",
  "user.password_reset",
  "user.sessions_revoke",
  "session.revoke",
  "permission.exception",
  "audit.read",
  "audit.export",
];

/**
 * Быстрые отборы прежнего экрана — кнопками над списком, теми же словами,
 * что там: «Усе · Доступ до карток · Вивантаження · Призначення · Відмови ·
 * Невдалі входи». Кто привык разбирать журнал так, находит тот же путь.
 */
export const AUDIT_PRESETS: readonly { action: string; key: UiKey }[] = [
  { action: "", key: "aud.allEvents" },
  { action: "response.read", key: "aud.cardAccess" },
  { action: "analytics.export", key: "aud.exports" },
  { action: "access.grant", key: "aud.grants" },
  { action: "access.denied", key: "aud.denials" },
  { action: "auth.login_failed", key: "aud.failedLogins" },
];

/** Поля отбора журнала — ровно те, что понимает GET /api/audit; все живут в адресе */
export const AUDIT_FILTERS = ["q", "actor", "subject", "action", "resourceType", "outcome", "from", "to"] as const;
export type AuditFilterKey = (typeof AUDIT_FILTERS)[number];
export type AuditFilters = Partial<Record<AuditFilterKey, string>>;

/** Отбор из адреса: пустое не передаётся вовсе — «action=» не то же, что «без действия» */
export function auditFiltersFrom(params: URLSearchParams): AuditFilters {
  const out: AuditFilters = {};
  for (const key of AUDIT_FILTERS) {
    const v = params.get(key)?.trim();
    if (v) out[key] = v;
  }
  return out;
}

/**
 * Подробности записи для раскрытия — отступами, ключи по алфавиту.
 *
 * Ничего не добавляется и не расшифровывается: показывается ровно то, что
 * лежит в журнале. requestId остаётся — по нему запись находится в логе
 * процесса одним поиском.
 */
export function prettyDetails(details: Record<string, unknown> | null): string {
  if (!details) return "—";
  const sorted = Object.fromEntries(Object.keys(details).sort().map((k) => [k, details[k]]));
  return JSON.stringify(sorted, null, 2);
}
