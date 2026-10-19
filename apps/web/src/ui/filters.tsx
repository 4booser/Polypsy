import { useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { grouped } from "./decimal";
import { Ic } from "./icons";
import { Kbd } from "./kbd";
import { useHotkeys } from "./keys";
import { MenuButton, menuItemClass } from "./menu";
import { Input } from "./primitives";
import { useLang } from "../lang";

/*
 * Полоса фильтров над списком (.fbar набора): поиск с «/», сохранённые
 * виды с числами, чипы фильтров, счёт «20 з 248» и порядок справа. Под ней —
 * полоса массовых действий, пока в таблице что-то отмечено.
 */

/**
 * Поиск (.search): залитое поле 40 со значком и подсказкой «/».
 *
 * `slash` — «/» ставит курсор сюда с любого места экрана (кроме полей
 * ввода: там «/» — обычный знак). Esc в поле снимает с него фокус.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  slash = false,
  width = 260,
  className,
  inputProps,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Имя поля для диктора; по умолчанию — подсказка внутри */
  label?: string;
  slash?: boolean;
  /** Ширина в пикселях; 0 — во всю строку */
  width?: number;
  className?: string;
  inputProps?: Record<string, string | undefined>;
}) {
  const { ut } = useLang();
  const ref = useRef<HTMLInputElement>(null);
  useHotkeys({ "/": () => ref.current?.focus() }, slash);
  const ph = placeholder ?? ut("ui.search");
  return (
    <Input
      ref={ref}
      type="search"
      look="fill"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
      }}
      placeholder={ph}
      aria-label={label ?? ph}
      autoComplete="off"
      icon={<Ic.search />}
      suffix={slash ? <Kbd>/</Kbd> : undefined}
      className={cx("rounded-[12px]", width ? "shrink-0" : "flex-1", className)}
      {...(width ? { style: { width } } : {})}
      {...inputProps}
    />
  );
}

/**
 * Чип фильтра (.fchip): «Методика PHQ-9 ⌄». `on` — фильтр применён
 * (тонированный), тогда рядом крестик «зняти». `add` — «+ Фільтр» контуром.
 * Нажатие на сам чип — `onClick` (обычно открывает меню значений).
 */
export function FilterChip({
  label,
  value,
  on,
  add,
  onClick,
  onClear,
  expanded,
}: {
  /** Подпись; у `add` по умолчанию — «Фільтр» */
  label?: ReactNode;
  value?: ReactNode;
  on?: boolean;
  add?: boolean;
  onClick?: () => void;
  onClear?: () => void;
  /** Меню значений открыто */
  expanded?: boolean;
}) {
  const { ut } = useLang();
  const base = cx(
    "inline-flex h-9 min-h-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-0 text-small font-semibold leading-none",
    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
  );
  if (add) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        className={cx(base, "rounded-[18px] bg-transparent pl-2.5 pr-3 text-text-2 shadow-[inset_0_0_0_1.5px_var(--ctl)] hover:bg-sunk")}
      >
        <Ic.plus size={14} />
        {label ?? ut("kit.addFilter")}
      </button>
    );
  }
  const main = (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className={cx(
        base,
        on && onClear ? "rounded-l-[18px] pl-3 pr-1.5" : "rounded-[18px] pl-3 pr-2.5",
        on ? "bg-violet-tint text-violet-ink hover:bg-violet-tint-2" : "bg-sunk text-text-2 hover:bg-sunk-2",
      )}
    >
      {label}
      {value ? <b className={cx("font-extrabold", on ? "text-violet-ink" : "text-text")}>{value}</b> : null}
      {on && onClear ? null : <Ic.chevronDown size={13} className={on ? "text-violet-ink" : "text-muted"} />}
    </button>
  );
  if (!(on && onClear)) return main;
  return (
    <span className="inline-flex">
      {main}
      <button
        type="button"
        onClick={onClear}
        aria-label={ut("kit.removeFilter").replace("{name}", typeof label === "string" ? label : "")}
        className={cx(base, "rounded-r-[18px] bg-violet-tint pl-1 pr-2.5 text-violet-ink hover:bg-violet-tint-2")}
      >
        <Ic.x size={13} />
      </button>
    </span>
  );
}

