import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";
import type { UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import {
  IconAlert,
  IconAudit,
  IconBattery,
  IconClock,
  IconCompare,
  IconDashboard,
  IconGroup,
  IconInvite,
  IconKiosk,
  IconPatients,
  IconPulse,
  IconReferral,
  IconRoute,
  IconStack,
  IconSurvey,
  IconUsers,
} from "../ui";

/*
 * Рельса разделов.
 *
 * Было девятнадцать пунктов подряд. Такой список не читают — по нему скользят
 * глазами сверху вниз, каждый раз заново отыскивая знакомое слово, и время на
 * это тратится в каждом переходе за смену.
 *
 * Группы названы по работе, а не по сущностям базы: «Сегодня» — то, с чего
 * начинается смена; «Люди» — кого ведём; «Методики и сбор» — чем и как
 * измеряем; «Разбор» — то, что делают, когда приёмы закончились. Порядок
 * групп повторяет порядок дня, поэтому в начале смены нужное лежит сверху.
 *
 * Счётчик рисуется только когда есть что считать: постоянный ноль рядом с
 * пунктом приучает не смотреть на это место, и однажды не заметят настоящее
 * число.
 */

interface Item {
  to: string;
  key: UiKey;
  icon: ReactNode;
  end?: boolean;
  badge?: number;
}

interface Group {
  key: UiKey;
  items: Item[];
}

export interface RailCounts {
  worklist?: number;
  alerts?: number;
  referrals?: number;
}

export function railGroups(counts: RailCounts, isSuper: boolean): Group[] {
  const groups: Group[] = [
    {
      key: "nav.group.today",
      items: [
        { to: "/", key: "nav.dashboard", icon: <IconDashboard />, end: true },
        { to: "/worklist", key: "nav.worklist", icon: <IconClock />, badge: counts.worklist },
        { to: "/alerts", key: "nav.cases", icon: <IconAlert />, badge: counts.alerts },
        { to: "/referrals", key: "nav.referrals", icon: <IconReferral />, badge: counts.referrals },
      ],
    },
    {
      key: "nav.group.people",
      items: [
        { to: "/patients", key: "nav.patients", icon: <IconPatients /> },
        { to: "/groups", key: "nav.groups", icon: <IconGroup /> },
        { to: "/invites", key: "nav.invites", icon: <IconInvite /> },
        { to: "/pathways", key: "pw.title", icon: <IconRoute /> },
      ],
    },
    {
      key: "nav.group.methods",
      items: [
        { to: "/surveys", key: "nav.surveys", icon: <IconSurvey /> },
        { to: "/batteries", key: "nav.batteries", icon: <IconBattery /> },
        { to: "/schedules", key: "nav.schedules", icon: <IconClock /> },
        { to: "/kiosk-sessions", key: "nav.kiosk", icon: <IconKiosk /> },
      ],
    },
    {
      key: "nav.group.analysis",
      items: [
        { to: "/compare", key: "nav.compare", icon: <IconCompare /> },
        { to: "/cohorts", key: "coh.title", icon: <IconGroup /> },
        { to: "/search", key: "srch.title", icon: <IconStack /> },
        { to: "/surveillance", key: "nav.surveillance", icon: <IconPulse /> },
        { to: "/unit-report", key: "nav.unitReport", icon: <IconGroup /> },
        { to: "/conclusion-batch", key: "cbatch.title", icon: <IconStack /> },
      ],
    },
  ];
  if (isSuper) {
    groups.push({
      key: "nav.admin",
      items: [
        { to: "/users", key: "nav.users", icon: <IconUsers /> },
        { to: "/audit", key: "nav.audit", icon: <IconAudit /> },
        /* текст согласия жил на одном маршруте с учётками; разведён в свой */
        { to: "/consent-text", key: "consent.title", icon: <IconInvite /> },
        { to: "/api-docs", key: "nav.api", icon: <IconSurvey /> },
        { to: "/ui", key: "nav.ui", icon: <IconDashboard /> },
      ],
    });
  }
  return groups;
}

function RailLink({ item, collapsed }: { item: Item; collapsed: boolean }) {
  const { ut } = useLang();
  const label = ut(item.key);
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cx(
          "group relative flex items-center rounded-sm text-small",
          "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
          collapsed ? "h-9 w-9 justify-center" : "h-9 gap-2.5 px-2.5",
          isActive
            ? "bg-surface-3 text-text font-medium"
            : "text-muted hover:bg-surface-2 hover:text-text",
        )
      }
    >
      {({ isActive }) => (
        <>
          {/*
            Активный раздел отмечен полосой слева, а не заливкой посветлее:
            заливку в тёмной теме на плохом мониторе не видно, полосу — видно
            всегда, и она не спорит с янтарным.
          */}
          <span
            aria-hidden
            className={cx(
              "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary",
              "transition-opacity duration-[var(--dur-fast)]",
              isActive ? "opacity-100" : "opacity-0",
            )}
          />
          <span className="shrink-0 [&>svg]:size-[18px]">{item.icon}</span>
          {collapsed ? null : <span className="truncate">{label}</span>}
          {/*
            Счётчик залит янтарём, а не набран янтарём по прозрачному фону.
            Полупрозрачная заливка давала в светлой теме 4,32:1 при пороге
            4,5 — и хуже всего именно на выбранном пункте, где под меткой
            лежит более светлая поверхность. Сплошная заливка даёт 6,4:1 на
            бумаге и 10,7:1 в тёмной теме; заодно это честнее по смыслу:
            число, которое требует внимания, не должно быть бледнее
            соседнего текста.
          */}
          {item.badge ? (
            <span
              className={cx(
                "bg-accent font-mono text-micro leading-none text-accent-text tabular-nums",
                collapsed
                  ? "absolute -right-0.5 -top-0.5 rounded-full px-1 py-0.5"
                  : "ml-auto rounded-sm px-1.5 py-0.5 font-semibold",
              )}
            >
              {item.badge > 99 ? "99+" : item.badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

export function Rail({
  counts,
  isSuper,
  collapsed,
  children,
}: {
  counts: RailCounts;
  isSuper: boolean;
  collapsed: boolean;
  children?: ReactNode;
}) {
  const { ut } = useLang();
  const groups = railGroups(counts, isSuper);
  return (
    /*
      Рельса прибита к окну и прокручивается внутри себя. Иначе подвал —
      имя, роль, стартовый экран и выход — уезжает за нижний край на
      ноутбучном экране, и человек не находит кнопку выхода вовсе.
      Прокручивается только список разделов: подвал остаётся на месте.
    */
    <aside
      className={cx(
        "sidebar sticky top-0 z-40 flex h-screen shrink-0 flex-col overflow-x-hidden",
        "border-r border-hairline bg-rail",
        "transition-transform duration-[var(--dur)] ease-[var(--ease)]",
        collapsed ? "w-14 px-2 py-3" : "w-[var(--rail-w)] px-3 py-3",
        /*
          Ниже 900 px рельса не сжимает содержимое, а ложится поверх него.
          Деление на две колонки на телефоне не оставляет места ни одной
          таблице: содержимое уезжает вбок, и страницу приходится возить
          горизонтально — на списке из восьми тысяч человек это невыносимо.
          Поэтому здесь она выводится из потока и выезжает по кнопке.
        */
        "max-[900px]:fixed max-[900px]:left-0 max-[900px]:top-0 max-[900px]:w-[var(--rail-w)] max-[900px]:px-3 max-[900px]:shadow-panel",
        collapsed ? "max-[900px]:-translate-x-full" : "max-[900px]:translate-x-0",
      )}
    >
      <div
        className={cx(
          "mb-3 flex shrink-0 items-center gap-2 px-1",
          collapsed && "justify-center px-0",
        )}
      >
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-sm bg-primary font-display text-small font-bold text-primary-text"
        >
          Q
        </span>
        {collapsed ? null : (
          <span className="font-display text-section font-semibold tracking-tight">Quizzy</span>
        )}
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto [scrollbar-width:thin]">
      {groups.map((g, gi) => (
        <div key={g.key} className={cx("flex flex-col gap-0.5", gi > 0 && "mt-3")}>
          {collapsed ? (
            gi > 0 ? <hr className="mx-auto mb-2 w-6 border-0 border-t border-hairline" /> : null
          ) : (
            <div className="px-2.5 pb-1 text-micro font-semibold uppercase tracking-[var(--tracking-label)] text-faint">
              {ut(g.key)}
            </div>
          )}
          {g.items.map((it) => (
            <RailLink key={it.to} item={it} collapsed={collapsed} />
          ))}
        </div>
      ))}

      </nav>
      {children ? <div className="shrink-0">{children}</div> : null}
    </aside>
  );
}
