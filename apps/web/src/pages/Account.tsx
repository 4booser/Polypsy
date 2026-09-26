import { useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Select } from "../ui/primitives";
import { LangSwitch, useLang } from "../lang";
import { ALWAYS_VISIBLE_RAIL } from "@quizzy/shared";
import { railGroups } from "../shell/Rail";
import { SecondFactorSettings } from "./ops/people2/SecondFactor";

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
  // умолчание светлое — как макет; см. пояснение в patient/Profile.tsx
  const theme = user?.workspace?.theme ?? (localStorage.getItem("quizzy.theme.v2") || "light");
  const density = user?.workspace?.density ?? "cozy";
  const motion = user?.workspace?.motion ?? "system";
  const hidden = user?.workspace?.railHidden ?? [];

  /*
   * Список разделов берётся из самой рельсы, а не набирается здесь руками.
   *
   * Второй список разошёлся бы с первым: новый раздел появился бы в меню и
   * не появился бы в настройке, и убрать его было бы нельзя — причём молча.
   * Считается он от полного набора (суперадмин, назначающий), чтобы человек
   * видел и те разделы, которых у него сейчас нет: скрытие живёт в профиле и
   * переживает выдачу права.
   */
  const railItems = useMemo(
    () =>
      railGroups({ today: 0, worklist: 0, alerts: 0, referrals: 0 }, true, true, [], true)
        .flatMap((g) => g.items)
        .map((i) => ({
          key: i.key,
          pinned: (ALWAYS_VISIBLE_RAIL as readonly string[]).includes(i.key),
        })),
    [],
  );

  /**
   * Настройка сохраняется НА СЕРВЕР, а не только в этот браузер.
   *
   * Тема здесь писалась в localStorage и в атрибут документа — и на этом
   * всё: до сервера выбор не доезжал, а оболочка, у которой своя копия
   * настроек, при следующей перерисовке возвращала прежнюю. Человек менял
   * тему, она менялась на глазах и откатывалась.
   *
   * Атрибут ставится сразу, до ответа сервера: иначе экран моргает старым
   * оформлением, пока летит запрос.
   */
  const applyPref = (patch: Parameters<typeof api.saveWorkspace>[0], attr?: [string, string | null]) =>
    run(async () => {
      if (attr) {
        const [name, value] = attr;
        if (value === null) delete document.documentElement.dataset[name];
        else document.documentElement.setAttribute(`data-${name}`, value);
      }
      await api.saveWorkspace(patch);
      await refreshUser();
    }, ut("acct.saved"));

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

        {/*
          Второй фактор (техпанель, people2): включить, подтвердить кодом,
          коды восстановления один раз, выключить паролем и кодом. Рядом с
          паролем — это тот же разговор о ключах от учётной записи.
        */}
        <Panel title={ut("acct.mfa.title")}>
          <div className="p-4">
            <SecondFactorSettings onEnabled={refreshUser} />
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
                <Button
                  size="sm"
                  variant={theme === "dark" ? "primary" : "quiet"}
                  onClick={() => applyPref({ theme: "dark" }, ["theme", "dark"])}
                >
                  {ut("nav.themeDark")}
                </Button>
                <Button
                  size="sm"
                  variant={theme === "light" ? "primary" : "quiet"}
                  onClick={() => applyPref({ theme: "light" }, ["theme", "light"])}
                >
                  {ut("nav.themeLight")}
                </Button>
              </div>
            </div>

            {/*
              Плотность меняется здесь, а не только в палитре команд.
              Настройка была, работала и хранилась на сервере — но добраться
              до неё можно было единственным способом: нажать Cmd+K и знать,
              что искать. Для человека, который о палитре не слышал, её не
              существовало.
            */}
            <div className="flex items-center justify-between gap-4">
              <span className="text-small text-muted">{ut("acct.density")}</span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={density === "cozy" ? "primary" : "quiet"}
                  onClick={() => applyPref({ density: "cozy" }, ["density", "cozy"])}
                >
                  {ut("acct.densityCozy")}
                </Button>
                <Button
                  size="sm"
                  variant={density === "compact" ? "primary" : "quiet"}
                  onClick={() => applyPref({ density: "compact" }, ["density", "compact"])}
                >
                  {ut("acct.densityCompact")}
                </Button>
              </div>
            </div>

            {/*
              Движение: следовать системе или всегда меньше.
              Включить его вопреки системной настройке нельзя — её ставят при
              вестибулярных расстройствах и мигрени, и перебивать её «зато
              красиво» значит делать человеку физически плохо. Обратное
              направление осмысленно: компьютер в кабинете общий, менять
              настройки системы человек не вправе, а убрать движение себе —
              вправе.
            */}
            <div className="flex items-center justify-between gap-4">
              <span className="text-small text-muted">{ut("acct.motion")}</span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={motion === "system" ? "primary" : "quiet"}
                  onClick={() => applyPref({ motion: "system" }, ["motion", null])}
                >
                  {ut("acct.motionSystem")}
                </Button>
                <Button
                  size="sm"
                  variant={motion === "reduced" ? "primary" : "quiet"}
                  onClick={() => applyPref({ motion: "reduced" }, ["motion", "reduced"])}
                >
                  {ut("acct.motionReduced")}
                </Button>
              </div>
            </div>
          </div>
        </Panel>

        {/*
          Разделы в меню: убирается лишнее, сигнальное остаётся.

          Рельса выросла до тринадцати разделов, и половиной из них
          конкретный специалист не пользуется никогда — а внимания они стоят
          при каждом открытии консоли. Здесь человек убирает своё.

          Порядок разделов НЕ настраивается, и это решение, а не недоделка.
          Разделы сгруппированы по смыслу — обзор, люди, методики,
          администрирование, — и перестановка между группами уничтожила бы
          ровно ту разметку, которая помогает искать. Перестановка внутри
          группы из двух-трёх пунктов не стоит ни перетаскивания, ни его
          доступной с клавиатуры замены.
        */}
        <Panel title={ut("acct.rail")} hint={ut("acct.railHint")}>
          <div className="flex flex-col gap-1 px-4 pb-4">
            {railItems.map(({ key, pinned }) => (
              <label
                key={key}
                className={`flex items-center gap-2 text-small ${pinned ? "text-muted" : ""}`}
                title={pinned ? ut("acct.railPinned") : undefined}
              >
                <input
                  type="checkbox"
                  checked={pinned || !hidden.includes(key)}
                  disabled={pinned || busy}
                  onChange={(e) =>
                    applyPref({
                      railHidden: e.target.checked
                        ? hidden.filter((k) => k !== key)
                        : [...hidden, key],
                    })
                  }
                />
                {ut(key)}
                {pinned ? (
                  <span className="text-caption text-faint">· {ut("acct.railPinned")}</span>
                ) : null}
              </label>
            ))}
          </div>
        </Panel>

        <Panel title={ut("acct.deleteTitle")}>
          <p className="px-4 pb-4 text-small text-muted">{ut("acct.deleteWhy")}</p>
        </Panel>
      </Stack>
    </Page>
  );
}
