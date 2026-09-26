import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { api, tokenStore } from "./api";
import { useAuth } from "./auth";
import { useLang } from "./lang";
import Login from "./pages/Login";
import { Topbar, barKind, type BurgerAccount } from "./shell/Topbar";
import { CommandPalette } from "./shell/CommandPalette";
import { onAppEvent } from "./events";
import type { WorkspacePrefs } from "@quizzy/shared";
import Dashboard from "./pages/Dashboard";
import { PatientDynamics, PatientList } from "./pages/Patients";
import { peopleLists } from "./pages/people/model";
import Alerts from "./pages/Alerts";
import { Loading, useAction } from "./ui";

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
/* техпанель: оболочка и вкладки — каждая своим куском, панель тяжёлая и нужна немногим */
const OpsPanel = lazy(() => import("./pages/ops"));
const OpsOverview = lazy(() => import("./pages/ops/Overview"));
const OpsRequests = lazy(() => import("./pages/ops/Requests"));
const OpsErrors = lazy(() => import("./pages/ops/Errors"));
const OpsLogs = lazy(() => import("./pages/ops/Logs"));
const OpsDatabase = lazy(() => import("./pages/ops/Database"));
const OpsJobs = lazy(() => import("./pages/ops/Jobs"));
const OpsUsers = lazy(() => import("./pages/ops/Users"));
const OpsSessions = lazy(() => import("./pages/ops/Sessions"));
const OpsAuditLog = lazy(() => import("./pages/ops/AuditLog"));
/* техпанель, безопасность: ключи, целостность, SQL на чтение — только суперадмину */
const OpsSecKeys = lazy(() => import("./pages/ops/sec/Keys"));
const OpsSecIntegrity = lazy(() => import("./pages/ops/sec/Integrity"));
const OpsSecSql = lazy(() => import("./pages/ops/sec/Sql"));
const Constructor = lazy(() => import("./pages/constructor"));
const SurveyList = lazy(() => import("./pages/constructor/SurveyList").then((m) => ({ default: m.SurveyList })));
const Administer = lazy(() => import("./pages/Administer"));
const ConsentText = lazy(() => import("./pages/Admin").then((m) => ({ default: m.ConsentText })));
const Groups = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Groups })));
/* группы ПАЦИЕНТОВ — раздел «Групи» верхней полосы; /groups выше — группы методик */
const PatientGroups = lazy(() => import("./pages/patientGroups/PatientGroups"));
const PatientGroupCard = lazy(() => import("./pages/patientGroups/PatientGroupCard"));
const Users = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Users })));
const Batteries = lazy(() => import("./pages/Batteries"));
const BlankForm = lazy(() => import("./pages/BlankForm"));
const Invites = lazy(() => import("./pages/Invites"));
const Join = lazy(() => import("./pages/Join"));
const GoogleReturn = lazy(() => import("./pages/GoogleReturn"));
const Norms = lazy(() => import("./pages/Norms"));
const CaseSummaryPage = lazy(() => import("./pages/CaseSummary"));
const CaseCard = lazy(() => import("./pages/CaseCard"));
const PatientCard = lazy(() => import("./pages/patientCard/PatientCard"));
const Start = lazy(() => import("./pages/Start"));
const Account = lazy(() => import("./pages/Account"));
/* кабинет пациента: отдельная оболочка, а не консоль с урезанным меню */
const PatientApp = lazy(() => import("./patient/PatientApp"));
const PatientHome = lazy(() => import("./patient/Home"));
const PatientTests = lazy(() => import("./patient/Tests"));
const PatientBooking = lazy(() => import("./patient/Booking"));
const PatientProfile = lazy(() => import("./patient/Profile"));
const Runner = lazy(() => import("./patient/Runner"));
/*
 * Лендинг «Про кампанію» (кадр f00) — то, что видит гость на корне до входа.
 * Догружается: сотрудник, у которого есть сессия, его не увидит никогда, а
 * вход остаётся в общей сборке — через него проходят каждый день.
 */
const Landing = lazy(() => import("./pages/public/Landing"));

/**
 * Прежние адреса клинической карты — /summary, /dynamics, /timeline — ведут
 * на неё же по новому адресу /patients/:id/case…: на /summary ссылается
 * очередь работы с сервера (routes/worklist.ts), на два других — закладки.
 */
