import { useState, type ReactNode } from "react";
import { LANG_NAMES, LANGS, type Lang } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { locale } from "../format";
import { useLang } from "../lang";
import { changePassword, passwordProblems, passwordReady } from "../pages/passwordModel";
import { SecondFactorSettings } from "../pages/ops/people2/SecondFactor";
import { ShellIcon } from "../shell/icons";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "../shell/theme";
import { Callout, Drawer, Ic, Modal, useAction } from "../ui";
import { cx } from "../ui/cx";
import { Button, Field, Input, Segmented, Select, Tag } from "../ui/primitives";
import { useResource } from "../useResource";
import { useRecheckConsent, consentSections } from "./ConsentGate";
import { Glyph, type GlyphName } from "./icons";
import { Body, Hero, PtPanel } from "./parts";

/**
 * «Мій профіль» (pt-profile «Виразної»): свои данные, вход и безопасность,
 * вид и язык, согласие, выход. Слева — кто вы и оглавление, справа — разделы.
 *
 * Телефон и почта здесь не меняются: смена телефона — способ увести чужую
 * учётную запись, и сервер такой правки пациенту не даёт. Пароль меняется
 * отдельным шагом с текущим паролем, второй фактор и отвязка Google — тоже
 * с подтверждением: операции одного класса, «ключи от учётной записи».
 *
 * Чего в макете больше, чем умеет сервер, здесь нет: сеансов на других
 * устройствах, каналов уведомлений и тихих часов, крупного текста.
 */
export default function PatientProfile() {
  const { ut } = useLang();
  const { user } = useAuth();
  const specialists = useResource(() => api.specialists(), []);
  const lead = (specialists.data?.items ?? []).find((p) => p.isLead) ?? null;

  const sections: { id: string; icon: ReactNode; label: string }[] = [
    { id: "pf-data", icon: <Ic.idCard size={17} />, label: ut("pt.myData") },
    { id: "pf-security", icon: <ShellIcon name="shield-check" size={17} />, label: ut("ptw.security") },
    { id: "pf-look", icon: <Glyph name="sun" size={17} />, label: ut("ptw.lookLang") },
    { id: "pf-consents", icon: <ShellIcon name="file-signature" size={17} />, label: ut("ptw.consents") },
    { id: "pf-exit", icon: <ShellIcon name="log-out" size={17} />, label: ut("ptw.exit") },
  ];

  return (
    <>
      <Hero title={ut("pt.titleProfile")} lead={ut("ptw.profileLead")} />
      <Body>
        <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-5 max-[1099px]:grid-cols-1">
          <aside className="flex flex-col gap-4 min-[1100px]:sticky min-[1100px]:top-4">
            <section className="flex flex-col items-center rounded-panel border border-border bg-panel px-[18px] pb-[18px] pt-[22px] text-center shadow-panel">
              <span
                aria-hidden
                className="grid size-[72px] place-items-center rounded-full bg-violet text-[24px] font-extrabold text-onfill shadow-[0_0_0_4px_var(--vtint)]"
              >
                {initialsOf(user?.fullName ?? "")}
              </span>
              <b className="mt-3 text-[18px] font-extrabold leading-6">{user?.fullName}</b>
              {user?.createdAt ? (
                <small className="text-[14px] leading-5 text-muted">{`${ut("ptw.since")} ${new Date(user.createdAt).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric" })}`}</small>
              ) : null}
              {lead ? (
                <span className="mt-3 inline-flex items-center gap-2 text-[14px] text-text-2">
                  <span aria-hidden className="grid size-7 place-items-center rounded-full bg-violet-tint text-[11px] font-extrabold text-violet-ink">
                    {initialsOf(lead.fullName)}
                  </span>
                  {`${ut("ptw.ledBy")} ${lead.fullName}`}
                </span>
              ) : null}
            </section>
            <nav aria-label={ut("ptw.profileSections")} className="rounded-panel border border-border bg-panel p-2 shadow-panel max-[1099px]:hidden">
              {sections.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="flex h-11 items-center gap-2.5 rounded-[12px] px-3 text-[15px] font-semibold text-text-2 no-underline hover:bg-sunk hover:text-text hover:no-underline [&>svg]:text-muted"
                >
                  {s.icon}
                  {s.label}
                </a>
              ))}
            </nav>
          </aside>
          <div className="flex min-w-0 flex-col gap-4">
            <DataSection />
            <SecuritySection />
            <LookSection />
            <ConsentSection />
            <ExitSection />
          </div>
        </div>
      </Body>
    </>
  );
}

