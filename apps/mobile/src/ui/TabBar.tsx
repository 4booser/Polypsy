import { Pressable, View } from "react-native";
import type { BottomTabBarProps } from "expo-router/js-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "../theme";
import { Icon, type IconName } from "./Icon";
import { T } from "./Text";

/**
 * Значок вкладки по имени маршрута. Вкладки пациента и сотрудника — как в
 * наборе (kit/shell.py, M_TABS); маршрут без значка получает круг-профиль, а
 * не пустое место.
 */
const TAB_ICON: Record<string, IconName> = {
  home: "house",
  booking: "calendar-plus",
  surveys: "clipboard-check",
  health: "heart-pulse",
  profile: "circle-user-round",
  rounds: "route",
  insights: "chart-line",
  alerts: "triangle-alert",
  patients: "users",
  messages: "messages-square",
};

/**
 * Панель вкладок «Виразной»: значок в пилюле 52×30 — у текущей залитой
 * фиолетовым, — подпись под ним и счётчик в углу. Текущая вкладка читается
 * и пилюлей, и жирной подписью, а не одним цветом.
 *
 * Вкладки с href: null (переписка, очередь, план) не рисуются — это экраны,
 * а не вкладки. Нажатие идёт тем же событием tabPress, что у стандартной
 * панели: перехват «Аналітики» в (app)/_layout.tsx работает как раньше.
 */
export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        paddingTop: 6,
        paddingHorizontal: 4,
        paddingBottom: Math.max(insets.bottom, 8),
        backgroundColor: c.panel,
        borderTopWidth: 1,
        borderTopColor: c.divider,
      }}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key]!;
        const itemStyle = options.tabBarItemStyle as { display?: string } | undefined;
        if (itemStyle?.display === "none") return null;

        const focused = state.index === index;
        const label =
          typeof options.tabBarLabel === "string" ? options.tabBarLabel : (options.title ?? route.name);
        const badge = options.tabBarBadge;
        const badgeBg = (options.tabBarBadgeStyle as { backgroundColor?: string } | undefined)?.backgroundColor;

        const onPress = () => {
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
            accessibilityRole="tab"
            accessibilityLabel={badge !== undefined ? `${label}, ${badge}` : label}
            accessibilityState={{ selected: focused }}
            style={{ flex: 1, minWidth: 0, minHeight: 50, alignItems: "center", gap: 3 }}
          >
            {({ pressed }) => (
              <>
                <View
                  style={{
                    width: 52,
                    height: 30,
                    borderRadius: 15,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: focused ? c.v : pressed ? c.vtint : "transparent",
                  }}
                >
                  <Icon name={TAB_ICON[route.name] ?? "circle-user-round"} size={21} color={focused ? c.onfill : c.muted} />
                </View>
                <T
                  v="caption"
                  size={11.5}
                  weight={focused ? 800 : 600}
                  color={focused ? c.vink : c.text2}
                  scale={false}
                  numberOfLines={1}
                  style={{ lineHeight: 14 }}
                >
                  {label}
                </T>
                {badge !== undefined ? (
                  <View
                    style={{
                      position: "absolute",
                      top: -4,
                      left: "50%",
                      marginLeft: 4,
                      minWidth: 22,
                      height: 22,
                      paddingHorizontal: 5,
                      borderRadius: 11,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: badgeBg ?? c.v,
                      borderWidth: 2,
                      borderColor: c.panel,
                    }}
                  >
                    <T v="caption" size={10.5} weight={800} color={c.onfill} num scale={false} style={{ lineHeight: 14 }}>
                      {badge}
                    </T>
                  </View>
                ) : null}
              </>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
