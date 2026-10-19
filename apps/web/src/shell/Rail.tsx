import { useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { ALWAYS_VISIBLE_RAIL, type UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import {
  IconAlert,
  IconBattery,
  IconClock,
  IconDashboard,
  IconGroup,
  IconMessage,
  IconPatients,
  IconPulse,
  IconReferral,
  IconStack,
  IconSurvey,
  IconUserGear,
  IconUsers,
} from "../ui";
import { ShellIcon } from "./icons";
import { railKeyOf, type RailEntry } from "./nav";
import { Tooltip } from "../ui/Popover";

/*
 * Разделы консоли: полный список (railGroups) и рельса значков (Rail).
 *
 * railGroups — весь набор разделов одним списком. Он остался от прежних
 * раскладок (боковая рельса с группами, потом бургер верхней полосы), и он
 * по-прежнему единственный: его читает экран настроек рабочего места
 * («убрать с глаз», Account.tsx) и проверки состава (test/rail.test.tsx).
 *
 * Rail — левая колонка Polypsy 2.0: десять разделов значком и словом, как в
 * наборе «Виразної» (kit/shell.py, RAIL). Состав и счётчики — в nav.ts,
 * здесь только как они нарисованы. Ниже 1280 px слова уходят, остаются
 * значки с подсказкой; ниже 1100 px рельсы нет вовсе — все разделы в меню
 * «Ще розділи» на полосе приложения (MoreMenu.tsx).
 */

interface Item {
  to: string;
  key: UiKey;
  icon: ReactNode;
  end?: boolean;
  badge?: number;
  /**
   * Число у пункта требует внимания, а не сообщает объём работы. Сейчас это
   * одни случаи риска: неразобранный случай — человек, которому, возможно,
   * плохо прямо сейчас. Люди на приём, задачи очереди и открытые
   * направления — счёт дела, а не тревога. На рельсе Polypsy 2.0 то же
   * правило держит цвет счётчика (nav.ts: красный — только «Ризик»).
   */
  attention?: boolean;
}

interface Group {
  key: UiKey;
  icon: ReactNode;
  items: Item[];
}

export interface RailCounts {
  /** Сколько людей ещё не принято сегодня: счётчик убывает по ходу дня */
  today?: number;
  worklist?: number;
  alerts?: number;
  referrals?: number;
}

/**
 * Убрать с глаз то, что человек убрал, — кроме сигнальных пунктов.
 *
 * Правило проверяется и здесь, и на сервере. Двойная проверка не от
 * недоверия: серверная закрывает запрос мимо экрана настроек, а эта —
 * настройку, сохранённую до того, как пункт стал сигнальным. Число рядом с
 * разделом появляется по мере развития системы, и список у человека в
 * профиле от этого не переписывается сам.
 *
 * Группа, оставшаяся без пунктов, исчезает целиком: заголовок раздела, под
 * которым ничего нет, — это не порядок, а обломок.
 */
function applyHidden(groups: Group[], hidden: readonly string[]): Group[] {
  if (!hidden.length) return groups;
  const off = new Set(hidden.filter((k) => !(ALWAYS_VISIBLE_RAIL as readonly string[]).includes(k)));
  if (!off.size) return groups;
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !off.has(i.key)) }))
    .filter((g) => g.items.length > 0);
}

