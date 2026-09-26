import { useRef, useState } from "react";
import { quantile } from "@quizzy/shared";
import { useChartWidth } from "../../charts/index";
import { num } from "../../charts/ladder";
import { axisFor } from "../../charts/scale";

/**
 * Время на каждый пункт одного прохождения: столбец на пункт, порог
 * «слишком быстро» пунктиром, быстрые столбцы — полыми.
 *
 * Сестра TimeColumns из charts/clinical.tsx, а не она сама: той нечем
 * выделить отдельный столбец и нечем провести порог — она отвечает на
 * вопрос «сколько за день», где все корзины равны. Здесь вопрос другой —
 * «какие пункты прочитаны слишком быстро», — и ответ на него должен быть
 * виден формой. Раскладка, сетка, подсказка и подписи — те же, что у
 * TimeColumns, чтобы на экране это читалось одной семьёй. Если форма
 * понадобится второму экрану, её место — в clinical.tsx рядом с сестрой.
 *
 * Быстрый столбец — полый (контур и бледная заливка), а не другого цвета:
 * янтарь значит «требует внимания», а быстрый ответ — повод посмотреть, не
 * тревога; и форма, в отличие от оттенка, переживает печать и дальтонизм.
 *
 * Ось обрезается, когда один-два пункта в разы дольше остальных: человек
 * отвлёкся на десять минут — и без обрезки все прочие столбцы легли бы
 * плоской полосой у нуля, а порог в полторы секунды слился бы с осью. Такой
 * столбец упирается в край и несёт засечку разрыва, а настоящее число — в
 * подсказке: обрезка видна, а не спрятана.
 */

export interface ItemColumn {
  key: string;
  /** Подпись под столбцом: номер пункта */
  label: string;
  /** Подпись в подсказке: «№5» */
  title: string;
  /** Секунды */
  value: number;
  /** Быстрее порога */
  fast: boolean;
}

const P = { top: 14, right: 8, bottom: 26, left: 40 };

/**
 * Верх оси: по данным, но без выбросов.
 *
 * Выброс — больше трёх девяностых перцентилей (и трёх порогов): тогда ось
 * кончается на полутора перцентилях, но не ниже двух порогов, чтобы порог
 * оставался внутри поля с запасом. Меньше пяти пунктов — не обрезается:
 * перцентиль из трёх чисел ничего не значит.
 */
export function itemAxisTop(values: readonly number[], threshold: number): number {
  const max = Math.max(0, threshold, ...values);
  if (values.length < 5) return max;
  const p90 = quantile(values.filter((v) => v > 0), 0.9);
  if (p90 === null) return max;
  const cap = Math.max(p90 * 1.5, threshold * 2);
  return max > Math.max(p90 * 3, threshold * 3) ? cap : max;
}

export function ItemTimes({
  columns,
  threshold,
  label,
  thresholdLabel,
  fastLabel,
  aboveLabel,
  unit,
  height = 200,
}: {
  columns: readonly ItemColumn[];
  /** Порог «слишком быстро», секунды */
  threshold: number;
  label: string;
  /** «поріг» */
  thresholdLabel: string;
  /** «Швидше за поріг» — в подсказке быстрого столбца */
  fastLabel: string;
  /** «вище за край осі» — в подсказке обрезанного столбца */
  aboveLabel: string;
  /** «с» */
  unit: string;
  height?: number;
}) {
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (!columns.length) return null;

  const axis = axisFor({ lo: 0, hi: itemAxisTop(columns.map((c) => c.value), threshold) });
  const top = Math.max(axis.max, Number.EPSILON);
  const pw = Math.max(40, W - P.left - P.right);
  const ph = height - P.top - P.bottom;
  const slot = pw / columns.length;
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const yAt = (v: number) => P.top + ph - (Math.min(v, top) / top) * ph;
  const xAt = (i: number) => P.left + slot * i + slot / 2;
  /* номера короткие: подпись не чаще раза в 28 пикселей, считая от первого пункта */
  const every = Math.max(1, Math.ceil(28 / slot));
  const ty = yAt(threshold);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    const x = ((e.clientX - box.left) / box.width) * W - P.left;
    const i = Math.floor(x / slot);
    setHover(i >= 0 && i < columns.length ? i : null);
  };
  const at = hover === null ? null : columns[hover]!;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${columns[0]!.title} — ${columns.at(-1)!.title}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={P.left} x2={W - P.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={P.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(t)}
            </text>
          </g>
        ))}

        {columns.map((c, i) => {
          const y = yAt(c.value);
          const h = Math.max(0, yAt(0) - y);
          const cut = c.value > top;
          const dim = hover !== null && hover !== i;
          return (
            <g key={c.key} opacity={dim ? 0.45 : 1}>
              <rect
                x={xAt(i) - bw / 2}
                y={y}
                width={bw}
                height={h}
                rx={2}
                fill="var(--primary)"
                fillOpacity={c.fast ? 0.14 : 0.85}
                stroke={c.fast ? "var(--primary)" : "none"}
                strokeWidth={c.fast ? 1.25 : 0}
              />
              {/* засечка разрыва: столбец выше края оси */}
              {cut ? (
                <g stroke="var(--card)" strokeWidth={1.5}>
                  <line x1={xAt(i) - bw / 2 - 1} x2={xAt(i) + bw / 2 + 1} y1={y + 5} y2={y + 2} />
                  <line x1={xAt(i) - bw / 2 - 1} x2={xAt(i) + bw / 2 + 1} y1={y + 9} y2={y + 6} />
                </g>
              ) : null}
            </g>
          );
        })}

        {/* порог — пунктир, как пороги полос в BandTrend: это граница, а не данные */}
        <line x1={P.left} x2={W - P.right} y1={ty} y2={ty} stroke="var(--axis)" strokeOpacity={0.7} strokeDasharray="3 4" />
        <text x={W - P.right} y={ty - 4} fontSize="10" fill="var(--axis)" textAnchor="end">
          {thresholdLabel} {num(threshold)} {unit}
        </text>

        <line x1={P.left} x2={W - P.right} y1={yAt(0)} y2={yAt(0)} stroke="var(--grid)" />
        {columns.map((c, i) =>
          i % every === 0 ? (
            <text key={c.key} x={xAt(i)} y={height - 8} fontSize="11" fill="var(--axis)" textAnchor="middle" fontFamily="var(--font-mono)">
              {c.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <div className="chart-tip" style={{ left: `${((xAt(hover!) / W) * 100).toFixed(2)}%` }} role="status">
          <span className="chart-tip-x">{at.title}</span>
          <span className="chart-tip-row">
            <b>
              {num(at.value)} {unit}
            </b>
          </span>
          {at.fast ? <span className="text-[11px] text-muted">{fastLabel}</span> : null}
          {at.value > top ? <span className="text-[11px] text-muted">{aboveLabel}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
