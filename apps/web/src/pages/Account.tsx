import { useMemo, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import type { MfaSetup, Sex } from "@quizzy/shared";
import { ALWAYS_VISIBLE_RAIL } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { Callout, Ic, Loading, Modal, useAction } from "../ui";
import { cx } from "../ui/cx";
import { Count, Page, Panel } from "../ui/layout";
import { Button, Checkbox, Field, Input, Segmented, Select, Switch, Tag } from "../ui/primitives";
import { useResource } from "../useResource";
import { railGroups } from "../shell/Rail";
import { setThemeChoice, useThemeChoice } from "../shell/theme";
import { changePassword, passwordProblems, passwordReady } from "./passwordModel";
import { AIc, dmy, fill, saveFile, whenShort } from "./people/parts";

/**
 * Учётная запись сотрудника — Polypsy 2.0, макеты admin-account и
 * admin-account-recovery-codes.
 *
 * Сводка защиты сверху, под ней разделы: данные о себе, пароль и второй
 * фактор, вид (язык, тема, плотность, движение, стартовый экран), разделы
 * бокового меню, Google, устройства, удаление. Переход по разделам — строкой
 * вкладок над ними: страница одна, вкладка ведёт к своему разделу.
 *
 * Тема — «Світла / Темна / Як у системі» (рамка 2.0): выбор применяется
 * сразу и уходит на сервер следом. Плотность, движение, стартовый экран и
 * скрытые разделы рельсы — те же настройки рабочего места, что и были.
 *
 * Удаления учётной записи здесь нет, и на экране написано почему: за
 * записями сотрудника закреплены подписанные заключения и протоколы
 * приёмов, они обязаны остаться за автором. Это работа администратора.
 *
 * Чего с макета нет и почему: дата смены пароля, свои сессии с «завершити»,
 * настройки уведомлений и Google Календар — у сервера этого нет; «створити
 * нові коди» — коды выдаются при включении второго фактора, отдельного
 * маршрута перевыпуска нет (см. отчёт участка).
 */

/** Сколько кодов восстановления выдаёт сервер (apps/api/src/lib/totp.ts, RECOVERY_COUNT) */
const RECOVERY_TOTAL = 10;

type SectionKey = "data" | "password" | "devices" | "appearance" | "google" | "rail";

export default function Account() {
  const { ut, lang, setLang } = useLang();
  const { user, refreshUser, login } = useAuth();
  const { run, busy } = useAction();
  const mfa = useResource(() => api.mfaStatus(), []);
  const devices = useResource(() => api.devices().catch(() => []), []);

  /* выбор темы — общий для вкладки (shell/theme.ts): тот же, что у переключателя на полосе приложения */
  const theme = useThemeChoice();
  const density = user?.workspace?.density ?? "cozy";
  const motion = user?.workspace?.motion ?? "system";
  const hidden = user?.workspace?.railHidden ?? [];

  /*
   * Список разделов берётся из самой рельсы, а не набирается здесь руками:
   * второй список разошёлся бы с первым. Считается от полного набора, чтобы
   * человек видел и те разделы, которых у него сейчас нет: скрытие живёт в
   * профиле и переживает выдачу права.
   */
  const railItems = useMemo(
    () =>
      railGroups({ today: 0, worklist: 0, alerts: 0, referrals: 0 }, true, true, [], true)
        .flatMap((g) => g.items)
        .map((i) => ({ key: i.key, icon: i.icon, pinned: (ALWAYS_VISIBLE_RAIL as readonly string[]).includes(i.key) })),
    [],
  );

  /**
   * Настройка сохраняется НА СЕРВЕР, а не только в этот браузер: оболочка,
   * у которой своя копия настроек, иначе возвращала бы прежнюю. Атрибут
   * ставится сразу, до ответа сервера: иначе экран моргает старым
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

  const goto = (key: SectionKey) => document.getElementById(`acct-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const sections: { key: SectionKey; label: string; count?: number }[] = [
    { key: "data", label: ut("acct.data") },
    { key: "password", label: ut("adm2.passwordAndSignIn") },
    { key: "devices", label: ut("adm2.devices"), count: devices.data?.length },
    { key: "appearance", label: ut("acct.appearance") },
    { key: "google", label: ut("adm2.google") },
    { key: "rail", label: ut("adm2.sidebar") },
  ];

  const roleTitle = user?.role === "superadmin" ? ut("nav.roleSuper") : (user?.position?.trim() || ut("nav.roleAdmin"));

  return (
    <Page
      title={ut("acct.title")}
      meta={user ? [user.fullName, roleTitle] : undefined}
      toolbar={
        <nav aria-label={ut("adm2.accountSections")} className="flex flex-wrap items-center gap-1">
          {sections.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => goto(s.key)}
              className={cx(
                "inline-flex h-9 min-h-0 cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-control border-0 px-[13px] text-body leading-none",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                i === 0 ? "bg-panel font-extrabold text-violet-ink shadow-tile" : "bg-transparent font-semibold text-text-2 hover:bg-tab-hover hover:text-text",
              )}
            >
              {s.label}
              {s.count ? <Count n={s.count} /> : null}
            </button>
          ))}
        </nav>
      }
    >
      <div className="flex flex-col gap-4">
        <ProtectionPanel mfa={mfa.data ?? null} googleLinked={!!user?.googleLinked} mustChange={!!user?.mustChangePassword} />
        <div className="grid items-start gap-4 min-[1180px]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <DataPanel />
            <Panel id="acct-appearance" title={ut("acct.appearance")} icon={<AIc.palette />} sub={ut("adm2.appearanceSub")}>
              <ul className="m-0 list-none p-0">
                <Setting label={ut("pt.language")}>
                  <Segmented
                    label={ut("pt.language")}
                    value={lang}
                    onChange={setLang}
                    items={[
                      { key: "uk", label: ut("lang.uk") },
                      { key: "ru", label: ut("lang.ru") },
                      { key: "en", label: ut("lang.en") },
                    ]}
                  />
                </Setting>
                <Setting label={ut("pt.theme")}>
                  <Segmented
                    label={ut("pt.theme")}
                    value={theme}
                    onChange={(value) => {
                      /* тема применяется сразу (App следит за выбором), сервер — следом */
                      setThemeChoice(value);
                      void applyPref({ theme: value });
                    }}
                    items={[
                      { key: "light", label: ut("adm2.themeLight") },
                      { key: "dark", label: ut("adm2.themeDark") },
                      { key: "system", label: ut("nav.themeSystem") },
                    ]}
                  />
                </Setting>
                {/*
                  Плотность меняется здесь, а не только в палитре команд: для
                  человека, который о палитре не слышал, её не существовало.
                */}
                <Setting label={ut("acct.density")} hint={ut("adm2.densityHint")}>
                  <Segmented
                    label={ut("acct.density")}
                    value={density}
                    onChange={(v) => void applyPref({ density: v }, ["density", v])}
                    items={[
                      { key: "cozy", label: ut("acct.densityCozy") },
                      { key: "compact", label: ut("acct.densityCompact") },
                    ]}
                  />
                </Setting>
                {/*
                  Движение: следовать системе или всегда меньше. Включить его
                  вопреки системной настройке нельзя — её ставят при
                  вестибулярных расстройствах и мигрени.
                */}
                <Setting label={ut("acct.motion")}>
                  <Segmented
                    label={ut("acct.motion")}
                    value={motion}
                    onChange={(v) => void applyPref({ motion: v }, ["motion", v === "system" ? null : "reduced"])}
                    items={[
                      { key: "system", label: ut("acct.motionSystem") },
                      { key: "reduced", label: ut("acct.motionReduced") },
                    ]}
                  />
                </Setting>
                {/*
                  Стартовый экран: дежурному нужна сводка, а тому, кто весь день
                  разбирает случаи, — очередь.
                */}
                <Setting label={ut("acct.startScreen")} hint={ut("adm2.startHint")}>
                  <span className="block w-[220px] shrink-0">
                    <Select
                      aria-label={ut("acct.startScreen")}
                      value={user?.workspace?.startScreen ?? "dashboard"}
                      onChange={(e) => void applyPref({ startScreen: e.target.value as never })}
                    >
                      <option value="dashboard">{ut("nav.dashboard")}</option>
                      <option value="worklist">{ut("nav.worklist")}</option>
                      <option value="alerts">{ut("nav.cases")}</option>
                      <option value="patients">{ut("nav.patients")}</option>
                    </Select>
                  </span>
                </Setting>
              </ul>
            </Panel>

            {/*
              Разделы в меню: убирается лишнее, сигнальное остаётся. Порядок
              не настраивается, и это решение: разделы сгруппированы по
              смыслу, и перестановка уничтожила бы ту разметку, которая
              помогает искать.
            */}
            <Panel id="acct-rail" title={ut("acct.rail")} icon={<AIc.panel />} sub={ut("adm2.railSub")} hint={ut("acct.railHint")}>
              <ul className="m-0 list-none p-0">
                {railItems.map(({ key, icon, pinned }) => (
                  <li key={key} className="flex min-h-[44px] items-center gap-3 border-b border-divider last:border-0">
                    <span className={cx("inline-grid size-5 place-items-center [&>svg]:size-[17px]", pinned ? "text-muted" : "text-text-2")} aria-hidden>
                      {icon}
                    </span>
                    <span className={cx("min-w-0 flex-1 text-body", pinned ? "text-text-2" : "text-text")}>{ut(key)}</span>
                    {pinned ? (
                      <span className="inline-flex items-center gap-1 text-caption text-muted" title={ut("acct.railPinned")}>
                        <AIc.pin size={13} />
                        {ut("adm2.pinned")}
                      </span>
                    ) : (
                      <Switch
                        checked={!hidden.includes(key)}
                        disabled={busy}
                        onChange={(on) => void applyPref({ railHidden: on ? hidden.filter((k) => k !== key) : [...hidden, key] })}
                        label={<span className="sr-only">{ut(key)}</span>}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title={ut("acct.deleteTitle")} icon={<AIc.userX />}>
              <p className="m-0 text-small text-text-2">{ut("acct.deleteWhy")}</p>
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <PasswordPanel
              email={user?.email ?? ""}
              login={login}
              mfa={mfa}
              onFactorChanged={() => {
                mfa.reload();
                void refreshUser();
              }}
            />
            <Panel id="acct-google" title={ut("adm2.google")} icon={<AIc.globe />}>
              <div className="flex items-center gap-3">
                <span className="inline-grid size-9 shrink-0 place-items-center rounded-[10px] bg-sunk text-muted">
                  <AIc.logOut size={16} />
                </span>
                <span className="min-w-0 flex-1 text-small leading-[18px]">
                  <b className="block font-bold text-text">{ut("pt.google")}</b>
                  <span className="text-text-2">{user?.googleLinked ? ut("pt.googleLinked") : ut("adm2.googleNotLinked")}</span>
                </span>
                {user?.googleLinked ? (
                  /*
                    Отвязка спрашивает пароль: это снятие второго ключа от
                    учётной записи, операция того же класса, что смена пароля.
                  */
                  <GoogleUnlink onDone={() => void refreshUser()} />
                ) : (
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
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
            <DevicesPanel devices={devices.data ?? null} loading={devices.loading} />
          </div>
        </div>
      </div>
    </Page>
  );
}

function Setting({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <li className="flex min-h-[56px] flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-divider py-2 last:border-0">
      <span className="flex min-w-0 flex-col">
        <b className="text-body font-bold text-text">{label}</b>
        {hint ? <small className="text-caption text-muted">{hint}</small> : null}
      </span>
      {children}
    </li>
  );
}

/* ─────────── сводка защиты ─────────── */

function ProtectionPanel({ mfa, googleLinked, mustChange }: { mfa: Awaited<ReturnType<typeof api.mfaStatus>> | null; googleLinked: boolean; mustChange: boolean }) {
  const { ut } = useLang();
  const items = [
    { ok: !mustChange, title: mustChange ? ut("adm2.stateTemp") : ut("adm2.passwordOwn"), sub: mustChange ? ut("adm2.tempPasswordPop") : ut("adm2.passwordOwnSub") },
    {
      ok: !!mfa?.enabled,
      title: ut("acct.mfa.title"),
      sub: mfa ? (mfa.enabled ? fill(ut("adm2.mfaSince"), { date: mfa.confirmedAt ? dmy(mfa.confirmedAt) : "" }) : ut("adm2.mfaOff")) : "",
    },
    {
      ok: !!mfa?.enabled && mfa.recoveryLeft > 0,
      title: ut("acct.mfa.codesTitle"),
      sub: mfa?.enabled ? fill(ut("adm2.codesOf"), { n: mfa.recoveryLeft, total: RECOVERY_TOTAL }) : ut("adm2.codesAfterMfa"),
    },
    { ok: true, title: ut("pt.google"), sub: googleLinked ? ut("pt.googleLinked") : ut("adm2.googleNotLinked"), neutral: !googleLinked },
  ];
  const score = items.filter((i) => i.ok && !i.neutral).length;
  const max = items.filter((i) => !i.neutral).length;
  return (
    <Panel
      title={ut("adm2.protection")}
      icon={<Ic.shieldCheck />}
      tone="good"
      actions={
        mfa ? (
          <span className="flex items-center gap-2">
            <b className={cx("text-small font-extrabold", score === max ? "text-good" : "text-warn")}>
              {fill(score === max ? ut("adm2.protectionGood") : ut("adm2.protectionPartial"), { n: score, total: max })}
            </b>
            <span className="flex gap-1" aria-hidden>
              {Array.from({ length: max }, (_, i) => (
                <i key={i} className={cx("block h-1.5 w-7 rounded-[3px]", i < score ? (score === max ? "bg-good" : "bg-warn") : "bg-track")} />
              ))}
            </span>
          </span>
        ) : null
      }
    >
      {!mfa ? (
        <Loading rows={1} bare />
      ) : (
        <ul className="m-0 grid list-none gap-4 p-0 min-[900px]:grid-cols-4">
          {items.map((it) => (
            <li key={it.title} className="flex items-start gap-2.5">
              {it.neutral ? (
                <Ic.minus size={18} className="mt-0.5 shrink-0 text-muted" />
              ) : it.ok ? (
                <Ic.circleCheck size={18} className="mt-0.5 shrink-0 text-good" />
              ) : (
                <Ic.circleAlert size={18} className="mt-0.5 shrink-0 text-warn" />
              )}
              <span className="min-w-0 text-small leading-[18px]">
                <b className="block font-bold text-text">{it.title}</b>
                <span className="text-text-2">{it.sub}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ─────────── данные о себе ─────────── */

function DataPanel() {
  const { ut } = useLang();
  const { user, refreshUser } = useAuth();
  const { run, busy } = useAction();
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [middleName, setMiddleName] = useState(user?.middleName ?? "");
  const [sex, setSex] = useState<Sex | "">(user?.sex ?? "");
  const [birthDate, setBirthDate] = useState(user?.birthDate ?? "");
  const [specialty, setSpecialty] = useState(user?.specialty ?? "");
  const dirty =
    firstName !== (user?.firstName ?? "") ||
    lastName !== (user?.lastName ?? "") ||
    middleName !== (user?.middleName ?? "") ||
    sex !== (user?.sex ?? "") ||
    birthDate !== (user?.birthDate ?? "") ||
    specialty !== (user?.specialty ?? "");
  return (
    <Panel
      id="acct-data"
      title={ut("acct.data")}
      icon={<Ic.user />}
      sub={ut("adm2.whoIsSub")}
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-small text-muted">{dirty ? ut("adm2.unsaved") : ut("adm2.noChanges")}</span>
          <Button
            className="ml-auto"
            variant={dirty ? "primary" : "secondary"}
            icon={<Ic.check size={15} />}
            disabled={busy || !dirty || !firstName.trim() || !lastName.trim()}
            onClick={() =>
              void run(async () => {
                await api.updateMe({
                  firstName: firstName.trim(),
                  lastName: lastName.trim(),
                  middleName: middleName.trim() || null,
                  sex: sex || null,
                  birthDate: birthDate || null,
                  specialty: specialty.trim() || null,
                });
                await refreshUser();
              }, ut("acct.saved"))
            }
          >
            {ut("common.save")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-x-3 min-[640px]:grid-cols-2">
        <Field label={ut("person.lastName")}>
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} />
        </Field>
        <Field label={ut("person.firstName")}>
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={80} />
        </Field>
        <Field label={ut("adm2.middleName")} optional>
          <Input value={middleName} onChange={(e) => setMiddleName(e.target.value)} maxLength={80} />
        </Field>
        <Field label={ut("person.sex")}>
          <Select value={sex} onChange={(e) => setSex(e.target.value as Sex | "")}>
            <option value="">{ut("ppl.unset")}</option>
            <option value="female">{ut("person.sex.female")}</option>
            <option value="male">{ut("person.sex.male")}</option>
          </Select>
        </Field>
        <Field label={ut("person.birthDate")} optional>
          <Input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
        </Field>
        <Field label={ut("ppl.specialty")} optional>
          <Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} maxLength={160} />
        </Field>
      </div>
      <Field label={ut("adm2.emailLogin")} hint={ut("adm2.emailByAdmin")}>
        <Input value={user?.email ?? ""} disabled icon={<Ic.lock size={15} />} />
      </Field>
    </Panel>
  );
}

/* ─────────── пароль и второй фактор ─────────── */

function PasswordPanel({
  email,
  login,
  mfa,
  onFactorChanged,
}: {
  email: string;
  login: (email: string, password: string) => Promise<unknown>;
  mfa: { data: Awaited<ReturnType<typeof api.mfaStatus>> | null; error: string | null; reload: () => void };
  onFactorChanged: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [show, setShow] = useState(false);
  /* пароль, который сервер уже принял: повтор после неудачного входа только входит (passwordModel.ts) */
  const [accepted, setAccepted] = useState<string | null>(null);
  const issues = passwordProblems({ current, next });
  const strength = strengthOf(next);
  return (
    <Panel id="acct-password" title={ut("adm2.passwordAndSignIn")} icon={<Ic.lock />}>
      <Field label={ut("acct.currentPassword")}>
        <Input type={show ? "text" : "password"} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Field>
      {/* длина и «совпадает с текущим» — словами у поля, до нажатия: граница та же, что у сервера */}
      <Field label={ut("acct.newPassword")} error={issues.next ? ut(issues.next) : null}>
        <Input
          type={show ? "text" : "password"}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          suffix={
            <button
              type="button"
              aria-label={show ? ut("adm2.hidePassword") : ut("adm2.showPassword")}
              aria-pressed={show}
              onClick={() => setShow((v) => !v)}
              className="inline-grid size-7 min-h-0 cursor-pointer place-items-center rounded-[8px] border-0 bg-transparent p-0 text-muted hover:bg-sunk hover:text-text"
            >
              {show ? <AIc.eyeOff size={15} /> : <Ic.eye size={15} />}
            </button>
          }
        />
      </Field>
      {next ? (
        <div className="-mt-1.5 mb-3 flex flex-col gap-1.5">
          <span className="flex items-center gap-2">
            <span className="flex gap-1" aria-hidden>
              {[1, 2, 3, 4].map((i) => (
                <i key={i} className={cx("block h-1.5 w-8 rounded-[3px]", i <= strength ? (strength >= 3 ? "bg-good" : "bg-warn") : "bg-track")} />
              ))}
            </span>
            <b className={cx("text-small font-bold", strength >= 3 ? "text-good" : "text-warn")}>{ut(strength >= 3 ? "adm2.strong" : "adm2.weak")}</b>
          </span>
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-2">
            <Check ok={next.length >= 10} label={ut("adm2.atLeast10")} />
            <Check ok={!!next && next !== current} label={ut("adm2.differsFromCurrent")} />
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          icon={<AIc.key size={15} />}
          disabled={busy || (accepted === null && !passwordReady({ current, next }))}
          onClick={() =>
            void run(async () => {
              /*
               * Смена гасит все сессии, и эту тоже: без входа заново первый же
               * следующий запрос упирался бы в погашенную сессию. Вход — тем
               * паролем, который сервер принял.
               */
              await changePassword(
                { current, next },
                accepted,
                {
                  change: (c, n) => api.changePassword(c, n),
                  relogin: (password) => login(email, password),
                },
                setAccepted,
              );
              setCurrent("");
              setNext("");
              setAccepted(null);
            }, ut("acct.passwordChanged"))
          }
        >
          {ut("acct.changePassword")}
        </Button>
        <span className="text-small text-muted">{ut("adm2.otherSessionsEnd")}</span>
      </div>
      <div className="mt-4 border-t border-divider pt-4">
        <SecondFactor mfa={mfa} onChanged={onFactorChanged} />
      </div>
    </Panel>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1", ok ? "text-good" : "text-muted")}>
      {ok ? <Ic.check size={13} /> : <Ic.minus size={13} />}
      {label}
    </span>
  );
}

/** Сила пароля 0…4: длина и разнообразие знаков — подсказка, а не правило; правило — 10 знаков у сервера */
export function strengthOf(p: string): number {
  if (!p) return 0;
  let s = p.length >= 10 ? 2 : p.length >= 6 ? 1 : 0;
  const kinds = [/[a-zа-яіїєґ]/, /[A-ZА-ЯІЇЄҐ]/, /\d/, /[^\p{L}\d]/u].filter((r) => r.test(p)).length;
  if (kinds >= 3) s++;
  if (p.length >= 14) s++;
  return Math.min(4, s);
}

/**
 * Второй фактор: состояние, включение с QR и кодом, коды восстановления —
 * один раз и в окне, которое не закрывается, пока их не сохранили;
 * выключение паролем и кодом. Те же маршруты, что у экрана обязательной
 * настройки (/api/auth/mfa/*).
 */
function SecondFactor({
  mfa,
  onChanged,
}: {
  mfa: { data: Awaited<ReturnType<typeof api.mfaStatus>> | null; error: string | null; reload: () => void };
  onChanged: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const [off, setOff] = useState({ password: "", code: "" });
  if (mfa.error) return <Loading error={mfa.error} onRetry={mfa.reload} bare />;
  if (!mfa.data) return <Loading rows={2} bare />;
  const s = mfa.data;

  return (
    <>
      <div className="flex items-start gap-3">
        <span className={cx("inline-grid size-9 shrink-0 place-items-center rounded-[10px]", s.enabled ? "bg-good-tint text-good" : "bg-sunk text-muted")}>
          <AIc.smartphone size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <b className="text-body font-extrabold text-text">{ut("acct.mfa.title")}</b>
            {s.enabled ? (
              <Tag tone="good" icon={<Ic.check />}>
                {ut("adm2.enabled")}
              </Tag>
            ) : (
              <Tag tone="attention">{ut("adm2.disabledShort")}</Tag>
            )}
          </span>
          <small className="block text-small text-text-2">
            {s.enabled ? fill(ut("adm2.mfaAppSince"), { date: s.confirmedAt ? dmy(s.confirmedAt) : "" }) : ut("acct.mfa.off")}
          </small>
        </span>
      </div>

      {s.enabled ? (
        <div className="mt-3 rounded-panel bg-sunk px-3.5 py-3">
          <span className="flex items-center justify-between text-small">
            <span className="text-text-2">{ut("acct.mfa.left")}</span>
            <b className="font-extrabold tabular-nums text-text">{fill(ut("adm2.nOf"), { n: s.recoveryLeft, total: RECOVERY_TOTAL })}</b>
          </span>
          <span className="mt-2 grid grid-cols-10 gap-1" aria-hidden>
            {Array.from({ length: RECOVERY_TOTAL }, (_, i) => (
              <i key={i} className={cx("block h-1.5 rounded-[3px]", i < s.recoveryLeft ? "bg-violet" : "bg-track")} />
            ))}
          </span>
        </div>
      ) : null}

      {setup ? (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const res = await api.mfaConfirm(code.trim());
              setSetup(null);
              setCode("");
              setCodes(res.recoveryCodes);
            }, ut("acct.mfa.enabledDone"));
          }}
        >
          <p className="m-0 text-small text-text-2">{ut("acct.mfa.scan")}</p>
          <div className="flex flex-wrap items-start gap-4">
            <Qr url={setup.otpauthUrl} label={ut("acct.mfa.qr")} />
            <div className="flex min-w-[200px] flex-1 flex-col">
              <span className="mb-1.5 block text-caption font-bold text-muted">{ut("acct.mfa.key")}</span>
              <output className="mb-3 block rounded-control bg-sunk px-3 py-2 font-mono text-[14px] text-text select-all [overflow-wrap:anywhere]">
                {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
              </output>
              <Field label={ut("acct.mfa.code")}>
                <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={9} autoFocus className="font-mono" />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={busy || code.replace(/\D/g, "").length !== 6}>
                  {ut("acct.mfa.confirm")}
                </Button>
                <Button variant="ghost" onClick={() => setSetup(null)}>
                  {ut("common.cancel")}
                </Button>
              </div>
            </div>
          </div>
        </form>
      ) : turningOff ? (
        <form
          className="mt-3 flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.mfaDisable(off.password, off.code.trim());
              setOff({ password: "", code: "" });
              setTurningOff(false);
              onChanged();
            }, ut("acct.mfa.disabledDone"));
          }}
        >
          <p className="m-0 mb-2 text-small text-muted">{ut("acct.mfa.disableHint")}</p>
          <div className="grid gap-x-3 min-[520px]:grid-cols-2">
            <Field label={ut("acct.currentPassword")}>
              <Input type="password" value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} autoComplete="current-password" />
            </Field>
            <Field label={ut("acct.mfa.code")}>
              <Input value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} autoComplete="one-time-code" className="font-mono" />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={busy || !off.password || off.code.trim().length < 6}>
              {ut("acct.mfa.disable")}
            </Button>
            <Button variant="ghost" onClick={() => setTurningOff(false)}>
              {ut("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {s.enabled ? (
            s.required ? null : (
              <Button size="xs" variant="ghost" onClick={() => setTurningOff(true)}>
                {ut("acct.mfa.disable")}
              </Button>
            )
          ) : (
            <Button size="xs" variant="primary" icon={<AIc.smartphone size={14} />} disabled={busy} onClick={() => void run(async () => setSetup(await api.mfaSetup()))}>
              {ut("acct.mfa.enable")}
            </Button>
          )}
        </div>
      )}
      {s.required ? <p className="m-0 mt-2 text-small text-muted">{ut("acct.mfa.required")}</p> : null}

      {codes ? (
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}

function Qr({ url, label }: { url: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);
  return (
    <div
      role="img"
      aria-label={label}
      className="size-[164px] shrink-0 rounded-control bg-panel p-1 shadow-[0_0_0_1px_var(--border)] [&>svg]:size-full"
      /*
        biome-ignore lint/security/noDangerouslySetInnerHtml: SVG собирается здесь же
        из otpauth-адреса, выданного сервером; чужой разметки в нём нет
      */
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Новые коды восстановления — показываются один раз. Окно не закрывается ни
 * Esc, ни подложкой (esc={false}), пока человек не отметил, что сохранил
 * коды: потерянный листок — это учётная запись без запасного входа.
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { ut } = useLang();
  const { user } = useAuth();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `${codes.join("\r\n")}\r\n`;
  return (
    <Modal
      title={ut("adm2.newCodesTitle")}
      sub={ut("adm2.newCodesSub")}
      icon={<AIc.key />}
      esc={false}
      /* и крестик закрывает только после отметки «зберіг»: иначе он был бы обходом той же отметки */
      onClose={() => {
        if (saved) onDone();
      }}
      footer={
        <>
          <Button variant="primary" icon={<Ic.check size={15} />} disabled={!saved} onClick={onDone}>
            {ut("adm2.done")}
          </Button>
          <span className="ml-auto text-caption text-muted">{ut("adm2.codesNotAgain")}</span>
        </>
      }
    >
      <p className="m-0 text-small text-text-2">{ut("acct.mfa.codesHint")}</p>
      <ol className="m-0 mt-3 grid list-none grid-cols-2 gap-2 rounded-panel bg-sunk p-2.5 max-[480px]:grid-cols-1">
        {codes.map((c, i) => (
          <li key={c} className="flex items-center gap-3 rounded-control border border-border bg-panel px-3 py-2">
            <span className="w-5 text-right text-caption tabular-nums text-muted">{i + 1}</span>
            <code className="font-mono text-[16px] font-bold tracking-[0.06em] text-text select-all">{c}</code>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="xs" icon={<Ic.download size={14} />} onClick={() => saveFile(text, `polypsy-recovery-${user?.email ?? "codes"}.txt`, "text/plain;charset=utf-8")}>
          {ut("acct.mfa.download")}
        </Button>
        <Button
          size="xs"
          icon={<AIc.copy size={14} />}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? ut("adm2.copied") : ut("adm2.copy")}
        </Button>
        <Button size="xs" icon={<AIc.printer size={14} />} onClick={() => window.print()}>
          {ut("adm2.print")}
        </Button>
      </div>
      <div className="mt-3">
        <Callout kind="info">{ut("adm2.codesLogged")}</Callout>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2.5">
        <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-px" />
        <span className="text-small">
          <b className="block font-bold text-text">{ut("acct.mfa.savedCodes")}</b>
          <small className="text-caption text-muted">{ut("adm2.savedCodesSub")}</small>
        </span>
      </label>
    </Modal>
  );
}

function GoogleUnlink({ onDone }: { onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  if (!asking) {
    return (
      <Button size="xs" variant="ghost" onClick={() => setAsking(true)}>
        {ut("pt.googleUnlink")}
      </Button>
    );
  }
  return (
    <Modal
      title={ut("pt.googleUnlink")}
      icon={<AIc.globe />}
      onClose={() => setAsking(false)}
      footer={
        <>
          <Button
            variant="primary"
            disabled={busy || !password}
            onClick={() =>
              void run(async () => {
                await api.googleUnlink(password);
                setAsking(false);
                setPassword("");
                onDone();
              }, ut("acct.saved"))
            }
          >
            {ut("pt.googleUnlink")}
          </Button>
          <Button variant="ghost" onClick={() => setAsking(false)}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <Field label={ut("acct.currentPassword")} hint={ut("lg.googleUnlinkAsk")}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
      </Field>
    </Modal>
  );
}

/** Свои устройства — установки мобильного приложения, привязанные к записи */
function DevicesPanel({ devices, loading }: { devices: Awaited<ReturnType<typeof api.devices>> | null; loading: boolean }) {
  const { ut } = useLang();
  return (
    <Panel
      id="acct-devices"
      title={ut("adm2.devices")}
      icon={<AIc.monitor />}
      count={devices ? devices.length : null}
      sub={ut("adm2.devicesSub")}
      flush
    >
      {!devices ? (
        <div className="px-4 pb-4">{loading ? <Loading rows={2} bare /> : null}</div>
      ) : devices.length ? (
        <ul className="m-0 list-none p-0">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 border-t border-divider px-4 py-2.5">
              <span className="inline-grid size-8 shrink-0 place-items-center rounded-[9px] bg-sunk text-muted">
                <AIc.smartphone size={15} />
              </span>
              <span className="min-w-0 flex-1 text-small leading-[18px]">
                <b className="block truncate font-bold text-text">{d.label ?? d.platform ?? ut("adm2.device")}</b>
                <span className="text-text-2">{d.platform ?? ""}</span>
              </span>
              <span className="whitespace-nowrap text-small tabular-nums text-text-2">
                {d.wipedAt ? ut("adm2.wiped") : d.wipeRequestedAt ? ut("adm2.wipePending") : whenShort(d.lastSeenAt, ut)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 border-t border-divider px-4 py-3 text-small text-muted">{ut("adm2.noDevices")}</p>
      )}
    </Panel>
  );
}
