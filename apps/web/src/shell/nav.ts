import { ALWAYS_VISIBLE_RAIL, type Permission, type UiKey } from "@quizzy/shared";
import { canOpenOps, opsGroups } from "../pages/ops/model";
import { peopleLists } from "../pages/people/model";
import type { IconName } from "./icons";

/*
 * Навигация консоли Polypsy 2.0 — данными, без разметки.
 *
 * Три уровня, как в наборе «Виразної» (kit/shell.py):
 *
 *   рельса      — десять разделов значком и словом слева (RAIL набора):
 *                 Сьогодні, Черга, Ризик, Пацієнти, Розклад, Листування,
 *                 Методики, Аналітика, Адмін и внизу Довідка;
 *   подразделы  — колонка раздела (SUBNAV набора): у пациентов, методик,
 *                 аналитики, администрирования и техпанели;
 *   всё сразу   — меню «Ще розділи» на узком окне (railGroups в Rail.tsx).
 *
 * Состав каждого уровня — функция от того, кто вошёл, и адреса. Отдельно от
 * разметки ради проверок: «кому какой раздел» и «куда ведёт пункт» читаются
 * здесь, а не из отрисованной страницы (apps/web/test/shellNav.test.ts).
 *
 * Права у пунктов — те, которыми сервер закрывает СПИСОК раздела
 * (apps/api/src/lib/openapi.ts), и спрашиваются они только у того, кто не
 * лечит: у остальных состав задан набором и решением заказчика — так было и
 * у верхней полосы (barItems), и пункт, ведущий в отказ, хуже
 * отсутствующего только для того, кому раздел закрыт целиком.
 */

export type RailKey =
  | "today"
  | "worklist"
  | "cases"
  | "patients"
  | "schedule"
  | "messages"
  | "methods"
  | "analytics"
  | "admin";

export type SectionKey = "patients" | "methods" | "analytics" | "admin" | "ops";

export interface NavCounts {
  /** Сколько людей ещё не принято сегодня */
  today?: number;
  worklist?: number;
  alerts?: number;
  referrals?: number;
  /** Непрочитанных писем пациентов во всех разговорах */
  messages?: number;
}

export interface NavAccess {
  isSuper: boolean;
  /** Есть кого назначать: ступень лестницы выше первой */
  canAssign: boolean;
  /**
   * Лечит: суперадмін, рядовой лікар (по классу записи) или тот, кому
   * выдано patients.read. Тому, кто лечит, разделы права не режут.
   */
  clinic: boolean;
  /** Открыта ли техпанель: хоть одно из ops.read, users.manage, audit.read */
  canOps: boolean;
  doctors: boolean;
  admins: boolean;
  can: (p: Permission) => boolean;
}

export function navAccess(
  user: { role?: string | null; ladderRank?: number | null } | null | undefined,
  can: (p: Permission) => boolean,
): NavAccess {
  const isSuper = user?.role === "superadmin";
  const rank = user?.ladderRank ?? 0;
  const lists = peopleLists(user);
  return {
    isSuper,
    canAssign: rank > 1,
    clinic: isSuper || rank <= 1 || can("patients.read"),
    canOps: canOpenOps(can, isSuper),
    doctors: lists.doctors,
    admins: lists.admins,
    can,
  };
}

/** Пустить ли к пункту с правом `need`: лечащему — да, остальным — по праву */
export function allows(a: NavAccess, need?: Permission): boolean {
  return !need || a.clinic || a.can(need);
}

/* ─────────── адреса ─────────── */

/** Адрес — сам корень или под ним; «/patients-x» не под «/patients» */
export function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

const PATIENT_ROOTS = ["/patients", "/patient-groups", "/referrals", "/cohorts", "/search", "/mailings"];
const METHOD_ROOTS = ["/surveys", "/batteries", "/groups", "/constructor", "/responses"];
const ANALYTICS_ROOTS = ["/analytics", "/statistics"];
const ADMIN_ROOTS = ["/staff", "/admins", "/permissions", "/ops", "/console", "/consent-text", "/api-docs", "/account"];