function RedirectToCase({ tab = "" }: { tab?: string }) {
  const { userId } = useParams<{ userId: string }>();
  return <Navigate to={`/patients/${userId}/case${tab}`} replace />;
}
const ReferralsPage = lazy(() => import("./pages/Referrals"));
const ApiDocs = lazy(() => import("./pages/ApiDocs"));
const Console = lazy(() => import("./pages/Console"));
const WorklistPage = lazy(() => import("./pages/Worklist"));
const TodayPage = lazy(() => import("./pages/Today"));
const SchedulePage = lazy(() => import("./pages/Schedule"));
const VisitPage = lazy(() => import("./pages/Visit"));
const MessagesPage = lazy(() => import("./pages/Messages"));
/*
 * «Повідомлення» верхней полосы — розсилки (кадры f09/f16/f22): список,
 * форма нового, форма существующего с меню-шестерни. Переписка пациент ↔
 * специалист (MessagesPage выше) осталась на /messages и в бургере под
 * именем «Листування»: это разные вещи — разговор двоих и письмо многим.
 */
const MailingList = lazy(() => import("./pages/messages/MailingList"));
const MailingEditor = lazy(() => import("./pages/messages/MailingEditor"));
const Cohorts = lazy(() => import("./pages/Cohorts"));
const SearchPage = lazy(() => import("./pages/Search"));
const UiKit = lazy(() => import("./pages/UiKit"));
const Timeline = lazy(() => import("./pages/Timeline"));
const KeyPrint = lazy(() => import("./pages/KeyPrint"));
const ResponseView = lazy(() => import("./pages/response"));
const ResponseCharts = lazy(() => import("./pages/response/charts"));
/*
 * Заключение — свой экран, а не строка в таблице прохождений.
 *
 * Прежде оно раскрывалось внутри аналитики методики и жило без адреса: его
 * нельзя было переслать коллеге, положить в закладку или открыть из карты.
 * Макет рисует заключение самостоятельной страницей сверху вниз, и адрес у
 * неё — по прохождению: заключение привязано к нему на сервере.
 */
const ConclusionPage = lazy(() => import("./pages/Conclusion"));
/*
 * Люди: «Лікарі» и «Адміністратори» — списки, карточка с вкладками,
 * заведение. Карточка одна на оба раздела: администратор в системе — тот же
 * сотрудник, только ступенью выше на лестнице должностей, и второй карточки
 * ему не полагается. Вкладки карточки лежат отдельными именованными
 * экспортами того же файла: они делят с ней контекст (Outlet), и разносить
 * их по файлам значило бы тянуть один тип контекста через три модуля.
 */
const StaffList = lazy(() => import("./pages/people/StaffList"));
const StaffNew = lazy(() => import("./pages/people/StaffNew"));
const StaffCard = lazy(() => import("./pages/people/StaffCard"));
const StaffProfile = lazy(() => import("./pages/people/StaffCard").then((m) => ({ default: m.StaffProfile })));
const StaffPatients = lazy(() => import("./pages/people/StaffCard").then((m) => ({ default: m.StaffPatients })));
const StaffGroups = lazy(() => import("./pages/people/StaffCard").then((m) => ({ default: m.StaffGroups })));
/*
 * Раздел «Аналітика» — перечень аналитических моделей и их конструктор.
 *
 * Модель здесь — правило поддержки решений (decision_rules): до этого раздела
 * правила заводились только запросом к API, а в консоли были видны одними
 * срабатываниями. Свой экран у них появился по кадрам f08/f15/f27.
 */
const AnalyticsList = lazy(() => import("./pages/analytics/List"));
const TestsAnalytics = lazy(() => import("./pages/analytics/tests"));
const AnalyticsModel = lazy(() => import("./pages/analytics/Editor"));
/*
 * Раздел «Статистика» — кадры f08, f09, f17, f18, f23, f24, f29: перечень
 * моделей, модель (одна выборка или несколько рядом), форма модели,
 * диаграмма и пресеты фильтров. До этого пункт «Статистика» верхней полосы
 * вёл на подбор людей (/cohorts); подбор остался в бургере под своим именем.
 */
