import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors, useShadows } from "../theme";
import { Icon, type IconName } from "./Icon";
import { T } from "./Text";

/**
 * Минимальная цель нажатия — 44 pt, порог руководств Apple и Google. Видимая
 * кнопка бывает ниже (36), но область нажатия добирается отступом.
 */
export const TARGET = 44;

/**
 * Кнопка набора.
 *
 *  — primary: фиолетовая заливка с тенью, одна на область — главное действие;
 *  — secondary: мягкая фиолетовая заливка — всё остальное. Обводки нет:
 *    обведённая кнопка в наборе — только на подкрашенной поверхности (outline);
 *  — ghost: без заливки — «Скасувати», ссылка-действие;
 *  — risk: красная — только риск для человека (103, «Розібрати»). Удаление и
 *    выход — обычная secondary с подтверждением.
 *
 * Высота: l 52 (действие внизу экрана), m 48 (в листе и панели), d 44
 * (по умолчанию), s 36 (в строке; цель нажатия всё равно 44).
 */
export type BtnKind = "primary" | "secondary" | "ghost" | "risk" | "outline";
export type BtnSize = "l" | "m" | "d" | "s";

const H: Record<BtnSize, number> = { l: 52, m: 48, d: 44, s: 36 };
const FS: Record<BtnSize, number> = { l: 17, m: 15, d: 15, s: 14 };
const R: Record<BtnSize, number> = { l: 14, m: 12, d: 12, s: 10 };
const ICON: Record<BtnSize, number> = { l: 20, m: 18, d: 18, s: 16 };

export function Btn({
  title,
  onPress,
  kind = "secondary",
  size = "d",
  icon,
  iconEnd = false,
  loading,
  disabled,
  full,
  flex,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  /** Подпись; пустая — кнопка-значок, тогда accessibilityLabel обязателен */
  title?: string;
  onPress: () => void;
  kind?: BtnKind;
  size?: BtnSize;
  icon?: IconName;
  /** Значок после подписи: «Далі ›» */
  iconEnd?: boolean;
  loading?: boolean;
  disabled?: boolean;
  /** Во всю ширину */
  full?: boolean;
  /** Доля в ряду кнопок: «Назад» 1, «Далі» 2 */
  flex?: number;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const sh = useShadows();
  const off = disabled || loading;
  const h = H[size];

  const bg = (pressed: boolean): string => {
    switch (kind) {
      case "primary":
        return pressed ? c.vhov : c.v;
      case "risk":
        return pressed ? c.riskink : c.risk;
      case "ghost":
        return pressed ? c.vtint : "transparent";
      case "outline":
        return pressed ? c.vtint : c.panel;
      default:
        return pressed ? c.vtint2 : c.vtint;
    }
  };
  const fg = kind === "primary" || kind === "risk" ? c.onfill : c.vink;
  const iconOnly = !title;

  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      // busy отдельно от disabled: голосовой доступ читает «занято», а не
      // «недоступно» — для человека это разные ситуации
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      hitSlop={h < TARGET ? { top: (TARGET - h) / 2, bottom: (TARGET - h) / 2 } : undefined}
      style={({ pressed }) => [
        {
          height: h,
          minWidth: iconOnly ? h : undefined,
          paddingHorizontal: iconOnly ? 0 : size === "s" ? 12 : size === "l" ? 20 : 16,
          borderRadius: R[size],
          flexDirection: iconEnd ? "row-reverse" : "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          backgroundColor: bg(pressed && !off),
          opacity: off && !loading ? 0.48 : 1,
          boxShadow: kind === "primary" && !off ? sh.primary : undefined,
          transform: pressed && !off ? [{ translateY: 1 }] : undefined,
        },
        kind === "outline" ? { borderWidth: 1, borderColor: c.ctl } : null,
        full ? { alignSelf: "stretch" } : null,
        flex ? { flex } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={ICON[size]} color={fg} /> : null}
          {title ? (
            <T v="body" weight={700} size={FS[size]} color={fg} scale={false} numberOfLines={1}>
              {title}
            </T>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

/** Ряд кнопок внизу экрана над домашней полосой: «Назад» и «Далі» */
export function ActionBar({ children }: { children: React.ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 10,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: Math.max(12, insets.bottom),
        backgroundColor: c.panel,
        borderTopWidth: 1,
        borderTopColor: c.divider,
      }}
    >
      {children}
    </View>
  );
}