export function railGroups(
  counts: RailCounts,
  isSuper: boolean,
  canAssign = false,
  hidden: readonly string[] = [],
  canOps = false,
): Group[] {
  const groups: Group[] = [
    {
      key: "nav.group.overview",
      icon: <IconClock />,
      items: [
        /*
         * Сводка и «Сегодня» слиты в один экран с вкладками: и то и другое
         * отвечает на вопрос «с чего начать смену», и выбирать между двумя
         * ответами на один вопрос человеку незачем.
         */
        { to: "/", key: "nav.dashboard", icon: <IconDashboard />, end: true, badge: counts.today },
        { to: "/worklist", key: "nav.worklist", icon: <IconClock />, badge: counts.worklist },
        { to: "/alerts", key: "nav.cases", icon: <IconAlert />, badge: counts.alerts, attention: true },
      ],
    },
    {
      key: "nav.group.people",
      icon: <IconPatients />,
      items: [
        { to: "/patients", key: "nav.patients", icon: <IconPatients /> },
        /*
         * Направления переехали из «Обзора» к людям. Направление — это
         * человек, отправленный дальше, и открывают его, думая о человеке, а
         * не о том, что сегодня за день. В обзоре оно стояло рядом со
         * случаями риска и читалось как ещё один сорт тревоги.
         */
        { to: "/referrals", key: "nav.referrals", icon: <IconReferral />, badge: counts.referrals },
        { to: "/search", key: "srch.title", icon: <IconStack /> },
        { to: "/cohorts", key: "coh.title", icon: <IconGroup /> },
        /*
         * «Групи» здесь — группы ПАЦИЕНТОВ, как и в верхней полосе: одно
         * слово, одна дверь. Группы методик — ниже, в «Методиках», под своим
         * полным именем.
         */
        { to: "/patient-groups", key: "nav.groups", icon: <IconGroup /> },
        { to: "/my-schedule", key: "nav.reception", icon: <IconClock /> },
        /*
         * Переписка с пациентом. Пункт полосы «Повідомлення» ушёл на
         * розсилки (кадр f09), и без этой строки у переписки осталась бы
         * одна дверь — палитра команд. Ключ — заголовок самого экрана
         * («Листування»), чтобы два «Повідомлення» не вели на два разных
         * экрана.
         */
        { to: "/messages", key: "ms.title", icon: <IconMessage /> },
      ],
    },
    {
      key: "nav.group.methods",
      icon: <IconSurvey />,
      items: [
        { to: "/surveys", key: "nav.surveys", icon: <IconSurvey /> },
        { to: "/batteries", key: "nav.batteries", icon: <IconBattery /> },
        /*
         * Группы методик переехали из «Людей» сюда: это единица доступа к
         * методикам, а не список людей, и рядом с пациентами они читались как
         * ещё один способ собрать людей. Ключ — заголовок самого экрана
         * («Групи методик»), как у поиска и подбора: второго перевода тому же
         * названию не заводится.
         */
        { to: "/groups", key: "adm.groupsTitle", icon: <IconGroup /> },
      ],
    },
  ];
  /*
   * Администрирование собирается ОДНОЙ группой, а не двумя.
   *
   * «Права» жили отдельной группой с ключом «Люди» — тем же, что у группы
   * пациентов. В рельсе получалось два раздела «Люди»: один с пациентами,
   * второй с одним пунктом. Хуже видимого: состояние раскрытия хранится по
   * ключу, поэтому обе группы открывались и закрывались вместе.
   *
   * По смыслу «Права» и не про людей, которых лечат, а про тех, кто лечит, —
   * это администрирование. Группа показывается тому, кому есть что в ней
   * делать: назначающему — права, техническому администратору — всё
   * остальное.
   *
   * Само правило доступа живёт на маршрутах; здесь только меню.
   */
  const adminItems: Item[] = [];
  if (canAssign || isSuper) {
    /*
     * «Лікарі» и «Адміністратори» — разделы макета (кадры f43, f50) рядом с
     * «Правами»: список людей, которых назначают, и сама раздача — одно
     * дело, и открыты они одним и тем же — тем, кому есть кого назначать.
     * Устройства и пациентские записи, которых в разделах макета нет, живут
     * во вкладке «Користувачі» техпанели (прежние «Облікові записи»).
     */
    adminItems.push(
      { to: "/staff", key: "ppl.staff", icon: <IconUsers /> },
      { to: "/admins", key: "adm.admins", icon: <IconUserGear /> },
      { to: "/permissions", key: "perm.title", icon: <IconGroup /> },
    );
  }
  if (isSuper) {
    /*
     * «Облікові записи» и «Журнал доступу» отсюда ушли (волна 10): оба стали
     * вкладками техпанели — «Користувачі» и «Аудит», — а их адреса ведут
     * туда перенаправлением. Два пункта меню на один экран — это две двери,
     * из которых одна однажды поведёт не туда. Текст согласия открывается
     * со вкладки «Користувачі».
     */
    adminItems.push({ to: "/console", key: "nav.console", icon: <IconStack /> });
  }
  /*
   * Техпанель — по праву, а не по классу: пункт виден, если открыта хоть
   * одна её вкладка (ops.read, users.manage или audit.read — canOpenOps в
   * pages/ops/model.ts). Суперадмину права достаются вместе со всеми,
   * разработчику их выдают исключением. Стоит последней в администрировании.
   */
  if (canOps) adminItems.push({ to: "/ops", key: "nav.ops", icon: <IconPulse /> });
  if (adminItems.length) {
    groups.push({ key: "nav.admin", icon: <IconUserGear />, items: adminItems });
  }

  /*
   * Ключи групп обязаны быть разными: по ключу хранится состояние
   * раскрытия и по нему же ищется группа активного экрана. Совпадение
   * ключей — не косметика, а склейка двух разделов в один, и заметить её
   * можно только глазами на живом экране. Здесь она стоит денег один раз.
   */
  const seen = new Set<string>();
  for (const g of groups) {
    if (seen.has(g.key)) throw new Error(`рельса: ключ группы «${g.key}» повторяется`);
    seen.add(g.key);
  }
  return applyHidden(groups, hidden);
}

