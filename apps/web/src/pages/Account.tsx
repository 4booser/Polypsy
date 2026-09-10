import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Select } from "../ui/primitives";
import { LangSwitch, useLang } from "../lang";

/**
 * Учётная запись сотрудника.
 *
 * До этого своих данных у сотрудника не было нигде: имя и роль стояли в
 * подвале рельсы без возможности что-либо изменить, пароль менялся только
 * через администратора, а привязка Google жила на экране входа — то есть
 * там, куда уже вошедший не возвращается.
 *
 * Удаления учётной записи здесь нет, и на экране написано почему: за
 * записями сотрудника закреплены подписанные заключения и протоколы
 * приёмов, они обязаны остаться за автором, и стереть человека одним
 * нажатием значило бы либо потерять подпись, либо оставить документы без
 * автора. Это работа администратора, и она обдумывается, а не нажимается.
 */
export default function Account() {
  const { ut } = useLang();
  const { user, refreshUser } = useAuth();
  const { run, busy } = useAction();

  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [middleName, setMiddleName] = useState(user?.middleName ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("quizzy.theme") ?? "dark");

  const applyTheme = (value: string) => {
    setTheme(value);
    localStorage.setItem("quizzy.theme", value);
    document.documentElement.setAttribute("data-theme", value);
  };

  return (
    <Page title={ut("acct.title")} sub={ut("acct.sub")}>
      <Stack>
        <Panel title={ut("acct.data")}>
          <div className="flex flex-col gap-3 p-4">
            <Field label={ut("adm.lastName")}>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </Field>
            <Field label={ut("adm.firstName")}>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </Field>
            <Field label={ut("adm.middleName")}>
              <Input value={middleName} onChange={(e) => setMiddleName(e.target.value)} />
            </Field>
            <div>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.updateMe({ firstName, lastName, middleName: middleName || null });
                    await refreshUser();
                  }, ut("acct.saved"))
                }
              >
                {ut("common.save")}
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title={ut("acct.password")}>
          <div className="flex flex-col gap-3 p-4">
            <Field label={ut("acct.currentPassword")}>
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            <Field label={ut("acct.newPassword")}>
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            </Field>
            <div>
              <Button
                disabled={busy || !current || next.length < 8}
                onClick={() =>
                  run(async () => {
                    await api.changePassword(current, next);
                    setCurrent("");
                    setNext("");
                  }, ut("acct.passwordChanged"))
                }
              >
                {ut("acct.changePassword")}
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title={ut("pt.google")}>
          <div className="flex flex-wrap items-center gap-3 p-4">
            {user?.googleLinked ? (
              <>
                <span className="text-small text-muted">{ut("pt.googleLinked")}</span>
                {/*
                  Отвязка спрашивает пароль: это снятие второго ключа от
                  учётной записи, операция того же класса, что смена пароля,
                  и угнанного получасового токена для неё быть достаточно не
                  должно.
                */}
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const pass = window.prompt(ut("lg.googleUnlinkAsk"));
                      /* отказался вводить пароль — ничего не произошло */
                      if (!pass) return false;
                      await api.googleUnlink(pass);
                      await refreshUser();
                    }, ut("acct.saved"))
                  }
                >
                  {ut("pt.googleUnlink")}
                </Button>
              </>
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
          </div>
        </Panel>

        <Panel title={ut("acct.appearance")}>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <span className="text-small text-muted">{ut("pt.language")}</span>
              <LangSwitch />
            </div>
            {/*
              Стартовый экран. Дежурному нужна сводка, а тому, кто весь день
              разбирает случаи, — очередь: попадать каждый раз не туда стоит
              лишнего нажатия в начале каждой смены.
            */}
            <div className="flex items-center justify-between gap-4">
              <span className="text-small text-muted">{ut("acct.startScreen")}</span>
              <Select
                aria-label={ut("acct.startScreen")}
                value={user?.workspace?.startScreen ?? "dashboard"}
                onChange={(e) =>
                  run(async () => {
                    await api.saveWorkspace({ startScreen: e.target.value as never });
                    await refreshUser();
                  }, ut("acct.saved"))
                }
              >
                <option value="dashboard">{ut("nav.dashboard")}</option>
                <option value="worklist">{ut("nav.worklist")}</option>
                <option value="alerts">{ut("nav.cases")}</option>
                <option value="patients">{ut("nav.patients")}</option>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4">
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
          </div>
        </Panel>

        <Panel title={ut("acct.deleteTitle")}>
          <p className="px-4 pb-4 text-small text-muted">{ut("acct.deleteWhy")}</p>
        </Panel>
      </Stack>
    </Page>
  );
}
