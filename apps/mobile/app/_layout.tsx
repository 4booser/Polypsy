import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "@/auth/AuthContext";
import { LangProvider, useLang } from "@/lang";
import { ThemeProvider } from "@/theme";
import { TextScaleProvider } from "@/textScale";
import { api } from "@/api/client";
import { AppLock } from "@/components/AppLock";
import { useColors } from "@/theme";
import { useScreenTelemetry } from "@/telemetry/screens";
import { API_URL } from "@/config";
import { tokenStorage } from "@/storage";
import { createMobileTelemetry, type ErrorUtilsLike } from "@/telemetry";

/*
 * Ошибки приложения — в «Помилки клієнта» техпанели (src/telemetry.ts).
 *
 * Заводится при загрузке модуля, а не в эффекте: падение при самой первой
 * отрисовке — тоже падение, и эффект до него не доживёт. Экран — адресом
 * expo-router, приведённым к шаблону; его RootLayout обновляет при каждом
 * переходе.
 */
let currentRoute = "/";
const telemetry = createMobileTelemetry({
  apiUrl: API_URL,
  release: Constants.expoConfig?.version,
  os: Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : undefined,
  getToken: () => tokenStorage.get(),
  currentRoute: () => currentRoute,
});
telemetry.install((globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils);

export default function RootLayout() {
  const pathname = usePathname();
  useEffect(() => {
    currentRoute = pathname;
  }, [pathname]);

  /*
   * Синхронизация: при старте, по возвращению приложения на передний план и
   * раз в 45 секунд, пока очередь непуста. Отдельного NetInfo нет — неудачная
   * попытка дешёвая (первый же сетевой отказ останавливает прогон).
   */
  useEffect(() => {
    /*
     * Отметка устройства идёт вместе с прогоном очереди: оба нужны ровно
     * тогда, когда появилась сеть. Если сервер просит стереть локальные
     * данные — приложение стирает их и выходит из учётной записи.
     */
    const sync = () => {
      void api.deviceCheckin(null).catch(() => {});
      void api.flushQueue().catch(() => {});
    };

    sync();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") sync();
    });
    const timer = setInterval(() => {
      if (api.pendingCount() > 0) void api.flushQueue().catch(() => {});
    }, 45_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
      <LangProvider>
      <TextScaleProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        {/* замок оборачивает всё приложение: он про экран, а не про отдельный маршрут */}
        <AppLock>
          <RootStack />
        </AppLock>
      </AuthProvider>
      </TextScaleProvider>
      </LangProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function RootStack() {
  const { ut } = useLang();
  const c = useColors();
  // какие экраны открывают — шаблоном маршрута, без людей и адресов (src/telemetry)
  useScreenTelemetry();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // шапка должна следовать теме — иначе на тёмной теме она остаётся белой
        headerStyle: { backgroundColor: c.card },
        headerTitleStyle: { color: c.text },
        headerTintColor: c.primary,
        contentStyle: { backgroundColor: c.bg },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
      <Stack.Screen name="consent" />
      <Stack.Screen name="(app)" />
      <Stack.Screen name="survey/[id]" options={{ headerShown: true, title: ut("mnav.instrument") }} />
      <Stack.Screen name="analytics" />
    </Stack>
  );
}
