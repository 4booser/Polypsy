import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { Severity } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { num } from "./ladder";

/**
 * Общие детали графиков «Виразної»: цвета рядов, метки, подсказка, легенда,
 * скрытая малая ячейка и переключатель «Діаграма / Таблиця».
 *
 * Правила взяты из набора (.superdesign/ui3/kit/charts.py) и навыка dataviz:
 *
 *   — цвет ряда следует за сущностью и идёт в постоянном порядке
 *     c1…c4 (PHQ-9 круг, GAD-7 квадрат, PCL-5 ромб, WHO-5 треугольник), c5 —
 *     «прочее» и сравнение; одиночный ряд — фиолетовый набора (--series);
 *   — у метки есть форма, чтобы ряд не держался на одном цвете;
 *   — текст никогда не красится в цвет ряда: подписи — чернилами текста,
 *     цветная метка рядом несёт принадлежность;
 *   — красный — только риск для человека, янтарь (--warn) — «требует
 *     внимания»;
 *   — линии 2 px, метки ≥ 8 px с кольцом цвета поверхности 2 px, столбцы
 *     ≤ 24 px со скруглением 4 px только у конца данных;
 *   — подсказка у каждого графика, и с клавиатуры то же, что мышью.
 */

/* ─────────── цвета и формы рядов ─────────── */

/** Категориальные ряды c1…c4: порядок постоянный, «пятый» — уже «прочее» */
export const SERIES_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"] as const;
/** Прочее и сравнение: «було», фон, всё, что не главный ряд */
export const OTHER_COLOR = "var(--c5)";
/** Одиночный ряд — фиолетовый набора (в тёмной — светлая ступень) */
export const SINGLE_COLOR = "var(--series)";
/** «Требует внимания»: просрочено, сбой, выше порога */
export const ATTENTION_COLOR = "var(--warn)";

export type MarkShape = "circle" | "square" | "diamond" | "triangle";

const SHAPES: readonly MarkShape[] = ["circle", "square", "diamond", "triangle"];

/**
 * Методики с закреплённым цветом и формой — на всех экранах одинаково:
 * PHQ-9 в одном месте фиолетовый круг, а в другом жёлтый квадрат читались бы
 * как две разные методики.
 */
const INSTRUMENTS: Record<string, { color: string; shape: MarkShape }> = {
  "PHQ-9": { color: "var(--c1)", shape: "circle" },
  "GAD-7": { color: "var(--c2)", shape: "square" },
  "PCL-5": { color: "var(--c3)", shape: "diamond" },
  "WHO-5": { color: "var(--c4)", shape: "triangle" },
};

/** Цвет и форма методики по коду; null — у методики своего места в палитре нет */
export function instrumentMark(code: string): { color: string; shape: MarkShape } | null {
  return INSTRUMENTS[code.toUpperCase()] ?? null;
}

/** Цвет ряда по месту: один ряд — фиолетовый, иначе c1…c4, дальше — «прочее» */
export function seriesColor(index: number, count: number): string {
  if (count === 1) return SINGLE_COLOR;
  return SERIES_COLORS[index] ?? OTHER_COLOR;
}

/**
 * Форма метки по цвету ряда: c2 — квадрат, c3 — ромб, c4 — треугольник.
 * Цвет приходит от вызывающего (прежние имена --s2, --cat-2 ведут на те же
 * ступени), и форма идёт за ним, а не за номером ряда на экране.
 */
export function shapeOf(color: string | undefined, index = 0): MarkShape {
  const m = color ? /--(?:c|s|cat-|series-)([1-4])\)/.exec(color) : null;
  if (m) return SHAPES[Number(m[1]) - 1]!;
  return color ? "circle" : (SHAPES[index] ?? "circle");
}

/** Ступень набора s0…s4 по выраженности консоли: «тяжка» — s4, s3 у консоли не бывает */
export const SEV_LEVEL: Record<Severity, 0 | 1 | 2 | 4> = { none: 0, mild: 1, moderate: 2, severe: 4 };

/** Цвет ступени для отрезка и метки */
export const sevColor = (s: Severity) => `var(--sev-${SEV_LEVEL[s]})`;
/** Подложка ступени: невыбранные отрезки линейки, плашка с словом */
export const sevBg = (s: Severity) => `var(--sev-${SEV_LEVEL[s]}-bg)`;

/* ─────────── числа ─────────── */

/**
 * Число в подписи: до двух знаков, запятая там, где её пишет язык.
 * «5,6» на украинской консоли, «5.6» на английской — и без
 * 0.30000000000000004 из суммы.
 */
