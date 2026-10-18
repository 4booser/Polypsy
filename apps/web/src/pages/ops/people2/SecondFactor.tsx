import { useMemo, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import type { MfaSetup } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { dateTime } from "../../../format";
import { useLang } from "../../../lang";
import { ShellIcon } from "../../../shell/icons";
import { Avatar, Callout, Ic, Loading, useAction, useToast } from "../../../ui";
import { cx } from "../../../ui/cx";
import { IconTile, Panel } from "../../../ui/layout";
import { Button, CheckLabel, Checkbox, ErrorText, Field, Input, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { AccessIcon } from "../../public/accessIcons";
import { OtpInput, fill, rich } from "../../public/authParts";
import { PublicFrame } from "../../public/PublicFrame";
import { saveText } from "./parts";
import { Sx } from "./securityParts";

/*
 * Второй фактор на стороне человека (участок people2): настройка в
 * «Обліковому записі», экран обязательной настройки и второй шаг входа.
 *
 * Решение заказчика 2026-09-26: включить, подтвердить кодом, показать коды
 * восстановления один раз, выключить паролем и кодом. QR — qrcode-generator
 * (уже в зависимостях веба, им же рисуются приглашения); секрет рядом
 * строкой — не всякий телефон сканирует экран, ключ переписывают руками.
 */

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
      className="size-[176px] shrink-0 rounded-control bg-panel p-1 shadow-[0_0_0_1px_var(--border)] [&>svg]:size-full"
      /*
        biome-ignore lint/security/noDangerouslySetInnerHtml: SVG собирается здесь же
        из otpauth-адреса, выданного сервером; чужой разметки в нём нет
      */
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Ключ группами по четыре — так его переписывают, не сбиваясь */
const grouped = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

/**
 * Настройка второго фактора: состояние, включение с QR и кодом, коды
 * восстановления один раз, выключение паролем и кодом.
 *
 * `onEnabled` — для экрана обязательной настройки: как только фактор
 * подтверждён и коды сохранены, консоль перечитывает профиль и открывает
 * рабочее место.
 */
export function SecondFactorSettings({ onEnabled }: { onEnabled?: () => void }) {
  const { ut } = useLang();
  const { user } = useAuth();
  const { run, busy } = useAction();
  const status = useResource(() => api.mfaStatus(), []);
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [off, setOff] = useState({ password: "", code: "" });

  if (status.error) return <Loading error={status.error} onRetry={status.reload} />;
  if (!status.data) return <Loading rows={2} />;
  const s = status.data;

  /* коды восстановления — единственный показ; окно не закрывается само */
  if (codes) {
    return (
      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-h3 font-extrabold text-text">{ut("acct.mfa.codesTitle")}</h3>
        <p className="m-0 max-w-[68ch] text-small text-text-2">{ut("acct.mfa.codesHint")}</p>
        <ul className="m-0 grid max-w-[360px] list-none grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5 p-0">
          {codes.map((c) => (
            <li key={c} className="rounded-control bg-sunk px-2.5 py-1.5 font-mono text-[15px] font-semibold text-text select-all">
              {c}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button icon={<Ic.download />} onClick={() => saveText(`${codes.join("\r\n")}\r\n`, `polypsy-recovery-${user?.email ?? "codes"}.txt`, "text/plain;charset=utf-8")}>
            {ut("acct.mfa.download")}
          </Button>
          <Button
            onClick={() => {
              setCodes(null);
              status.reload();
              onEnabled?.();
            }}
          >
            {ut("acct.mfa.savedCodes")}
          </Button>
        </div>
      </div>
    );
  }

  if (setup) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void run(async () => {
        const res = await api.mfaConfirm(code.trim());
        setSetup(null);
        setCode("");
        setCodes(res.recoveryCodes);
      }, ut("acct.mfa.enabledDone"));
    };
    return (
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className="m-0 max-w-[68ch] text-body text-text-2">{ut("acct.mfa.scan")}</p>
        <div className="flex flex-wrap items-start gap-5">
          <Qr url={setup.otpauthUrl} label={ut("acct.mfa.qr")} />
          <div className="flex min-w-[240px] flex-1 flex-col gap-2.5">
            <div>
              <span className="mb-1.5 block text-caption font-bold text-muted">{ut("acct.mfa.key")}</span>
              <output className="block rounded-control bg-sunk px-2.5 py-1.5 font-mono text-[15px] font-semibold text-text select-all [overflow-wrap:anywhere]">
                {grouped(setup.secret)}
              </output>
            </div>
            <Field label={ut("acct.mfa.code")}>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={9}
                autoFocus
                className="tabular-nums"
              />
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
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {s.required ? <p className="m-0 text-small font-semibold text-warn">{ut("acct.mfa.required")}</p> : null}
      {s.enabled ? (
        <>
          <p className="m-0 text-body text-text-2">
            {ut("acct.mfa.on")} {dateTime(s.confirmedAt)}. {ut("acct.mfa.left")}:{" "}
            <b className="font-extrabold tabular-nums text-text">{s.recoveryLeft}</b>
          </p>
          {s.required ? null : (
            <form
              className="flex max-w-[420px] flex-col gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api.mfaDisable(off.password, off.code.trim());
                  setOff({ password: "", code: "" });
                  status.reload();
                }, ut("acct.mfa.disabledDone"));
              }}
            >
              <p className="m-0 mb-1.5 text-small text-muted">{ut("acct.mfa.disableHint")}</p>
              <Field label={ut("acct.currentPassword")}>
                <Input type="password" value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} autoComplete="current-password" />
              </Field>
              <Field label={ut("acct.mfa.code")}>
                <Input value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} autoComplete="one-time-code" className="tabular-nums" />
              </Field>
              <div>
                <Button type="submit" variant="danger" disabled={busy || !off.password || off.code.trim().length < 6}>
                  {ut("acct.mfa.disable")}
                </Button>
              </div>
            </form>
          )}
        </>
      ) : (
        <>
          <p className="m-0 text-body text-text-2">{ut("acct.mfa.off")}</p>
          <div>
            <Button variant="primary" disabled={busy} onClick={() => void run(async () => setSetup(await api.mfaSetup()))}>
              {ut("acct.mfa.enable")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Экран «Налаштуйте другий фактор» — вместо рабочего места (набор «Виразна»,
 * access-mfa-setup): три шага рядом, слева направо — QR-код или ключ,
 * проверка кодом, коды восстановления. Человек видит весь путь сразу и где
 * он на нём; следующий шаг открывается, когда сделан предыдущий.
 *
 * Мягкий переход (решение заказчика 2026-09-26): требование включено, фактор
 * не настроен — человек вошёл, но дальше настройки не проходит. Сервер
 * отказывает во всём остальном сам (err.mfaSetupRequired); экран здесь,
 * чтобы вместо консоли, полной отказов, человек видел одно дело, которое
 * надо сделать. Тот же приём, что у временного пароля (ForcePassword.tsx).
 *
 * Те же вызовы, что у настройки в «Обліковому записі»: начать (секрет и
 * QR), подтвердить кодом, показать коды восстановления один раз — и
 * перечитать профиль, когда человек отметил, что коды сохранены.
 *
 * Ключ создаётся по нажатию, а не при открытии: начало настройки — действие
 * на сервере (новый секрет), а не загрузка, и повторять его само по себе —
 * значит менять QR у человека на глазах, пока он наводит камеру.
 */
export function MfaSetupGate() {
  const { ut } = useLang();
  const { user, refreshUser, logout } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const start = () => {
    setStarting(true);
    setStartError(null);
    api
      .mfaSetup()
      .then(setSetup)
      .catch((e) => setStartError(e instanceof Error ? e.message : ut("ui.actionFailed")))
      .finally(() => setStarting(false));
  };

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    if (!setup || checking || code.length !== 6) return;
    setChecking(true);
    setCodeError(null);
    api
      .mfaConfirm(code)
      .then((res) => setCodes(res.recoveryCodes))
      .catch((err) => setCodeError(err instanceof Error ? err.message : ut("ui.actionFailed")))
      .finally(() => setChecking(false));
  };

  const copy = (text: string, done: string) => {
    if (!navigator.clipboard) return toast(ut("ui.actionFailed"), "err");
    void navigator.clipboard
      .writeText(text)
      .then(() => toast(done, "ok"))
      .catch(() => toast(ut("ui.actionFailed"), "err"));
  };

  /* «Polypsy:почта» — так запись подписана в приложении (lib/totp.ts, otpauthUrl) */
  const account = setup ? decodeURIComponent(setup.otpauthUrl.split("?")[0]?.split("/").pop() ?? "") : "";
  const confirmed = codes !== null;
  const name = user?.fullName || user?.email || "";

  return (
    <PublicFrame signIn={false}>
      <div className="pb-4 pt-4">
        <header className="mb-1.5 flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-3">
          <IconTile icon={<ShellIcon name="shield-check" />} size={40} />
          <h1 className="m-0 text-page font-extrabold text-text">{ut("mfa.gate.title")}</h1>
          <div className="flex flex-col border-l border-border pl-4 text-[13px] leading-[18px] text-text-2">
            <b className="font-extrabold text-text">{ut("ax.mg.required")}</b>
            <span>{ut("ax.mg.policy")}</span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-3 rounded-panel border border-border bg-panel py-1.5 pl-2 pr-1.5">
            <Avatar name={name} size={34} tone="soft" />
            <span className="flex min-w-0 flex-col">
              <b className="truncate text-body font-extrabold leading-[18px] text-text">{name}</b>
              {user?.fullName ? <small className="truncate text-caption leading-4 text-muted">{user.email}</small> : null}
            </span>
            <Button variant="ghost" size="xs" icon={<ShellIcon name="log-out" size={14} />} onClick={logout}>
              {ut("nav.logout")}
            </Button>
          </div>
        </header>
        <p className="m-0 max-w-[760px] text-[14px] leading-[21px] text-text-2">{ut("mfa.gate.sub")}</p>
        <Callout kind="info" title={ut("ax.mg.whyTitle")} className="mt-4">
          <p className="m-0">{ut("ax.mg.why")}</p>
        </Callout>

        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.36fr)] items-stretch gap-4 max-[1180px]:grid-cols-2 max-[760px]:grid-cols-1">
          {/* шаг 1: ключ — QR-кодом и строкой */}
          <Panel
            title={ut("ax.mg.s1")}
            icon={setup ? <Ic.check /> : <ShellIcon name="scan-eye" />}
            tone={setup ? "good" : "violet"}
            sub={fill(ut("ax.mg.step"), { n: 1 })}
            actions={
              setup ? (
                <Tag tone="good" icon={<Ic.check />}>
                  {ut("ax.mg.done")}
                </Tag>
              ) : null
            }
            className="h-full"
          >
            <p className="m-0 text-body leading-5 text-text-2">{ut("ax.mg.s1Text")}</p>
            {setup ? (
              <>
                <div className="mt-4 flex justify-center">
                  <QrTile url={setup.otpauthUrl} label={ut("acct.mfa.qr")} />
                </div>
                <div className="mb-1.5 mt-4 flex items-center justify-between gap-2">
                  <span className="text-caption font-bold text-muted">{ut("ax.mg.manual")}</span>
                  <span className="text-caption text-muted">{ut("ax.mg.manualSpec")}</span>
                </div>
                <div className="flex min-h-11 items-center gap-2 rounded-[12px] bg-sunk py-1 pl-3 pr-1">
                  <output className="min-w-0 flex-1 select-all font-mono text-[13px] font-semibold leading-[18px] tracking-[0.04em] text-text [overflow-wrap:anywhere]">
                    {grouped(setup.secret)}
                  </output>
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label={ut("ax.mg.copyKey")}
                    title={ut("ax.mg.copyKey")}
                    icon={<AccessIcon name="copy" />}
                    onClick={() => copy(setup.secret, ut("ax.mg.keyCopied"))}
                  />
                </div>
                <p className="m-0 mt-2.5 text-small text-muted [overflow-wrap:anywhere]">
                  {rich(ut("ax.mg.account"), { account: <b className="font-bold text-text">{account}</b> })}
                </p>
              </>
            ) : (
              <>
                <p className="m-0 mt-2 text-small text-muted">{ut("ax.mg.s1Before")}</p>
                <Button
                  variant="primary"
                  size="md"
                  className="mt-4 w-full"
                  icon={<ShellIcon name="scan-eye" size={18} />}
                  disabled={starting}
                  onClick={start}
                >
                  {ut("ax.mg.start")}
                </Button>
                {startError ? (
                  <div role="alert" className="mt-2">
                    <ErrorText>{startError}</ErrorText>
                  </div>
                ) : null}
              </>
            )}
          </Panel>

          {/* шаг 2: проверка кодом — тот же код, что потом будет при каждом входе */}
          <Panel
            title={ut("ax.mg.s2")}
            icon={confirmed ? <Ic.check /> : <ShellIcon name="key-round" />}
            tone={confirmed ? "good" : "violet"}
            sub={fill(ut("ax.mg.step"), { n: 2 })}
            actions={
              confirmed ? (
                <Tag tone="good" icon={<Ic.check />}>
                  {ut("ax.mg.codeOk")}
                </Tag>
              ) : null
            }
            footer={
              <span className="flex items-center gap-1.5 text-small text-text-2">
                <ShellIcon name="smartphone" size={14} />
                {ut("ax.mg.newPhone")}
              </span>
            }
            className="flex h-full flex-col [&>div:last-child]:mt-auto"
          >
            <p className="m-0 text-body leading-5 text-text-2">{ut("ax.mg.s2Text")}</p>
            <form className="mt-4" onSubmit={confirm} noValidate>
              <OtpInput
                value={code}
                onChange={(v) => {
                  setCode(v);
                  setCodeError(null);
                }}
                label={ut("acct.mfa.code")}
                small
                ok={confirmed}
                disabled={!setup || confirmed}
              />
              {codeError ? (
                <div role="alert" className="mt-2">
                  <ErrorText>{codeError}</ErrorText>
                </div>
              ) : null}
              {confirmed ? null : (
                <Button
                  type="submit"
                  variant={setup ? "primary" : "secondary"}
                  className="mt-3.5"
                  disabled={!setup || checking || code.length !== 6}
                >
                  {ut("acct.mfa.confirm")}
                </Button>
              )}
            </form>
            {!setup ? <p className="m-0 mt-2.5 text-small text-muted">{ut("ax.mg.s2Wait")}</p> : null}
            {confirmed ? (
              <Callout kind="good" title={ut("acct.mfa.enabledDone")} className="mt-4">
                <p className="m-0">{ut("ax.mg.s2Done")}</p>
              </Callout>
            ) : setup ? (
              <p className="m-0 mt-3 text-small text-text-2">
                <b className="font-bold text-text">{ut("ax.mg.s2HelpTitle")}</b> {ut("ax.mg.s2Help")}
              </p>
            ) : null}
            <h3 className="m-0 mb-2 mt-5 text-h3 font-extrabold text-text">{ut("ax.mg.howTitle")}</h3>
            <ul className="m-0 list-none p-0">
              {(
                [
                  ["key-round", "ax.mg.how1", "good"],
                  ["smartphone", "ax.mg.how2", "violet"],
                  ["life-buoy", "ax.mg.how3", "neutral"],
                ] as const
              ).map(([icon, key, tone]) => (
                <li
                  key={key}
                  className="flex items-center gap-2.5 border-t border-divider py-2 text-small leading-[17px] text-text-2 first:border-t-0 first:pt-0"
                >
                  <IconTile icon={<ShellIcon name={icon} />} tone={tone} size={28} />
                  {ut(key)}
                </li>
              ))}
            </ul>
          </Panel>

          {/* шаг 3: коды восстановления — показываются один раз */}
          <Panel
            title={ut("acct.mfa.codesTitle")}
            icon={<ShellIcon name="life-buoy" />}
            sub={fill(ut("ax.mg.step"), { n: 3 })}
            actions={
              <Tag tone="attention" icon={<ShellIcon name="eye" size={12} />}>
                {ut("ax.mg.once")}
              </Tag>
            }
            className={cx("h-full", confirmed && "border-violet-line shadow-[0_0_0_3px_var(--vtint)]")}
          >
            {codes ? (
              <>
                <p className="m-0 text-body leading-5 text-text-2">{ut("acct.mfa.codesHint")}</p>
                <ol aria-label={ut("acct.mfa.codesTitle")} className="m-0 mt-3.5 grid list-none grid-cols-2 gap-1.5 p-0">
                  {codes.map((c, i) => (
                    <li key={c} className="flex h-10 items-center gap-2.5 rounded-control bg-sunk px-3">
                      <i className="w-4 text-right text-[11.5px] font-bold not-italic tabular-nums text-muted">{i + 1}</i>
                      <span className="select-all font-mono text-[14px] font-semibold tracking-[0.05em] text-text">{c}</span>
                    </li>
                  ))}
                </ol>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Button
                    size="xs"
                    icon={<Ic.download />}
                    onClick={() =>
                      saveText(
                        `${codes.join("\r\n")}\r\n`,
                        `polypsy-recovery-${user?.email ?? "codes"}.txt`,
                        "text/plain;charset=utf-8",
                      )
                    }
                  >
                    {ut("acct.mfa.download")}
                  </Button>
                  <Button
                    size="xs"
                    icon={<AccessIcon name="copy" />}
                    onClick={() => copy(codes.join("\n"), ut("ax.mg.codesCopied"))}
                  >
                    {ut("ax.mg.copyCodes")}
                  </Button>
                </div>
                <CheckLabel
                  className="mt-4"
                  control={<Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />}
                  label={ut("ax.mg.saved")}
                />
                <Button
                  variant="primary"
                  size="md"
                  className="mt-4 w-full"
                  disabled={!saved}
                  iconEnd={<AccessIcon name="arrow-right" />}
                  onClick={refreshUser}
                >
                  {ut("ax.mg.go")}
                </Button>
                <p className="m-0 mt-2 text-center text-caption leading-4 text-muted">{ut("ax.mg.burn")}</p>
              </>
            ) : (
              <p className="m-0 text-body leading-5 text-muted">{ut("ax.mg.s3Wait")}</p>
            )}
          </Panel>
        </div>
      </div>
    </PublicFrame>
  );
}

/** QR на белой плитке — в обеих темах: камера читает тёмное на светлом */
function QrTile({ url, label }: { url: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [url]);
  return (
    <div
      role="img"
      aria-label={label}
      className="size-[202px] shrink-0 rounded-[16px] bg-onfill p-3.5 shadow-[inset_0_0_0_1px_var(--border)] [&>svg]:size-full"
      /*
        biome-ignore lint/security/noDangerouslySetInnerHtml: SVG собирается здесь же
        из otpauth-адреса, выданного сервером; чужой разметки в нём нет
      */
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
