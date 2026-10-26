import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Outlet, useLocation, useSearchParams } from "react-router-dom";
import { Loading } from "../ui";
import { Page } from "../ui/layout";
import { Tabs } from "../ui/primitives";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { overviewHref } from "../shell/nav";
import { useShellNav } from "../shell/useShellNav";

export { overviewHref };

/**
 * «Сьогодні» — рамка начала смены: зведення, приём дня и приглашения
 * вкладками одного экрана (решение заказчика 2026-09-26, кадры day-start,
 * day-today, day-invites Polypsy 2.0).
 *
 * Заголовок — то же слово, что у пункта рельсы: нажал «Сьогодні» — видишь
 * «Сьогодні». Вкладки названы по тому, что на них: «Зведення» (віджети; то
 * же слово, что у «Налаштувати зведення» и у стартового экрана в
 * настройках), «Прийом» (день приёма: у него листание дней, и вкладка
 * «Сьогодні» на завтрашнем дне говорила бы неправду) и «Запрошення».
 * Заголовок не повторяет вкладку, и двух разных «Сьогодні» на экране нет.
 *
 * Мета-строка и действия справа у каждой вкладки свои: у зведення — счёт
 * открытого и «Налаштувати зведення», у дня — сколько сессий и листание
 * дней, у приглашений — сколько их действует и «Створити запрошення». Их
 * рисует сама вкладка через `StartHead`: данные для этих строк есть только у
 * неё, а прокидывать их наверх значило бы грузить их дважды.
 *
 * Стартовым экраном может быть и не зведення (настройка рабочего места:
 * черга, випадки ризику, пацієнти). Тогда на «/» стоит тот экран со своей
 * шапкой, и рамка отступает: два заголовка друг над другом читались бы как
 * сбой, а у списка-и-записи своя раскладка во всю высоту.
 */

interface Slots {
  meta: HTMLElement | null;
  actions: HTMLElement | null;
}

const SlotsCtx = createContext<Slots | null>(null);

/**
 * Мета-строка и действия вкладки — в шапку рамки. Вне рамки (вкладка стоит
 * стартовым экраном сама по себе) ничего не рисует.
 */
export function StartHead({ meta, actions }: { meta?: ReactNode; actions?: ReactNode }) {
  const slots = useContext(SlotsCtx);
  if (!slots) return null;
  return (
    <>
      {slots.meta && meta ? createPortal(meta, slots.meta) : null}
      {slots.actions && actions ? createPortal(actions, slots.actions) : null}
    </>
  );
}

/** Стоит ли на этом адресе рамка: на «/» — только когда стартовый экран — зведення */
export function framed(pathname: string, startScreen: string | undefined, view?: string | null): boolean {
  if (pathname !== "/" || view === "overview") return true;
  return !startScreen || startScreen === "dashboard";
}

const Overview = lazy(() => import("./Dashboard"));

export default function Start() {
  const { ut } = useLang();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const nav = useShellNav();
  const [meta, setMeta] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const start = user?.workspace?.startScreen;
  /* зведення по ссылке вкладки, когда на «/» стоит другой стартовый экран */
  const overview = pathname === "/" && params.get("view") === "overview" && !!start && start !== "dashboard";

  if (!framed(pathname, start, params.get("view"))) return <Outlet />;

  /*
   * Вкладка приглашений стоит не у всех: её показывает право с сервера.
   * Спрятать её от того, кому сервер откажет, честнее, чем дать нажать и
   * показать отказ, — а сам отказ проверяется на маршруте, а не здесь.
   *
   * Число у «Прийом» — сколько людей ещё ждут (тот же счётчик, что у
   * оболочки): число записанных к обеду не меняется и перестаёт что-то
   * сообщать.
   */
  const waiting = nav?.counts.today;
  const items = [
    { to: overviewHref(start), label: ut("dash.title"), end: true },
    { to: "/today", label: ut("home.agenda"), count: waiting ? waiting : null },
    ...(user?.canInvite ? [{ to: "/invites", label: ut("inv.title") }] : []),
  ];

  return (
    <SlotsCtx.Provider value={{ meta, actions }}>
      <Page
        title={ut("day.title")}
        meta={<span ref={setMeta} className="contents" />}
        actions={<span ref={setActions} className="contents" />}
        toolbar={<Tabs label={ut("day.title")} items={items} />}
      >
        {overview ? (
          <Suspense fallback={<Loading rows={5} />}>
            <Overview />
          </Suspense>
        ) : (
          <Outlet />
        )}
      </Page>
    </SlotsCtx.Provider>
  );
}
