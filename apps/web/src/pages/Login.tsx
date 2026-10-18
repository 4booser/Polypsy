import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { renderError } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dateTime, timeOfDay } from "../format";
import { useLang } from "../lang";
import { bannerFor, sameLocalDay } from "../service/model";
import { useServiceStatus } from "../service/status";
import { ShellIcon } from "../shell/icons";
import { Logo } from "../shell/Logo";
import { Callout } from "../ui";
import { cx } from "../ui/cx";
import { IconTile } from "../ui/layout";
import { Button, ErrorText, Field, Input, Tag, buttonClass } from "../ui/primitives";
import { useResource } from "../useResource";
import { AccessIcon } from "./public/accessIcons";
import {
  AuthCard,
  AuthLead,
  AuthTitle,
  BandAside,
  CrisisNote,
  OrLine,
  OtpInput,
  PasswordInput,
  WhoRow,
  fill,
  tallField,
} from "./public/authParts";
import { PublicFrame } from "./public/PublicFrame";
import { GoogleMark } from "./public/social";

/**
 * Вход — экран «Вхід до Polypsy» (набор «Виразна», access-login): одна
 * спокойная колонка 440 по центру — лист формы, под ним «Пацієнтам —
 * застосунок» и «Стан системи», ниже — кому звонить, если плохо сейчас.
 *
 * Состояния — этого же экрана, а не отдельные страницы:
 *  - технические работы (access-login-maintenance): выноска работ над
 *    заголовком, внутри листа. Войти можно — сервер пускает вход и во время
 *    работ, — не сохраняется только изменяемое;
 *  - забагато спроб (access-login-locked): выноска с отсчётом под паролем,
 *    погашенная кнопка «Увійти можна о …» и подсказка, кто сбрасывает пароль;
 *  - второй шаг (access-login-mfa): код из приложения, рядом — телефон с
 *    приложением-аутентификатором.
 *
 * Вход через Google возвращён кнопкой — набор рисует её, а сервер её
 * обслуживает (GET /api/auth/google/status, /start). Кнопка стоит, только
 * если способ настроен на сервере: кнопка в отказ хуже отсутствующей.
 *
 * Поведение входа не менялось: тот же login() из auth.tsx, тот же второй шаг,
 * отказ сервера — его словами в строке role="alert".
 */

/** Окно блокировки входа на сервере (lib/loginGuard.ts): пять неудач за 15 минут */
const LOCK_MS = 15 * 60_000;

