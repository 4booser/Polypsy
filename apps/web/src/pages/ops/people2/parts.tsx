import { useRef, useState, type ReactNode } from "react";
import { ShareBar, type SharePart } from "../../../charts/clinical";
import { useChartWidth } from "../../../charts/index";
import { num } from "../../../charts/ladder";
import { axisFor } from "../../../charts/scale";
import { useLang } from "../../../lang";
import { cx } from "../../../ui/cx";
import { NoData } from "../../../ui/primitives";
import type { StackColumn, StackSeries } from "./model";

/*
 * Общие детали раздела «Люди й безпека»: раздел с линией, флажок строки,
 * загрузка файла из памяти.
 *
 * Раздел — тот же, что в карточке пациента (patientCard/PatientCard.tsx,
 * Section): заголовок 20/700 фиолетовым над линией 2px. Своей копией, а не
 * импортом: там он не экспортирован, и тянуть внутренности карточки в
 * техпанель ради шести строк разметки незачем.
 */

export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("border-t-2 border-primary-rule pb-[16px] pt-[24px]", className)}>
      <div className="mb-[14px] flex min-h-[27px] flex-wrap items-center justify-between gap-x-[24px] gap-y-[8px]">
        <h2 className="m-0 text-[20px] font-bold leading-[24px] text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Флажок строки: квадрат 22 в зоне нажатия 44, отмеченный — заливкой
 * primary внутри, как у выбора людей в группах (patientGroups/PersonGrid.tsx).
 *
 * Размер — с «!»: у наследия стоит `input[type=checkbox] { width: auto }`
 * селектором с атрибутом, и он сильнее одного класса.
 */
export function RowCheck({
  checked,
  mixed,
  onChange,
  label,
}: {
  checked: boolean;
  mixed?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="grid size-[44px] shrink-0 cursor-pointer place-items-center print:hidden">
      <input
        type="checkbox"
        checked={checked}
        aria-checked={mixed ? "mixed" : checked}
        onChange={onChange}
        aria-label={label}
        className={cx(
          "m-0 grid min-h-0 size-[22px]! appearance-none place-items-center rounded-[4px] border-2 border-border bg-[var(--bg)] p-0",
          "before:rounded-[2px] before:content-['']",
          mixed ? "before:h-[3px] before:w-[10px] before:bg-primary" : "before:size-[12px] checked:before:bg-primary",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2",
        )}
      />
    </label>
  );
}

/** Отдать текст файлом — из памяти, без похода на сервер (пароли, отчёт) */
export function saveText(text: string, name: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Строка-сообщение «пусто» — 13 серым, как у остальных списков техпанели */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 py-[16px] text-[13px] text-muted">{children}</p>;
}

/* ═══════════ графики (волна 11) ═══════════ */

/*
 * Формы, которых нет в общем наборе (charts/clinical.tsx): столбцы из
 * нескольких частей и полосы долей строками. Общий набор в этой волне
 * дополняет только участок obs, поэтому они собраны здесь на тех же
 * примитивах — ширина контейнера (useChartWidth), ось от нуля (axisFor),
 * подсказка chart-tip. Понадобятся второму экрану — их место там.
 */

/** Две фигуры рядом с 900 px, одна под другой ниже — как у соседних разделов техпанели */
export const FIGURE_GRID = "grid grid-cols-1 gap-x-[32px] gap-y-[28px] min-[900px]:grid-cols-2";

/**
 * Легенда рядов: квадрат цвета и подпись. Утилитами, а не классами
 * legend/dot из charts/index.tsx: те — наследие «Пульта» (legacy.css), и
 * тащить их в новый код макет запрещает. Один ряд легенды не требует.
 */
