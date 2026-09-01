import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { CrisisBar, CrisisProvider, CrisisSwitch } from "./components/CrisisBar";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import { useLang } from "./lang";
import Login from "./pages/Login";
import { Topbar } from "./shell/Topbar";
import { Rail } from "./shell/Rail";
import { Button, Field, Select, Tag } from "./ui/primitives";
import { CommandPalette } from "./shell/CommandPalette";
import { onAppEvent } from "./events";
import type { WorkspacePrefs } from "@quizzy/shared";
import Dashboard from "./pages/Dashboard";
import { PatientDynamics, PatientList } from "./pages/Patients";
import Alerts from "./pages/Alerts";
import { Loading } from "./ui";

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
const Permissions = lazy(() => import("./pages/Permissions"));
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
const InformantForm = lazy(() => import("./pages/InformantForm"));
const Kiosk = lazy(() => import("./pages/Kiosk"));
const KioskSessions = lazy(() => import("./pages/KioskSessions"));
const Norms = lazy(() => import("./pages/Norms"));
const CaseSummaryPage = lazy(() => import("./pages/CaseSummary"));
const ReferralsPage = lazy(() => import("./pages/Referrals"));
const ApiDocs = lazy(() => import("./pages/ApiDocs"));
const WorklistPage = lazy(() => import("./pages/Worklist"));
const TodayPage = lazy(() => import("./pages/Today"));
const SchedulePage = lazy(() => import("./pages/Schedule"));
const VisitPage = lazy(() => import("./pages/Visit"));
const DepartmentReportPage = lazy(() => import("./pages/DepartmentReport"));
const MessagesPage = lazy(() => import("./pages/Messages"));
const UnitReportPage = lazy(() => import("./pages/UnitReport"));
const ConclusionBatch = lazy(() => import("./pages/ConclusionBatch"));
const Cohorts = lazy(() => import("./pages/Cohorts"));
const SearchPage = lazy(() => import("./pages/Search"));
const UiKit = lazy(() => import("./pages/UiKit"));
const Timeline = lazy(() => import("./pages/Timeline"));
const Pathways = lazy(() => import("./pages/Pathways"));
const PathwayEditor = lazy(() => import("./pages/PathwayEditor"));
const PathwayDetail = lazy(() => import("./pages/Pathways").then((m) => ({ default: m.PathwayDetailPage })));
const KeyPrint = lazy(() => import("./pages/KeyPrint"));

type Theme = "dark" | "light";
type Density = "cozy" | "compact";

/**
 * Что показывать на корневом адресе.
 *
 * Неизвестное значение молча превращается в сводку: настройка приходит с
 * сервера, а сервер может оказаться новее консоли — падать из-за этого не за
 * что.
 */
function StartScreen({ prefs }: { prefs: WorkspacePrefs | null }) {
  switch (prefs?.startScreen) {
    case "worklist":
      return <WorklistPage />;
    case "alerts":
      return <Alerts />;
    case "patients":
      return <PatientList />;
    default:
      return <Dashboard />;
  }
}

