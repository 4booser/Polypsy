import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import SurveyAnalyticsPage from "./pages/SurveyAnalytics";
import Access from "./pages/Access";
import { PatientDynamics, PatientList } from "./pages/Patients";
import Alerts from "./pages/Alerts";
import Audit from "./pages/Audit";
import Compare from "./pages/Compare";
import Schedules from "./pages/Schedules";
import Surveillance from "./pages/Surveillance";
import Constructor from "./pages/constructor";
import { SurveyList } from "./pages/constructor/SurveyList";
import Administer from "./pages/Administer";
import { ConsentText, Groups, Users } from "./pages/Admin";
import Batteries from "./pages/Batteries";
import BlankForm from "./pages/BlankForm";
import Invites from "./pages/Invites";
import Join from "./pages/Join";
import Kiosk from "./pages/Kiosk";
import KioskSessions from "./pages/KioskSessions";
import Norms from "./pages/Norms";
import CaseSummaryPage from "./pages/CaseSummary";
import ReferralsPage from "./pages/Referrals";
import KeyPrint from "./pages/KeyPrint";
import {
  IconAlert,
  IconAudit,
  IconBattery,
  IconClock,
  IconInvite,
  IconReferral,
  IconKiosk,
  IconCompare,
  IconDashboard,
  IconGroup,
  IconPatients,
  IconPulse,
  IconSurvey,
  IconUsers,
} from "./ui";

type Theme = "dark" | "light";

function Nav({
  to,
  end,
  icon,
  badge,
  children,
}: {
  to: string;
  end?: boolean;
  icon: ReactNode;
  badge?: number;
  children: ReactNode;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
      {icon}
      <span className="grow">{children}</span>
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </NavLink>
  );
}

export default function App() {
  const { user, loading, logout } = useAuth();
  const [openAlerts, setOpenAlerts] = useState(0);
  const [openReferrals, setOpenReferrals] = useState(0);
  /*
   * Тема хранится явно: тёмная по умолчанию, но в кабинете при дневном свете
   * она неудобна, а системная настройка на рабочей станции часто не отражает
   * условия конкретного помещения.
   */
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("quizzy.theme") as Theme) ?? "dark",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("quizzy.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!user) return;
    /*
     * Тревоги — единственное в консоли, что должно догонять само: пока
     * email-канал не настроен, поллинг раз в минуту + бейдж на favicon —
     * дежурный видит новую тревогу, даже сидя в другой вкладке.
     */
    const load = () => {
      api.alerts().then((a) => setOpenAlerts(a.length)).catch(() => {});
      // направления в том же такте: незакрытое направление ждёт так же долго
      api.referrals().then((r) => setOpenReferrals(r.length)).catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [user]);

  useEffect(() => {
    paintFavicon(openAlerts);
  }, [openAlerts]);

  // публичные страницы живут вне auth-гейта: у пациента и киоска нет входа
  if (location.pathname.startsWith("/join/") || location.pathname.startsWith("/kiosk/")) {
    return (
      <Routes>
        <Route path="/join/:token" element={<Join />} />
        <Route path="/kiosk/:token" element={<Kiosk />} />
      </Routes>
    );
  }

  if (loading) return <p style={{ padding: 40 }} className="muted">Загрузка…</p>;
  if (!user) return <Login />;

  const isSuper = user.role === "superadmin";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Q</span>
          Quizzy
        </div>

        <Nav to="/" end icon={<IconDashboard />}>Сводка</Nav>
        <Nav to="/surveys" icon={<IconSurvey />}>Методики</Nav>
        <Nav to="/batteries" icon={<IconBattery />}>Батареи</Nav>
        <Nav to="/schedules" icon={<IconClock />}>Расписание</Nav>
        <Nav to="/invites" icon={<IconInvite />}>Приглашения</Nav>
        <Nav to="/kiosk-sessions" icon={<IconKiosk />}>Сеансы киоска</Nav>
        <Nav to="/groups" icon={<IconGroup />}>Группы</Nav>
        <Nav to="/patients" icon={<IconPatients />}>Пациенты</Nav>
        <Nav to="/compare" icon={<IconCompare />}>Сравнение</Nav>
        <Nav to="/surveillance" icon={<IconPulse />}>Надзор</Nav>
        <Nav to="/alerts" icon={<IconAlert />} badge={openAlerts}>Тревоги</Nav>
        <Nav to="/referrals" icon={<IconReferral />} badge={openReferrals}>Направления</Nav>

        {isSuper ? (
          <>
            <div className="nav-section">Администрирование</div>
            <Nav to="/users" icon={<IconUsers />}>Учётные записи</Nav>
            <Nav to="/audit" icon={<IconAudit />}>Журнал доступа</Nav>
          </>
        ) : null}

        <div style={{ flex: 1 }} />
        <button
          className="ghost"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          style={{ width: "100%", justifyContent: "flex-start" }}
        >
          {theme === "dark" ? "☀ Светлая тема" : "☾ Тёмная тема"}
        </button>
        <div className="nav-section" style={{ paddingBottom: 2 }}>
          {user.fullName}
        </div>
        <div className="muted" style={{ fontSize: 11, padding: "0 10px 8px" }}>
          {user.role === "superadmin" ? "Суперадминистратор" : "Администратор группы"}
        </div>
        <button className="ghost" onClick={logout} style={{ width: "100%", justifyContent: "flex-start" }}>
          Выйти
        </button>
        <span className="build-tag" title={`Сборка от ${__BUILD_DATE__}`}>
          {__BUILD_SHA__}
        </span>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/surveys" element={<SurveyList />} />
          <Route path="/surveys/:id" element={<SurveyAnalyticsPage />} />
          <Route path="/surveys/:id/administer" element={<Administer />} />
          <Route path="/surveys/:id/key" element={<KeyPrint />} />
          <Route path="/surveys/:id/norms" element={<Norms />} />
          <Route path="/surveys/:id/blank" element={<BlankForm />} />
          <Route path="/constructor" element={<Constructor />} />
          <Route path="/constructor/:id" element={<Constructor />} />
          <Route path="/surveys/:id/access" element={<Access />} />
          <Route path="/patients" element={<PatientList />} />
          <Route path="/patients/:userId" element={<PatientDynamics />} />
          <Route path="/patients/:userId/summary" element={<CaseSummaryPage />} />
          <Route path="/referrals" element={<ReferralsPage />} />
          <Route path="/batteries" element={<Batteries />} />
          <Route path="/invites" element={<Invites />} />
          <Route path="/kiosk-sessions" element={<KioskSessions />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/surveillance" element={<Surveillance />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/groups" element={<Groups />} />
          {isSuper ? <Route path="/users" element={<><Users /><ConsentText /></>} /> : null}
          {isSuper ? <Route path="/audit" element={<Audit />} /> : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** Favicon с числом открытых тревог: видно из любой вкладки */
function paintFavicon(count: number): void {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // базовый знак
  ctx.fillStyle = "#3b5bfd";
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 18px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Q", 16, 17);

  if (count > 0) {
    ctx.fillStyle = "#d03b3b";
    ctx.beginPath();
    ctx.arc(24, 8, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px system-ui";
    ctx.fillText(count > 9 ? "9+" : String(count), 24, 9);
  }

  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = canvas.toDataURL("image/png");
}
