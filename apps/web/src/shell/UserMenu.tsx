import { Fragment } from "react";
import { Link } from "react-router-dom";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { MenuButton, MenuSeparator, menuItemClass } from "../ui/menu";
import { ShellIcon, type IconName } from "./icons";

/**
 * Кто вошёл и что он может сделать со своей записью.
 *
 * Данными, а не разметкой: App знает пользователя, отвязку Google и выход,
 * полосе приложения про авторизацию знать незачем — она решает только, как
 * это нарисовать. Жило подвалом бургера верхней полосы; в Polypsy 2.0 это
 * карточка за именем справа на полосе приложения (.me и pp-me набора).
 */
export interface AccountCard {
  name: string;
  /** Слово роли или должности, уже переведённое */
  roleLabel: string;
  email?: string;
  /** Отделение: показывается полностью здесь, на полосе может быть обрезано */
  unit?: string | null;
  /** Метка сборки: короткий хэш и дата — подписью наведения */
  build: { sha: string; date: string };
  /** То, что требует внимания: «только чтение» объясняет, почему кнопки не срабатывают */
  warning?: string;
  /** Состояние записи обычным текстом: «Google прив’язано» */
  note?: string;
  actions: AccountAction[];
}

export interface AccountAction {
  /** Ключ React и опора проверок: подпись меняется с языком, ключ нет */
  id: string;
  label: string;
  icon: IconName;
  /** Переход — ссылкой; без адреса пункт — кнопка с onSelect */
  to?: string;
  onSelect?: () => void;
  /** Черта над пунктом: так выход отделён от остального */
  ruled?: boolean;
}

/** Инициалы для кружка: первые буквы двух первых слов имени */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/**
 * Кружок с инициалами на полосе приложения: сиреневый с тёмной буквой, как в
 * наборе (.me .av) — в обеих темах, потому что полоса тёмная в обеих.
 */
function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-[34px] shrink-0 place-items-center rounded-full bg-appbar-badge text-[12px] font-extrabold text-appbar-badge-ink"
    >
      {initials(name)}
    </span>
  );
}

/**
 * Имя справа на полосе и меню учётной записи по нажатию (MenuButton набора:
 * лист 14, пункты 36, стрелки, Home/End, Esc, возврат фокуса имени).
 *
 * Полоса всегда в одну строку: длинное имя или должность обрезаются
 * многоточием (не шире 170), а целиком — в шапке меню, вместе с отделением и
 * почтой. Ниже 900 px имени на полосе нет вовсе — остаётся кружок.
 */
export function UserMenu({ account }: { account: AccountCard }) {
  const { ut } = useLang();
  const sub = [account.roleLabel, account.unit].filter(Boolean).join(", ");
  return (
    <MenuButton
      label={ut("acct.title")}
      className="min-w-0 items-center self-stretch"
      plateClassName="w-[300px] max-w-[calc(100vw-24px)]"
      trigger={(p) => (
        <button
          type="button"
          {...p}
          data-user-menu=""
          className={cx(
            "flex h-11 min-h-0 min-w-0 items-center gap-[10px] rounded-[12px] border-0 bg-transparent pl-[5px] pr-[10px]",
            "text-left text-appbar-ink transition-colors duration-[var(--dur-fast)] hover:bg-appbar-hover",
            "aria-expanded:bg-appbar-hover max-[899px]:pr-[5px]",
          )}
        >
          <Avatar name={account.name} />
          <span className="flex min-w-0 max-w-[170px] flex-col max-[899px]:sr-only">
            <b className="truncate text-[13px] font-bold leading-4">{account.name}</b>
            <small className="truncate text-[12px] font-medium leading-[15px] text-appbar-muted">{account.roleLabel}</small>
          </span>
        </button>
      )}
    >
      {(close) => (
        <>
          {/* шапка меню — кто вошёл целиком; не пункт меню, стрелки её проходят мимо */}
          <div role="none" className="px-2.5 pb-2.5 pt-1.5">
            <p className="m-0 text-[13.5px] font-extrabold leading-[18px] text-text [overflow-wrap:anywhere]">{account.name}</p>
            {sub ? <p className="m-0 mt-[5px] text-[12.5px] leading-[18px] text-text-2">{sub}</p> : null}
            {account.email ? (
              <p className="m-0 text-[12.5px] leading-[18px] text-muted [overflow-wrap:anywhere]">{account.email}</p>
            ) : null}
            {account.note ? <p className="m-0 mt-[5px] text-[12.5px] leading-[18px] text-muted">{account.note}</p> : null}
            {account.warning ? (
              <p className="m-0 mt-[8px] inline-flex items-center gap-[6px] rounded-pill bg-warn-tint px-[10px] py-[3px] text-[12px] font-bold leading-4 text-warn">
                <ShellIcon name="eye" size={13} />
                {account.warning}
              </p>
            ) : null}
          </div>
          <MenuSeparator />
          {account.actions.map((a) => (
            <Fragment key={a.id}>
              {a.ruled ? <MenuSeparator /> : null}
              {a.to ? (
                <Link to={a.to} role="menuitem" onClick={close} className={menuItemClass("left")}>
                  <ShellIcon name={a.icon} size={16} />
                  {a.label}
                </Link>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    a.onSelect?.();
                  }}
                  /* у <button> правило наследия ставит подпись по центру — пункт меню у левого края */
                  className={cx(menuItemClass("left"), "justify-start")}
                >
                  <ShellIcon name={a.icon} size={16} />
                  {a.label}
                </button>
              )}
            </Fragment>
          ))}
          <div role="none" className="px-2.5 pb-1 pt-2 text-[11px] leading-4 text-muted">
            <span title={`${ut("ui.buildFrom")} ${account.build.date}`} className="font-mono">
              {account.build.sha}
            </span>
          </div>
        </>
      )}
    </MenuButton>
  );
}
