import { useState, type ReactNode } from "react";
import { Pressable, TextInput, View, type TextInputProps } from "react-native";
import { font } from "../../fonts";
import { useLang } from "../../lang";
import { radius, useColors, useIsDark } from "../../theme";
import { useTextScale } from "../../textScale";
import { Field } from "../../ui/Field";
import { Icon, type IconName } from "../../ui/Icon";
import { T } from "../../ui/Text";

/**
 * Пароль с «показать» справа — цель 44. Пароль набирают на телефоне, часто
 * дрожащими руками: возможность увидеть набранное экономит три попытки и
 * блокировку входа.
 */
export function SecretField({
  label,
  icon = "lock-keyhole",
  status,
  ...props
}: TextInputProps & { label: string; icon?: IconName; hint?: string; error?: string | null; status?: ReactNode }) {
  const c = useColors();
  const { ut } = useLang();
  const [shown, setShown] = useState(false);
  return (
    <Field
      label={label}
      icon={icon}
      secureTextEntry={!shown}
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      right={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: -8 }}>
          {status}
          <Pressable
            onPress={() => setShown((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={shown ? ut("mpt.lg.hide") : ut("mpt.lg.show")}
            accessibilityState={{ selected: shown }}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? c.sunk : "transparent",
            })}
          >
            <Icon name={shown ? "eye-off" : "eye"} size={20} color={c.muted} />
          </Pressable>
        </View>
      }
    />
  );
}

/** Группа строк формы: подпись слева, поле справа — регистрация, личные данные */
export function FormGroup({ children, label }: { children: ReactNode; label?: string }) {
  const c = useColors();
  return (
    <View
      accessibilityLabel={label}
      style={{ marginHorizontal: 16, borderRadius: radius.tile, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, overflow: "hidden" }}
    >
      {children}
    </View>
  );
}

/**
 * Строка группы: подпись 142 слева, ввод справа; не ниже 52. В фокусе вся
 * строка подсвечивается — в длинной форме видно, где сейчас курсор.
 */
export function FormRow({
  label,
  first,
  control,
  right,
  ...props
}: TextInputProps & { label: string; first?: boolean; control?: ReactNode; right?: ReactNode }) {
  const c = useColors();
  const dark = useIsDark();
  const { fs } = useTextScale();
  const [focus, setFocus] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 52,
        paddingVertical: 4,
        paddingLeft: 16,
        paddingRight: 6,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: focus ? "transparent" : c.divider,
        backgroundColor: focus ? c.vtint : "transparent",
        borderWidth: focus ? 2 : 0,
        borderColor: dark ? c.vink : c.v,
      }}
    >
      <T v="body" size={15} weight={600} tone="text2" style={{ width: 142 }}>
        {label}
      </T>
      {control ?? (
        <TextInput
          placeholderTextColor={c.muted}
          accessibilityLabel={label}
          {...props}
          onFocus={(e) => {
            setFocus(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocus(false);
            props.onBlur?.(e);
          }}
          style={{ flex: 1, minWidth: 0, height: 44, color: c.text, fontSize: fs(16), ...font(700) }}
        />
      )}
      {right}
    </View>
  );
}

/** Пояснение под группой формы — 14/20, приглушённое */
export function FormFoot({ children }: { children: ReactNode }) {
  return (
    <T v="sub" style={{ marginTop: 8, marginHorizontal: 20 }}>
      {children}
    </T>
  );
}
