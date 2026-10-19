import React from "react";
import { View } from "react-native";
import Svg, { Rect, Text as SvgText } from "react-native-svg";
import { useChart, useColors } from "../../theme";
import { Caption, heatStep, svgFont, useAxisText, useMeasuredWidth } from "./primitives";
import { useLang } from "@/lang";

export interface HeatRow {
  label: string;
  cells: { label: string; value: number }[];
}

/**
 * Тепловая карта «вопрос × вариант ответа».
 *
 * Одноцветная последовательная шкала: величина кодируется насыщенностью, а не
 * оттенком — радуга на числовой величине читается неверно. Ступени — тепловая
 * лестница набора h1…h5 с текстом, подобранным под каждую. Значение
 * подписывается в ячейке, чтобы карта работала и при слабом различении цвета.
 */
export function Heatmap({
  rows,
  columns,
  height,
  unit = "%",
}: {
  rows: HeatRow[];
  columns: string[];
  height?: number;
  unit?: string;
}) {
  const { ut } = useLang();
  const chart = useChart();
  const c = useColors();
  const axis = useAxisText();
  const [width, onLayout] = useMeasuredWidth();

  if (rows.length === 0) return <Caption>{ut("mviz.noData")}</Caption>;

  const labelW = Math.min(140, width * 0.38);
  const headerH = 30;
  const rowH = 30;
  const gridW = Math.max(40, width - labelW);
  const cellW = gridW / Math.max(1, columns.length);
  const totalH = height ?? headerH + rows.length * rowH + 6;
  const max = Math.max(...rows.flatMap((r) => r.cells.map((x) => x.value)), 1);

  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={totalH}>
        {columns.map((col, i) => (
          <SvgText
            key={`h${i}`}
            x={labelW + cellW * i + cellW / 2}
            y={18}
            {...axis}
            fontSize={10}
            textAnchor="middle"
          >
            {col.length > 9 ? `${col.slice(0, 8)}…` : col}
          </SvgText>
        ))}

        {rows.map((row, ri) => (
          <React.Fragment key={row.label}>
            <SvgText x={0} y={headerH + ri * rowH + rowH / 2 + 4} fontSize={12} fill={c.text} {...svgFont(600)}>
              {row.label.length > 22 ? `${row.label.slice(0, 21)}…` : row.label}
            </SvgText>
            {row.cells.map((cell, ci) => {
              const step = heatStep(max > 0 ? cell.value / max : 0);
              return (
                <React.Fragment key={ci}>
                  <Rect
                    x={labelW + cellW * ci + 1}
                    y={headerH + ri * rowH + 1}
                    width={cellW - 2}
                    height={rowH - 2}
                    rx={4}
                    fill={chart.heat[step]}
                  />
                  <SvgText
                    x={labelW + cellW * ci + cellW / 2}
                    y={headerH + ri * rowH + rowH / 2 + 4}
                    fontSize={11}
                    {...svgFont(step >= 3 ? 800 : 600)}
                    fill={chart.heatInk[step]}
                    textAnchor="middle"
                  >
                    {Math.round(cell.value)}
                    {unit}
                  </SvgText>
                </React.Fragment>
              );
            })}
          </React.Fragment>
        ))}
      </Svg>
      <Caption>{ut("mviz.heatHint")}</Caption>
    </View>
  );
}
