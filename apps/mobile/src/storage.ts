import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const TOKEN_KEY = "quizzy.token";
const REFRESH_KEY = "quizzy.refresh";

// SecureStore недоступен в web-сборке — там падаем на localStorage
const store =
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

export const tokenStorage = store;
