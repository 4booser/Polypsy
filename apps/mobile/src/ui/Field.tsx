import { useState, type ReactNode } from "react";
import { TextInput, View, type TextInputProps } from "react-native";
import { font } from "../fonts";
import { useTextScale } from "../textScale";
import { radius, useColors, useIsDark } from "../theme";
import { Icon, type IconName } from "./Icon";
import { T } from "./Text";

/**
 * Поле ввода — 52, текст 16, рамка 3:1 к листу (токен field): в плохом
 * свете поле, которое сливается с фоном, не находят и не заполняют.
 *
 * Фокус — фиолетовая рамка и мягкое кольцо; ошибка — красная рамка и
 * красный текст со значком под полем, без красной заливки: ошибка формы —
 * не риск для человека.
 *
 * Подпись связана с полем для диктора (accessibilityLabel): сам он рядом
 * стоящий текст с полем не свяжет.
 */
export function Field({
  label,
  hint,
  error,
  icon,
  right,
  disabled,
  multiline,
  style,
  onFocus,
  onBlur,
  ...props
}: TextInputProps & {
  label: string;
  hint?: string;
  error?: string | null;
  icon?: IconName;
  /** Справа в поле: единица, кнопка «показать» */
  right?: ReactNode;
  disabled?: boolean;
}) {
  const c = useColors();
  const darkTheme = useIsDark();
  const { fs } = useTextScale();
  const [focus, setFocus] = useState(false);
  const accent = darkTheme ? c.vink : c.v;
  const border = error ? c.riskink : focus ? accent : disabled ? c.border : c.field;

  return (
    <View style={{ gap: 6 }}>
      <T v="sub" size={15} weight={700} tone="text2">
        {label}
      </T>
      <View
        style={{
          flexDirection: "row",
          alignItems: multiline ? "flex-start" : "center",
          gap: 10,
          minHeight: multiline ? 120 : 52,
          paddingHorizontal: 14,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: disabled ? c.sunk : c.panel,
          boxShadow: error ? `0px 0px 0px 3px ${c.risktint}` : focus ? `0px 0px 0px 3px ${c.vtint}` : undefined,
        }}
      >
        {icon ? <Icon name={icon} size={20} color={c.muted} /> : null}
        <TextInput
          placeholderTextColor={c.muted}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          editable={!disabled}
          multiline={multiline}
          {...props}
          onFocus={(e) => {
            setFocus(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocus(false);
            onBlur?.(e);
          }}
          style={[
            {
              flex: 1,
              minHeight: multiline ? 120 : 50,
              paddingVertical: multiline ? 14 : 0,
              color: disabled ? c.muted : c.text,
              fontSize: fs(16),
              textAlignVertical: multiline ? "top" : "center",
              ...font(500),
            },
            style,
          ]}
        />
        {right}
      </View>
      {error ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }} accessibilityLiveRegion="polite">
          <Icon name="circle-alert" size={16} color={c.riskink} />
          <T v="sub" weight={700} color={c.riskink} style={{ flex: 1 }}>
            {error}
          </T>
        </View>
      ) : hint ? (
        <T v="sub">{hint}</T>
      ) : null}
    </View>
  );
}
