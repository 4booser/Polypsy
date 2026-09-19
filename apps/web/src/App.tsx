import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import { useLang } from "./lang";
import Login from "./pages/Login";
import { Topbar } from "./shell/Topbar";
import { Button, Tag } from "./ui/primitives";
import { CommandPalette } from "./shell/CommandPalette";
import { onAppEvent } from "./events";
import type { WorkspacePrefs } from "@quizzy/shared";
import Dashboard from "./pages/Dashboard";
import { PatientDynamics, PatientList } from "./pages/Patients";
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
const GoogleReturn = lazy(() => import("./pages/GoogleReturn"));
const Norms = lazy(() => import("./pages/Norms"));
const CaseSummaryPage = lazy(() => import("./pages/CaseSummary"));
const PatientCard = lazy(() => import("./pages/PatientCard"));
const Start = lazy(() => import("./pages/Start"));
const Account = lazy(() => import("./pages/Account"));
/* кабинет пациента: отдельная оболочка, а не консоль с урезанным меню */
const PatientApp = lazy(() => import("./patient/PatientApp"));
const PatientHome = lazy(() => import("./patient/Home"));
const PatientTests = lazy(() => import("./patient/Tests"));
const PatientBooking = lazy(() => import("./patient/Booking"));
const PatientProfile = lazy(() => import("./patient/Profile"));
const Runner = lazy(() => import("./patient/Runner"));

/** Прежний адрес сводки — теперь вкладка «Обзор» карты */
function RedirectToCard() {
  const { userId } = useParams<{ userId: string }>();
  return <Navigate to={`/patients/${userId}`} replace />;
}
const ReferralsPage = lazy(() => import("./pages/Referrals"));
const ApiDocs = lazy(() => import("./pages/ApiDocs"));
const Console = lazy(() => import("./pages/Console"));
const WorklistPage = lazy(() => import("./pages/Worklist"));
const TodayPage = lazy(() => import("./pages/Today"));
const SchedulePage = lazy(() => import("./pages/Schedule"));
const VisitPage = lazy(() => import("./pages/Visit"));
const MessagesPage = lazy(() => import("./pages/Messages"));
const Cohorts = lazy(() => import("./pages/Cohorts"));
const SearchPage = lazy(() => import("./pages/Search"));
const UiKit = lazy(() => import("./pages/UiKit"));
const Timeline = lazy(() => import("./pages/Timeline"));
const KeyPrint = lazy(() => import("./pages/KeyPrint"));
const ResponseView = lazy(() => import("./pages/response"));

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
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
   */
  if (location.pathname.startsWith("/join/")) {
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
  if (!user) return <Login />;

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
   * навигацию.
   */
  const account = (
    <div className="flex flex-col gap-2">
      <div className="px-1">
        <div className="truncate text-small font-medium text-text">{user.fullName}</div>
        <div className="text-micro text-faint">
          {user.role === "superadmin" ? ut("nav.roleSuper") : ut("nav.roleAdmin")}
        </div>
      </div>
      {user.readOnly ? (
        /*
          Человек должен понимать, почему кнопки не срабатывают, до того как
          решит, что консоль сломана.
        */
        <Tag tone="attention" className="self-start">{ut("nav.readOnly")}</Tag>
      ) : null}

      {/*
        Связь с Google — второй ключ от учётной записи, поэтому состояние
        видно всегда, а не прячется в настройках: человек должен знать, каких
        дверей у его записи две.

        Привязка уходит переходом на сервер, а не запросом из кода: Google
        показывает свой экран выбора учётной записи, и провести через него
        можно только браузер целиком.
      */}
      {googleReady ? (
        <div className="flex flex-col gap-1">
          <span className="text-micro text-faint">
            {user.googleLinked ? ut("lg.googleLinked") : ""}
          </span>
          {user.googleLinked ? (
            <Button
              variant="quiet"
              size="sm"
              className="justify-start"
              onClick={() => {
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
              }}
            >
              {ut("lg.googleUnlink")}
            </Button>
          ) : (
            <Button
              variant="quiet"
              size="sm"
              className="justify-start"
              onClick={() =>
                void api
                  .googleLinkUrl()
                  .then((r) => {
                    window.location.href = r.url;
                  })
                  .catch(() => {})
              }
            >
              {ut("lg.googleLink")}
            </Button>
          )}
        </div>
      ) : null}

      {/*
        Учётная запись — рядом с именем и выходом, а не разделом работы. Туда
        ходят раз в месяц: сменить пароль, привязать Google, поменять тему.
        Пункт в списке разделов стоил бы внимания при каждом открытии консоли.
      */}
      <Link
        to="/account"
        className="rounded-sm px-2 py-1.5 text-caption text-muted no-underline transition-colors hover:bg-surface-2 hover:text-text"
      >
        {ut("acct.title")}
      </Link>

      {/*
        Выход подписан словом, а не значком.

        В свёрнутой рельсе на его месте стоял нарисованный кружок с чертой —
        единственное, что туда помещалось. Свёрнутого состояния больше нет:
        меню либо открыто целиком, либо закрыто целиком, — и значок, который
        надо угадывать, стал платой ни за что.
      */}
      <Button variant="quiet" size="sm" onClick={logout} className="justify-start">
        {ut("nav.logout")}
      </Button>
      <span className="px-1 font-mono text-micro text-faint" title={`${ut("ui.buildFrom")} ${__BUILD_DATE__}`}>
        {__BUILD_SHA__}
      </span>
    </div>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Topbar
        counts={{ today: todayLeft, worklist: worklistCount, alerts: openAlerts, referrals: openReferrals }}
        isSuper={isSuper}
        canAssign={(user.ladderRank ?? 0) > 1}
        hidden={user.workspace?.railHidden ?? []}
        onSearch={() => setPaletteOpen(true)}
        theme={theme}
        onToggleTheme={() => chooseTheme(theme === "dark" ? "light" : "dark")}
        menu={account}
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
          <Route path="/surveys/:id" element={<SurveyAnalyticsPage />} />
          <Route path="/surveys/:id/administer" element={<Administer />} />
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
          <Route path="/constructor" element={<Constructor />} />
          <Route path="/constructor/:id" element={<Constructor />} />
          <Route path="/surveys/:id/access" element={<Access />} />
          <Route path="/patients" element={<PatientList />} />
          {/*
            Карта пациента — один экран с вкладками. Вкладка стоит в адресе:
            карту пересылают коллеге и кладут в закладку, и открываться она
            должна на том, что человек смотрел.
          */}
          <Route path="/patients/:userId" element={<PatientCard />}>
            <Route index element={<CaseSummaryPage />} />
            <Route path="dynamics" element={<PatientDynamics />} />
            <Route path="timeline" element={<Timeline />} />
          </Route>
          {/*
            Прежний адрес сводки остаётся рабочим: на него ссылается очередь
            работы с сервера (routes/worklist.ts) и чьи-то закладки. Ломать
            их ради чистоты адресов незачем — перенаправление стоит строку.
          */}
          <Route
            path="/patients/:userId/summary"
            element={<RedirectToCard />}
          />
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
          <Route path="/permissions" element={<Permissions />} />
          {isSuper ? <Route path="/consent-text" element={<ConsentText />} /> : null}
          {isSuper ? <Route path="/audit" element={<Audit />} /> : null}
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
