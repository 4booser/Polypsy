import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { ALWAYS_VISIBLE_RAIL, type UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import {
  IconAlert,
  IconAudit,
  IconBattery,
  IconChevron,
  IconClock,
  IconDashboard,
  IconGroup,
  IconPatients,
  IconReferral,
  IconStack,
  IconSurvey,
  IconUserGear,
  IconUsers,
} from "../ui";

/*
 * Рельса разделов: группы раскрываются, а не лежат все сразу.
 *
 * Было пять групп, развёрнутых всегда, и у суперадмина это двадцать пять
 * строк в одну колонку с прокруткой. Такой список не читают — по нему
 * скользят глазами сверху вниз, каждый раз заново отыскивая знакомое слово.
 * Заголовки групп при этом только занимали место: они ничего не делали,
 * потому что под ними всё равно лежало всё.
 *
 * Теперь заголовок — кнопка. Открыта обычно одна группа, и на экране
 * шесть-семь строк вместо двадцати пяти.
 *
 * Три следствия, без которых раскрытие было бы ухудшением:
 *
 * 1. **Счётчики поднимаются в заголовок закрытой группы.** Иначе сворачивание
 *    прятало бы то, ради чего счётчик заведён: три неразобранных случая
 *    внутри закрытой «Сегодня» показывают спокойный экран человеку, которому
 *    надо действовать.
 *
 * 2. **Группа с текущим экраном раскрывается сама.** Навигация, в которой не
 *    видно, где ты находишься, заставляет искать себя после каждого перехода.
 *
 * 3. **Состояние запоминается.** Рельса, которая сбрасывается при каждой
 *    перезагрузке, вынуждает раскрывать своё каждое утро.
 *
 * Заодно вернулись четыре экрана, убранные из рельсы в волне 10: батареи,
 * сеансы киоска, расписание повторов, приглашения. Тогда их убрали потому,
 * что «пункт в рельсе стоит внимания на каждом открытии консоли, а нужен
 * раз в месяц», — и это было верно для всегда развёрнутого списка. В
 * закрытой группе пункт внимания не стоит вовсе, а открывать эти экраны по
 * набранному вручную адресу — цена, которую больше незачем платить.
 */

interface Item {
  to: string;
  key: UiKey;
  icon: ReactNode;
  end?: boolean;
  badge?: number;
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
        { to: "/alerts", key: "nav.cases", icon: <IconAlert />, badge: counts.alerts },
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
        { to: "/groups", key: "nav.groups", icon: <IconGroup /> },
        { to: "/my-schedule", key: "nav.reception", icon: <IconClock /> },
      ],
    },
    {
      key: "nav.group.methods",
      icon: <IconSurvey />,
      items: [
        { to: "/surveys", key: "nav.surveys", icon: <IconSurvey /> },
        { to: "/batteries", key: "nav.batteries", icon: <IconBattery /> },
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
    adminItems.push({ to: "/permissions", key: "perm.title", icon: <IconGroup /> });
  }
  if (isSuper) {
    /* текст согласия стал вкладкой учётных записей: это настройка
       учреждения, а не отдельный раздел работы */
    adminItems.push(
      { to: "/users", key: "nav.users", icon: <IconUsers /> },
      { to: "/audit", key: "nav.audit", icon: <IconAudit /> },
      { to: "/console", key: "nav.console", icon: <IconStack /> },
    );
  }
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
 * Раздел «Аналітика» верхнего меню (Topbar.tsx → /analytics) — другое: это
 * перечень аналитических моделей, то есть правил поддержки решений; он
 * живёт в верхней полосе вместе с остальными разделами макета, и рельса
 * его не дублирует.
 *
 * Библиотека компонентов и описание API открываются по адресам /ui и
 * /api-docs. Это инструменты того, кто пишет систему, а не того, кто
 * принимает людей, и в меню они занимали место наравне с журналом доступа.
 */

/**
 * Какой группе принадлежит текущий адрес.
 *
 * Выигрывает самое длинное совпадение, а не первое: «/» есть начало любого
 * адреса, и по первому совпадению сводка забирала бы себе каждый экран, а
 * раскрывалась бы всегда одна и та же группа.
 */
export function groupOfPath(groups: Group[], path: string): UiKey | null {
  let best: { key: UiKey; len: number } | null = null;
  for (const g of groups) {
    for (const it of g.items) {
      const hit = it.end ? path === it.to : path === it.to || path.startsWith(`${it.to}/`);
      if (hit && (!best || it.to.length > best.len)) best = { key: g.key, len: it.to.length };
    }
  }
  return best?.key ?? null;
}

const STORE_KEY = "quizzy.rail.open";

function readOpen(): string[] | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    // испорченное значение — не повод падать при загрузке консоли
    return null;
  }
}

