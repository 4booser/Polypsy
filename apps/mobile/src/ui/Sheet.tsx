import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLang } from "../lang";
import { radius, useColors, useShadows } from "../theme";
import { Icon } from "./Icon";
import { EASE_OUT, NATIVE_DRIVER, useReducedMotion } from "./motion";
import { T } from "./Text";

/**
 * Лист снизу — телефонная форма выдвижной панели консоли.
 *
 * Поднимается над затемнением, сверху «ручка», заголовок и крестик 44.
 * Закрывается крестиком, нажатием на затемнение и системной кнопкой «назад».
 * dismissible={false} — шаг, который надо закончить (подтвердить выход с
 * неотправленными ответами): тогда закрывают только свои кнопки листа.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  sub,
  children,
  dismissible = true,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  children?: ReactNode;
  dismissible?: boolean;
  /** Кнопки под содержимым, вне прокрутки */
  footer?: ReactNode;
}) {
  const c = useColors();
  const sh = useShadows();
  const { ut } = useLang();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: reduced ? 0 : visible ? 300 : 200,
      easing: EASE_OUT,
      useNativeDriver: NATIVE_DRIVER,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, reduced, anim]);

  if (!mounted) return null;
  const close = dismissible ? onClose : () => {};

  return (
    <Modal transparent visible animationType="none" onRequestClose={close} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: anim }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel={ut("common.close")}
          importantForAccessibility={dismissible ? "auto" : "no"}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={title}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "92%",
          backgroundColor: c.panel,
          borderTopLeftRadius: radius.sheet,
          borderTopRightRadius: radius.sheet,
          boxShadow: sh.sheet,
          paddingBottom: Math.max(16, insets.bottom),
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [640, 0] }) }],
        }}
      >
        <View style={{ alignSelf: "center", width: 36, height: 5, marginTop: 8, borderRadius: 3, backgroundColor: c.ctl }} />
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingTop: 12, paddingRight: 12, paddingBottom: 14, paddingLeft: 20 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="sheetTitle" accessibilityRole="header">
              {title}
            </T>
            {sub ? (
              <T v="note" style={{ marginTop: 4 }}>
                {sub}
              </T>
            ) : null}
          </View>
          {dismissible ? (
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={ut("common.close")}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: radius.panel,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? c.sunk2 : c.sunk,
              })}
            >
              <Icon name="x" size={20} color={c.text2} />
            </Pressable>
          ) : null}
        </View>
        <ScrollView bounces={false} contentContainerStyle={{ paddingBottom: footer ? 0 : 4 }}>
          {children}
        </ScrollView>
        {footer ? <View style={{ gap: 8, paddingHorizontal: 16, paddingTop: 12 }}>{footer}</View> : null}
      </Animated.View>
    </Modal>
  );
}
