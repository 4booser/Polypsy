import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { User } from "@quizzy/shared";
import { api } from "../api/client";
import { tokenStorage } from "../storage";
import { forgetPush } from "../push";

interface AuthState {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  isSuperadmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    middleName?: string | null;
    anonymous?: boolean;
    sex?: "male" | "female" | null;
    birthDate?: string | null;
    inviteCode?: string | null;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // при старте пробуем восстановить сессию по сохранённому токену
  useEffect(() => {
    (async () => {
      const token = await tokenStorage.get();
      if (token) {
        try {
          setUser(await api.me());
        } catch {
          await tokenStorage.clear();
        }
      }
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const payload = await api.login({ email, password });
    await tokenStorage.set(payload.token);
    await tokenStorage.setRefresh(payload.refreshToken);
    setUser(payload.user);
  }, []);

  const register = useCallback<AuthState["register"]>(async (input) => {
    const payload = await api.register(input);
    await tokenStorage.set(payload.token);
    await tokenStorage.setRefresh(payload.refreshToken);
    setUser(payload.user);
  }, []);

  /** Перечитывает профиль после правки паспортной части */
  const refresh = useCallback(async () => {
    setUser(await api.me());
  }, []);

  const logout = useCallback(async () => {
    // на общем планшете токен обязан уехать вместе с учётной записью
    await forgetPush().catch(() => {});
    await tokenStorage.clear();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      // «сотрудник»: и админ группы, и суперадмин видят конструктор и аналитику
      isAdmin: user?.role === "admin" || user?.role === "superadmin",
      isSuperadmin: user?.role === "superadmin",
      login,
      register,
      logout,
      refresh,
    }),
    [user, loading, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth должен использоваться внутри AuthProvider");
  return ctx;
}
