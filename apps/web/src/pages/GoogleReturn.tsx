import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { isGoogleReturnCode, renderError, type Lang } from "@quizzy/shared";
import { ApiError, api, tokenStore } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Logo } from "../shell/Logo";
import { Ic } from "../ui";
import { Panel } from "../ui/layout";
import { ButtonLink, buttonClass } from "../ui/primitives";
import { AccessIcon } from "./public/accessIcons";
import { AuthCard } from "./public/authParts";
import { PublicFrame } from "./public/PublicFrame";
import { GoogleMark } from "./public/social";

/**
 * Возврат от Google (набор «Виразна», access-google-return).
 *
 * Сервер выдал пару токенов и привёл человека сюда переходом браузера —
 * значит значения приезжают в адресе, вернуть их телом ответа некому.
 *
 * Адрес чистится сразу же, до всего остального: он попадает в историю
 * браузера, в журнал прокси и в заголовок Referer при следующем переходе.
 * Токен, оставленный в адресной строке на экране в кабинете, — это доступ
 * к картам для любого, кто заглянет через плечо.
 *
 * Пока идёт обмен — спокойный лист «Входимо через Google…». Отказ — лист с
 * причиной словами сервера и путями дальше: войти паролем или попробовать
 * Google ещё раз; справа — какие ещё бывают причины и что с каждой делать.
 */
/**
 * Причина отказа, с которой сервер вернул сюда (routes/auth.ts, GET
 * /google/callback): ключ словами на языке страницы. Ключ не из списка
 * отказов возврата — null: адрес может набрать кто угодно.
 */
export function googleRefusal(search: string, lang: Lang): string | null {
  const key = new URLSearchParams(search).get("error");
  return isGoogleReturnCode(key) ? renderError(key, lang) : null;
}

