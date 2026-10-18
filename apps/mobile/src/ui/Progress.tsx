import { View } from "react-native";
import { useChart, useColors, useIsDark } from "../theme";

/**
 * Сегменты прогресса: по одному на пункт — пройденные залиты, текущий
 * обведён, впереди — дорожка. Сегмент — это пункт, и человек видит не
 * проценты, а «ещё шесть вопросов».
 *
 * Больше SEGMENTS_MAX пунктов — сплошная полоса: двести сегментов по
 * полтора пикселя читаются как шум, а не как счёт.
 */
export const SEGMENTS_MAX = 24;

export function ProgressSegments({
  total,
  current,
  done,
  accessibilityLabel,
}: {
  total: number;
  /** Номер текущего пункта с нуля; -1 — текущего нет (итог) */
  current: number;
  /** Сколько пройдено; по умолчанию — всё до текущего */
  done?: number;
  /** «Питання 3 з 9» — читает диктор */
  accessibilityLabel?: string;
}) {
  const c = useColors();
  const darkTheme = useIsDark();
  const fill = darkTheme ? c.vink : c.v;
  const track = useChart().track;
  const passed = done ?? Math.max(0, current);
  const a11y = {
    accessible: true,
    accessibilityRole: "progressbar" as const,
    accessibilityLabel,
    accessibilityValue: { min: 0, max: total, now: Math.min(total, passed + (current >= 0 ? 1 : 0)) },
  };

  if (total > SEGMENTS_MAX) {
    const share = total ? Math.min(1, (passed + (current >= 0 ? 0.5 : 0)) / total) : 0;
    return (
      <View {...a11y} style={{ height: 6, borderRadius: 3, backgroundColor: track, marginTop: 10, overflow: "hidden" }}>
        <View style={{ width: `${Math.round(share * 1000) / 10}%`, height: 6, borderRadius: 3, backgroundColor: fill }} />
      </View>
    );
  }

  return (
    <View {...a11y} style={{ flexDirection: "row", gap: 4, marginTop: 10 }}>
      {Array.from({ length: total }, (_, i) => {
        const isCurrent = i === current;
        const isDone = i < passed && !isCurrent;
        return (
          <View
            key={i}
            style={[
              { flex: 1, height: 6, borderRadius: 3, backgroundColor: isDone ? fill : isCurrent ? c.vline : track },
              isCurrent ? { borderWidth: 1.5, borderColor: fill } : null,
            ]}
          />
        );
      })}
    </View>
  );
}
