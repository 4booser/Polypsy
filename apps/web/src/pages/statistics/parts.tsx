import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PatientGroupWithCounts, SampleFilters, Sex, StatCell } from "@quizzy/shared";
import { api, type Patient } from "../../api";
import { seriesColor } from "../../charts/kit";
import { useLang } from "../../lang";
import { Popover } from "../../ui";
import { cx } from "../../ui/cx";
import { Button, ErrorText, Field, Input, Segmented, Select, Tag } from "../../ui/primitives";
import { useDebounced, useResource } from "../../useResource";
import { useLocalityHints } from "./data";
import { patientName } from "./names";
import {
  CRITERION_LABEL,
  type Criterion,
  HIDDEN_MARK,
  ageFromInput,
  cellText,
  criteriaOf,
  criterionValue,
  filterErrors,
} from "./model";

/*
 * Детали раздела «Статистика», общие для его экранов, — и только для них:
 * значки, номер выборки, чипы критериев, скрытая ячейка с объяснением,
 * пометка «ВШР» и поля фильтра выборки (ящик модели и пресет).
 */

/* ─────────── значки ─────────── */

/*
 * Значки lucide, которых нет в наборе (ui/icons.tsx): штрих 2 на сетке 24,
 * currentColor. Здесь, а не в наборе: набор правят параллельно, а нужны они
 * только экранам статистики.
 */
function glyph(paths: ReactNode) {
  return function Glyph({ size = 16, className }: { size?: number; className?: string }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        focusable="false"
        className={cx("shrink-0", className)}
      >
        {paths}
      </svg>
    );
  };
}

export const St = {
  play: glyph(<polygon points="6 3 20 12 6 21 6 3" />),
  trash: glyph(
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </>,
  ),
  sigma: glyph(
    <path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2" />,
  ),
  sliders: glyph(
    <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />,
  ),
  mapPin: glyph(
    <>
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </>,
  ),
  cake: glyph(
    <>
      <path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8" />
      <path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1" />
      <path d="M2 21h20M7 8v3M12 8v3M17 8v3M7 4h.01M12 4h.01M17 4h.01" />
    </>,
  ),
  calendarRange: glyph(
    <>
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M16 2v4M3 10h18M8 2v4M17 14h-6M13 18H7M7 14h.01M17 18h.01" />
    </>,
  ),
  eyeOff: glyph(
    <>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </>,
  ),
  shieldAlert: glyph(
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4M12 16h.01" />
    </>,
  ),
  book: glyph(
    <>
      <path d="M12 7v14M16 12h2M16 8h2M6 12h2M6 8h2" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </>,
  ),
  listOrdered: glyph(<path d="M10 12h11M10 18h11M10 6h11M4 10h2M4 6h1v4M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />),
  link: glyph(
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>,
  ),
  arrowUpRight: glyph(<path d="M7 7h10v10M7 17 17 7" />),
  settings: glyph(
    <>
      <path d="M20 7h-9M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </>,
  ),
  save: glyph(
    <>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7" />
    </>,
  ),
  copy: glyph(
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>,
  ),
  userSearch: glyph(
    <>
      <circle cx="10" cy="7" r="4" />
      <path d="M10.3 15H7a4 4 0 0 0-4 4v2" />
      <circle cx="17" cy="17" r="3" />
      <path d="m21 21-1.9-1.9" />
    </>,
  ),
  userRound: glyph(
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </>,
  ),
  usersRound: glyph(
    <>
      <path d="M18 21a8 8 0 0 0-16 0" />
      <circle cx="10" cy="8" r="5" />
      <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
    </>,
  ),
  component: glyph(
    <path d="M15.5 11.3a1 1 0 0 0 0 1.4l2.4 2.4a1 1 0 0 0 1.4 0l2.4-2.4a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0zM2.3 11.3a1 1 0 0 0 0 1.4l2.4 2.4a1 1 0 0 0 1.4 0l2.4-2.4a1 1 0 0 0 0-1.4L6.1 8.9a1 1 0 0 0-1.4 0zM8.9 17.9a1 1 0 0 0 0 1.4l2.4 2.4a1 1 0 0 0 1.4 0l2.4-2.4a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0zM8.9 4.7a1 1 0 0 0 0 1.4l2.4 2.4a1 1 0 0 0 1.4 0l2.4-2.4a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0z" />,
  ),
  chartColumn: glyph(<path d="M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3" />),
  chartBar: glyph(<path d="M3 3v16a2 2 0 0 0 2 2h16M7 16h8M7 11h12M7 6h3" />),
  filter: glyph(<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />),
  split: glyph(<path d="M16 3h5v5M8 3H3v5M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3M15 9l6-6" />),
  pencil: glyph(
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>,
  ),
};

/*
 * Глиф «−» и кнопка-глиф прежних экранов раздела. Экраны статистики ими
 * больше не пользуются, но их берёт «Добір людей» (pages/Cohorts.tsx) —
 * чужой участок; убрать их здесь значило бы сломать его сборку.
 */

/** «−» строки условия: штрих 5 в квадрате 27 — близнец IconPlusThick (ui/glyphs.tsx) */
export function IconMinusThick() {
  return (
    <svg viewBox="0 0 27 27" width={27} height={27} aria-hidden focusable="false">
      <path d="M2.5 13.5h22" stroke="currentColor" strokeWidth={5} />
    </svg>
  );
}

/** Голый глиф «+»/«−» с подписью для диктора и подсказкой тем же словом */
export function GlyphButton({
  label,
  onClick,
  children,
  disabled,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      size="glyph"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={className}
    >
      {children}
    </Button>
  );
}

/** Значок строки-критерия: тот же в чипе, в строке пресета и в «Додати умову» */
export const CRITERION_ICON: Record<Criterion, ReactNode> = {
  date: <St.calendarRange size={13} />,
  patient: <St.userSearch size={13} />,
  age: <St.cake size={13} />,
  sex: <St.userRound size={13} />,
  locality: <St.mapPin size={13} />,
  group: <St.component size={13} />,
};

/* ─────────── выборка ─────────── */

/** Цвет выборки — цвет её ряда на графике (c1…c4, дальше — «прочее») */
export function sampleColor(i: number, n: number): string {
  return seriesColor(i, n);
}

/**
 * Номер выборки на кольце её цвета. Цвет не единственный признак: номер
 * тот же, что в подписи «Вибірка N» и в легенде графика.
 */
export function SampleBadge({ n, of, small, fresh }: { n: number; of: number; small?: boolean; fresh?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-grid shrink-0 place-items-center bg-panel font-extrabold tabular-nums leading-none text-text",
        small ? "size-[18px] rounded-[6px] text-[10.5px]" : "size-[22px] rounded-[7px] text-[11.5px]",
        fresh && "text-muted",
      )}
      style={{ boxShadow: `inset 0 0 0 ${fresh ? 1.5 : 2}px ${fresh ? "var(--ctl)" : sampleColor(n - 1, of)}` }}
    >
      {n}
    </span>
  );
}

