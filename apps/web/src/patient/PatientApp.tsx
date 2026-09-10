import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
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

  const tabs = [
    { to: "/me", end: true, label: ut("pt.home"), icon: <IconHome /> },
    { to: "/me/tests", label: ut("pt.tests"), icon: <IconTest /> },
    { to: "/me/booking", label: ut("pt.booking"), icon: <IconCalendar /> },
    { to: "/me/profile", label: ut("pt.me"), icon: <IconPerson /> },
  ];

  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg">
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
    </div>
  );
}
