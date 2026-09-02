import { View } from "react-native";
import Svg, { Circle, Line, Polygon, Text as SvgText } from "react-native-svg";
import { useChart, useColors } from "../../theme";
import { Caption, Legend, useMeasuredWidth } from "./primitives";
import { useLang } from "@/lang";

export interface RadarAxis {
  label: string;
  /** Значение 0–1: доля от максимума своей шкалы */
  value: number;
  raw: number;
}

/**
 * Профиль по субшкалам.
 *
 * Классическая форма представления результата психодиагностики: важна не
 * величина отдельной шкалы, а форма профиля целиком. Оси нормируются к доле
 * от максимума своей шкалы — иначе шкала с диапазоном 0–60 подавляла бы
 * шкалу 0–5 и профиль читался бы неверно.
 */
export function RadarChart({
  axes,
  compare,
  height = 260,
  labels,
}: {
  axes: RadarAxis[];
  /** Второй профиль для сравнения — например прошлый замер */
  compare?: RadarAxis[];
  height?: number;
  /** Подписи профилей; по умолчанию «Текущий» и «Предыдущий» на языке интерфейса */
  labels?: [string, string] | string[];
}) {
  const { ut } = useLang();
  const chart = useChart();
  const c = useColors();
  const [width, onLayout] = useMeasuredWidth();

  if (axes.length < 3) {
    return <Caption>{ut("mv.radarNeedsThree").replace("{n}", String(axes.length))}</Caption>;
  }

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 46;
  const step = (Math.PI * 2) / axes.length;
  const point = (i: number, v: number) => {
    const angle = -Math.PI / 2 + i * step;
    return [cx + Math.cos(angle) * radius * v, cy + Math.sin(angle) * radius * v] as const;
  };
  const polygon = (data: RadarAxis[]) =>
    data.map((a, i) => point(i, Math.max(0, Math.min(1, a.value))).join(",")).join(" ");

  const rings = [0.25, 0.5, 0.75, 1];

  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={height}>
        {rings.map((r) => (
          <Polygon
            key={`ring-${r}`}
            points={axes.map((_, i) => point(i, r).join(",")).join(" ")}
            fill="none"
            stroke={chart.grid}
            strokeWidth={1}
          />
        ))}
        {axes.map((_, i) => {
          const [x, y] = point(i, 1);
          return <Line key={`spoke-${i}`} x1={cx} y1={cy} x2={x} y2={y} stroke={chart.grid} strokeWidth={1} />;
        })}

        {compare ? (
          <Polygon
            points={polygon(compare)}
            fill={chart.series[1]}
            fillOpacity={0.12}
            stroke={chart.series[1]}
            strokeWidth={2}
            strokeDasharray="4 3"
          />
        ) : null}

        <Polygon
          points={polygon(axes)}
          fill={chart.series[0]}
          fillOpacity={0.2}
          stroke={chart.series[0]}
          strokeWidth={2}
        />

        {axes.map((a, i) => {
          const [x, y] = point(i, Math.max(0, Math.min(1, a.value)));
          return <Circle key={`dot-${i}`} cx={x} cy={y} r={4} fill={chart.series[0]} stroke={c.card} strokeWidth={2} />;
        })}

        {axes.map((a, i) => {
          const [x, y] = point(i, 1.19);
          const anchor = Math.abs(x - cx) < 12 ? "middle" : x > cx ? "start" : "end";
          return (
            <SvgText
              key={`lbl-${i}`}
              x={x}
              y={y + 4}
              fontSize={10}
              fill={c.muted}
              textAnchor={anchor as "middle" | "start" | "end"}
            >
              {a.label.length > 14 ? `${a.label.slice(0, 13)}…` : a.label}
            </SvgText>
          );
        })}
      </Svg>

      <Legend
        items={
          compare
            ? [
                { label: labels?.[0] ?? ut("mviz.current"), color: chart.series[0]! },
                { label: labels?.[1] ?? ut("mviz.previous"), color: chart.series[1]! },
              ]
            : []
        }
      />
      <Caption>{ut("mviz.radarHint")}</Caption>
    </View>
  );
}