/** Имя выборки: своя подпись, иначе имя пресета, иначе «Вибірка N» */
export function useSampleName() {
  const { ut } = useLang();
  return (title: string | null | undefined, presetTitle: string | null | undefined, i: number) =>
    title?.trim() || presetTitle || `${ut("st.sample")} ${i + 1}`;
}

/**
 * Чипы критериев выборки: «Дата: 01.07 – 31.12.2026», «Стать: Чоловіки».
 * Группа и человек — только именем критерия (criterionValue): чип читают
 * через плечо. Без критериев — «усі пацієнти».
 */
export function CriteriaChips({ filters, className }: { filters: SampleFilters | null | undefined; className?: string }) {
  const { ut } = useLang();
  const list = criteriaOf(filters);
  if (!list.length) {
    return (
      <div className={cx("flex flex-wrap gap-[5px]", className)}>
        <Tag icon={<St.usersRound />}>{ut("st.everyone")}</Tag>
      </div>
    );
  }
  return (
    <div className={cx("flex flex-wrap gap-[5px]", className)}>
      {list.map((k) => {
        const value = criterionValue(k, filters, ut);
        return (
          <Tag key={k} icon={CRITERION_ICON[k]} className="max-w-full">
            <span className="truncate">
              {ut(CRITERION_LABEL[k])}
              {value ? `: ${value}` : ""}
            </span>
          </Tag>
        );
      })}
    </div>
  );
}

/** «пресет: Чоловіки 25–45» или «власні фільтри» — чем отобрана выборка */
export function SourceTag({ preset }: { preset: string | null | undefined }) {
  const { ut } = useLang();
  return preset ? (
    <Tag tone="primary" icon={<St.sliders />} className="max-w-full">
      <span className="truncate">
        {ut("st.presetWord")}: {preset}
      </span>
    </Tag>
  ) : (
    <Tag icon={<St.filter />}>{ut("st.ownFilters")}</Tag>
  );
}

/* ─────────── скрытое ─────────── */

/**
 * Что значит «приховано» — одна фраза на весь раздел: число есть, но вместе
 * с другими числами отчёта оно называло бы людей. Нули печатаются всегда,
 * выборку меньше порога сервер закрывает целиком.
 */