const StatList = lazy(() => import("./pages/statistics/List"));
const StatModel = lazy(() => import("./pages/statistics/ModelView"));
const StatEditor = lazy(() => import("./pages/statistics/Editor"));
const StatChart = lazy(() => import("./pages/statistics/Chart"));
const StatFilters = lazy(() => import("./pages/statistics/Filters"));

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
  const { user, loading, logout, refreshUser, can } = useAuth();
  /* раздел экрана нужен полосе: её состав кадры различают и по нему, не только по должности */
  const { pathname } = useLocation();
  /* отказ отвязки должен быть виден: см. кнопку ниже */
  const { run } = useAction();
  /*
   * Настроен ли вход через Google — спрашиваем сервер, а не переменную
   * сборки: образ консоли один на все учреждения, а настроен способ в
   * одном из них.
   */
  const [googleReady, setGoogleReady] = useState(false);
  useEffect(() => {
    void api
      .googleStatus()
      .then((r) => setGoogleReady(r.enabled))
      .catch(() => {});
  }, []);
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
    /*
     * Умолчание — светлая: макет заказчика нарисован на белом листе, и консоль
     * обязана открываться так, как нарисована. Тёмная остаётся выбором человека.
     * То же умолчание стоит в tokens.css (голый :root), в Account.tsx и в
     * patient/Profile.tsx — иначе первый кадр шёл бы светлым, второй тёмным.
     */
    /*
     * Ключ с суффиксом .v2 — не косметика. Прежний код писал тему в
     * хранилище при каждом монтировании, то есть в каждом браузере, где
     * консоль открывали хоть раз, лежит «dark», которого человек не
     * выбирал. Миграция 0079 чистит такое в профиле на сервере, но до
     * браузера серверу не дотянуться. Новый ключ означает: старое
     * авто-значение больше не читается, а новое пишет только переключатель.
     * Старый ключ остаётся в браузерах мёртвым грузом — это дешевле кода,
     * который ходил бы его вычищать.
     */
    () => (localStorage.getItem("quizzy.theme.v2") as Theme) ?? "light",
  );
  /*
   * Плотность — не косметика: в плотном режиме на экран помещается 24 строки
   * вместо 14, а разбор случаев — это чтение списка. Держится в профиле
   * рабочего места, потому что зависит от монитора, а не от человека.
   */
  /* «system» — следовать настройке системы; «reduced» — всегда меньше движения */
  const [motion, setMotion] = useState<"system" | "reduced">(
    () => (localStorage.getItem("quizzy.motion") as "system" | "reduced") ?? "system",
  );
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem("quizzy.density") as Density) ?? "cozy",
  );
  /*
   * Состояния рельсы здесь больше нет.
   *
   * Она хранила «открыта ли колонка» и помнила это между заходами — нужное
   * свойство ровно до тех пор, пока навигация отнимала ширину. Верхняя полоса
   * не отнимает ничего и не сворачивается, а бургер живёт одним нажатием и
   * закрывается сам: помнить между заходами нечего. Ключ «quizzy.rail» в
   * хранилище браузеров остаётся мусором — читать его больше некому, и
   * подчищать его отдельным кодом дороже, чем оставить.
   */
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
    if (user.workspace.motion) setMotion(user.workspace.motion);
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

  /*
   * Применение и сохранение темы — разные действия, и здесь это разведено.
   *
   * Эффект раньше и ставил атрибут, и писал в хранилище, и слал на сервер —
   * на КАЖДОМ монтировании, включая самое первое, когда тема ещё умолчание,
   * а не выбор. Итог: у каждого, кто хоть раз открывал консоль, в профиле и
   * в браузере лежит «dark», которого он не выбирал. Стоило умолчанию стать
   * светлым (макет заказчика — белый лист), как оно перестало работать для
   * всех, кроме новых: сохранённое умолчание перебивало новое.
   *
   * Теперь эффект только применяет. Сохраняет — chooseTheme, и только когда
   * человек нажал переключатель: выбор — это действие, а не состояние.
   * Плотность и движение оставлены как были, они не меняли умолчания.
   */
  /*
   * Пока никто не вошёл — светлая, и не по выбору.
   *
   * Лендинг и вход (кадры f00/f01) нарисованы заказчиком одним листом:
   * сиреневые волны, силуэт с галактикой, фиолетовый текст. Тёмная тема —
   * настройка рабочего места сотрудника, а до входа неизвестно, чьё это
   * рабочее место: у общего компьютера в кабинете в хранилище лежит выбор
   * того, кто сидел последним. Осветлённый фиолетовый тёмной земли поверх
   * сиреневой картинки читался бы плохо и не был бы тем кадром. Выбор
   * человека при этом не трогается: после входа возвращается его тема.
   *
   * Условие — «гость ли это», а не «есть ли профиль». Пока летит GET /me,
   * профиля ещё нет, и признак `user` держал светлую тему всю длительность
   * запроса: сотрудник, работающий в тёмной, получал при каждой перезагрузке
   * любого экрана белую вспышку во весь экран (включая заглушку `loading`
   * ниже по файлу) и возврат в тёмную после ответа.
   *
   * «Гость» читается по токену, а не по `loading`. С `loading` вспышка
   * меняла бы сторону: у посетителя без токена первый проход эффектов
   * застаёт `loading === true` (эффект App выполняется раньше эффекта
   * AuthProvider — дети раньше родителей), и лендинг успел бы мигнуть
   * тёмной, если она выбрана на этой машине. Токен известен синхронно и до
   * первого кадра, и обе стороны вспышки закрываются одним признаком.
   * `loading` остаётся в зависимостях: протухший токен чистится молча, и
   * `user` при этом не меняется — пересчитать тему больше не с чего.
   *
   * Приглашение (/join/:token) и возврат от Google — не кадры f00/f01, а
   * обычные экраны консоли, и они остаются в выбранной теме. Путь читается
   * из window.location, а не из useLocation: тем же способом читает его
   * гейт публичных страниц ниже по файлу, и два решения об одном и том же
   * должны опираться на один источник — иначе они разойдутся.
   */
  useEffect(() => {
    const publicFrame =
      !user &&
      !tokenStore.get() &&
      !location.pathname.startsWith("/join/") &&
      !location.pathname.startsWith("/auth/google");
    document.documentElement.dataset.theme = publicFrame ? "light" : theme;
  }, [theme, user, loading]);

  const chooseTheme = (next: Theme) => {
    setTheme(next);
    localStorage.setItem("quizzy.theme.v2", next);
    persist({ theme: next });
  };

  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem("quizzy.density", density);
    persist({ density });
  }, [density]);

  useEffect(() => {
    /*
     * Атрибут ставится только для «reduced»: «system» означает «не мешать»,
     * и признак, который надо было бы перебивать медиазапросом, только
     * запутал бы правило.
     */
    if (motion === "reduced") document.documentElement.dataset.motion = "reduced";
    else delete document.documentElement.dataset.motion;
    localStorage.setItem("quizzy.motion", motion);
    persist({ motion });
  }, [motion]);

  // ⌘K — единственный вход в поиск; в поле ввода не перехватываем
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      /*
       * Esc гасит палитру. Нижний слой при этом остаётся открытым —
       * за это отвечает сам слой: он проверяет, верхний ли он (isTopLayer в
       * ui/index.tsx). Здесь останавливать событие бесполезно: слушатель
       * окна срабатывает ПОСЛЕ слушателя документа, на котором висят
       * диалоги, — то есть нижний слой уже успел его увидеть.
       */
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

  /*
   * Публичные страницы живут вне auth-гейта: по приглашению входят без входа.
   *
   * Раньше сюда же пускались «/kiosk/» и «/informant/» — от экранов, которых
   * в приложении нет. Ни один Route их не обслуживал, и пропуск мимо гейта
   * означал только одно: неизвестный путь показывал пустоту вместо экрана
   * входа.
   *
   * «/auth/google» назван в условии, а не только в Route ниже. Сервер после
   * согласия Google приводит браузер сюда (routes/auth.ts: redirect на
   * `${consoleUrl}/auth/google`), но в гейт пускался один «/join/», и до
   * Route дело не доходило: гость с кодом в адресе попадал в общий перехват
   * «*» и видел форму входа, а код так и оставался неразменянным на токены.
   * Вход через Google был мёртв ещё до снятия его кнопки с кадра f01.
   */
  if (location.pathname.startsWith("/join/") || location.pathname === "/auth/google") {
    return (
      <Suspense fallback={<Loading />}>
        <Routes>
          {/* возврат от Google: сюда сервер приводит браузер после входа */}
          <Route path="/auth/google" element={<GoogleReturn />} />
          <Route path="/join/:token" element={<Join />} />
        </Routes>
      </Suspense>
    );
  }

  if (loading) return <div style={{ padding: 40 }}><Loading rows={3} /></div>;
  /*
   * Гость: корень — лендинг, «/login» — вход, любой другой адрес — тоже вход,
   * с сохранением адреса: после входа консоль откроется на том, что человек
   * набрал или получил ссылкой, — так было и до лендинга. Отдельного
   * перенаправления на «/login» нет намеренно: оно добавляло бы шаг в историю,
   * и «назад» после входа возвращало бы на форму.
   */
  if (!user) {
    return (
      <Suspense fallback={<Loading rows={3} />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="*" element={<Login />} />
        </Routes>
      </Suspense>
    );
  }

  /*
   * Пациент попадает в свой кабинет, а не в консоль специалиста.
   *
   * До этого он видел рельсу с «Пациентами», «Очередью работы» и «Случаями
   * риска» и получал отказ доступа на каждом пункте: интерфейс обещал то,
   * чего не даст. Хуже того, он показывал, что такие экраны существуют, — и
   * человек мог решить, что его карту читает кто угодно.
   */
  if (user.role === "user") {
    return (
      <Suspense fallback={<Loading rows={4} />}>
        <Routes>
          <Route path="/me" element={<PatientApp />}>
            <Route index element={<PatientHome />} />
            <Route path="tests" element={<PatientTests />} />
            <Route path="booking" element={<PatientBooking />} />
            <Route path="profile" element={<PatientProfile />} />
          </Route>
          <Route path="/me/tests/:id" element={<Runner />} />
          <Route path="*" element={<Navigate to="/me" replace />} />
        </Routes>
      </Suspense>
    );
  }

  const isSuper = user.role === "superadmin";
  /*
   * Кому есть кого назначать: ступень лестницы выше первой. То же число
   * решает и пункт «Права», и разделы «Лікарі» / «Адміністратори»: списки
   * коллег — это часть назначения, а не отдельная привилегия.
   */
  const canAssign = (user.ladderRank ?? 0) > 1;
  /*
   * Кому заводить сотрудников: по праву users.manage, а не по классу.
   * Право приходит с карточкой прав вместе с профилем (auth.tsx, can):
   * заведующий, которому его выдали ролью или исключением, заводит людей
   * наравне с суперадмином — POST /api/users открыт ему точно так же.
   */
  const canManageUsers = can("users.manage");

  /*
   * Подвал рельсы переехал в бургер целиком — вместе с именем, ролью,
   * пометкой «только чтение», связью с Google, «Учётной записью», выходом и
   * номером сборки.
   *
   * Ничего из этого не потерялось и ничего не переехало на отдельный экран.
   * Причина простая: всё это отвечает на вопрос «кто я здесь и как отсюда
   * выйти», а такой вопрос задают редко и из любого места. Место для него —
   * последняя строка общего меню, а не пункт в ряду разделов работы.
   *
   * Собирается здесь, а не в полосе: тут живут и пользователь, и отвязка
   * Google, и выход. Полосе про авторизацию знать незачем — она про
   * навигацию. Собирается ДАННЫМИ, а не разметкой: как выглядит подвал,
   * решает бургер (BurgerAccount в Topbar.tsx), и его строки — те же, что у
   * разделов выше; прежде здесь стояли три разных вида у трёх действий.
   */
  const account: BurgerAccount = {
    name: user.fullName,
    roleLabel: user.role === "superadmin" ? ut("nav.roleSuper") : ut("nav.roleAdmin"),
    build: { sha: __BUILD_SHA__, date: __BUILD_DATE__ },
    /*
     * Человек должен понимать, почему кнопки не срабатывают, до того как
     * решит, что консоль сломана.
     */
    warning: user.readOnly ? ut("nav.readOnly") : undefined,
    /*
     * Связь с Google — второй ключ от учётной записи, поэтому состояние
     * видно всегда, а не прячется в настройках: человек должен знать, каких
     * дверей у его записи две.
     */
    note: googleReady && user.googleLinked ? ut("lg.googleLinked") : undefined,
    actions: [
      /*
       * Привязка уходит переходом на сервер, а не запросом из кода: Google
       * показывает свой экран выбора учётной записи, и провести через него
       * можно только браузер целиком.
       */
      ...(googleReady
        ? [
            user.googleLinked
              ? {
                  id: "google",
                  label: ut("lg.googleUnlink"),
                  onSelect: () => {
                    // отвязка снимает второй ключ от учётной записи —
                    // сервер спрашивает пароль, и спросить его надо здесь
                    const pass = window.prompt(ut("lg.googleUnlinkAsk"));
                    if (!pass) return;
                    /*
                      Отказ показывается, а не глотается.
                      Здесь стоял пустой catch: на неверный пароль не происходило
                      ровно ничего — ни сообщения, ни изменения на экране. Та же
                      кнопка в разделе «Учётная запись» ошибку показывает; две
                      версии одной кнопки, одна из них немая.
                    */
                    void run(
                      () => api.googleUnlink(pass).then(refreshUser),
                      ut("acct.saved"),
                    );
                  },
                }
              : {
                  id: "google",
                  label: ut("lg.googleLink"),
                  onSelect: () =>
                    void api
                      .googleLinkUrl()
                      .then((r) => {
                        window.location.href = r.url;
                      })
                      .catch(() => {}),
                },
          ]
        : []),
      /*
       * Учётная запись — рядом с именем и выходом, а не разделом работы. Туда
       * ходят раз в месяц: сменить пароль, привязать Google, поменять тему.
       * Пункт в списке разделов стоил бы внимания при каждом открытии консоли.
       */
      { id: "account", label: ut("acct.title"), to: "/account" },
      /*
       * Выход подписан словом, а не значком.
       *
       * В свёрнутой рельсе на его месте стоял нарисованный кружок с чертой —
       * единственное, что туда помещалось. Свёрнутого состояния больше нет:
       * меню либо открыто целиком, либо закрыто целиком, — и значок, который
       * надо угадывать, стал платой ни за что.
       */
      { id: "logout", label: ut("nav.logout"), onSelect: logout, ruled: true },
    ],
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Topbar
        counts={{ today: todayLeft, worklist: worklistCount, alerts: openAlerts, referrals: openReferrals }}
        isSuper={isSuper}
        canAssign={canAssign}
        /*
         * Рабочее место вошедшего — по должности И по разделу экрана (см.
         * barKind в Topbar.tsx). Состав полосы от раздела с 2026-09-26 не
         * зависит (решение заказчика, см. barItems), а права нужны ей, чтобы
         * тому, кто не лечит, не показывать разделов, куда ему нет входа.
         *
         * «Лечит ли» — право видеть пациентов. Специалист лечит по классу
         * записи: справочника прав у него нет вовсе (auth.tsx), и can ему
         * всегда отвечает «нет» — спрашивать его о patients.read значило бы
         * отобрать у него полосу целиком.
         */
        bar={barKind(user, user.role !== "admin" || can("patients.read"), pathname)}
        can={can}
        hidden={user.workspace?.railHidden ?? []}
        onSearch={() => setPaletteOpen(true)}
        theme={theme}
        onToggleTheme={() => chooseTheme(theme === "dark" ? "light" : "dark")}
        account={account}
      />
      {/*
        Содержимое — колонка в 1200 px по центру, как на макете.

        Поля здесь не ставятся: своими полями распоряжается экран (см. Page).
        Полоса сверху держит ту же колонку и те же 1200, поэтому знак, пункты
        меню и заголовок страницы стоят на одних вертикалях — расхождение в
        несколько пикселей между шапкой и содержимым читается как перекос
        даже у того, кто не умеет его назвать.
      */}
      <main className="main mx-auto w-full max-w-[1200px]">
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
          {/*
            Сводка и приём — вкладки одного экрана: и то и другое отвечает на
            вопрос «с чего начать смену».
          */}
          <Route path="/" element={<Start />}>
            <Route index element={<StartScreen prefs={user?.workspace ?? null} />} />
          </Route>
          <Route path="/today" element={<Start />}>
            <Route index element={<TodayPage />} />
          </Route>
          {/*
            Приглашения — третья вкладка того же экрана. Ссылку выписывают,
            глядя на сегодняшний приём («этот придёт завтра, дам ему методику
            заранее»), а не уходя в администрирование: там она стояла пунктом
            рельсы, видимым одному суперадмину, — то есть недоступной как раз
            тому, кто приглашает.
          */}
          <Route path="/invites" element={<Start />}>
            <Route index element={<Invites />} />
          </Route>
          <Route path="/surveys" element={<SurveyList />} />
          {/*
            Вкладки каталога «Опубліковані / Неопубліковані / Зняті» стоят в
            адресе, а не в состоянии: ссылку на неопубликованные пересылают
            коллеге, и открыться она обязана на них же (см. Tabs в
            primitives.tsx). Статичные сегменты `drafts` и `retired` не
            спорят с `/surveys/:id` ниже: маршрутизатор ранжирует точный
            сегмент выше параметра независимо от порядка объявления, а
            идентификаторы методик — UUID, и слово «drafts» среди них не
            встретится.
          */}
          <Route path="/surveys/drafts" element={<SurveyList />} />
          <Route path="/surveys/retired" element={<SurveyList />} />
          <Route path="/surveys/:id" element={<SurveyAnalyticsPage />} />
          <Route path="/surveys/:id/administer" element={<Administer />} />
          <Route path="/responses/:id/conclusion" element={<ConclusionPage />} />
          {/*
            Тот же экран заключения, но с инструментами черновика в меню
            шестерёнки: «Зібрати з результатів», библиотека формулировок,
            история версий, «Зберегти чернетку». На кадре f36 в раскрытом
            меню ровно два пункта — «Зберегти як PDF» и «Надіслати поштою»,
            — и четырём инструментам редактора там места нет. Отдельный
            адрес, а не вложенный пункт: пункт «Чернетка ▸» был бы третьим
            на кадре, которого кадр не рисует.
          */}
          <Route path="/responses/:id/conclusion/draft" element={<ConclusionPage />} />
          <Route path="/surveys/:id/key" element={<KeyPrint />} />
          <Route path="/surveys/:id/norms" element={<Norms />} />
          <Route path="/surveys/:id/blank" element={<BlankForm />} />
          {/*
            Прохождение — под методикой, а не отдельным корнем /responses:
            ключ, бланк, доступ уже лежат здесь, и «Тести» в верхней полосе
            остаётся подсвеченным, как на кадре. Ссылки на этот адрес собирают
            три экрана; их форму сторожит apps/web/test/responseView.test.ts.
          */}
          <Route path="/surveys/:id/responses/:rid" element={<ResponseView />} />
          {/*
            Графики того же прохождения — вкладка рядом с протоколом, своим
            адресом: карточка пациента ведёт сюда прямо (решение заказчика
            2026-09-26), а ссылку на графики пересылают так же, как на протокол.
          */}
          <Route path="/surveys/:id/responses/:rid/charts" element={<ResponseCharts />} />
          <Route path="/constructor" element={<Constructor />} />
          <Route path="/constructor/:id" element={<Constructor />} />
          <Route path="/surveys/:id/access" element={<Access />} />
          {/*
            Модели аналитики: перечень, новая, правка. `new` объявлен раньше
            `:id` для читающего, а не для маршрутизатора: тот и так ставит
            точный сегмент выше параметра, а идентификаторы правил — UUID.
          */}
          <Route path="/analytics" element={<AnalyticsList />} />
          {/*
            Вкладка «Тести» — полная аналитика методики (pages/analytics/tests).
            Статичный сегмент не спорит с `:id` модели: маршрутизатор ставит
            точный сегмент выше параметра, а идентификаторы правил — UUID.
            Прежний /surveys/:id перенаправляет сюда (SurveyAnalytics.tsx).
          */}
          <Route path="/analytics/tests" element={<TestsAnalytics />} />
          <Route path="/analytics/new" element={<AnalyticsModel />} />
          <Route path="/analytics/:id" element={<AnalyticsModel />} />
          {/*
            Статистика: статичные сегменты `new`, `chart`, `filters` не спорят
            с `:id` — маршрутизатор ставит точный сегмент выше параметра, а
            идентификаторы моделей — UUID. Правка модели — та же форма f17
            (Editor) на `/:id/edit`.
          */}
          <Route path="/statistics" element={<StatList />} />
          <Route path="/statistics/new" element={<StatEditor />} />
          <Route path="/statistics/chart" element={<StatChart />} />
          <Route path="/statistics/filters" element={<StatFilters />} />
          <Route path="/statistics/filters/:id" element={<StatFilters />} />
          <Route path="/statistics/:id" element={<StatModel />} />
          <Route path="/statistics/:id/edit" element={<StatEditor />} />
          <Route path="/patients" element={<PatientList />} />
          {/*
            Карточка пациента по кадру f19 заказчика: персональные данные,
            «Тести», «Групи», «Заключення». На неё ведут все ссылки на
            человека — из списка, групп, поиска, дня приёма.
          */}
          <Route path="/patients/:userId" element={<PatientCard />} />
          {/*
            Клиническая карта — один экран с вкладками, под своим сегментом
            /case: адрес человека занят карточкой кадра, а сводка, динамика и
            хронология с него не убраны (дверь — шестерёнка в шапке карточки).
            Вкладка стоит в адресе: карту пересылают коллеге и кладут в
            закладку, и открываться она должна на том, что человек смотрел.
          */}
          <Route path="/patients/:userId/case" element={<CaseCard />}>
            <Route index element={<CaseSummaryPage />} />
            <Route path="dynamics" element={<PatientDynamics />} />
            <Route path="timeline" element={<Timeline />} />
          </Route>
          {/*
            Прежние адреса остаются рабочими: на /summary ссылается очередь
            работы с сервера (routes/worklist.ts), на /dynamics и /timeline —
            чьи-то закладки. Ломать их ради чистоты адресов незачем —
            перенаправление стоит строку.
          */}
          <Route path="/patients/:userId/summary" element={<RedirectToCase />} />
          <Route path="/patients/:userId/dynamics" element={<RedirectToCase tab="/dynamics" />} />
          <Route path="/patients/:userId/timeline" element={<RedirectToCase tab="/timeline" />} />
          <Route path="/referrals" element={<ReferralsPage />} />
          <Route path="/api-docs" element={<ApiDocs />} />
          <Route path="/console" element={<Console />} />
          <Route path="/account" element={<Account />} />
          <Route path="/ui" element={<UiKit />} />
          <Route path="/batteries" element={<Batteries />} />
          <Route path="/alerts" element={<Alerts />} />
            <Route path="/worklist" element={<WorklistPage />} />
            <Route path="/my-schedule" element={<SchedulePage />} />
            <Route path="/visit/:id" element={<VisitPage />} />
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/messages/:id" element={<MessagesPage />} />
            {/* `new` объявлен раньше `:id` для читающего: маршрутизатор и так ставит точный сегмент выше */}
            <Route path="/mailings" element={<MailingList />} />
            <Route path="/mailings/new" element={<MailingEditor />} />
            <Route path="/mailings/:id" element={<MailingEditor />} />
            <Route path="/cohorts" element={<Cohorts />} />
            <Route path="/search" element={<SearchPage />} />
          {/*
            «Групи» верхней полосы — группы ПАЦИЕНТОВ (кадры f10/f20). Адрес
            /groups остаётся за группами методик: на него ссылаются бургер,
            палитра команд и закладки, а ставить две разные сущности на один
            адрес значило бы, что старая ссылка молча открывает не то.
          */}
          <Route path="/patient-groups" element={<PatientGroups />} />
          <Route path="/patient-groups/:id" element={<PatientGroupCard />} />
          {/*
            Карточка группы с открытым окном правки названия и описания: на
            кадре f14 в строке заголовка справа чисто, глифу-карандашу там
            места нет, а PATCH на сервере есть. Тот же экран, отдельный
            адрес — окно открывается сразу.
          */}
          <Route path="/patient-groups/:id/edit" element={<PatientGroupCard />} />
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
          {/*
            Разделы «Лікарі» и «Адміністратори» — тем, кому есть кого назначать,
            и суперадмину: как и пункт меню. Заведение («/new») — по праву
            users.manage, которым оно закрыто на сервере; у заведующего его
            по умолчанию нет, но выданное ролью или исключением оно должно
            открывать и «+», и адрес. Статичный сегмент `new` не спорит с
            `:id` ниже — маршрутизатор ранжирует его выше параметра, а
            идентификаторы — UUID.

            Своя карточка открыта каждому сотруднику: по схеме заказчика
            (кадр f03) это первый экран лікаря после входа. Чужая — тем же,
            кому открыты списки; остальным сервер откажет в справочнике.
          */}
          {/* правило — peopleLists (pages/people/model.ts): по нему же список решает, показывать ли вкладки «Лікарі | Адміністратори» */}
          {peopleLists(user).doctors ? <Route path="/staff" element={<StaffList kind="doctors" />} /> : null}
          {peopleLists(user).admins ? <Route path="/admins" element={<StaffList kind="admins" />} /> : null}
          {canManageUsers ? <Route path="/staff/new" element={<StaffNew kind="doctor" />} /> : null}
          {canManageUsers ? <Route path="/admins/new" element={<StaffNew kind="admin" />} /> : null}
          <Route path="/staff/:id" element={<StaffCard />}>
            <Route index element={<StaffProfile />} />
            <Route path="patients" element={<StaffPatients />} />
            <Route path="groups" element={<StaffGroups />} />
          </Route>
          <Route path="/permissions" element={<Permissions />} />
          {isSuper ? <Route path="/consent-text" element={<ConsentText />} /> : null}
          {isSuper ? <Route path="/audit" element={<Audit />} /> : null}
          {/*
            Техпанель — по праву ops.read (суперадмину оно есть всегда); вкладки
            о людях — по своим правам, как и их пункты во вкладках панели.
          */}
          {can("ops.read") ? (
            <Route path="/ops" element={<OpsPanel />}>
              <Route index element={<OpsOverview />} />
              <Route path="requests" element={<OpsRequests />} />
              <Route path="errors" element={<OpsErrors />} />
              <Route path="logs" element={<OpsLogs />} />
              <Route path="db" element={<OpsDatabase />} />
              <Route path="jobs" element={<OpsJobs />} />
              {can("users.manage") ? <Route path="users" element={<OpsUsers />} /> : null}
              {can("users.manage") ? <Route path="sessions" element={<OpsSessions />} /> : null}
              {can("audit.read") ? <Route path="audit" element={<OpsAuditLog />} /> : null}
              {/* ролью, а не правом: сервер отвечает 403 всем, кроме суперадмина */}
              {isSuper ? <Route path="keys" element={<OpsSecKeys />} /> : null}
              {isSuper ? <Route path="integrity" element={<OpsSecIntegrity />} /> : null}
              {isSuper ? <Route path="sql" element={<OpsSecSql />} /> : null}
            </Route>
          ) : null}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleTheme={() => chooseTheme(theme === "dark" ? "light" : "dark")}
        onToggleDensity={() => setDensity(density === "compact" ? "cozy" : "compact")}
      />
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
