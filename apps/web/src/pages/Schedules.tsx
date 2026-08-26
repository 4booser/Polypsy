import { useEffect, useMemo, useState } from "react";
import type { Battery, Schedule, ScheduleScope } from "@quizzy/shared";
import { api, type Patient } from "../api";
import { day } from "../format";
import { Empty, IconBattery, Loading, PageHead, Search, useAction } from "../ui";

/**
 * Расписание повторных обследований.
 *
 * Расписание выдаёт батарею, а не отдельную методику: повторный замер почти
 * всегда идёт набором, а вторая ветка выдачи заданий завела бы свои правила
 * доступа и свой прогресс. Батарея из одной методики закрывает частный случай.
 */
export default function Schedules() {
  const [rows, setRows] = useState<Schedule[] | null>(null);
  const [batteries, setBatteries] = useState<Battery[]>([]);
  const [units, setUnits] = useState<string[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const run = useAction();

  const reload = () => api.schedules().then(setRows).catch(() => setRows([]));

  useEffect(() => {
    reload();
    api.batteries().then((b) => setBatteries(b.filter((x) => !x.archived))).catch(() => {});
    api.scheduleUnits().then(setUnits).catch(() => {});
    api.patients().then(setPatients).catch(() => {});
  }, []);

  return (
    <>
      <PageHead
        title="Расписание повторов"
        sub="Периодическая выдача батарей: входной контроль, плановые замеры, динамика"
        actions={
          <button className="primary" disabled={!batteries.length} onClick={() => setEditing("new")}>
            Новое расписание
          </button>
        }
      />

      {!batteries.length && rows ? (
        <Empty
          title="Сначала нужна батарея"
          hint="Расписание выдаёт батарею целиком. Соберите набор в разделе «Батареи» — из одной методики тоже можно."
        />
      ) : null}

      {editing ? (
        <ScheduleEditor
          schedule={editing === "new" ? null : editing}
          batteries={batteries}
          units={units}
          patients={patients}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}

      {!rows ? <Loading /> : null}
      {rows && !rows.length && batteries.length && !editing ? (
        <Empty
          title="Расписаний нет"
          hint="Заведите повтор, чтобы плановые замеры выдавались сами, а не по памяти"
        />
      ) : null}

      {rows?.map((s) => (
        <div className={`card${s.active ? "" : " muted-card"}`} key={s.id}>
          <div className="card-head">
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconBattery />
              {s.title}
              {s.active ? null : <span className="chip static">выключено</span>}
            </h2>
            <div className="row tight">
              <button
                onClick={() =>
                  run(async () => {
                    await api.runSchedule(s.id);
                    await reload();
                  }, "Расписание отработало")
                }
                disabled={!s.active}
              >
                Запустить сейчас
              </button>
              <button onClick={() => setEditing(s)}>Править</button>
              <button
                className="danger"
                onClick={() =>
                  run(async () => {
                    await api.deleteSchedule(s.id);
                    await reload();
                  }, "Расписание удалено")
                }
              >
                Удалить
              </button>
            </div>
          </div>

          <div className="tiles">
            <div className="tile">
              <span className="label">Период</span>
              <span className="value">{everyLabel(s.intervalDays)}</span>
            </div>
            <div className="tile">
              <span className="label">Охват</span>
              <span className="value">{s.reach}</span>
              <span className="label">{s.scope === "unit" ? (s.unit ?? "—") : "поимённо"}</span>
            </div>
            <div className="tile">
              <span className="label">Срок на прохождение</span>
              <span className="value">{s.dueDays}</span>
              <span className="label">дней</span>
            </div>
            <div className="tile">
              <span className="label">Ближайшая выдача</span>
              <span className="value" style={{ fontSize: 17 }}>
                {s.active ? day(s.nextRunAt) : "—"}
              </span>
            </div>
          </div>

          <p className="hint">
            Батарея: {s.batteryTitle} · с {day(s.startsAt)}
            {s.endsAt ? ` по ${day(s.endsAt)}` : ", бессрочно"}
            {s.lastRunAt ? ` · последняя выдача ${day(s.lastRunAt)}` : " · ещё не выдавалось"}
          </p>

          {s.reach === 0 ? (
            <p className="hint warn">
              Сейчас расписание никого не охватывает
              {s.scope === "unit"
                ? `: в подразделении «${s.unit}» нет обследуемых`
                : ": список пуст"}
              . Оно отработает вхолостую.
            </p>
          ) : null}

          {s.runs.length ? (
            <div className="nested">
              <h3>Последние срабатывания</h3>
              <table>
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th className="num">Назначено</th>
                    <th className="num">Пропущено</th>
                    <th>Примечание</th>
                  </tr>
                </thead>
                <tbody>
                  {s.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="muted">{day(r.ranAt)}</td>
                      <td className="num">{r.assigned}</td>
                      <td className="num muted">{r.skipped}</td>
                      <td className="muted">
                        {r.note ?? (r.skipped ? "пропущены те, у кого задание ещё открыто" : "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

/** Период человеческими словами: «каждые 90 дней» читается хуже, чем «раз в квартал» */
function everyLabel(days: number): string {
  if (days === 1) return "ежедневно";
  if (days === 7) return "еженедельно";
  if (days === 14) return "раз в 2 недели";
  if (days === 30 || days === 31) return "ежемесячно";
  if (days === 90 || days === 91) return "раз в квартал";
  if (days === 180) return "раз в полгода";
  if (days === 365) return "ежегодно";
  return `раз в ${days} дн.`;
}

const PRESETS: [string, number][] = [
  ["Еженедельно", 7],
  ["Ежемесячно", 30],
  ["Раз в квартал", 90],
  ["Раз в полгода", 180],
  ["Ежегодно", 365],
];

function ScheduleEditor({
  schedule,
  batteries,
  units,
  patients,
  onClose,
  onSaved,
}: {
  schedule: Schedule | null;
  batteries: Battery[];
  units: string[];
  patients: Patient[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [batteryId, setBatteryId] = useState(schedule?.batteryId ?? batteries[0]?.id ?? "");
  const [scope, setScope] = useState<ScheduleScope>(schedule?.scope ?? "unit");
  const [unit, setUnit] = useState(schedule?.unit ?? units[0] ?? "");
  const [intervalDays, setIntervalDays] = useState(schedule?.intervalDays ?? 90);
  const [dueDays, setDueDays] = useState(schedule?.dueDays ?? 14);
  const [startsAt, setStartsAt] = useState((schedule?.startsAt ?? new Date().toISOString()).slice(0, 10));
  const [endsAt, setEndsAt] = useState(schedule?.endsAt?.slice(0, 10) ?? "");
  const [active, setActive] = useState(schedule?.active ?? true);
  const [picked, setPicked] = useState<string[]>(schedule?.targets.map((t) => t.userId) ?? []);
  const [query, setQuery] = useState("");
  const run = useAction();

  const byId = useMemo(() => new Map(patients.map((p) => [p.id, p])), [patients]);
  const found = useMemo(
    () =>
      patients
        .filter((p) => !picked.includes(p.id))
        .filter((p) => `${p.fullName} ${p.email}`.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8),
    [patients, picked, query],
  );

  // охват по подразделению считаем прямо в форме: цифру нужно видеть до
  // сохранения, а не узнавать из первого срабатывания
  const unitReach = patients.filter((p) => p.unit === unit).length;

  const save = () =>
    run(async () => {
      const payload = {
        title,
        batteryId,
        scope,
        unit: scope === "unit" ? unit : null,
        userIds: scope === "users" ? picked : [],
        intervalDays,
        dueDays,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        active,
      };
      if (schedule) await api.updateSchedule(schedule.id, payload);
      else await api.createSchedule(payload);
      onSaved();
    }, schedule ? "Расписание обновлено" : "Расписание заведено");

  return (
    <div className="card">
      <div className="card-head">
        <h2>{schedule ? "Правка расписания" : "Новое расписание"}</h2>
        <button onClick={onClose}>Закрыть</button>
      </div>

      <div className="form-grid">
        <label className="field grow">
          <span>Название</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Например, плановый замер личного состава"
          />
        </label>
        <label className="field grow">
          <span>Батарея</span>
          <select value={batteryId} onChange={(e) => setBatteryId(e.target.value)}>
            {batteries.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title} · {b.items.length} методик
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3 style={{ marginTop: 16 }}>Как часто</h3>
      <div className="row tight">
        {PRESETS.map(([label, days]) => (
          <button
            key={days}
            className={`chip ${intervalDays === days ? "active" : ""}`}
            onClick={() => setIntervalDays(days)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <label className="field">
          <span>Период, дней</span>
          <input
            type="number"
            min={1}
            value={intervalDays}
            onChange={(e) => setIntervalDays(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <label className="field">
          <span>Дней на прохождение</span>
          <input
            type="number"
            min={1}
            value={dueDays}
            onChange={(e) => setDueDays(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <label className="field">
          <span>Начало</span>
          <input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </label>
        <label className="field">
          <span>Окончание</span>
          <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
      </div>
      <p className="hint">
        Первая выдача произойдёт в дату начала, дальше — каждые {intervalDays} дн. от плановой
        сетки, а не от фактического запуска: задержка сервера не сдвигает график.
        {dueDays >= intervalDays ? (
          <> Срок на прохождение не меньше периода — задания начнут накладываться друг на друга.</>
        ) : null}
      </p>

      <h3 style={{ marginTop: 16 }}>Кого охватывает</h3>
      <div className="row tight">
        <button className={`chip ${scope === "unit" ? "active" : ""}`} onClick={() => setScope("unit")}>
          Подразделение целиком
        </button>
        <button className={`chip ${scope === "users" ? "active" : ""}`} onClick={() => setScope("users")}>
          Поимённый список
        </button>
      </div>

      {scope === "unit" ? (
        <>
          <label className="field grow" style={{ marginTop: 12, maxWidth: 380 }}>
            <span>Подразделение</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {units.length ? null : <option value="">— нет подразделений —</option>}
              {units.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </label>
          <p className="hint">
            Сейчас в подразделении {unitReach} обследуемых. Состав считается в момент выдачи, поэтому
            те, кто придёт позже, попадут в ближайший повтор автоматически.
          </p>
        </>
      ) : (
        <>
          <div style={{ marginTop: 12, maxWidth: 380 }}>
            <Search value={query} onChange={setQuery} placeholder="Найти обследуемого" />
          </div>
          {query ? (
            <div className="row tight" style={{ marginTop: 8 }}>
              {found.length ? (
                found.map((p) => (
                  <button key={p.id} onClick={() => { setPicked([...picked, p.id]); setQuery(""); }}>
                    + {p.fullName}
                  </button>
                ))
              ) : (
                <span className="hint">Никого не найдено</span>
              )}
            </div>
          ) : null}
          <div className="row tight" style={{ marginTop: 10 }}>
            {picked.length ? (
              picked.map((id) => (
                <span key={id} className="chip static">
                  {byId.get(id)?.fullName ?? id}
                  <button
                    className="chip-x"
                    aria-label="Убрать"
                    onClick={() => setPicked(picked.filter((x) => x !== id))}
                  >
                    ×
                  </button>
                </span>
              ))
            ) : (
              <span className="hint">Список пуст</span>
            )}
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 18 }}>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Расписание включено
        </label>
        <div className="spacer" />
        <button
          className="primary"
          onClick={save}
          disabled={
            !title.trim() ||
            !batteryId ||
            (scope === "unit" ? !unit : picked.length === 0)
          }
        >
          Сохранить
        </button>
        <button onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}
