import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { Battery, KioskSession } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Empty, Loading, PageHead, useAction } from "../ui";

/**
 * Сеансы киоска: групповое обследование на одном планшете.
 *
 * Оператор создаёт сеанс, открывает ссылку на устройстве киоска и раздаёт его
 * по очереди. Прогресс обновляется здесь поллингом — видно, кто прошёл, кто в
 * процессе. Ссылка сеанса показывается один раз: в базе только отпечаток.
 */
export default function KioskSessions() {
  const [rows, setRows] = useState<KioskSession[] | null>(null);
  const [batteries, setBatteries] = useState<Battery[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const reload = () => api.kioskSessions().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    reload();
    api.batteries().then((b) => setBatteries(b.filter((x) => !x.archived))).catch(() => {});
    // живой прогресс: пока страница открыта, раз в 10 секунд
    const timer = setInterval(reload, 10_000);
    return () => clearInterval(timer);
  }, []);

  const active = rows?.filter((s) => !s.closedAt && s.expiresAt > new Date().toISOString()) ?? [];
  const past = rows?.filter((s) => !!s.closedAt || s.expiresAt <= new Date().toISOString()) ?? [];

  return (
    <>
      <PageHead
        title="Сеансы киоска"
        sub="Один планшет — поток обследуемых по очереди, с живым прогрессом"
        actions={
          <button className="primary" disabled={!batteries.length} onClick={() => setShowForm(true)}>
            Новый сеанс
          </button>
        }
      />

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
        <Empty title="Сеансов не было" hint="Создайте сеанс и откройте его ссылку на планшете — дальше устройство работает само" />
      ) : null}

      {active.map((s) => <SessionCard key={s.id} session={s} onChanged={reload} live />)}
      {past.length ? <h2 style={{ margin: "20px 0 10px", fontSize: 15 }} className="muted">Завершённые</h2> : null}
      {past.slice(0, 10).map((s) => <SessionCard key={s.id} session={s} onChanged={reload} />)}
    </>
  );
}

function SessionCard({ session, onChanged, live }: { session: KioskSession; onChanged: () => void; live?: boolean }) {
  const run = useAction();
  const done = session.participants.filter((p) => p.finishedAt).length;
  return (
    <div className={`card${live ? "" : " muted-card"}`}>
      <div className="card-head">
        <h2>{session.title}</h2>
        <div className="row tight">
          {live ? <span className="chip static"><i className="dot live" />идёт</span> : null}
          {live ? (
            <button
              className="danger"
              onClick={() => run(async () => { await api.closeKioskSession(session.id); onChanged(); }, "Сеанс закрыт")}
            >
              Завершить сеанс
            </button>
          ) : null}
        </div>
      </div>
      <p className="hint">
        {session.batteryTitle} · создан {day(session.createdAt)} ({session.createdByName})
        {session.closedAt ? ` · закрыт ${day(session.closedAt)}` : ` · действует до ${day(session.expiresAt)}`}
        {" · "}прошли {done} из {session.participants.length}
      </p>
      {session.participants.length ? (
        <table>
          <thead>
            <tr><th>Участник</th><th>Начал</th><th>Прогресс</th></tr>
          </thead>
          <tbody>
            {session.participants.map((p) => (
              <tr key={p.id}>
                <td>{p.displayName}</td>
                <td className="muted">{new Date(p.startedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</td>
                <td>
                  {p.finishedAt
                    ? <span className="good">завершил</span>
                    : <span>{p.doneRequired} из {p.totalRequired} методик</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">Пока никто не начал</p>
      )}
    </div>
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
  const [title, setTitle] = useState("");
  const [batteryId, setBatteryId] = useState(batteries[0]?.id ?? "");
  const [ttlHours, setTtlHours] = useState(8);
  const run = useAction();
  const chosen = batteries.find((b) => b.id === batteryId);
  const clinicianSteps = chosen?.items.filter((i) => i.administration === "clinician") ?? [];

  return (
    <div className="card">
      <div className="card-head">
        <h2>Новый сеанс</h2>
        <button onClick={onClose}>Закрыть</button>
      </div>
      <div className="form-grid">
        <label className="field grow"><span>Название</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, «Обследование 3-й роты, кабинет 12»" /></label>
        <label className="field grow"><span>Батарея</span>
          <select value={batteryId} onChange={(e) => setBatteryId(e.target.value)}>
            {batteries.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select></label>
        <label className="field"><span>Длительность, часов</span>
          <input type="number" min={1} max={72} value={ttlHours}
            onChange={(e) => setTtlHours(Math.max(1, Number(e.target.value) || 1))} /></label>
      </div>
      {clinicianSteps.length ? (
        <p className="hint warn">
          В батарее есть {clinicianSteps.length} методик, которые заполняет специалист, — на киоске
          они пропускаются. Внесите их через «Провести» после сеанса.
        </p>
      ) : null}
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="primary"
          disabled={!title.trim() || !batteryId}
          onClick={() =>
            run(async () => {
              const res = await api.createKioskSession({ title, batteryId, ttlHours });
              onCreated(res.token);
            }, "Сеанс создан")
          }
        >
          Создать сеанс
        </button>
      </div>
    </div>
  );
}

function FreshSession({ token, onClose }: { token: string; onClose: () => void }) {
  const url = `${location.origin}/kiosk/${token}`;
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
        <h2>Сеанс готов</h2>
        <button onClick={onClose}>Скрыть</button>
      </div>
      <p className="hint warn">
        Откройте эту ссылку на планшете киоска. Показывается один раз — дальше хранится только
        отпечаток. На планшете включите режим одного приложения (Guided Access / закрепление экрана),
        чтобы из теста нельзя было выйти в систему.
      </p>
      <div className="invite-fresh">
        {/*
          biome-ignore lint/security/noDangerouslySetInnerHtml: SVG кода собирается
          здесь же из ссылки, никакие внешние данные в разметку не попадают
        */}
        <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div style={{ flex: 1, minWidth: 260 }}>
          <label className="field"><span>Ссылка киоска</span>
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} /></label>
          <div className="row tight">
            <button onClick={() => run(async () => navigator.clipboard.writeText(url), "Скопировано")}>
              Копировать
            </button>
            <a className="btn" href={url} target="_blank" rel="noreferrer">Открыть здесь (проверка)</a>
          </div>
        </div>
      </div>
    </div>
  );
}
