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
import { Empty, IconBattery, Loading, Screen, Search, useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button } from "../ui/primitives";
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
  const { run } = useAction();

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
    <Page
      title={ut("bt.title")}
      sub={ut("bt.sub")}
      count={rows.length}
      actions={<Button variant="primary" onClick={() => setEditing("new")}>{ut("bt.assemble")}</Button>}
    >
      <Stack>
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
          <Panel
            key={b.id}
            className={b.archived ? "opacity-[0.62]" : undefined}
            title={
              <span className="flex items-center gap-2">
                <IconBattery />
                {b.title}
                {b.archived ? <span className="chip static">{ut("bt.archived")}</span> : null}
              </span>
            }
            actions={
              <div className="row tight">
                <button onClick={() => setOpenId(openId === b.id ? null : b.id)}>
                  {openId === b.id ? ut("bt.collapseAssignments") : `${ut("bt.assignments")} · ${b.activeAssignments}`}
                </button>
                <button onClick={() => setEditing(b)}>{ut("f.edit")}</button>
                <Button
                  variant="danger"
                  onClick={() =>
                    run(async () => {
                      await api.deleteBattery(b.id);
                      await reload();
                    }, ut("bt.deleted"))
                  }
                >
                  {ut("ui.delete")}
                </Button>
              </div>
            }
          >
            {b.description ? <p className="text-caption text-muted">{b.description}</p> : null}
            <p className="mt-1 text-caption text-muted">
              {b.groupTitle ? `${ut("bt.group")}: ${b.groupTitle}` : ut("bt.noGroup")} ·{" "}
              {b.strictOrder ? ut("bt.strictOrder") : ut("bt.freeOrder")} · {ut("bt.totalItems")}{" "}
              {b.items.reduce((sum, i) => sum + i.questionCount, 0)}
              {totalMinutes(b) !== null ? ` · ${ut("bt.approx")} ${totalMinutes(b)} ${ut("ui.min")}` : null}
            </p>

            {b.items.some((i) => i.administration === "clinician") &&
            b.items.some((i) => i.administration === "self") ? (
              <p className="mt-1 text-caption text-[var(--sev-mild-text)]">
                {ut("bt.mixedModes")}
              </p>
            ) : null}

            <ol className="battery-steps">
              {b.items.map((item) => (
                <li key={item.surveyId}>
                  <Link to={`/surveys/${item.surveyId}`}>{item.title}</Link>
                  <span className="text-caption text-muted">
                    {item.questionCount} {ut("bt.items")}
                    {item.medianMinutes !== null
                      ? ` · ${ut("bt.median")} ${item.medianMinutes} ${ut("ui.min")}`
                      : ` · ${ut("bt.durationUnknown")}`}
                    {item.required ? "" : ` · ${ut("bt.optional")}`}
                    {item.administration === "clinician" ? ` · ${ut("bt.byClinician")}` : ""}
                  </span>
                </li>
              ))}
            </ol>

            {openId === b.id ? <Assignments battery={b} patients={patients} /> : null}
          </Panel>
        ))}
      </Stack>
    </Page>
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
  const { run } = useAction();

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
                <td className="text-muted">{day(a.assignedAt)}</td>
                <td className={a.overdue ? "bad" : "text-muted"}>
                  {a.dueAt ? day(a.dueAt) : ut("bt.noDeadline")}
                  {a.overdue ? ` · ${ut("bt.overdueNote")}` : ""}
                </td>
                <td>
                  <StepTrack steps={a.steps} />
                  <span className="text-caption text-muted">
                    {a.doneRequired} {ut("common.of")} {a.totalRequired} {ut("bt.requiredGen")}
                  </span>
                </td>
                <td>
                  {a.cancelledAt ? (
                    <span className="text-muted">{ut("bt.cancelledOn")} {day(a.cancelledAt)}</span>
                  ) : a.doneRequired === a.totalRequired ? (
                    <span className="good">{ut("mark.passed")}</span>
                  ) : (
                    <button
                      onClick={() =>
                        run(async () => {
                          await api.cancelAssignment(a.id);
                          await reload();
                        }, ut("bt.assignmentRemoved"))
                      }
                    >
                      {ut("acc.revoke")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : rows ? (
        <p className="text-caption text-muted">{ut("bat.notAssigned")}</p>
      ) : null}

      <div className="assign-row">
        <Search value={query} onChange={setQuery} placeholder={ut("ui.findRespondent")} />
        <label className="field">
          <span>{ut("bt.deadline")}</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <label className="field grow">
          <span>{ut("f.note")}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={ut("mark.optional")} />
        </label>
      </div>
      {query ? (
        <div className="row tight mt-2">
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
                  }, `${ut("bt.assignedToast")} ${p.fullName}`)
                }
              >
                + {p.fullName}
              </button>
            ))
          ) : (
            <span className="text-caption text-muted">{ut("bat.nobodyLeft")}</span>
          )}
        </div>
      ) : null}
      <p className="mt-2 text-caption text-muted">
        {ut("bt.assignHint")}
      </p>
    </div>
  );
}

