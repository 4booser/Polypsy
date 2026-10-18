import { Pressable, View } from "react-native";
import { radius, useColors, useIsDark, useShadows } from "../theme";
import { Icon } from "./Icon";
import { T } from "./Text";

/**
 * Вариант ответа — плитка не ниже 64, скругление 16.
 *
 * Выбранная — мягкая фиолетовая заливка и кольцо 2 px, кружок закрашен и
 * несёт галочку, подпись жирнее. Выбор читается тремя признаками сразу, а не
 * одним цветом: человек с плохим зрением в плохом свете видит и кольцо, и
 * галочку.
 *
 * Рамка меняет толщину 1 → 2, а отступ — обратно на пиксель: текст при
 * выборе не сдвигается.
 *
 * Роль и состояние обязательны: без них диктор читает просто «Иногда», не
 * сообщая ни что это выбор, ни что он уже сделан.
 */
export function AnswerTile({
  label,
  selected,
  onPress,
  multi = false,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Несколько ответов: квадрат вместо кружка, роль checkbox */
  multi?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const c = useColors();
  const sh = useShadows();
  const darkTheme = useIsDark();
  const ring = darkTheme ? c.vink : c.v;
  const ring1 = selected ? 0 : 1;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        minHeight: 64,
        paddingVertical: 11 + ring1,
        paddingLeft: 15 + ring1,
        paddingRight: 17 + ring1,
        borderRadius: radius.tile,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? ring : pressed ? c.ctl : c.border,
        backgroundColor: selected ? c.vtint : pressed ? c.panel2 : c.panel,
        boxShadow: selected ? undefined : sh.panel,
        opacity: disabled ? 0.48 : 1,
      })}
    >
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: multi ? 8 : 13,
          borderWidth: selected ? 0 : 2,
          borderColor: c.ctl,
          backgroundColor: selected ? ring : c.panel,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? <Icon name="check" size={16} strokeWidth={3} color={darkTheme ? c.ground : c.onfill} /> : null}
      </View>
      <T v="body" size={17} weight={selected ? 800 : 700} color={selected ? c.vink : c.text} style={{ flex: 1 }}>
        {label}
      </T>
    </Pressable>
  );
}
