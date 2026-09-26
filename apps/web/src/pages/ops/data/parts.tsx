import { useRef, useState, type ReactNode } from "react";
import type { DataCheck } from "@quizzy/shared";
import { useChartWidth } from "../../../charts/index";
import { num } from "../../../charts/ladder";
import { axisFor } from "../../../charts/scale";
import { useLang } from "../../../lang";
import { cx } from "../../../ui/cx";
import { NoData, Tag } from "../../../ui/primitives";
import { PeriodSwitch } from "../../dashboard/parts";
import { LEVEL_LABEL, WINDOWS, WINDOW_LABEL, type MaybeColumn, type Window } from "./model";

/*
 * Общие куски четырёх разделов «Дані й продукт».
 *
 * Ячейки таблиц — те же утилиты, что у таблиц качества методики
 * (components/DataQualityPanel.tsx): техпанель — тот же лист консоли, и
 * таблица на ней не должна выглядеть вставкой из другого приложения.
 */
export const TH =
  "border-b border-hairline py-[8px] pr-[16px] text-left align-bottom text-[13px] font-bold leading-[16px] text-muted";
export const TD = "border-b border-hairline py-[8px] pr-[16px] align-top text-[13px] leading-[18px] text-text-2";
export const NUM = "text-right font-mono tabular-nums";

/** Сетка плиток: складывается в столбец на узком экране сама — minmax от 200 */
export const KPI_GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-[16px]";
/** Две фигуры рядом с 900 px, одна под другой ниже */
export const PAIR_GRID = "grid grid-cols-1 gap-x-[32px] gap-y-[24px] min-[900px]:grid-cols-2";

/** Пояснение под фигурой или таблицей: 13 серым, как подпись фигуры */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("m-0 mt-[10px] max-w-[760px] text-[13px] leading-[18px] text-muted", className)}>{children}</p>;
}

/** Переключатель окна 7 / 30 / 90 дней — та же кнопка-группа, что у «Зведення» */
export function WindowSwitch({ value, onChange }: { value: Window; onChange: (w: Window) => void }) {
  const { ut } = useLang();
  return (
    <PeriodSwitch
      label={ut("dash.rangeLabel")}
      value={String(value) as `${Window}`}
      onChange={(v) => onChange(Number(v) as Window)}
      options={WINDOWS.map((w) => [String(w) as `${Window}`, ut(WINDOW_LABEL[w])] as const)}
    />
  );
}

/**
 * Уровень проверки — словом в метке, не цветом.
 *
 * «Помилка» — красной рамкой danger (данные уже врут), «Попередження» —
 * янтарём: это ровно «требует внимания», для чего янтарь и заведён; «До
 * відома» — нейтральной меткой. Цвет здесь второе, слово — первое: метка
 * читается и в печати, и тем, кто цветов не различает.
 */
export function LevelTag({ level }: { level: DataCheck["level"] }) {
  const { ut } = useLang();
  const tone = level === "error" ? "danger" : level === "warning" ? "attention" : "plain";
  return <Tag tone={tone}>{ut(LEVEL_LABEL[level])}</Tag>;
}

const CP = { top: 12, right: 8, bottom: 26, left: 40 };

/**
 * Столбцы по дням, где день бывает скрыт порогом малых ячеек.
 *
 * TimeColumns (charts/clinical.tsx) скрытого не знает — у него value: number.
 * Нарисовать скрытый день нулём нельзя: ноль — это «никого», а скрытый день —
 * «кто-то был, но меньше порога»; подменить одно другим значит соврать
 * (docs/ARCHITECTURE.md: невычислимое — null, а не ноль). Выпустить день из
 * ряда тоже нельзя — время сожмётся. Поэтому своя форма той же геометрии:
 * скрытый день — короткая черта у оси цветом подписей оси, в подсказке —
 * «приховано». Высоты у черты нет: высота столбца — тоже число.
 *
 * Общий набор графиков не правится (его держит координатор); если форма
 * понадобится второму экрану — её место там.
 */
export function MaybeColumns({ columns, height = 200, label }: { columns: readonly MaybeColumn[]; height?: number; label: string }) {
  const { ut } = useLang();
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (!columns.length) return <NoData />;

  const axis = axisFor({ lo: 0, hi: Math.max(...columns.map((c) => c.value ?? 0), 0) });
  const pw = Math.max(40, W - CP.left - CP.right);
  const ph = height - CP.top - CP.bottom;
  const slot = pw / columns.length;
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const yAt = (v: number) => CP.top + ph - (v / Math.max(axis.max, 1)) * ph;
  const xAt = (i: number) => CP.left + slot * i + slot / 2;
  const every = Math.max(1, Math.ceil(64 / slot));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W - CP.left;
    const i = Math.floor(x / slot);
    setHover(i >= 0 && i < columns.length ? i : null);
  };
  const at = hover === null ? null : columns[hover]!;
  const hidden = columns.filter((c) => c.value === null).length;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${columns[0]!.label} — ${columns.at(-1)!.label}${hidden ? `; ${ut("kit.hidden")}: ${hidden}` : ""}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={CP.left} x2={W - CP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={CP.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) =>
          c.value === null ? (
            <line
              key={c.key}
              x1={xAt(i) - bw / 2}
              x2={xAt(i) + bw / 2}
              y1={yAt(0) - 3}
              y2={yAt(0) - 3}
              stroke="var(--axis)"
              strokeWidth={2}
              strokeLinecap="round"
            />
          ) : (
            <rect
              key={c.key}
              x={xAt(i) - bw / 2}
              y={yAt(c.value)}
              width={bw}
              height={Math.max(0, yAt(0) - yAt(c.value))}
              rx={2}
              fill="var(--primary)"
              fillOpacity={hover === null || hover === i ? 0.85 : 0.4}
            />
          ),
        )}
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
          <span className="chart-tip-row">{at.value === null ? ut("kit.hidden") : <b>{num(at.value)}</b>}</span>
        </div>
      ) : null}
    </div>
  );
}
