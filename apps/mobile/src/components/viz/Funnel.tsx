import React from "react";
import { View } from "react-native";
import Svg, { Path, Text as SvgText } from "react-native-svg";
import { severityColor, useChart, useColors } from "../../theme";
import { Caption, useMeasuredWidth } from "./primitives";

export interface FunnelStage {
  label: string;
  value: number;
  lost: number;
}

/**
 * Воронка прохождения: сколько респондентов дошло до каждого вопроса.
 *
 * Форма трапеции показывает потерю нагляднее столбиков — сужение и есть отвал.
 * Шаги с заметной потерей подписаны отдельно.
 */
export function Funnel({ stages, height }: { stages: FunnelStage[]; height?: number }) {
  const chart = useChart();
  const c = useColors();
  const [width, onLayout] = useMeasuredWidth();

  if (stages.length === 0) return <Caption>Данных пока нет</Caption>;

  const rowH = 34;
  const labelW = Math.min(150, width * 0.42);
  const plotW = Math.max(40, width - labelW - 40);
  const totalH = height ?? stages.length * rowH + 10;
  const max = Math.max(...stages.map((s) => s.value), 1);
  const halfAt = (v: number) => (v / max) * (plotW / 2);
  const cx = labelW + plotW / 2;

  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={totalH}>
        {stages.map((s, i) => {
          const next = stages[i + 1] ?? s;
          const y0 = i * rowH + 4;
          const y1 = y0 + rowH - 6;
          const h0 = halfAt(s.value);
          const h1 = halfAt(next.value);
          const lostShare = s.value > 0 ? s.lost / (s.value + s.lost) : 0;
          return (
            <React.Fragment key={s.label}>
              <SvgText x={0} y={y0 + 18} fontSize={11} fill={c.text}>
                {s.label.length > 22 ? `${s.label.slice(0, 21)}…` : s.label}
              </SvgText>
              <Path
                d={`M${cx - h0},${y0} L${cx + h0},${y0} L${cx + h1},${y1} L${cx - h1},${y1} Z`}
                fill={chart.series[0]}
                fillOpacity={0.75}
              />
              <SvgText x={width - 2} y={y0 + 18} fontSize={11} fill={c.muted} textAnchor="end">
                {s.value}
              </SvgText>
              {s.lost > 0 ? (
                <SvgText
                  x={cx}
                  y={y1 + 1}
                  fontSize={9}
                  fill={lostShare > 0.15 ? severityColor.severe : c.muted}
                  textAnchor="middle"
                >
                  −{s.lost}
                </SvgText>
              ) : null}
            </React.Fragment>
          );
        })}
      </Svg>
      <Caption>Сужение показывает, на каком вопросе респонденты прекращают прохождение</Caption>
    </View>
  );
}
