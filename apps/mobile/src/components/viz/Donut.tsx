import { Text as RNText, View } from "react-native";
import Svg, { G, Path, Text as SvgText } from "react-native-svg";
import { spacing, useColors } from "../../theme";
import { Caption, useMeasuredWidth } from "./primitives";
import { useLang } from "@/lang";

export interface Slice {
  label: string;
  value: number;
  color: string;
}

/**
 * Кольцевая диаграмма долей.
 *
 * Применяется только там, где доли складываются в осмысленное целое и их
 * немного. Между секторами оставлен зазор цвета поверхности, в центре —
 * итоговое число, легенда всегда с подписями и абсолютными значениями.
 */
export function Donut({
  slices,
  centerValue,
  centerLabel,
  size = 170,
}: {
  slices: Slice[];
  centerValue?: string;
  centerLabel?: string;
  size?: number;
}) {
  const { ut } = useLang();
  const c = useColors();
  const [, onLayout] = useMeasuredWidth();
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total === 0) return <Caption>{ut("mviz.noData")}</Caption>;

  const r = size / 2 - 12;
  const inner = r * 0.62;
  const cx = size / 2;
  const cy = size / 2;
  const GAP = 0.02; // радианы — зазор между секторами

  let angle = -Math.PI / 2;
  const arcs = slices.map((s) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const a0 = angle + GAP / 2;
    const a1 = angle + sweep - GAP / 2;
    angle += sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad];
    const [x0, y0] = p(r, a0);
    const [x1, y1] = p(r, a1);
    const [x2, y2] = p(inner, a1);
    const [x3, y3] = p(inner, a0);
    return {
      ...s,
      d: `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${inner},${inner} 0 ${large} 0 ${x3},${y3} Z`,
    };
  });

  return (
    <View onLayout={onLayout} style={{ flexDirection: "row", alignItems: "center", gap: spacing.lg }}>
      <Svg width={size} height={size}>
        <G>
          {arcs.map((a) => (
            <Path key={a.label} d={a.d} fill={a.color} />
          ))}
        </G>
        {centerValue ? (
          <>
            <SvgText x={cx} y={cy + 2} fontSize={22} fontWeight="700" fill={c.text} textAnchor="middle">
              {centerValue}
            </SvgText>
            {centerLabel ? (
              <SvgText x={cx} y={cy + 18} fontSize={10} fill={c.muted} textAnchor="middle">
                {centerLabel}
              </SvgText>
            ) : null}
          </>
        ) : null}
      </Svg>

      <View style={{ flex: 1, gap: spacing.xs }}>
        {slices.map((s) => (
          <View key={s.label} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: s.color }} />
            <RNText style={{ color: c.text, fontSize: 13, flex: 1 }} numberOfLines={1}>
              {s.label}
            </RNText>
            <RNText style={{ color: c.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
              {s.value} · {Math.round((s.value / total) * 100)}%
            </RNText>
          </View>
        ))}
      </View>
    </View>
  );
}
