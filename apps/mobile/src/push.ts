import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { api } from "./api/client";

/**
 * Пуш-уведомления.
 *
 * Разрешение спрашивается не при первом запуске, а когда человеку уже
 * назначили обследование: запрос без контекста отклоняют, и второй раз
 * система его не покажет. Отказ не ломает ничего — приложение продолжает
 * работать, просто молча.
 *
 * На эмуляторе токен не выдаётся вовсе, и это нормальный путь, а не ошибка.
 */

let registered = false;

export async function ensurePushRegistered(): Promise<boolean> {
  if (registered) return true;
  if (!Device.isDevice) return false;

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== "granted") return false;

  /*
   * projectId нужен Expo, чтобы выдать токен: без него вызов падает на
   * сборках, собранных не через EAS. Отсутствие — не ошибка приложения.
   */
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;

  try {
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await api.registerPush(token.data, Platform.OS === "ios" ? "ios" : "android");
    registered = true;
    return true;
  } catch {
    // ни токена, ни сети — приложение работает дальше, просто молча
    return false;
  }
}

/** При выходе токен отвязывается: на общем планшете это обязательно */
export async function forgetPush(): Promise<void> {
  registered = false;
  if (!Device.isDevice) return;
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await api.forgetPush(token.data);
  } catch {
    /* устройство и так не зарегистрировано */
  }
}

/**
 * Как показывать уведомление, когда приложение открыто.
 *
 * Показываем: человек мог открыть приложение по другому поводу, а назначение
 * или тревога от этого не перестают быть срочными.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});
