import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { TouchArea } from "../ui/primitives";
import { IconCalendar, IconHome, IconPerson, IconTest } from "./icons";

/**
 * Кабинет пациента.
 *
 * Отдельная оболочка, а не консоль с урезанным меню. Человек, вошедший
 * пациентом, видел рельсу специалиста — «Пациенты», «Очередь работы»,
 * «Случаи риска» — и получал отказ доступа на каждом пункте: интерфейс
 * обещал то, чего не даст. Хуже того, он показывал, что такие экраны
 * существуют, и человек мог решить, что его карту читает кто угодно.
 *
 * Разметка мобильная в первую очередь: телефон, а не окно. Отсюда нижняя
 * полоса вкладок вместо боковой рельсы — большим пальцем достаётся низ
 * экрана, а не левый край, — и одна колонка на любой ширине.
 *
 * Четыре вкладки, и это потолок: пятую на нижней полосе уже не разобрать
 * пальцем, а всё, что не помещается в четыре, человеку в кабинете и не
 * нужно.
 */
export default function PatientApp() {
  const { ut } = useLang();
  const { user } = useAuth();
  const { pathname } = useLocation();

  /*
   * У вкладки две подписи, и это не дублирование.
   *
   * `label` — надпись под значком внизу: там помещается одно слово. `title`
   * — заголовок экрана, который человек слышит и читает первым; ему одного
   * слова мало. «Я» на вкладке понятно рядом со значком человека, а
   * заголовок «Я» не называет ничего.
   */
  const tabs = [
    { to: "/me", end: true, label: ut("pt.home"), title: ut("pt.titleHome"), icon: <IconHome /> },
    { to: "/me/tests", label: ut("pt.tests"), title: ut("pt.titleTests"), icon: <IconTest /> },
    { to: "/me/booking", label: ut("pt.booking"), title: ut("pt.titleBooking"), icon: <IconCalendar /> },
    { to: "/me/profile", label: ut("pt.me"), title: ut("pt.titleProfile"), icon: <IconPerson /> },
  ];

  /*
   * Заголовок экрана берётся из той же таблицы вкладок, что и навигация.
   *
   * Раньше заголовка не было вовсе ни на одном из четырёх экранов: шапка
   * рисовала знак и имя человека, а дальше начинались h2 — на «Тестах» и
   * их не было, весь экран состоял из одного списка. Диктор в таком месте
   * не может ответить на вопрос «где я»: он перечисляет ссылки, и всё.
   *
   * Заголовок стоит здесь, в оболочке, а не на каждом экране, ровно по той
   * же причине, что и высота мишеней: написанное на каждом экране отдельно
   * держится на памяти автора экрана. Новый экран кабинета получает
   * заголовок оттого, что он экран кабинета, — забыть нечего.
   */
  const here = tabs.find((t) => (t.end ? pathname === t.to : pathname.startsWith(t.to))) ?? tabs[0];

  return (
    /*
      Весь кабинет — территория пальца: телефон, одна рука, человек в
      тяжёлом состоянии. Отсюда 44 px у любой мишени внутри, включая чужие
      компоненты вроде переключателя языка. См. TouchArea.
    */
    <TouchArea className="flex min-h-[100dvh] flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-[7px] border border-primary font-display text-caption font-semibold text-primary shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_35%,transparent)]"
        >
          Q
        </span>
        <span className="truncate text-small text-muted">{user?.fullName ?? ""}</span>
      </header>

      {/* pb под высоту полосы вкладок: иначе последняя кнопка экрана под ней */}
      <main className="flex-1 pb-20">
        <h1 className="px-4 pt-4 font-display text-section font-medium tracking-tight">
          {here.title}
        </h1>
        <Outlet />
      </main>

      {/*
        Полоса отступает снизу на безопасную зону.
        Под ней у телефона своя домашняя черта, и вкладка, прижатая к самому
        краю, попадает под неё: нажатие уходит системе, а не приложению.
      */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-hairline bg-rail pb-[max(env(safe-area-inset-bottom),8px)]">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              cx(
                "flex min-h-[48px] flex-1 flex-col items-center justify-center gap-1 py-2 text-micro",
                "transition-colors duration-[var(--dur-fast)]",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                isActive ? "text-primary" : "text-muted",
              )
            }
          >
            <span className="[&>svg]:size-[22px]">{t.icon}</span>
            {t.label}
          </NavLink>
        ))}
      </nav>
    </TouchArea>
  );
}
