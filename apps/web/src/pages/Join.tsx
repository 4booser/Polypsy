import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { InvitePreview } from "@quizzy/shared";
import { api } from "../api";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Drawer, Ic } from "../ui";
import { cx } from "../ui/cx";
import { IconTile, Panel } from "../ui/layout";
import {
  Button,
  ButtonLink,
  CheckLabel,
  Checkbox,
  ErrorText,
  Field,
  Input,
  Segmented,
  Tag,
  buttonClass,
} from "../ui/primitives";
import { useResource } from "../useResource";
import { AccessIcon, type AccessIconName } from "./public/accessIcons";
import { AuthCard, CrisisNote, PasswordInput, fill, patientField, rich } from "./public/authParts";
import { PublicFrame } from "./public/PublicFrame";

/**
 * Регистрация пациента по приглашению (набор «Виразна», access-join и
 * access-join-invalid) — экран регистра пациента: 16 по тексту, поля 48,
 * «Допомога» в шапке всегда под рукой.
 *
 * Слева — что за приглашение и что будет дальше, справа — форма. Имени
 * пригласившего здесь нет и не будет: предпросмотр приглашения (GET
 * /api/invites/preview) намеренно отдаёт наружу только название набора или
 * методики и подразделение — ссылка ходит по почте и мессенджерам, и состав
 * отделения из неё узнавать незачем.
 *
 * После регистрации в консоль не пускаем (она для персонала) — экран
 * говорит, где теперь входить: застосунок на телефоне или кабинет в
 * браузере, той же почтой и паролем.
 */
const ptLabel = "mb-1.5 block text-[14px] font-bold leading-[18px] text-muted";

export default function Join() {
  const { token } = useParams<{ token: string }>();
  const { ut } = useLang();
  /*
   * Предпросмотр — загрузкой (волна 13). Голый fetch в эффекте не знал ни
   * языка страницы, ни об обрыве связи: без сети человек читал «посилання
   * недійсне», хотя ссылка была в порядке. Теперь обрыв — это «перевіряємо»
   * до возвращения связи (и проверка повторится сама), а «недійсне з
   * невідомої причини» остаётся для отказа сервера, как и было.
   */
  const previewRes = useResource(() => api.invitePreview(token!), [token], { enabled: !!token });
  const preview: InvitePreview | null =
    previewRes.data ?? (previewRes.error ? { valid: false, reason: "unknown" } : null);
  const [done, setDone] = useState(false);
  const [help, setHelp] = useState(false);

  const pill = (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={help}
      onClick={() => setHelp(true)}
      className={cx(
        "inline-flex h-11 min-h-0 shrink-0 cursor-pointer items-center gap-2 rounded-pill border-0 bg-panel px-4",
        "text-[15px] font-extrabold text-violet-ink shadow-[inset_0_0_0_1px_var(--ctl)] hover:bg-violet-tint",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] max-[600px]:px-3",
      )}
    >
      <ShellIcon name="life-buoy" size={18} />
      {ut("pt.help")}
    </button>
  );

  const title = preview?.batteryTitle ?? preview?.surveyTitle ?? null;

  return (
    <PublicFrame extra={pill}>
      {preview === null ? (
        <div className="flex justify-center pt-10">
          <AuthCard className="max-w-[480px]">
            <p className="m-0 text-[16px] text-muted" role="status">
              {ut("join.checking")}
            </p>
          </AuthCard>
        </div>
      ) : !preview.valid ? (
        <Invalid reason={preview.reason ?? "unknown"} onHelp={() => setHelp(true)} />
      ) : done ? (
        <Done title={title} />
      ) : (
        <Register preview={preview} token={token!} onDone={() => setDone(true)} onHelp={() => setHelp(true)} />
      )}
      <HelpCalls open={help} onClose={() => setHelp(false)} />
    </PublicFrame>
  );
}

