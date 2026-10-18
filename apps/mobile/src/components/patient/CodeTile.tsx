import { View } from "react-native";
import { useColors } from "../../theme";
import { Icon, type IconName } from "../../ui/Icon";
import { T } from "../../ui/Text";

/**
 * Код методики в квадрате 44 — «ISI», «PHQ-9»: по нему человек узнаёт
 * методику быстрее, чем по названию, и тот же код он слышит от специалиста.
 * Кода нет — значок. n — нейтральный: пройдено, без динамики.
 */
export function CodeTile({ code, icon = "clipboard-list", neutral }: { code: string | null; icon?: IconName; neutral?: boolean }) {
  const c = useColors();
  const bg = neutral ? c.sunk : c.vtint;
  const fg = neutral ? c.text2 : c.vink;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        minWidth: 44,
        height: 44,
        paddingHorizontal: 7,
        borderRadius: 13,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: neutral ? c.border : c.vline,
      }}
    >
      {code ? (
        <T v="caption" size={12.5} weight={800} color={fg} scale={false} numberOfLines={1}>
          {code}
        </T>
      ) : (
        <Icon name={icon} size={20} color={fg} />
      )}
    </View>
  );
}
