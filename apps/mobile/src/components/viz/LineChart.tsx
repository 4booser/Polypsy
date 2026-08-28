import { View } from "react-native";
import Svg, { Circle, G, Line, Path, Text as SvgText } from "react-native-svg";
import { severityColor, useChart, useColors } from "../../theme";
import { Caption, Legend, PLOT, formatShort, niceTicks, useMeasuredWidth } from "./primitives";
import { useLang } from "@/lang";

export interface SeriesPoint {
  x: string;
  y: number;
  /** Цветовая метка точки — например степень выраженности */
  tone?: keyof typeof severityColor;
}

export interface Series {
  label: string;
  points: SeriesPoint[];
  color?: string;
}

/**
 * Линейный график изменения во времени.
 *
 * Точки соединяются, потому что здесь важна не величина каждого замера,
 * а направление между ними. Подписываются только первая, последняя и
 * экстремальные точки — число на каждой точке превращает график в таблицу.
 */
export function LineChart({
  series,
  height = 180,
  yMax,
  showArea = false,
  valueLabel,
}: {
  series: Series[];
  height?: number;
  yMax?: number;
  showArea?: boolean;
  valueLabel?: (v: number) => string;
}) {
  const { ut } = useLang();
  const chart = useChart();
  const c = useColors();
  const [width, onLayout] = useMeasuredWidth();

  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <Caption>{ut("mviz.noData")}</Caption>;

  const top = yMax ?? Math.max(...all.map((p) => p.y), 1);
  const ticks = niceTicks(top);
  const scaleTop = Math.max(...ticks, top);

  const plotW = Math.max(40, width - PLOT.padLeft - PLOT.padRight);
  const plotH = height - PLOT.padTop - PLOT.padBottom;
  const count = Math.max(...series.map((s) => s.points.length));
  const xAt = (i: number) => PLOT.padLeft + (count > 1 ? (i / (count - 1)) * plotW : plotW / 2);
  const yAt = (v: number) => PLOT.padTop + plotH - (v / scaleTop) * plotH;

  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={height}>
        {/* сетка приглушена: она ориентир, а не содержание */}
        {ticks.map((t) => (
          <Line
            key={`g-${t}`}
            x1={PLOT.padLeft}
            x2={PLOT.padLeft + plotW}
            y1={yAt(t)}
            y2={yAt(t)}
            stroke={chart.grid}
            strokeWidth={1}
          />
        ))}
        {ticks.map((t) => (
          <SvgText
            key={`t-${t}`}
            x={PLOT.padLeft - 6}
            y={yAt(t) + 4}
            fontSize={10}
            fill={chart.axis}
            textAnchor="end"
          >
            {formatShort(t)}
          </SvgText>
        ))}

        {series.map((s, si) => {
          const color = s.color ?? chart.series[si % chart.series.length]!;
          const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(p.y)}`).join(" ");
          const areaD = `${d} L${xAt(s.points.length - 1)},${yAt(0)} L${xAt(0)},${yAt(0)} Z`;
          return (
            // группа SVG, а не View: React Native не рендерит обычные вью внутри Svg
            <G key={s.label}>
              {showArea ? <Path d={areaD} fill={color} opacity={0.12} /> : null}
              <Path d={d} stroke={color} strokeWidth={PLOT.strokeWidth} fill="none" />
              {s.points.map((p, i) => (
                <Circle
                  key={`${s.label}-${i}`}
                  cx={xAt(i)}
                  cy={yAt(p.y)}
                  r={PLOT.markRadius}
                  fill={p.tone ? severityColor[p.tone] : color}
                  stroke={c.card}
                  strokeWidth={2}
                />
              ))}
            </G>
          );
        })}

        {/* подписываем только края: число на каждой точке делает график таблицей */}
        {series.length === 1 && series[0]!.points.length > 0
          ? [0, series[0]!.points.length - 1]
              .filter((i, idx, arr) => arr.indexOf(i) === idx)
              .map((i) => {
                const p = series[0]!.points[i]!;
                return (
                  <SvgText
                    key={`lbl-${i}`}
                    x={xAt(i)}
                    y={yAt(p.y) - 10}
                    fontSize={11}
                    fontWeight="600"
                    fill={c.text}
                    textAnchor={i === 0 ? "start" : "end"}
                  >
                    {valueLabel ? valueLabel(p.y) : formatShort(p.y)}
                  </SvgText>
                );
              })
          : null}

        <Line
          x1={PLOT.padLeft}
          x2={PLOT.padLeft + plotW}
          y1={yAt(0)}
          y2={yAt(0)}
          stroke={chart.axis}
          strokeWidth={1}
        />
        {all.length > 0 ? (
          <>
            <SvgText x={PLOT.padLeft} y={height - 6} fontSize={10} fill={chart.axis}>
              {series[0]!.points[0]?.x ?? ""}
            </SvgText>
            <SvgText
              x={PLOT.padLeft + plotW}
              y={height - 6}
              fontSize={10}
              fill={chart.axis}
              textAnchor="end"
            >
              {series[0]!.points[series[0]!.points.length - 1]?.x ?? ""}
            </SvgText>
          </>
        ) : null}
      </Svg>

      <Legend
        items={series.map((s, i) => ({
          label: s.label,
          color: s.color ?? chart.series[i % chart.series.length]!,
        }))}
      />
    </View>
  );
}