export function useDecimal(): (v: number, digits?: number) => string {
  const { lang } = useLang();
  return (v, digits = 2) => {
    const k = 10 ** digits;
    const s = digits === 2 ? num(v) : String(Math.round(v * k) / k);
    return lang === "en" ? s : s.replace(".", ",");
  };
}

/** Подстановка {name} в строку словаря */
export function fillIn(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}

/* ─────────── метка ряда ─────────── */

/**
 * Метка с кольцом цвета поверхности: кольцо отделяет её от линии и от
 * соседней метки, где они пересекаются. Форма — второй канал после цвета.
 */
export function Marker({
  shape = "circle",
  x,
  y,
  r = 4,
  color,
  ring = "var(--panel)",
  ringWidth = 2,
}: {
  shape?: MarkShape;
  x: number;
  y: number;
  r?: number;
  color: string;
  ring?: string;
  ringWidth?: number;
}) {
  const paint = {
    fill: color,
    stroke: ring,
    strokeWidth: ringWidth,
    paintOrder: "stroke",
    strokeLinejoin: "round",
  } as const;
  const f = (v: number) => v.toFixed(1);
  if (shape === "square") {
    const s = r * 1.7;
    return <rect x={f(x - s / 2)} y={f(y - s / 2)} width={f(s)} height={f(s)} rx={1.5} style={paint} />;
  }
  if (shape === "diamond") {
    const q = r * 1.35;
    return <polygon points={`${f(x)},${f(y - q)} ${f(x + q)},${f(y)} ${f(x)},${f(y + q)} ${f(x - q)},${f(y)}`} style={paint} />;
  }
  if (shape === "triangle") {
    const q = r * 1.4;
    return (
      <polygon
        points={`${f(x)},${f(y - q)} ${f(x + q * 0.95)},${f(y + q * 0.72)} ${f(x - q * 0.95)},${f(y + q * 0.72)}`}
        style={paint}
      />
    );
  }
  return <circle cx={f(x)} cy={f(y)} r={r} style={paint} />;
}

/* ─────────── подсказка ─────────── */

/**
 * Подсказка графика — всплывающий слой набора (.pop): лист, рамка, тень
 * всплывающего, 12,5 px. Стоит рядом с точкой, справа от неё, а у правого
 * края — слева: подсказка, которая уезжает за край панели, не читается.
 */
export function ChartTip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = x <= width * 0.58;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-[3] w-max max-w-[300px] rounded-panel border border-border bg-panel px-[14px] pt-[11px] pb-[12px] text-small text-text-2 shadow-pop"
      style={{ top: Math.max(0, Math.round(y) - 18), ...(left ? { left: Math.round(x) + 14 } : { right: Math.round(width - x) + 14 }) }}
    >
      {children}
    </div>
  );
}

/** Заголовок подсказки: что и когда, справа — тихая пометка («старт», «n = 31») */
export function TipHead({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <p className="m-0 flex items-baseline gap-[8px] text-body leading-[18px] font-extrabold whitespace-nowrap text-text">
      <span>{children}</span>
      {note ? <span className="ml-auto pl-[8px] text-caption font-semibold text-muted">{note}</span> : null}
    </p>
  );
}

/** Строка подсказки: ключ ряда коротким штрихом, подпись, значение справа — значение главное */
export function TipRow({
  color,
  label,
  value,
  extra,
  kind = "line",
}: {
  color?: string;
  label?: ReactNode;
  value: ReactNode;
  extra?: ReactNode;
  kind?: "line" | "box";
}) {
  return (
    <span className="mt-[6px] flex items-baseline gap-[8px] border-t border-divider pt-[5px] whitespace-nowrap">
      {color ? (
        kind === "line" ? (
          <span aria-hidden className="inline-block h-[2px] w-[12px] shrink-0 -translate-y-[3px] rounded-[1px]" style={{ background: color }} />
        ) : (
          <span aria-hidden className="inline-block size-[9px] shrink-0 rounded-[2px]" style={{ background: color }} />
        )
      ) : null}
      {label !== undefined ? <span className="grow text-text-2">{label}</span> : null}
      <b className="ml-auto pl-[10px] font-extrabold text-text">{value}</b>
      {extra ? <span className="text-muted">{extra}</span> : null}
    </span>
  );
}

