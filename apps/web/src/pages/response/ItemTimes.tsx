import { useRef } from "react";
import { quantile } from "@quizzy/shared";
import { useChartWidth } from "../../charts/index";
import { ChartTip, FOCUSABLE, OTHER_COLOR, SINGLE_COLOR, TipHead, TipRow, TipText, useDecimal, useIndexHover } from "../../charts/kit";
import { axisFor } from "../../charts/scale";
import { cx } from "../../ui/cx";

/**
 * Время на каждый пункт одного прохождения: столбец на пункт, порог
 * «слишком быстро» пунктиром, быстрые столбцы — полыми.
 *
 * Сестра TimeColumns из charts/clinical.tsx, а не она сама: той нечем
 * выделить отдельный столбец и нечем провести порог — она отвечает на
 * вопрос «сколько за день», где все корзины равны. Здесь вопрос другой —
 * «какие пункты прочитаны слишком быстро и где человек думал дольше», — и
 * ответ на него должен быть виден формой. Раскладка, сетка, подсказка
 * (`ChartTip` набора графиков) и подписи — те же, что у TimeColumns.
 *
 * Цвет — по смыслу, а не по ряду: столбцы пунктов, где ответ меняли, —
 * цветом ряда (`--series`), прочие — нейтральным `--c5`: смотрящий ищет
 * пункт, над которым думали, и находит его глазом. Быстрый столбец — полый
 * (контур и бледная заливка), а не другого цвета: янтарь значит «требует
 * внимания», а быстрый ответ — повод посмотреть, не тревога; и форма, в
 * отличие от оттенка, переживает печать и дальтонизм.
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
  /** Ответ на пункте меняли — столбец цветом ряда */
  changed?: boolean;
}

const P = { top: 18, right: 8, bottom: 24, left: 34 };

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
  const p90 = quantile(
    values.filter((v) => v > 0),
    0.9,
  );
  if (p90 === null) return max;
  const cap = Math.max(p90 * 1.5, threshold * 2);
  return max > Math.max(p90 * 3, threshold * 3) ? cap : max;
}

/** Столбец со скруглением 4 px у конца данных и прямым углом у основания */
function colPath(x: number, w: number, y: number, base: number): string {
  const h = Math.max(0, base - y);
  const r = Math.min(4, h, w / 2);
  const f = (v: number) => v.toFixed(1);
  return `M${f(x)} ${f(base)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(base)}Z`;
}

export function ItemTimes({
  columns,
  threshold,
  label,
  thresholdLabel,
  fastLabel,
  aboveLabel,
  changedLabel,
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
  /** «Відповідь змінювали» — в подсказке столбца со сменой ответа */
  changedLabel?: string;
  /** «с» */
  unit: string;
  height?: number;
}) {
  const [W, boxRef] = useChartWidth(320);
  const svgRef = useRef<SVGSVGElement>(null);
  const dec = useDecimal();
  const hover = useIndexHover(columns.length);
  if (!columns.length) return null;

  const axis = axisFor({ lo: 0, hi: itemAxisTop(columns.map((c) => c.value), threshold) });
  const top = Math.max(axis.max, Number.EPSILON);
  const pw = Math.max(40, W - P.left - P.right);
  const ph = height - P.top - P.bottom;
  const slot = pw / columns.length;
  const bw = Math.max(2, Math.min(24, slot * 0.56));
  const yAt = (v: number) => P.top + ph - (Math.min(v, top) / top) * ph;
  const xAt = (i: number) => P.left + slot * i + slot / 2;
  /* номера короткие: подпись не чаще раза в 24 пикселя, считая от первого пункта */
  const every = Math.max(1, Math.ceil(24 / slot));
  const printValues = columns.length <= 16 && slot >= 22;
  const ty = yAt(threshold);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    const x = ((e.clientX - box.left) / box.width) * W - P.left;
    const i = Math.floor(x / slot);
    hover.setAt(i >= 0 && i < columns.length ? i : null);
  };
  const at = hover.at === null ? null : columns[hover.at]!;

  return (
    <div className="relative min-w-0" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${columns[0]!.title} — ${columns.at(-1)!.title}`}
        className={cx("block overflow-visible", FOCUSABLE)}
        onMouseMove={onMove}
        {...hover.focusProps}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={P.left} x2={W - P.right} y1={yAt(t)} y2={yAt(t)} stroke={t === 0 ? "var(--ctl)" : "var(--grid)"} />
            <text x={P.left - 8} y={yAt(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
              {dec(t)}
            </text>
          </g>
        ))}

        {columns.map((c, i) => {
          const y = yAt(c.value);
          const cut = c.value > top;
          const color = c.changed ? SINGLE_COLOR : OTHER_COLOR;
          const dim = hover.at !== null && hover.at !== i;
          return (
            <g key={c.key} opacity={dim ? 0.5 : 1} data-col={i}>
              <path
                d={colPath(xAt(i) - bw / 2, bw, y, yAt(0))}
                fill={color}
                fillOpacity={c.fast ? 0.16 : 1}
                stroke={c.fast ? color : "none"}
                strokeWidth={c.fast ? 1.25 : 0}
              />
              {/* засечка разрыва: столбец выше края оси */}
              {cut ? (
                <g stroke="var(--panel)" strokeWidth={1.5}>
                  <line x1={xAt(i) - bw / 2 - 1} x2={xAt(i) + bw / 2 + 1} y1={y + 5} y2={y + 2} />
                  <line x1={xAt(i) - bw / 2 - 1} x2={xAt(i) + bw / 2 + 1} y1={y + 9} y2={y + 6} />
                </g>
              ) : null}
              {printValues ? (
                <text x={xAt(i)} y={y - 6} fontSize={12} fontWeight={800} fill="var(--text)" textAnchor="middle">
                  {dec(c.value, 0)}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* порог — пунктир, как пороги полос: это граница, а не данные; подпись — в легенде под графиком */}
        <line x1={P.left} x2={W - P.right} y1={ty} y2={ty} stroke="var(--axis)" strokeOpacity={0.8} strokeDasharray="3 4">
          {/* одной строкой: несколько узлов в <title> React не собирает в текст подсказки */}
          <title>{`${thresholdLabel} ${dec(threshold)} ${unit}`}</title>
        </line>

        {columns.map((c, i) =>
          i % every === 0 ? (
            <text key={c.key} x={xAt(i)} y={height - 7} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="middle">
              {c.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <ChartTip x={xAt(hover.at!)} y={yAt(at.value)} width={W}>
          <TipHead>{at.title}</TipHead>
          <TipRow kind="box" color={at.changed ? SINGLE_COLOR : OTHER_COLOR} value={`${dec(at.value)} ${unit}`} />
          {at.changed && changedLabel ? <TipText>{changedLabel}</TipText> : null}
          {at.fast ? <TipText muted>{fastLabel}</TipText> : null}
          {at.value > top ? <TipText muted>{aboveLabel}</TipText> : null}
        </ChartTip>
      ) : null}
    </div>
  );
}
