import { Pressable, View } from "react-native";
import { SEVERITY_KEY, type Severity } from "@quizzy/shared";
import { useLang } from "../lang";
import { useColors, useSeverity, type Colors } from "../theme";
import { Icon, type IconName } from "./Icon";
import { T } from "./Text";

/**
 * Плашка состояния — 28, скругление 14, значок и слово.
 *
 *  risk — только риск для человека; riskOutline — передано дежурному;
 *  warn — требует внимания (просрочено, неявка, не принято);
 *  v — моё, назначено, выбрано; info — сведения; good — сделано;
 *  n — нейтральное (результат, черновик, завершено).
 */
export type PillKind = "risk" | "riskOutline" | "warn" | "v" | "info" | "good" | "n" | "done";

function pillColors(c: Colors, kind: PillKind): { bg: string; fg: string; line?: string } {
  switch (kind) {
    case "risk":
      return { bg: c.risktint2, fg: c.riskink };
    case "riskOutline":
      return { bg: "transparent", fg: c.riskink, line: c.riskline };
    case "warn":
      return { bg: c.warntint2, fg: c.warn };
    case "v":
      return { bg: c.vtint, fg: c.vink };
    case "info":
      return { bg: c.infotint, fg: c.info };
    case "good":
      return { bg: c.goodtint, fg: c.good };
    case "done":
      return { bg: c.sunk, fg: c.muted };
    default:
      return { bg: c.sunk, fg: c.text2 };
  }
}

export function Pill({ label, kind = "n", icon }: { label: string; kind?: PillKind; icon?: IconName }) {
  const c = useColors();
  const t = pillColors(c, kind);
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
          gap: 6,
          height: 28,
          paddingLeft: icon ? 9 : 11,
          paddingRight: 11,
          borderRadius: 14,
          backgroundColor: t.bg,
        },
        t.line ? { borderWidth: 1, borderColor: t.line } : null,
      ]}
    >
      {icon ? <Icon name={icon} size={15} color={t.fg} /> : null}
      <T v="sub" size={14} weight={700} color={t.fg} scale={false} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

/**
 * Выраженность словом на подложке своей ступени — цвет никогда не говорит
 * один. label — слово полосы методики («помірна»), без него — слово степени
 * из словаря. step (0…4) — ступень набора, если у методики их пять.
 */
export function SevPill({
  severity,
  step,
  label,
  small,
}: {
  severity?: Severity;
  step?: 0 | 1 | 2 | 3 | 4;
  label?: string;
  small?: boolean;
}) {
  const s = useSeverity();
  const { ut } = useLang();
  const fg = step !== undefined ? s.steps[step]! : s.color[severity ?? "none"];
  const bg = step !== undefined ? s.stepTints[step]! : s.tint[severity ?? "none"];
  const text = label ?? (severity ? ut(SEVERITY_KEY[severity]) : "");
  const h = small ? 24 : 30;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        justifyContent: "center",
        height: h,
        paddingHorizontal: small ? 9 : 13,
        borderRadius: h / 2,
        backgroundColor: bg,
      }}
    >
      <T v="sub" size={small ? 12.5 : 14} weight={700} color={fg} scale={false} numberOfLines={1}>
        {text}
      </T>
    </View>
  );
}

/** Счётчик: r — риск, v — моё, t — мягкий фиолетовый, без вида — нейтральный */
export function Count({ n, kind }: { n: number | string; kind?: "r" | "v" | "t" }) {
  const c = useColors();
  const bg = kind === "r" ? c.risk : kind === "v" ? c.v : kind === "t" ? c.vtint : c.sunk;
  const fg = kind === "r" || kind === "v" ? c.onfill : kind === "t" ? c.vink : c.text2;
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: 7,
        borderRadius: 11,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T v="caption" size={12} weight={800} color={fg} num scale={false}>
        {n}
      </T>
    </View>
  );
}

/**
 * Пилюля-фильтр в ряду над списком — 36, выбранная залита фиолетовым.
 * Число рядом — сколько строк за ней.
 */
export function FilterChip({
  label,
  count,
  selected,
  onPress,
  onBand,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onPress: () => void;
  /** На полосе шапки лист другой — карточка полосы */
  onBand?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={count === undefined ? label : `${label}: ${count}`}
      accessibilityState={{ selected }}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          height: 36,
          paddingHorizontal: 13,
          borderRadius: 18,
          backgroundColor: selected ? c.v : pressed ? c.panel2 : onBand ? c.bcard : c.panel,
        },
        selected ? null : { borderWidth: 1, borderColor: onBand ? c.bcardline : c.border },
      ]}
    >
      <T v="sub" size={14} weight={700} color={selected ? c.onfill : c.text2} scale={false} numberOfLines={1}>
        {label}
      </T>
      {count !== undefined ? (
        <T v="sub" size={14} weight={700} color={selected ? c.onfill : c.muted} num scale={false}>
          {count}
        </T>
      ) : null}
    </Pressable>
  );
}