export function HiddenWhy({ floor }: { floor: number }) {
  const { ut } = useLang();
  return (
    <>
      <span className="block">{ut("st.hiddenWhy")}</span>
      <span className="mt-1 block text-muted">{ut("st.hiddenRules").replace("{n}", String(floor))}</span>
    </>
  );
}

/**
 * Скрытая ячейка таблицы: пунктирная рамка с прочерком и объяснение по
 * наведению и фокусу. Число сюда не доезжает: ячейка приходит без него.
 */
export function HiddenCell({ floor }: { floor: number }) {
  const { ut } = useLang();
  return (
    <Popover title={ut("st.hiddenTitle")} note={ut("st.privacyRule")} content={<HiddenWhy floor={floor} />} width={300}>
      <span
        tabIndex={0}
        aria-label={ut("st.hidden")}
        className={cx(
          "inline-grid h-6 min-w-[38px] cursor-help place-items-center rounded-[7px] border-[1.5px] border-dashed border-control",
          "text-[15px] font-extrabold leading-none text-muted hover:border-muted hover:text-text",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        )}
      >
        {HIDDEN_MARK}
      </span>
    </Popover>
  );
}

/** Доля строкой с подписью скрытого для диктора — легенда, таблица графика */
export function CellText({ cell }: { cell: StatCell | null | undefined }) {
  const { ut } = useLang();
  const text = cellText(cell);
  if (text !== HIDDEN_MARK) return <>{text}</>;
  return (
    <span title={ut("st.hidden")}>
      <span aria-hidden>{HIDDEN_MARK}</span>
      <span className="sr-only">{ut("st.hidden")}</span>
    </span>
  );
}

/* ─────────── «ВШР» ─────────── */

/**
 * Пометка «ВШР» (високий ступінь ризику) на варианте ответа — кнопка с
 * состоянием. Нажатая — тоном риска с галочкой, отпущенная — контуром:
 * признак не только цветом, но и знаком. Риск здесь — про человека,
 * выбравшего такой ответ, поэтому красный уместен.
 */
export function VshrToggle({ pressed, onToggle }: { pressed: boolean; onToggle: () => void }) {
  const { ut } = useLang();
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={ut("st.vshrAll")}
      onClick={onToggle}
      className={cx(
        "inline-flex h-[22px] min-h-0 shrink-0 cursor-pointer items-center gap-1 rounded-[11px] border-0 px-2",
        "text-[11px] font-extrabold leading-none",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        pressed
          ? "bg-risk-tint text-risk-ink shadow-[inset_0_0_0_1px_var(--riskline)]"
          : "bg-transparent text-muted shadow-[inset_0_0_0_1px_var(--ctl)]",
      )}
    >
      {pressed ? <CheckGlyph /> : null}
      {/* видимое слово входит в имя целиком (WCAG 2.5.3): голосом говорят «ВШР» */}
      {ut("st.vshr")}
      <span className="sr-only"> — {ut("st.vshrLong")}</span>
    </button>
  );
}

function CheckGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Метка «ВШР» без действия — в строках отчёта редактора и графика */
export function VshrMark() {
  const { ut } = useLang();
  return (
    <span
      title={ut("st.vshrLong")}
      className="inline-flex h-5 shrink-0 items-center rounded-[10px] px-[7px] text-[10.5px] font-extrabold leading-none text-risk-ink shadow-[inset_0_0_0_1px_var(--riskline)]"
    >
      {ut("st.vshr")}
    </span>
  );
}

/* ─────────── поля фильтра ─────────── */

/**
 * Два поля диапазона: «від» и «до». Отказ — словами под парой. `inline` —
 * строка условия пресета: подписи только для диктора, между полями тире,
 * как в строке «Вік 25 — 45».
 */
function RangePair({
  inline,
  error,
  labels,
  children,
}: {
  inline?: boolean;
  error: string | null;
  labels: [string, string];
  children: [ReactNode, ReactNode];
}) {
  if (!inline) {
    return (
      <div className="grid grid-cols-2 gap-x-3">
        <Field label={labels[0]} error={error} className="mb-0">
          {children[0]}
        </Field>
        <Field label={labels[1]} className="mb-0">
          {children[1]}
        </Field>
      </div>
    );
  }
  return (
    <div>
      <div className="flex max-w-[440px] items-center gap-2">
        <Field label={labels[0]} inline className="min-w-0 flex-1">
          {children[0]}
        </Field>
        <span aria-hidden className="h-[1.5px] w-3 shrink-0 bg-muted" />
        <Field label={labels[1]} inline className="min-w-0 flex-1">
          {children[1]}
        </Field>
      </div>
      {error ? <ErrorText className="mt-1.5">{error}</ErrorText> : null}
    </div>
  );
}

