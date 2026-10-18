import { useEffect, useId, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { ShellIcon } from "./icons";
import { isCurrent, type SubNavData, type SubNavGroup, type SubNavItem } from "./nav";

/*
 * Колонка подразделов — 232 px между рельсой и экраном (.snav набора).
 *
 * Заголовок раздела сверху, пункты со значком и числом, подписанные группы;
 * у техпанели — «назад» к администрированию и плотные строки (её разделов
 * тридцать). Состав — данными из nav.ts (subNavFor): оболочка рисует
 * колонку сама по адресу, и экрану раздела делать для этого ничего не надо.
 * Экран, которому нужна своя колонка (оглавление, разделы настроек), рисует
 * этот же компонент со своими данными.
 *
 * Ниже 1100 px колонки нет: на узком окне она отнимала бы у экрана треть
 * ширины. Её пункты тогда — первой группой меню «Ще розділи» (MoreMenu.tsx).
 */
export function SubNav({ data, className }: { data: SubNavData; className?: string }) {
  const { ut } = useLang();
  const { pathname } = useLocation();
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();

  /*
   * Текущий пункт виден, даже если он в хвосте длинного списка: человек,
   * открывший «Пуш-сповіщення» по ссылке, должен видеть, где он, без
   * прокрутки колонки. Прокручивается сама колонка, а не страница.
   */
  useEffect(() => {
    const box = body.current;
    const on = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !on) return;
    if (on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight - 24 || on.offsetTop < box.scrollTop) {
      box.scrollTop = on.offsetTop - box.clientHeight / 2;
    }
  }, [pathname]);

  return (
    <nav
      aria-labelledby={titleId}
      data-subnav={data.section}
      className={cx(
        "flex w-[232px] shrink-0 flex-col border-r border-border bg-panel",
        "max-[1099px]:hidden print:hidden",
        className,
      )}
    >
      <div className="flex h-[50px] shrink-0 items-center pl-[18px] pr-[10px] pt-[14px]">
        <h2 id={titleId} className="m-0 truncate text-[18px] font-extrabold leading-none tracking-[-0.02em] text-text">
          {ut(data.title)}
        </h2>
      </div>
      <div ref={body} className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2 [scrollbar-width:thin]">
        {data.back ? (
          <Link to={data.back.to} className={subNavRow("back", data.dense)}>
            <ShellIcon name="chevron-left" size={16} />
            <span className="min-w-0 truncate">{ut(data.back.label)}</span>
          </Link>
        ) : null}
        <SubNavGroups groups={data.groups} dense={data.dense} path={pathname} />
      </div>
    </nav>
  );
}

/**
 * Группы и пункты — отдельно от колонки: те же строки стоят первой группой
 * в меню «Ще розділи» на узком окне, и вид у них обязан быть один.
 */
export function SubNavGroups({
  groups,
  dense,
  path,
  onGo,
}: {
  groups: SubNavGroup[];
  dense?: boolean;
  path: string;
  /** Нажали на пункт — меню, в котором стоят строки, закрывается */
  onGo?: () => void;
}) {
  return (
    <>
      {groups.map((g, i) => (
        <SubNavGroupBlock key={g.label ?? `g${i}`} group={g} dense={dense} path={path} first={i === 0} onGo={onGo} />
      ))}
    </>
  );
}

function SubNavGroupBlock({
  group,
  dense,
  path,
  first,
  onGo,
}: {
  group: SubNavGroup;
  dense?: boolean;
  path: string;
  first: boolean;
  onGo?: () => void;
}) {
  const { ut } = useLang();
  const id = useId();
  return (
    <div role="group" aria-labelledby={group.label ? id : undefined} className="flex flex-col gap-[2px]">
      {group.label ? (
        <div
          id={id}
          className={cx(
            "flex items-center px-[10px] text-[12px] font-bold leading-4 text-muted",
            dense ? "h-[26px]" : "h-[28px]",
            first ? "" : dense ? "mt-[8px]" : "mt-[12px]",
          )}
        >
          {ut(group.label)}
        </div>
      ) : null}
      {group.items.map((it) => (
        <SubNavLink key={it.to} item={it} current={isCurrent(it, path)} dense={dense} onGo={onGo} />
      ))}
    </div>
  );
}

/**
 * Строка пункта: 38 высотой (32 в плотной колонке). Текущий — мягкой
 * заливкой с обводкой; «назад» — фиолетовым словом, без заливки.
 */
export function subNavRow(state: boolean | "back", dense?: boolean): string {
  return cx(
    "flex w-full shrink-0 items-center gap-[10px] whitespace-nowrap pl-[10px] pr-[8px]",
    "no-underline transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] hover:no-underline",
    dense ? "h-[32px] rounded-[10px] text-[13px]" : "h-[38px] rounded-[11px] text-[13.5px]",
    state === "back"
      ? "font-bold text-violet-ink hover:bg-sunk"
      : state
        ? "bg-violet-tint font-extrabold text-violet-ink shadow-[inset_0_0_0_1px_var(--vline)]"
        : "font-semibold text-text-2 hover:bg-sunk hover:text-text",
  );
}

function SubNavLink({
  item,
  current,
  dense,
  onGo,
}: {
  item: SubNavItem;
  current: boolean;
  dense?: boolean;
  onGo?: () => void;
}) {
  const { ut } = useLang();
  return (
    <Link
      to={item.to}
      aria-current={current ? "page" : undefined}
      onClick={onGo}
      className={cx("group", subNavRow(current, dense))}
    >
      <ShellIcon
        name={item.icon}
        size={16}
        className={current ? "text-violet-ink" : "text-muted group-hover:text-text"}
      />
      <span className="min-w-0 flex-1 truncate">{ut(item.label)}</span>
      {item.count ? (
        <span
          className={cx(
            "ml-auto inline-grid h-[20px] min-w-[22px] place-items-center rounded-[10px] px-[6px]",
            "text-[11.5px] font-bold leading-none tabular-nums",
            item.risk
              ? "bg-risk text-onfill"
              : current
                ? "bg-panel text-violet-ink"
                : "bg-sunk text-text-2",
          )}
        >
          {item.count > 99 ? "99+" : item.count}
        </span>
      ) : null}
    </Link>
  );
}
