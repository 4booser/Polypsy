import { useMemo, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import type { MfaSetup } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { dateTime } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction } from "../../../ui";
import { Page } from "../../../ui/layout";
import { Button, Field, Input } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { saveText } from "./parts";

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
      className="size-[176px] shrink-0 rounded-[5px] bg-[var(--bg)] p-[4px] shadow-[0_0_0_1px_var(--hairline)] [&>svg]:size-full"
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
      <div className="flex flex-col gap-[12px]">
        <h3 className="m-0 text-[17px] font-bold leading-[22px] text-primary">{ut("acct.mfa.codesTitle")}</h3>
        <p className="m-0 max-w-[68ch] text-[13px] leading-[18px] text-muted">{ut("acct.mfa.codesHint")}</p>
        <ul className="m-0 grid max-w-[360px] list-none grid-cols-2 gap-[6px] p-0">
          {codes.map((c) => (
            <li key={c} className="rounded-[5px] bg-primary-soft px-[10px] py-[6px] font-mono text-[17px] tabular-nums text-primary select-all">
              {c}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-[12px]">
          <Button variant="ghost" onClick={() => saveText(`${codes.join("\r\n")}\r\n`, `polypsy-recovery-${user?.email ?? "codes"}.txt`, "text/plain;charset=utf-8")}>
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
      <form className="flex flex-col gap-[12px]" onSubmit={submit}>
        <p className="m-0 max-w-[68ch] text-[15px] leading-[21px] text-text-2">{ut("acct.mfa.scan")}</p>
        <div className="flex flex-wrap items-start gap-[20px]">
          <Qr url={setup.otpauthUrl} label={ut("acct.mfa.qr")} />
          <div className="flex min-w-[240px] flex-1 flex-col gap-[10px]">
            <div>
              <span className="mb-[6px] block text-[13px] font-bold text-muted">{ut("acct.mfa.key")}</span>
              <output className="block rounded-[5px] bg-primary-soft px-[10px] py-[6px] font-mono text-[15px] tabular-nums text-primary select-all [overflow-wrap:anywhere]">
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
                className="font-mono tabular-nums"
              />
            </Field>
            <div className="flex gap-[12px]">
              <Button type="submit" disabled={busy || code.replace(/\D/g, "").length !== 6}>
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
    <div className="flex flex-col gap-[12px]">
      {s.required ? <p className="m-0 text-[13px] leading-[18px] text-accent">{ut("acct.mfa.required")}</p> : null}
      {s.enabled ? (
        <>
          <p className="m-0 text-[15px] leading-[21px] text-text-2">
            {ut("acct.mfa.on")} {dateTime(s.confirmedAt)} · {ut("acct.mfa.left")}:{" "}
            <span className="font-mono tabular-nums">{s.recoveryLeft}</span>
          </p>
          {s.required ? null : (
            <form
              className="flex max-w-[420px] flex-col gap-[4px]"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api.mfaDisable(off.password, off.code.trim());
                  setOff({ password: "", code: "" });
                  status.reload();
                }, ut("acct.mfa.disabledDone"));
              }}
            >
              <p className="m-0 mb-[6px] text-[13px] leading-[18px] text-muted">{ut("acct.mfa.disableHint")}</p>
              <Field label={ut("acct.currentPassword")}>
                <Input type="password" value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} autoComplete="current-password" />
              </Field>
              <Field label={ut("acct.mfa.code")}>
                <Input value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} autoComplete="one-time-code" className="font-mono tabular-nums" />
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
          <p className="m-0 text-[15px] leading-[21px] text-text-2">{ut("acct.mfa.off")}</p>
          <div>
            <Button disabled={busy} onClick={() => void run(async () => setSetup(await api.mfaSetup()))}>
              {ut("acct.mfa.enable")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Экран «Налаштуйте другий фактор» — вместо рабочего места.
 *
 * Мягкий переход (решение заказчика 2026-09-26): требование включено, фактор
 * не настроен — человек вошёл, но дальше настройки не проходит. Сервер
 * отказывает во всём остальном сам (err.mfaSetupRequired); экран здесь,
 * чтобы вместо консоли, полной отказов, человек видел одно дело, которое
 * надо сделать. Тот же приём, что у временного пароля (ForcePassword.tsx).
 */
export function MfaSetupGate() {
  const { ut } = useLang();
  const { user, refreshUser, logout } = useAuth();
  return (
    <main className="mx-auto w-full max-w-[1200px]">
      <Page title={ut("mfa.gate.title")} sub={ut("mfa.gate.sub")}>
        <div className="flex max-w-[760px] flex-col gap-[16px]">
          <p className="m-0 text-[15px] text-text-2 [overflow-wrap:anywhere]">{user?.email}</p>
          <SecondFactorSettings onEnabled={refreshUser} />
          <div>
            <Button variant="ghost" onClick={logout}>
              {ut("nav.logout")}
            </Button>
          </div>
        </div>
      </Page>
    </main>
  );
}
