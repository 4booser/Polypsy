import { useState } from "react";
import { LayoutChangeEvent, Text as RNText, View } from "react-native";
import { spacing, useColors } from "../../theme";

/**
 * Общие примитивы диаграмм.
 *
 * Все графики строятся по одним правилам: тонкие метки, приглушённая сетка,
 * прямые подписи там, где серия одна, и обязательная легенда при двух и более
 * сериях — идентичность не должна держаться на одном цвете.
 */

export const PLOT = {
  padTop: 12,
  padRight: 12,
  padBottom: 22,
  padLeft: 36,
  markRadius: 4,
  strokeWidth: 2,
  gapPx: 2,
} as const;

/** Измеряет доступную ширину — SVG требует явных координат */
export function useMeasuredWidth(initial = 320): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(initial);
  return [
    width,
    (e: LayoutChangeEvent) => {
      const w = Math.round(e.nativeEvent.layout.width);
      if (w > 0 && Math.abs(w - width) > 1) setWidth(w);
    },
  ];
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  const c = useColors();
  if (items.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.sm }}>
      {items.map((it) => (
        <View key={it.label} style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: it.color }} />
          <RNText style={{ color: c.muted, fontSize: 12 }}>{it.label}</RNText>
        </View>
      ))}
    </View>
  );
}

export function Caption({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <RNText style={{ color: c.muted, fontSize: 12, marginTop: spacing.xs }}>{children}</RNText>;
}

// числовая часть — в math.ts: там она без react-native и покрыта тестами
export { niceTicks, formatShort } from "./math";
