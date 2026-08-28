import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  Battery,
  BatteryStep,
  SurveyGroupWithCounts,
  SurveyListItem,
} from "@quizzy/shared";
import { api, type Patient } from "../api";
import { day } from "../format";
import { Empty, IconBattery, Loading, PageHead, Screen, Search, useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Батареи: набор методик, назначаемый целиком.
 *
 * Обследование редко состоит из одной методики — обычно это скрининг, основной
 * опросник и уточняющий. Назначение по одной держится на том, что психолог
 * ничего не забудет и выдаст в нужном порядке; батарея снимает оба допущения.
 */
export default function Batteries() {
  const { ut } = useLang();
  const [editing, setEditing] = useState<Battery | "new" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const run = useAction();

  /*
   * Батареи — содержание экрана, остальные три списка нужны только редактору
   * и назначению. Их отказ не должен прятать сам список: пустой справочник
   * ограничит выбор, но не оставит человека перед пустым экраном.
   */
  const res = useResource(async () => {
    const [rows, surveys, groups, patients] = await Promise.all([
      api.batteries(),
      api.surveys().catch(() => [] as SurveyListItem[]),
      api.groups().catch(() => [] as SurveyGroupWithCounts[]),
      api.patients().then((p) => p.items).catch(() => [] as Patient[]),
    ]);
    return { rows, surveys, groups, patients };
  }, []);
  const reload = res.reload;

  return (
    <Screen res={res}>
      {({ rows, surveys, groups, patients }) => (
    <>
      <PageHead
        title={ut("bt.title")}
        sub={ut("bt.sub")}
        actions={<button className="primary" onClick={() => setEditing("new")}>{ut("bt.assemble")}</button>}
      />

      {editing ? (
        <BatteryEditor
          battery={editing === "new" ? null : editing}
          surveys={surveys}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}

      {!rows.length && !editing ? (
        <Empty
          title={ut("bt.none")}
          hint={ut("bt.noneHint")}
        />
      ) : null}

      {rows?.map((b) => (
        <div className={`card${b.archived ? " muted-card" : ""}`} key={b.id}>
          <div className="card-head">
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconBattery />
              {b.title}
              {b.archived ? <span className="chip static">архив</span> : null}
            </h2>
            <div className="row tight">
              <button onClick={() => setOpenId(openId === b.id ? null : b.id)}>
                {openId === b.id ? ut("bt.collapseAssignments") : `Назначения · ${b.activeAssignments}`}
              </button>
              <button onClick={() => setEditing(b)}>{ut("f.edit")}</button>
              <button
                className="danger"
                onClick={() =>
                  run(async () => {
                    await api.deleteBattery(b.id);
                    await reload();
                  }, ut("bt.deleted"))
                }
              >
                Удалить
              </button>
            </div>
          </div>

          {b.description ? <p className="hint">{b.description}</p> : null}
          <p className="hint">
            {b.groupTitle ? `Группа: ${b.groupTitle}` : ut("bt.noGroup")} ·{" "}
            {b.strictOrder ? "строгий порядок" : "свободный порядок"} · всего{" "}
            {b.items.reduce((sum, i) => sum + i.questionCount, 0)} пунктов
            {totalMinutes(b) !== null ? ` · ориентировочно ${totalMinutes(b)} мин` : null}
          </p>

          {b.items.some((i) => i.administration === "clinician") &&
          b.items.some((i) => i.administration === "self") ? (
            <p className="hint warn">
              В батарее смешаны режимы. Шаги, которые заполняет специалист, обследуемый увидит,
              но открыть не сможет — при строгом порядке они задержат остальные, пока их не
              внесут через «Провести».
            </p>
          ) : null}

          <ol className="battery-steps">
            {b.items.map((item) => (
              <li key={item.surveyId}>
                <Link to={`/surveys/${item.surveyId}`}>{item.title}</Link>
                <span className="hint">
                  {item.questionCount} пунктов
                  {item.medianMinutes !== null ? ` · медиана ${item.medianMinutes} мин` : " · длительность неизвестна"}
                  {item.required ? "" : " · необязательная"}
                  {item.administration === "clinician" ? " · заполняет специалист" : ""}
                </span>
              </li>
            ))}
          </ol>

          {openId === b.id ? <Assignments battery={b} patients={patients} /> : null}
        </div>
      ))}
    </>
      )}
    </Screen>
  );
}

/** Суммарный ориентир по батарее: считаем только там, где известны все методики */
function totalMinutes(b: Battery): number | null {
  if (!b.items.length || b.items.some((i) => i.medianMinutes === null)) return null;
  return Math.round(b.items.reduce((sum, i) => sum + (i.medianMinutes ?? 0), 0));
}

function Assignments({ battery, patients }: { battery: Battery; patients: Patient[] }) {
  const { ut } = useLang();
  const [query, setQuery] = useState("");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const run = useAction();

  const res = useResource(() => api.batteryAssignments(battery.id), [battery.id]);
  const rows = res.data;
  const reload = res.reload;

  const assigned = new Set(
    rows?.filter((r) => !r.cancelledAt && !r.completedAt).map((r) => r.userId) ?? [],
  );
  const candidates = useMemo(
    () =>
      patients
        .filter((p) => !assigned.has(p.id))
        .filter((p) => `${p.fullName} ${p.email}`.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8),
    [patients, query, rows],
  );

  return (
    <div className="nested">
      <h3>{ut("f.assignments")}</h3>
      {!rows ? <Loading /> : null}

      {rows?.length ? (
        <table>
          <thead>
            <tr>
              <th>{ut("f.subject")}</th>
              <th>{ut("f.assigned")}</th>
              <th>{ut("bt.deadline")}</th>
              <th>{ut("bat.progress")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className={a.overdue ? "alarm-row" : undefined}>
                <td>{a.userName}</td>
                <td className="muted">{day(a.assignedAt)}</td>
                <td className={a.overdue ? "bad" : "muted"}>
                  {a.dueAt ? day(a.dueAt) : "без срока"}
                  {a.overdue ? " · просрочено" : ""}
                </td>
                <td>
                  <StepTrack steps={a.steps} />
                  <span className="hint">
                    {a.doneRequired} из {a.totalRequired} обязательных
                  </span>
                </td>
                <td>
                  {a.cancelledAt ? (
                    <span className="muted">снято {day(a.cancelledAt)}</span>
                  ) : a.doneRequired === a.totalRequired ? (
                    <span className="good">пройдена</span>
                  ) : (
                    <button
                      onClick={() =>
                        run(async () => {
                          await api.cancelAssignment(a.id);
                          await reload();
                        }, ut("bt.assignmentRemoved"))
                      }
                    >
                      Снять
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : rows ? (
        <p className="hint">{ut("bat.notAssigned")}</p>
      ) : null}

      <div className="assign-row">
        <Search value={query} onChange={setQuery} placeholder={ut("ui.findRespondent")} />
        <label className="field">
          <span>{ut("bt.deadline")}</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <label className="field grow">
          <span>{ut("f.note")}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="необязательно" />
        </label>
      </div>
      {query ? (
        <div className="row tight" style={{ marginTop: 8 }}>
          {candidates.length ? (
            candidates.map((p) => (
              <button
                key={p.id}
                onClick={() =>
                  run(async () => {
                    await api.assignBattery(battery.id, p.id, due || null, note || null);
                    setQuery("");
                    setNote("");
                    await reload();
                  }, `Батарея назначена: ${p.fullName}`)
                }
              >
                + {p.fullName}
              </button>
            ))
          ) : (
            <span className="hint">{ut("bat.nobodyLeft")}</span>
          )}
        </div>
      ) : null}
      <p className="hint" style={{ marginTop: 8 }}>
        Назначение открывает доступ ко всем методикам набора. Срок назначения становится сроком
        доступа: после него методики снова скрыты.
      </p>
    </div>
  );
}

/** Полоска шагов: пройдено / текущий / заблокировано */
function StepTrack({ steps }: { steps: BatteryStep[] }) {
  return (
    <span className="step-track" role="img" aria-label={`${steps.filter((s) => s.state === "done").length} из ${steps.length} пройдено`}>
      {steps.map((s) => (
        <i key={s.surveyId} className={`step ${s.state}`} title={`${s.title} — ${STATE_LABEL[s.state]}`} />
      ))}
    </span>
  );
}

const STATE_LABEL: Record<BatteryStep["state"], string> = {
  done: "пройдена",
  current: "следующая",
  available: "доступна",
  locked: "откроется позже",
};

function BatteryEditor({
  battery,
  surveys,
  groups,
  onClose,
  onSaved,
}: {
  battery: Battery | null;
  surveys: SurveyListItem[];
  groups: SurveyGroupWithCounts[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { ut } = useLang();
  const [title, setTitle] = useState(battery?.title ?? "");
  const [description, setDescription] = useState(battery?.description ?? "");
  const [groupId, setGroupId] = useState(battery?.groupId ?? "");
  const [strictOrder, setStrictOrder] = useState(battery?.strictOrder ?? true);
  const [archived, setArchived] = useState(battery?.archived ?? false);
  const [items, setItems] = useState<{ surveyId: string; required: boolean }[]>(
    battery?.items.map((i) => ({ surveyId: i.surveyId, required: i.required })) ?? [],
  );
  const run = useAction();

  const titleOf = (id: string) => surveys.find((s) => s.id === id)?.title ?? id;
  const move = (index: number, delta: number) => {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setItems(next);
  };

  const save = () =>
    run(async () => {
      const payload = {
        title,
        description: description || null,
        groupId: groupId || null,
        strictOrder,
        archived,
        items,
      };
      if (battery) await api.updateBattery(battery.id, payload);
      else await api.createBattery(payload);
      onSaved();
    }, battery ? ut("bt.updated") : ut("bt.assembled"));

  return (
    <div className="card">
      <div className="card-head">
        <h2>{battery ? ut("bt.editTitle") : ut("bt.newTitle")}</h2>
        <button onClick={onClose}>{ut("ui.close")}</button>
      </div>

      <div className="form-grid">
        <label className="field grow">
          <span>{ut("f.name")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ut("bt.namePlaceholder")} />
        </label>
        <label className="field">
          <span>{ut("f.group")}</span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">вне групп</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.title}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>{ut("f.description")}</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="необязательно" />
        </label>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <label className="check">
          <input type="checkbox" checked={strictOrder} onChange={(e) => setStrictOrder(e.target.checked)} />
          Строгий порядок
        </label>
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          В архиве
        </label>
      </div>
      <p className="hint">
        При строгом порядке следующая методика открывается только после предыдущей. Это важно там,
        где утомление от длинного опросника искажает результат короткого.
      </p>

      <h3 style={{ marginTop: 18 }}>{ut("bt.composition")}</h3>
      {items.length ? (
        <ol className="battery-steps editable">
          {items.map((item, i) => (
            <li key={item.surveyId}>
              <span>{titleOf(item.surveyId)}</span>
              <div className="row tight">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={item.required}
                    onChange={(e) =>
                      setItems(items.map((x, j) => (i === j ? { ...x, required: e.target.checked } : x)))
                    }
                  />
                  обязательная
                </label>
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Выше">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Ниже">↓</button>
                <button className="danger" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  Убрать
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="hint">{ut("bat.emptyAddBelow")}</p>
      )}

      <div className="row tight" style={{ marginTop: 12 }}>
        {surveys
          .filter((s) => !items.some((i) => i.surveyId === s.id))
          .map((s) => (
            <button key={s.id} onClick={() => setItems([...items, { surveyId: s.id, required: true }])}>
              + {s.title}
            </button>
          ))}
      </div>

      <div className="row" style={{ marginTop: 18 }}>
        <button className="primary" onClick={save} disabled={!title.trim() || !items.length}>
          Сохранить
        </button>
        <button onClick={onClose}>{ut("ui.cancel")}</button>
      </div>
    </div>
  );
}