/** Полоска шагов: пройдено / текущий / заблокировано */
function StepTrack({ steps }: { steps: BatteryStep[] }) {
  const { ut } = useLang();
  const stateLabel: Record<BatteryStep["state"], string> = {
    done: ut("bt.stepDone"),
    current: ut("bt.stepCurrent"),
    available: ut("bt.stepAvailable"),
    locked: ut("bt.stepLocked"),
  };
  return (
    <span
      className="step-track"
      role="img"
      aria-label={`${steps.filter((s) => s.state === "done").length} ${ut("common.of")} ${steps.length} ${ut("bt.stepsDoneWord")}`}
    >
      {steps.map((s) => (
        <i key={s.surveyId} className={`step ${s.state}`} title={`${s.title} — ${stateLabel[s.state]}`} />
      ))}
    </span>
  );
}

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
  const { run } = useAction();

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
    <Panel
      title={battery ? ut("bt.editTitle") : ut("bt.newTitle")}
      actions={<button onClick={onClose}>{ut("ui.close")}</button>}
    >
      <div className="form-grid">
        <label className="field grow">
          <span>{ut("f.name")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ut("bt.namePlaceholder")} />
        </label>
        <label className="field">
          <span>{ut("f.group")}</span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">{ut("mark.outsideGroups")}</option>
            {/*
              Снятые группы не предлагаются, но выбранная остаётся: <select>
              без совпадающего значения показывает первый вариант, и правка
              названия батареи молча переносила бы её в чужую группу.
            */}
            {groups
              .filter((g) => !g.archivedAt || g.id === groupId)
              .map((g) => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
          </select>
        </label>
        <label className="field grow">
          <span>{ut("f.description")}</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={ut("mark.optional")} />
        </label>
      </div>

      <div className="row mt-2.5">
        <label className="check">
          <input type="checkbox" checked={strictOrder} onChange={(e) => setStrictOrder(e.target.checked)} />
          {ut("bat.strictOrder")}
        </label>
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          {ut("bat.archived")}
        </label>
      </div>
      <p className="mt-1 text-caption text-muted">
        {ut("bt.strictOrderHint")}
      </p>

      <h3 className="mt-[18px]">{ut("bt.composition")}</h3>
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
                  {ut("bt.required")}
                </label>
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={ut("mark.above")}>↑</button>
                <button onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={ut("mark.below")}>↓</button>
                <Button variant="danger" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  {ut("ui.remove")}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-caption text-muted">{ut("bat.emptyAddBelow")}</p>
      )}

      <div className="row tight mt-3">
        {surveys
          .filter((s) => !items.some((i) => i.surveyId === s.id))
          .map((s) => (
            <button key={s.id} onClick={() => setItems([...items, { surveyId: s.id, required: true }])}>
              + {s.title}
            </button>
          ))}
      </div>

      <div className="row mt-[18px]">
        <Button variant="primary" onClick={save} disabled={!title.trim() || !items.length}>
          {ut("ui.save")}
        </Button>
        <button onClick={onClose}>{ut("ui.cancel")}</button>
      </div>
    </Panel>
  );
}
