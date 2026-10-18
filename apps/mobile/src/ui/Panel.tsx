import type { ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { radius, useColors, useShadows, type Colors } from "../theme";
import { Icon, type IconName } from "./Icon";
import { T } from "./Text";

/** Тон квадрата со значком и подсказки: фиолетовый по умолчанию, статусы — по смыслу */
export type Tone = "v" | "risk" | "warn" | "good" | "info" | "n";

export function toneColors(c: Colors, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case "risk":
      return { bg: c.risktint, fg: c.riskink };
    case "warn":
      return { bg: c.warntint, fg: c.warn };
    case "good":
      return { bg: c.goodtint, fg: c.good };
    case "info":
      return { bg: c.infotint, fg: c.info };
    case "n":
      return { bg: c.sunk, fg: c.muted };
    default:
      return { bg: c.vtint, fg: c.vink };
  }
}

/** Квадрат 32 со значком — голова панели, строка настроек, заметка */
export function Squircle({ icon, tone = "v", size = 32 }: { icon: IconName; tone?: Tone; size?: number }) {
  const c = useColors();
  const t = toneColors(c, tone);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.31),
        backgroundColor: t.bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.56)} color={t.fg} />
    </View>
  );
}

/**
 * Панель: лист с рамкой, скругление 14. Голова — квадрат со значком,
 * заголовок, подпись и действие справа; тело — с отступом или вплотную
 * (pad={false} — для списка строк).
 */
export function Panel({
  title,
  icon,
  tone,
  sub,
  right,
  pad = true,
  children,
  style,
}: {
  title?: string;
  icon?: IconName;
  tone?: Tone;
  sub?: string;
  right?: ReactNode;
  pad?: boolean;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
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
          overflow: "hidden",
        },
        style,
      ]}
    >
      {title ? (
        <View
          accessibilityRole="header"
          style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 60, paddingTop: 12, paddingRight: 12, paddingBottom: 10, paddingLeft: 14 }}
        >
          {icon ? <Squircle icon={icon} tone={tone} /> : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="headline" size={17}>
              {title}
            </T>
            {sub ? <T v="sub">{sub}</T> : null}
          </View>
          {right}
        </View>
      ) : null}
      {pad ? <View style={{ paddingHorizontal: 16, paddingBottom: 16, paddingTop: title ? 4 : 16, gap: 8 }}>{children}</View> : children}
    </View>
  );
}

/** Заголовок раздела над списком — 18/24, справа счётчик или ссылка */
export function SectionHead({ title, right, sub }: { title: string; right?: ReactNode; sub?: string }) {
  return (
    <View style={{ paddingTop: 20, paddingHorizontal: 20, paddingBottom: 10 }}>
      <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <T v="section" style={{ flex: 1 }}>
          {title}
        </T>
        {right}
      </View>
      {sub ? <T v="sub">{sub}</T> : null}
    </View>
  );
}

/** Скруглённый список строк — 16, рамка, строки через разделитель */
export function List({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View
      style={[
        {
          marginHorizontal: 16,
          borderRadius: radius.tile,
          backgroundColor: c.panel,
          borderWidth: 1,
          borderColor: c.border,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Строка списка, не ниже 64: слева значок или аватар, жирный заголовок,
 * подпись, текст, плашки; справа шеврон или своё. tone="risk" — строка риска
 * на красной подложке.
 */
export function ListRow({
  title,
  sub,
  body,
  chips,
  lead,
  end,
  chevron,
  onPress,
  first,
  tone,
  unread,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  sub?: string;
  body?: string;
  chips?: ReactNode;
  lead?: ReactNode;
  end?: ReactNode;
  /** Шеврон справа — строка ведёт дальше */
  chevron?: boolean;
  onPress?: () => void;
  /** Первая строка без разделителя сверху */
  first?: boolean;
  tone?: "risk";
  unread?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const c = useColors();
  const inner = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 12,
        minHeight: 64,
        paddingTop: 12,
        paddingRight: 14,
        paddingBottom: 13,
        paddingLeft: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.divider,
        backgroundColor: tone === "risk" ? c.risktint : pressed ? c.panel2 : "transparent",
      }}
    >
      {unread ? (
        <View style={{ position: "absolute", left: 6, top: 21, width: 7, height: 7, borderRadius: 4, backgroundColor: c.vink }} />
      ) : null}
      {lead}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="headline">{title}</T>
        {sub ? <T v="sub">{sub}</T> : null}
        {body ? (
          <T v="note" style={{ marginTop: 4 }}>
            {body}
          </T>
        ) : null}
        {chips ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>{chips}</View> : null}
      </View>
      {end}
      {chevron ? (
        <View style={{ alignSelf: "center" }}>
          <Icon name="chevron-right" size={20} color={c.muted} />
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return inner(false);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, sub].filter(Boolean).join(". ")}
      accessibilityHint={accessibilityHint}
    >
      {({ pressed }) => inner(pressed)}
    </Pressable>
  );
}

/**
 * Подсказка: значок и текст на мягкой подложке. kind — смысл: info сведения,
 * warn «требует внимания», risk только риск, good сделано, line — без
 * подложки, обведённая.
 */
export function Callout({
  title,
  text,
  icon = "info",
  kind = "n",
  children,
}: {
  title?: string;
  text?: string;
  icon?: IconName;
  kind?: "v" | "info" | "warn" | "risk" | "good" | "line" | "n";
  children?: ReactNode;
}) {
  const c = useColors();
  const t = kind === "line" ? { bg: "transparent", fg: c.vink } : toneColors(c, kind === "n" ? "n" : kind);
  return (
    <View
      style={[
        { flexDirection: "row", gap: 10, paddingVertical: 13, paddingHorizontal: 14, borderRadius: radius.panel, backgroundColor: kind === "n" ? c.sunk : t.bg },
        kind === "line" ? { borderWidth: 1.5, borderColor: c.ctl } : null,
      ]}
    >
      <View style={{ marginTop: 2 }}>
        <Icon name={icon} size={18} color={kind === "n" ? c.vink : t.fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? (
          <T v="headline" color={kind === "v" || kind === "line" || kind === "n" ? c.text : t.fg}>
            {title}
          </T>
        ) : null}
        {text ? <T v="note">{text}</T> : null}
        {children}
      </View>
    </View>
  );
}
