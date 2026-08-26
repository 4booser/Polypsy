import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  Battery,
  BatteryAssignment,
  BatteryStep,
  SurveyGroupWithCounts,
  SurveyListItem,
} from "@quizzy/shared";
import { api, type Patient } from "../api";
import { day } from "../format";
import { Empty, IconBattery, Loading, PageHead, Search, useAction } from "../ui";

/**
 * Батареи: набор методик, назначаемый целиком.
 *
 * Обследование редко состоит из одной методики — обычно это скрининг, основной
 * опросник и уточняющий. Назначение по одной держится на том, что психолог
 * ничего не забудет и выдаст в нужном порядке; батарея снимает оба допущения.
 */
export default function Batteries() {
  const [rows, setRows] = useState<Battery[] | null>(null);
  const [surveys, setSurveys] = useState<SurveyListItem[]>([]);
  const [groups, setGroups] = useState<SurveyGroupWithCounts[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [editing, setEditing] = useState<Battery | "new" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const run = useAction();

  const reload = () => api.batteries().then(setRows).catch(() => setRows([]));

  useEffect(() => {
    reload();
    api.surveys().then(setSurveys).catch(() => {});
    api.groups().then(setGroups).catch(() => {});
    api.patients().then(setPatients).catch(() => {});
  }, []);

  return (
    <>
      <PageHead
        title="Батареи методик"
        sub="Набор методик, который назначается и проходится целиком"
        actions={<button className="primary" onClick={() => setEditing("new")}>Собрать батарею</button>}
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

      {!rows ? <Loading /> : null}
      {rows && !rows.length && !editing ? (
        <Empty
          title="Батарей пока нет"
          hint="Соберите набор из методик, которые всегда идут вместе, — назначать его придётся один раз, а не по одной методике"
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
                {openId === b.id ? "Свернуть назначения" : `Назначения · ${b.activeAssignments}`}
              </button>
              <button onClick={() => setEditing(b)}>Править</button>
              <button
                className="danger"
                onClick={() =>
                  run(async () => {
                    await api.deleteBattery(b.id);
                    await reload();
                  }, "Батарея удалена")
                }
              >
                Удалить
              </button>
            </div>
          </div>

          {b.description ? <p className="hint">{b.description}</p> : null}
          <p className="hint">
            {b.groupTitle ? `Группа: ${b.groupTitle}` : "Вне групп"} ·{" "}
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
  );
}

/** Суммарный ориентир по батарее: считаем только там, где известны все методики */
function totalMinutes(b: Battery): number | null {
  if (!b.items.length || b.items.some((i) => i.medianMinutes === null)) return null;
  return Math.round(b.items.reduce((sum, i) => sum + (i.medianMinutes ?? 0), 0));
}

function Assignments({ battery, patients }: { battery: Battery; patients: Patient[] }) {
  const [rows, setRows] = useState<BatteryAssignment[] | null>(null);
  const [query, setQuery] = useState("");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const run = useAction();

  const reload = () => api.batteryAssignments(battery.id).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    reload();
  }, [battery.id]);

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
      <h3>Назначения</h3>
      {!rows ? <Loading /> : null}

      {rows?.length ? (
        <table>
          <thead>
            <tr>
              <th>Обследуемый</th>
              <th>Назначено</th>
              <th>Срок</th>
              <th>Прогресс</th>
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
                        }, "Назначение снято")
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
        <p className="hint">Батарея пока никому не назначена</p>
      ) : null}

      <div className="assign-row">
        <Search value={query} onChange={setQuery} placeholder="Найти обследуемого" />
        <label className="field">
          <span>Срок</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <label className="field grow">
          <span>Примечание</span>
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
            <span className="hint">Никого не найдено — либо батарея уже назначена</span>
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
    }, battery ? "Батарея обновлена" : "Батарея собрана");

  return (
    <div className="card">
      <div className="card-head">
        <h2>{battery ? "Правка батареи" : "Новая батарея"}</h2>
        <button onClick={onClose}>Закрыть</button>
      </div>

      <div className="form-grid">
        <label className="field grow">
          <span>Название</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, входное обследование" />
        </label>
        <label className="field">
          <span>Группа</span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">вне групп</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.title}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Описание</span>
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

      <h3 style={{ marginTop: 18 }}>Состав</h3>
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
        <p className="hint">Пока пусто — добавьте методики ниже</p>
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
        <button onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}