/** Период: два поля даты; конец раньше начала — оба поля с отказом и словами под ними */
export function PeriodFields({
  from,
  to,
  onChange,
  inline,
}: {
  from?: string | null;
  to?: string | null;
  onChange: (next: { from: string | null; to: string | null }) => void;
  inline?: boolean;
}) {
  const { ut } = useLang();
  const bad = filterErrors({ from, to }).includes("coh.errPeriod");
  return (
    <RangePair inline={inline} error={bad ? ut("coh.errPeriod") : null} labels={[ut("st.periodFrom"), ut("st.periodTo")]}>
      <Input
        type="date"
        value={from ?? ""}
        max={to ?? undefined}
        aria-invalid={bad || undefined}
        onChange={(e) => onChange({ from: e.target.value || null, to: to ?? null })}
      />
      <Input
        type="date"
        value={to ?? ""}
        min={from ?? undefined}
        aria-invalid={bad || undefined}
        onChange={(e) => onChange({ from: from ?? null, to: e.target.value || null })}
      />
    </RangePair>
  );
}

/** Возраст: «від — до» в годах на день сдачи; «від» больше «до» — отказ словами */
export function AgeFields({
  min,
  max,
  onChange,
  inline,
}: {
  min?: number | null;
  max?: number | null;
  onChange: (next: { ageMin: number | null; ageMax: number | null }) => void;
  inline?: boolean;
}) {
  const { ut } = useLang();
  const bad = filterErrors({ ageMin: min, ageMax: max }).includes("coh.errAge");
  return (
    <RangePair inline={inline} error={bad ? ut("coh.errAge") : null} labels={[ut("st.ageFrom"), ut("st.ageTo")]}>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={120}
        placeholder="0"
        suffix={ut("st.years")}
        aria-invalid={bad || undefined}
        value={min ?? ""}
        onChange={(e) => onChange({ ageMin: ageFromInput(e.target.value), ageMax: max ?? null })}
      />
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={120}
        placeholder="120"
        suffix={ut("st.years")}
        aria-invalid={bad || undefined}
        value={max ?? ""}
        onChange={(e) => onChange({ ageMin: min ?? null, ageMax: ageFromInput(e.target.value) })}
      />
    </RangePair>
  );
}

/** «Стать»: будь-яка, чоловіча, жіноча — стать з картки на момент здачі */
export function SexField({ value, onChange }: { value?: Sex | null; onChange: (v: Sex | null) => void }) {
  const { ut } = useLang();
  return (
    <Segmented
      label={ut("person.sex")}
      wide
      value={value ?? "any"}
      onChange={(k) => onChange(k === "male" || k === "female" ? k : null)}
      items={[
        { key: "any", label: ut("st.anySex") },
        { key: "male", label: ut("mp.male") },
        { key: "female", label: ut("mp.female") },
      ]}
    />
  );
}

/**
 * «Населений пункт»: свободное поле с подсказками из записанных названий.
 *
 * Решение заказчика 2026-09-26: адекватные фильтры. Сравнение точное (без
 * учёта регистра): «Київ» против «м. Київ» давало пустую выборку, и экран не
 * говорил почему. Подсказки — штатный datalist.
 */
