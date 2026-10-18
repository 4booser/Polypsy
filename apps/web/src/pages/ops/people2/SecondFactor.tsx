import { useMemo, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import type { MfaSetup } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { dateTime } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction } from "../../../ui";
import { Ic } from "../../../ui/icons";
import { IconTile } from "../../../ui/layout";
import { Button, Field, Input } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
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
  /*
   * Polypsy 2.0: одна карточка посреди фона, без рамки консоли — рабочего
   * места за ней всё равно нет. Тот же вид, что в показе на «Другому
   * факторі» техпанели (MfaPolicy.tsx, GatePanel): значок, заголовок,
   * пояснение, настройка и «Вийти».
   */
  return (
    <main className="grid min-h-dvh place-items-center bg-ground px-4 py-10">
      <section aria-labelledby="mfa-gate-title" className="w-full max-w-[600px] rounded-drawer border border-border bg-panel p-6 shadow-panel">
        <div className="flex items-center gap-3">
          <IconTile icon={<Sx.smartphoneNfc />} size={40} />
          <h1 id="mfa-gate-title" className="m-0 text-big font-extrabold tracking-[-0.02em] text-text">
            {ut("mfa.gate.title")}
          </h1>
        </div>
        <p className="m-0 mt-2.5 text-body text-text-2">{ut("mfa.gate.sub")}</p>
        <p className="m-0 mt-1.5 text-small text-muted [overflow-wrap:anywhere]">{user?.email}</p>
        <div className="mt-4 border-t border-divider pt-4">
          <SecondFactorSettings onEnabled={refreshUser} />
        </div>
        <div className="mt-4 border-t border-divider pt-3">
          <Button variant="quiet" onClick={logout}>
            {ut("nav.logout")}
          </Button>
        </div>
      </section>
    </main>
  );
}
