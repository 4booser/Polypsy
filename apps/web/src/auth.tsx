import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Permission, User } from "@quizzy/shared";
import { api, impersonationStore, tokenStore, watchSession } from "./api";
import { queryClient } from "./query";
import { useResource } from "./useResource";

interface AuthState {
  user: User | null;
  loading: boolean;
  /**
   * Вход: пара токенов — и человек внутри; или, если у него включён второй
   * фактор, ждём код (mfa ниже) — экран входа показывает второй шаг.
   */
  login: (email: string, password: string) => Promise<void>;
  /** Второй шаг входа ждёт кода (people2); null — не ждёт */
  mfa: { token: string } | null;
  /** Принять просьбу о коде, пришедшую не с формы входа — возврат от Google */
  beginMfa: (token: string) => void;
  completeMfa: (code: string) => Promise<void>;
  cancelMfa: () => void;
  logout: () => void;
  /** Перечитать профиль — после правки настроек рабочего места */
  refreshUser: () => void;
  /** Принять готовую пару токенов: регистрация входит без второго запроса */
  adopt: (res: { token: string; refreshToken: string; user: User }) => Promise<void>;
  /**
   * Есть ли у меня право — подсказка меню, как ladderRank и canInvite.
   *
   * Ограничением не является: право проверяется на маршрутах. Здесь оно
   * нужно, чтобы консоль не обещала того, чего сервер не даст, и — что
   * важнее — не ходила в закрытый маршрут «на пробу»: отказ в праве сервер
   * пишет в журнал доступа, и штатная работа выглядела бы там как попытки
   * взлома (см. permissionsFor).
   */
  can: (permission: Permission) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

/** Права техпанели и журнала — под входом «от имени» их нет (см. can) */
const OPS_ONLY: ReadonlySet<Permission> = new Set<Permission>(["ops.read", "ops.manage", "users.manage", "audit.read"]);

/**
 * Мои действующие права — с карточки прав, вместе с профилем.
 *
 * /me несёт две подсказки меню — ступень лестницы и «можно ли выписывать
 * приглашения», — но не право вести учётные записи, и без него разделы
 * «Лікарі» / «Адміністратори» решали бы «по какому маршруту идти за
 * справочником» наугад: бить в реестр и откатываться по отказу. Отказ —
 * это запись access.denied в журнале доступа, которую экран «Журнал»
 * считает в красный счётчик «Відмов»; заведующий, открывающий список коллег,
 * попадал бы туда на каждом заходе.
 *
 * GET /api/permissions/users/:id для своего id открыт каждому сотруднику, не
 * журналируется и отдаёт `effective` — тот самый набор, который проверяют
 * маршруты. Берётся он целиком, а не одно право: следующей подсказке меню
 * не понадобится ни новое поле в /me, ни второй запрос.
 *
 * Досылать право в /me было бы на один запрос дешевле, но /me — про учётную
 * запись, а карточка прав — про права, и она уже есть; второй источник того
 * же набора на сервере разошёлся бы с первым молча.
 *
 * Суперадмина не спрашиваем: сервер обходит для него справочник целиком
 * (permissionsOf), и `can` отвечает ему «да» без запроса. Пациента — тоже:
 * маршрут закрыт для него классом, а не правом, и ответ был бы отказом.
 * Не ответил сервер — прав «нет»: консоль спрячет лишнее, но работать
 * будет; отказать во входе из-за подсказки меню нельзя.
 */
async function permissionsFor(user: User): Promise<ReadonlySet<string>> {
  if (user.role !== "admin") return new Set();
  return api
    .userPermissions(user.id)
    .then((card) => new Set(card.effective))
    .catch(() => new Set<string>());
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [perms, setPerms] = useState<ReadonlySet<string>>(new Set());
  const [mfa, setMfa] = useState<{ token: string } | null>(null);

  /*
   * Профиль и права принимаются парой и в этом порядке: сперва права, потом
   * профиль. Консоль рисует маршруты по профилю, и появись он раньше прав,
   * заведующий на мгновение увидел бы консоль без своих разделов, а прямая
   * ссылка на «/staff/new» успела бы упереться в общий перехват и увести
   * на сводку.
   */
  async function accept(next: User) {
    setPerms(await permissionsFor(next));
    setUser(next);
  }

  /*
   * Восстановление сессии при открытии — через слой загрузки (волна 13).
   *
   * Здесь стоял голый запрос с `.catch(() => tokenStore.clear())`: любой
   * отказ /me чистил сессию. В том числе обрыв связи — консоль, открытая
   * во время перезапуска сервера или в кабинете со слабым Wi-Fi, выкидывала
   * человека на вход, хотя его refresh жив ещё месяц; а на входе без связи
   * делать нечего. Теперь обрыв — не отказ: загрузка ждёт связи (строка
   * «немає зв’язку» стоит над заглушкой, App.tsx) и по её возвращении
   * повторяется сама. Пятисотка сначала повторяется дважды (query.ts) и
   * только потом, как и раньше, закрывает сессию; так же — отказ по
   * существу: 401, когда обмен refresh уже не помог (api.ts), и прочие 4xx.
   *
   * Без токена спрашивать нечего: гость видит вход с первого кадра, а не
   * после пустого прохода эффектов.
   */
  const [hadToken] = useState(() => {
    // истёкший вход «от имени» с прошлого открытия вкладки — не повод остаться без своей сессии (#167)
    impersonationStore.dropExpired();
    return !!tokenStore.get();
  });
  const [settled, setSettled] = useState(!hadToken);
  const boot = useResource(
    async () => {
      const me = await api.me();
      return { me, perms: await permissionsFor(me) };
    },
    [],
    { enabled: hadToken && !settled },
  );
  useEffect(() => {
    if (settled) return;
    if (boot.data) {
      // права и профиль — одним проходом отрисовки, права не позже профиля (см. accept)
      setPerms(boot.data.perms);
      setUser(boot.data.me);
      setSettled(true);
    } else if (boot.error) {
      tokenStore.clear();
      setSettled(true);
    }
  }, [boot.data, boot.error, settled]);
  const loading = !settled;

  /*
   * В соседней вкладке сменился человек (#166): вошёл другой или вышел этот.
   * Вкладка сбрасывает профиль и кэш и показывает вход — дальше работать с
   * экраном одного и токеном другого нельзя. Токены не трогаем и на сервере
   * ничего не гасим: они теперь чужие, и выход здесь выкинул бы человека из
   * соседней вкладки. Вход «от имени» этой вкладки держался на прежней своей
   * сессии — уходит и он.
   */
  useEffect(
    () =>
      watchSession(window, () => {
        impersonationStore.clear();
        setUser(null);
        setPerms(new Set());
        setMfa(null);
        /* кэш — после того, как экраны сняты (см. logout) */
        setTimeout(() => queryClient.clear(), 0);
      }),
    [],
  );

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
    /*
     * Новый человек — чистый кэш загрузок (волна 13). Экраны прежнего уже
     * сняты, но ответы им живут в слое загрузки ещё минуту (query.ts); за
     * общим компьютером в кабинете следующий вошедший не должен получить
     * ни одного из них даже заглушкой «пока грузится».
     */
    queryClient.clear();
    tokenStore.set(res.token);
    tokenStore.setRefresh(res.refreshToken);
    await accept(await api.me().catch(() => res.user));
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
    const res = await api.login(email, password);
    /*
     * Второй фактор включён — пары нет, есть знак «пароль верный». Человек,
     * который уже был внутри (смена временного пароля на ForcePassword входит
     * заново сама), выходит на экран входа со вторым шагом: его прежняя
     * сессия погашена сменой пароля, и держать на экране её профиль нечем.
     */
    if ("mfaRequired" in res) {
      tokenStore.clear();
      setUser(null);
      setPerms(new Set());
      setMfa({ token: res.mfaToken });
      return;
    }
    await adopt(res);
  }

