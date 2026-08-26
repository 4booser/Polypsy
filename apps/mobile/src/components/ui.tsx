import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { radius, spacing, useColors } from "../theme";

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: c.card,
          borderColor: c.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.md,
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

export function Title({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={{ color: c.text, fontSize: 22, fontWeight: "700" }}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const c = useColors();
  return <Text style={{ color: muted ? c.muted : c.text, fontSize: 15, lineHeight: 21 }}>{children}</Text>;
}

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
  const c = useColors();
  const isDisabled = disabled || loading;
  const bg = variant === "primary" ? c.primary : variant === "danger" ? c.danger : "transparent";
  const fg = variant === "secondary" ? c.text : c.primaryText;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => ({
        backgroundColor: bg,
        borderColor: variant === "secondary" ? c.border : bg,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.sm,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        alignItems: "center",
        opacity: isDisabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontWeight: "600", fontSize: 15 }}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const c = useColors();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
      <TextInput
        placeholderTextColor={c.muted}
        {...props}
        style={{
          backgroundColor: c.card,
          borderColor: c.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.sm,
          padding: spacing.md,
          color: c.text,
          fontSize: 15,
        }}
      />
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  const c = useColors();
  if (!children) return null;
  return <Text style={{ color: c.danger, fontSize: 14 }}>{children}</Text>;
}

export function Loader() {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
      <ActivityIndicator size="large" color={c.primary} />
    </View>
  );
}

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
  const tint = color ?? c.muted;
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs,
        alignSelf: "flex-start",
        borderColor: selected ? c.primary : c.border,
        borderWidth: 1,
        borderRadius: radius.sm,
        backgroundColor: selected ? c.primary : "transparent",
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
      }}
    >
      {color ? <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: tint }} /> : null}
      <Text style={{ color: selected ? c.primaryText : c.text, fontSize: 12, fontWeight: "600" }}>
        {label}
      </Text>
    </View>
  );
  return onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: c.cardAlt,
        borderRadius: radius.sm,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: spacing.sm,
              borderRadius: radius.sm - 2,
              backgroundColor: active ? c.card : "transparent",
            }}
          >
            <Text style={{ color: active ? c.text : c.muted, fontSize: 13, fontWeight: "600" }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Divider() {
  const c = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

export function Row({ children, gap = spacing.sm }: { children: ReactNode; gap?: number }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap }}>{children}</View>;
}

export function Empty({ text }: { text: string }) {
  return (
    <Card>
      <Body muted>{text}</Body>
    </Card>
  );
}
