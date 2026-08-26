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
import Constructor, { SurveyList } from "./pages/Constructor";
import Administer from "./pages/Administer";
import { Groups, Users } from "./pages/Admin";
import Batteries from "./pages/Batteries";
import BlankForm from "./pages/BlankForm";
import Invites from "./pages/Invites";
import Join from "./pages/Join";
import KeyPrint from "./pages/KeyPrint";
import {
  IconAlert,
  IconAudit,
  IconBattery,
  IconClock,
  IconInvite,
  IconCompare,
  IconDashboard,
  IconGroup,
  IconPatients,
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
    api.alerts().then((a) => setOpenAlerts(a.length)).catch(() => setOpenAlerts(0));
  }, [user]);

  // публичная страница приглашения живёт вне auth-гейта: у пациента нет входа
  if (location.pathname.startsWith("/join/")) {
    return (
      <Routes>
        <Route path="/join/:token" element={<Join />} />
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
        <Nav to="/groups" icon={<IconGroup />}>Группы</Nav>
        <Nav to="/patients" icon={<IconPatients />}>Пациенты</Nav>
        <Nav to="/compare" icon={<IconCompare />}>Сравнение</Nav>
        <Nav to="/alerts" icon={<IconAlert />} badge={openAlerts}>Тревоги</Nav>

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
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/surveys" element={<SurveyList />} />
          <Route path="/surveys/:id" element={<SurveyAnalyticsPage />} />
          <Route path="/surveys/:id/administer" element={<Administer />} />
          <Route path="/surveys/:id/key" element={<KeyPrint />} />
          <Route path="/surveys/:id/blank" element={<BlankForm />} />
          <Route path="/constructor" element={<Constructor />} />
          <Route path="/constructor/:id" element={<Constructor />} />
          <Route path="/surveys/:id/access" element={<Access />} />
          <Route path="/patients" element={<PatientList />} />
          <Route path="/patients/:userId" element={<PatientDynamics />} />
          <Route path="/batteries" element={<Batteries />} />
          <Route path="/invites" element={<Invites />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/groups" element={<Groups />} />
          {isSuper ? <Route path="/users" element={<Users />} /> : null}
          {isSuper ? <Route path="/audit" element={<Audit />} /> : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