export default function GoogleReturn() {
  const navigate = useNavigate();
  const { refreshUser, beginMfa } = useAuth();
  const { ut, lang } = useLang();
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
    const code = params.get("code");
    const refused = googleRefusal(window.location.search, lang);
    window.history.replaceState(null, "", window.location.pathname);

    if (!code) {
      /* сервер вернул с отказом — его причиной («не прив’язано», «сеанс застарів»); иначе общей строкой */
      setError(refused ?? ut("lg.googleFailed"));
      return;
    }

    /*
     * В адресе приезжает одноразовый код, а не сама пара токенов.
     *
     * Токены в адресе попадали в историю браузера общего компьютера, в
     * журнал обратного прокси и в Referer первого же подзапроса — а refresh
     * живёт тридцать дней. Чистка адреса здесь от этого не спасала: она
     * случается позже, чем адрес отдан браузеру.
     */
    api
      .googleExchange(code)
      .then((pair) => {
        /*
         * Второй фактор включён (people2): вместо пары — просьба о коде.
         * Вход через Google его не обходит; второй шаг — на экране входа.
         */
        if ("mfaRequired" in pair) {
          beginMfa(pair.mfaToken);
          navigate("/login", { replace: true });
          return null;
        }
        tokenStore.set(pair.token);
        tokenStore.setRefresh(pair.refreshToken);
        return api.me();
      })
      .then((user) => {
        if (!user) return;
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
      .catch((err) => {
        tokenStore.clear();
        /* отказ сервера — его словами («сеанс входу застарів…»); обрыв и прочее — общей строкой */
        setError(err instanceof ApiError && err.status >= 400 && err.status < 500 ? err.message : ut("lg.googleFailed"));
      });
  }, [navigate, refreshUser, beginMfa, ut, lang]);

  if (!error) {
    return (
      <PublicFrame>
        <div className="flex justify-center pt-10">
          <AuthCard className="max-w-[440px]">
            <div className="flex items-center gap-3" role="status">
              <GoogleMark size={22} />
              <p className="m-0 text-[15px] font-semibold text-text-2">{ut("ax.gr.loading")}</p>
            </div>
          </AuthCard>
        </div>
      </PublicFrame>
    );
  }

  const steps = [
    [ut("ax.gr.h1t"), ut("ax.gr.h1")],
    [ut("ax.gr.h2t"), ut("ax.gr.h2")],
    [ut("ax.gr.h3t"), ut("ax.gr.h3")],
  ];
  const reasons: [ReactNode, string, string][] = [
    [<AccessIcon key="l" name="unlink" size={16} />, ut("ax.gr.r.linked.t"), ut("ax.gr.r.linked")],
    [<Ic.timer key="s" size={16} />, ut("ax.gr.r.state.t"), ut("ax.gr.r.state")],
    [<AccessIcon key="u" name="mail" size={16} />, ut("ax.gr.r.unverified.t"), ut("ax.gr.r.unverified")],
    [<AccessIcon key="d" name="globe" size={16} />, ut("ax.gr.r.domain.t"), ut("ax.gr.r.domain")],
    [<Ic.users key="t" size={16} />, ut("ax.gr.r.taken.t"), ut("ax.gr.r.taken")],
    [<AccessIcon key="p" name="user-x" size={16} />, ut("ax.gr.r.staff.t"), ut("ax.gr.r.staff")],
    [<AccessIcon key="g" name="shield-off" size={16} />, ut("ax.gr.r.google.t"), ut("ax.gr.r.google")],
  ];

  return (
    <PublicFrame>
      <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-7 pb-4 pt-6 max-[1000px]:grid-cols-1">
        <AuthCard labelledBy="gr-title" className="px-9 pb-[34px] pt-8 max-[600px]:px-5">
          <div role="img" aria-label={ut("ax.gr.linkAlt")} className="flex items-center gap-1.5">
            <span className="grid size-14 place-items-center rounded-[17px] bg-onfill text-brand shadow-[inset_0_0_0_1px_var(--border)]">
              <Logo size={34} />
            </span>
            <span aria-hidden className="h-0.5 w-[22px] rounded-[1px] bg-field-border" />
            <span
              aria-hidden
              className="grid size-[30px] place-items-center rounded-full bg-warn-tint text-warn shadow-[inset_0_0_0_1px_var(--warnline)]"
            >
              <AccessIcon name="unlink" size={15} />
            </span>
            <span aria-hidden className="h-0.5 w-[22px] rounded-[1px] bg-field-border" />
            <span className="grid size-14 place-items-center rounded-[17px] bg-onfill shadow-[inset_0_0_0_1px_var(--border)]">
              <GoogleMark size={28} />
            </span>
          </div>
          <h1 id="gr-title" className="m-0 mt-6 text-title font-extrabold text-text">
            {ut("ax.gr.title")}
          </h1>
          <p role="alert" className="m-0 mt-2 max-w-[620px] text-[15px] leading-[23px] text-text-2">
            {error}
          </p>

          <h2 className="m-0 mt-6 text-h3 font-extrabold text-text">{ut("ax.gr.howTitle")}</h2>
          <ol className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
            {steps.map(([t, d], i) => (
              <li key={t} className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-3 text-small leading-[17px] text-muted">
                <span aria-hidden className="grid size-7 place-items-center rounded-full bg-violet-tint text-small font-extrabold text-violet-ink">
                  {i + 1}
                </span>
                <span>
                  <b className="block text-body font-extrabold leading-[19px] text-text">{t}</b>
                  {d}
                </span>
              </li>
            ))}
          </ol>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <ButtonLink to="/login" variant="primary" size="md">
              <ShellIcon name="key-round" size={18} />
              {ut("ax.gr.password")}
            </ButtonLink>
            <a href="/api/auth/google/start" className={buttonClass("secondary", "md")}>
              <GoogleMark />
              {ut("ax.gr.retry")}
            </a>
          </div>
          <p className="m-0 mt-2.5 flex items-center gap-1.5 text-small text-muted">
            <ShellIcon name="shield-check" size={14} className="text-good" />
            {ut("ax.gr.safe")}
          </p>
        </AuthCard>

        <Panel title={ut("ax.gr.whyTitle")} icon={<ShellIcon name="list-checks" />} tone="neutral">
          <ul className="m-0 list-none p-0">
            {reasons.map(([icon, t, d]) => (
              <li
                key={t}
                className="grid grid-cols-[32px_minmax(0,1fr)] items-start gap-2.5 border-t border-divider px-0.5 py-2.5 text-small leading-[17px] text-text-2 first:border-t-0 first:pt-0"
              >
                <span aria-hidden className="grid size-8 place-items-center rounded-control bg-sunk text-muted">
                  {icon}
                </span>
                <span>
                  <b className="block text-body font-extrabold leading-[19px] text-text">{t}</b>
                  {d}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </PublicFrame>
  );
}
