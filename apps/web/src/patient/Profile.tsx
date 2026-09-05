import { api } from "../api";
import { useAuth } from "../auth";
import { useAction } from "../ui";
import { Button, Field, Input } from "../ui/primitives";
import { LangSwitch } from "../lang";
import { useLang } from "../lang";
import { useState } from "react";

/**
 * «Я»: свои данные, вход через Google, вид приложения.
 *
 * Пароль и телефон сюда не вынесены намеренно: смена телефона — способ
 * увести чужую учётную запись, и она идёт через смену пароля, отдельным
 * путём с записью в журнал. Класть её рядом с выбором темы значило бы
 * приравнять одно к другому.
 */
export default function PatientProfile() {
  const { ut } = useLang();
  const { user, logout, refreshUser } = useAuth();
  const { run, busy } = useAction();

  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [theme, setTheme] = useState(() => localStorage.getItem("quizzy.theme") ?? "dark");

  const applyTheme = (next: string) => {
    setTheme(next);
    localStorage.setItem("quizzy.theme", next);
    document.documentElement.setAttribute("data-theme", next);
  };

  return (
    <div className="flex flex-col gap-5 p-4">
      <section className="flex flex-col gap-3">
        <h2 className="text-caption uppercase tracking-[var(--tracking-label)] text-faint">
          {ut("pt.myData")}
        </h2>
        <Field label={ut("adm.lastName")}>
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </Field>
        <Field label={ut("adm.firstName")}>
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </Field>
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api.updateMe({ firstName, lastName });
              await refreshUser();
            }, ut("pt.saved"))
          }
        >
          {ut("common.save")}
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-caption uppercase tracking-[var(--tracking-label)] text-faint">
          {ut("pt.google")}
        </h2>
        {user?.googleLinked ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-small text-muted">{ut("pt.googleLinked")}</span>
            {/*
              Отвязка спрашивает пароль. Это снятие второго ключа от учётной
              записи, операция того же класса, что смена пароля, — и
              угнанного получасового токена для неё быть достаточно не должно.
            */}
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const pass = window.prompt(ut("lg.googleUnlinkAsk"));
                  if (!pass) return;
                  await api.googleUnlink(pass);
                  await refreshUser();
                }, ut("pt.saved"))
              }
            >
              {ut("pt.googleUnlink")}
            </Button>
          </div>
        ) : (
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const { url } = await api.googleLinkUrl();
                window.location.href = url;
              })
            }
          >
            {ut("pt.googleLink")}
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-caption uppercase tracking-[var(--tracking-label)] text-faint">
          {ut("pt.appearance")}
        </h2>
        <div className="flex items-center justify-between">
          <span className="text-small text-muted">{ut("pt.language")}</span>
          <LangSwitch />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-small text-muted">{ut("pt.theme")}</span>
          <div className="flex gap-1">
            <Button size="sm" variant={theme === "dark" ? "primary" : "quiet"} onClick={() => applyTheme("dark")}>
              {ut("nav.themeDark")}
            </Button>
            <Button size="sm" variant={theme === "light" ? "primary" : "quiet"} onClick={() => applyTheme("light")}>
              {ut("nav.themeLight")}
            </Button>
          </div>
        </div>
      </section>

      <Button variant="quiet" onClick={logout}>
        {ut("nav.logout")}
      </Button>
    </div>
  );
}