function initialsOf(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Строка настройки (srow): значок, что это и как сейчас, справа — действие */
function SettingRow({ icon, title, sub, children }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-divider py-4 first:border-t-0 first:pt-1">
      <span aria-hidden className="mt-0.5 self-start text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[16px] font-extrabold leading-[22px] text-text">{title}</b>
        {sub ? <small className="mt-px block text-[14px] leading-5 text-text-2">{sub}</small> : null}
      </span>
      {children ? <span className="flex shrink-0 flex-wrap items-center gap-2">{children}</span> : null}
    </div>
  );
}

const field = "h-12! rounded-[12px]! text-[16px]!";

/** «Мої дані»: как обращаться; имя у псевдонимизированной записи не меняется (сервер его и не примет) */
function DataSection() {
  const { ut } = useLang();
  const { user, refreshUser } = useAuth();
  const { run, busy } = useAction();
  const initial = {
    lastName: user?.lastName ?? "",
    firstName: user?.firstName ?? "",
    middleName: user?.middleName ?? "",
    birthDate: user?.birthDate ?? "",
    sex: (user?.sex ?? "") as "" | "male" | "female",
    locality: user?.locality ?? "",
  };
  const [form, setForm] = useState(initial);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const named = !user?.anonymous;
  const changed = JSON.stringify(form) !== JSON.stringify(initial);

  return (
    <div id="pf-data" className="scroll-mt-4">
      <PtPanel title={ut("pt.myData")} icon={<Ic.idCard size={16} />} sub={ut("ptw.dataSub")}>
        <div className="grid grid-cols-3 gap-x-3.5 gap-y-3 max-[760px]:grid-cols-1">
          {named ? (
            <>
              <Field label={ut("adm.lastName")}>
                <Input className={field} value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} autoComplete="family-name" />
              </Field>
              <Field label={ut("adm.firstName")}>
                <Input className={field} value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} autoComplete="given-name" />
              </Field>
              <Field label={ut("adm.middleName")} optional>
                <Input className={field} value={form.middleName} onChange={(e) => set({ middleName: e.target.value })} autoComplete="additional-name" />
              </Field>
            </>
          ) : null}
          <Field label={ut("person.birthDate")}>
            <Input className={field} type="date" value={form.birthDate} onChange={(e) => set({ birthDate: e.target.value })} autoComplete="bday" />
          </Field>
          <Field label={ut("person.sex")}>
            <Select className={field} value={form.sex} onChange={(e) => set({ sex: e.target.value as typeof form.sex })}>
              <option value="">{ut("ptw.notSet")}</option>
              <option value="male">{ut("mp.male")}</option>
              <option value="female">{ut("mp.female")}</option>
            </Select>
          </Field>
          <Field label={ut("ppl.city")} optional>
            <Input className={field} value={form.locality} onChange={(e) => set({ locality: e.target.value })} autoComplete="address-level2" />
          </Field>
        </div>
        <div className="mt-3.5 grid grid-cols-2 gap-3.5 max-[760px]:grid-cols-1">
          <Field label={ut("o2b.channel.email")}>
            <Input className={cx(field, "text-text-2")} value={user?.email ?? ""} readOnly icon={<Glyph name="lock-keyhole" size={15} />} />
          </Field>
        </div>
        <p className="m-0 mt-2 flex items-start gap-1.5 text-[14px] leading-5 text-text-2">
          <Ic.info size={14} className="mt-[3px] shrink-0" />
          {ut("ptw.contactsHint")}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<Ic.check size={16} />}
            disabled={busy || !changed || (named && (!form.firstName.trim() || !form.lastName.trim()))}
            onClick={() =>
              run(async () => {
                await api.updateMe({
                  ...(named
                    ? { firstName: form.firstName.trim(), lastName: form.lastName.trim(), middleName: form.middleName.trim() || null }
                    : {}),
                  birthDate: form.birthDate || null,
                  sex: form.sex || null,
                  locality: form.locality.trim(),
                });
                await refreshUser();
              }, ut("pt.saved"))
            }
          >
            {ut("common.save")}
          </Button>
          <Button variant="ghost" disabled={!changed} onClick={() => setForm(initial)}>
            {ut("ptw.discardChanges")}
          </Button>
        </div>
      </PtPanel>
    </div>
  );
}

