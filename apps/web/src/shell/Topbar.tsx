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
 * сиреневая заливка #f0ecff, знак и подписи #663399 — все, включая текущий
 * раздел (почему не бледнее, см. у самого NavLink). Через семантический токен
 * это выражается неточно: токен меняется вместе с темой, а полоса на макете
 * одна. Привязать её к теме значило бы получить в тёмной теме полосу другого
 * цвета — то есть не тот макет, который согласован.
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
 * «Аналітика» ведёт в перечень аналитических моделей (/analytics, кадры
 * f08/f15/f27): до волны 4 своего экрана у раздела не было, и пункт временно
 * вёл на сводку. Аналитика самой методики по-прежнему живёт на ней самой
 * (/surveys/:id) — это другой вопрос («что показывает эта методика»), и в
 * постоянное меню адрес с выбранной методикой не поставить.
 *
 * «Статистика» собственного экрана пока не имеет и ведёт на подбор людей
 * («/cohorts»): визуальный запрос по срезам, который отвечает «сколько
 * таких» — ближайшее к статистике из того, что в консоли есть. Замена
 * временная и названа вслух, чтобы её заменили на настоящий экран, когда тот
 * появится, а не оставили «потому что работает».
 */
/*
 * «Групи» ведут на группы ПАЦИЕНТОВ, а не методик.
 *
 * Пункт стоял на /groups — группах методик, единице разграничения доступа.
 * На макете же рядом с «Пацієнти» стоят «Групи» из «Моя група», «Група
 * ризику», «Вечірня група» — рабочие списки людей (кадры f05/f10/f20). Группы
 * методик никуда не делись: они в бургере под именем «Групи методик», чтобы
 * два одинаковых слова не вели на два разных экрана.
 *
 * Список отдан наружу ради проверки (apps/web/test/patientGroups.test.ts):
 * подмена адреса у этого пункта — тихая ошибка, глазами её не отличить.
 */
/*
 * «Повідомлення» ведут на розсилки (/mailings, кадры f09/f16/f22), а не на
 * переписку. На кадре под этим словом — список «тема · начало текста · дата»
 * с «+» и страницами, то есть письма автора многим; переписка с пациентом —
 * разговор двоих, и она осталась на /messages под именем «Листування» в
 * бургере (railGroups) и в палитре команд. Сторож — apps/web/test/mailings.test.ts.
 */
export const TOP: TopItem[] = [
  { key: "top.patients", to: "/patients" },
  { key: "top.groups", to: "/patient-groups" },
  { key: "top.tests", to: "/surveys" },
  { key: "top.analytics", to: "/analytics" },
  { key: "top.statistics", to: "/cohorts" },
  { key: "top.messages", to: "/mailings" },
];

const STAFF: TopItem = { key: "ppl.staff", to: "/staff" };
const ADMINS: TopItem = { key: "adm.admins", to: "/admins" };

