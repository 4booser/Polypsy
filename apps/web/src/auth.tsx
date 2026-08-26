import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@quizzy/shared";
import { api, tokenStore } from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tokenStore.get()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await api.login(email, password);
    // консоль предназначена только для сотрудников: пациенту здесь нечего делать,
    // и пускать его внутрь, чтобы потом показывать пустые экраны, неправильно
    if (res.user.role === "user") {
      throw new Error("Консоль доступна только сотрудникам. Пациенты работают в мобильном приложении.");
    }
    tokenStore.set(res.token);
    tokenStore.setRefresh(res.refreshToken);
    setUser(res.user);
  }

  function logout() {
    // отзываем сессию на сервере; локально чистим независимо от результата
    const raw = tokenStore.getRefresh();
    if (raw) void api.logout(raw).catch(() => {});
    tokenStore.clear();
    setUser(null);
  }

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth вне AuthProvider");
  return ctx;
}
