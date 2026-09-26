import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isTransientStatus, type User } from "@quizzy/shared";
import { api } from "../api/client";
import { cache } from "../offline/cache";
import { ownerOfToken } from "../offline/owner";
import { tokenStorage } from "../storage";
import { forgetPush } from "../push";

interface AuthState {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  isSuperadmin: boolean;
  /**
   * Вход. Если у учётки включён второй фактор (техпанель, people2), пары нет:
   * возвращается знак «пароль верный», и экран входа просит код —
   * completeMfa. Мобилкой входят и сотрудники, а второй фактор, который
   * обходится входом с телефона, защищал бы одну дверь из двух.
   */
  login: (email: string, password: string) => Promise<{ mfaToken: string } | null>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    /** Обязателен для всех, включая учётки под кодом */
    phone: string;
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
          // истёкший access продлевается по refresh внутри запроса (auth/session.ts)
          setUser(await api.me());
        } catch (error) {
          /*
           * Стирать сессию — только когда сервер сказал «нет». Раньше её
           * стирал любой сбой, включая отсутствие сети: запуск в подвале
           * выкидывал человека на вход, а войти без сети нельзя — и план
           * безопасности, который приложение обязано показать офлайн,
           * оказывался за экраном входа. Без сети берётся свой профиль из
           * кэша владельца токена; кэша нет — сессия остаётся, и следующий
           * запуск со связью её восстановит.
           */
          if (isTransientStatus((error as { status?: number }).status ?? -1)) {
            const cached = cache.me(ownerOfToken(token));
            if (cached) setUser(cached);
          } else {
            await tokenStorage.clear();
          }
        }
      }
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const payload = await api.login({ email, password });
    if ("mfaRequired" in payload) return { mfaToken: payload.mfaToken };
    await tokenStorage.set(payload.token);
    await tokenStorage.setRefresh(payload.refreshToken);
    setUser(payload.user);
    return null;
  }, []);

  const completeMfa = useCallback(async (mfaToken: string, code: string) => {
    const payload = await api.loginMfa({ mfaToken, code });
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
    /*
     * На общем планшете пуш-токен обязан уехать вместе с учётной записью. Но
     * отвязка идёт по сети, а выход сети ждать не должен: без связи запрос
     * висел бы, и кнопка «вийти» не выводила бы. Три секунды — и дальше без
     * неё. Цена честная: не успевшая отвязка оставляет устройство за прежней
     * учётной записью, пока на нём кто-нибудь не зарегистрирует уведомления
     * заново (сервер переписывает владельца токена — lib/push.ts,
     * registerDevice), и до того её напоминания могут прийти сюда.
     */
    await Promise.race([forgetPush().catch(() => {}), new Promise((done) => setTimeout(done, 3_000))]);
    const refresh = await tokenStorage.getRefresh().catch(() => null);
    /*
     * Сначала — выход на устройстве, потом отзыв на сервере, и выход его не
     * ждёт: без сети отзыв уйдёт при первой связи (auth/session.ts). Раньше
     * серверную сессию не отзывал никто, и refresh жил до конца срока.
     */
    await tokenStorage.clear();
    setUser(null);
    if (refresh) void api.revokeSession(refresh).catch(() => {});
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      // «сотрудник»: и админ группы, и суперадмин видят конструктор и аналитику
      isAdmin: user?.role === "admin" || user?.role === "superadmin",
      isSuperadmin: user?.role === "superadmin",
      login,
      completeMfa,
      register,
      logout,
      refresh,
    }),
    [user, loading, login, completeMfa, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth должен использоваться внутри AuthProvider");
  return ctx;
}
