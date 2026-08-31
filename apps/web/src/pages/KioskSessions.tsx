import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { Battery, KioskSession } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Empty, Loading, Screen, useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useLiveReload } from "../events";

/**
 * Сеансы киоска: групповое обследование на одном планшете.
 *
 * Оператор создаёт сеанс, открывает ссылку на устройстве киоска и раздаёт его
 * по очереди. Прогресс приходит по каналу событий — участник появляется в
 * списке сразу, а не через десять секунд; поллинг раз в минуту остался
 * страховкой на случай, если канал оборвался. Ссылка сеанса показывается один
 * раз: в базе только отпечаток.
 */
export default function KioskSessions() {
  const { ut } = useLang();
  const [fresh, setFresh] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const res = useResource(
    async () => {
      const [rows, batteries] = await Promise.all([
        api.kioskSessions(),
        api.batteries().then((b) => b.filter((x) => !x.archived)).catch(() => [] as Battery[]),
      ]);
      return { rows, batteries };
    },
    [],
    { pollMs: 60_000 },
  );
  const reload = res.reload;
  useLiveReload(["kiosk.progress"], reload);

  return (
    <Screen res={res}>
      {({ rows, batteries }) => {
        const now = new Date().toISOString();
        const active = rows.filter((s) => !s.closedAt && s.expiresAt > now);
        const past = rows.filter((s) => !!s.closedAt || s.expiresAt <= now);
        return (
    <Page
      title={ut("ks.title")}
      sub={ut("ks.sub")}
      count={rows.length}
      actions={
        <Button variant="primary" disabled={!batteries.length} onClick={() => setShowForm(true)}>
          {ut("ks.new")}
        </Button>
      }
    >
      <Stack>
        {showForm ? (
          <SessionForm
            batteries={batteries}
            onClose={() => setShowForm(false)}
            onCreated={(token) => {
              setFresh(token);
              setShowForm(false);
              reload();
            }}
          />
        ) : null}

        {fresh ? <FreshSession token={fresh} onClose={() => setFresh(null)} /> : null}

        {!rows ? <Loading /> : null}
        {rows && !rows.length && !showForm ? (
          <Empty title={ut("ks.none")} hint={ut("ks.noneHint")} />
        ) : null}

        {active.map((s) => <SessionCard key={s.id} session={s} onChanged={reload} live />)}
        {past.length ? <h2 className="mt-5 mb-2.5 text-body text-muted">{ut("ks.finished")}</h2> : null}
        {past.slice(0, 10).map((s) => <SessionCard key={s.id} session={s} onChanged={reload} />)}
      </Stack>
    </Page>
        );
      }}
    </Screen>
  );
}

function SessionCard({ session, onChanged, live }: { session: KioskSession; onChanged: () => void; live?: boolean }) {
  const { ut } = useLang();
  const { run } = useAction();
  const done = session.participants.filter((p) => p.finishedAt).length;
  return (
    <Panel
      className={live ? undefined : "opacity-[0.62]"}
      title={session.title}
      hint={
        <>
          {session.batteryTitle} · {ut("ks.createdOn")} {day(session.createdAt)} ({session.createdByName})
          {session.closedAt ? ` · ${ut("ks.closedAt")} ${day(session.closedAt)}` : ` · ${ut("ks.activeUntil")} ${day(session.expiresAt)}`}
          {" · "}{ut("ks.passedCount")} {done} {ut("common.of")} {session.participants.length}
        </>
      }
      actions={
        <div className="row tight">
          {live ? <span className="chip static"><i className="dot live" />{ut("mark.running")}</span> : null}
          {live ? (
            <Button
              variant="danger"
              onClick={() => run(async () => { await api.closeKioskSession(session.id); onChanged(); }, ut("ks.closed"))}
            >
              {ut("ks.finish")}
            </Button>
          ) : null}
        </div>
      }
    >
      {session.participants.length ? (
        <table>
          <thead>
            <tr><th>{ut("ks.participant")}</th><th>{ut("ks.started")}</th><th>{ut("bat.progress")}</th></tr>
          </thead>
          <tbody>
            {session.participants.map((p) => (
              <tr key={p.id}>
                <td>{p.displayName}</td>
                <td className="text-muted">{new Date(p.startedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</td>
                <td>
                  {p.finishedAt
                    ? <span className="text-[var(--sev-none-text)]">{ut("mark.finished")}</span>
                    : <span>{p.doneRequired} {ut("common.of")} {p.totalRequired} {ut("f.methodsGen")}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-caption text-muted">{ut("ks.nobodyStarted")}</p>
      )}
    </Panel>
  );
}

function SessionForm({
  batteries,
  onClose,
  onCreated,
}: {
  batteries: Battery[];
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const { ut } = useLang();
  const [title, setTitle] = useState("");
  const [batteryId, setBatteryId] = useState(batteries[0]?.id ?? "");
  const [ttlHours, setTtlHours] = useState(8);
  const { run } = useAction();
  const chosen = batteries.find((b) => b.id === batteryId);
  const clinicianSteps = chosen?.items.filter((i) => i.administration === "clinician") ?? [];

  return (
    <Panel title={ut("ks.new")} actions={<button onClick={onClose}>{ut("ui.close")}</button>}>
      <div className="form-grid">
        <label className="field grow"><span>{ut("f.name")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ut("ks.namePlaceholder")} /></label>
        <label className="field grow"><span>{ut("f.battery")}</span>
          <select value={batteryId} onChange={(e) => setBatteryId(e.target.value)}>
            {batteries.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select></label>
        <label className="field"><span>{ut("ks.hours")}</span>
          <input type="number" min={1} max={72} value={ttlHours}
            onChange={(e) => setTtlHours(Math.max(1, Number(e.target.value) || 1))} /></label>
      </div>
      {clinicianSteps.length ? (
        <p className="mt-2 text-caption text-[var(--sev-mild-text)]">
          {ut("ks.clinicianStepsPrefix")} {clinicianSteps.length} {ut("f.methodsGen")}{ut("ks.clinicianStepsSuffix")}
        </p>
      ) : null}
      <div className="row mt-3">
        <Button
          variant="primary"
          disabled={!title.trim() || !batteryId}
          onClick={() =>
            run(async () => {
              const res = await api.createKioskSession({ title, batteryId, ttlHours });
              onCreated(res.token);
            }, ut("ks.created"))
          }
        >
          {ut("ks.createSession")}
        </Button>
      </div>
    </Panel>
  );
}

function FreshSession({ token, onClose }: { token: string; onClose: () => void }) {
  const { ut } = useLang();
  const url = `${location.origin}/kiosk/${token}`;
  const { run } = useAction();
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);

  return (
    <Panel title={ut("ks.ready")} actions={<button onClick={onClose}>{ut("f.hide")}</button>}>
      <p className="mb-3 text-caption text-[var(--sev-mild-text)]">
        {ut("ks.linkHint")}
      </p>
      <div className="invite-fresh">
        {/*
          biome-ignore lint/security/noDangerouslySetInnerHtml: SVG кода собирается
          здесь же из ссылки, никакие внешние данные в разметку не попадают
        */}
        <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="min-w-[260px] flex-1">
          <label className="field"><span>{ut("ks.link")}</span>
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} /></label>
          <div className="row tight">
            <button onClick={() => run(async () => navigator.clipboard.writeText(url), ut("ui.copied"))}>
              {ut("ks.copy")}
            </button>
            <a className="btn" href={url} target="_blank" rel="noreferrer">{ut("ks.openHere")}</a>
          </div>
        </div>
      </div>
    </Panel>
  );
}
