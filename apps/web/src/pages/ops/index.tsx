import { Outlet } from "react-router-dom";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { Page } from "../../ui/layout";
import { Tabs, type TabItem } from "../../ui/primitives";

/*
 * Техпанель — экран для разработчиков и того, кто держит сервер.
 *
 * Решение заказчика 2026-09-26: «отдельный дашборд для супер тех админа,
 * чисто для разрабов» — логи, ошибки, нагрузка, число запросов и время
 * ответа, все пользователи с выдачей доступа, созданием и удалением учёток,
 * полный аудит действий.
 *
 * Открывается по праву ops.read (packages/shared/src/permissions.ts, группа
 * «Технічна служба»): суперадмину оно достаётся вместе со всеми, разработчику
 * его выдают личным исключением. Вкладки о людях — по своим правам:
 * «Користувачі» и «Сесії» по users.manage, «Аудит» по audit.read. Право
 * смотреть, как работает система, не должно открывать ни людей, ни журнал
 * их чтений — это разные работы и выдаются разным людям.
 *
 * Вкладки — адресами (/ops, /ops/requests, …), а не состоянием: ссылку на
 * «ошибки за последний час» пересылают коллеге.
 */
export default function OpsPanel() {
  const { ut } = useLang();
  const { can } = useAuth();

  const items: TabItem[] = [
    { to: "/ops", label: ut("ops.tab.overview"), end: true },
    { to: "/ops/requests", label: ut("ops.tab.requests") },
    { to: "/ops/errors", label: ut("ops.tab.errors") },
    { to: "/ops/logs", label: ut("ops.tab.logs") },
    { to: "/ops/db", label: ut("ops.tab.db") },
    { to: "/ops/jobs", label: ut("ops.tab.jobs") },
    ...(can("users.manage")
      ? [
          { to: "/ops/users", label: ut("ops.tab.users") },
          { to: "/ops/sessions", label: ut("ops.tab.sessions") },
        ]
      : []),
    ...(can("audit.read") ? [{ to: "/ops/audit", label: ut("ops.tab.audit") }] : []),
  ];

  return (
    <Page title={ut("ops.title")} crumbs={<Tabs items={items} label={ut("ops.title")} />}>
      <Outlet />
    </Page>
  );
}
