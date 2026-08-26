import React from "react";
import { View } from "react-native";
import Svg, { Rect, Text as SvgText } from "react-native-svg";
import { useChart, useColors } from "../../theme";
import { Caption, useMeasuredWidth } from "./primitives";

export interface HeatRow {
  label: string;
  cells: { label: string; value: number }[];
}

/**
 * Тепловая карта «вопрос × вариант ответа».
 *
 * Одноцветная последовательная шкала: величина кодируется насыщенностью, а не
 * оттенком — радуга на числовой величине читается неверно. Значение
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
  const chart = useChart();
  const c = useColors();
  const [width, onLayout] = useMeasuredWidth();

  if (rows.length === 0) return <Caption>Данных пока нет</Caption>;

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
            fontSize={9}
            fill={chart.axis}
            textAnchor="middle"
          >
            {col.length > 9 ? `${col.slice(0, 8)}…` : col}
          </SvgText>
        ))}

        {rows.map((row, ri) => (
          <React.Fragment key={row.label}>
            <SvgText x={0} y={headerH + ri * rowH + rowH / 2 + 4} fontSize={11} fill={c.text}>
              {row.label.length > 22 ? `${row.label.slice(0, 21)}…` : row.label}
            </SvgText>
            {row.cells.map((cell, ci) => {
              const intensity = max > 0 ? cell.value / max : 0;
              return (
                <React.Fragment key={ci}>
                  <Rect
                    x={labelW + cellW * ci + 1}
                    y={headerH + ri * rowH + 1}
                    width={cellW - 2}
                    height={rowH - 2}
                    rx={3}
                    fill={chart.series[0]}
                    fillOpacity={0.1 + intensity * 0.75}
                  />
                  <SvgText
                    x={labelW + cellW * ci + cellW / 2}
                    y={headerH + ri * rowH + rowH / 2 + 4}
                    fontSize={10}
                    fontWeight={intensity > 0.6 ? "700" : "400"}
                    fill={intensity > 0.55 ? "#ffffff" : c.text}
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
      <Caption>Насыщенность кодирует величину; значение продублировано числом</Caption>
    </View>
  );
}
