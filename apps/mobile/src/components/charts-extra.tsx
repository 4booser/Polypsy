import { View } from "react-native";
import { spacing, useChart } from "../theme";
import { T } from "../ui/Text";
import { useLang } from "@/lang";

/** Положение балла в накопленной выборке: дорожка и метка на ней */
export function PercentileBar({ percentile }: { percentile: number }) {
  const chart = useChart();
  const { ut } = useLang();
  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ height: 8, backgroundColor: chart.track, borderRadius: 4 }}>
        <View
          style={{
            position: "absolute",
            left: `${Math.min(98, Math.max(0, percentile))}%`,
            top: -3,
            width: 4,
            height: 14,
            backgroundColor: chart.bar,
            borderRadius: 2,
          }}
        />
      </View>
      <T v="sub">{ut("mv.aboveShare").replace("{n}", String(percentile))}</T>
    </View>
  );
}
