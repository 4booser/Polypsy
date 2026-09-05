import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { LangSwitch, useLang } from "../lang";
import { Button, Field, Input } from "../ui/primitives";

/**
 * Вход в консоль.
 *
 * Единственный экран, который видят до всего остального, — и до переделки он
 * был самым небрежным: поля стояли впритык, кнопка была зашита по-русски
 * мимо словаря, а переключателя языка не было вовсе. Украиноязычный
 * сотрудник встречал подпись на украинском и единственную кнопку на русском,
 * и переключить язык мог только войдя — то есть уже пройдя этот экран.
 */
export default function Login() {
  const { ut } = useLang();
  const { login, adopt } = useAuth();
  /*
   * Спрашиваем сервер, настроен ли вход через Google. Не переменной сборки:
   * образ консоли один на все учреждения, а настроен способ в одном из них.
   */
  const [googleReady, setGoogleReady] = useState(false);
  /*
   * Можно ли завести учётную запись самому. Спрашивается у сервера вместе
   * со способами входа: ссылка «создать аккаунт» там, где регистрация
   * закрыта, ведёт в отказ — а человек у экрана входа не должен выяснять
   * опытным путём, что ему доступно.
   */
  const [openReg, setOpenReg] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  useEffect(() => {
    fetch("/api/auth/google/status")
      .then((r) => r.json())
      .then((j: { enabled?: boolean; openRegistration?: boolean }) => {
        setGoogleReady(Boolean(j.enabled));
        setOpenReg(Boolean(j.openRegistration));
      })
      .catch(() => {});
  }, []);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        const created = await api.register({
          email: email.trim(),
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
        });
        adopt(created);
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : ut("lg.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="w-full max-w-[380px]">
        <form
          className="card flex w-full flex-col gap-4 !mb-0 !p-7 shadow-panel"
          onSubmit={submit}
          noValidate
        >
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-md bg-primary font-display text-section font-bold text-primary-text"
            >
              Q
            </span>
            <div className="min-w-0">
              <h1 className="!m-0 font-display text-section font-semibold leading-tight">Quizzy</h1>
              <p className="m-0 text-caption text-muted">{ut("lg.consoleSub")}</p>
            </div>
          </div>

          {mode === "register" ? (
            <>
              <Field label={ut("adm.lastName")} htmlFor="reg-last">
                <Input id="reg-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </Field>
              <Field label={ut("adm.firstName")} htmlFor="reg-first">
                <Input id="reg-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </Field>
              <Field label={ut("rg.phone")} htmlFor="reg-phone" hint={ut("rg.phoneHint")}>
                <Input
                  id="reg-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  type="tel"
                  autoComplete="tel"
                />
              </Field>
            </>
          ) : null}

          <Field label="Email" htmlFor="login-email">
            <Input
              id="login-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="username"
              autoFocus
            />
          </Field>

          <Field label={ut("lg.password")} htmlFor="login-password">
            <Input
              id="login-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </Field>

          {/*
            Ошибка живёт рядом с кнопкой, а не под заголовком: смотрят туда,
            куда только что нажали. Роль alert нужна, чтобы диктор прочитал
            причину отказа, а не оставил человека перед не сработавшей кнопкой.
          */}
          {error ? (
            <p role="alert" className="m-0 text-caption text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {busy ? ut("lg.signingIn") : mode === "register" ? ut("rg.create") : ut("lg.signIn")}
          </Button>

          {openReg ? (
            <button
              type="button"
              className="text-caption text-muted underline-offset-2 hover:underline"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError(null);
              }}
            >
              {mode === "login" ? ut("rg.create") : ut("rg.haveAccount")}
            </button>
          ) : null}

          {/*
            Кнопка Google появляется, только если способ настроен на сервере.
            Нарисованная всегда, она вела бы в отказ — а человек у экрана
            входа не должен разбираться, какой из двух способов сегодня
            работает.

            Вход паролем остаётся первым и главным: это учреждение, где
            работают по записи, и потеря доступа из-за сбоя у внешнего
            поставщика — несостоявшийся приём.
          */}
          {googleReady ? (
            <>
              <div className="flex items-center gap-3 text-caption text-faint">
                <span className="h-px flex-1 bg-hairline" />
                {ut("lg.or")}
                <span className="h-px flex-1 bg-hairline" />
              </div>
              <a className="btn w-full justify-center" href="/api/auth/google/start">
                {ut("lg.google")}
              </a>
            </>
          ) : null}
        </form>

        {/*
          Переключатель языка — до входа, а не после. Иначе выбрать язык можно
          только пройдя экран, который сам показан не на том языке.
        */}
        <div className="mt-4 flex justify-center">
          <LangSwitch />
        </div>
      </div>
    </div>
  );
}
