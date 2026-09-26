import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { Page } from "../../ui/layout";
import { Tabs, type TabItem } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { groupOf, opsGroups } from "./model";

/*
 * Техпанель — экран для разработчиков и того, кто держит сервер.
 *
 * Решение заказчика 2026-09-26: «отдельный дашборд для супер тех админа,
 * чисто для разрабов» — логи, ошибки, нагрузка, число запросов и время
 * ответа, все пользователи с выдачей доступа, созданием и удалением учёток,
 * полный аудит действий.
 *
 * Открывается, если есть хоть одно из трёх прав: ops.read (наблюдаемость,
 * группа «Технічна служба» в packages/shared/src/permissions.ts),
 * users.manage («Користувачі» и «Сесії»), audit.read («Аудит»). Вкладки —
 * каждая по своему праву, пустых нет (opsTabs в model.ts): право смотреть,
 * как работает система, не открывает ни людей, ни журнал их чтений, а право
 * вести учётки не открывает логов сервера. Это разные работы, и выдаются
 * они разным людям. Суперадмину сервер отвечает «да» на всё — у него все
 * вкладки.
 *
 * Прежние экраны «Облікові записи» (/users) и «Журнал доступу» (/audit)
 * сняты в пользу вкладок: два экрана одного назначения расходились бы в том,
 * что умеют. Старые адреса перенаправляют сюда (App.tsx).
 *
 * Вкладки — адресами (/ops, /ops/requests, …), а не состоянием: ссылку на
 * «ошибки за последний час» пересылают коллеге.
 */
export default function OpsPanel() {
  const { ut } = useLang();
  const { can, user } = useAuth();
  const { pathname } = useLocation();
  const isSuper = user?.role === "superadmin";
  const groups = opsGroups(can, isSuper);
  const current = groupOf(pathname, groups.flatMap((g) => g.tabs)) ?? groups[0]?.key;
  const active = groups.find((g) => g.key === current) ?? groups[0];

  /*
   * Два уровня, а не одна строка: разделов больше двадцати, и строка
   * вкладок их не вмещает. Сверху — группы («Система», «Експлуатація»,
   * «Люди й безпека», «Дані й продукт») обычными вкладками консоли; ссылка
   * группы ведёт на её первый доступный раздел. Ниже — разделы открытой
   * группы, ступенью тише (15/700), чтобы уровни не спорили. Реестр —
   * sections.ts, права — там же.
   */
  const groupItems: TabItem[] = groups.map((g) => ({
    to: g.tabs[0]!.to,
    label: ut(g.label),
    active: g.key === active?.key,
  }));

  return (
    <Page title={ut("ops.title")} crumbs={<Tabs items={groupItems} label={ut("ops.title")} />}>
      {active && active.tabs.length > 1 ? (
        <nav aria-label={ut(active.label)} className="-mt-[6px] mb-[22px] overflow-x-auto">
          <ul className="m-0 flex list-none gap-x-[28px] gap-y-[6px] p-0 max-[900px]:flex-wrap">
            {active.tabs.map((t) => (
              <li key={t.to} className="shrink-0">
                <NavLink
                  to={t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    cx(
                      "whitespace-nowrap text-[15px] font-bold leading-[20px] no-underline",
                      "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                      /* как у вкладок консоли: «вы здесь» — светлотой и aria-current, без подчёркивания */
                      isActive ? "text-primary" : "text-primary-dim hover:text-primary",
                    )
                  }
                >
                  {ut(t.key)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <Outlet />
    </Page>
  );
}
