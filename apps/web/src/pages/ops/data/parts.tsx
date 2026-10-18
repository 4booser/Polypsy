import type { ReactNode } from "react";
import type { DataCheck, Lang, UiKey } from "@quizzy/shared";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { Tooltip } from "../../../ui/Popover";
import { Segmented, Tag } from "../../../ui/primitives";
import { fill } from "../../dashboard/model";
import { Ix } from "../people2/icons";
import { LEVEL_LABEL, WINDOWS, WINDOW_LABEL, type Window } from "./model";

/*
 * Общие куски четырёх разделов «Дані й продукт» в «Виразній»: окно 7 / 30 /
 * 90 дней сегментами в шапке, уровень проверки пилюлей со словом и знаком,
 * числа с разрядами, короткие даты, пары «подпись — число» строками панели,
 * строка-пояснение под таблицей и замаскированный секрет.
 */

/* ─────────── числа и даты ─────────── */

/** Число с разрядами по языку экрана: «81 420» */
export function int(v: number): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(v);
}

/** Доля с одним знаком: «99,6 %» — по языку экрана */
export function pct(v: number): string {
  return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(v)} %`;
}

/** Календарный день «YYYY-MM-DD» — полночью по местному, а не по UTC (иначе западнее Гринвича он сдвинется) */
function calendarDay(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
}

/** Подпись дня под осью: «10.09» — коротко, столбцов тридцать */
export function dayTick(iso: string): string {
  return calendarDay(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
}

/** День с годом: «08.10.2026» — конец окна в мета-строке */
export function dayWithYear(iso: string): string {
  return calendarDay(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Момент коротко: «08.10, 16:59»; не нынешнего года — с годом */
export function stamp(iso: string): string {
  const d = new Date(iso);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(locale(), {
    day: "2-digit",
    month: "2-digit",
    ...(thisYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ─────────── число со словом ─────────── */

/** Три формы слова при числе: 1 проходження, 2 проходження, 5 проходжень */
export interface Forms {
  one: UiKey;
  few: UiKey;
  many: UiKey;
}

/** Форма по правилу числа языка (Intl.PluralRules); дробное и «other» — как «many» */
export function pluralForm(lang: Lang, n: number): keyof Forms {
  const rule = new Intl.PluralRules(lang).select(n);
  return rule === "one" ? "one" : rule === "few" ? "few" : "many";
}

/** Строка формы с подставленным числом: «{n} проходжень» → «14 проходжень» */
export function usePlural(): (n: number, forms: Forms) => string {
  const { ut, lang } = useLang();
  return (n, forms) => fill(ut(forms[pluralForm(lang, n)]), { n: int(n) });
}

/* ─────────── окно ─────────── */

/** Окно 7 / 30 / 90 дней — сегментами набора у правого края шапки */
export function WindowSwitch({ value, onChange }: { value: Window; onChange: (w: Window) => void }) {
  const { ut } = useLang();
  return (
    <Segmented
      label={ut("dash.rangeLabel")}
      value={String(value) as `${Window}`}
      onChange={(v) => onChange(Number(v) as Window)}
      items={WINDOWS.map((w) => ({ key: String(w) as `${Window}`, label: ut(WINDOW_LABEL[w]) }))}
    />
  );
}

/* ─────────── уровень проверки ─────────── */

/**
 * Уровень проверки — словом и знаком, цвет вторым.
 *
 * «Помилка» — янтарём со знаком стоп: данные уже врут, и это ровно
 * «требует внимания»; красный в консоли отдан риску для человека, а
 * разошедшаяся запись — забота того, кто держит систему. «Попередження» —
 * нейтральной пилюлей с треугольником, «До відома» — сведениями. Слово и
 * форма знака читаются и в печати, и тем, кто цветов не различает.
 */
export function LevelTag({ level }: { level: DataCheck["level"] }) {
  const { ut } = useLang();
  if (level === "error") {
    return (
      <Tag tone="attention" icon={<Ix.octagonAlert />}>
        {ut(LEVEL_LABEL[level])}
      </Tag>
    );
  }
  if (level === "warning") {
    return (
      <Tag tone="plain" icon={<Ic.alert />}>
        {ut(LEVEL_LABEL[level])}
      </Tag>
    );
  }
  return (
    <Tag tone="info" icon={<Ic.info />}>
      {ut(LEVEL_LABEL[level])}
    </Tag>
  );
}

/* ─────────── строки панели ─────────── */

export interface Fact {
  key: string;
  label: ReactNode;
  value: ReactNode;
  /** Приглушённое пояснение после числа: «з 186 пристроїв», «на 6 пристроях» */
  note?: ReactNode;
  /** Число требует внимания — янтарём */
  warn?: boolean;
}

/**
 * Пары «подпись — число» строками через волосяную линию (.kvl набора):
 * подпись слева, число 800 у правого края, пояснение за ним. Для сводок,
 * где чисел три-четыре и каждое со своим сравнением, — вместо плиток.
 */
export function Facts({ rows, className }: { rows: readonly Fact[]; className?: string }) {
  return (
    <dl className={cx("m-0 flex flex-col", className)}>
      {rows.map((r) => (
        <div
          key={r.key}
          className="flex items-baseline gap-2.5 border-t border-divider py-[7px] text-small text-text-2 first:border-t-0 first:pt-0"
        >
          <dt className="min-w-0">{r.label}</dt>
          <dd className="m-0 ml-auto flex shrink-0 items-baseline gap-2.5">
            <b className={cx("whitespace-nowrap font-extrabold tabular-nums", r.warn ? "text-warn" : "text-text")}>{r.value}</b>
            {r.note ? <span className="whitespace-nowrap text-caption text-muted">{r.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Подпись над фигурой внутри панели (.lbl набора): 12/700 приглушённым */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("text-caption font-bold leading-4 text-muted", className)}>{children}</div>;
}

/** Строка-пояснение в подвале панели (.pfx набора): знак и текст text-2 */
export function FootNote({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-2 text-small text-text-2">
      <span aria-hidden className="mt-px inline-flex shrink-0 text-muted [&>svg]:size-[15px]">
        {icon ?? <Ic.info />}
      </span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** Код или идентификатор в плашке (.cd набора): моноширинным, на утопленной подложке */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center whitespace-nowrap rounded-[6px] bg-sunk px-1.5 align-middle font-mono text-[11.5px] font-semibold leading-none text-text-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Значение, которое не показывается никому (.mask набора): замок и точки.
 * Стоит там, где у записи есть секрет, — чтобы было видно, что он есть и
 * что его здесь нет. Подпись для диктора — словами.
 */
export function Masked() {
  const { ut } = useLang();
  return (
    <Tooltip label={ut("oppd.masked")}>
      <span
        tabIndex={0}
        className="inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-[6px] bg-sunk px-[7px] text-[12px] font-bold leading-none tracking-[.14em] text-muted outline-none focus-visible:ring-2 focus-visible:ring-violet-ring"
      >
        <Ic.lock size={11} />
        <span aria-hidden>{"•".repeat(10)}</span>
        <span className="sr-only">{ut("oppd.masked")}</span>
      </span>
    </Tooltip>
  );
}
