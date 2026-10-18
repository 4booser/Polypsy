import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PALETTES } from "../palettes";
import { radius, useColors, useShadows, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";
import { EASE_OUT, NATIVE_DRIVER, useReducedMotion } from "./motion";
import { T } from "./Text";

/**
 * Всплывающее сообщение внизу экрана: «Чернетку збережено», «Записано на
 * 10.10». Тёмная плашка на светлой теме и светлая на тёмной — заметна, но не
 * перекрывает действие: висит над панелью вкладок и сама уходит.
 *
 * Действие («Повернутися», «Скасувати») держит сообщение дольше — его надо
 * успеть нажать.
 */
interface ToastOptions {
  icon?: IconName;
  action?: { label: string; onPress: () => void };
}

interface ToastState extends ToastOptions {
  id: number;
  text: string;
}

const ToastCtx = createContext<{ show: (text: string, options?: ToastOptions) => void }>({ show: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const seq = useRef(0);

  const show = useCallback((text: string, options?: ToastOptions) => {
    seq.current += 1;
    setToast({ id: seq.current, text, ...options });
    // диктор узнаёт о сообщении сразу, не разыскивая его на экране
    if (Platform.OS !== "web") AccessibilityInfo.announceForAccessibility(text);
  }, []);

  const hide = useCallback(() => setToast(null), []);
  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {toast ? <ToastView key={toast.id} toast={toast} onDone={hide} /> : null}
    </ToastCtx.Provider>
  );
}

function ToastView({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  const c = useColors();
  const sh = useShadows();
  const resolved = useTheme().resolved;
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(0)).current;
  // значок «готово» — зелёный противоположной темы: плашка у неё и цвета
  const ok = resolved === "light" ? PALETTES.dark.good : PALETTES.light.good;

  useEffect(() => {
    const step = (to: number, done?: () => void) =>
      Animated.timing(anim, {
        toValue: to,
        duration: reduced ? 0 : to ? 220 : 160,
        easing: EASE_OUT,
        useNativeDriver: NATIVE_DRIVER,
      }).start(done);
    step(1);
    const timer = setTimeout(() => step(0, onDone), toast.action ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [anim, reduced, toast.action, onDone]);

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom: insets.bottom + 96,
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 52,
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderRadius: radius.panel,
          backgroundColor: c.tipbg,
          boxShadow: sh.pop,
        }}
      >
        <Icon name={toast.icon ?? "circle-check"} size={18} color={toast.icon ? c.tipink : ok} />
        <T v="note" weight={600} color={c.tipink} style={{ flex: 1 }}>
          {toast.text}
        </T>
        {toast.action ? (
          <Pressable
            onPress={() => {
              toast.action!.onPress();
              onDone();
            }}
            accessibilityRole="button"
            accessibilityLabel={toast.action.label}
            hitSlop={12}
          >
            <T v="note" weight={800} color={c.tipink} style={{ textDecorationLine: "underline" }}>
              {toast.action.label}
            </T>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}
