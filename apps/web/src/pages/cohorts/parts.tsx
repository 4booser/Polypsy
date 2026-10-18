import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Severity } from "@quizzy/shared";
import { HBars } from "../../charts/clinical";
import { useLang } from "../../lang";
import { isTopLayer, useFocusTrap } from "../../ui";
import { cx } from "../../ui/cx";
import { SearchField } from "../../ui/filters";
import { Ic } from "../../ui/icons";
import { Button, Checkbox, CheckLabel } from "../../ui/primitives";
import { SEVERITY_LABEL, type BarRow } from "./model";

/*
 * Детали «Добору людей» в наборе «Виразна» — и только его.
 *
 * Здесь, а не в ui/: набор правят параллельно другие сборщики, а этому экрану
 * нужны вещи, которых нет больше нигде, — выбор нескольких значений метками с
 * «Додати», переключатель вариантов на настоящих радиокнопках, метки активных
 * условий с «×». Когда такое понадобится второму экрану, их место — ui/.
 */

const FOCUS_INSIDE = "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";

/* ─────────── группа фильтра ─────────── */

/**
 * Группа фильтра: подпись 12/700 над полем — как подпись поля набора.
 *
 * fieldset/legend, а не div с текстом: у переключателя и диапазона полей
 * несколько, и диктор должен услышать, к чему они относятся, на каждом из
 * них. Браузерные рамка и поля fieldset сняты явно.
 */
export function Group({
  legend,
  hint,
  error,
  children,
  className,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cx("m-0 min-w-0 border-0 p-0", className)}>
      <legend className="mb-1.5 p-0 text-caption font-bold text-muted">{legend}</legend>
      {children}
      {error ? (
        <p role="alert" className="m-0 mt-1.5 flex items-center gap-1.5 text-small font-semibold text-risk-ink">
          <Ic.circleAlert size={14} />
          {error}
        </p>
      ) : hint ? (
        <p className="m-0 mt-1.5 text-caption text-muted">{hint}</p>
      ) : null}
    </fieldset>
  );
}

/** Раздел колонки фильтров: «Про людину», «Про обстеження», «Умови за шкалами» */
export function FilterSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-divider pb-1 pt-4 first:border-t-0 first:pt-1">
      <h3 className="m-0 mb-3 text-h3 font-extrabold text-text">{title}</h3>
      <div className="flex flex-col gap-3.5">{children}</div>
    </section>
  );
}

/* ─────────── переключатель вариантов ─────────── */

/**
 * Один вариант из нескольких: стать, вираженість.
 *
 * Настоящие радиокнопки под подписями: стрелки, Tab и «выбрано, 2 из 3»
 * диктору даёт браузер, а не обработчики. Вид — сегменты набора: подложка
 * sunk, выбранный — лист с тенью и фиолетовой подписью.
 */