/**
 * Раздел рельсы, к которому принадлежит адрес.
 *
 * «Сьогодні» — это и сводка, и день приёма, и приглашения (вкладки одного
 * экрана), и сам приём (/visit — кадр набора рисует его под «Сьогодні»).
 */
export function railKeyOf(path: string): RailKey | null {
  if (path === "/" || under(path, "/today") || under(path, "/invites") || under(path, "/visit")) return "today";
  if (under(path, "/worklist")) return "worklist";
  if (under(path, "/alerts")) return "cases";
  if (PATIENT_ROOTS.some((r) => under(path, r))) return "patients";
  if (under(path, "/my-schedule")) return "schedule";
  if (under(path, "/messages")) return "messages";
  if (METHOD_ROOTS.some((r) => under(path, r))) return "methods";
  if (ANALYTICS_ROOTS.some((r) => under(path, r))) return "analytics";
  if (ADMIN_ROOTS.some((r) => under(path, r))) return "admin";
  return null;
}

/**
 * Колонка подразделов на этом адресе.
 *
 * Конструктор её не получает: это редактор во всю ширину, и набор рисует
 * его без колонки. Учётная запись — только у того, у кого есть раздел
 * администрирования: у остальных колонка состояла бы из одного пункта.
 */
export function sectionOf(path: string): SectionKey | null {
  if (under(path, "/ops")) return "ops";
  if (under(path, "/constructor")) return null;
  switch (railKeyOf(path)) {
    case "patients":
      return "patients";
    case "methods":
      return "methods";
    case "analytics":
      return "analytics";
    case "admin":
      return "admin";
    default:
      return null;
  }
}

/* ─────────── рельса ─────────── */

export type BadgeTone = "plain" | "risk" | "violet";

export interface RailEntry {
  key: RailKey;
  to: string;
  /** Слово под значком — короткое */
  label: UiKey;
  /** Полное имя: подсказка и имя для диктора */
  full: UiKey;
  icon: IconName;
  badge?: { n: number; tone: BadgeTone };
  /**
   * Пункты общего списка (railGroups), которые этот раздел представляет:
   * по ним действует «убрать с глаз» из настроек рабочего места.
   */
  navKeys: string[];
}

/** Первая доступная дверь администрирования — туда ведёт «Адмін» */
export function adminHome(a: NavAccess): string | null {
  if (a.doctors) return "/staff";
  if (a.admins) return "/admins";
  if (a.canAssign || a.isSuper) return "/permissions";
  if (a.canOps) return "/ops";
  return null;
}

/**
 * Разделы рельсы — ровно в порядке набора.
 *
 * Счётчики — только там, где число уже есть у консоли: очередь (объём
 * работы, нейтральный), случаи риска (красный: это человек, которому,
 * возможно, плохо прямо сейчас) и непрочитанные письма (фиолетовый: «моё»).
 * У «Сьогодні» на рельсе числа нет — так нарисовано; людей на сегодня
 * считает сам экран дня.
 */