export default function App() {
  const { user, loading, logout, refreshUser } = useAuth();
  const { ut } = useLang();
  const [openAlerts, setOpenAlerts] = useState(0);
  const [openReferrals, setOpenReferrals] = useState(0);
  const [worklistCount, setWorklistCount] = useState(0);
  const [todayLeft, setTodayLeft] = useState(0);
  /*
   * Тема хранится явно: тёмная по умолчанию, но в кабинете при дневном свете
   * она неудобна, а системная настройка на рабочей станции часто не отражает
   * условия конкретного помещения.
   */
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("quizzy.theme") as Theme) ?? "dark",
  );
  /*
   * Плотность — не косметика: в плотном режиме на экран помещается 24 строки
   * вместо 14, а разбор случаев — это чтение списка. Держится в профиле
   * рабочего места, потому что зависит от монитора, а не от человека.
   */
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem("quizzy.density") as Density) ?? "cozy",
  );
  const [railOpen, setRailOpen] = useState(() => {
    // на узком экране рельса перекрывает содержимое, поэтому стартует закрытой
    if (window.matchMedia("(max-width: 900px)").matches) return false;
    return localStorage.getItem("quizzy.rail") !== "0";
  });
  const [paletteOpen, setPaletteOpen] = useState(false);

  /*
   * Настройки рабочего места приходят с профилем и перекрывают локальные.
   *
   * Сотрудник садится за разные машины в отделении, и «моя тема» не должна
   * означать «тема этого компьютера». Локальная копия остаётся: она отвечает
   * за то, чтобы консоль не мигнула чужим оформлением, пока летит запрос за
   * профилем.
   */
  const applied = useRef(false);
  useEffect(() => {
    if (!user?.workspace || applied.current) return;
    applied.current = true;
    if (user.workspace.theme) setTheme(user.workspace.theme);
    if (user.workspace.density) setDensity(user.workspace.density);
  }, [user]);

  /*
   * Сохранение — только после того, как серверные настройки применены.
   * Иначе первый же рендер отправлял бы на сервер локальное значение и
   * затирал им то, что человек настроил на другой машине.
   */
  const persist = (prefs: Parameters<typeof api.saveWorkspace>[0]) => {
    if (!user || !applied.current) return;
    void api.saveWorkspace(prefs).catch(() => {
      /* настройка рабочего места — удобство: её отказ ничего не ломает */
    });
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("quizzy.theme", theme);
    persist({ theme });
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem("quizzy.density", density);
    persist({ density });
  }, [density]);

  useEffect(() => {
    localStorage.setItem("quizzy.rail", railOpen ? "1" : "0");
  }, [railOpen]);

  // ⌘K — единственный вход в поиск; в поле ввода не перехватываем
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      /*
       * В бейдже — сколько ещё не принято, а не сколько записано. Число,
       * которое не убывает по ходу дня, ничего не сообщает: к обеду оно то
       * же самое, что утром, и смотреть на него перестают.
       */
      api
        .today()
        .then((d) =>
          setTodayLeft(
            d.items.filter((a) => a.status === "booked" || a.status === "confirmed").length,
          ),
        )
        .catch(() => {});
    };
    load();
    /*
     * Таймер остаётся страховкой: поток событий может не пройти через
     * корпоративный прокси, и тогда счётчики обновляются как прежде — раз в
     * минуту. Реальное время здесь ускорение, а не единственный путь.
     */
    const timer = setInterval(load, 60_000);
    const off = onAppEvent((e) => {
      if (e.kind === "alert.created" || e.kind === "case.changed") load();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [user]);

  useEffect(() => {
    paintFavicon(openAlerts);
  }, [openAlerts]);

  // публичные страницы живут вне auth-гейта: у пациента и киоска нет входа
  if (
    location.pathname.startsWith("/join/") ||
    location.pathname.startsWith("/kiosk/") ||
    location.pathname.startsWith("/informant/")
  ) {
    return (
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/join/:token" element={<Join />} />
          <Route path="/kiosk/:token" element={<Kiosk />} />
          <Route path="/informant/:token" element={<InformantForm />} />
        </Routes>
      </Suspense>
    );
  }

  if (loading) return <div style={{ padding: 40 }}><Loading rows={3} /></div>;
  if (!user) return <Login />;

  const isSuper = user.role === "superadmin";

  return (
    <CrisisProvider>
    <div className="flex min-h-screen">
      <Rail counts={{ today: todayLeft, worklist: worklistCount, alerts: openAlerts, referrals: openReferrals }} isSuper={isSuper} collapsed={!railOpen}>
        <div className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3">
          {railOpen ? (
            <>
              <div className="px-1">
                <div className="truncate text-small font-medium text-text">{user.fullName}</div>
                <div className="text-micro text-faint">
                  {user.role === "superadmin" ? ut("nav.roleSuper") : ut("nav.roleAdmin")}
                </div>
              </div>
              {user.readOnly ? (
                /*
                  Человек должен понимать, почему кнопки не срабатывают, до
                  того как решит, что консоль сломана.
                */
                <Tag tone="attention" className="self-start">{ut("nav.readOnly")}</Tag>
              ) : null}

              {/*
                Стартовый экран. Дежурному нужна сводка, а тому, кто весь день
                разбирает случаи, — очередь: попадать каждый раз не туда стоит
                лишнего нажатия в начале каждой смены.
              */}
              <Field label={ut("ws.startScreen")} htmlFor="start-screen">
                <Select
                  id="start-screen"
                  value={user.workspace?.startScreen ?? "dashboard"}
                  onChange={(e) => {
                    const value = e.target.value as NonNullable<WorkspacePrefs["startScreen"]>;
                    void api.saveWorkspace({ startScreen: value }).then(refreshUser).catch(() => {});
                  }}
                >
                  <option value="dashboard">{ut("nav.dashboard")}</option>
                  <option value="worklist">{ut("nav.worklist")}</option>
                  <option value="alerts">{ut("nav.cases")}</option>
                  <option value="patients">{ut("nav.patients")}</option>
                </Select>
              </Field>
            </>
          ) : null}

          <Button variant="quiet" size="sm" onClick={logout} className={railOpen ? "justify-start" : "justify-center px-0"}>
            {railOpen ? (
              ut("nav.logout")
            ) : (
              /*
                Значок нарисован, а не набран символом ⏻: шрифты подключены
                подмножествами, и его там нет — браузер подставил бы запасную
                гарнитуру, а какую именно, зависит от машины.
              */
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                <path d="M12 4v8" />
                <path d="M7.5 7a7 7 0 1 0 9 0" />
              </svg>
            )}
          </Button>
          {railOpen ? (
            <span className="px-1 font-mono text-micro text-faint" title={`${ut("ui.buildFrom")} ${__BUILD_DATE__}`}>
              {__BUILD_SHA__}
            </span>
          ) : null}
        </div>
      </Rail>

      <div className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar
          right={<CrisisSwitch canSwitch={isSuper} />}
          onSearch={() => setPaletteOpen(true)}
          onToggleRail={() => setRailOpen((v) => !v)}
          railOpen={railOpen}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
          density={density}
          onToggleDensity={() => setDensity(density === "compact" ? "cozy" : "compact")}
        />
        <CrisisBar canSwitch={isSuper} />
        <main className="main">
        {/*
          Пока догружается экран, на его месте стоит скелет — то же, что при
          загрузке данных. Пустой прямоугольник или прыжок содержимого
          выглядели бы поломкой.
        */}
        <Suspense fallback={<Loading rows={5} />}>
          <Routes>
          {/*
            Стартовый экран настраивается: дежурному нужна сводка, а тому, кто
            весь день разбирает случаи, — очередь. Замена происходит здесь, а
            не перенаправлением после входа: перенаправление добавляло бы
            лишнюю запись в историю браузера, и «назад» возвращало бы на пустой
            экран.
          */}
          <Route path="/" element={<StartScreen prefs={user?.workspace ?? null} />} />
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
          <Route path="/patients/:userId/timeline" element={<Timeline />} />
          <Route path="/referrals" element={<ReferralsPage />} />
          <Route path="/pathways" element={<Pathways />} />
          <Route path="/pathways/new" element={<PathwayEditor />} />
          <Route path="/pathways/:id" element={<PathwayDetail />} />
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
            <Route path="/today" element={<TodayPage />} />
            <Route path="/my-schedule" element={<SchedulePage />} />
            <Route path="/visit/:id" element={<VisitPage />} />
            <Route path="/department-report" element={<DepartmentReportPage />} />
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/messages/:id" element={<MessagesPage />} />
            <Route path="/unit-report" element={<UnitReportPage />} />
            <Route path="/conclusion-batch" element={<ConclusionBatch />} />
            <Route path="/cohorts" element={<Cohorts />} />
            <Route path="/search" element={<SearchPage />} />
          <Route path="/groups" element={<Groups />} />
          {/*
            Учётки и текст согласия — два отдельных маршрута, а не два экрана
            на одном.

            Раньше они склеивались фрагментом. Это было тесно и до переделки —
            два заголовка первого уровня на одной странице, — а с новой рамкой
            стало опасно: экран занимает свою область целиком, и из двух
            соседей второй молча закрыл бы первого. Ошибка была бы тихой:
            разметка на месте, ошибок в консоли нет, а половина страницы
            недостижима.
          */}
          {isSuper ? <Route path="/users" element={<Users />} /> : null}
          {isSuper ? <Route path="/permissions" element={<Permissions />} /> : null}
          {isSuper ? <Route path="/consent-text" element={<ConsentText />} /> : null}
          {isSuper ? <Route path="/audit" element={<Audit />} /> : null}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        onToggleDensity={() => setDensity(density === "compact" ? "cozy" : "compact")}
      />
    </div>
    </CrisisProvider>
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
