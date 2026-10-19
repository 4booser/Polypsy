import { Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { groupOf, opsGroups } from "./model";
import { OpsFrame } from "./parts";
import { ownFrame } from "./people2/frame";

/*
 * Техпанель — экран для разработчиков и того, кто держит сервер.
 *
 * Решение заказчика 2026-09-26: «отдельный дашборд для супер тех админа,
 * чисто для разрабов» — логи, ошибки, нагрузка, число запросов и время
 * ответа, все пользователи с выдачей доступа, созданием и удалением учёток,
 * полный аудит действий.
 *
 * Открывается, если есть хоть одно из трёх прав: ops.read, users.manage,
 * audit.read. Разделы — каждый по своему праву, пустых нет (opsGroups в
 * model.ts, реестр — sections.ts).
 *
 * Навигация по разделам — колонка подразделов оболочки (Polypsy 2.0: index
 * техпанели в наборе «Виразної», shell/nav.ts → subNavFor("ops")): группы
 * «Система», «Експлуатація», «Люди й безпека», «Дані й продукт» подписями,
 * разделы строками под ними, «Адміністрування» назад. Прежде здесь стояли
 * две строки вкладок — группы и разделы открытой группы; колонка вмещает
 * все тридцать разделов сразу, и группа больше не прячет соседние.
 *
 * Здесь остаётся рамка экрана: заголовок раздела над его содержимым.
 * Разделы — адресами (/ops, /ops/requests, …): ссылку на «ошибки за
 * последний час» пересылают коллеге. Мета-строку, действия и полосу
 * инструментов раздел ставит в шапку сам — через <OpsHead> (parts.tsx):
 * рамка даёт им места, а не рисует за раздел.
 */
export default function OpsPanel() {
  const { ut } = useLang();
  const { can, user } = useAuth();
  const { pathname } = useLocation();
  const groups = opsGroups(can, user?.role === "superadmin");
  const tabs = groups.flatMap((g) => g.tabs);
  const group = groupOf(pathname, tabs);
  /* имя открытого раздела — заголовком экрана; трасса запроса и прочие страницы без пункта — «Техпанель» */
  const here = tabs.filter((t) => t.group === group).find((t) => (t.end ? pathname === t.to : pathname.startsWith(t.to)));
  /* «Люди й безпека» и «Дані й продукт» ставят свою рамку: шапка с мета-строкой, правом и действиями */
  if (ownFrame(pathname)) return <Outlet />;
  return (
    <OpsFrame title={here ? ut(here.key) : ut("ops.title")}>
      <Outlet />
    </OpsFrame>
  );
}