/*
 * Чего в рельсе нет и почему — чтобы не завели заново.
 *
 * Убраны по прямому решению: сравнение когорт, эпидемиологическое
 * наблюдение, отчёт отделения, отчёт подразделения, пакет заключений,
 * сеансы киоска, маршруты помощи. Аналитика самой методики осталась там,
 * где ей место, — на ней (/surveys/:id): вопрос «что показывает эта
 * методика» задают, глядя на методику, а не на отдельный экран сравнения.
 * Раздел «Аналітика» рельсы (/analytics, /statistics — nav.ts) — другое: это
 * перечень аналитических и статистических моделей; в этом списке его нет,
 * потому что настройка «убрать с глаз» его не касалась и раньше.
 *
 * Библиотека компонентов открывается по адресу /ui. Это инструмент того,
 * кто пишет систему, а не того, кто принимает людей. Описание API — в
 * подразделах администрирования у суперадміна (nav.ts), рядом с консолью.
 */

/* ─────────── рельса значков ─────────── */

/** Окно уже порога: подписи рельсы ушли, остались значки с подсказкой */
export const ICONS_ONLY = "(max-width: 1279px)";

function subscribeMedia(query: string) {
  return (fn: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  };
}

/**
 * Подходит ли окно под медиазапрос — и перерисовка, когда перестаёт.
 *
 * Подписка — одна на запрос, а не новая на каждую отрисовку: новая функция
 * подписки заставляет useSyncExternalStore отписываться и подписываться
 * заново при любой перерисовке рельсы и экранов (каждый переход, каждый такт
 * счётчиков).
 */
