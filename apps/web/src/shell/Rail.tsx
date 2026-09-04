import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import type { UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import {
  IconAlert,
  IconAudit,
  IconBattery,
  IconChevron,
  IconClock,
  IconCompare,
  IconDashboard,
  IconGroup,
  IconInvite,
  IconKiosk,
  IconPatients,
  IconPulse,
  IconReferral,
  IconRoute,
  IconStack,
  IconSurvey,
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

export function railGroups(counts: RailCounts, isSuper: boolean): Group[] {
  const groups: Group[] = [
    {
      key: "nav.group.today",
      icon: <IconClock />,
      items: [
        { to: "/", key: "nav.dashboard", icon: <IconDashboard />, end: true },
        /*
         * «Сегодня» стоит вторым, сразу за сводкой: с него начинается
         * рабочий день, и до него не должно быть прокрутки.
         */
        { to: "/today", key: "nav.today", icon: <IconClock />, badge: counts.today },
        /*
         * Переписки в рельсе нет намеренно, и это не пропажа.
         *
         * План волны 5 требовал: «Черга непрочитаного у фахівця — в ту саму
         * чергу роботи, а не окремим місцем, куди треба не забути зайти».
         * Очередь работы это уже делает (routes/worklist.ts: непрочитанные
         * ветки идут наравне с неявками и тревогами) — а пункт «Переписка»
         * рядом с ней был ровно тем вторым местом, мимо которого проходят.
         *
         * Ветка конкретного человека открывается из его карты, общий экран
         * остаётся по адресу /messages.
         */
        { to: "/worklist", key: "nav.worklist", icon: <IconClock />, badge: counts.worklist },
        { to: "/alerts", key: "nav.cases", icon: <IconAlert />, badge: counts.alerts },
        { to: "/referrals", key: "nav.referrals", icon: <IconReferral />, badge: counts.referrals },
      ],
    },
    {
      key: "nav.group.people",
      icon: <IconPatients />,
      items: [
        { to: "/patients", key: "nav.patients", icon: <IconPatients /> },
        /*
         * «Когорты» переименованы в «Подбор людей» и переехали сюда из
         * разбора. Слово было жаргонным ровно там, где не должно: экран
         * отвечает на вопрос «кто подходит под условия», его открывают,
         * когда ищут людей, — и искать его надо среди людей, а не среди
         * аналитики.
         */
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
        { to: "/schedules", key: "nav.schedules", icon: <IconClock /> },
        /*
         * Маршрут помощи — заготовка протокола, а не повседневная работа:
         * его настраивают однажды и потом назначают. В «Людях» он стоял
         * рядом с пациентами и читался как «список чьих-то маршрутов», хотя
         * это справочник шаблонов. Маршрут КОНКРЕТНОГО человека лежит там,
         * где ему место, — в его карте (components/PatientPathways).
         */
        { to: "/pathways", key: "pw.title", icon: <IconRoute /> },
        { to: "/kiosk-sessions", key: "nav.kiosk", icon: <IconKiosk /> },
      ],
    },
    {
      key: "nav.group.analysis",
      icon: <IconCompare />,
      items: [
        { to: "/compare", key: "nav.compare", icon: <IconCompare /> },
        { to: "/search", key: "srch.title", icon: <IconStack /> },
        { to: "/surveillance", key: "nav.surveillance", icon: <IconPulse /> },
        { to: "/department-report", key: "dep.title", icon: <IconClock /> },
        { to: "/unit-report", key: "nav.unitReport", icon: <IconGroup /> },
        { to: "/conclusion-batch", key: "cbatch.title", icon: <IconStack /> },
      ],
    },
  ];
  if (isSuper) {
    groups.push({
      key: "nav.admin",
      icon: <IconUsers />,
      items: [
        { to: "/users", key: "nav.users", icon: <IconUsers /> },
        { to: "/permissions", key: "perm.title", icon: <IconGroup /> },
        { to: "/audit", key: "nav.audit", icon: <IconAudit /> },
        /* текст согласия жил на одном маршруте с учётками; разведён в свой */
        { to: "/consent-text", key: "consent.title", icon: <IconInvite /> },
        { to: "/invites", key: "nav.invites", icon: <IconInvite /> },
        { to: "/console", key: "nav.console", icon: <IconStack /> },
        { to: "/api-docs", key: "nav.api", icon: <IconSurvey /> },
        { to: "/ui", key: "nav.ui", icon: <IconDashboard /> },
      ],
    });
  }
  return groups;
}

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
          collapsed ? "h-9 w-9 justify-center" : "h-8 gap-2.5 px-2.5",
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
        "flex h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-small",
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
  collapsed,
  children,
}: {
  counts: RailCounts;
  isSuper: boolean;
  collapsed: boolean;
  children?: ReactNode;
}) {
  const { pathname } = useLocation();
  const groups = useMemo(() => railGroups(counts, isSuper), [counts, isSuper]);
  const active = groupOfPath(groups, pathname);

  /*
   * Первый заход раскрывает только ту группу, в которой находится человек.
   * Раскрыть всё «на всякий случай» значило бы вернуть прежний длинный
   * список и отменить смысл затеи.
   */
  const [open, setOpen] = useState<Set<string>>(() => {
    const stored = readOpen();
    if (stored) return new Set(stored);
    return new Set(active ? [active] : ["nav.group.today"]);
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
    /*
      Рельса прибита к окну и прокручивается внутри себя. Иначе подвал —
      имя, роль, стартовый экран и выход — уезжает за нижний край на
      ноутбучном экране, и человек не находит кнопку выхода вовсе.
      Прокручивается только список разделов: подвал остаётся на месте.
    */
    <aside
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
        collapsed ? "max-[900px]:-translate-x-full" : "max-[900px]:translate-x-0",
      )}
    >
      <div
        className={cx(
          "mb-3 flex shrink-0 items-center gap-2 px-1",
          collapsed && "justify-center px-0",
        )}
      >
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-sm bg-primary font-display text-small font-bold text-primary-text"
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
      {children ? <div className="shrink-0">{children}</div> : null}
    </aside>
  );
}
