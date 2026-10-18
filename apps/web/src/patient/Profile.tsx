import { api } from "../api";
import { useAuth } from "../auth";
import { useAction } from "../ui";
import { Button, Field, Input } from "../ui/primitives";
import { LangSwitch } from "../lang";
import { useLang } from "../lang";
import { useState } from "react";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "../shell/theme";

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
  /*
   * Выбор темы — общий для вкладки (shell/theme.ts): тот же, что у
   * переключателя в шапке кабинета. Умолчание — светлая. Выбор уходит и в
   * профиль на сервере: пациент тоже открывает кабинет с разных устройств.
   */
  const theme = useThemeChoice();
  const applyTheme = (next: ThemeChoice) => {
    setThemeChoice(next);
    void api.saveWorkspace({ theme: next }).catch(() => {});
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
                  /* отказался вводить пароль — ничего не произошло */
                  if (!pass) return false;
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
            {(
              [
                ["light", "nav.themeLight"],
                ["dark", "nav.themeDark"],
                ["system", "nav.themeSystem"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={theme === value ? "primary" : "quiet"}
                aria-pressed={theme === value}
                onClick={() => applyTheme(value)}
              >
                {ut(label)}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <Button variant="quiet" onClick={logout}>
        {ut("nav.logout")}
      </Button>
    </div>
  );
}