/*
 * ПОЛОСА БЫВАЕТ ЧЕТЫРЁХ СОСТАВОВ, И ВЫБИРАЕТ ИХ РАЗДЕЛ ЭКРАНА ВМЕСТЕ С ТЕМ,
 * ЛЕЧИТ ЛИ ВОШЕДШИЙ, — а не одна ступень лестницы должностей.
 *
 *   specialist   — шесть пунктов без «Лікарі» (f04): у рядового лікаря
 *                  раздела людей нет вовсе;
 *   admin        — те же шесть и «Лікарі» вторым (f30, f31, f34, f35): это
 *                  заведующий, у которого есть И свои пациенты, И свои
 *                  лікарі;
 *   peopleStaff  — ОДИН пункт «Лікарі» по центру (f40, f41, f42, f43) — и
 *                  он же у суперадміна в разделе организаций (f44, f45,
 *                  f51, f52);
 *   peopleAdmins — ОДИН пункт «Адміністратори» по центру (f47, f48, f49,
 *                  f50): раздел людей у суперадміна. «Адміністраторів» в
 *                  полосе не было ни в каком виде — пункт жил только в
 *                  бургере (Rail.tsx), и суперадмин видел чужую полосу.
 *
 * ПОЧЕМУ РАЗДЕЛ, А НЕ ДОЛЖНОСТЬ. Кадры f44/f45/f51/f52 рисуют у суперадміна
 * «Лікарі», а f47–f50 — «Адміністратори»; человек один и тот же, разные —
 * разделы. Полоса, выбранная одной должностью, такого сказать не может: она
 * подписала бы «Адміністратори» и на организациях. Поэтому состав считается
 * по паре «кто смотрит» и «в каком разделе», и раздел — из адреса.
 *
 * ПОЧЕМУ «ЛЕЧИТ», А НЕ СТУПЕНЬ. Здесь стояло «ступень 3 и выше — чистый
 * администратор», и это была догадка: ни один кадр не говорит, какой ступени
 * принадлежат f40–f43, а главный лікар (chief) терял из полосы шесть
 * клинических разделов молча. Признак взят настоящий — право видеть
 * пациентов: у кого его нет, тому пять клинических пунктов вели бы в пустые
 * экраны (f40–f43); у кого есть, тот остаётся с широкой полосой (f30–f35).
 * Специалист лечит по классу записи: справочника прав у него нет вовсе.
 *
 * ВНЕ РАЗДЕЛОВ ЛЮДЕЙ И ОРГАНИЗАЦИЙ узкой полосы нет ни на одном кадре,
 * поэтому там её и не бывает: разделы из полосы не убираются без кадра,
 * который этого требует.
 *
 * Пункты, ушедшие из полосы в двух узких составах, НЕ пропали: весь набор
 * разделов целиком лежит в бургере (railGroups), и он от состава полосы не
 * зависит. Полоса — ярлыки рабочего места, бургер — все двери.
 */
export type BarKind = "specialist" | "admin" | "peopleStaff" | "peopleAdmins";

export const bars: Record<BarKind, TopItem[]> = {
  specialist: TOP,
  admin: [TOP[0]!, STAFF, ...TOP.slice(1)],
  peopleStaff: [STAFF],
  peopleAdmins: [ADMINS],
};

/**
 * Раздел экрана в том смысле, в каком его различают кадры.
 *
 * «Организаций» в консоли ещё нет — экрана под этот адрес не заведено. Адрес
 * назван здесь заранее не про запас, а потому что четыре кадра (f44, f45,
 * f51, f52) рисуют у суперадміна в этом разделе другую полосу, чем в разделе
 * людей: правило без него было бы записано неверно и разошлось бы с кадрами
 * в день, когда экран появится.
 */
export function barSection(pathname: string): "people" | "organisations" | "other" {
  const at = (root: string) => pathname === root || pathname.startsWith(`${root}/`);
  if (at("/staff") || at("/admins")) return "people";
  if (at("/organisations")) return "organisations";
  return "other";
}

/**
 * Какое рабочее место у вошедшего на этом экране.
 *
 * Отдано наружу, потому что тот же вопрос задаёт карточка человека: под
 * карточкой в общей консоли лежит список или плитки (f04, f30, f31), а в
 * разделе людей — ничего, кроме подчинённых лікарів у чужой карточки
 * администратора (f40, f43, f47 против f50). Два ответа на один вопрос
 * разошлись бы на первой же правке.
 *
 * `treats` — «видит пациентов»: право users.manage у заведующего и у чистого
 * администратора одно и то же, а patients.read их и разделяет.
 */
