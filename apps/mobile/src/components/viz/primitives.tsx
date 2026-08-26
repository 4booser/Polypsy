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

/** Красивые деления оси: 0, 5, 10 вместо 0, 3.7, 7.4 */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

export function formatShort(v: number): string {
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v * 100) / 100);
}
