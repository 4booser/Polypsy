import { View } from "react-native";
import Svg, { Circle, G, Line, Path, Text as SvgText } from "react-native-svg";
import { severityColor, useChart, useColors } from "../../theme";
import { Caption, Legend, PLOT, formatShort, niceTicks, useMeasuredWidth } from "./primitives";
import { lineRuns, xFractions } from "./math";
import { useLang } from "@/lang";

export interface SeriesPoint {
  x: string;
  /** null — замера нет: линия здесь рвётся, а не идёт через пустоту (math.ts, lineRuns) */
  y: number | null;
  /** Момент замера, мс. Есть у всех точек — ось X по времени, а не по номеру (math.ts, xFractions) */
  t?: number;
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
 *
 * Соединяются только соседние известные: где замера нет (y = null), линия
 * рвётся. Раньше пропусков не было вовсе — счёт по дням шёл подряд, и линия
 * тянулась через недели без единого замера так, будто они были. Одиночный
 * замер между пустыми виден маркером.
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

  const known = series.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y !== null));
  if (known.length === 0) return <Caption>{ut("mviz.noData")}</Caption>;

  const top = yMax ?? Math.max(...known, 1);
  const ticks = niceTicks(top);
  const scaleTop = Math.max(...ticks, top);

  const plotW = Math.max(40, width - PLOT.padLeft - PLOT.padRight);
  const plotH = height - PLOT.padTop - PLOT.padBottom;
  const fractions = xFractions(series);
  const xOf = (si: number, i: number) => PLOT.padLeft + (fractions[si]?.[i] ?? 0.5) * plotW;
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
          // по отрезку на каждую серию подряд идущих замеров: пропуск рвёт линию и заливку
          const runs = lineRuns(s.points.map((p) => p.y)).filter((run) => run.length > 1);
          const lineOf = (run: number[]) =>
            run.map((i, k) => `${k === 0 ? "M" : "L"}${xOf(si, i)},${yAt(s.points[i]!.y!)}`).join(" ");
          return (
            // группа SVG, а не View: React Native не рендерит обычные вью внутри Svg
            <G key={s.label}>
              {showArea
                ? runs.map((run) => (
                    <Path
                      key={`a-${run[0]}`}
                      d={`${lineOf(run)} L${xOf(si, run.at(-1)!)},${yAt(0)} L${xOf(si, run[0]!)},${yAt(0)} Z`}
                      fill={color}
                      opacity={0.12}
                    />
                  ))
                : null}
              {runs.map((run) => (
                <Path key={`l-${run[0]}`} d={lineOf(run)} stroke={color} strokeWidth={PLOT.strokeWidth} fill="none" />
              ))}
              {s.points.map((p, i) =>
                p.y === null ? null : (
                  <Circle
                    key={`${s.label}-${i}`}
                    cx={xOf(si, i)}
                    cy={yAt(p.y)}
                    r={PLOT.markRadius}
                    fill={p.tone ? severityColor[p.tone] : color}
                    stroke={c.card}
                    strokeWidth={2}
                  />
                ),
              )}
            </G>
          );
        })}

        {/* подписываем только края: число на каждой точке делает график таблицей */}
        {series.length === 1 && series[0]!.points.length > 0
          ? (() => {
              // края — первый и последний известные замеры, а не пустые дни по краям
              const idx = series[0]!.points.flatMap((p, i) => (p.y === null ? [] : [i]));
              return idx.length ? [idx[0]!, idx.at(-1)!] : [];
            })()
              .filter((i, idx, arr) => arr.indexOf(i) === idx)
              .map((i, k) => {
                const p = series[0]!.points[i]! as SeriesPoint & { y: number };
                return (
                  <SvgText
                    key={`lbl-${i}`}
                    x={xOf(0, i)}
                    y={yAt(p.y) - 10}
                    fontSize={11}
                    fontWeight="600"
                    fill={c.text}
                    textAnchor={k === 0 ? "start" : "end"}
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
        {known.length > 0 ? (
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