/** Абзац подсказки; muted — пояснение второго плана */
export function TipText({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <p className={cx("m-0 mt-[5px] max-w-[272px] whitespace-normal", muted ? "text-muted" : "text-text-2")}>{children}</p>;
}

/** Плашка выраженности набора (.sev): ступень всегда со своим словом */
export function SevChip({ severity, label, small }: { severity: Severity; label: string; small?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-pill font-bold leading-none whitespace-nowrap",
        small ? "h-[20px] px-[8px] text-[11.5px]" : "h-[24px] px-[10px] text-caption",
      )}
      style={{ color: sevColor(severity), background: sevBg(severity) }}
    >
      {label}
    </span>
  );
}

/* ─────────── наведение с клавиатуры ─────────── */

/**
 * Номер элемента под курсором — и тот же номер с клавиатуры.
 *
 * Подсказка дополняет, а не запирает: всё, что видно мышью, должно быть
 * видно и тому, кто ходит клавишами. График получает фокус (Tab), стрелки
 * переводят от точки к точке, Home/End — к краям, Esc снимает подсказку.
 */
export function useIndexHover(count: number) {
  const [at, setAt] = useState<number | null>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!count) return;
    const step = (d: number) => {
      e.preventDefault();
      setAt((p) => (p === null ? (d > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, p + d))));
    };
    if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1);
    else if (e.key === "Home") {
      e.preventDefault();
      setAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setAt(count - 1);
    } else if (e.key === "Escape") setAt(null);
  };
  return {
    at,
    setAt,
    focusProps: {
      tabIndex: 0,
      onKeyDown,
      onFocus: () => setAt((p) => p ?? (count ? count - 1 : null)),
      onBlur: () => setAt(null),
      onMouseLeave: () => setAt(null),
    },
  };
}

/** Кольцо фокуса у графика, который ходит стрелками */
export const FOCUSABLE =
  "rounded-[6px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

/* ─────────── легенда ─────────── */

export type LegendKind = "line" | "mark" | "band" | "dash" | "zone" | "risk" | "warn";

export interface LegendItem {
  key: string;
  label: ReactNode;
  color: string;
  kind?: LegendKind;
  shape?: MarkShape;
}

