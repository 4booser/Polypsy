import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Адрес API. В дев-режиме берём хост Metro-сервера, чтобы приложение
 * на телефоне/эмуляторе достучалось до машины разработчика, а не до своего localhost.
 */
function resolveApiUrl(): string {
  const configured = Constants.expoConfig?.extra?.apiUrl as string | undefined;
  const port = configured ? new URL(configured).port || "3001" : "3001";

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri?.split(":")[0];

  if (host && host !== "localhost" && host !== "127.0.0.1") {
    return `http://${host}:${port}`;
  }
  if (Platform.OS === "android") {
    // localhost внутри Android-эмулятора — это сам эмулятор
    return `http://10.0.2.2:${port}`;
  }
  return configured ?? `http://localhost:${port}`;
}

export const API_URL = resolveApiUrl();
