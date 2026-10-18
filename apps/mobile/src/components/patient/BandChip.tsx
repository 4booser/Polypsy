import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useColors } from "../../theme";
import { Icon, type IconName } from "../../ui/Icon";
import { T } from "../../ui/Text";

/**
 * Строка открытого на полосе главного экрана: «Підтвердити прийом»,
 * «Нове повідомлення», «ISI до 15.10», щит плана. Прокручивается вбок;
 * каждая пилюля ведёт туда, где это делается.
 */
export function ChipStrip({ children, accessibilityLabel }: { children: ReactNode; accessibilityLabel?: string }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={accessibilityLabel}
      style={{ marginTop: 14, marginHorizontal: -20 }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 20, paddingBottom: 2 }}
    >
      {children}
    </ScrollView>
  );
}

/**
 * Пилюля 44: значок, жирная подпись и пояснение. kind — смысл: msg —
 * сообщение, warn — требует внимания, good — только значок (план на месте).
 */
export function BandChip({
  label,
  detail,
  icon,
  kind,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  detail?: string;
  icon: IconName;
  kind?: "msg" | "warn" | "good";
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const c = useColors();
  const tone =
    kind === "msg"
      ? { bg: c.infotint, fg: c.info, ink: c.info }
      : kind === "warn"
        ? { bg: c.warntint, fg: c.warn, ink: c.warn }
        : kind === "good"
          ? { bg: c.goodtint, fg: c.good, ink: c.good }
          : { bg: c.bcard, fg: c.muted, ink: c.text };
  const iconOnly = kind === "good";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [label, detail].filter(Boolean).join(", ")}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          height: 44,
          minWidth: 44,
          paddingLeft: iconOnly ? 0 : 13,
          paddingRight: iconOnly ? 0 : 15,
          justifyContent: "center",
          borderRadius: 22,
          backgroundColor: tone.bg,
          opacity: pressed ? 0.85 : 1,
        },
        !kind ? { borderWidth: 1, borderColor: pressed ? c.ctl : c.bcardline } : null,
      ]}
    >
      <Icon name={icon} size={iconOnly ? 18 : 17} color={tone.fg} />
      {iconOnly ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <T v="body" size={15} weight={800} color={tone.ink} scale={false} numberOfLines={1}>
            {label}
          </T>
          {detail ? (
            <T v="body" size={15} weight={500} tone="text2" scale={false} numberOfLines={1}>
              {detail}
            </T>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}
