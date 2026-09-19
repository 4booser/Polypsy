import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { isTopLayer, useFocusTrap } from "../ui";
import { EventCenter } from "./EventCenter";
import { railGroups, type RailCounts } from "./Rail";

/*
 * Верхнее меню вместо боковой рельсы — раскладка заказчика, один в один.
 *
 * Рельса отдавала под навигацию колонку во всю высоту экрана: на ноутбуке это
 * пятая часть ширины, занятая списком, в который смотрят раз в полчаса.
 * Полоса сверху берёт сто пикселей высоты один раз и возвращает содержимому
 * всю ширину — а список из восьми тысяч человек читается по ширине, не по
 * высоте.
 *
 * Плата за это честная, и её видно: в полосу помещается шесть разделов, а их
 * в консоли больше двадцати. Поэтому справа стоит бургер, и в нём лежит ВЕСЬ
 * набор разделов целиком — тот же, что был в рельсе (railGroups), плюс подвал
 * с учётной записью и выходом. Ни один экран не потерял двери; шесть верхних
 * пунктов — это ярлыки к тому, куда ходят каждый день, а не урезанное меню.
 *
 * Отсюда же и повтор: «Пацієнти» стоят и в полосе, и в бургере. Убрать из
 * бургера то, что попало в полосу, было бы дешевле на вид и дороже по сути —
 * состав бургера начал бы зависеть от полосы, группа «Методики и сбор»
 * осталась бы из одного пункта, а человек, привыкший искать раздел в общем
 * списке, перестал бы его там находить. Повтор ведёт туда же, куда ярлык;
 * это не две разные двери, а одна и та же.
 */

/*
 * Цвета макета стоят числами, а не токенами, и это осознанно.
 *
 * Полоса — единственное место консоли, где цвет задан заказчиком попиксельно:
 * сиреневая заливка #f0ecff, знак и подписи #663399, текущий раздел бледнее —
 * #ab8fcc. Через семантический токен это выражается неточно: токен меняется
 * вместе с темой, а полоса на макете одна. Привязать её к теме значило бы
 * получить в тёмной теме полосу другого цвета — то есть не тот макет, который
 * согласован.
 *
 * Выпадающий список бургера, наоборот, живёт на токенах: внутри него стоят
 * обычные кнопки и метки консоли (Button, Tag), и на прибитой белой подложке
 * в тёмной теме они были бы светлым по светлому.
 *
 * Числа не вынесены в константы намеренно: Tailwind читает исходник глазами
 * сборщика и собирает классы из литералов. `bg-[${BAND}]` он не увидит вовсе,
 * и полоса осталась бы без заливки — молча, без единой ошибки при сборке.
 */

interface TopItem {
  key: UiKey;
  to: string;
  /** Точное совпадение адреса: «/» есть начало любого пути */
  end?: boolean;
}

/*
 * Шесть разделов полосы — ровно в порядке макета.
 *
 * Два из шести не имеют собственного экрана, и выдумывать его здесь нечего:
 *
 * «Аналітика» ведёт на сводку («/»). Это единственный экран, который отвечает
 * на вопрос «как идут дела вообще»: открытые случаи, очередь, доля
 * завершённых методик. Аналитика самой методики живёт на ней самой
 * (/surveys/:id) и без выбранной методики не открывается — в постоянное меню
 * такой адрес не поставить.
 *
 * «Статистика» ведёт на подбор людей («/cohorts»): визуальный запрос по
 * срезам, который отвечает «сколько таких» — ближайшее к статистике из того,
 * что в консоли есть.
 *
 * Обе замены временные и обе названы вслух, чтобы их заменили на настоящие
 * экраны, когда те появятся, а не оставили «потому что работает».
 */
const TOP: TopItem[] = [
  { key: "top.patients", to: "/patients" },
  { key: "top.groups", to: "/groups" },
  { key: "top.tests", to: "/surveys" },
  { key: "top.analytics", to: "/", end: true },
  { key: "top.statistics", to: "/cohorts" },
  { key: "top.messages", to: "/messages" },
];

/**
 * Верхняя полоса консоли.
 *
 * `menu` — подвал бургера: кто вошёл, учётная запись, выход, номер сборки.
 * Собирает его App, а не полоса: там живут и пользователь, и отвязка Google,
 * и выход, и тащить их сюда значило бы дать полосе знать про авторизацию.
 */
