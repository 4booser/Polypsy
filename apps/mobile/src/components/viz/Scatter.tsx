import React from "react";
import { View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { severityColor, useChart, useColors } from "../../theme";
import { Caption, Legend, PLOT, formatShort, niceTicks, useMeasuredWidth } from "./primitives";

export interface ScatterPoint {
  x: number;
  y: number;
  label?: string;
  flagged?: boolean;
}

/**
 * Диаграмма рассеяния: время прохождения против итогового балла.
 *
 * Нужна, чтобы увидеть небрежное заполнение глазами: точки, прижатые к левому
 * краю, — это люди, прошедшие методику быстрее, чем её физически можно прочесть.
 * Помеченные точки выделены цветом И формой (обводкой), а не только цветом.
 */
export function Scatter({
  points,
  xLabel,
  yLabel,
  height = 220,
  xThreshold,
}: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  height?: number;
  /** Вертикальная отсечка — например минимально правдоподобное время */
  xThreshold?: number;
}) {
  const chart = useChart();
  const c = useColors();
  const [width, onLayout] = useMeasuredWidth();

  if (points.length === 0) return <Caption>Данных пока нет</Caption>;

  const xMax = Math.max(...points.map((p) => p.x), xThreshold ?? 0, 1);
  const yMax = Math.max(...points.map((p) => p.y), 1);
  const xTicks = niceTicks(xMax, 3);
  const yTicks = niceTicks(yMax, 3);
  const plotW = Math.max(40, width - PLOT.padLeft - PLOT.padRight);
  const plotH = height - PLOT.padTop - PLOT.padBottom - 10;
  const xAt = (v: number) => PLOT.padLeft + (v / Math.max(...xTicks, xMax)) * plotW;
  const yAt = (v: number) => PLOT.padTop + plotH - (v / Math.max(...yTicks, yMax)) * plotH;

  const flagged = points.filter((p) => p.flagged).length;

  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={height}>
        {yTicks.map((t) => (
          <React.Fragment key={`y${t}`}>
            <Line x1={PLOT.padLeft} x2={PLOT.padLeft + plotW} y1={yAt(t)} y2={yAt(t)} stroke={chart.grid} strokeWidth={1} />
            <SvgText x={PLOT.padLeft - 6} y={yAt(t) + 4} fontSize={10} fill={chart.axis} textAnchor="end">
              {formatShort(t)}
            </SvgText>
          </React.Fragment>
        ))}
        {xTicks.map((t) => (
          <SvgText key={`x${t}`} x={xAt(t)} y={height - 12} fontSize={10} fill={chart.axis} textAnchor="middle">
            {formatShort(t)}
          </SvgText>
        ))}

        {xThreshold !== undefined ? (
          <>
            <Line
              x1={xAt(xThreshold)}
              x2={xAt(xThreshold)}
              y1={PLOT.padTop}
              y2={PLOT.padTop + plotH}
              stroke={severityColor.severe}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <SvgText x={xAt(xThreshold) + 4} y={PLOT.padTop + 10} fontSize={9} fill={severityColor.severe}>
              порог
            </SvgText>
          </>
        ) : null}

        {points.map((p, i) => (
          <Circle
            key={i}
            cx={xAt(p.x)}
            cy={yAt(p.y)}
            r={p.flagged ? 6 : 4}
            fill={p.flagged ? severityColor.severe : chart.series[0]}
            fillOpacity={p.flagged ? 0.9 : 0.55}
            stroke={p.flagged ? c.card : "none"}
            strokeWidth={p.flagged ? 2 : 0}
          />
        ))}

        <SvgText x={PLOT.padLeft} y={height - 1} fontSize={10} fill={chart.axis}>
          {xLabel}
        </SvgText>
        <SvgText x={PLOT.padLeft - 6} y={PLOT.padTop - 2} fontSize={10} fill={chart.axis} textAnchor="end">
          {yLabel}
        </SvgText>
      </Svg>
      <Legend
        items={
          flagged
            ? [
                { label: "обычные", color: chart.series[0]! },
                { label: `помечены как небрежные (${flagged})`, color: severityColor.severe },
              ]
            : []
        }
      />
    </View>
  );
}
