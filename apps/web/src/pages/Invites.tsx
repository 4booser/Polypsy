import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { Battery } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Empty, Loading, Screen, useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Select } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Приглашения: вход пациента по ссылке, QR или короткому коду.
 *
 * Токен показывается один раз при создании — в базе только хеш, и «посмотреть
 * ссылку ещё раз» невозможно намеренно. Код остаётся видимым: он для диктовки
 * по телефону и ввода руками, его перехват без пары email+пароль бесполезен.
 */
export default function Invites() {
  const { ut } = useLang();
  const [fresh, setFresh] = useState<{ token: string; code: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const { run } = useAction();

  // батареи нужны только форме: их отказ не должен прятать сам список ссылок
  const res = useResource(async () => {
    const [rows, batteries] = await Promise.all([
      api.invites(),
      api.batteries().then((b) => b.filter((x) => !x.archived)).catch(() => [] as Battery[]),
    ]);
    return { rows, batteries };
  }, []);
  const reload = res.reload;

  return (
    <Screen res={res}>
      {({ rows, batteries }) => (
        <Page
          title={ut("inv.title")}
          sub={ut("inv.sub")}
          actions={<Button variant="primary" onClick={() => setShowForm(true)}>{ut("inv.create")}</Button>}
        >
          <Stack>
            {showForm ? (
              <InviteForm
                batteries={batteries}
                onClose={() => setShowForm(false)}
                onCreated={(t) => {
                  setFresh(t);
                  setShowForm(false);
                  reload();
                }}
              />
            ) : null}

            {fresh ? <FreshInvite token={fresh.token} code={fresh.code} onClose={() => setFresh(null)} /> : null}

            {!rows ? <Loading /> : null}
            {rows && !rows.length && !showForm ? (
              <Empty title={ut("inv.none")} hint={ut("inv.noneHint")} />
            ) : null}

            {rows?.length ? (
              <Panel flush>
                <div className="overflow-x-auto">
                  <table>
                    <thead>
                      <tr>
                        <th>{ut("inv.code")}</th>
                        <th>{ut("f.battery")}</th>
                        <th>{ut("ui.unit")}</th>
                        <th className="num">{ut("inv.entries")}</th>
                        <th>{ut("inv.expires")}</th>
                        <th>{ut("inv.createdBy")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((inv) => {
                        const dead = !!inv.revokedAt || inv.usedCount >= inv.maxUses || inv.expiresAt < new Date().toISOString();
                        return (
                          <tr key={inv.id} className={dead ? "muted-row" : undefined}>
                            <td className="font-mono font-semibold">{inv.code}</td>
                            <td>{inv.batteryTitle ?? <span className="text-muted">{ut("inv.noBattery")}</span>}</td>
                            <td className="text-muted">{inv.unit ?? "—"}</td>
                            <td className="num">
                              {inv.usedCount}/{inv.maxUses}
                              {inv.uses.length ? (
                                <div className="text-caption text-muted">{inv.uses.map((u) => u.fullName).join(", ")}</div>
                              ) : null}
                            </td>
                            <td className={dead ? "text-muted" : undefined}>
                              {inv.revokedAt ? `${ut("inf.revoked")} ${day(inv.revokedAt)}` : day(inv.expiresAt)}
                            </td>
                            <td className="text-muted">{inv.createdByName}</td>
                            <td>
                              {!dead ? (
                                <Button
                                  variant="danger"
                                  size="sm"
                                  onClick={() =>
                                    run(async () => {
                                      await api.revokeInvite(inv.id);
                                      await reload();
                                    }, ut("inv.revoked"))
                                  }
                                >
                                  {ut("inv.revoke")}
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ) : null}
          </Stack>
        </Page>
      )}
    </Screen>
  );
}

function InviteForm({
  batteries,
  onClose,
  onCreated,
}: {
  batteries: Battery[];
  onClose: () => void;
  onCreated: (t: { token: string; code: string }) => void;
}) {
  const { ut } = useLang();
  const [batteryId, setBatteryId] = useState("");
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [ttlDays, setTtlDays] = useState(14);
  const { run } = useAction();

  return (
    <Panel title={ut("inv.new")} actions={<Button variant="quiet" onClick={onClose}>{ut("ui.close")}</Button>}>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        <Field label={ut("inv.batteryOnRegister")} className="sm:col-span-2">
          <Select value={batteryId} onChange={(e) => setBatteryId(e.target.value)}>
            <option value="">{ut("inv.noBatteryHint")}</option>
            {batteries.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </Select>
        </Field>
        <Field label={ut("ui.unit")}>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={ut("inv.unitToAccount")} />
        </Field>
        <Field label={ut("inv.uses")}>
          <Input type="number" min={1} max={500} value={maxUses}
            onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={ut("inv.days")}>
          <Input type="number" min={1} max={365} value={ttlDays}
            onChange={(e) => setTtlDays(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={ut("inv.noteStaffOnly")} className="sm:col-span-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={ut("inv.reasonExample")} />
        </Field>
      </div>
      <p className="mt-3 text-caption text-muted">{ut("inv.groupHint")}</p>
      <div className="mt-3">
        <Button
          variant="primary"
          onClick={() =>
            run(async () => {
              const res = await api.createInvite({
                batteryId: batteryId || null,
                unit: unit || null,
                note: note || null,
                maxUses,
                ttlDays,
              });
              onCreated({ token: res.token, code: res.code });
            }, ut("inv.created"))
          }
        >
          {ut("inv.createSubmit")}
        </Button>
      </div>
    </Panel>
  );
}

/** Показ ссылки и QR один раз после создания */
function FreshInvite({ token, code, onClose }: { token: string; code: string; onClose: () => void }) {
  const { ut } = useLang();
  const url = `${location.origin}/join/${token}`;
  const { run } = useAction();

  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);

  return (
    <Panel title={ut("inv.ready")} actions={<Button variant="quiet" onClick={onClose}>{ut("f.hide")}</Button>}>
      {/*
        Предупреждение красится акцентом: это ровно тот случай, для
        которого он существует, — ссылку нужно скопировать сейчас, второго
        показа не будет.
      */}
      <p className="text-caption text-accent">{ut("inv.linkWarning")}</p>
      <div className="flex flex-wrap gap-5">
        {/*
          biome-ignore lint/security/noDangerouslySetInnerHtml: SVG кода собирается
          здесь же из ссылки, никакие внешние данные в разметку не попадают
        */}
        <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="min-w-[260px] flex-1">
          <Field label={ut("inv.link")}>
            <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <Field label={ut("inv.manualCode")} className="mt-2">
            <Input readOnly value={code} className="font-mono text-[18px] font-bold" />
          </Field>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button onClick={() => run(async () => navigator.clipboard.writeText(url), ut("inv.linkCopied"))}>
              {ut("inv.copyLink")}
            </Button>
            <Button onClick={() => run(async () => navigator.clipboard.writeText(code), ut("inv.codeCopied"))}>
              {ut("inv.copyCode")}
            </Button>
            <Button onClick={() => window.print()}>{ut("inv.printQr")}</Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