export interface ViewItem {
  key: string;
  label: string;
  /** Сколько строк в виде; null — неизвестно */
  count?: number | null;
  /** Число красным — только риск для человека */
  risk?: boolean;
}

/**
 * Сохранённые виды пилюлями с числами (.views / .vw): «Мої 34», «Ризик 2»,
 * «Усі 248». Выбранный — фиолетовой заливкой. Выбор одного — aria-pressed.
 */
export function ViewPills({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: ViewItem[];
  value: string | null;
  onChange: (key: string) => void;
  label?: string;
  className?: string;
}) {
  const { ut } = useLang();
  return (
    <div role="group" aria-label={label ?? ut("kit.savedViews")} className={cx("flex flex-wrap gap-x-[5px] gap-y-1.5", className)}>
      {items.map(({ key, ...v }) => (
        <ViewPill key={key} {...v} on={key === value} onClick={() => onChange(key)} />
      ))}
    </div>
  );
}

/** Одна пилюля вида — для полос, где виды приходят с сервера (ui/SavedViews) */
export function ViewPill({
  label,
  count,
  risk,
  on,
  onClick,
  icon,
  title,
}: {
  label: ReactNode;
  count?: number | null;
  risk?: boolean;
  on?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
  title?: string;
}) {
  const { lang } = useLang();
  return (
    <button
      type="button"
      aria-pressed={!!on}
      onClick={onClick}
      title={title}
      className={cx(
        "inline-flex h-8 min-h-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-2xl border-0 px-2.5 text-small leading-none",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        on ? "bg-violet font-bold text-onfill" : "bg-sunk font-semibold text-text-2 hover:bg-sunk-2 hover:text-text",
      )}
    >
      {icon}
      {label}
      {count !== undefined && count !== null ? (
        <span className={cx("font-bold tabular-nums", on ? "text-onfill-muted" : risk ? "text-risk-ink" : "text-muted")}>{grouped(count, lang)}</span>
      ) : null}
    </button>
  );
}

export interface SortOption {
  key: string;
  label: string;
}

/**
 * Порядок (.sortb): «⇣ ризик спершу ⌄» — меню вариантов с отметкой
 * выбранного. Подпись «Сортування» — для диктора и в подсказке.
 */
export function SortMenu({
  options,
  value,
  onChange,
  label,
}: {
  options: SortOption[];
  value: string;
  onChange: (key: string) => void;
  label?: string;
}) {
  const { ut } = useLang();
  const name = label ?? ut("kit.sort");
  const current = options.find((o) => o.key === value) ?? options[0];
  return (
    <MenuButton
      label={name}
      trigger={(p) => (
        <button
          type="button"
          {...p}
          aria-label={`${name}: ${current?.label ?? ""}`}
          title={name}
          className={cx(
            "inline-flex h-9 min-h-0 cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-control border-0 bg-transparent px-3 text-small text-muted",
            "hover:bg-sunk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          )}
        >
          <Ic.sortDesc size={14} />
          <b className="font-bold text-text-2">{current?.label}</b>
          <Ic.chevronDown size={13} />
        </button>
      )}
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.key}
            type="button"
            role="menuitemradio"
            aria-checked={o.key === value}
            className={menuItemClass("left")}
            onClick={() => {
              close();
              onChange(o.key);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.key === value ? <Ic.check size={15} className="text-violet-ink" /> : null}
          </button>
        ))
      }
    </MenuButton>
  );
}

