import React from "react";
import { View } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import { severityColor, useChart, useColors } from "../../theme";
import { Caption, useMeasuredWidth } from "./primitives";
import { useLang } from "@/lang";

export interface DivergingItem {
  label: string;
  value: number;
}

/**
 * Двусторонние столбики для величин со знаком — например корреляций пункта
 * со шкалой.
 *
 * Нулевая линия по центру: направление здесь и есть содержание. Полюса разными
 * цветами, потому что «хорошо» и «плохо» тут противоположны по смыслу, а не
 * просто разные категории.
 */
export function DivergingBar({
  items,
  domain = 1,
  goodThreshold,
  height,
}: {
  items: DivergingItem[];
  /** Максимум по модулю */
  domain?: number;
  /** Ниже этого значения пункт считается слабым */
  goodThreshold?: number;
  height?: number;
}) {
  const { ut } = useLang();
  const chart = useChart();
  const c = useColors();
  const [width, onLayout] = useMeasuredWidth();

  if (items.length === 0) return <Caption>{ut("mviz.noData")}</Caption>;

  const rowH = 34;
  const labelW = Math.min(150, width * 0.42);
  const plotW = Math.max(40, width - labelW - 34);
  const zero = labelW + plotW / 2;
  const totalH = height ?? items.length * rowH + 14;
  const xAt = (v: number) => zero + (Math.max(-domain, Math.min(domain, v)) / domain) * (plotW / 2);

  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={totalH}>
        <Line x1={zero} x2={zero} y1={0} y2={items.length * rowH} stroke={chart.axis} strokeWidth={1} />

        {items.map((it, i) => {
          const weak = goodThreshold !== undefined && it.value < goodThreshold;
          const color = it.value < 0 ? severityColor.severe : weak ? severityColor.mild : chart.series[0]!;
          const x = xAt(it.value);
          const y = i * rowH + 9;
          return (
            <React.Fragment key={it.label}>
              <SvgText x={0} y={y + 11} fontSize={11} fill={c.text}>
                {it.label.length > 24 ? `${it.label.slice(0, 23)}…` : it.label}
              </SvgText>
              <Rect
                x={Math.min(zero, x)}
                y={y}
                width={Math.max(2, Math.abs(x - zero))}
                height={14}
                rx={3}
                fill={color}
              />
              <SvgText
                x={width - 2}
                y={y + 11}
                fontSize={11}
                fill={c.muted}
                textAnchor="end"
              >
                {it.value.toFixed(2)}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
      {goodThreshold !== undefined ? (
        <Caption>
          {ut("mv.lowItemLink").replace("{n}", String(goodThreshold))}
        </Caption>
      ) : null}
    </View>
  );
}