export function useMedia(query: string): boolean {
  const subscribe = useMemo(() => subscribeMedia(query), [query]);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Число у раздела: нейтральное (объём работы), красное (риск для человека)
 * или фиолетовое («моё»: письма мне). Обведено цветом рельсы, чтобы не
 * сливаться со значком, на который заходит краем.
 */
export function RailBadge({ n, tone, inline }: NonNullable<RailEntry["badge"]> & { inline?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "h-[18px] min-w-[18px] rounded-[9px] px-[5px] text-center",
        "text-[10.5px] font-extrabold leading-[18px] tabular-nums",
        inline
          ? "ml-auto inline-block shrink-0"
          : "absolute left-[calc(50%+8px)] top-[1px] shadow-[0_0_0_2px_var(--panel)] max-[1279px]:top-[3px]",
        tone === "risk" ? "bg-risk text-onfill" : tone === "violet" ? "bg-violet text-onfill" : "bg-text-2 text-panel",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/**
 * Подсказка набора справа от значка — только когда слова под значками ушли
 * (окно уже 1280): со словом рядом она повторяла бы видимое.
 */
function IconsOnlyTip({ on, label, children }: { on: boolean; label: string; children: ReactElement }) {
  return on ? (
    <Tooltip label={label} side="right">
      {children}
    </Tooltip>
  ) : (
    children
  );
}

/** Пункт рельсы: значок в пилюле и слово под ним; текущий — пилюля фиолетовым */
function railItem(current: boolean): string {
  return cx(
    "group relative flex min-h-0 w-[70px] shrink-0 flex-col items-center justify-center gap-[4px] rounded-[14px]",
    "border-0 bg-transparent p-0 text-[11.5px] leading-[14px] no-underline hover:no-underline",
    "h-[58px] max-[1279px]:h-[46px] max-[1279px]:w-[52px]",
    current ? "font-extrabold text-violet-ink" : "font-semibold text-text-2 hover:text-text",
  );
}

function RailPill({ current, children }: { current: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid h-[30px] w-[46px] place-items-center rounded-[15px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
        current ? "bg-violet text-onfill" : "text-muted group-hover:bg-sunk group-hover:text-text",
      )}
    >
      {children}
    </span>
  );
}

function RailLink({ entry, current, iconsOnly }: { entry: RailEntry; current: boolean; iconsOnly: boolean }) {
  const { ut } = useLang();
  const full = ut(entry.full);
  /* число входит в имя: «Випадки ризику, 2» — диктор слышит то же, что видит глаз */
  const name = entry.badge ? `${full}, ${entry.badge.n}` : full;
  return (
    <IconsOnlyTip on={iconsOnly} label={name}>
      <Link
        to={entry.to}
        aria-label={name}
        aria-current={current ? "page" : undefined}
        data-rail={entry.key}
        className={railItem(current)}
      >
        <RailPill current={current}>
          <ShellIcon name={entry.icon} size={20} />
        </RailPill>
        {/* без многоточия: «Листування» — самое длинное слово рельсы, и оно умещается в 70 впритык */}
        <span className="whitespace-nowrap max-[1279px]:sr-only">{ut(entry.label)}</span>
        {entry.badge ? <RailBadge {...entry.badge} /> : null}
      </Link>
    </IconsOnlyTip>
  );
}

/**
 * Рельса: разделы значком и словом, «Довідка» прижата вниз.
 *
 * Ссылки, а не кнопки: раздел — это адрес, его открывают в новой вкладке и
 * пересылают. Текущий раздел — `aria-current` и заливка пилюли, а не только
 * цвет слова: пилюлю видно и на плохом мониторе, и в тёмной теме.
 *
 * Прокручивается сама, если окно ниже десяти пунктов (ноутбук боком,
 * увеличенный масштаб): «Довідка» тогда уезжает вниз вместе со списком, а не
 * наезжает на него.
 */
export function Rail({
  entries,
  onHelp,
  helpOpen,
}: {
  entries: RailEntry[];
  onHelp: () => void;
  helpOpen: boolean;
}) {
  const { ut } = useLang();
  const { pathname } = useLocation();
  const active = railKeyOf(pathname);
  const iconsOnly = useMedia(ICONS_ONLY);
  const help = ut("rail.helpFull");
  return (
    <nav
      aria-label={ut("shell.sections")}
      className={cx(
        "flex w-[80px] shrink-0 flex-col items-center gap-[2px] overflow-y-auto overflow-x-hidden",
        "border-r border-border bg-panel py-[12px] [scrollbar-width:none]",
        "max-[1279px]:w-[64px] max-[1099px]:hidden print:hidden",
      )}
    >
      {entries.map((e) => (
        <RailLink key={e.key} entry={e} current={e.key === active} iconsOnly={iconsOnly} />
      ))}
      <span aria-hidden className="min-h-[12px] flex-1" />
      <IconsOnlyTip on={iconsOnly} label={help}>
        <button
          type="button"
          onClick={onHelp}
          aria-label={help}
          aria-haspopup="dialog"
          aria-expanded={helpOpen}
          className={railItem(helpOpen)}
        >
          <RailPill current={helpOpen}>
            <ShellIcon name="circle-help" size={20} />
          </RailPill>
          <span className="max-[1279px]:sr-only">{ut("rail.help")}</span>
        </button>
      </IconsOnlyTip>
    </nav>
  );
}
