import { useMemo, useState } from "react";
import type { Battery, Schedule, ScheduleScope, UiKey } from "@quizzy/shared";
import { api, type Patient } from "../api";
import { day } from "../format";
import { Empty, IconBattery, Loading, Screen, Search, useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Расписание повторных обследований.
 *
 * Расписание выдаёт батарею, а не отдельную методику: повторный замер почти
 * всегда идёт набором, а вторая ветка выдачи заданий завела бы свои правила
 * доступа и свой прогресс. Батарея из одной методики закрывает частный случай.
 */
export default function Schedules() {
  const { ut } = useLang();
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const { run } = useAction();

  // справочники нужны редактору: их отказ ограничивает выбор, но не экран
  const res = useResource(async () => {
    const [rows, batteries, units, patients] = await Promise.all([
      api.schedules(),
      api.batteries().then((b) => b.filter((x) => !x.archived)).catch(() => [] as Battery[]),
      api.scheduleUnits().catch(() => [] as string[]),
      api.patients().then((p) => p.items).catch(() => [] as Patient[]),
    ]);
    return { rows, batteries, units, patients };
  }, []);
  const reload = res.reload;

  return (
    <Screen res={res}>
      {({ rows, batteries, units, patients }) => (
    <Page
      title={ut("sch.title")}
      sub={ut("sch.sub")}
      count={rows?.length ?? null}
      actions={
        <Button variant="primary" disabled={!batteries.length} onClick={() => setEditing("new")}>
          Новое расписание
        </Button>
      }
    >
      <Stack>
        {!batteries.length && rows ? (
          <Empty
            title={ut("sch.needBattery")}
            hint={ut("sch.needBatteryHint")}
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
            title={ut("sch.none")}
            hint={ut("sch.noneHint")}
          />
        ) : null}

        {rows?.map((s) => (
          <Panel
            key={s.id}
            className={s.active ? undefined : "opacity-[0.62]"}
            title={
              <span className="flex items-center gap-2">
                <IconBattery />
                {s.title}
                {s.active ? null : <span className="chip static">{ut("sch.off")}</span>}
              </span>
            }
            actions={
              <div className="row tight">
                <button
                  onClick={() =>
                    run(async () => {
                      await api.runSchedule(s.id);
                      await reload();
                    }, ut("sch.ran"))
                  }
                  disabled={!s.active}
                >
                  {ut("sch.runNow")}
                </button>
                <button onClick={() => setEditing(s)}>{ut("f.edit")}</button>
                <Button
                  variant="danger"
                  onClick={() =>
                    run(async () => {
                      await api.deleteSchedule(s.id);
                      await reload();
                    }, ut("sch.deleted"))
                  }
                >
                  {ut("ui.delete")}
                </Button>
              </div>
            }
          >
            <div className="tiles">
              <div className="tile">
                <span className="label">{ut("sch.period")}</span>
                <span className="value">
                  {everyKey(s.intervalDays)
                    ? ut(everyKey(s.intervalDays)!)
                    : `${ut("sch.everyNDays")} ${s.intervalDays}`}
                </span>
              </div>
              <div className="tile">
                <span className="label">{ut("sch.scope")}</span>
                <span className="value">{s.reach}</span>
                <span className="label">{s.scope === "unit" ? (s.unit ?? "—") : ut("sch.byName")}</span>
              </div>
              <div className="tile">
                <span className="label">{ut("sch.deadline")}</span>
                <span className="value">{s.dueDays}</span>
                <span className="label">{ut("sch.days")}</span>
              </div>
              <div className="tile">
                <span className="label">{ut("sch.nextRun")}</span>
                <span className="value text-[17px]">
                  {s.active ? day(s.nextRunAt) : "—"}
                </span>
              </div>
            </div>

            <p className="mt-3 text-caption text-muted">
              {ut("f.battery")}: {s.batteryTitle} · {ut("sch.from")} {day(s.startsAt)}
              {s.endsAt ? ` ${ut("sch.to")} ${day(s.endsAt)}` : `, ${ut("acc.forever")}`}
              {s.lastRunAt
                ? ` · ${ut("sch.lastIssue")} ${day(s.lastRunAt)}`
                : ` · ${ut("sch.neverIssued")}`}
            </p>

            {s.reach === 0 ? (
              <p className="mt-1 text-caption text-[var(--sev-mild-text)]">
                {ut("sch.reachesNobody")}
                {s.scope === "unit"
                  ? `: ${ut("sch.noSubjectsInUnit")} «${s.unit}»`
                  : `: ${ut("sch.emptyList")}`}
                . {ut("sch.willRunIdle")}
              </p>
            ) : null}

            {s.runs.length ? (
              <div className="nested">
                <h3>{ut("sch.lastRuns")}</h3>
                <table>
                  <thead>
                    <tr>
                      <th>{ut("sch.when")}</th>
                      <th className="num">{ut("f.assigned")}</th>
                      <th className="num">{ut("sch.skipped")}</th>
                      <th>{ut("f.note")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.runs.map((r) => (
                      <tr key={r.id}>
                        <td className="text-muted">{day(r.ranAt)}</td>
                        <td className="num">{r.assigned}</td>
                        <td className="num text-muted">{r.skipped}</td>
                        <td className="text-muted">
                          {r.note ?? (r.skipped ? ut("sch.skippedHint") : "—")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Panel>
        ))}
      </Stack>
    </Page>
      )}
    </Screen>
  );
}

/**
 * Период человеческими словами: «каждые 90 дней» читается хуже, чем
 * «раз в квартал». Возвращается ключ, а не готовая строка: функция вызывается
 * из разметки, и язык должен браться при отрисовке.
 */
function everyKey(days: number): UiKey | null {
  if (days === 1) return "sch.daily";
  if (days === 7) return "sch.weekly";
  if (days === 14) return "sch.biweekly";
  if (days === 30 || days === 31) return "sch.monthly";
  if (days === 90 || days === 91) return "sch.quarterly";
  if (days === 180) return "sch.halfYear";
  if (days === 365) return "sch.yearly";
  return null;
}

const PRESETS: [UiKey, number][] = [
  ["sch.weeklyCap", 7],
  ["sch.monthlyCap", 30],
  ["sch.quarterlyCap", 90],
  ["sch.halfYearCap", 180],
  ["sch.yearlyCap", 365],
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
  const { ut } = useLang();
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
  const { run } = useAction();

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
    }, schedule ? ut("sch.updated") : ut("sch.created"));

  return (
    <Panel
      title={schedule ? ut("sch.editTitle") : ut("sch.newTitle")}
      actions={<button onClick={onClose}>{ut("ui.close")}</button>}
    >
      <div className="form-grid">
        <label className="field grow">
          <span>{ut("f.name")}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={ut("sch.namePlaceholder")}
          />
        </label>
        <label className="field grow">
          <span>{ut("f.battery")}</span>
          <select value={batteryId} onChange={(e) => setBatteryId(e.target.value)}>
            {batteries.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title} · {b.items.length} методик
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3 className="mt-4">{ut("sch.howOften")}</h3>
      <div className="row tight">
        {PRESETS.map(([label, days]) => (
          <button
            key={days}
            className={`chip ${intervalDays === days ? "active" : ""}`}
            onClick={() => setIntervalDays(days)}
          >
            {ut(label)}
          </button>
        ))}
      </div>
      <div className="form-grid mt-2.5">
        <label className="field">
          <span>{ut("sch.periodDays")}</span>
          <input
            type="number"
            min={1}
            value={intervalDays}
            onChange={(e) => setIntervalDays(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <label className="field">
          <span>{ut("sch.daysToPass")}</span>
          <input
            type="number"
            min={1}
            value={dueDays}
            onChange={(e) => setDueDays(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <label className="field">
          <span>{ut("sch.start")}</span>
          <input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </label>
        <label className="field">
          <span>{ut("sch.end")}</span>
          <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
      </div>
      <p className="mt-1 text-caption text-muted">
        Первая выдача произойдёт в дату начала, дальше — каждые {intervalDays} дн. от плановой
        сетки, а не от фактического запуска: задержка сервера не сдвигает график.
        {dueDays >= intervalDays ? (
          <> Срок на прохождение не меньше периода — задания начнут накладываться друг на друга.</>
        ) : null}
      </p>

      <h3 className="mt-4">{ut("sch.coverage")}</h3>
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
          <label className="field grow mt-3 max-w-[380px]">
            <span>{ut("sch.unit")}</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {units.length ? null : <option value="">{ut("sel.noUnits")}</option>}
              {units.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-caption text-muted">
            Сейчас в подразделении {unitReach} обследуемых. Состав считается в момент выдачи, поэтому
            те, кто придёт позже, попадут в ближайший повтор автоматически.
          </p>
        </>
      ) : (
        <>
          <div className="mt-3 max-w-[380px]">
            <Search value={query} onChange={setQuery} placeholder={ut("ui.findRespondent")} />
          </div>
          {query ? (
            <div className="row tight mt-2">
              {found.length ? (
                found.map((p) => (
                  <button key={p.id} onClick={() => { setPicked([...picked, p.id]); setQuery(""); }}>
                    + {p.fullName}
                  </button>
                ))
              ) : (
                <span className="text-caption text-muted">{ut("f.nobodyFound")}</span>
              )}
            </div>
          ) : null}
          <div className="row tight mt-2.5">
            {picked.length ? (
              picked.map((id) => (
                <span key={id} className="chip static">
                  {byId.get(id)?.fullName ?? id}
                  <button
                    className="chip-x"
                    aria-label={ut("ui.remove")}
                    onClick={() => setPicked(picked.filter((x) => x !== id))}
                  >
                    ×
                  </button>
                </span>
              ))
            ) : (
              <span className="text-caption text-muted">{ut("sch.emptyList")}</span>
            )}
          </div>
        </>
      )}

      <div className="row mt-[18px]">
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Расписание включено
        </label>
        <div className="spacer" />
        <Button
          variant="primary"
          onClick={save}
          disabled={
            !title.trim() ||
            !batteryId ||
            (scope === "unit" ? !unit : picked.length === 0)
          }
        >
          Сохранить
        </Button>
        <button onClick={onClose}>{ut("ui.cancel")}</button>
      </div>
    </Panel>
  );
}
