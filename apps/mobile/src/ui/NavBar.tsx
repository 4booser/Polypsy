import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLang } from "../lang";
import { useColors } from "../theme";
import { HelpSheet } from "./HelpSheet";
import { Icon } from "./Icon";
import { T } from "./Text";

/**
 * Верх экрана на фиолетовой полосе: строка навигации 44 и, у корневых
 * экранов, крупный заголовок 30.
 *
 *  — слева «‹ Назад» с именем экрана, куда вернёт, или текстовая кнопка
 *    («Пізніше», «Закрити»);
 *  — по центру компактный заголовок — у вложенных экранов;
 *  — справа «Допомога» у пациента, своё действие у сотрудника.
 *
 * Полоса доходит до верхнего края: строка состояния лежит на ней же, без
 * белой щели над шапкой.
 */
export function NavBar({
  title,
  large,
  lead,
  left,
  back,
  right,
  children,
  below,
  flush,
}: {
  title?: string;
  /** Крупный заголовок вместо компактного — корневые экраны */
  large?: boolean;
  /** Подзаголовок под крупным заголовком */
  lead?: string;
  /** Своё слева — заменяет «назад» */
  left?: ReactNode;
  back?: { label: string; onPress: () => void };
  right?: ReactNode;
  /** Под крупным заголовком на полосе: переключатель, фильтры */
  children?: ReactNode;
  /** Последним на полосе, во всю её ширину: полоса «нет связи» */
  below?: ReactNode;
  /**
   * Без черты снизу: под шапкой экран продолжает полосу своим крупным
   * заголовком (Hero экрана пациента), и черта легла бы посреди полосы.
   */
  flush?: boolean;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const leftNode = left ?? (back ? <BackButton label={back.label} onPress={back.onPress} /> : null);
  const row = leftNode || right || (title && !large);
  /*
   * Заголовок — по центру экрана, а не по центру промежутка: стороны
   * разной ширины («Закрити» и «Допомога») сдвинули бы его вбок. Поэтому он
   * лежит поверх строки с отступом по более широкой стороне и обрезается
   * многоточием, а не наезжает на кнопки.
   */
  const [sides, setSides] = useState({ l: 0, r: 0 });
  const inset = 8 + Math.max(sides.l, sides.r) + 6;

  return (
    <View style={{ backgroundColor: c.band, paddingTop: insets.top, borderBottomWidth: flush ? 0 : 1, borderBottomColor: c.bcardline }}>
      {row ? (
        <View style={{ height: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8 }}>
          {title && !large ? (
            <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: inset, right: inset, justifyContent: "center" }}>
              <T v="navTitle" numberOfLines={1} accessibilityRole="header" center>
                {title}
              </T>
            </View>
          ) : null}
          <View
            onLayout={(e) => {
              const l = Math.round(e.nativeEvent.layout.width);
              setSides((s) => (s.l === l ? s : { ...s, l }));
            }}
            style={{ maxWidth: "42%" }}
          >
            {leftNode}
          </View>
          <View
            onLayout={(e) => {
              const r = Math.round(e.nativeEvent.layout.width);
              setSides((s) => (s.r === r ? s : { ...s, r }));
            }}
            style={{ maxWidth: "50%" }}
          >
            {right}
          </View>
        </View>
      ) : (
        <View style={{ height: 8 }} />
      )}
      {large && title ? (
        <View style={{ paddingTop: 2, paddingHorizontal: 20, paddingBottom: children ? 16 : 20 }}>
          <T v="largeTitle" accessibilityRole="header">
            {title}
          </T>
          {lead ? (
            <T v="lead" style={{ marginTop: 6 }}>
              {lead}
            </T>
          ) : null}
          {children ? <View style={{ marginTop: 14 }}>{children}</View> : null}
        </View>
      ) : children ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 14 }}>{children}</View>
      ) : null}
      {below}
    </View>
  );
}

/** «‹ Назад» — шеврон и имя экрана, куда вернёт; цель 44 */
export function BackButton({ label, onPress, accessibilityLabel }: { label: string; onPress: () => void; accessibilityLabel?: string }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        minHeight: 44,
        paddingLeft: 2,
        paddingRight: 10,
        borderRadius: 12,
        backgroundColor: pressed ? c.tabhov : "transparent",
        maxWidth: "100%",
      })}
    >
      <Icon name="chevron-left" size={26} color={c.vink} />
      <T v="body" size={17} weight={600} color={c.vink} scale={false} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </T>
    </Pressable>
  );
}

/** Текстовая кнопка шапки: «Пізніше», «Закрити», «Готово» */
export function NavTextButton({
  label,
  onPress,
  strong,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  /** «Готово» — жирнее: это завершение, а не уход */
  strong?: boolean;
  accessibilityLabel?: string;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: pressed ? c.tabhov : "transparent",
      })}
    >
      <T v="body" size={17} weight={strong ? 800 : 600} color={c.vink} scale={false} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

/**
 * «Допомога» — всегда в шапке пациента. Открывает лист с номерами, которые
 * звонят сразу, планом безопасности и перепиской. В кризис его не ищут по
 * экранам: он там же, где человек находится.
 */
export function HelpPill() {
  const c = useColors();
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={ut("mui.help")}
        accessibilityHint={ut("mui.helpTitle")}
        accessibilityState={{ expanded: open }}
        style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}
      >
        {({ pressed }) => (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 11,
              paddingRight: 14,
              borderRadius: 18,
              borderWidth: 1,
              borderColor: c.bcardline,
              backgroundColor: pressed ? c.vtint2 : c.bcard,
            }}
          >
            <Icon name="life-buoy" size={18} color={c.vink} />
            <T v="body" size={15} weight={700} color={c.vink} scale={false}>
              {ut("mui.help")}
            </T>
          </View>
        )}
      </Pressable>
      <HelpSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}
