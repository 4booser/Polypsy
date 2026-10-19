import { Pressable, View } from "react-native";
import { useColors, useShadows } from "../theme";
import { T } from "./Text";

/**
 * Переключатель: утопленная дорожка, выбранный сегмент — лист с тенью и
 * фиолетовой подписью. Высота с дорожкой — 44, цель нажатия набора.
 *
 * Роль radiogroup/radio: диктор называет и выбор, и сколько вариантов.
 */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  accessibilityLabel,
  onBand,
}: {
  value: V;
  options: { value: V; label: string; count?: number }[];
  onChange: (value: V) => void;
  accessibilityLabel?: string;
  /** На полосе шапки — дорожка цвета карточки полосы */
  onBand?: boolean;
}) {
  const c = useColors();
  const sh = useShadows();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[
        { flexDirection: "row", padding: 3, gap: 2, borderRadius: 12, backgroundColor: onBand ? c.bcard : c.sunk },
        onBand ? { borderWidth: 1, borderColor: c.bcardline } : null,
      ]}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityLabel={o.count === undefined ? o.label : `${o.label}: ${o.count}`}
            accessibilityState={{ checked: on }}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 38,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              // 6, как у широкого переключателя набора (.seg-w): три подписи со счётчиком влезают в 390 без многоточия
              paddingHorizontal: 6,
              borderRadius: 9,
              backgroundColor: on ? c.panel : pressed ? c.sunk2 : "transparent",
              boxShadow: on ? sh.tile : undefined,
            })}
          >
            <Txt label={o.label} on={on} />
            {o.count !== undefined ? <Txt label={String(o.count)} on={on} muted /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Txt({ label, on, muted }: { label: string; on: boolean; muted?: boolean }) {
  const c = useColors();
  return (
    <T
      v="sub"
      size={14}
      weight={700}
      color={on ? c.vink : muted ? c.muted : c.text2}
      num={muted}
      scale={false}
      numberOfLines={1}
    >
      {label}
    </T>
  );
}