export function railEntries(a: NavAccess, counts: NavCounts = {}, hidden: readonly string[] = []): RailEntry[] {
  const badge = (n: number | undefined, tone: BadgeTone) => (n && n > 0 ? { n, tone } : undefined);
  const out: RailEntry[] = [
    { key: "today", to: "/", label: "day.title", full: "day.title", icon: "house", navKeys: ["nav.dashboard"] },
    {
      key: "worklist",
      to: "/worklist",
      label: "rail.worklist",
      full: "nav.worklist",
      icon: "list-checks",
      badge: badge(counts.worklist, "plain"),
      navKeys: ["nav.worklist"],
    },
    {
      key: "cases",
      to: "/alerts",
      label: "rail.cases",
      full: "nav.cases",
      icon: "triangle-alert",
      badge: badge(counts.alerts, "risk"),
      navKeys: ["nav.cases"],
    },
  ];
  if (allows(a, "patients.read")) {
    out.push({
      key: "patients",
      to: "/patients",
      label: "nav.patients",
      full: "nav.patients",
      icon: "users",
      navKeys: ["nav.patients", "nav.referrals", "srch.title", "coh.title", "nav.groups"],
    });
  }
  out.push(
    {
      key: "schedule",
      to: "/my-schedule",
      label: "rail.schedule",
      full: "nav.reception",
      icon: "calendar-days",
      navKeys: ["nav.reception"],
    },
    {
      key: "messages",
      to: "/messages",
      label: "ms.title",
      full: "ms.title",
      icon: "messages-square",
      badge: badge(counts.messages, "violet"),
      navKeys: ["ms.title"],
    },
    {
      key: "methods",
      to: "/surveys",
      label: "nav.surveys",
      full: "nav.surveys",
      icon: "clipboard-list",
      navKeys: ["nav.surveys", "nav.batteries", "adm.groupsTitle"],
    },
  );
  const analytics = allows(a, "alerts.review");
  const statistics = allows(a, "statistics.read");
  if (analytics || statistics) {
    out.push({
      key: "analytics",
      to: analytics ? "/analytics" : "/statistics",
      label: "top.analytics",
      full: "rail.analyticsFull",
      icon: "chart-line",
      navKeys: [],
    });
  }
  const admin = adminHome(a);
  if (admin) {
    out.push({
      key: "admin",
      to: admin,
      label: "rail.admin",
      full: "nav.admin",
      icon: "settings",
      navKeys: [],
    });
  }
  /*
   * «Убрать с глаз» действует и на рельсу: раздел уходит, когда убраны все
   * пункты, которые он представляет. Сигнальные (очередь, случаи, сводка)
   * не убираются никогда — то же правило, что у railGroups и на сервере.
   */
  if (!hidden.length) return out;
  const off = new Set(hidden.filter((k) => !(ALWAYS_VISIBLE_RAIL as readonly string[]).includes(k)));
  return out.filter((e) => !e.navKeys.length || e.navKeys.some((k) => !off.has(k)));
}

/* ─────────── подразделы ─────────── */

export interface SubNavItem {
  to: string;
  label: UiKey;
  icon: IconName;
  count?: number;
  /** Число — риск для человека: красным, как в наборе */
  risk?: boolean;
  /** Точное совпадение адреса */
  end?: boolean;
  /** Ещё корни, на которых пункт — текущий */
  also?: string[];
  /** Корни, на которых пункт НЕ текущий, хотя адрес под ним */
  except?: string[];
}

export interface SubNavGroup {
  /** Подпись группы; без неё пункты стоят сразу под заголовком */
  label?: UiKey;
  items: SubNavItem[];
}

export interface SubNavData {
  section: SectionKey;
  title: UiKey;
  /** Пункт «назад» над списком: техпанель → администрирование */
  back?: { to: string; label: UiKey };
  /** Плотные строки: в техпанели тридцать разделов */
  dense?: boolean;
  groups: SubNavGroup[];
}

/** Текущий ли это пункт подразделов */
export function isCurrent(item: SubNavItem, path: string): boolean {
  if (item.except?.some((r) => under(path, r))) return false;
  if (item.end ? path === item.to : under(path, item.to)) return true;
  return !!item.also?.some((r) => under(path, r));
}

/**
 * Двери к одному человеку — клиническая карта открытого пациента.
 *
 * Жили в бургере верхней полосы (кадр f13 не даёт им места в шапке
 * карточки). Теперь — группой подразделов пациентов, пока открыт человек:
 * это двери к нему, а не к экрану консоли, и вне карточки их нет.
 */
