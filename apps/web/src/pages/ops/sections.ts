import type { Permission, UiKey } from "@quizzy/shared";

/**
 * Разделы техпанели — реестр, по которому рисуется её навигация.
 *
 * Разделов за двадцать, и одна строка вкладок их не вмещает: навигация
 * группирована («Система», «Експлуатація», «Люди й безпека», «Дані й
 * продукт»), а каждый раздел несёт своё право — человек видит только то,
 * что ему открыто. Реестр отдельным файлом, а не списком в разметке:
 * сборщики волны 10 дописывают сюда каждый свой участок, не трогая
 * оболочку.
 *
 * `role: "superadmin"` — раздел, который не выдаётся никаким правом
 * (SQL-консоль, вход под другим человеком, ротация ключей).
 */
export interface OpsSection {
  to: string;
  label: UiKey;
  /** Право, которым открыт раздел; хотя бы одно из списка */
  perm?: Permission | Permission[];
  role?: "superadmin";
}

export interface OpsGroup {
  key: "system" | "operations" | "people" | "data";
  label: UiKey;
  sections: OpsSection[];
}

export const OPS_GROUPS: OpsGroup[] = [
  {
    key: "system",
    label: "ops.group.system",
    sections: [
      { to: "/ops", label: "ops.tab.overview", perm: "ops.read" },
      { to: "/ops/requests", label: "ops.tab.requests", perm: "ops.read" },
      { to: "/ops/errors", label: "ops.tab.errors", perm: "ops.read" },
      { to: "/ops/logs", label: "ops.tab.logs", perm: "ops.read" },
      { to: "/ops/db", label: "ops.tab.db", perm: "ops.read" },
      /* ── sections:obs2 ── */
      /* ── sections:sec-system ── */
    ],
  },
  {
    key: "operations",
    label: "ops.group.operations",
    sections: [
      { to: "/ops/jobs", label: "ops.tab.jobs", perm: "ops.read" },
      /* ── sections:maint ── */
      /*
       * Эксплуатация (участок maint): смотреть — ops.read, менять внутри
       * разделов — ops.manage (кнопки без него не рисуются, сервер
       * проверяет сам).
       */
      { to: "/ops/maintenance", label: "ops.tab.maintenance", perm: "ops.read" },
      { to: "/ops/flags", label: "ops.tab.flags", perm: "ops.read" },
      { to: "/ops/releases", label: "ops.tab.releases", perm: "ops.read" },
      /* ── sections:obs2-ops ── */
    ],
  },
  {
    key: "people",
    label: "ops.group.people",
    sections: [
      { to: "/ops/users", label: "ops.tab.users", perm: "users.manage" },
      { to: "/ops/sessions", label: "ops.tab.sessions", perm: "users.manage" },
      { to: "/ops/audit", label: "ops.tab.audit", perm: "audit.read" },
      /* ── sections:people2 ── */
      /* ── sections:sec ── */
    ],
  },
  {
    key: "data",
    label: "ops.group.data",
    sections: [
      /* ── sections:data ── */
      { to: "/ops/quality", label: "opsd.tab.quality", perm: "ops.read" },
      { to: "/ops/usage", label: "opsd.tab.usage", perm: "ops.read" },
      { to: "/ops/mobile", label: "opsd.tab.mobile", perm: "ops.read" },
      { to: "/ops/push", label: "opsd.tab.push", perm: "ops.read" },
    ],
  },
];