/*
 * Ниже этой ширины рельса не сжимает содержимое, а ложится поверх него.
 * Порог тот же, что в классах ниже (max-[900px]), и он здесь ровно потому,
 * что поведение при выезде поверх — другое: это уже не колонка, а ящик,
 * который открывают и закрывают.
 */
const NARROW = "(max-width: 900px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return narrow;
}

/* что считается мишенью табуляции внутри рельсы */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function RailLink({ item, collapsed }: { item: Item; collapsed: boolean }) {
  const { ut } = useLang();
  const label = ut(item.key);
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cx(
          "group relative flex items-center rounded-sm text-small",
          "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
          collapsed ? "h-9 w-9 justify-center" : "h-[30px] gap-2.5 px-2",
          isActive
            ? "bg-surface-3 text-text font-medium"
            : "text-muted hover:bg-surface-2 hover:text-text",
        )
      }
    >
      {({ isActive }) => (
        <>
          {/*
            Активный раздел отмечен полосой слева, а не заливкой посветлее:
            заливку в тёмной теме на плохом мониторе не видно, полосу — видно
            всегда, и она не спорит с янтарным.
          */}
          <span
            aria-hidden
            className={cx(
              "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary",
              "transition-opacity duration-[var(--dur-fast)]",
              isActive ? "opacity-100" : "opacity-0",
            )}
          />
          <span className="shrink-0 [&>svg]:size-[18px]">{item.icon}</span>
          {collapsed ? null : <span className="truncate">{label}</span>}
          {/*
            Счётчик залит янтарём, а не набран янтарём по прозрачному фону.
            Полупрозрачная заливка давала в светлой теме 4,32:1 при пороге
            4,5 — и хуже всего именно на выбранном пункте, где под меткой
            лежит более светлая поверхность. Сплошная заливка даёт 6,4:1 на
            бумаге и 10,7:1 в тёмной теме; заодно это честнее по смыслу:
            число, которое требует внимания, не должно быть бледнее
            соседнего текста.
          */}
          {item.badge ? (
            <span
              className={cx(
                "bg-accent font-mono text-micro leading-none text-accent-text tabular-nums",
                collapsed
                  ? "absolute -right-0.5 -top-0.5 rounded-full px-1 py-0.5"
                  : "ml-auto rounded-sm px-1.5 py-0.5 font-semibold",
              )}
            >
              {item.badge > 99 ? "99+" : item.badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function GroupHeader({
  group,
  open,
  hidden,
  onToggle,
}: {
  group: Group;
  open: boolean;
  /** Сумма счётчиков внутри — показывается, только когда группа закрыта */
  hidden: number;
  onToggle: () => void;
}) {
  const { ut } = useLang();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={`rail-${group.key}`}
      className={cx(
        "flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-small",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
        "outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        open ? "font-medium text-text" : "text-muted hover:text-text",
      )}
    >
      <span className="shrink-0 [&>svg]:size-[18px]">{group.icon}</span>
      <span className="truncate">{ut(group.key)}</span>
      {/*
        Счётчик закрытой группы — сумма её пунктов. Без него сворачивание
        прятало бы срочное: три неразобранных случая внутри закрытой группы
        показывают спокойный экран человеку, которому надо действовать.
      */}
      {!open && hidden > 0 ? (
        <span className="ml-auto rounded-sm bg-accent px-1.5 py-0.5 font-mono text-micro font-semibold leading-none text-accent-text tabular-nums">
          {hidden > 99 ? "99+" : hidden}
        </span>
      ) : null}
      <span
        aria-hidden
        className={cx(
          "shrink-0 text-faint [&>svg]:size-[14px]",
          !open && hidden > 0 ? "ml-1.5" : "ml-auto",
          "transition-transform duration-[var(--dur-fast)] ease-[var(--ease)]",
          open && "rotate-90",
        )}
      >
        <IconChevron />
      </span>
    </button>
  );
}

export function Rail({
  counts,
  isSuper,
  canAssign,
  collapsed,
  hidden,
  children,
}: {
  counts: RailCounts;
  isSuper: boolean;
  /** Есть ли кому назначать роли: от этого зависит пункт «Права» */
  canAssign: boolean;
  collapsed: boolean;
  /** Что человек убрал с глаз в настройках рабочего места */
  hidden?: string[];
  children?: ReactNode;
}) {
  const { ut } = useLang();
  const { pathname } = useLocation();
  const groups = useMemo(
    () => railGroups(counts, isSuper, canAssign, hidden ?? []),
    [counts, isSuper, canAssign, hidden],
  );
  const active = groupOfPath(groups, pathname);

  /*
   * На узком экране рельса — ящик, а не колонка, и у неё два состояния,
   * которых на широком не бывает.
   *
   * **Задвинута.** Сдвиг трансформацией уводил её за левый край, но из
   * разметки не убирал: двенадцать ссылок оставались в порядке табуляции.
   * Первые двенадцать Tab на телефоне уходили за край экрана — кольца
   * фокуса не видно нигде, до содержимого не добраться, и человек не
   * понимает, куда он попал. Автопроверка на это молчит по построению:
   * элемент не спрятан, он сдвинут, а про смещённые трансформацией она
   * ничего не знает.
   *
   * **Выехала поверх.** Ящик, перекрывающий содержимое, обязан закрываться:
   * Esc, нажатием мимо и переходом по ссылке внутри. Ничего этого не было —
   * открыв рельсу и передумав, человек с клавиатуры оставался под ней
   * навсегда, а перейдя по ссылке, читал новый экран сквозь неё.
   *
   * Закрытие держится здесь, а не у владельца состояния, намеренно:
   * `collapsed` отвечает на вопрос «просили ли рельсу», а ящик закрывается
   * по своим правилам, которых на широком экране не существует вовсе.
   * Признак сбрасывается при каждом переключении снаружи — иначе кнопка
   * панели перестала бы открывать закрытый ящик.
   */
  const narrow = useNarrow();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [collapsed]);

  const overlay = narrow && !collapsed && !dismissed;
  const offscreen = narrow && (collapsed || dismissed);

  /* переход по ссылке закрывает ящик: иначе новый экран читают сквозь него */
  const seenPath = useRef(pathname);
  useEffect(() => {
    if (seenPath.current === pathname) return;
    seenPath.current = pathname;
    if (window.matchMedia(NARROW).matches) setDismissed(true);
  }, [pathname]);

  /*
   * Пока ящик открыт, табуляция ходит внутри него, а Esc закрывает.
   *
   * Ловушка нужна по той же причине, по которой нужен был inert у
   * задвинутой рельсы: за краем ящика фокус не виден. Разница лишь в том,
   * что здесь невидимо содержимое ПОД ящиком, а не сам ящик.
   */
  const boxRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!overlay) return;
    const opener = document.activeElement as HTMLElement | null;
    const inside = () => [...(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    inside()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDismissed(true);
        return;
      }
      if (e.key !== "Tab") return;
      const list = inside();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const here = document.activeElement;
      const out = !boxRef.current?.contains(here);
      if (e.shiftKey ? here === first || out : here === last || out) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      /* фокус возвращается туда, откуда ящик открыли, а не в начало документа */
      opener?.focus?.();
    };
  }, [overlay]);

  /*
   * Первый заход раскрывает только ту группу, в которой находится человек.
   * Раскрыть всё «на всякий случай» значило бы вернуть прежний длинный
   * список и отменить смысл затеи.
   */
  const [open, setOpen] = useState<Set<string>>(() => {
    const stored = readOpen();
    if (stored) return new Set(stored);
    return new Set(active ? [active] : ["nav.group.overview"]);
  });

  // группа текущего экрана раскрывается сама: навигация, в которой не видно,
  // где ты, заставляет искать себя после каждого перехода
  useEffect(() => {
    if (!active) return;
    setOpen((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [active]);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...open]));
    } catch {
      // приватный режим браузера запрещает запись; рельса от этого работать
      // не перестаёт, просто не запоминает раскрытое
    }
  }, [open]);

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <>
      {/*
        Подложка под выехавшим ящиком.

        Она не украшение: это единственное, что отвечает на нажатие мимо
        рельсы. Без неё нажатие приходилось по содержимому под ящиком —
        человек целился «закрыть», а попадал в ссылку, которую не видел.
      */}
      {overlay ? (
        <div
          aria-hidden
          onClick={() => setDismissed(true)}
          className="fixed inset-0 z-[39] bg-[color-mix(in_srgb,var(--bg)_70%,transparent)]"
        />
      ) : null}
    {/*
      Рельса прибита к окну и прокручивается внутри себя. Иначе подвал —
      имя, роль, стартовый экран и выход — уезжает за нижний край на
      ноутбучном экране, и человек не находит кнопку выхода вовсе.
      Прокручивается только список разделов: подвал остаётся на месте.
    */}
    <aside
      ref={boxRef}
      /*
        Задвинутая рельса убрана из табуляции и из дерева доступности.

        inert — для браузера и диктора, visibility:hidden — для самого
        порядка табуляции и для случая, когда разметка отрисована, а сценарий
        ещё не выполнялся. Одного aria-hidden было бы мало и даже хуже:
        скрытый от диктора, но достижимый Tab элемент — отдельное нарушение.
      */
      inert={offscreen}
      aria-hidden={offscreen || undefined}
      /* выехавший поверх ящик обязан быть назван: он перекрывает экран */
      role={overlay ? "dialog" : undefined}
      aria-modal={overlay || undefined}
      aria-label={overlay ? ut("shell.sections") : undefined}
      className={cx(
        "sidebar sticky top-0 z-40 flex h-screen shrink-0 flex-col overflow-x-hidden",
        "border-r border-hairline bg-rail",
        "transition-transform duration-[var(--dur)] ease-[var(--ease)]",
        collapsed ? "w-14 px-2 py-3" : "w-[var(--rail-w)] px-3 py-3",
        /*
          Ниже 900 px рельса не сжимает содержимое, а ложится поверх него.
          Деление на две колонки на телефоне не оставляет места ни одной
          таблице: содержимое уезжает вбок, и страницу приходится возить
          горизонтально — на списке из восьми тысяч человек это невыносимо.
          Поэтому здесь она выводится из потока и выезжает по кнопке.
        */
        "max-[900px]:fixed max-[900px]:left-0 max-[900px]:top-0 max-[900px]:w-[var(--rail-w)] max-[900px]:px-3 max-[900px]:shadow-panel",
        offscreen
          ? "max-[900px]:invisible max-[900px]:-translate-x-full"
          : "max-[900px]:visible max-[900px]:translate-x-0",
      )}
    >
      <div
        className={cx(
          "mb-3 flex shrink-0 items-center gap-2 px-1",
          collapsed && "justify-center px-0",
        )}
      >
        {/*
          Знак обведён, а не залит.
          Nocturne держит акцент линией и свечением, а не заливкой: залитый
          квадрат — единственное пятно чистого акцента на всём экране, и он
          перетягивал взгляд с того, ради чего рельса существует, — со
          счётчиков срочного.
        */}
        <span
          aria-hidden
          className={cx(
            "grid size-[26px] shrink-0 place-items-center rounded-[7px]",
            "border border-primary font-display text-small font-semibold text-primary",
            "shadow-[0_0_14px_color-mix(in_srgb,var(--primary)_35%,transparent)]",
          )}
        >
          Q
        </span>
        {collapsed ? null : (
          <span className="font-display text-section font-semibold tracking-tight">Quizzy</span>
        )}
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto [scrollbar-width:thin]">
        {groups.map((g, gi) => {
          /*
           * Свёрнутая до значков рельса групп не раскрывает: раскрывать
           * нечего — подписей нет, и выпадающий список поверх узкой полосы
           * пришлось бы городить ради экрана, который открывают как раз
           * чтобы освободить место. Там остаётся плоский список со старым
           * разделителем.
           */
          if (collapsed) {
            return (
              <div key={g.key} className="flex flex-col gap-0.5">
                {gi > 0 ? (
                  <hr className="mx-auto my-2 w-6 border-0 border-t border-hairline" />
                ) : null}
                {g.items.map((it) => (
                  <RailLink key={it.to} item={it} collapsed />
                ))}
              </div>
            );
          }

          const isOpen = open.has(g.key);
          const hidden = g.items.reduce((sum, it) => sum + (it.badge ?? 0), 0);
          return (
            <div key={g.key} className="flex flex-col gap-0.5">
              <GroupHeader group={g} open={isOpen} hidden={hidden} onToggle={() => toggle(g.key)} />
              {isOpen ? (
                <div
                  id={`rail-${g.key}`}
                  /*
                    Тонкая направляющая слева вместо рамки вокруг: она
                    показывает, докуда простирается группа, и не рисует
                    коробку внутри коробки. Отступ ставит пункты под
                    подписью заголовка, а не под его значком.
                  */
                  className="mb-1 ml-[1.05rem] flex flex-col gap-0.5 border-l border-hairline pl-1"
                >
                  {g.items.map((it) => (
                    <RailLink key={it.to} item={it} collapsed={false} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
      {children ? (
        <div className="shrink-0">
          {/*
            Черта гаснет к краям, а не обрывается.
            Подпись системы: сплошная линия во всю ширину делит рельсу на две
            коробки, гаснущая — просто отделяет подвал от списка.
          */}
          <div
            aria-hidden
            className="my-2.5 h-px bg-[linear-gradient(to_right,transparent,var(--hairline)_32px,var(--hairline)_calc(100%-32px),transparent)]"
          />
          {children}
        </div>
      ) : null}
    </aside>
    </>
  );
}