export function SeriesLegend({ items }: { items: readonly { key: string; label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="m-0 mt-[8px] flex list-none flex-wrap gap-x-[18px] gap-y-[4px] p-0 text-[13px] leading-[18px]">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-[6px] text-text-2">
          <span aria-hidden className="inline-block size-[8px] shrink-0 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

const SP = { top: 12, right: 8, bottom: 26, left: 40 };

/**
 * Столбцы по времени из нескольких частей: удачные и неудачные входы,
 * персонал и пациенты, разобранное и новое.
 *
 * Части сложены, а не поставлены рядом: вопрос обычно «сколько всего и какая
 * доля — неудачи», и высота столбца отвечает на первое, верхняя часть — на
 * второе. Ось — от нуля до наибольшего столбца (axisFor): у столбца другой
 * высоты нет.
 *
 * Скрытая порогом часть (null) не рисуется вовсе — высота тоже число, — а
 * над столбцом ставится короткая риска цветом подписей оси: «здесь есть,
 * но меньше порога». Ноль вместо неё соврал бы («никого»), пропуск столбца —
 * сжал бы время (то же правило, что у MaybeColumns раздела «Дані й
 * продукт»). В подсказке у скрытой части — слова, а «всего» не печатается:
 * сумма показанных частей выдавала бы себя за целое.
 */
export function StackColumns({
  series,
  columns,
  height = 180,
  label,
}: {
  series: readonly StackSeries[];
  columns: readonly StackColumn[];
  height?: number;
  label: string;
}) {
  const { ut } = useLang();
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  /* всё по нулям — «нет данных» словами, а не пустые оси */
  if (!columns.length || columns.every((c) => c.values.every((v) => v === 0))) return <NoData />;

  const totals = columns.map((c) => c.values.reduce<number>((s, v) => s + (v ?? 0), 0));
  const axis = axisFor({ lo: 0, hi: Math.max(...totals, 0) });
  const pw = Math.max(40, W - SP.left - SP.right);
  const ph = height - SP.top - SP.bottom;
  const slot = pw / columns.length;
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const yAt = (v: number) => SP.top + ph - (v / Math.max(axis.max, 1)) * ph;
  const xAt = (i: number) => SP.left + slot * i + slot / 2;
  /* подписи — не чаще, чем раз в 64 пикселя, и отсчёт от конца: последний столбец — «сейчас» */
  const every = Math.max(1, Math.ceil(64 / slot));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W - SP.left;
    const i = Math.floor(x / slot);
    setHover(i >= 0 && i < columns.length ? i : null);
  };
  const at = hover === null ? null : columns[hover]!;
  const hidden = columns.filter((c) => c.values.some((v) => v === null)).length;

  return (
    <div>
      <div className="chart-wrap" ref={boxRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`${label} (${series.map((s) => s.label).join(", ")}): ${columns[0]!.label} — ${columns.at(-1)!.label}${
            hidden ? `; ${ut("kit.hidden")}: ${hidden}` : ""
          }`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {axis.ticks.map((t) => (
            <g key={t}>
              <line x1={SP.left} x2={W - SP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
              <text x={SP.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
                {num(t)}
              </text>
            </g>
          ))}
          {columns.map((c, i) => {
            let base = 0;
            let cut = false;
            const parts: ReactNode[] = [];
            series.forEach((s, si) => {
              const v = c.values[si] ?? 0;
              if (c.values[si] === null) {
                cut = true;
                return;
              }
              if (v <= 0) return;
              parts.push(
                <rect
                  key={s.key}
                  x={xAt(i) - bw / 2}
                  y={yAt(base + v)}
                  width={bw}
                  height={Math.max(0, yAt(base) - yAt(base + v))}
                  rx={1.5}
                  fill={s.color}
                  fillOpacity={hover === null || hover === i ? 0.85 : 0.4}
                />,
              );
              base += v;
            });
            return (
              <g key={c.key}>
                {parts}
                {cut ? (
                  <line
                    x1={xAt(i) - bw / 2}
                    x2={xAt(i) + bw / 2}
                    y1={yAt(base) - 4}
                    y2={yAt(base) - 4}
                    stroke="var(--axis)"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                ) : null}
              </g>
            );
          })}
          {columns.map((c, i) =>
            (columns.length - 1 - i) % every === 0 ? (
              <text key={c.key} x={xAt(i)} y={height - 8} fontSize="11" fill="var(--axis)" textAnchor="middle">
                {c.label}
              </text>
            ) : null,
          )}
        </svg>
        {at ? (
          <div className="chart-tip" style={{ left: `${((xAt(hover!) / W) * 100).toFixed(2)}%` }} role="status">
            <span className="chart-tip-x">{at.label}</span>
            {series.map((s, si) => (
              <span key={s.key} className="chart-tip-row">
                <i style={{ background: s.color }} />
                {series.length > 1 ? <span className="grow">{s.label}</span> : null}
                {at.values[si] === null ? <span className="text-muted">{ut("kit.hidden")}</span> : <b>{num(at.values[si] ?? 0)}</b>}
              </span>
            ))}
            {series.length > 1 && at.values.every((v) => v !== null) ? (
              <span className="chart-tip-row">
                <span className="grow">{ut("opsp.total")}</span>
                <b>{num(totals[hover!]!)}</b>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <SeriesLegend items={series} />
    </div>
  );
}

export interface ShareRow {
  key: string;
  title: string;
  /** null — целое скрыто порогом: вместо полосы — слова */
  total: number | null;
  parts: SharePart[];
}

/**
 * Полосы долей строками: у каждой строки своё целое (роль, группа) и своя
 * легенда с числами. Строками, а не одной полосой: доля выключенных у
 * суперадминов и у пациентов — разные вопросы, и общая полоса утопила бы
 * троих суперадминов в тысяче пациентов.
 */
export function ShareRows({ rows }: { rows: readonly ShareRow[] }) {
  const { ut } = useLang();
  if (!rows.length) return <NoData />;
  return (
    <ul className="m-0 grid list-none gap-[18px] p-0">
      {rows.map((r) => (
        <li key={r.key} className="min-w-0">
          <div className="mb-[6px] flex items-baseline justify-between gap-[12px]">
            <span className="min-w-0 truncate text-[13px] font-bold leading-[17px] text-text">{r.title}</span>
            <span className="shrink-0 font-mono text-[12px] text-muted tabular-nums">
              {r.total === null ? (
                <>
                  —<span className="sr-only"> {ut("kit.hidden")}</span>
                </>
              ) : (
                num(r.total)
              )}
            </span>
          </div>
          {r.total === null ? (
            <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("kit.hidden")}</p>
          ) : (
            <ShareBar parts={r.parts} label={r.title} />
          )}
        </li>
      ))}
    </ul>
  );
}
