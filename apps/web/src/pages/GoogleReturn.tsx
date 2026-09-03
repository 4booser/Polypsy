import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, tokenStore } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";

/**
 * Возврат от Google.
 *
 * Сервер выдал пару токенов и привёл человека сюда переходом браузера —
 * значит значения приезжают в адресе, вернуть их телом ответа некому.
 *
 * Адрес чистится сразу же, до всего остального: он попадает в историю
 * браузера, в журнал прокси и в заголовок Referer при следующем переходе.
 * Токен, оставленный в адресной строке на экране в кабинете, — это доступ
 * к картам для любого, кто заглянет через плечо.
 */
export default function GoogleReturn() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const { ut } = useLang();
  const [error, setError] = useState<string | null>(null);
  /*
   * Строгий режим React вызывает эффект дважды. Без этой отметки второй
   * вызов читает уже вычищенный адрес, не находит токена и показывает
   * отказ поверх удачного входа.
   */
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const refreshToken = params.get("refresh");
    window.history.replaceState(null, "", window.location.pathname);

    if (!token || !refreshToken) {
      setError(ut("lg.googleFailed"));
      return;
    }

    tokenStore.set(token);
    tokenStore.setRefresh(refreshToken);

    api
      .me()
      .then((user) => {
        /*
         * То же правило, что и при входе паролем: консоль — для сотрудников.
         * Проверять надо и здесь: иначе пациент со связанным Google получал
         * бы пустые экраны вместо внятного отказа.
         */
        if (user.role === "user") {
          tokenStore.clear();
          setError(ut("lg.staffOnly"));
          return;
        }
        refreshUser();
        navigate("/", { replace: true });
      })
      .catch(() => {
        tokenStore.clear();
        setError(ut("lg.googleFailed"));
      });
  }, [navigate, refreshUser, ut]);

  return (
    <div className="login">
      <div className="card w-full max-w-[380px] !p-7">
        {error ? (
          <>
            <p role="alert" className="m-0 text-danger">
              {error}
            </p>
            <a className="btn mt-4 w-full justify-center" href="/">
              {ut("lg.signIn")}
            </a>
          </>
        ) : (
          <p className="m-0 text-muted">{ut("common.loading")}</p>
        )}
      </div>
    </div>
  );
}
