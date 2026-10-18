import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { ShellIcon } from "./icons";
import { railKeyOf, sectionOf, subNavFor, type NavAccess, type NavCounts, type RailEntry, type SectionKey } from "./nav";
import { ShellDrawer } from "./overlays";
import { RailBadge } from "./Rail";
import { SubNavGroups, subNavRow } from "./SubNav";
import type { ThemeChoice } from "./theme";
import { ThemeToggle } from "./ThemeToggle";

/**
 * «Ще розділи» — все разделы консоли на узком окне.
 *
 * Ниже 1100 px нет ни рельсы, ни колонки подразделов: они отняли бы у экрана
 * треть ширины, а на телефоне — всю. Ни один экран при этом не теряет двери:
 * меню повторяет рельсу целиком, а под каждым разделом — его подразделы.
 * Первой группой стоят подразделы того раздела, где человек сейчас (на них
 * переходят чаще всего), вместе с дверями открытого человека и экрана.
 *
 * Слой — ящик слева на затемнении, с ловушкой фокуса, Esc и нажатием мимо
 * (ShellDrawer). Переход закрывает его: иначе новый экран читают сквозь
 * список.
 */
export function MoreMenu({
  id,
  entries,
  access,
  counts,
  onClose,
  onTheme,
}: {
  id: string;
  entries: RailEntry[];
  access: NavAccess;
  counts: NavCounts;
  onClose: () => void;
  onTheme: (c: ThemeChoice) => void;
}) {
  const { ut } = useLang();
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  const here = section ? subNavFor(section, pathname, access, counts) : null;
  const active = railKeyOf(pathname);

  /*
   * Переход закрывает меню — по адресу окна, а не маршрутизатора: переход
   * маршрутизатор проводит переходом React, и сразу после входа адрес в
   * строке уже новый, а `pathname` ещё прежний. Меню, открытое в этот миг,
   * принимало бы догнавший маршрутизатор за переход и закрывалось бы само.
   */
  const seen = useRef(window.location.pathname);
  useEffect(() => {
    const now = window.location.pathname;
    if (seen.current === now) return;
    seen.current = now;
    onClose();
  }, [pathname, onClose]);

  return (
    <ShellDrawer label={ut("top.more")} onClose={onClose}>
      <div id={id} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 pb-4 pt-2 [scrollbar-width:thin]">
        {here ? (
          <section aria-label={ut(here.title)} className="border-b border-divider pb-3">
            <h2 className="m-0 px-[10px] pb-[6px] pt-[10px] text-[16px] font-extrabold leading-5 tracking-[-0.015em] text-text">
              {ut(here.title)}
            </h2>
            {here.back ? (
              <Link to={here.back.to} className={subNavRow("back", here.dense)}>
                <ShellIcon name="chevron-left" size={16} />
                <span className="min-w-0 truncate">{ut(here.back.label)}</span>
              </Link>
            ) : null}
            <SubNavGroups groups={here.groups} dense={here.dense} path={pathname} />
          </section>
        ) : null}
        <nav aria-label={ut("shell.sections")} className="flex flex-col gap-[2px] pt-2">
          {entries.map((e) => (
            <EntryBlock
              key={e.key}
              entry={e}
              current={e.key === active}
              section={sectionFor(e.key)}
              access={access}
              counts={counts}
              path={pathname}
              skip={section}
            />
          ))}
        </nav>
      </div>
      {/*
        Тема — здесь, внизу меню: на узком окне переключателю нет места на
        полосе приложения (ниже 900 он с неё уходит), а меню и есть место,
        куда складывается всё, что не поместилось.
      */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-divider px-4 py-3">
        <span className="text-[12.5px] font-semibold text-text-2">{ut("pt.theme")}</span>
        <ThemeToggle tone="band" onChoose={onTheme} />
      </div>
    </ShellDrawer>
  );
}

/** Раздел рельсы, у которого есть колонка подразделов */
function sectionFor(key: RailEntry["key"]): SectionKey | null {
  return key === "patients" || key === "methods" || key === "analytics" || key === "admin" ? key : null;
}

function EntryBlock({
  entry,
  current,
  section,
  access,
  counts,
  path,
  skip,
}: {
  entry: RailEntry;
  current: boolean;
  section: SectionKey | null;
  access: NavAccess;
  counts: NavCounts;
  path: string;
  /** Раздел, чьи подразделы уже стоят первой группой: второй раз не повторяются */
  skip: SectionKey | null;
}) {
  const { ut } = useLang();
  const sub = section && section !== skip && !(skip === "ops" && section === "admin") ? subNavFor(section, "", access, counts) : null;
  const full = ut(entry.full);
  return (
    <div className="flex flex-col gap-[2px]">
      <Link
        to={entry.to}
        aria-current={current ? "page" : undefined}
        aria-label={entry.badge ? `${full}, ${entry.badge.n}` : full}
        className={cx("group relative", subNavRow(current))}
      >
        <ShellIcon name={entry.icon} size={18} className={current ? "text-violet-ink" : "text-muted group-hover:text-text"} />
        <span className="min-w-0 flex-1 truncate">{full}</span>
        {entry.badge ? <RailBadge {...entry.badge} inline /> : null}
      </Link>
      {sub ? (
        <div className="pl-[22px]">
          <SubNavGroups groups={sub.groups.map((g) => ({ items: g.items }))} dense path={path} />
        </div>
      ) : null}
    </div>
  );
}
