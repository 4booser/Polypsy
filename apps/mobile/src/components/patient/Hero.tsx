import type { ReactNode } from "react";
import { View } from "react-native";
import { useColors } from "../../theme";
import { T } from "../../ui/Text";

/**
 * Крупный заголовок экрана пациента на фиолетовой полосе — внутри
 * прокрутки, а не в шапке (как в утверждённом экране методики): заголовок,
 * подзаголовок и то, что относится ко всему экрану, — строка открытого,
 * переключатель, карточка «от кого», плашка состояния.
 *
 * Шапка над ним (NavBar flush) — та же полоса без черты, поэтому заголовок
 * читается её продолжением. Сверху полосой залита и область «оттягивания»
 * прокрутки на iPhone: иначе под шапкой мелькала бы земля экрана.
 */
export function Hero({
  title,
  lead,
  mark,
  children,
  compact,
}: {
  title?: string;
  lead?: string;
  /** Знак слева от заголовка: квадрат с ключом, галочка «надіслано» */
  mark?: ReactNode;
  /** Под подзаголовком: строка открытого, переключатель, карточка */
  children?: ReactNode;
  /** Меньше отступ снизу — когда под заголовком переключатель */
  compact?: boolean;
}) {
  const c = useColors();
  return (
    <View
      style={{
        backgroundColor: c.band,
        paddingTop: 2,
        paddingHorizontal: 20,
        paddingBottom: compact ? 16 : 20,
        borderBottomWidth: 1,
        borderBottomColor: c.bcardline,
      }}
    >
      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: -600, height: 600, backgroundColor: c.band }} />
      {title ? (
        mark ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            {mark}
            <T v="largeTitle" accessibilityRole="header" style={{ flex: 1 }}>
              {title}
            </T>
          </View>
        ) : (
          <T v="largeTitle" accessibilityRole="header">
            {title}
          </T>
        )
      ) : null}
      {lead ? (
        <T v="lead" style={{ marginTop: title ? 6 : 0 }}>
          {lead}
        </T>
      ) : null}
      {children}
    </View>
  );
}

/** Строка плашек под заголовком: «Редакція від…», «надіслано о 14:12» */
export function HeroMeta({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 12, rowGap: 8, marginTop: 12 }}>{children}</View>;
}

/**
 * Карточка полосы: «Ірина Савчук просить пройти», имя и почта в профиле.
 * Лист цвета карточки полосы, скругление 18.
 */
export function BandCard({ children, style }: { children: ReactNode; style?: object }) {
  const c = useColors();
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 14,
          marginTop: 16,
          paddingTop: 14,
          paddingHorizontal: 16,
          paddingBottom: 15,
          borderRadius: 18,
          backgroundColor: c.bcard,
          borderWidth: 1,
          borderColor: c.bcardline,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