/**
 * Полоса фильтров (.fbar). Все части необязательны; справа — счёт, своё
 * (кнопки «Стовпці», «Таблиця / Картки») и порядок.
 *
 * ```tsx
 * <FilterBar
 *   search={{ value: q, onChange: setQ, placeholder: "ПІБ, картка або телефон" }}
 *   views={{ items: [{ key: "mine", label: "Мої", count: 34 }], value: view, onChange: setView }}
 *   chips={<FilterChip label="Методика" value="PHQ-9" on onClear={…} />}
 *   count={{ shown: 20, total: 248 }}
 *   sort={{ options, value: sort, onChange: setSort }}
 * />
 * ```
 */
export function FilterBar({
  search,
  views,
  chips,
  count,
  sort,
  right,
  className,
}: {
  search?: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string; slash?: boolean; width?: number };
  views?: { items: ViewItem[]; value: string | null; onChange: (key: string) => void; label?: string };
  chips?: ReactNode;
  count?: { shown: number; total: number } | ReactNode;
  sort?: { options: SortOption[]; value: string; onChange: (key: string) => void; label?: string };
  right?: ReactNode;
  className?: string;
}) {
  const { ut, lang } = useLang();
  const counted =
    count && typeof count === "object" && "shown" in count && "total" in count ? (
      <span className="whitespace-nowrap text-small text-muted">
        {ut("kit.ofTotal")
          .split(/(\{n\}|\{total\})/)
          .map((part, i) =>
            part === "{n}" ? (
              <b key={i} className="font-extrabold text-text">
                {grouped((count as { shown: number }).shown, lang)}
              </b>
            ) : part === "{total}" ? (
              grouped((count as { total: number }).total, lang)
            ) : (
              part
            ),
          )}
      </span>
    ) : (
      (count as ReactNode)
    );
  return (
    <div className={cx("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {search ? <SearchField slash={search.slash ?? true} {...search} /> : null}
      {views ? <ViewPills {...views} /> : null}
      {chips}
      {counted || right || sort ? (
        <div className="ml-auto flex items-center gap-2">
          {counted}
          {right}
          {sort ? <SortMenu {...sort} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Полоса массовых действий (.bulk): «✓✓ Вибрано: 3 · Вибрати всіх 248 ·
 * [дії] · Зняти вибір». Пока ничего не отмечено, её нет. Число — живая
 * область: диктор слышит, сколько отмечено.
 */
export function BulkBar({
  count,
  total,
  onSelectAll,
  onClear,
  children,
  className,
}: {
  count: number;
  /** Сколько всего: показывает «Вибрати всіх N», если выбраны не все */
  total?: number;
  onSelectAll?: () => void;
  onClear?: () => void;
  /** Действия: <Button size="xs" variant="panel"> — лист на тонированной полосе */
  children?: ReactNode;
  className?: string;
}) {
  const { ut, lang } = useLang();
  if (count <= 0) return null;
  return (
    <div
      role="region"
      aria-label={ut("kit.selected")}
      className={cx(
        "flex flex-wrap items-center gap-2 rounded-[12px] bg-violet-tint py-1.5 pl-3.5 pr-1.5 text-[13px] font-bold leading-none text-violet-ink",
        className,
      )}
    >
      <Ic.checkCheck size={16} />
      <span aria-live="polite" className="whitespace-nowrap">
        {ut("kit.selected")}: <span className="tabular-nums">{grouped(count, lang)}</span>
      </span>
      {total !== undefined && onSelectAll && count < total ? (
        <button
          type="button"
          onClick={onSelectAll}
          className="ml-1 min-h-0 cursor-pointer border-0 bg-transparent p-0 text-[13px] font-bold text-violet-ink underline decoration-violet-line decoration-2 underline-offset-[3px] hover:decoration-current"
        >
          {ut("kit.selectAllN").replace("{n}", grouped(total, lang))}
        </button>
      ) : null}
      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {children}
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-8 min-h-0 cursor-pointer items-center gap-1.5 rounded-[9px] border-0 px-3 text-small font-bold text-violet-ink hover:bg-violet-tint-2"
          >
            <Ic.x size={14} />
            {ut("kit.clearSelection")}
          </button>
        ) : null}
      </span>
    </div>
  );
}
