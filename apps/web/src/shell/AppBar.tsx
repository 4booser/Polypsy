import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { locale, timeOfDay } from "../format";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { EventCenter } from "./EventCenter";
import { ModKey, isMac } from "./HelpDrawer";
import { ShellIcon } from "./icons";
import { LangMenu } from "./LangMenu";
import { LogoTile } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import type { ThemeChoice } from "./theme";
import { Kbd } from "../ui/kbd";
import { Tooltip } from "../ui/Popover";
import { UserMenu, type AccountCard } from "./UserMenu";

/**
 * Полоса приложения консоли — 56 px, тёмная в обеих темах (.appbar набора).
 *
 * Слева знак и отделение, затем поле поиска, которое открывает палитру
 * команд; справа дата и время, центр событий, тема, язык и кто вошёл.
 * Дежурного специалиста, которого рисует набор, здесь нет: таких данных у
 * консоли нет, и строка с выдуманным дежурным была бы хуже пустого места.
 *
 * ВСЕГДА В ОДНУ СТРОКУ, для любой роли и любого имени. Тексты не
 * переносятся; первым уступает ширину поле поиска (до 200), затем
 * отделение — многоточием, с полным текстом в подсказке; имя и должность
 * обрезаются на 170 и целиком стоят в карточке за ними. Ниже 1200 уходит
 * дата, ниже 1100 слева встаёт кнопка «Ще розділи» (рельсы там нет), ниже
 * 900 поиск сжимается до значка, тема переезжает в карточку учётной записи,
 * а от имени остаётся кружок.
 *
 * На печать полоса не идёт: на бумаге меню не нажимают, а тонер оно съедает.
 */
export function AppBar({
  account,
  onSearch,
  onTheme,
  menuOpen,
  onMenu,
  menuId,
}: {
  account: AccountCard;
  onSearch: () => void;
  onTheme: (c: ThemeChoice) => void;
  /** Открыто ли меню «Ще розділи» (узкое окно) */
  menuOpen: boolean;
  onMenu: () => void;
  menuId: string;
}) {
  const { ut } = useLang();
  const hint = ut("shell.searchHint");
  const menuLabel = menuOpen ? ut("shell.collapse") : ut("shell.expand");
  return (
    <header
      className={cx(
        "relative z-50 flex h-14 shrink-0 items-center gap-[14px] bg-appbar pl-[22px] pr-[14px] text-appbar-ink",
        "max-[1099px]:gap-[10px] max-[1099px]:pl-[10px] max-[600px]:pr-[8px] print:hidden",
      )}
    >
      <button
        type="button"
        onClick={onMenu}
        aria-label={menuLabel}
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        className={cx(
          "hidden size-10 min-h-0 shrink-0 place-items-center rounded-[12px] border-0 bg-transparent p-0 text-appbar-muted",
          "transition-colors hover:bg-appbar-hover hover:text-appbar-ink aria-expanded:bg-appbar-hover aria-expanded:text-appbar-ink",
          "max-[1099px]:grid",
        )}
      >
        <ShellIcon name="menu" size={20} />
      </button>

      <Link
        to="/"
        aria-label={ut("shell.home")}
        className="flex shrink-0 items-center gap-[10px] rounded-[12px] text-appbar-ink no-underline hover:no-underline"
      >
        <LogoTile size={36} />
        <span className="text-[17px] font-extrabold leading-none tracking-[-0.015em] max-[600px]:hidden">
          {ut("shell.brand")}
        </span>
      </Link>

      {account.unit ? (
        <Tooltip label={account.unit} side="bottom">
            <span
              className={cx(
                "min-w-0 max-w-[240px] shrink truncate whitespace-nowrap border-l border-appbar-line pl-[14px]",
                "text-[13px] font-semibold leading-5 text-appbar-muted max-[899px]:hidden",
              )}
            >
              {account.unit}
            </span>
        </Tooltip>
      ) : null}

      {/*
        Поиск выглядит полем, но это кнопка: она открывает палитру команд, а
        печатают уже в ней. ⌘K/Ctrl K делает то же самое с любого экрана — и
        подпись клавиши стоит прямо в поле, где её видно, а не в справке.
      */}
      <button
        type="button"
        onClick={onSearch}
        aria-label={hint}
        aria-keyshortcuts={isMac() ? "Meta+K" : "Control+K"}
        data-shell-search=""
        className={cx(
          "ml-[10px] flex h-10 min-h-0 w-[400px] min-w-[200px] shrink items-center gap-[10px] rounded-[12px]",
          "border border-transparent bg-appbar-field pl-[14px] pr-2 text-left text-[13.5px] font-medium text-appbar-muted",
          "transition-colors hover:border-appbar-line hover:text-appbar-ink",
          "max-[1099px]:ml-0 max-[899px]:w-10 max-[899px]:min-w-0 max-[899px]:justify-center max-[899px]:p-0",
        )}
      >
        <ShellIcon name="search" size={15} />
        <span className="min-w-0 flex-1 truncate max-[899px]:hidden">{hint}</span>
        <span className="max-[899px]:hidden">
          <Kbd tone="appbar">
            <span className="inline-flex items-center gap-[3px]">
              <ModKey />K
            </span>
          </Kbd>
        </span>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-[6px] whitespace-nowrap text-[13px] font-semibold text-appbar-muted">
        <Clock />
        <span aria-hidden className="mx-2 h-6 w-px bg-appbar-line max-[1199px]:hidden" />
        <EventCenter />
        <ThemeToggle onChoose={onTheme} className="max-[899px]:hidden" />
        <LangMenu tone="appbar" />
        <span aria-hidden className="mx-1 h-6 w-px bg-appbar-line max-[600px]:hidden" />
        <UserMenu account={account} />
      </div>
    </header>
  );
}

/**
 * Дата и время — словами дня, как в наборе («Сб, 18 жовтня, 17:00»).
 *
 * Обновляется раз в полминуты: минута на полосе, отстающая на полминуты,
 * незаметна, а перерисовка раз в секунду — лишняя работа на слабом ноутбуке.
 */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const day = now.toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "long" });
  const iso = now.toISOString();
  return (
    <time dateTime={iso} className="text-appbar-ink tabular-nums max-[1199px]:hidden">
      {day.charAt(0).toUpperCase() + day.slice(1)}, {timeOfDay(iso)}
    </time>
  );
}
