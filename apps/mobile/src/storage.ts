import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const TOKEN_KEY = "quizzy.token";

// SecureStore недоступен в web-сборке — там падаем на localStorage
const store =
  Platform.OS === "web"
    ? {
        get: async () => (typeof localStorage === "undefined" ? null : localStorage.getItem(TOKEN_KEY)),
        set: async (token: string) => localStorage?.setItem(TOKEN_KEY, token),
        clear: async () => localStorage?.removeItem(TOKEN_KEY),
      }
    : {
        get: () => SecureStore.getItemAsync(TOKEN_KEY),
        set: (token: string) => SecureStore.setItemAsync(TOKEN_KEY, token),
        clear: () => SecureStore.deleteItemAsync(TOKEN_KEY),
      };

export const tokenStorage = store;