export function clinicalLinks(path: string): SubNavItem[] | null {
  const m = /^\/patients\/([^/]+)/.exec(path);
  const id = m?.[1];
  if (!id) return null;
  const base = `/patients/${id}/case`;
  return [
    { to: base, label: "pc.overview", icon: "layout-dashboard", end: true },
    { to: `${base}/dynamics`, label: "pc.dynamics", icon: "chart-line" },
    { to: `${base}/timeline`, label: "tl.title", icon: "list-tree" },
  ];
}

/**
 * Двери текущего экрана, которых кадр на самом экране не рисует: правка
 * названия группы (f14) и черновик заключения (f36). На самом адресе двери
 * её в списке нет — ссылка «туда, где мы уже стоим» только мешает.
 */
export function screenTools(path: string): SubNavItem[] | null {
  const group = /^\/patient-groups\/([^/]+)$/.exec(path);
  if (group) return [{ to: `/patient-groups/${group[1]}/edit`, label: "pg.edit", icon: "pencil" }];
  const conclusion = /^\/responses\/([^/]+)\/conclusion$/.exec(path);
  if (conclusion) {
    return [{ to: `/responses/${conclusion[1]}/conclusion/draft`, label: "tools.conclusionDraft", icon: "file-pen-line" }];
  }
  return null;
}

/* значки разделов техпанели — по адресу, как в наборе (SUBNAV['ops']) */
const OPS_ICONS: Record<string, IconName> = {
  "/ops": "layout-dashboard",
  "/ops/requests": "arrow-left-right",
  "/ops/errors": "octagon-alert",
  "/ops/logs": "scroll-text",
  "/ops/db": "database",
  "/ops/client-errors": "monitor-x",
  "/ops/vitals": "timer",
  "/ops/compare": "git-compare",
  "/ops/statements": "turtle",
  "/ops/integrity": "shield-check",
  "/ops/jobs": "cog",
  "/ops/maintenance": "wrench",
  "/ops/flags": "flag",
  "/ops/releases": "rocket",
  "/ops/alerts": "bell-ring",
  "/ops/recordings": "mic",
  "/ops/users": "users",
  "/ops/sessions": "monitor-smartphone",
  "/ops/audit": "file-search",
  "/ops/suspicious": "scan-eye",
  "/ops/grants": "hourglass",
  "/ops/who-viewed": "eye",
  "/ops/mfa": "smartphone-nfc",
  "/ops/keys": "key-square",
  "/ops/sql": "square-terminal",
  "/ops/quality": "badge-check",
  "/ops/usage": "chart-column",
  "/ops/mobile": "smartphone",
  "/ops/push": "bell",
};