export default function Login() {
  const { ut, lang } = useLang();
  const { login, mfa } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState(false);
  const [forgot, setForgot] = useState(false);
  /*
   * Блокировка по почте. Сервер говорит только «забагато спроб» — когда она
   * кончится, он не сообщает (и API входа здесь не меняется). Последняя
   * неудача была до этого отказа, значит окно в 15 минут кончится не позже
   * чем через 15 минут от него: это верхняя граница, и она честно названа
   * «не пізніше ніж».
   */
  const [lock, setLock] = useState<{ email: string; since: number; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pwId = useId();
  const google = useResource(() => api.googleStatus().catch(() => ({ enabled: false })), []).data?.enabled ?? false;

  const key = email.trim().toLowerCase();
  const locked = !!lock && lock.email === key && now < lock.until;

  useEffect(() => {
    if (!lock) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lock.until) setLock(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lock]);

  /*
   * Второй шаг — «код із застосунку» (people2): пароль верный, у учётки
   * включён второй фактор. Почта — та, что набрали: строка «кто входит».
   * После возврата от Google почты здесь нет, и строки нет.
   */
  if (mfa) return <MfaStep email={key || null} />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || locked) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      const text = err instanceof Error ? err.message : ut("lg.failed");
      if (text.startsWith(renderError("err.tooManyAttempts", lang))) {
        const t = Date.now();
        setNow(t);
        setLock({ email: key, since: t, until: t + LOCK_MS });
      } else setError(text);
    } finally {
      setBusy(false);
    }
  }

  const onPasswordKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState("CapsLock"));
  const at = (ms: number) => timeOfDay(new Date(ms).toISOString());
  const left = lock ? Math.max(0, lock.until - now) : 0;
  const mmss = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`;

  return (
    <PublicFrame>
      <div className="flex justify-center pb-4 pt-6">
        <div className="flex w-full max-w-[440px] flex-col gap-4">
          <AuthCard labelledBy="lg-title">
            <ServiceNotice />
            <AuthTitle id="lg-title">{ut("ax.lg.title")}</AuthTitle>
            <AuthLead>{ut("ax.lg.lead")}</AuthLead>

            {google ? (
              <>
                <div className="mt-5">
                  <a href="/api/auth/google/start" className={buttonClass("secondary", "md", "w-full")}>
                    <GoogleMark />
                    {ut("ax.lg.google")}
                  </a>
                  <p
                    className={cx(
                      "m-0 mt-2 text-center text-caption leading-4",
                      locked ? "font-bold text-violet-ink" : "text-muted",
                    )}
                  >
                    {locked ? ut("ax.lg.googleLocked") : ut("ax.lg.googleNote")}
                  </p>
                </div>
                <OrLine>{ut("ax.lg.or")}</OrLine>
              </>
            ) : (
              <div className="mt-5" />
            )}

            {/*
              noValidate: проверку формы браузер не делает — отказ приходит с
              сервера одной и той же строкой, на языке консоли.
            */}
            <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
              <Field label={ut("ax.lg.email")} className="!mb-0">
                <Input
                  type="email"
                  icon={<AccessIcon name="at-sign" size={16} />}
                  className={tallField}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                  autoComplete="username"
                  autoFocus
                />
              </Field>

              <div className="flex min-w-0 flex-col">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label htmlFor={pwId} className="text-caption font-bold text-muted">
                    {ut("lg.password")}
                  </label>
                  <button
                    type="button"
                    aria-expanded={forgot || locked}
                    aria-controls="lg-forgot"
                    onClick={() => setForgot((f) => !f)}
                    className="min-h-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 text-small font-bold text-violet-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
                  >
                    {ut("ax.lg.forgot")}
                  </button>
                </div>
                <PasswordInput
                  id={pwId}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={onPasswordKey}
                  onKeyUp={onPasswordKey}
                  onBlur={() => setCaps(false)}
                  disabled={locked}
                  autoComplete="current-password"
                />
                {caps && !locked ? (
                  <ErrorText tone="warn" className="mt-2">
                    <span className="inline-flex items-center gap-1.5">
                      <AccessIcon name="arrow-big-up" size={14} />
                      {ut("ax.lg.caps")}
                    </span>
                  </ErrorText>
                ) : null}
                {/*
                  Отказ стоит под паролем: смотрят туда, куда только что нажали.
                  Роль alert — чтобы диктор прочитал причину отказа.
                */}
                {error ? (
                  <div role="alert" className="mt-2">
                    <ErrorText>{error}</ErrorText>
                  </div>
                ) : null}
                {locked && lock ? (
                  <Callout
                    kind="warn"
                    role="alert"
                    icon={<AccessIcon name="lock-keyhole" size={16} />}
                    title={ut("ax.lg.lockTitle")}
                    className="mt-3"
                  >
                    <p className="m-0 leading-[18px]">{ut("ax.lg.lockText")}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-[3px] bg-warn-line">
                        <i
                          className="block h-full rounded-[3px] bg-warn"
                          style={{ width: `${Math.min(100, ((now - lock.since) / (lock.until - lock.since)) * 100)}%` }}
                        />
                      </span>
                      <b className="text-[13px] font-extrabold tabular-nums text-warn">{mmss}</b>
                      <span className="text-caption text-text-2">{fill(ut("ax.lg.lockLeft"), { time: at(lock.until) })}</span>
                    </div>
                  </Callout>
                ) : null}
              </div>

              <Button
                type="submit"
                variant="primary"
                size="md"
                className="w-full"
                disabled={busy || locked}
                icon={locked ? <AccessIcon name="lock-keyhole" size={18} /> : undefined}
              >
                {busy
                  ? ut("lg.signingIn")
                  : locked && lock
                    ? fill(ut("ax.lg.lockButton"), { time: at(lock.until) })
                    : ut("lg.signIn")}
              </Button>
            </form>

            {forgot || locked ? (
              <div id="lg-forgot" className="mt-4 rounded-panel bg-sunk px-3.5 pb-3 pt-3.5 text-small text-text-2">
                <b className="block text-body font-extrabold text-text">{ut("ax.lg.forgotTitle")}</b>
                <p className="m-0 mt-0.5">{ut("ax.lg.forgotText")}</p>
              </div>
            ) : null}
          </AuthCard>

          <UsefulLinks />
          <CrisisNote template={ut("ax.crisis.login")} />
        </div>
      </div>
    </PublicFrame>
  );
}

/**
 * Работы или сбои — выноской в листе входа, над заголовком: человек должен
 * узнать о них до входа, а не после первой отказанной кнопки. Пока всё
 * работает, выноски нет.
 *
 * Отсчёта «ще 40 хв» здесь нет намеренно: он у баннера консоли за флагом
 * функции, а флаги — про человека, которого на входе ещё нет. Время начала и
 * ожидаемого конца — из объявления как есть.
 */
function ServiceNotice() {
  const { ut } = useLang();
  const { status } = useServiceStatus();
  const banner = bannerFor(status);
  if (!banner) return null;
  const maintenance = banner.tone === "maintenance";
  const now = Date.now();
  const at = (iso: string) => (sameLocalDay(iso, now) ? timeOfDay(iso) : dateTime(iso));
  const title = maintenance
    ? banner.expectedEnd
      ? fill(ut("ax.lg.maintUntil"), { time: at(banner.expectedEnd) })
      : ut("svc.banner.maintenance")
    : ut("svc.banner.degraded");
  return (
    <Callout
      kind="warn"
      icon={<ShellIcon name={maintenance ? "wrench" : "circle-alert"} size={16} />}
      title={title}
      className="mb-4"
      actions={
        <>
          {status?.since ? (
            <span className="inline-flex items-center gap-1.5 text-caption text-text-2">
              <AccessIcon name="clock" size={13} />
              {fill(ut("ax.lg.since"), { time: at(status.since) })}
            </span>
          ) : null}
          <Link to="/status" className="ml-auto text-small font-bold text-violet-ink no-underline hover:underline">
            {maintenance ? ut("ax.lg.maintMore") : ut("svc.details")}
          </Link>
        </>
      }
    >
      <p className="m-0 leading-[18px]">{maintenance ? ut("ax.lg.maintText") : ut("ax.lg.degradedText")}</p>
      {banner.message ? (
        <p className="m-0 mt-1 whitespace-pre-line leading-[18px] text-text [overflow-wrap:anywhere]">{banner.message}</p>
      ) : null}
    </Callout>
  );
}

/** Под листом: застосунок для пациентов и состояние системы — тихой строкой */
function UsefulLinks() {
  const { ut } = useLang();
  const { status } = useServiceStatus();
  const state = status?.status ?? "ok";
  const link =
    "inline-flex items-center gap-1.5 rounded-[6px] text-small font-semibold text-text-2 no-underline hover:text-violet-ink";
  return (
    <nav aria-label={ut("ax.lg.links")} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
      <Link to="/#app" className={link}>
        <ShellIcon name="smartphone" size={15} className="text-muted" />
        {ut("ax.lg.app")}
      </Link>
      <Link to="/status" className={cx(link, "ml-auto")}>
        <ShellIcon
          name={state === "ok" ? "circle-check" : "circle-alert"}
          size={15}
          className={state === "ok" ? "text-good" : "text-warn"}
        />
        {state === "ok" ? ut("svc.title") : ut(`svc.status.${state}`)}
      </Link>
    </nav>
  );
}

/**
 * Второй шаг входа (people2, access-login-mfa): шесть клеток кода из
 * приложения или — по кнопке «немає телефону» — одно поле кода
 * восстановления. Различает их сервер (lib/totp.ts, looksLikeRecovery), как и
 * прежде: экран только решает, какое поле показать.
 */
function MfaStep({ email }: { email: string | null }) {
  const { ut } = useLang();
  const { completeMfa, cancelMfa } = useAuth();
  const [mode, setMode] = useState<"app" | "recovery">("app");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = mode === "app" ? code : recovery.trim();
  const ready = mode === "app" ? code.length === 6 : recovery.replace(/[\s-]/g, "").length >= 8;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    completeMfa(value)
      .catch((err) => setError(err instanceof Error ? err.message : ut("lg.failed")))
      .finally(() => setBusy(false));
  };

  const switchMode = () => {
    setMode((m) => (m === "app" ? "recovery" : "app"));
    setError(null);
  };

  return (
    <PublicFrame>
      <div className="flex flex-wrap items-start justify-center gap-14 pb-4 pt-6 max-[1000px]:gap-8">
        <div className="flex w-full max-w-[440px] flex-col gap-4">
          <AuthCard labelledBy="mf-title">
            <button
              type="button"
              onClick={cancelMfa}
              className={cx(
                "-ml-2 -mt-1.5 mb-3.5 inline-flex h-8 min-h-0 cursor-pointer items-center gap-1.5 rounded-[9px] border-0 bg-transparent pl-1.5 pr-2.5",
                "text-small font-bold text-violet-ink hover:bg-violet-tint",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]",
              )}
            >
              <AccessIcon name="arrow-left" size={15} />
              {ut("lg.mfa.back")}
            </button>
            <AuthTitle id="mf-title">{ut("lg.mfa.title")}</AuthTitle>
            <AuthLead>{ut("lg.mfa.hint")}</AuthLead>

            {email ? (
              <WhoRow
                className="mt-5"
                lead={<IconTile icon={<ShellIcon name="circle-user-round" />} tone="violet" />}
                title={email}
                aside={
                  <Tag tone="good" icon={<ShellIcon name="circle-check" size={12} />}>
                    {ut("ax.mfa.accepted")}
                  </Tag>
                }
              />
            ) : null}

            <form className="mt-5 flex flex-col" onSubmit={submit} noValidate>
              {mode === "app" ? (
                <div className="flex flex-col">
                  <span id="mf-code-label" className="mb-1.5 text-caption font-bold text-muted">
                    {ut("lg.mfa.title")}
                  </span>
                  <OtpInput value={code} onChange={setCode} label={ut("ax.mfa.digits")} autoFocus />
                  <span className="mt-2.5 flex items-center gap-1.5 text-small text-muted">
                    <AccessIcon name="clipboard-paste" size={14} />
                    {ut("ax.mfa.paste")}
                  </span>
                </div>
              ) : (
                <Field label={ut("ax.mfa.recovery")} hint={ut("ax.mfa.recoveryHint")} className="!mb-0">
                  <Input
                    value={recovery}
                    onChange={(e) => setRecovery(e.target.value)}
                    icon={<ShellIcon name="key-round" size={16} />}
                    className={tallField}
                    placeholder={ut("ax.mfa.recoveryPh")}
                    autoComplete="one-time-code"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={12}
                    autoFocus
                  />
                </Field>
              )}
              {error ? (
                <div role="alert" className="mt-2">
                  <ErrorText>{error}</ErrorText>
                </div>
              ) : null}
              <div className="mt-5">
                <Button type="submit" variant="primary" size="md" className="w-full" disabled={busy || !ready}>
                  {busy ? ut("lg.signingIn") : ut("lg.signIn")}
                </Button>
                {mode === "app" && !ready ? (
                  <p className="m-0 mt-2 text-center text-caption leading-4 text-muted">{ut("ax.mfa.ready")}</p>
                ) : null}
              </div>
            </form>

            <OrLine>{ut("ax.mfa.noPhone")}</OrLine>
            <Button
              size="md"
              className="w-full"
              icon={mode === "app" ? <ShellIcon name="life-buoy" size={18} /> : <ShellIcon name="smartphone" size={18} />}
              onClick={switchMode}
            >
              {mode === "app" ? ut("ax.mfa.useRecovery") : ut("ax.mfa.useApp")}
            </Button>
            <Callout kind="info" icon={<ShellIcon name="timer" size={16} />} className="mt-4">
              <p className="m-0 leading-[18px]">{ut("ax.mfa.timeout")}</p>
            </Callout>
          </AuthCard>
          <CrisisNote template={ut("ax.crisis.login")} />
        </div>

        <BandAside
          center
          title={ut("ax.mfa.whereTitle")}
          lead={ut("ax.mfa.whereText")}
          className="w-[400px] max-[1000px]:hidden"
        >
          <AuthenticatorPhone />
        </BandAside>
      </div>
    </PublicFrame>
  );
}

/**
 * Телефон с приложением-аутентификатором — рисунок, а не данные: строка
 * Polypsy подсвечена, цифры кода нарисованы плашками (настоящий код знает
 * только телефон человека), соседние записи — серые полосы.
 */
function AuthenticatorPhone() {
  const { ut } = useLang();
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <div role="img" aria-label={ut("ax.mfa.phoneAlt")} className="mt-6 w-[244px] rounded-[40px] bg-appbar p-[9px] shadow-banner">
      <div className="relative h-[400px] overflow-hidden rounded-[31px] bg-panel px-3 pt-11 text-left">
        <span aria-hidden className="absolute left-1/2 top-2.5 h-5 w-[70px] -translate-x-1/2 rounded-[10px] bg-appbar" />
        <div className="flex items-center justify-between px-1.5 text-[17px] font-extrabold leading-[22px] text-text">
          {ut("ax.mfa.phoneCodes")}
          <AccessIcon name="plus" size={16} className="text-muted" />
        </div>
        <div className="mt-1 rounded-[14px] bg-violet-tint px-3 pb-[11px] pt-2.5 shadow-[inset_0_0_0_1px_var(--vline)]">
          <div className="flex items-center gap-1.5 text-[11.5px] font-extrabold leading-[15px] text-text-2">
            <span className="grid size-4 place-items-center rounded-[5px] bg-onfill text-brand shadow-[inset_0_0_0_1px_var(--border)]">
              <Logo size={12} />
            </span>
            {ut("shell.brand")}
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <i key={i} className={cx("block h-[22px] w-3.5 rounded-[4px] bg-violet-ink/80", i === 3 && "ml-2")} />
              ))}
            </span>
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
              <circle cx="11" cy="11" r={r} fill="none" stroke="var(--vline)" strokeWidth="2.5" />
              <circle
                cx="11"
                cy="11"
                r={r}
                fill="none"
                stroke="var(--vink)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={`${(c * 19) / 30} ${c}`}
                transform="rotate(-90 11 11)"
              />
            </svg>
          </div>
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="border-t border-divider px-3 pb-[11px] pt-2.5 first-of-type:border-t-0">
            <div className="flex items-center gap-1.5">
              <span className="size-4 rounded-[5px] bg-sunk-2" />
              <span className="h-2.5 rounded-[3px] bg-sunk-2" style={{ width: 44 + i * 10 }} />
            </div>
            <span className="mt-2 flex items-center gap-1">
              {[0, 1, 2, 3, 4, 5].map((j) => (
                <i key={j} className={cx("block h-[22px] w-3.5 rounded-[4px] bg-sunk-2", j === 3 && "ml-2")} />
              ))}
            </span>
          </div>
        ))}
        <p className="m-0 mx-1.5 mt-3 flex items-center gap-1.5 text-micro leading-[14px] text-muted">
          <AccessIcon name="refresh-cw" size={12} />
          {ut("ax.mfa.phoneEvery")}
        </p>
      </div>
    </div>
  );
}
