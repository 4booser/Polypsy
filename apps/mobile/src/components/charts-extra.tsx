import { Text, View } from "react-native";
import { radius, spacing, useChart, useColors } from "../theme";

/** Положение балла в накопленной выборке */
export function PercentileBar({ percentile }: { percentile: number }) {
  const chart = useChart();
  const c = useColors();
  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ height: 8, backgroundColor: chart.grid, borderRadius: radius.sm }}>
        <View
          style={{
            position: "absolute",
            left: `${Math.min(98, Math.max(0, percentile))}%`,
            width: 3,
            height: 8,
            backgroundColor: chart.bar,
            borderRadius: 2,
          }}
        />
      </View>
      <Text style={{ color: c.muted, fontSize: 12 }}>
        выше, чем у {percentile}% обследованных
      </Text>
    </View>
  );
}