export function Topbar({
  counts,
  isSuper,
  canAssign,
  hidden,
  onSearch,
  theme,
  onToggleTheme,
  menu,
}: {
  counts: RailCounts;
  isSuper: boolean;
  /** Есть ли кому назначать роли: от этого зависит пункт «Права» */
  canAssign: boolean;
  /**
   * Что человек убрал с глаз в настройках рабочего места.
   *
   * Действует только на бургер, и это не упущение. Настройка перечисляет
   * разделы рабочего списка (nav.*), а шесть пунктов полосы — не разделы, а
   * согласованная с заказчиком постоянная часть экрана: её состав задан
   * макетом, а не профилем. Убрать «Пацієнтів» из полосы значило бы дать
   * настройке вида менять макет — и оставить полосу с дырой посередине.
   */
  hidden?: string[];
  onSearch: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  menu?: ReactNode;
}) {
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement | null>(null);

  return (
    /*
      Полоса не прилипает к верху окна.
      Прокручивается не страница, а содержимое экрана (см. .main), и прибивать
      полосу не к чему: она и так всегда на месте. Sticky здесь создавал бы
      только лишний слой над содержимым, а тени под полосой в макете нет.

      На печать полоса не идёт вовсе. Прежняя рельса пряталась печатным
      правилом в legacy.css по классу .sidebar; полосе такого правила никто не
      писал, и бланк методики выезжал бы из принтера с сиреневой шапкой и
      меню — на бумаге меню не нажимают, а тонер оно съедает.
    */
    <header className="h-[100px] shrink-0 bg-[#f0ecff] print:hidden">
      {/*
        Колонка содержимого — 1200 px по центру.
        Предел ширины 1232, поля по 16 px сняты изнутри: на макетных 1600 это
        даёт ровно те 200 px отступа с каждой стороны, а на телефоне остаётся
        шестнадцатипиксельное поле, без которого знак упирался бы в край.
      */}
      <div className="mx-auto flex h-full w-full max-w-[1232px] items-center gap-6 px-4">
        <Link
          to="/"
          aria-label={ut("dash.title")}
          className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#663399]"
        >
          <Logo />
        </Link>

        {/*
          Шесть пунктов по центру свободного места между знаком и правой
          группой. На макете середина набора приходится на середину колонки —
          flex-1 с центрированием даёт то же и не разъезжается, когда подписи
          меняют длину на другом языке.

          Ниже 1100 px шесть пунктов в строку не помещаются. Переносить их на
          вторую строку полоса высотой в сто пикселей не может, а сжимать кегль
          до нечитаемого хуже, чем убрать: раздел, набранный восьмым кеглем в
          углу, всё равно не находят. Там они уходят в бургер — тот же порог
          стоит на блоке внутри списка, и оба места обязаны совпадать.
        */}
        <nav
          aria-label={ut("shell.sections")}
          className="flex flex-1 items-center justify-center gap-[46px] max-[1100px]:hidden"
        >
          {TOP.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                cx(
                  "whitespace-nowrap text-[20px] font-bold leading-none no-underline",
                  "transition-colors duration-[var(--dur-fast)]",
                  "outline-none focus-visible:ring-2 focus-visible:ring-[#663399]",
                  /*
                    Текущий раздел — бледнее остальных, без подчёркивания и
                    заливки: так на макете. Наведение показывает тот же бледный
                    цвет заранее — «нажмёшь и станешь здесь». Диктору цвет не
                    сообщает ничего, поэтому текущий пункт помечен ещё и
                    aria-current, который NavLink ставит сам.
                  */
                  /*
                    Текущий раздел — бледнее остальных, как в макете, но не
                    его буквой: #ab8fcc на полосе шапки даёт 2,79:1, вдвое
                    ниже нормы, и первый же прогон доступности это поймал.
                    #7a4ea6 — тот же тон с достаточной светлотой (5,23:1 на
                    полосе). Литералом, а не токеном --primary-dim, по той же
                    причине, что и сама полоса: она не меняется с темой, а
                    токен меняется — в тёмной теме он светлеет и на светлой
                    полосе становится нечитаем (проверка это и поймала).
                    Ховер — им же: подсказка «сюда можно» не должна быть
                    нечитаемой.
                  */
                  isActive ? "text-[#7a4ea6]" : "text-[#663399] hover:text-[#7a4ea6]",
                )
              }
            >
              {ut(it.key)}
            </NavLink>
          ))}
        </nav>
        {/* пункты спрятаны — место между знаком и правой группой держит распорка */}
        <span className="hidden flex-1 max-[1100px]:block" />

        {/*
          Правая группа растянута на всю высоту полосы (self-stretch), хотя
          внутри у неё подпись в двадцать пикселей и бургер в двадцать.
          Высота нужна не ей, а выпадающему списку: он считает своё «сверху»
          от этой коробки, и от коробки по содержимому список начинался бы
          внутри сиреневой полосы — накрывая её нижнюю треть. Подпирать его
          подобранным числом отступа значило бы сломать раскладку в тот день,
          когда подпись станет на пиксель выше.
        */}
        <div className="relative flex shrink-0 items-center gap-[18px] self-stretch">
          <LangToggle />
          <Burger buttonRef={burgerRef} open={open} onToggle={() => setOpen((v) => !v)} />
          {open ? (
            <MoreMenu
              counts={counts}
              isSuper={isSuper}
              canAssign={canAssign}
              hidden={hidden}
              opener={burgerRef}
              onSearch={onSearch}
              theme={theme}
              onToggleTheme={onToggleTheme}
              onClose={() => setOpen(false)}
            >
              {menu}
            </MoreMenu>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * Знак учреждения.
 *
 * Нарисован разметкой, а не подключён картинкой или шрифтом: политика
 * содержимого в консоли закрыта наглухо, внешние ресурсы не грузятся вовсе, а
 * картинка в сборке — это ещё один файл, который однажды разъедется с
 * макетом. Буквы расставлены поштучно и с наклоном — так они и стоят на
 * макете, вразброс по кругу, а не строкой.
 */
function Logo() {
  return (
    <svg
      width={70}
      height={70}
      viewBox="0 0 70 70"
      aria-hidden
      focusable="false"
      className="block shrink-0"
    >
      <circle cx="35" cy="35" r="34" fill="none" stroke="#663399" strokeWidth="2" />
      <g fill="#663399" fontSize="16" fontWeight="700" textAnchor="middle">
        <text x="19" y="33" transform="rotate(-10 19 33)">P</text>
        <text x="33" y="30">O</text>
        <text x="47" y="33" transform="rotate(10 47 33)">L</text>
        <text x="25" y="52" transform="rotate(-8 25 52)">S</text>
        <text x="46" y="51" transform="rotate(8 46 51)">Y</text>
      </g>
    </svg>
  );
}

/**
 * Язык одной подписью, без рамки и каретки — как на макете.
 *
 * Сегментированный переключатель (LangSwitch) показывает оба языка сразу и
 * занимает вдвое больше места; на макете справа стоит одно слово. Смысл от
 * этого не теряется: слово называет текущий язык и переключает на второй, а
 * языков всего два — третьего состояния, ради которого нужен был бы список,
 * не существует. На публичных страницах и в учётной записи LangSwitch
 * остаётся: там место есть, и выбор из двух нагляднее переключения.
 */
function LangToggle() {
  const { lang, setLang, ut } = useLang();
  return (
    <button
      type="button"
      onClick={() => setLang(lang === "uk" ? "ru" : "uk")}
      /* подпись называет сам язык и потому не переводится — та же, что у LangSwitch */
      aria-label="Мова / Язык"
      className={cx(
        // глобальное правило для button рисует рамку и поля — гасим их явно:
        // это подпись, а не кнопка панели
        "min-h-0 rounded-sm border-0 bg-transparent p-0",
        "text-[20px] font-bold leading-none text-[#663399]",
        "transition-colors duration-[var(--dur-fast)] hover:text-[#7a4ea6]",
        "outline-none focus-visible:ring-2 focus-visible:ring-[#663399]",
      )}
    >
      {ut("top.lang")}
    </button>
  );
}

/**
 * Бургер: 29×20, три полосы по 3 px.
 *
 * Полосы — элементы разметки, а не нарисованный значок: три `span` в колонке
 * с распределением по краям дают ровно тот шаг, что на макете, и не зависят
 * от того, как браузер округлит виртуальную систему координат SVG.
 */
function Burger({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  /** Куда возвращать фокус тому, что открыто из меню: см. MoreMenu.opener */
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { ut } = useLang();
  const label = open ? ut("shell.collapse") : ut("shell.expand");
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="topbar-more"
      aria-label={label}
      title={label}
      className={cx(
        "flex h-5 w-[29px] min-h-0 shrink-0 flex-col justify-between",
        "rounded-sm border-0 bg-transparent p-0",
        "outline-none focus-visible:ring-2 focus-visible:ring-[#663399]",
      )}
    >
      <span aria-hidden className="h-[3px] w-full rounded-[1px] bg-[#663399]" />
      <span aria-hidden className="h-[3px] w-full rounded-[1px] bg-[#663399]" />
      <span aria-hidden className="h-[3px] w-full rounded-[1px] bg-[#663399]" />
    </button>
  );
}

/**
 * Всё, что не поместилось в шесть пунктов.
 *
 * Разделы берутся из railGroups — из того же места, откуда их брала рельса и
 * откуда их читает экран настроек («убрать с глаз»). Второго списка разделов
 * в консоли не заводится: два списка расходятся, и расхождение видно только
 * глазами на живом экране.
 */
function MoreMenu({
  counts,
  isSuper,
  canAssign,
  hidden,
  opener,
  onSearch,
  theme,
  onToggleTheme,
  onClose,
  children,
}: {
  counts: RailCounts;
  isSuper: boolean;
  canAssign: boolean;
  hidden?: string[];
  /**
   * Кнопка бургера — единственное, что остаётся на экране, когда меню
   * закрывается по команде. Палитра команд открывается ИЗ меню, а меню при
   * этом гаснет — и ловушка фокуса палитры запомнила бы «открывшим» кнопку
   * поиска, которой через мгновение нет. По Esc фокус падал бы в body:
   * человек с клавиатурой терял место. Поэтому перед открытием палитры
   * фокус возвращается сюда — бургер и есть то место, откуда всё началось.
   */
  opener: RefObject<HTMLButtonElement | null>;
  onSearch: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { ut } = useLang();
  const { pathname } = useLocation();
  const groups = useMemo(
    () => railGroups(counts, isSuper, canAssign, hidden ?? []),
    [counts, isSuper, canAssign, hidden],
  );

  /*
   * Ловушка фокуса — общая, из ui/index.tsx, а не своя.
   *
   * Список перекрывает экран, и без ловушки два нажатия Tab уводят на
   * содержимое под ним: человек продолжает «ходить по меню», а ходит по
   * ссылкам, которых не видит. Своя копия этой логики здесь была бы третьей в
   * проекте — а расхождение между копиями как раз так и появляется.
   */
  const ref = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    /* Esc закрывает верхний слой: палитра поверх меню не должна гасить оба */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(ref)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, ref]);

  /*
   * Переход закрывает меню: иначе новый экран читают сквозь список.
   *
   * Сравнивается запомненный адрес, а не просто «сработал эффект». Владелец
   * состояния передаёт onClose новой стрелкой на каждой отрисовке, и эффект с
   * ним в зависимостях закрывал бы меню сразу после открытия — оно мигало бы
   * и исчезало, а причина выглядела бы как «бургер не работает».
   */
  const seen = useRef(pathname);
  useEffect(() => {
    if (seen.current === pathname) return;
    seen.current = pathname;
    onClose();
  }, [pathname, onClose]);

  return (
    <>
      {/*
        Подложка отвечает на нажатие мимо меню. Без неё нажатие приходится по
        содержимому под списком: человек целится «закрыть», а попадает в
        ссылку, которую не видел.
      */}
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-40" />
      <div
        id="topbar-more"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ut("top.more")}
        /*
          Прокручивается список разделов, а не сам слой.
          Прокрутка на слое обрезала бы всё, что из него выступает, — а из него
          выступает панель центра событий: она открывается поверх и шире
          бургера. Обрезанная, она превращалась бы в полоску без текста.
        */
        className={cx(
          "absolute right-0 top-[calc(100%+8px)] z-50 w-[min(320px,calc(100vw-32px))]",
          "flex max-h-[min(70vh,560px)] flex-col",
          "rounded-md border border-border bg-surface shadow-panel outline-none",
        )}
      >
        {/*
          Первой строкой — поиск, события и тема.

          На макете их нет, но дверь им нужна. Поиск открывается ещё и по ⌘K, а
          про клавишу знает только тот, кому её показали. Центр событий —
          вообще единственный вход к тому, что произошло, пока вкладка была
          закрыта; тема из консоли достижима и из «Учётной записи», но она
          стояла здесь годами, и отнимать её заодно с рельсой не за что.
        */}
        <div className="flex shrink-0 items-center gap-1 border-b border-hairline p-2">
          <button
            type="button"
            onClick={() => {
              onClose();
              // порядок важен: сначала фокус на бургер, потом палитра его запомнит
              opener.current?.focus();
              onSearch();
            }}
            className={cx(
              "flex h-8 min-h-0 flex-1 items-center gap-2 rounded-sm border-0 px-2",
              "bg-surface-2 text-small text-muted",
              "transition-colors duration-[var(--dur-fast)] hover:bg-surface-3 hover:text-text",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
            )}
          >
            <span className="shrink-0 text-primary [&>svg]:size-[15px]">
              <IconSearch />
            </span>
            <span className="truncate">{ut("shell.search")}</span>
          </button>
          <EventCenter />
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? ut("nav.themeLight") : ut("nav.themeDark")}
            title={theme === "dark" ? ut("nav.themeLight") : ut("nav.themeDark")}
            className={cx(
              "inline-grid size-8 min-h-0 shrink-0 place-items-center rounded-sm p-0",
              "border border-transparent bg-transparent text-muted",
              "transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 hover:text-text",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
            )}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
        </div>

        {/*
          Шесть верхних пунктов повторяются здесь только на узком экране, где
          полоса их не показывает. На широком они стоят в двух шагах выше, и
          второй их список заставлял бы гадать, разные ли это экраны.
        */}
        <div className="hidden shrink-0 flex-col gap-0.5 border-b border-hairline p-2 max-[1100px]:flex">
          {TOP.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.end} className={rowClass}>
              <span className="truncate">{ut(it.key)}</span>
            </NavLink>
          ))}
        </div>

        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2 [scrollbar-width:thin]">
          {groups.map((g) => (
            <div key={g.key} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 px-2 py-1 text-micro font-semibold uppercase tracking-[var(--tracking-label)] text-faint">
                <span className="shrink-0 [&>svg]:size-[14px]">{g.icon}</span>
                <span className="truncate">{ut(g.key)}</span>
              </div>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} className={rowClass}>
                  <span className="shrink-0 [&>svg]:size-[18px]">{it.icon}</span>
                  <span className="truncate">{ut(it.key)}</span>
                  {/*
                    Счётчик залит янтарём, а не набран янтарём по прозрачному:
                    полупрозрачная заливка в светлой теме не добирала до порога
                    контраста как раз на выбранном пункте, под которым лежит
                    более светлая поверхность.
                  */}
                  {it.badge ? (
                    <span className="ml-auto rounded-sm bg-accent px-1.5 py-0.5 font-mono text-micro font-semibold leading-none text-accent-text tabular-nums">
                      {it.badge > 99 ? "99+" : it.badge}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          ))}
        </div>

        {children ? <div className="shrink-0 border-t border-hairline p-2">{children}</div> : null}
      </div>
    </>
  );
}

/** Строка меню: одна и та же у разделов и у шести верхних пунктов на узком экране */
function rowClass({ isActive }: { isActive: boolean }): string {
  return cx(
    "flex h-[30px] items-center gap-2.5 rounded-sm px-2 text-small no-underline",
    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
    isActive ? "bg-surface-3 font-medium text-text" : "text-muted hover:bg-surface-2 hover:text-text",
  );
}

const s = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;

function IconSearch() {
  return <svg {...s}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}
function IconSun() {
  return (
    <svg {...s}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></svg>
  );
}
function IconMoon() {
  return <svg {...s}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" /></svg>;
}