export function LocalityInput({ value, onChange }: { value?: string | null; onChange: (v: string) => void }) {
  const { ut } = useLang();
  const hints = useLocalityHints();
  const listId = useId();
  return (
    <>
      <Input
        value={value ?? ""}
        maxLength={160}
        placeholder={ut("st.anyLocality")}
        icon={<St.mapPin />}
        list={hints.length ? listId : undefined}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      {hints.length ? (
        <datalist id={listId}>
          {hints.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

/**
 * «Група пацієнтів» — своя группа сотрудника. Группа, которой больше нет
 * (или она чужая), остаётся в выборе строкой «Група недоступна»: иначе
 * выборка считала бы по ней, а поле показывало бы «будь-яка».
 */
export function GroupSelect({
  value,
  onChange,
  groups,
}: {
  value?: string | null;
  onChange: (v: string | null) => void;
  groups: PatientGroupWithCounts[] | null;
}) {
  const { ut } = useLang();
  const orphan = value && groups && !groups.some((g) => g.id === value) ? value : null;
  return (
    <Select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{ut("st.anyGroup")}</option>
      {orphan ? <option value={orphan}>{ut("st.groupUnavailable")}</option> : null}
      {(groups ?? []).map((g) => (
        <option key={g.id} value={g.id}>
          {g.title}
        </option>
      ))}
    </Select>
  );
}

/**
 * «Пацієнт» — поиск человека по имени в зоне видимости сотрудника.
 *
 * Список под полем — те же люди, что в разделе «Пацієнти» (GET
 * /api/access/patients): сервер отдаёт только тех, кого сотруднику видеть
 * положено, и расчёт проверит это ещё раз (assertFilterRefs). Выборка из
 * одного человека всегда ниже порога и приходит закрытой — чисел по одному
 * человеку экран не покажет никогда.
 */
export function PatientField({
  value,
  onChange,
  label,
}: {
  value?: string | null;
  onChange: (id: string | null) => void;
  /** Имя поля для диктора, когда видимая подпись стоит не в <label> вокруг поля */
  label?: string;
}) {
  const { ut } = useLang();
  const id = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const known = useRef(new Map<string, string>());
  const listRef = useRef<HTMLDivElement>(null);

  /*
   * Имя сохранённого в фильтре человека — один раз, по идентификатору.
   * Загрузкой, а не голым запросом: имя прежнего человека, приехавшее после
   * смены фильтра, не встанет в поле нового. Только имя, а не карточка
   * (names.ts): карточка — чтение персональных данных с телефоном, и в
   * журнал оно шло как «открывал карточку» на каждую выборку при каждом
   * открытии страницы. Человека нет в ответе (вне зоны) — «недоступний», как
   * прежде отказ карточки.
   */
  const name = useResource(() => patientName(value!).then((n) => ({ n })), [value], {
    enabled: !!value && !known.current.has(value),
    keep: false,
  });
  useEffect(() => {
    if (!value) {
      setText("");
      return;
    }
    const kept = known.current.get(value);
    if (kept) {
      setText(kept);
      return;
    }
    if (name.data?.n) {
      known.current.set(value, name.data.n);
      setText(name.data.n);
    } else if (name.data || name.error) setText(ut("st.patientUnavailable"));
  }, [value, name.data, name.error, ut]);

  /* поиск ждёт паузу в наборе: сервер расшифровывает ФИО на каждый запрос */
  const typed = text.trim();
  const q = useDebounced(typed, 250);
  const searching = open && typed.length >= 2 && q.length >= 2;
  const search = useResource(
    () =>
      api
        .patients({ search: q })
        .then((r) => r.items.slice(0, 8))
        // отказ поиска — «никого не найдено», а не поломка поля
        .catch(() => [] as Patient[]),
    [q],
    { enabled: searching },
  );
  const found = searching ? search.data : null;

  const choose = (p: Patient) => {
    known.current.set(p.id, p.fullName);
    setText(p.fullName);
    setOpen(false);
    onChange(p.id);
  };

  return (
    <div className="relative">
      <Input
        role="combobox"
        aria-label={label}
        aria-expanded={open && !!found}
        aria-controls={open && found ? id : undefined}
        aria-autocomplete="list"
        value={text}
        placeholder={ut("st.patientHint")}
        icon={<St.userSearch />}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          /* стёртое имя — снятый критерий: иначе поле показывало бы пустоту, а фильтр держал человека */
          if (!e.target.value.trim()) onChange(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            /* Esc закрывает список, а не ящик вокруг поля */
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setOpen(false);
          }
        }}
        /*
         * Ушёл из поля, не выбрав, — в поле снова тот, кто в фильтре (или
         * пусто): набранное, но не выбранное имя читалось бы как критерий,
         * которого в выборке нет.
         */
        onBlur={(e) => {
          if (listRef.current?.contains(e.relatedTarget as Node | null)) return;
          setOpen(false);
          setText(value ? (known.current.get(value) ?? "") : "");
        }}
      />
      {open && found ? (
        <div
          ref={listRef}
          id={id}
          role="listbox"
          aria-label={ut("st.patient")}
          className="absolute left-0 top-[calc(100%+4px)] z-50 w-full rounded-control border border-border bg-panel py-1 shadow-pop"
        >
          {found.length === 0 ? (
            <p className="m-0 px-3 py-1.5 text-small text-muted">{ut("st.noPatients")}</p>
          ) : (
            found.map((p) => (
              <div
                key={p.id}
                role="option"
                aria-selected={p.id === value}
                tabIndex={0}
                /* фокус остаётся в поле: иначе его уход закрыл бы список раньше, чем дойдёт нажатие */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose(p);
                  }
                }}
                className={cx(
                  "flex h-9 cursor-pointer items-center px-3 text-body text-text hover:bg-violet-tint",
                  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                )}
              >
                <span className="truncate">{p.fullName}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
