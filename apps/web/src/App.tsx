import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import { LangSwitch, useLang } from "./lang";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import { PatientDynamics, PatientList } from "./pages/Patients";
import Alerts from "./pages/Alerts";
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
  IconSurvey,
  IconUsers,
  Loading,
} from "./ui";

/*
 * Экраны догружаются по требованию.
 *
 * Собранная консоль весила 565 КБ одним файлом: человек, открывший список
 * случаев, тянул вместе с ним конструктор методик, печатные бланки, киоск и
 * витрину компонентов — всё, чем он сегодня не пользуется.
 *
 * Сразу грузятся только вход, сводка, случаи и пациенты: по ним заходят
 * каждый день, и подгрузка на них была бы заметной задержкой, а не
 * экономией.
 */
const SurveyAnalyticsPage = lazy(() => import("./pages/SurveyAnalytics"));
const Access = lazy(() => import("./pages/Access"));
const Audit = lazy(() => import("./pages/Audit"));
const Compare = lazy(() => import("./pages/Compare"));
const Schedules = lazy(() => import("./pages/Schedules"));
const Surveillance = lazy(() => import("./pages/Surveillance"));
const Constructor = lazy(() => import("./pages/constructor"));
const SurveyList = lazy(() => import("./pages/constructor/SurveyList").then((m) => ({ default: m.SurveyList })));
const Administer = lazy(() => import("./pages/Administer"));
const ConsentText = lazy(() => import("./pages/Admin").then((m) => ({ default: m.ConsentText })));
const Groups = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Groups })));
const Users = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Users })));
const Batteries = lazy(() => import("./pages/Batteries"));
const BlankForm = lazy(() => import("./pages/BlankForm"));
const Invites = lazy(() => import("./pages/Invites"));
const Join = lazy(() => import("./pages/Join"));
const Kiosk = lazy(() => import("./pages/Kiosk"));
const KioskSessions = lazy(() => import("./pages/KioskSessions"));
const Norms = lazy(() => import("./pages/Norms"));
const CaseSummaryPage = lazy(() => import("./pages/CaseSummary"));
const ReferralsPage = lazy(() => import("./pages/Referrals"));
const ApiDocs = lazy(() => import("./pages/ApiDocs"));
const WorklistPage = lazy(() => import("./pages/Worklist"));
const UnitReportPage = lazy(() => import("./pages/UnitReport"));
const UiKit = lazy(() => import("./pages/UiKit"));
const KeyPrint = lazy(() => import("./pages/KeyPrint"));

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
  const { ut } = useLang();
  const [openAlerts, setOpenAlerts] = useState(0);
  const [openReferrals, setOpenReferrals] = useState(0);
  const [worklistCount, setWorklistCount] = useState(0);
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
      // счётчик считает случаи, а не сработавшие пункты: в навигации должно
      // стоять число людей, которых надо разобрать, а не число сигналов
      api.alertCases({ limit: "1" }).then((p) => setOpenAlerts(p.total ?? 0)).catch(() => {});
      // направления в том же такте: незакрытое направление ждёт так же долго
      api.referrals().then((r) => setOpenReferrals(r.items.length)).catch(() => {});
      api.worklist().then((w) => setWorklistCount(w.total)).catch(() => {});
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
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/join/:token" element={<Join />} />
          <Route path="/kiosk/:token" element={<Kiosk />} />
        </Routes>
      </Suspense>
    );
  }

  if (loading) return <div style={{ padding: 40 }}><Loading rows={3} /></div>;
  if (!user) return <Login />;

  const isSuper = user.role === "superadmin";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Q</span>
          Quizzy
        </div>

        <Nav to="/" end icon={<IconDashboard />}>{ut("nav.dashboard")}</Nav>
        {/* очередь сразу под сводкой: с неё начинается рабочий день */}
        <Nav to="/worklist" icon={<IconClock />} badge={worklistCount}>{ut("nav.worklist")}</Nav>
        <Nav to="/surveys" icon={<IconSurvey />}>{ut("nav.surveys")}</Nav>
        <Nav to="/batteries" icon={<IconBattery />}>{ut("nav.batteries")}</Nav>
        <Nav to="/schedules" icon={<IconClock />}>{ut("nav.schedules")}</Nav>
        <Nav to="/invites" icon={<IconInvite />}>{ut("nav.invites")}</Nav>
        <Nav to="/kiosk-sessions" icon={<IconKiosk />}>{ut("nav.kiosk")}</Nav>
        <Nav to="/groups" icon={<IconGroup />}>{ut("nav.groups")}</Nav>
        <Nav to="/patients" icon={<IconPatients />}>{ut("nav.patients")}</Nav>
        <Nav to="/compare" icon={<IconCompare />}>{ut("nav.compare")}</Nav>
        <Nav to="/surveillance" icon={<IconPulse />}>{ut("nav.surveillance")}</Nav>
        <Nav to="/unit-report" icon={<IconGroup />}>{ut("nav.unitReport")}</Nav>
        <Nav to="/alerts" icon={<IconAlert />} badge={openAlerts}>{ut("nav.cases")}</Nav>
        <Nav to="/referrals" icon={<IconReferral />} badge={openReferrals}>{ut("nav.referrals")}</Nav>

        {isSuper ? (
          <>
            <div className="nav-section">{ut("nav.admin")}</div>
            <Nav to="/users" icon={<IconUsers />}>{ut("nav.users")}</Nav>
            <Nav to="/audit" icon={<IconAudit />}>{ut("nav.audit")}</Nav>
            <Nav to="/api-docs" icon={<IconSurvey />}>{ut("nav.api")}</Nav>
            <Nav to="/ui" icon={<IconDashboard />}>{ut("nav.ui")}</Nav>
          </>
        ) : null}

        <div style={{ flex: 1 }} />
        <button
          className="ghost"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          style={{ width: "100%", justifyContent: "flex-start" }}
        >
          {theme === "dark" ? `☀ ${ut("nav.themeLight")}` : `☾ ${ut("nav.themeDark")}`}
        </button>
        {/* язык рядом с темой: обе настройки про то, как выглядит консоль */}
        <div style={{ padding: "0 10px 8px" }}>
          <LangSwitch />
        </div>
        <div className="nav-section" style={{ paddingBottom: 2 }}>
          {user.fullName}
        </div>
        {user.readOnly ? (
          // человек должен понимать, почему кнопки не срабатывают, до того
          // как решит, что консоль сломана
          <div className="muted" style={{ fontSize: 11, padding: "0 10px 4px" }}>
            {ut("nav.readOnly")}
          </div>
        ) : null}
        <div className="muted" style={{ fontSize: 11, padding: "0 10px 8px" }}>
          {user.role === "superadmin" ? ut("nav.roleSuper") : ut("nav.roleAdmin")}
        </div>
        <button className="ghost" onClick={logout} style={{ width: "100%", justifyContent: "flex-start" }}>
          {ut("nav.logout")}
        </button>
        <span className="build-tag" title={`Сборка от ${__BUILD_DATE__}`}>
          {__BUILD_SHA__}
        </span>
      </aside>

      <main className="main">
        {/*
          Пока догружается экран, на его месте стоит скелет — то же, что при
          загрузке данных. Пустой прямоугольник или прыжок содержимого
          выглядели бы поломкой.
        */}
        <Suspense fallback={<Loading rows={5} />}>
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
          <Route path="/api-docs" element={<ApiDocs />} />
          <Route path="/ui" element={<UiKit />} />
          <Route path="/batteries" element={<Batteries />} />
          <Route path="/invites" element={<Invites />} />
          <Route path="/kiosk-sessions" element={<KioskSessions />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/surveillance" element={<Surveillance />} />
          <Route path="/alerts" element={<Alerts />} />
            <Route path="/worklist" element={<WorklistPage />} />
            <Route path="/unit-report" element={<UnitReportPage />} />
          <Route path="/groups" element={<Groups />} />
          {isSuper ? <Route path="/users" element={<><Users /><ConsentText /></>} /> : null}
          {isSuper ? <Route path="/audit" element={<Audit />} /> : null}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
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
