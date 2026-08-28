import React from "react";
import { View } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import { useChart } from "../../theme";
import { Caption, PLOT, formatShort, useMeasuredWidth } from "./primitives";

export { boxStatsOf, type BoxStat } from "./math";
import type { BoxStat } from "./math";
import { useLang } from "@/lang";

/**
 * Ящик с усами: разброс, а не только среднее.
 *
 * Среднее прячет форму распределения — две шкалы с одинаковым средним могут
 * вести себя совершенно по-разному. Здесь видно медиану, межквартильный размах
 * и края.
 */
export function BoxPlot({
  boxes,
  height = 190,
  /**
   * По умолчанию все ящики одного цвета: это одна и та же величина, измеренная
   * у разных объектов, а не разные сущности. Разные оттенки здесь означали бы
   * различие в идентичности, которого нет.
   */
  categorical = false,
}: {
  boxes: BoxStat[];
  height?: number;
  categorical?: boolean;
}) {
  const { ut } = useLang();
  const chart = useChart();
  const [width, onLayout] = useMeasuredWidth();

  if (boxes.length === 0) return <Caption>{ut("mviz.noData")}</Caption>;

  const top = Math.max(...boxes.map((b) => b.max), 1);
  const plotH = height - PLOT.padTop - PLOT.padBottom;
  const plotW = Math.max(40, width - PLOT.padLeft - PLOT.padRight);
  const yAt = (v: number) => PLOT.padTop + plotH - (v / top) * plotH;
  const slot = plotW / boxes.length;
  const boxW = Math.min(38, slot * 0.5);

  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={height}>
        {[0, top / 2, top].map((t) => (
          <React.Fragment key={t}>
            <Line
              x1={PLOT.padLeft}
              x2={PLOT.padLeft + plotW}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke={chart.grid}
              strokeWidth={1}
            />
            <SvgText x={PLOT.padLeft - 6} y={yAt(t) + 4} fontSize={10} fill={chart.axis} textAnchor="end">
              {formatShort(t)}
            </SvgText>
          </React.Fragment>
        ))}

        {boxes.map((b, i) => {
          const cx = PLOT.padLeft + slot * i + slot / 2;
          return (
            <React.Fragment key={b.label}>
              <Line x1={cx} x2={cx} y1={yAt(b.max)} y2={yAt(b.q3)} stroke={chart.axis} strokeWidth={1} />
              <Line x1={cx} x2={cx} y1={yAt(b.q1)} y2={yAt(b.min)} stroke={chart.axis} strokeWidth={1} />
              <Line x1={cx - 8} x2={cx + 8} y1={yAt(b.max)} y2={yAt(b.max)} stroke={chart.axis} strokeWidth={1} />
              <Line x1={cx - 8} x2={cx + 8} y1={yAt(b.min)} y2={yAt(b.min)} stroke={chart.axis} strokeWidth={1} />
              <Rect
                x={cx - boxW / 2}
                y={yAt(b.q3)}
                width={boxW}
                height={Math.max(2, yAt(b.q1) - yAt(b.q3))}
                fill={categorical ? chart.series[i % chart.series.length] : chart.bar}
                fillOpacity={0.25}
                stroke={categorical ? chart.series[i % chart.series.length] : chart.bar}
                strokeWidth={2}
                rx={3}
              />
              <Line
                x1={cx - boxW / 2}
                x2={cx + boxW / 2}
                y1={yAt(b.median)}
                y2={yAt(b.median)}
                stroke={categorical ? chart.series[i % chart.series.length] : chart.bar}
                strokeWidth={3}
              />
              <SvgText x={cx} y={height - 6} fontSize={10} fill={chart.axis} textAnchor="middle">
                {b.label.length > 10 ? `${b.label.slice(0, 9)}…` : b.label}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
      <Caption>{ut("mviz.boxHint")}</Caption>
    </View>
  );
}