export function barKind(
  user: { role?: string | null; ladderRank?: number | null } | null | undefined,
  treats: boolean,
  pathname: string,
): BarKind {
  const section = barSection(pathname);
  if (user?.role === "superadmin") {
    /* f47–f50 против f44/f45/f51/f52: у одного человека две полосы, и выбирает раздел */
    if (section === "people") return "peopleAdmins";
    if (section === "organisations") return "peopleStaff";
    /* клинических экранов суперадміна кадров нет — полоса остаётся полной */
    return "admin";
  }
  const managesPeople = (user?.ladderRank ?? 0) > 1;
  /* f40–f43: ведёт людей, но не лечит — и только в разделе людей, других кадров нет */
  if (managesPeople && !treats && section !== "other") return "peopleStaff";
  return managesPeople ? "admin" : "specialist";
}

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
  bar,
  hidden,
  onSearch,
  theme,
  onToggleTheme,
  menu,
}: {
  counts: RailCounts;
  isSuper: boolean;
  /**
   * Состав полосы. Без него — прежнее поведение (шесть пунктов, семь у тех,
   * кому есть кого назначать): полосу делят все разделы, и молчаливая смена
   * состава у того, кто свойство не передал, была бы сменой экрана.
   */
  bar?: BarKind;
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
  const items = bars[bar ?? (isSuper || canAssign ? "admin" : "specialist")];

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
          /*
            Тесноту задаёт седьмой пункт, а не размер стекла.
            Зазор 46 — замер полосы из шести пунктов (f04: 44,44,44,43,45
            между чернилами). В семипунктовой полосе пункты стоят теснее:
            f30 даёт 31,44,34,33,29,24 — в среднем 33. Прежде 46 держались до
            ширины окна 1250, и на широком стекле семипунктовый набор выходил
            за кадр на 80px. Медиазапрос оставлен страховкой узкого окна.
          */
          className={cx(
            "flex flex-1 items-center justify-center max-[1250px]:gap-[30px] max-[1100px]:hidden",
            items.length > 6 ? "gap-[33px]" : "gap-[46px]",
          )}
        >
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={cx(
                "whitespace-nowrap text-[20px] font-bold leading-none no-underline",
                "transition-colors duration-[var(--dur-fast)]",
                "outline-none focus-visible:ring-2 focus-visible:ring-[#663399]",
                /*
                  ТЕКУЩИЙ ПУНКТ НИЧЕМ НЕ ВЫДЕЛЕН — все подписи одного
                  #663399.

                  Замер чернил пункта, совпадающего с адресом экрана: из
                  шестнадцати кадров полосы бледный тон стоит на четырёх
                  (f30 — (179,152,206), f49 — (171,143,204), f05 —
                  «Пацієнти» (171,143,204), f06 — «Групи» там же), а на
                  двенадцати (f13, f14, f31, f34, f35, f36, f37, f40,
                  f41, f42, f43, f47, f48, f50) ровно (102,51,153) при
                  том же растре (217 тёмных пикселей и там и там, то
                  есть цвет, а не начертание). Кадры спорят сами с собой
                  на одном и том же экране списка: f42 рисует «Лікарі»
                  полным цветом, f49 — «Адміністратори» бледным; f05 и
                  f06 бледнят свой пункт, а f13 и f14 — соседние экраны
                  того же раздела — не бледнят.

                  Разрешено в пользу большинства, и второй довод тот же:
                  бледный кадра #ab8fcc на полосе #f0ecff даёт 2,79:1 —
                  вдвое ниже нормы. Подставлять вместо него «похожий, но
                  читаемый» тон значило бы рисовать то, чего нет ни на
                  одном кадре: на двенадцати подсветки нет вовсе, а на
                  четырёх она именно та, которую нельзя прочесть. «Вы
                  здесь» несёт aria-current, который NavLink ставит сам.
                  Вопрос вынесен заказчику отдельной строкой отчёта
                  сверки: бледный тон принимается только вместе с новым
                  числом, проходящим по контрасту.

                  Наведение — отдельный разговор: это ответ на действие, а
                  не состояние экрана, и кадры его в полосе не рисуют.
                  Тон наведения #7a4ea6 (5,23:1 на полосе) оставлен
                  литералом, а не токеном --primary-dim, по той же
                  причине, что и сама полоса: она не меняется с темой, а
                  токен меняется — в тёмной теме он светлеет и на светлой
                  полосе становится нечитаем.
                */
                "text-[#663399] hover:text-[#7a4ea6]",
              )}
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
              items={items}
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
 *
 * Размер — свойство места, а не знака: в полосе он 70, на публичной странице
 * (кадры f00/f01) над заголовком — 136, в подвале — 80. Один рисунок с
 * `size`, а не три копии: копии разошлись бы на первой же правке букв.
 * Отдан наружу ради pages/public — второй знак POLSY в проекте не нужен.
 */
export function Logo({ size = 70 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
 * не существует. В учётной записи и на странице приглашения LangSwitch
 * остаётся: там место есть, и выбор из двух нагляднее переключения. Лендинг
 * и вход (кадры f00/f01) берут это же слово: у них в левом верхнем углу стоит
 * одно «Укр», и отсюда оно отдано наружу, чтобы не рисовать второе.
 */
export function LangToggle() {
  const { lang, setLang, ut } = useLang();
  return (
    <button
      type="button"
      onClick={() => setLang(lang === "uk" ? "ru" : "uk")}
      /*
       * Видимое слово входит в имя для диктора, и первым. Стояло голое
       * «Мова / Язык»: тот, кто управляет голосом, говорит то, что видит
       * («Укр»), — и не попадал по кнопке (WCAG 2.5.3 Label in Name).
       * Убрать aria-label совсем было бы дешевле, но тогда имя — одно
       * «Укр», и диктор не сообщает, что это переключатель. Хвост называет
       * сам язык и потому не переводится — та же подпись, что у LangSwitch.
       */
      aria-label={ut("top.lang") + " — Мова / Язык"}
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
  items,
  children,
}: {
  counts: RailCounts;
  isSuper: boolean;
  canAssign: boolean;
  hidden?: string[];
  /** Пункты полосы — те же, что показаны вверху: на узком экране они повторяются здесь */
  items: TopItem[];
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
  const caseLinks = useMemo(() => clinicalLinks(pathname), [pathname]);

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
          {items.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.end} className={rowClass}>
              <span className="truncate">{ut(it.key)}</span>
            </NavLink>
          ))}
        </div>

        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2 [scrollbar-width:thin]">
          {/*
            Клиническая карта открытого человека — сводка, динамика,
            хронология. Раздел появляется только на карточке пациента и
            только там имеет смысл: это двери к ОДНОМУ человеку, а не к
            экрану консоли.

            Стояли эти три входа шестерёнкой в строке заголовка карточки, а
            на кадре f13 в той строке одна кнопка «Відписатись» и больше
            ничего. Бургер — то место, куда макет и складывает все двери,
            не поместившиеся в полосу; здесь они и лежат.
          */}
          {caseLinks ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 px-2 py-1 text-micro font-semibold uppercase tracking-[var(--tracking-label)] text-faint">
                <span className="truncate">{ut("pcard.clinical")}</span>
              </div>
              {caseLinks.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} className={rowClass}>
                  <span className="truncate">{ut(it.key)}</span>
                </NavLink>
              ))}
            </div>
          ) : null}
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

/**
 * Три входа клинической карты, когда открыт человек.
 *
 * Адрес читается из пути, а не приходит свойством: бургер один на консоль и
 * стоит выше любого экрана, а карточка пациента — не единственный экран
 * человека (на /patients/:id/case разделы те же). Признак «открыт человек» —
 * первый сегмент /patients и второй, не похожий на служебное слово.
 *
 * Вне карточки — пусто: раздел, ведущий к «тому, кого мы недавно смотрели»,
 * был бы дверью в неизвестно чью карту.
 */
function clinicalLinks(pathname: string): { to: string; key: UiKey; end?: boolean }[] | null {
  const m = /^\/patients\/([^/]+)/.exec(pathname);
  const id = m?.[1];
  if (!id) return null;
  const base = `/patients/${id}/case`;
  return [
    { to: base, key: "pc.overview", end: true },
    { to: `${base}/dynamics`, key: "pc.dynamics" },
    { to: `${base}/timeline`, key: "tl.title" },
  ];
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