function Register({
  preview,
  token,
  onDone,
  onHelp,
}: {
  preview: InvitePreview;
  token: string;
  onDone: () => void;
  onHelp: () => void;
}) {
  const { ut } = useLang();
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [sex, setSex] = useState<"male" | "female" | "">("");
  const [birthDate, setBirthDate] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          phone,
          anonymous,
          firstName: anonymous ? undefined : firstName,
          lastName: anonymous ? undefined : lastName,
          middleName: anonymous ? undefined : middleName || undefined,
          sex: sex || undefined,
          birthDate: birthDate || undefined,
          inviteCode: token,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `${ut("join.errorPrefix")} ${res.status}`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("join.registerFailed"));
    } finally {
      setBusy(false);
    }
  }

  const title = preview.batteryTitle ?? preview.surveyTitle ?? null;
  const ready = !!email && !!phone && password.length >= 8 && (anonymous || (!!firstName && !!lastName));
  const req = (label: string) => `${label} *`;

  const steps: { icon: AccessIconName | "smartphone" | "clipboard-check"; t: string; d: string }[] = [
    { icon: "user-plus", t: ut("ax.jn.n1t"), d: ut("ax.jn.n1") },
    { icon: "smartphone", t: ut("ax.jn.n2t"), d: ut("ax.jn.n2") },
    { icon: "clipboard-check", t: ut("ax.jn.n3t"), d: ut("ax.jn.n3") },
    { icon: "message-circle", t: ut("ax.jn.n4t"), d: ut("ax.jn.n4") },
  ];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_480px] items-start gap-16 pb-4 pt-5 text-[16px] leading-6 max-[1180px]:gap-10 max-[1000px]:grid-cols-1">
      <div className="min-w-0">
        <h1 className="m-0 max-w-[620px] text-[40px] font-extrabold leading-[46px] tracking-[-0.035em] text-text [text-wrap:balance] max-[600px]:text-[32px] max-[600px]:leading-[38px]">
          {ut("join.invited")}
        </h1>
        <p className="m-0 mt-2.5 max-w-[620px] text-[17px] font-semibold leading-[26px] text-text-2">{ut("ax.jn.lead")}</p>

        <Panel
          title={ut("ax.jn.invite")}
          icon={<AccessIcon name="mail-check" />}
          actions={
            <Tag tone="primary" icon={<AccessIcon name="calendar-check" />}>
              {ut("ax.jn.valid")}
            </Tag>
          }
          footer={
            <span className="flex items-center gap-1.5 text-small text-text-2">
              <AccessIcon name="pause" size={15} />
              {ut("ax.jn.pause")}
            </span>
          }
          className="mt-6"
        >
          {title ? (
            <div className="flex flex-col gap-1 rounded-panel bg-sunk px-3.5 py-3">
              <small className="text-[13.5px] leading-[18px] text-muted">
                {preview.batteryTitle ? ut("ax.jn.battery") : ut("ax.jn.survey")}
              </small>
              <b className="text-[17px] font-extrabold leading-[22px] text-text">{title}</b>
            </div>
          ) : (
            <p className="m-0 text-[15px] leading-[22px] text-text-2">{ut("ax.jn.noBattery")}</p>
          )}
          {preview.unit ? (
            <p className="m-0 mt-3 flex items-center gap-2 text-[15px] text-text-2">
              <span className="text-muted">{ut("person.unit")}</span>
              <b className="font-extrabold text-text">{preview.unit}</b>
            </p>
          ) : null}
        </Panel>

        <h2 className="m-0 mt-8 text-big font-extrabold text-text">{ut("ax.jn.nextTitle")}</h2>
        <ol className="m-0 mt-3.5 list-none p-0">
          {steps.map((s, i) => (
            <li
              key={s.t}
              className={cx(
                "relative grid grid-cols-[36px_minmax(0,1fr)] gap-3.5 pb-[18px] text-[15px] leading-[22px] text-text-2 last:pb-0",
                "before:absolute before:bottom-0.5 before:left-[17px] before:top-[38px] before:w-0.5 before:rounded-[1px] before:bg-divider before:content-[''] last:before:hidden",
              )}
            >
              <span
                aria-hidden
                className={cx(
                  "grid size-9 place-items-center rounded-full",
                  i === 0
                    ? "bg-violet text-onfill shadow-[0_0_0_4px_var(--vtint)]"
                    : "bg-panel text-muted shadow-[inset_0_0_0_1.5px_var(--ctl)]",
                )}
              >
                {s.icon === "smartphone" || s.icon === "clipboard-check" ? (
                  <ShellIcon name={s.icon} size={16} />
                ) : (
                  <AccessIcon name={s.icon} size={16} />
                )}
              </span>
              <span>
                <b className="block pt-1.5 text-[16px] font-extrabold leading-[22px] text-text">{s.t}</b>
                {s.d}
              </span>
            </li>
          ))}
        </ol>

        <CrisisNote
          className="mt-6 !px-4 !py-3.5 !text-[15px] [&_b]:!text-[16px]"
          title={ut("ax.jn.helpTitle")}
          template={ut("ax.jn.help")}
          actions={
            <Button variant="paper" size="xs" icon={<ShellIcon name="phone" size={14} />} onClick={onHelp}>
              {ut("ax.jn.whoCall")}
            </Button>
          }
        />
      </div>

      <AuthCard labelledBy="jn-title" className="max-w-[480px] max-[1000px]:justify-self-center">
        <h2 id="jn-title" className="m-0 text-big font-extrabold text-text">
          {ut("join.registerTitle")}
        </h2>
        <p className="m-0 mt-1.5 text-[16px] leading-6 text-text-2">{ut("ax.jn.formLead")}</p>
        <form
          className="mt-5 flex flex-col gap-4 [&_[data-field]>span]:!text-[14px] [&_[data-field]>span]:!leading-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void submit();
          }}
        >
          {/*
            Телефон обязателен и здесь: регистрация по приглашению — та же
            регистрация, и заводить аккаунт без номера значит завести
            человека, которому при сработавшей тревоге некуда позвонить.
          */}
          <Field label={req(ut("reg.phone"))} labelClassName={ptLabel} hint={ut("reg.phoneWhy")} className="!mb-0">
            <Input
              type="tel"
              icon={<ShellIcon name="phone" size={16} />}
              className={patientField}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              required
            />
          </Field>
          <Field label={req(ut("ax.lg.email"))} labelClassName={ptLabel} className="!mb-0">
            <Input
              type="email"
              icon={<AccessIcon name="at-sign" size={16} />}
              className={patientField}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </Field>
          <Field label={req(ut("lg.password"))} labelClassName={ptLabel} hint={ut("ax.jn.pwHint")} className="!mb-0">
            <PasswordInput
              patient
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <div className="h-px bg-divider" />
          <CheckLabel
            className="!text-[15px] !font-semibold !text-text [&_small]:!text-[13.5px] [&_small]:!leading-[19px]"
            control={<Checkbox checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />}
            label={ut("join.anonymous")}
            sub={ut("join.anonymousHint")}
          />
          {anonymous ? null : (
            <>
              <div className="grid grid-cols-2 gap-4 max-[520px]:grid-cols-1">
                <Field label={req(ut("person.lastName"))} labelClassName={ptLabel} className="!mb-0">
                  <Input
                    className={patientField}
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="family-name"
                    required
                  />
                </Field>
                <Field label={req(ut("person.firstName"))} labelClassName={ptLabel} className="!mb-0">
                  <Input
                    className={patientField}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoComplete="given-name"
                    required
                  />
                </Field>
              </div>
              <Field label={ut("person.middleName")} labelClassName={ptLabel} optional className="!mb-0">
                <Input
                  className={patientField}
                  value={middleName}
                  onChange={(e) => setMiddleName(e.target.value)}
                  autoComplete="additional-name"
                />
              </Field>
            </>
          )}
          <div className="grid grid-cols-2 items-start gap-4 max-[520px]:grid-cols-1">
            <div className="flex min-w-0 flex-col">
              <span id="jn-sex" className={ptLabel}>
                {ut("person.sex")}
              </span>
              {/* повторное нажатие снимает выбор: поле необязательное, как было и в списке с «—» */}
              <Segmented
                wide
                label={ut("person.sex")}
                value={sex}
                onChange={(k) => setSex((cur) => (cur === k ? "" : k))}
                items={[
                  { key: "male", label: <span className="inline-block first-letter:uppercase">{ut("person.sex.male")}</span> },
                  { key: "female", label: <span className="inline-block first-letter:uppercase">{ut("person.sex.female")}</span> },
                ]}
                className="h-12 items-stretch [&>button]:!h-[42px] [&>button]:!text-[15px]"
              />
            </div>
            <Field label={ut("person.birthDate")} labelClassName={ptLabel} className="!mb-0">
              <Input
                type="date"
                className={patientField}
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                autoComplete="bday"
              />
            </Field>
          </div>
          <p className="m-0 -mt-1 flex items-start gap-1.5 text-[14px] leading-5 text-muted">
            <Ic.info size={14} className="mt-[3px]" />
            {ut("person.normsHint")}
          </p>
          {error ? (
            <div role="alert">
              <ErrorText className="!text-[14px]">{error}</ErrorText>
            </div>
          ) : null}
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy || !ready}>
            {busy ? ut("join.creating") : ut("join.register")}
          </Button>
          <p className="m-0 text-center text-[14px] leading-5 text-muted">
            {ut("ax.jn.haveAccount")}{" "}
            <Link to="/login" className="font-bold text-violet-ink no-underline hover:underline">
              {ut("ax.jn.signInLink")}
            </Link>
          </p>
        </form>
      </AuthCard>
    </div>
  );
}