  async function completeMfa(code: string) {
    if (!mfa) return;
    await adopt(await api.loginMfa(mfa.token, code));
    setMfa(null);
  }

  function logout() {
    // отзываем сессию на сервере; локально чистим независимо от результата
    const raw = tokenStore.getRefresh();
    if (raw) void api.logout(raw).catch(() => {});
    tokenStore.clear();
    setUser(null);
    setPerms(new Set());
    /* кэш — после того, как экраны сняты: иначе они успели бы перечитать себя уже без токена */
    setTimeout(() => queryClient.clear(), 0);
  }

  /*
   * Перечитать профиль. Нужно после правки настроек рабочего места: они
   * приходят вместе с профилем, и без обновления консоль показывала бы старое
   * значение до следующего входа.
   */
  /*
   * Права перечитываются вместе с профилем, а не живут с момента входа:
   * роль, выданную посреди смены, человек должен увидеть без выхода.
   */
  function refreshUser() {
    void api.me().then(accept).catch(() => {});
  }

  /*
   * Суперадмин — «да» без справочника, как и на сервере (permissionsOf):
   * иначе суперадмин, случайно отнявший у себя право, не смог бы вернуть
   * его обратно — консоль спрятала бы от него экран, на котором это делается.
   */
  /*
   * Под входом «от имени» (people2) техпанель закрыта на сервере целиком —
   * и консоль её не обещает: права панели и журнала отвечают «нет», как бы
   * ни были выданы тому, под кем смотрят. Иначе пункт бургера и вкладки
   * вели бы в отказ.
   */
  const can = (permission: Permission) => {
    if (user?.impersonation && OPS_ONLY.has(permission)) return false;
    return user?.role === "superadmin" || perms.has(permission);
  };

  return (
    <Ctx.Provider
      value={{
        user,
        loading,
        login,
        mfa,
        beginMfa: (token: string) => setMfa({ token }),
        completeMfa,
        cancelMfa: () => setMfa(null),
        logout,
        refreshUser,
        adopt,
        can,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth вне AuthProvider");
  return ctx;
}