export function Segmented<V extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
}) {
  return (
    <div className="flex w-full gap-0.5 rounded-[12px] bg-sunk p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label
            key={o.value}
            className={cx(
              "m-0 flex h-8 flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-[9px] px-2 text-caption font-bold",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
              on ? "bg-panel text-violet-ink shadow-tile" : "text-text-2 hover:bg-sunk-2 hover:text-text",
              FOCUS_INSIDE,
            )}
          >
            <input type="radio" name={name} className="sr-only" checked={on} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

/* ─────────── флажок ─────────── */

/** Флажок с подписью — флажок набора */
export function Check({
  checked,
  onChange,
  children,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children?: ReactNode;
  /** Имя для диктора, когда видимой подписи нет */
  label?: string;
}) {
  return (
    <CheckLabel
      className="min-h-[30px] text-body font-medium text-text"
      control={<Checkbox checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />}
      label={children}
    />
  );
}

/* ─────────── несколько значений ─────────── */

/**
 * Несколько значений из списка — подразделения, населённые пункты.
 *
 * Выбранные стоят метками с «×» в рамке поля, «+ Додати» раскрывает список с
 * флажками (и поиском, когда вариантов больше восьми). Выбранные, которых
 * нет среди вариантов (пришли ссылкой из адреса), всё равно видны — иначе
 * снять их было бы нечем.
 */
export function MultiPick({
  label,
  allLabel,
  options,
  value,
  onChange,
  emptyText,
}: {
  label: string;
  /** Что показывает пустой выбор: «усі підрозділи» */
  allLabel: string;
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Что сказать, когда выбирать не из чего */
  emptyText: string;
}) {
  const { ut } = useLang();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(ref)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, ref]);

  const all = useMemo(() => [...new Set([...value, ...options])], [value, options]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter((o) => o.toLowerCase().includes(needle)) : all;
  const toggle = (o: string, on: boolean) => onChange(on ? [...value, o] : value.filter((x) => x !== o));

  return (
    <div className="relative min-w-0">
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-control border border-field-border bg-panel p-1.5">
        {value.length === 0 ? <span className="px-1.5 text-body text-muted">{allLabel}</span> : null}
        {value.map((v) => (
          <span key={v} className="inline-flex h-7 max-w-full items-center gap-1 rounded-[14px] bg-violet-tint pl-2.5 pr-1 text-caption font-bold text-violet-ink">
            <span className="min-w-0 truncate">{v}</span>
            <button
              type="button"
              aria-label={`${ut("coh.removeTag")}: ${v}`}
              onClick={() => toggle(v, false)}
              className="inline-grid size-5 min-h-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-violet-ink hover:bg-violet-tint-2"
            >
              <Ic.x size={12} />
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={`${label}: ${ut("coh2.add")}`}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-7 min-h-0 cursor-pointer items-center gap-1 rounded-[14px] border-0 bg-transparent px-2.5 text-caption font-semibold text-text-2 shadow-[inset_0_0_0_1.5px_var(--ctl)] hover:bg-sunk"
        >
          <Ic.plus size={13} />
          {ut("coh2.add")}
        </button>
      </div>
      {open ? (
        <>
          <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div
            ref={ref}
            id={id}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            className="absolute left-0 top-[calc(100%+6px)] z-50 w-full min-w-[260px] rounded-panel border border-border bg-panel p-2.5 shadow-pop"
          >
            {all.length > 8 ? (
              <SearchField value={q} onChange={setQ} placeholder={ut("coh.pickSearch")} width={0} className="mb-2 w-full" />
            ) : null}
            {all.length === 0 ? (
              <p className="m-0 py-1.5 text-small text-muted">{emptyText}</p>
            ) : shown.length === 0 ? (
              <p className="m-0 py-1.5 text-small text-muted">{ut("srch.nothing")}</p>
            ) : (
              <ul className="m-0 flex max-h-[260px] list-none flex-col gap-1 overflow-y-auto p-0">
                {shown.map((o) => (
                  <li key={o}>
                    <Check checked={value.includes(o)} onChange={(on) => toggle(o, on)}>
                      <span className="min-w-0 truncate">{o}</span>
                    </Check>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex items-center justify-between gap-2.5">
              <Button variant="quiet" size="xs" disabled={!value.length} onClick={() => onChange([])}>
                {ut("coh.pickClear")}
              </Button>
              <Button size="xs" onClick={() => setOpen(false)}>
                {ut("common.close")}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ─────────── метки активных условий ─────────── */

/**
 * Метка условия с «×». Вся метка не кнопка: нажимается только крестик —
 * у диктора это «Прибрати: Стать: Чоловіки», а не безымянное «кнопка».
 */
export function FilterTag({ label, onRemove }: { label: string; onRemove: () => void }) {
  const { ut } = useLang();
  return (
    <li className="inline-flex h-9 max-w-full items-center gap-1 rounded-[18px] bg-violet-tint pl-3 pr-1.5 text-small font-semibold text-violet-ink">
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={`${ut("coh.removeTag")}: ${label}`}
        title={ut("coh.removeTag")}
        onClick={onRemove}
        className="inline-grid size-6 min-h-0 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-violet-ink hover:bg-violet-tint-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <Ic.x size={13} />
      </button>
    </li>
  );
}

/* ─────────── разбивка ─────────── */

/**
 * Разбивка полосами (HBars графиков): подпись с долей от всей выборки,
 * полоса от самой длинной строки, число справа. Скрытая порогом ячейка —
 * «n < 5» с объяснением по наведению, без полосы: длина полосы — тоже число.
 *
 * Выраженность — цветом ступени вместе со словом: цвет никогда не один.
 */
export function Breakdown({
  title,
  rows,
  label,
  severity,
  floor,
  limit = 6,
}: {
  title: string;
  rows: BarRow[];
  label: (key: string) => string;
  severity?: boolean;
  floor: number;
  limit?: number;
}) {
  const { ut } = useLang();
  const [all, setAll] = useState(false);
  const visible = all ? rows : rows.slice(0, limit);
  const sev = (key: string): Severity | null => (key in SEVERITY_LABEL ? (key as Severity) : null);
  return (
    <div className="min-w-0">
      <h3 className="m-0 mb-2 text-caption font-bold text-muted">{title}</h3>
      {rows.length === 0 ? (
        <p className="m-0 text-small text-muted">{ut("chart.noData")}</p>
      ) : (
        <HBars
          floor={floor}
          items={visible.map((r) => ({
            key: r.key,
            label: (
              <>
                {label(r.key)}
                {r.share !== null ? <span className="ml-1.5 text-caption font-medium text-muted">{r.share} %</span> : null}
              </>
            ),
            value: r.count,
            severity: severity ? sev(r.key) : null,
          }))}
        />
      )}
      {rows.length > limit ? (
        <Button variant="quiet" size="xs" className="mt-1" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? ut("coh.less") : `${ut("coh.more")} ${rows.length - visible.length}`}
        </Button>
      ) : null}
    </div>
  );
}
