import type { ReactNode } from "react";
import { ActivityIndicator, View, type TextInputProps, type ViewStyle } from "react-native";
import { radius, spacing, useColors, useShadows } from "../theme";
import { Btn } from "../ui/Button";
import { Field as UiField } from "../ui/Field";
import { Icon } from "../ui/Icon";
import { FilterChip } from "../ui/Pill";
import { Segmented as UiSegmented } from "../ui/Segmented";
import { T } from "../ui/Text";

/*
 * Прежние имена компонентов — теперь в «Виразной».
 *
 * Экраны собраны из Card, Title, Body, Button и остальных отсюда; новые
 * компоненты живут в src/ui. Чтобы экраны, ещё не переписанные, уже стояли
 * в новом оформлении, прежние имена рисуются новыми компонентами, а их
 * свойства остаются прежними.
 */

/**
 * Минимальная цель нажатия.
 *
 * 44 pt — порог из руководств Apple и Google; берём 48, потому что планшет
 * в киоске держат на вытянутой руке, а часть обследуемых приходит с тремором
 * или после бессонной смены.
 */
export const TOUCH_TARGET = 48;

/** Лист панели: рамка, скругление 14, отступ 16 */
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const c = useColors();
  const sh = useShadows();
  return (
    <View
      style={[
        {
          backgroundColor: c.panel,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: radius.panel,
          boxShadow: sh.panel,
          padding: spacing.lg,
          gap: spacing.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Заголовок в теле экрана — 22/28; заголовок самого экрана стоит в шапке */
export function Title({ children }: { children: ReactNode }) {
  return (
    <T v="sheetTitle" accessibilityRole="header">
      {children}
    </T>
  );
}

/** Текст 16/24; muted — второй текст, он приглушён, но читается в плохом свете */
export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <T v="body" tone={muted ? "text2" : "text"}>
      {children}
    </T>
  );
}

/**
 * Кнопка. primary — фиолетовая 52, главное действие; secondary — мягкая
 * заливка 48. danger ведёт туда же, куда secondary: выход и удаление в
 * наборе — обычные кнопки с подтверждением, красный — только риск для
 * человека.
 */
export function Button({
  title,
  onPress,
  loading,
  disabled,
  variant = "primary",
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <Btn
      title={title}
      onPress={onPress}
      loading={loading}
      disabled={disabled}
      kind={variant === "primary" ? "primary" : "secondary"}
      size={variant === "primary" ? "l" : "m"}
    />
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <UiField label={label} {...props} />;
}

/** Ошибка — красный текст со значком, без красной заливки: это не риск для человека */
export function ErrorText({ children }: { children: ReactNode }) {
  const c = useColors();
  if (!children) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }} accessibilityLiveRegion="polite">
      <View style={{ marginTop: 2 }}>
        <Icon name="circle-alert" size={17} color={c.riskink} />
      </View>
      <T v="note" weight={700} color={c.riskink} style={{ flex: 1 }}>
        {children}
      </T>
    </View>
  );
}

export function Loader() {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.ground }}>
      <ActivityIndicator size="large" color={c.primary} />
    </View>
  );
}

/**
 * Плашка. С onPress — переключаемая пилюля (выбор темы, пол); без —
 * неподвижная метка. color — цветная метка рядом со словом (выраженность):
 * цвет никогда не говорит один.
 */
export function Chip({
  label,
  color,
  onPress,
  selected,
}: {
  label: string;
  color?: string;
  onPress?: () => void;
  selected?: boolean;
}) {
  const c = useColors();
  if (onPress) return <FilterChip label={label} selected={!!selected} onPress={onPress} />;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 6,
        height: 28,
        paddingHorizontal: 11,
        borderRadius: 14,
        backgroundColor: c.sunk,
      }}
    >
      {color ? <View style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: color }} /> : null}
      <T v="sub" size={14} weight={700} tone="text2" scale={false} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

export function Segmented<V extends string>(props: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  return <UiSegmented {...props} />;
}

export function Row({ children, gap = spacing.sm }: { children: ReactNode; gap?: number }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap }}>{children}</View>;
}