function withoutEmpty(groups: SubNavGroup[]): SubNavGroup[] {
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Подразделы раздела — по набору (SUBNAV в kit/shell.py), но из настоящих
 * экранов: пункты, которых в консоли нет (сохранённые подання в колонке,
 * «Норми» без открытой методики), не рисуются.
 */
export function subNavFor(
  section: SectionKey,
  path: string,
  a: NavAccess,
  counts: NavCounts = {},
): SubNavData | null {
  switch (section) {
    case "patients": {
      const items: SubNavItem[] = [];
      if (allows(a, "patients.read")) {
        items.push(
          { to: "/patients", label: "sn.allPatients", icon: "users-round" },
          { to: "/patient-groups", label: "sn.patientGroups", icon: "component" },
        );
      }
      items.push(
        {
          to: "/referrals",
          label: "nav.referrals",
          icon: "arrow-right-left",
          count: counts.referrals || undefined,
        },
        { to: "/cohorts", label: "coh.title", icon: "filter" },
        { to: "/search", label: "srch.title", icon: "text-search" },
      );
      if (allows(a, "mailings.manage")) items.push({ to: "/mailings", label: "sn.mailings", icon: "megaphone" });
      const groups: SubNavGroup[] = [{ items }];
      const card = clinicalLinks(path);
      if (card) groups.push({ label: "pcard.clinical", items: card });
      const tools = screenTools(path);
      if (tools) groups.push({ label: "tools.screen", items: tools });
      return { section, title: "nav.patients", groups: withoutEmpty(groups) };
    }
    case "methods": {
      const survey = /^\/surveys\/([0-9a-f-]{8,})(?:\/|$)/i.exec(path)?.[1];
      const groups: SubNavGroup[] = [
        {
          items: [
            {
              to: "/surveys",
              label: "sn.catalog",
              icon: "library",
              also: ["/responses"],
              except: ["/surveys/drafts", "/surveys/retired"],
            },
            { to: "/surveys/drafts", label: "sn.drafts", icon: "file-pen-line" },
            { to: "/surveys/retired", label: "sn.archive", icon: "archive" },
            { to: "/batteries", label: "nav.batteries", icon: "layers" },
            { to: "/groups", label: "adm.groupsTitle", icon: "folder-tree" },
          ],
        },
        {
          label: "sn.creating",
          items: [
            { to: "/constructor", label: "sn.constructor", icon: "pencil-ruler", end: true },
            ...(survey ? [{ to: `/surveys/${survey}/norms`, label: "sn.norms" as UiKey, icon: "ruler" as IconName }] : []),
          ],
        },
      ];
      const tools = screenTools(path);
      if (tools) groups.push({ label: "tools.screen", items: tools });
      return { section, title: "nav.surveys", groups };
    }
    case "analytics": {
      const groups: SubNavGroup[] = [];
      if (allows(a, "alerts.review")) {
        groups.push({
          label: "top.analytics",
          items: [
            { to: "/analytics/tests", label: "ant.title", icon: "gauge" },
            { to: "/analytics", label: "sn.analyticsModels", icon: "chart-spline", except: ["/analytics/tests"] },
          ],
        });
      }
      if (allows(a, "statistics.read")) {
        groups.push({
          label: "top.statistics",
          items: [
            {
              to: "/statistics",
              label: "sn.statModels",
              icon: "sigma",
              except: ["/statistics/chart", "/statistics/filters"],
            },
            { to: "/statistics/chart", label: "sn.chart", icon: "chart-scatter" },
            { to: "/statistics/filters", label: "sn.sampleFilters", icon: "sliders-horizontal" },
          ],
        });
      }
      return groups.length ? { section, title: "top.analytics", groups } : null;
    }
    case "admin": {
      if (!adminHome(a)) return null;
      const people: SubNavItem[] = [];
      if (a.doctors) people.push({ to: "/staff", label: "ppl.staff", icon: "stethoscope" });
      if (a.admins) people.push({ to: "/admins", label: "adm.admins", icon: "user-cog" });
      if (a.canAssign || a.isSuper) people.push({ to: "/permissions", label: "perm.title", icon: "key-round" });
      const system: SubNavItem[] = [];
      if (a.canOps) system.push({ to: "/ops", label: "nav.ops", icon: "activity" });
      if (a.isSuper) {
        system.push(
          { to: "/console", label: "nav.console", icon: "square-terminal" },
          { to: "/consent-text", label: "adm.consentTitle", icon: "file-signature" },
          { to: "/api-docs", label: "api.title", icon: "braces" },
        );
      }
      return {
        section,
        title: "nav.admin",
        groups: withoutEmpty([
          { label: "nav.group.people", items: people },
          { label: "ops.group.system", items: system },
          { label: "sn.personal", items: [{ to: "/account", label: "acct.title", icon: "circle-user-round" }] },
        ]),
      };
    }
    case "ops": {
      const tabs = opsGroups(a.can, a.isSuper);
      if (!tabs.length) return null;
      const back = adminHome(a);
      return {
        section,
        title: "ops.title",
        back: back && back !== "/ops" ? { to: back, label: "nav.admin" } : undefined,
        dense: true,
        groups: tabs.map((g) => ({
          label: g.label,
          items: g.tabs.map((t) => ({
            to: t.to,
            label: t.key,
            icon: OPS_ICONS[t.to] ?? "activity",
            end: t.end,
          })),
        })),
      };
    }
  }
}
