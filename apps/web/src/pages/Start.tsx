import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Outlet, useLocation } from "react-router-dom";
import { Page } from "../ui/layout";
import { Tabs } from "../ui/primitives";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { useShellNav } from "../shell/useShellNav";

/**
 * «Зведення» — рамка начала смены: огляд, приём дня и приглашения вкладками
 * одного экрана (решение заказчика 2026-09-26, кадры day-start, day-today,
 * day-invites Polypsy 2.0).
 *
 * Заголовок называет экран и стоит один на три вкладки, вкладки — строкой
 * под ним. Мета-строка и действия справа у каждой вкладки свои: у огляду —
 * дата и «Налаштувати зведення», у дня — дата, сколько сессий и листание
 * дней, у приглашений — сколько их действует и «Створити запрошення». Их
 * рисует сама вкладка через `StartHead`: данные для этих строк есть только у
 * неё, а прокидывать их наверх значило бы грузить их дважды.
 *
 * Стартовым экраном может быть и не огляд (настройка рабочего места:
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

/** Стоит ли на этом адресе рамка: на «/» — только когда стартовый экран — огляд */
export function framed(pathname: string, startScreen: string | undefined): boolean {
  if (pathname !== "/") return true;
  return !startScreen || startScreen === "dashboard";
}

export default function Start() {
  const { ut } = useLang();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const nav = useShellNav();
  const [meta, setMeta] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);

  if (!framed(pathname, user?.workspace?.startScreen)) return <Outlet />;

  /*
   * Вкладка приглашений стоит не у всех: её показывает право с сервера.
   * Спрятать её от того, кому сервер откажет, честнее, чем дать нажать и
   * показать отказ, — а сам отказ проверяется на маршруте, а не здесь.
   *
   * Число у «Сьогодні» — сколько людей ещё ждут (тот же счётчик, что у
   * оболочки): число записанных к обеду не меняется и перестаёт что-то
   * сообщать.
   */
  const waiting = nav?.counts.today;
  const items = [
    { to: "/", label: ut("dash.tabOverview"), end: true },
    { to: "/today", label: ut("day.title"), count: waiting ? waiting : null },
    ...(user?.canInvite ? [{ to: "/invites", label: ut("inv.title") }] : []),
  ];

  return (
    <SlotsCtx.Provider value={{ meta, actions }}>
      <Page
        title={ut("dash.title")}
        meta={<span ref={setMeta} className="contents" />}
        actions={<span ref={setActions} className="contents" />}
        toolbar={<Tabs label={ut("dash.title")} items={items} />}
      >
        <Outlet />
      </Page>
    </SlotsCtx.Provider>
  );
}