/** Запись создана: где теперь входить — застосунок или кабинет, той же почтой */
function Done({ title }: { title: string | null }) {
  const { ut } = useLang();
  return (
    <div className="flex justify-center pt-10">
      <AuthCard labelledBy="jn-done" className="max-w-[560px] text-[16px] leading-6">
        <IconTile icon={<Ic.check />} tone="good" size={48} />
        <h1 id="jn-done" className="m-0 mt-5 text-[32px] font-extrabold leading-[38px] tracking-[-0.03em] text-text">
          {ut("ax.jn.doneTitle")}
        </h1>
        {title ? (
          <p className="m-0 mt-3 text-[17px] font-semibold leading-[26px] text-text">
            {fill(ut("ax.jn.doneBattery"), { title })}
          </p>
        ) : null}
        <p className="m-0 mt-2 text-text-2">{ut("ax.jn.doneNext")}</p>
        <ButtonLink to="/login" variant="primary" size="lg" className="mt-6 w-full">
          <ShellIcon name="log-in" size={18} />
          {ut("lg.signIn")}
        </ButtonLink>
      </AuthCard>
    </div>
  );
}

const REASONS = ["expired", "exhausted", "revoked", "unknown"] as const;
type Reason = (typeof REASONS)[number];
const REASON_ICON: Record<Reason, ReactNode> = {
  expired: <AccessIcon name="calendar-x" size={17} />,
  exhausted: <Ic.checkCheck size={17} />,
  revoked: <Ic.ban size={17} />,
  unknown: <AccessIcon name="link-off" size={17} />,
};

