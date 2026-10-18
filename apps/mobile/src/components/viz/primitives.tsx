import { useState } from "react";
import { LayoutChangeEvent, View } from "react-native";
import { FONT, fontsLoaded, type Weight } from "../../fonts";
import { spacing, useChart } from "../../theme";
import { T } from "../../ui/Text";

/**
 * Общие примитивы диаграмм.
 *
 * Все графики строятся по одним правилам: тонкие метки, приглушённая сетка,
 * прямые подписи там, где серия одна, и обязательная легенда при двух и более
 * сериях — идентичность не должна держаться на одном цвете.
 *
 * Подписи — Manrope с моноширинными цифрами, как в наборе (.ch, .cv в
 * kit/page.py): ось — 11 полужирным приглушённым, значение — 12 жирным.
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

/** Начертание подписи SVG: файл Manrope или, если шрифт не загрузился, вес системного */
export function svgFont(weight: Weight): { fontFamily: string } | { fontWeight: string } {
  return fontsLoaded() ? { fontFamily: FONT[weight] } : { fontWeight: String(weight) };
}

/** Подпись оси: 11, полужирный, приглушённый */
export function useAxisText() {
  const chart = useChart();
  return { fontSize: 11, fill: chart.axis, ...svgFont(600) };
}

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
  if (items.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: spacing.md, rowGap: spacing.xs, marginTop: spacing.sm }}>
      {items.map((it) => (
        <View key={it.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: it.color }} />
          <T v="sub" size={13} tone="text2">
            {it.label}
          </T>
        </View>
      ))}
    </View>
  );
}

export function Caption({ children }: { children: React.ReactNode }) {
  return (
    <T v="sub" size={13} style={{ marginTop: spacing.xs }}>
      {children}
    </T>
  );
}

// числовая часть — в math.ts: там она без react-native и покрыта тестами
export { niceTicks, formatShort, heatStep } from "./math";