/** «Вхід і безпека»: пароль, второй фактор, вход через Google — каждое своим шагом с подтверждением */
function SecuritySection() {
  const { ut } = useLang();
  const { user, refreshUser, login } = useAuth();
  const { run, busy } = useAction();
  const mfa = useResource(() => api.mfaStatus(), []);
  const [pane, setPane] = useState<"password" | "mfa" | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  /* пароль, который сервер уже принял: повтор после неудачного входа только входит (passwordModel.ts) */
  const [accepted, setAccepted] = useState<string | null>(null);
  const issues = passwordProblems({ current, next });
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkPass, setUnlinkPass] = useState("");

  return (
    <div id="pf-security" className="scroll-mt-4">
      <PtPanel title={ut("ptw.security")} icon={<ShellIcon name="shield-check" size={16} />} sub={ut("ptw.securitySub")}>
        <SettingRow icon={<ShellIcon name="key-round" size={19} />} title={ut("acct.password")} sub={ut("ptw.passwordSub")}>
          <Button aria-haspopup="dialog" aria-expanded={pane === "password"} onClick={() => setPane("password")}>
            {ut("acct.changePassword")}
          </Button>
        </SettingRow>
        <SettingRow
          icon={<ShellIcon name="smartphone-nfc" size={19} />}
          title={ut("ptw.mfa")}
          sub={mfa.data?.enabled ? ut("ptw.mfaOn") : ut("ptw.mfaOff")}
        >
          {mfa.data?.enabled ? <Tag tone="good" icon={<Ic.check size={12} />}>{ut("ptw.on")}</Tag> : null}
          <Button aria-haspopup="dialog" aria-expanded={pane === "mfa"} onClick={() => setPane("mfa")}>
            {mfa.data?.enabled ? ut("ptw.manage") : ut("ptw.turnOn")}
          </Button>
        </SettingRow>
        <SettingRow
          icon={<Glyph name="lock-keyhole" size={19} />}
          title={ut("pt.google")}
          sub={user?.googleLinked ? ut("ptw.googleLinkedSub") : ut("ptw.googleOffSub")}
        >
          {user?.googleLinked ? (
            <>
              <Tag tone="good" icon={<Ic.check size={12} />}>{ut("pt.googleLinked")}</Tag>
              {/*
                Отвязка спрашивает пароль: это снятие второго ключа от учётной
                записи, операция того же класса, что смена пароля, — и
                угнанного получасового токена для неё быть достаточно не должно.
              */}
              <Button variant="ghost" disabled={busy} aria-haspopup="dialog" onClick={() => setUnlinking(true)}>
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
        </SettingRow>
      </PtPanel>

      <Drawer
        open={pane !== null}
        mode={pane ?? "password"}
        onClose={() => setPane(null)}
        title={pane === "mfa" ? ut("ptw.mfa") : ut("acct.changePassword")}
        sub={pane === "mfa" ? ut("ptw.mfaOff") : ut("ptw.passwordDrawerSub")}
        icon={pane === "mfa" ? <ShellIcon name="smartphone-nfc" size={18} /> : <ShellIcon name="key-round" size={18} />}
        footer={
          pane === "password" ? (
            <Button
              variant="primary"
              disabled={busy || (accepted === null && !passwordReady({ current, next }))}
              onClick={() =>
                run(async () => {
                  /*
                   * Смена гасит все сессии, и эту тоже: без входа заново первый
                   * же следующий запрос упирался бы в погашенную сессию. Вход —
                   * тем паролем, который сервер принял.
                   */
                  await changePassword(
                    { current, next },
                    accepted,
                    { change: (c, n) => api.changePassword(c, n), relogin: (password) => login(user!.email, password) },
                    setAccepted,
                  );
                  setCurrent("");
                  setNext("");
                  setAccepted(null);
                  setPane(null);
                }, ut("acct.passwordChanged"))
              }
            >
              {ut("acct.changePassword")}
            </Button>
          ) : undefined
        }
      >
        {pane === "mfa" ? (
          <div className="py-3">
            {/* строка «Двоетапна перевірка» читает своё состояние — перечитать и после включения, и после выключения */}
            <SecondFactorSettings
              onEnabled={() => {
                void refreshUser();
                mfa.reload();
              }}
              onDisabled={() => {
                void refreshUser();
                mfa.reload();
              }}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-3">
            <Field label={ut("acct.currentPassword")}>
              <Input className={field} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            {/* длина и «совпадает с текущим» — словами у поля, до нажатия: граница та же, что у сервера */}
            <Field label={ut("acct.newPassword")} error={issues.next ? ut(issues.next) : null}>
              <Input className={field} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            </Field>
            <Callout kind="neutral" className="text-[14px] leading-5">
              {ut("ptw.passwordNote")}
            </Callout>
          </div>
        )}
      </Drawer>

      {unlinking ? (
        <Modal
          title={ut("ptw.unlinkTitle")}
          sub={ut("lg.googleUnlinkAsk")}
          icon={<Glyph name="lock-keyhole" size={18} />}
          onClose={() => {
            setUnlinking(false);
            setUnlinkPass("");
          }}
          footer={
            <>
              <Button
                variant="danger"
                disabled={busy || !unlinkPass}
                onClick={() =>
                  run(async () => {
                    await api.googleUnlink(unlinkPass);
                    await refreshUser();
                    setUnlinking(false);
                    setUnlinkPass("");
                  }, ut("pt.saved"))
                }
              >
                {ut("pt.googleUnlink")}
              </Button>
              <Button variant="quiet" onClick={() => setUnlinking(false)}>
                {ut("ptw.keep")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-[16px] leading-6 text-text-2">{ut("ptw.unlinkText")}</p>
          <div className="mt-3">
            <Field label={ut("acct.currentPassword")}>
              <Input className={field} type="password" value={unlinkPass} onChange={(e) => setUnlinkPass(e.target.value)} autoComplete="current-password" />
            </Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** «Вигляд і мова»: язык интерфейса и тема — общие для вкладки и уходят в профиль на сервере */
function LookSection() {
  const { ut, lang, setLang } = useLang();
  /*
   * Выбор темы — общий для вкладки (shell/theme.ts). Умолчание — светлая.
   * Выбор уходит и в профиль на сервере: пациент тоже открывает кабинет с
   * разных устройств.
   */
  const theme = useThemeChoice();
  const applyTheme = (next: ThemeChoice) => {
    setThemeChoice(next);
    void api.saveWorkspace({ theme: next }).catch(() => {});
  };
  const themes: { key: ThemeChoice; label: string; sub: string; icon: GlyphName | "monitor" }[] = [
    { key: "light", label: ut("ptw.themeLight"), sub: ut("ptw.themeLightSub"), icon: "sun" },
    { key: "dark", label: ut("ptw.themeDark"), sub: ut("ptw.themeDarkSub"), icon: "moon" },
    { key: "system", label: ut("nav.themeSystem"), sub: ut("ptw.themeSystemSub"), icon: "monitor" },
  ];
  return (
    <div id="pf-look" className="scroll-mt-4">
      <PtPanel title={ut("ptw.lookLang")} icon={<Glyph name="sun" size={16} />} sub={ut("ptw.lookSub")}>
        <SettingRow icon={<Glyph name="languages" size={19} />} title={ut("pt.language")} sub={ut("ptw.languageSub")}>
          <Segmented<Lang>
            label={ut("pt.language")}
            value={lang}
            onChange={setLang}
            items={LANGS.map((code) => ({ key: code, label: <span lang={code}>{LANG_NAMES[code].full}</span> }))}
            className="[&>button]:h-10 [&>button]:px-3.5 [&>button]:text-[14px]"
          />
        </SettingRow>
        <div className="border-t border-divider pt-4">
          <div className="flex items-start gap-3.5">
            <span aria-hidden className="mt-0.5 text-muted">
              <Glyph name="sun" size={19} />
            </span>
            <span className="min-w-0 flex-1">
              <b className="block text-[16px] font-extrabold leading-[22px] text-text">{ut("pt.theme")}</b>
              <small className="mt-px block text-[14px] leading-5 text-text-2">{ut("ptw.themeSub")}</small>
            </span>
          </div>
          <div role="group" aria-label={ut("pt.theme")} className="mt-3 grid grid-cols-3 gap-2.5 pl-[33px] max-[760px]:grid-cols-1 max-[760px]:pl-0">
            {themes.map((t) => {
              const on = theme === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => applyTheme(t.key)}
                  className={cx(
                    "flex min-h-[68px] items-center gap-3 rounded-[14px] px-3.5 py-2.5 text-left",
                    "transition-[background-color,box-shadow] duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                    on
                      ? "bg-violet-tint shadow-[inset_0_0_0_2px_var(--vring)]"
                      : "bg-panel shadow-[inset_0_0_0_1px_var(--border)] hover:bg-panel-2 hover:shadow-[inset_0_0_0_1px_var(--ctl)]",
                  )}
                >
                  <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-control bg-sunk text-muted">
                    {t.icon === "monitor" ? <ShellIcon name="monitor-smartphone" size={16} /> : <Glyph name={t.icon} size={16} />}
                  </span>
                  <span className="min-w-0">
                    <b className={cx("block text-[15px] font-extrabold leading-5", on ? "text-violet-ink" : "text-text")}>{t.label}</b>
                    <small className="block text-[13px] font-semibold leading-[17px] text-muted">{t.sub}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </PtPanel>
    </div>
  );
}

/**
 * «Згоди»: текст, с которым человек согласился, — в ящике; отзыв — окном с
 * последствием. После отзыва ворота кабинета перечитывают статус и встают
 * экраном согласия (ConsentGate, useRecheckConsent): дальше кабинет без
 * согласия не пускает — так же, как сервер не принимает ответы.
 */
function ConsentSection() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const recheck = useRecheckConsent();
  const status = useResource(() => api.consentStatus(), []);
  const [reading, setReading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const text = status.data?.text?.trim() || null;
  const required = status.data?.required ?? false;

  return (
    <div id="pf-consents" className="scroll-mt-4">
      <PtPanel title={ut("ptw.consents")} icon={<ShellIcon name="file-signature" size={16} />} sub={ut("ptw.consentsSub")}>
        {required ? (
          <SettingRow
            icon={<ShellIcon name="file-text" size={19} />}
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                {ut("consent.title")}
                {status.data?.version ? (
                  <Tag tone="good" icon={<Ic.check size={12} />}>
                    {ut("ptw.consentEdition").replace("{n}", String(status.data.version))}
                  </Tag>
                ) : null}
              </span>
            }
            sub={ut("ptw.consentGiven")}
          >
            {text ? (
              <Button icon={<ShellIcon name="file-text" size={16} />} aria-haspopup="dialog" aria-expanded={reading} onClick={() => setReading(true)}>
                {ut("ptw.readText")}
              </Button>
            ) : null}
            <Button variant="ghost" aria-haspopup="dialog" onClick={() => setWithdrawing(true)}>
              {ut("ptw.withdraw")}
            </Button>
          </SettingRow>
        ) : (
          <p className="m-0 text-[15px] text-text-2">{ut("ptw.noConsentNeeded")}</p>
        )}
        <p className="m-0 mt-1 border-t border-divider pt-3.5 text-[14.5px] leading-[21px] text-text-2">{ut("ptw.withdrawNote")}</p>
      </PtPanel>

      <Drawer
        open={reading}
        onClose={() => setReading(false)}
        title={ut("consent.title")}
        sub={status.data?.version ? ut("ptw.consentEdition").replace("{n}", String(status.data.version)) : undefined}
        icon={<ShellIcon name="file-text" size={18} />}
      >
        <div className="py-3">
          {consentSections(text ?? "").map((s, i) => (
            <section key={i} className="border-t border-divider py-4 first:border-t-0 first:pt-0">
              {s.title ? <h3 className="m-0 mb-1.5 text-[16px] font-extrabold leading-[22px]">{s.title}</h3> : null}
              <p className="m-0 whitespace-pre-wrap text-[15.5px] leading-[25px] text-text-2">{s.body}</p>
            </section>
          ))}
        </div>
      </Drawer>

      {withdrawing ? (
        <Modal
          title={ut("ptw.withdrawTitle")}
          sub={ut("ptw.withdrawSub")}
          icon={<ShellIcon name="file-signature" size={18} />}
          tone="warn"
          onClose={() => setWithdrawing(false)}
          footer={
            <>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.declineConsent();
                    setWithdrawing(false);
                    recheck();
                  }, ut("ptw.withdrawn"))
                }
              >
                {ut("ptw.withdrawYes")}
              </Button>
              <Button variant="quiet" onClick={() => setWithdrawing(false)}>
                {ut("ptw.withdrawKeep")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-[16px] leading-6 text-text">{ut("ptw.withdrawText")}</p>
          <Callout kind="info" className="mt-3 text-[15px] leading-[22px]">
            {ut("ptw.withdrawVisits")}
          </Callout>
        </Modal>
      ) : null}
    </div>
  );
}

/** «Вихід»: ответы, ждущие отправки, остаются на устройстве и уйдут после следующего входа */
function ExitSection() {
  const { ut } = useLang();
  const { logout } = useAuth();
  return (
    <div id="pf-exit" className="scroll-mt-4">
      <PtPanel title={ut("ptw.exit")} icon={<ShellIcon name="log-out" size={16} />}>
        <div className="flex flex-wrap items-center gap-4">
          <p className="m-0 min-w-[240px] flex-1 text-[15px] leading-[22px] text-text-2">{ut("ptw.exitText")}</p>
          <Button icon={<ShellIcon name="log-out" size={16} />} onClick={logout}>
            {ut("consent.signOut")}
          </Button>
        </div>
      </PtPanel>
    </div>
  );
}