/** Образец ряда в легенде: такой же, как на графике, — линия с меткой, полоса, пунктир */
export function LegendGlyph({ kind = "band", color, shape }: { kind?: LegendKind; color: string; shape?: MarkShape }) {
  if (kind === "band") return <span aria-hidden className="inline-block h-[10px] w-[18px] shrink-0 rounded-[3px]" style={{ background: color }} />;
  if (kind === "risk") return <span aria-hidden className="inline-block size-[9px] shrink-0 rounded-[2px] bg-risk" />;
  const box = kind === "mark" || kind === "warn" ? 14 : 24;
  return (
    <svg aria-hidden width={box} height={kind === "mark" || kind === "warn" ? 14 : 12} viewBox={`0 0 ${box} ${kind === "mark" || kind === "warn" ? 14 : 12}`} className="block shrink-0">
      {kind === "line" ? (
        <>
          <line x1={1} y1={6} x2={23} y2={6} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <Marker shape={shape ?? "circle"} x={12} y={6} r={3.4} color={color} ringWidth={0} />
        </>
      ) : null}
      {kind === "dash" ? <line x1={1} y1={6} x2={23} y2={6} stroke={color} strokeWidth={1.6} strokeDasharray="5 3" /> : null}
      {kind === "zone" ? (
        <rect x={1} y={1} width={22} height={10} rx={2} fill={color} stroke="var(--vink)" strokeWidth={1} strokeDasharray="3 2" />
      ) : null}
      {kind === "mark" ? <Marker shape={shape ?? "circle"} x={7} y={7} r={4.2} color={color} ringWidth={0} /> : null}
      {kind === "warn" ? (
        <>
          <circle cx={7} cy={7} r={5.5} fill="var(--warntint)" stroke="var(--warn)" strokeWidth={1.3} />
          <path d="M5 5L9 9M9 5L5 9" stroke="var(--warn)" strokeWidth={1.4} strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  );
}

/**
 * Легенда рядов набора (.lgd): строкой под графиком, 12 px. Для одного ряда
 * её нет — ряд называет заголовок фигуры; для двух и больше она есть всегда,
 * даже когда ряды подписаны у концов линий.
 */
export function ChartLegend({ items, className, always }: { items: readonly LegendItem[]; className?: string; always?: boolean }) {
  if (items.length < (always ? 1 : 2)) return null;
  return (
    <ul className={cx("m-0 mt-[10px] flex list-none flex-wrap gap-x-[16px] gap-y-[6px] p-0 text-caption leading-[16px] font-semibold text-text-2", className)}>
      {items.map((i) => (
        <li key={i.key} className="flex min-w-0 items-center gap-[6px]">
          <LegendGlyph kind={i.kind} color={i.color} shape={i.shape} />
          <span className="truncate">{i.label}</span>
        </li>
      ))}
    </ul>
  );
}

/* ─────────── скрытая малая ячейка ─────────── */

/**
 * Ячейка, скрытая порогом малых чисел: «n < 5» и объяснение по наведению и
 * фокусу. Не ноль и не прочерк без слов: человек должен понять, что число
 * есть, но его не показывают, — и почему.
 */
export function SmallCell({ floor = 5, className }: { floor?: number; className?: string }) {
  const { ut } = useLang();
  return (
    <span tabIndex={0} className={cx("group/sc relative inline-flex cursor-default rounded-[4px] outline-none focus-visible:outline-2 focus-visible:outline-[var(--focus)]", className)}>
      <span className="font-semibold whitespace-nowrap text-muted">{fillIn(ut("chart.smallCell"), { n: floor })}</span>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute right-0 bottom-[calc(100%+6px)] z-[4] w-[240px] rounded-panel border border-border bg-panel px-[12px] py-[10px] text-left text-small leading-[18px] font-medium whitespace-normal text-text-2 opacity-0 shadow-pop transition-opacity duration-[120ms] group-hover/sc:visible group-hover/sc:opacity-100 group-focus-visible/sc:visible group-focus-visible/sc:opacity-100"
      >
        <b className="block font-extrabold text-text">{ut("kit.hidden")}</b>
        {fillIn(ut("chart.smallCellWhy"), { n: floor })}
      </span>
    </span>
  );
}

/* ─────────── подсказка строки в HTML ─────────── */

/**
 * Подсказка строки-полосы (HBars, BarList, PairBars) — CSS-ом, без
 * состояния: наведение и фокус строки открывают слой над концом полосы.
 * Слой не перехватывает указатель и не сдвигает строки.
 */
export function RowTip({ children, at = 0 }: { children: ReactNode; at?: number }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none invisible absolute bottom-[calc(100%+4px)] z-[4] w-max max-w-[300px] rounded-panel border border-border bg-panel px-[14px] pt-[10px] pb-[11px] text-small text-text-2 opacity-0 shadow-pop transition-opacity duration-[120ms] group-hover/row:visible group-hover/row:opacity-100 group-focus-visible/row:visible group-focus-visible/row:opacity-100"
      style={{ left: `clamp(0px, ${(at * 100).toFixed(1)}%, calc(100% - 300px))` }}
    >
      {children}
    </span>
  );
}

/* ─────────── таблица вместо графика ─────────── */

export interface TableView {
  /** Заголовки колонок; первая — подпись строки */
  head: readonly ReactNode[];
  rows: readonly (readonly ReactNode[])[];
}

/**
 * Таблица того же, что нарисовано: для того, кто читает числа, а не форму,
 * для программы чтения с экрана и для печати на монохромном принтере.
 */
export function DataTable({ table, caption }: { table: TableView; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-small">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {table.head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className={cx(
                  "static h-auto border-b border-divider bg-transparent py-[7px] pr-[14px] pl-0 align-bottom text-caption font-bold tracking-normal normal-case text-muted",
                  i ? "text-right" : "text-left",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, k) => (
            <tr key={k}>
              {r.map((c, i) =>
                i ? (
                  <td key={i} className="h-auto border-b border-divider py-[7px] pr-[14px] pl-0 text-right font-semibold text-text tabular-nums">
                    {c}
                  </td>
                ) : (
                  <th key={i} scope="row" className="h-auto border-b border-divider py-[7px] pr-[14px] pl-0 text-left font-semibold text-text-2">
                    {c}
                  </th>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Переключатель «Діаграма / Таблиця» — сегменты набора (.seg) */
export function ViewSwitch({ table, onTable }: { table: boolean; onTable: (v: boolean) => void }) {
  const { ut } = useLang();
  const btn = (on: boolean) =>
    cx(
      "h-[28px] rounded-[8px] px-[10px] text-caption font-bold transition-colors duration-[120ms]",
      on ? "bg-panel text-violet-ink shadow-tile" : "text-text-2 hover:bg-sunk-2 hover:text-text",
    );
  return (
    <span className="inline-flex gap-[2px] rounded-[10px] bg-sunk p-[3px]">
      <button type="button" aria-pressed={!table} className={btn(!table)} onClick={() => onTable(false)}>
        {ut("chart.viewChart")}
      </button>
      <button type="button" aria-pressed={table} className={btn(table)} onClick={() => onTable(true)}>
        {ut("chart.viewTable")}
      </button>
    </span>
  );
}
