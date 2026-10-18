import { View } from "react-native";
import { radius, useColors, useShadows } from "../../theme";
import type { IconName } from "../../ui/Icon";
import { Squircle, type Tone } from "../../ui/Panel";
import { T } from "../../ui/Text";

export interface Fact {
  icon: IconName;
  tone?: Tone;
  title: string;
  text?: string | null;
}

/**
 * «Що варто знати»: строки со значком, жирной строкой и пояснением —
 * перед методикой, в согласии. Пояснение 15/21 текстом второго уровня, а не
 * приглушённым: его читают, а не пробегают.
 */
export function FactList({ facts, accessibilityLabel }: { facts: Fact[]; accessibilityLabel?: string }) {
  const c = useColors();
  const sh = useShadows();
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={{
        marginTop: 16,
        marginHorizontal: 16,
        paddingVertical: 4,
        borderRadius: radius.panel,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.panel,
        boxShadow: sh.panel,
      }}
    >
      {facts.map((f, i) => (
        <View
          key={`${f.title}-${i}`}
          accessible
          style={{
            flexDirection: "row",
            gap: 14,
            paddingVertical: 13,
            paddingLeft: 14,
            paddingRight: 16,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: c.divider,
          }}
        >
          <View style={{ marginTop: 1 }}>
            <Squircle icon={f.icon} tone={f.tone} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="headline">{f.title}</T>
            {f.text ? (
              <T v="note" tone="text2" style={{ marginTop: 1 }}>
                {f.text}
              </T>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}
