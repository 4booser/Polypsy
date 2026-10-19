import { View } from "react-native";
import { spacing, useChart } from "../theme";
import { useLang } from "../lang";
import { T } from "../ui/Text";
import { Body } from "./ui";

/**
 * Диаграммы собраны на View: столбики тонкие, с закруглённым концом и
 * прижаты к базовой линии, между сегментами — зазор цвета поверхности,
 * подписи стоят рядом со значением, сетка и оси приглушены.
 *
 * Цвета — палитра графиков «Виразной» (useChart): один ряд — фиолетовый
 * набора, дорожка — track.
 */

const SEGMENT_GAP = 2;

/** Вертикальная гистограмма числовых ответов */
export function Histogram({
  data,
  height = 96,
}: {
  data: { value: number; count: number }[];
  height?: number;
}) {
  const { ut } = useLang();
  const chart = useChart();
  if (!data.length) return <Body muted>{ut("mch.noNumeric")}</Body>;
  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: SEGMENT_GAP, height }}>
        {data.map((d) => (
          <View key={d.value} style={{ flex: 1, alignItems: "center", gap: 2 }}>
            <T v="caption" size={11} weight={700} tone="text2" num scale={false}>
              {d.count}
            </T>
            <View
              style={{
                width: "100%",
                height: Math.max(3, (d.count / max) * (height - 18)),
                backgroundColor: chart.bar,
                borderTopLeftRadius: 4,
                borderTopRightRadius: 4,
              }}
            />
          </View>
        ))}
      </View>
      <View style={{ height: 1, backgroundColor: chart.base }} />
      <View style={{ flexDirection: "row", gap: SEGMENT_GAP }}>
        {data.map((d) => (
          <T key={d.value} v="caption" size={11} num scale={false} style={{ flex: 1, textAlign: "center" }}>
            {d.value}
          </T>
        ))}
      </View>
    </View>
  );
}
