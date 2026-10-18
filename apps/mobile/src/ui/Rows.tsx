import type { ReactNode } from "react";
import { Linking, Pressable, Switch, View } from "react-native";
import { radius, useColors } from "../theme";
import { Icon, type IconName } from "./Icon";
import { Squircle, type Tone } from "./Panel";
import { T } from "./Text";

/**
 * Строка настроек: квадрат со значком, название, пояснение и справа
 * значение, переключатель или шеврон. Не ниже 56 — палец попадает с первого
 * раза.
 */
export function SettingRow({
  icon,
  tone,
  label,
  sub,
  value,
  right,
  onPress,
  first,
  accessibilityHint,
}: {
  icon?: IconName;
  tone?: Tone;
  label: string;
  sub?: string;
  /** Значение справа, приглушённым: «Українська», «5 з 8» */
  value?: string;
  right?: ReactNode;
  /** Строка ведёт дальше — шеврон справа */
  onPress?: () => void;
  first?: boolean;
  accessibilityHint?: string;
}) {
  const c = useColors();
  const body = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: sub ? "flex-start" : "center",
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingLeft: 14,
        paddingRight: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.divider,
        backgroundColor: pressed ? c.panel2 : "transparent",
      }}
    >
      {icon ? <Squircle icon={icon} tone={tone} /> : null}
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center", minHeight: icon ? 32 : undefined }}>
        <T v="headline" weight={700}>
          {label}
        </T>
        {sub ? <T v="sub">{sub}</T> : null}
      </View>
      {value ? (
        <T v="body" weight={600} tone="text2" numberOfLines={1} style={{ alignSelf: "center", flexShrink: 1, textAlign: "right" }}>
          {value}
        </T>
      ) : null}
      {right ? <View style={{ alignSelf: "center" }}>{right}</View> : null}
      {onPress ? (
        <View style={{ alignSelf: "center" }}>
          <Icon name="chevron-right" size={18} color={c.muted} />
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}: ${value}` : label}
      accessibilityHint={accessibilityHint ?? sub}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

/**
 * Строка с переключателем. Нажимается вся строка, а не только рычажок:
 * в рычажок 51×31 после смены или с тремором попадают не с первого раза.
 * Для диктора строка — один переключатель с названием и состоянием.
 */
export function SwitchRow({
  icon,
  tone,
  label,
  sub,
  value,
  onChange,
  disabled,
  first,
}: {
  icon?: IconName;
  tone?: Tone;
  label: string;
  sub?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  first?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={sub}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      style={{ opacity: disabled ? 0.48 : 1 }}
    >
      {({ pressed }) => (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            minHeight: 56,
            paddingVertical: 12,
            paddingHorizontal: 14,
            borderTopWidth: first ? 0 : 1,
            borderTopColor: c.divider,
            backgroundColor: pressed ? c.panel2 : "transparent",
          }}
        >
          {icon ? <Squircle icon={icon} tone={tone} /> : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="headline" weight={700}>
              {label}
            </T>
            {sub ? <T v="sub">{sub}</T> : null}
          </View>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
            <Switch
              value={value}
              disabled={disabled}
              trackColor={{ false: c.ctl, true: c.v }}
              thumbColor={c.onfill}
              ios_backgroundColor={c.ctl}
            />
          </View>
        </View>
      )}
    </Pressable>
  );
}

/**
 * Строка звонка: кто, зачем, номер крупно и кнопка-трубка 44. Нажатие на
 * строку звонит сразу, без подтверждения: в кризис лишний шаг между
 * человеком и звонком стоит дороже всего остального на экране.
 *
 * tone="risk" — экстренный номер (103): красная трубка. Красный здесь
 * законен — это риск для человека.
 */
export function CallRow({
  name,
  sub,
  number,
  tone,
  first,
}: {
  name: string;
  sub?: string;
  /** Номер как написан; для набора из него берутся только цифры и «+» */
  number: string;
  tone?: "risk";
  first?: boolean;
}) {
  const c = useColors();
  const risk = tone === "risk";
  const ink = risk ? c.riskink : c.vink;
  // короткий номер (7333, 103) — крупно справа; длинный — строкой под именем, иначе он съест имя
  const short = number.replace(/\s/g, "").length <= 6;
  const line = short ? sub : (sub ?? number);
  return (
    <Pressable
      onPress={() => void Linking.openURL(`tel:${number.replace(/[^+\d]/g, "")}`)}
      accessibilityRole="button"
      accessibilityLabel={[name, sub, number].filter(Boolean).join(". ")}
    >
      {({ pressed }) => (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            minHeight: 66,
            paddingVertical: 9,
            paddingLeft: 16,
            paddingRight: 14,
            borderTopWidth: first ? 0 : 1,
            borderTopColor: c.divider,
            backgroundColor: pressed ? c.panel2 : "transparent",
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="headline" color={risk ? c.riskink : c.text}>
              {name}
            </T>
            {line ? (
              <T v="sub" num numberOfLines={1}>
                {line}
              </T>
            ) : null}
          </View>
          {short ? (
            <T v="headline" size={20} color={ink} num scale={false}>
              {number}
            </T>
          ) : null}
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: radius.panel,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: risk ? (pressed ? c.riskink : c.risk) : pressed ? c.vtint2 : c.vtint,
            }}
          >
            <Icon name="phone" size={20} color={risk ? c.onfill : c.vink} />
          </View>
        </View>
      )}
    </Pressable>
  );
}
