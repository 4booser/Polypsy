import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { ownerOfToken, setActiveOwner, signedIn } from "./offline/owner";

const TOKEN_KEY = "quizzy.token";
const REFRESH_KEY = "quizzy.refresh";

// SecureStore недоступен в web-сборке — там падаем на localStorage
const raw =
  Platform.OS === "web"
    ? {
        get: async () => (typeof localStorage === "undefined" ? null : localStorage.getItem(TOKEN_KEY)),
        set: async (token: string) => localStorage?.setItem(TOKEN_KEY, token),
        getRefresh: async () => (typeof localStorage === "undefined" ? null : localStorage.getItem(REFRESH_KEY)),
        setRefresh: async (token: string) => localStorage?.setItem(REFRESH_KEY, token),
        clear: async () => {
          localStorage?.removeItem(TOKEN_KEY);
          localStorage?.removeItem(REFRESH_KEY);
        },
      }
    : {
        get: () => SecureStore.getItemAsync(TOKEN_KEY),
        set: (token: string) => SecureStore.setItemAsync(TOKEN_KEY, token),
        getRefresh: () => SecureStore.getItemAsync(REFRESH_KEY),
        setRefresh: (token: string) => SecureStore.setItemAsync(REFRESH_KEY, token),
        clear: async () => {
          await SecureStore.deleteItemAsync(TOKEN_KEY);
          await SecureStore.deleteItemAsync(REFRESH_KEY);
        },
      };

/*
 * Каждое чтение, запись и очистка токена заодно называют владельца
 * офлайн-данных (offline/owner.ts). Владелец — функция токена, и держать его
 * отдельно, обновляя «где не забыли», значило бы однажды разойтись: вход
 * через второй фактор, обмен refresh, стирание устройства меняют токен в
 * разных местах кода.
 */
export const tokenStorage = {
  get: async () => {
    const token = await raw.get();
    setActiveOwner(ownerOfToken(token));
    return token;
  },
  set: async (token: string) => {
    await raw.set(token);
    // новый токен — это вход: после стирания офлайн-слой снова пишет, но только за него (offline/owner.ts)
    signedIn(ownerOfToken(token));
  },
  getRefresh: () => raw.getRefresh(),
  setRefresh: (token: string) => raw.setRefresh(token),
  clear: async () => {
    // владелец снимается первым: запрос, отвечающий уже после выхода, не должен найти «текущего»
    setActiveOwner(null);
    await raw.clear();
  },
};

/*
 * Refresh-токены вышедших, ещё не отозванные на сервере (auth/session.ts):
 * выход не ждёт сети, а отзыв догоняет его при первой связи. Лежат там же,
 * где лежал сам токен, — в защищённом хранилище, а не в файлах офлайн-слоя.
 */
const REVOKE_KEY = "quizzy.revoke";

function parseList(raw: string | null): string[] {
  try {
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export const revokeStorage = {
  get: async (): Promise<string[]> =>
    parseList(
      Platform.OS === "web"
        ? typeof localStorage === "undefined"
          ? null
          : localStorage.getItem(REVOKE_KEY)
        : await SecureStore.getItemAsync(REVOKE_KEY),
    ),
  set: async (tokens: string[]): Promise<void> => {
    if (Platform.OS === "web") {
      if (tokens.length) localStorage?.setItem(REVOKE_KEY, JSON.stringify(tokens));
      else localStorage?.removeItem(REVOKE_KEY);
      return;
    }
    if (tokens.length) await SecureStore.setItemAsync(REVOKE_KEY, JSON.stringify(tokens));
    else await SecureStore.deleteItemAsync(REVOKE_KEY);
  },
};

/**
 * Настройки (язык и т.п.) — не секреты, но живут в том же хранилище:
 * лишняя зависимость ради localStorage-аналога не нужна.
 */
export const prefStorage = {
  get: (key: string) =>
    Platform.OS === "web"
      ? Promise.resolve(typeof localStorage === "undefined" ? null : localStorage.getItem(key))
      : SecureStore.getItemAsync(key),
  set: (key: string, value: string) =>
    Platform.OS === "web"
      ? Promise.resolve(localStorage?.setItem(key, value))
      : SecureStore.setItemAsync(key, value),
};
