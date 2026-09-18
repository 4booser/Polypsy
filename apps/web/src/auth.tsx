import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@quizzy/shared";
import { api, tokenStore } from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Перечитать профиль — после правки настроек рабочего места */
  refreshUser: () => void;
  /** Принять готовую пару токенов: регистрация входит без второго запроса */
  adopt: (res: { token: string; refreshToken: string; user: User }) => Promise<void>;
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

  /*
   * Принять уже выданную пару токенов.
   *
   * Нужно регистрации: сервер отдаёт токены сразу с созданной учётной
   * записью, и заставлять человека тут же входить заново значило бы
   * спрашивать пароль, который он ввёл секунду назад.
   *
   * Кто я — спрашиваем у /me, а не берём из ответа на вход.
   *
   * Ответ на вход описывает учётную запись, а не права: подсказки меню —
   * ступень должностей и «можно ли выписывать приглашения» — считаются на
   * сервере и приезжают только в /me. Пока профиль брался отсюда, вкладка
   * «Приглашения» и пункт «Права» не появлялись до первой перезагрузки
   * страницы: у человека, только что вошедшего, этих полей в профиле просто
   * не было. Поймано на живом стенде, и не нами.
   *
   * Второй вариант — досылать подсказки в ответ на вход — отвергнут: одно и
   * то же считалось бы в двух местах, и разошлось бы это молча, а заметили бы
   * опять случайно. Задача входа — выдать ключи; «кто я и что мне можно»
   * должно иметь ровно один адрес.
   *
   * Если /me не ответил, берём профиль из ответа на вход и пускаем внутрь.
   * Человек всё равно вошёл — ключи у него на руках, — и запирать его из-за
   * одного неудачного запроса нельзя: подсказки меню не стоят отказа в
   * доступе к системе, которая может понадобиться срочно. Ближайшая
   * перезагрузка их довезёт.
   */
  async function adopt(res: { token: string; refreshToken: string; user: User }) {
    tokenStore.set(res.token);
    tokenStore.setRefresh(res.refreshToken);
    setUser(await api.me().catch(() => res.user));
  }

  async function login(email: string, password: string) {
    /*
     * Пациента больше не разворачиваем.
     *
     * Здесь стоял отказ «консоль доступна только сотрудникам, пациенты
     * работают в мобильном приложении» — и он был правдой ровно до
     * появления кабинета пациента в вебе. Приложения нет, а человек, которому
     * назначили методику, упирался в отказ на входе: система обещала ему
     * доступ и не давала войти вовсе. Куда его пустить, решает App по классу
     * учётной записи.
     */
    await adopt(await api.login(email, password));
  }

  function logout() {
    // отзываем сессию на сервере; локально чистим независимо от результата
    const raw = tokenStore.getRefresh();
    if (raw) void api.logout(raw).catch(() => {});
    tokenStore.clear();
    setUser(null);
  }

  /*
   * Перечитать профиль. Нужно после правки настроек рабочего места: они
   * приходят вместе с профилем, и без обновления консоль показывала бы старое
   * значение до следующего входа.
   */
  function refreshUser() {
    void api.me().then(setUser).catch(() => {});
  }

  return (
    <Ctx.Provider value={{ user, loading, login, logout, refreshUser, adopt }}>{children}</Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth вне AuthProvider");
  return ctx;
}
