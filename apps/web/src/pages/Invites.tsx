import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { Battery, Invite } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Empty, Loading, PageHead, useAction } from "../ui";

/**
 * Приглашения: вход пациента по ссылке, QR или короткому коду.
 *
 * Токен показывается один раз при создании — в базе только хеш, и «посмотреть
 * ссылку ещё раз» невозможно намеренно. Код остаётся видимым: он для диктовки
 * по телефону и ввода руками, его перехват без пары email+пароль бесполезен.
 */
export default function Invites() {
  const [rows, setRows] = useState<Invite[] | null>(null);
  const [batteries, setBatteries] = useState<Battery[]>([]);
  const [fresh, setFresh] = useState<{ token: string; code: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const run = useAction();

  const reload = () => api.invites().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    reload();
    api.batteries().then((b) => setBatteries(b.filter((x) => !x.archived))).catch(() => {});
  }, []);

  return (
    <>
      <PageHead
        title="Приглашения"
        sub="Ссылка или код — и пациент регистрируется сам, уже с назначенной батареей"
        actions={<button className="primary" onClick={() => setShowForm(true)}>Создать приглашение</button>}
      />

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
        <Empty title="Приглашений нет" hint="Создайте ссылку — пациент зарегистрируется сам и сразу получит назначение" />
      ) : null}

      {rows?.length ? (
        <div className="card scroll-x">
          <table>
            <thead>
              <tr>
                <th>Код</th>
                <th>Батарея</th>
                <th>Подразделение</th>
                <th className="num">Входов</th>
                <th>Действует до</th>
                <th>Создал</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const dead = !!inv.revokedAt || inv.usedCount >= inv.maxUses || inv.expiresAt < new Date().toISOString();
                return (
                  <tr key={inv.id} className={dead ? "muted-row" : undefined}>
                    <td style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{inv.code}</td>
                    <td>{inv.batteryTitle ?? <span className="muted">без батареи</span>}</td>
                    <td className="muted">{inv.unit ?? "—"}</td>
                    <td className="num">
                      {inv.usedCount}/{inv.maxUses}
                      {inv.uses.length ? (
                        <div className="hint">{inv.uses.map((u) => u.fullName).join(", ")}</div>
                      ) : null}
                    </td>
                    <td className={dead ? "muted" : undefined}>
                      {inv.revokedAt ? `отозвано ${day(inv.revokedAt)}` : day(inv.expiresAt)}
                    </td>
                    <td className="muted">{inv.createdByName}</td>
                    <td>
                      {!dead ? (
                        <button
                          className="danger"
                          onClick={() =>
                            run(async () => {
                              await api.revokeInvite(inv.id);
                              await reload();
                            }, "Приглашение отозвано")
                          }
                        >
                          Отозвать
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
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
  const [batteryId, setBatteryId] = useState("");
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [ttlDays, setTtlDays] = useState(14);
  const run = useAction();

  return (
    <div className="card">
      <div className="card-head">
        <h2>Новое приглашение</h2>
        <button onClick={onClose}>Закрыть</button>
      </div>
      <div className="form-grid">
        <label className="field grow">
          <span>Батарея (назначится при регистрации)</span>
          <select value={batteryId} onChange={(e) => setBatteryId(e.target.value)}>
            <option value="">без батареи — только доступ в систему</option>
            {batteries.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Подразделение</span>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="проставится аккаунту" />
        </label>
        <label className="field">
          <span>Использований</span>
          <input type="number" min={1} max={500} value={maxUses}
            onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label className="field">
          <span>Срок, дней</span>
          <input type="number" min={1} max={365} value={ttlDays}
            onChange={(e) => setTtlDays(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label className="field grow">
          <span>Заметка (видна только персоналу)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="например, «поступление 3-й роты»" />
        </label>
      </div>
      <p className="hint">
        Для группового обследования поставьте использований по числу людей — все войдут по одной
        ссылке. Подразделение из приглашения главнее введённого пациентом.
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="primary"
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
            }, "Приглашение создано")
          }
        >
          Создать
        </button>
      </div>
    </div>
  );
}

/** Показ ссылки и QR один раз после создания */
function FreshInvite({ token, code, onClose }: { token: string; code: string; onClose: () => void }) {
  const url = `${location.origin}/join/${token}`;
  const run = useAction();

  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Приглашение готово</h2>
        <button onClick={onClose}>Скрыть</button>
      </div>
      <p className="hint warn">
        Ссылка показывается один раз — в системе хранится только её отпечаток. Скопируйте или
        распечатайте сейчас. Код останется виден в списке.
      </p>
      <div className="invite-fresh">
        {/*
          biome-ignore lint/security/noDangerouslySetInnerHtml: SVG кода собирается
          здесь же из ссылки, никакие внешние данные в разметку не попадают
        */}
        <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div style={{ flex: 1, minWidth: 260 }}>
          <label className="field">
            <span>Ссылка</span>
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <label className="field">
            <span>Код для ручного ввода</span>
            <input readOnly value={code} style={{ fontFamily: "ui-monospace, monospace", fontSize: 18, fontWeight: 700 }} />
          </label>
          <div className="row tight">
            <button onClick={() => run(async () => navigator.clipboard.writeText(url), "Ссылка скопирована")}>
              Копировать ссылку
            </button>
            <button onClick={() => run(async () => navigator.clipboard.writeText(code), "Код скопирован")}>
              Копировать код
            </button>
            <button onClick={() => window.print()}>Печать с QR</button>
          </div>
        </div>
      </div>
    </div>
  );
}