/** Приглашение не действует: причина словами, как получить новое и кому звонить, если плохо сейчас */
function Invalid({ reason, onHelp }: { reason: string; onHelp: () => void }) {
  const { ut } = useLang();
  const mine: Reason = (REASONS as readonly string[]).includes(reason) ? (reason as Reason) : "unknown";
  const phone = ut("pub.phone");
  const email = ut("pub.email");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-7 pb-4 pt-6 text-[16px] leading-6 max-[1000px]:grid-cols-1">
      <AuthCard labelledBy="ji-title" className="px-9 pb-[34px] pt-8 max-[600px]:px-5">
        <span aria-hidden className="grid size-14 place-items-center rounded-[17px] bg-warn-tint text-warn supports-[corner-shape:squircle]:rounded-[18px] supports-[corner-shape:squircle]:[corner-shape:squircle]">
          <AccessIcon name="mail-x" size={26} />
        </span>
        <h1
          id="ji-title"
          className="m-0 mt-5 text-[40px] font-extrabold leading-[46px] tracking-[-0.035em] text-text max-[600px]:text-[32px] max-[600px]:leading-[38px]"
        >
          {ut("join.invalidTitle")}
        </h1>
        <p className="m-0 mt-2.5 max-w-[620px] text-[17px] font-semibold leading-[26px] text-text-2">
          {ut(`join.reason.${mine}`)}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <a href={`tel:${phone.replace(/\s+/g, "")}`} className={buttonClass("primary", "md")}>
            <ShellIcon name="phone" size={18} />
            {ut("ax.jn.call")}
          </a>
          <a href={`mailto:${email}`} className={buttonClass("secondary", "md")}>
            <AccessIcon name="mail" size={18} />
            {ut("ax.jn.mail")}
          </a>
          <ButtonLink to="/login" variant="ghost" size="md">
            <ShellIcon name="log-in" size={18} />
            {ut("ax.jn.registered")}
          </ButtonLink>
        </div>
        <p className="m-0 mt-2.5 text-[14px] leading-5 text-muted">
          {rich(ut("ax.jn.contacts"), {
            phone: <b className="font-bold text-text">{phone}</b>,
            email: <b className="font-bold text-text">{email}</b>,
          })}
        </p>
        <CrisisNote
          className="mt-6 !px-4 !py-3.5 !text-[15px] [&_b]:!text-[16px]"
          title={ut("ax.jn.helpTitle")}
          template={ut("ax.jn.helpInvalid")}
          actions={
            <Button variant="paper" size="xs" icon={<ShellIcon name="phone" size={14} />} onClick={onHelp}>
              {ut("ax.jn.whoCall")}
            </Button>
          }
        />
      </AuthCard>
      <Panel title={ut("ax.jn.whyTitle")} icon={<ShellIcon name="circle-help" />} tone="neutral">
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {REASONS.map((r) => (
            <li
              key={r}
              className={cx(
                "grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3 rounded-panel p-3 text-[14px] leading-5 text-text-2",
                r === mine && "bg-warn-tint",
              )}
            >
              <span
                aria-hidden
                className={cx(
                  "grid size-9 place-items-center rounded-[11px]",
                  r === mine ? "bg-panel text-warn" : "bg-sunk text-muted",
                )}
              >
                {REASON_ICON[r]}
              </span>
              <span>
                <b className="flex flex-wrap items-center gap-2 text-[15px] font-extrabold leading-[22px] text-text">
                  {ut(`ax.jn.r.${r}.t`)}
                  {r === mine ? <Tag tone="attention">{ut("ax.jn.yours")}</Tag> : null}
                </b>
                {ut(`ax.jn.r.${r}`)}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/**
 * «Потрібна допомога зараз» — кому звонить, одним нажатием (help_pane
 * набора), как в кабинете пациента. Красным — только 103: это единственная
 * строка про угрозу жизни. Номера — ссылками tel:, без подтверждения.
 */
function HelpCalls({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ut } = useLang();
  const rows = [
    { key: "hotline", name: ut("home.hotline"), sub: ut("pt.helpHotlineSub"), num: ut("home.hotlineNumber"), risk: false },
    { key: "emergency", name: ut("pt.emergency"), sub: ut("pt.emergencySub"), num: ut("pt.emergencyNumber"), risk: true },
  ];
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={ut("pt.helpTitle")}
      sub={ut("pt.helpSub")}
      icon={<ShellIcon name="life-buoy" size={18} />}
    >
      <div className="pb-[18px] pt-[14px]">
        <div className="overflow-hidden rounded-[16px] border border-border">
          {rows.map((r) => (
            <a
              key={r.key}
              href={`tel:${r.num}`}
              aria-label={`${ut("pt.helpCall")}: ${r.name}, ${r.num}`}
              className="group grid min-h-[66px] grid-cols-[minmax(0,1fr)_auto_44px] items-center gap-3 border-t border-divider py-[9px] pl-4 pr-[14px] text-text no-underline first:border-t-0 hover:bg-panel-2 hover:no-underline"
            >
              <span className="min-w-0">
                <b className={cx("block text-[16px] font-extrabold leading-[22px]", r.risk && "text-risk-ink")}>{r.name}</b>
                <small className="block truncate text-[14px] font-semibold leading-[19px] text-muted">{r.sub}</small>
              </span>
              <span className={cx("text-[20px] font-extrabold leading-none tabular-nums", r.risk ? "text-risk-ink" : "text-violet-ink")}>
                {r.num}
              </span>
              <span
                aria-hidden
                className={cx(
                  "grid size-11 place-items-center rounded-[14px]",
                  r.risk ? "bg-risk text-onfill group-hover:bg-risk-hover" : "bg-violet-tint text-violet-ink group-hover:bg-violet-tint-2",
                )}
              >
                <ShellIcon name="phone" size={19} />
              </span>
            </a>
          ))}
        </div>
        <p className="m-0 mt-3 text-[14px] leading-5 text-muted">{ut("ax.jn.helpNote")}</p>
      </div>
    </Drawer>
  );
}
