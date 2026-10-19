import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Battery, BatteryAssignment, BatteryStep, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../api";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Avatar, Modal, Screen, useAction } from "../ui";
import { choiceLabel, keepChosen } from "../ui/choices";
import { cx } from "../ui/cx";
import { DataTable, type Column } from "../ui/DataTable";
import { Drawer, DrawerSection } from "../ui/Drawer";
import { ViewPills } from "../ui/filters";
import { Ic } from "../ui/icons";
import { useHotkeys } from "../ui/keys";
import { Page, Panel } from "../ui/layout";
import { ActionMenu, type MenuEntry } from "../ui/menu";
import { Tooltip } from "../ui/Popover";
import { ListGroup, ListTile, PersonCell } from "../ui/records";
import { Button, ButtonLink, CheckLabel, Checkbox, Field, Input, Select, Tag } from "../ui/primitives";
import { Callout, Empty } from "../ui/states";
import { useUrlState } from "../ui/urlState";
import { useResource } from "../useResource";
import { busyAssignees } from "./batteries/model";
import { AssignDrawer, type ExistingAssignment } from "./methods/AssignDrawer";
import { Mi } from "./methods/icons";
import { ListAndRecord, ListColumn, ListEmpty } from "./methods/ListColumn";
import { Fact } from "./methods/MethodPage";
import { dayDiff, shortDate, splitCode } from "./methods/model";
import { num, useCount } from "./methods/useCount";

/*
 * Набори методик — UI 3, «Виразна» (methods-batteries), список і запис.
 *
 * Обследование редко состоит из одной методики — обычно это скрининг,
 * основной опросник и уточняющий. Набор назначается целиком и снимает два
 * допущения: что психолог ничего не забудет и выдаст в нужном порядке.
 *
 * Слева — наборы по группам методик: сколько активных назначений, коды
 * шагов, что требует внимания (просрочено, шаг снят с использования),
 * порядок и длительность. Справа — выбранный набор: состав с режимами
 * заполнения, предупреждения и назначения с прогрессом каждого человека по
 * шагам. «Правити» и «Зібрати набір» — в ящике, «Призначити» — в ящике
 * назначения, «Відкликати» — окном.
 *
 * Выбранный набор — в адресе (?id=): ссылку на набор пересылают.
 */

type View = "all" | "late" | "strict";

/** Минуты набора — только если известна длительность каждого шага */
function totalMinutes(b: Battery): number | null {
  if (!b.items.length || b.items.some((i) => i.medianMinutes === null)) return null;
  return Math.round(b.items.reduce((sum, i) => sum + (i.medianMinutes ?? 0), 0));
}

const shortOf = (title: string) => splitCode(title).code ?? splitCode(title).name;

export default function Batteries() {
  /*
   * Наборы — содержание экрана, остальные списки нужны составу и редактору:
   * их отказ ограничит выбор, но не оставит человека перед пустым экраном.
   */
  const res = useResource(async () => {
    const [rows, surveys, groups] = await Promise.all([
      api.batteries(),
      /* со снятыми: шаг может держать снятую методику, и экран обязан её назвать */
      api.surveys(true).catch(() => [] as SurveyListItem[]),
      api.groups().catch(() => [] as SurveyGroupWithCounts[]),
    ]);
    return { rows, surveys, groups };
  }, []);

  return (
    <Screen res={res}>
      {({ rows, surveys, groups }) => <BatteriesScreen rows={rows} surveys={surveys} groups={groups} reload={res.reload} />}
    </Screen>
  );
}

function BatteriesScreen({
  rows,
  surveys,
  groups,
  reload,
}: {
  rows: Battery[];
  surveys: SurveyListItem[];
  groups: SurveyGroupWithCounts[];
  reload: () => void;
}) {
  const { ut } = useLang();
  const count = useCount();
  const navigate = useNavigate();
  const [selected, setSelected] = useUrlState("id");
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("all");
  const [collapsed, setCollapsed] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [editing, setEditing] = useState<Battery | "new" | null>(null);

  const retiredIds = useMemo(() => new Set(surveys.filter((s) => s.archivedAt).map((s) => s.id)), [surveys]);
  const live = rows.filter((b) => !b.archived);
  const archived = rows.filter((b) => b.archived);
  const lateCount = live.filter((b) => (b.overdueAssignments ?? 0) > 0).length;
  const strictCount = live.filter((b) => b.strictOrder).length;

  const matches = (b: Battery) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return `${b.title} ${b.items.map((i) => i.title).join(" ")}`.toLowerCase().includes(needle);
  };
  const shown = live
    .filter(matches)
    .filter((b) => (view === "late" ? (b.overdueAssignments ?? 0) > 0 : view === "strict" ? b.strictOrder : true));
  const shownArchived = archived.filter(matches);

  /* группы методик по имени, «поза групами» — последней; внутри — по активным назначениям */
  const grouped = useMemo(() => {
    const by = new Map<string, Battery[]>();
    for (const b of shown) {
      const key = b.groupTitle ?? "";
      by.set(key, [...(by.get(key) ?? []), b]);
    }
    return [...by.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map(([title, list]) => [title, [...list].sort((x, y) => y.activeAssignments - x.activeAssignments)] as const);
  }, [shown]);
  const order = [...grouped.flatMap(([, list]) => list), ...(archiveOpen ? shownArchived : [])];
  const current = rows.find((b) => b.id === selected) ?? order[0] ?? null;

  const step = (dir: 1 | -1) => {
    if (!order.length) return;
    const at = current ? order.findIndex((b) => b.id === current.id) : -1;
    const next = order[Math.min(order.length - 1, Math.max(0, at + dir))];
    if (next) setSelected(next.id);
  };

  const tile = (b: Battery) => {
    const codes = b.items.map((i) => shortOf(i.title));
    const retiredStep = b.items.find((i) => retiredIds.has(i.surveyId));
    const late = b.overdueAssignments ?? 0;
    const minutes = totalMinutes(b);
    /* с пилюлей справа места на три кода нет — два и «+N» */
    const room = retiredStep || late ? 2 : 3;
    return (
      <ListTile
        key={b.id}
        to={`/batteries?id=${b.id}`}
        selected={current?.id === b.id}
        title={b.title}
        meta={
          <>
            <b className="font-extrabold text-text">{num(b.activeAssignments)}</b> {ut("mc.btActive")}
          </>
        }
        reason={
          <span className="flex min-w-0 items-center gap-[3px] overflow-hidden">
            {codes.slice(0, room).map((c, i) => (
              <span
                key={`${c}-${i}`}
                className={cx(
                  "inline-grid h-5 shrink-0 place-items-center rounded-[6px] px-1.5 text-[11px] font-extrabold leading-none text-text",
                  current?.id === b.id ? "bg-panel" : "bg-sunk",
                )}
              >
                {c.length > 10 ? `${c.slice(0, 9)}…` : c}
              </span>
            ))}
            {codes.length > room ? <span className="text-[11.5px] font-bold text-muted">{`+${codes.length - room}`}</span> : null}
          </span>
        }
        aside={
          retiredStep ? (
            <Tag tone="attention" icon={<Ic.alert />}>
              {ut("mc.btStepRetired").replace("{code}", shortOf(retiredStep.title))}
            </Tag>
          ) : late ? (
            <Tag tone="attention" icon={<ShellIcon name="hourglass" size={12} />}>
              {ut("mc.btLateN").replace("{n}", String(late))}
            </Tag>
          ) : undefined
        }
        next={b.strictOrder ? ut("bt.strictOrder") : ut("mc.btAnyOrder")}
        nextIcon={b.strictOrder ? <Mi.listOrdered /> : <Mi.shuffle />}
        when={minutes !== null ? ut("mc.btSize").replace("{items}", String(b.items.reduce((s, i) => s + i.questionCount, 0))).replace("{min}", String(minutes)) : count(b.items.reduce((s, i) => s + i.questionCount, 0), "items")}
      />
    );
  };

  const list = (
    <ListColumn
      title={ut("nav.batteries")}
      count={live.length}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      onStep={step}
      search={{ value: q, onChange: setQ, placeholder: ut("mc.btSearch") }}
      views={{
        value: view,
        onChange: (k) => setView(k as View),
        items: [
          { key: "all", label: ut("grp.filterAll"), count: live.length },
          { key: "late", label: ut("mc.btWithLate"), count: lateCount },
          { key: "strict", label: ut("bat.strictOrder"), count: strictCount },
        ],
      }}
      sortNote={ut("mc.btSortNote")}
      footCount={ut("kit.ofTotal").replace("{n}", String(shown.length)).replace("{total}", String(live.length))}
      actions={
        <Tooltip label={ut("bt.assemble")} side="bottom">
          <Button size="icon-sm" variant="quiet" aria-label={ut("bt.assemble")} onClick={() => setEditing("new")}>
            <Ic.plus />
          </Button>
        </Tooltip>
      }
    >
      {grouped.length ? (
        grouped.map(([title, list]) => (
          <div key={title || "none"}>
            <ListGroup label={title || ut("bt.noGroup")} count={list.length} mark={title ? "violet" : "neutral"} />
            {list.map(tile)}
          </div>
        ))
      ) : (
        <ListEmpty>{live.length ? ut("cat.emptySearch") : ut("bt.noneHint")}</ListEmpty>
      )}
      {archived.length ? (
        <>
          <button
            type="button"
            aria-expanded={archiveOpen}
            onClick={() => setArchiveOpen((v) => !v)}
            className="mt-1.5 flex h-9 w-full min-h-0 cursor-pointer items-center gap-2 border-0 bg-transparent pl-5 pr-4 text-small font-extrabold text-text hover:bg-sunk"
          >
            <Ic.chevronRight size={14} className={cx("text-muted transition-transform", archiveOpen && "rotate-90")} />
            {ut("sn.archive")}
            <span className="inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-sunk px-1.5 text-[11.5px] font-bold text-text-2">
              {archived.length}
            </span>
          </button>
          {archiveOpen ? shownArchived.map(tile) : null}
        </>
      ) : null}
    </ListColumn>
  );

  return (
    <ListAndRecord list={list}>
      {current ? (
        <BatteryRecord
          key={current.id}
          battery={current}
          retiredIds={retiredIds}
          onEdit={() => setEditing(current)}
          onChanged={reload}
          onDeleted={() => {
            setSelected("");
            reload();
          }}
        />
      ) : (
        <Page title={ut("bt.title")} actions={<Button variant="primary" icon={<Ic.plus />} onClick={() => setEditing("new")}>{ut("bt.assemble")}</Button>}>
          <Panel>
            <Empty title={ut("bt.none")} hint={ut("bt.noneHint")} icon={<Ic.layers />} />
          </Panel>
        </Page>
      )}
      <BatteryEditor
        key={editing === "new" ? "editor-new" : `editor-${editing?.id ?? "closed"}`}
        battery={editing}
        surveys={surveys}
        groups={groups}
        onClose={() => setEditing(null)}
        onSaved={(id) => {
          setEditing(null);
          if (id) navigate(`/batteries?id=${id}`, { replace: true });
          reload();
        }}
      />
    </ListAndRecord>
  );
}

/* ─────────── запись ─────────── */

const STEP_TONE: Record<string, string> = {
  done: "bg-violet text-onfill",
  current: "bg-panel shadow-[inset_0_0_0_2px_var(--v)]",
  available: "bg-sunk text-muted",
  locked: "bg-sunk text-muted",
  retired: "bg-sunk text-muted line-through",
  clinician: "bg-warn-tint text-warn shadow-[inset_0_0_0_1px_var(--warnline)]",
};

/** Шаги одного назначения квадратиками: пройден, следующий, ждёт специалиста, откроется позже, снят */
function StepDots({ steps }: { steps: BatteryStep[] }) {
  const { ut } = useLang();
  const word: Record<string, string> = {
    done: ut("bt.stepDone"),
    current: ut("bt.stepCurrent"),
    available: ut("bt.stepAvailable"),
    locked: ut("bt.stepLocked"),
    retired: ut("mark.retired"),
    clinician: ut("mc.btWaitsClinician"),
  };
  return (
    <span className="flex gap-1" role="img" aria-label={ut("mc.btStepsAria").replace("{done}", String(steps.filter((s) => s.state === "done").length)).replace("{all}", String(steps.length))}>
      {steps.map((s) => {
        const kind = s.state !== "done" && s.state !== "retired" && s.administration === "clinician" ? "clinician" : s.state;
        return (
          <Tooltip key={s.surveyId} label={`${shortOf(s.title)}: ${word[kind]}`}>
            <span tabIndex={0} className={cx("grid size-[22px] place-items-center rounded-[7px] outline-offset-1", STEP_TONE[kind])}>
              {kind === "done" ? (
                <Ic.check size={12} />
              ) : kind === "locked" ? (
                <Ic.lock size={11} />
              ) : kind === "clinician" ? (
                <ShellIcon name="stethoscope" size={12} />
              ) : kind === "retired" ? (
                <Ic.archive size={11} />
              ) : null}
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}

type AsgView = "all" | "active" | "late" | "done";

function BatteryRecord({
  battery: b,
  retiredIds,
  onEdit,
  onChanged,
  onDeleted,
}: {
  battery: Battery;
  retiredIds: Set<string>;
  onEdit: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { ut } = useLang();
  const count = useCount();
  const { run, busy } = useAction();
  const [assigning, setAssigning] = useState(false);
  const [view, setView] = useState<AsgView>("all");
  const [cancelling, setCancelling] = useState<BatteryAssignment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const asg = useResource(() => api.batteryAssignments(b.id), [b.id]);
  const rows = asg.data ?? [];
  const now = new Date();

  useHotkeys({
    e: onEdit,
    a: () => {
      if (!b.archived) setAssigning(true);
    },
  });

  const minutes = totalMinutes(b);
  const items = b.items.reduce((s, i) => s + i.questionCount, 0);
  const mixed = b.items.some((i) => i.administration === "clinician") && b.items.some((i) => i.administration === "self");
  const retiredSteps = b.items.filter((i) => retiredIds.has(i.surveyId));

  const state = (a: BatteryAssignment): AsgView => (a.cancelledAt || a.completedAt ? "done" : a.overdue ? "late" : "active");
  const counts = {
    all: rows.length,
    active: rows.filter((a) => state(a) !== "done").length,
    late: rows.filter((a) => state(a) === "late").length,
    done: rows.filter((a) => state(a) === "done").length,
  };
  const shownRows = rows.filter((a) => view === "all" || (view === "active" ? state(a) !== "done" : state(a) === view));
  const existing = useMemo(() => {
    const busyIds = busyAssignees(rows);
    return new Map<string, ExistingAssignment>(rows.filter((a) => busyIds.has(a.userId)).map((a) => [a.userId, { until: a.dueAt }] as const));
  }, [rows]);

  const noteOf = (a: BatteryAssignment): { text: string; tone: string } => {
    if (a.cancelledAt) return { text: ut("mc.btCancelledOn").replace("{date}", shortDate(a.cancelledAt)), tone: "text-muted" };
    if (a.completedAt) return { text: ut("mc.btDoneOn").replace("{date}", shortDate(a.completedAt)), tone: "font-bold text-good" };
    const waiting = a.steps.find((s) => (s.state === "current" || s.state === "available") && s.administration === "clinician");
    if (waiting) return { text: ut("mc.btWaits").replace("{code}", shortOf(waiting.title)), tone: "font-bold text-warn" };
    const text = ut("mc.btRequired").replace("{done}", String(a.doneRequired)).replace("{all}", String(a.totalRequired));
    return { text, tone: a.overdue ? "font-bold text-warn" : "text-text-2" };
  };

  const columns: Column<BatteryAssignment>[] = [
    {
      key: "who",
      header: ut("f.subject"),
      required: true,
      width: 240,
      sort: (a) => a.userName,
      render: (a) => (
        <PersonCell
          name={a.userName}
          sub={ut("mc.btAssignedOn").replace("{date}", shortDate(a.assignedAt))}
          avatar={<Avatar name={a.userName} size={28} />}
          to={`/patients/${a.userId}`}
        />
      ),
    },
    {
      key: "due",
      header: ut("bt.deadline"),
      required: true,
      width: 110,
      sort: (a) => a.dueAt ?? "9999",
      render: (a) =>
        a.dueAt ? (
          <span className="flex flex-col">
            <span className={cx("tabular-nums", a.overdue ? "font-bold text-warn" : "text-text-2")}>{shortDate(a.dueAt)}</span>
            {a.overdue ? (
              <small className="text-caption text-muted">{ut("mc.btDaysLate").replace("{n}", String(Math.max(1, -dayDiff(now, new Date(a.dueAt)))))}</small>
            ) : null}
          </span>
        ) : (
          <span className="text-text-2">{ut("bt.noDeadline")}</span>
        ),
    },
    {
      key: "progress",
      header: ut("mc.btProgress"),
      required: true,
      render: (a) => {
        const n = noteOf(a);
        return (
          <span className="flex flex-col gap-1">
            <StepDots steps={a.steps} />
            <small className={cx("text-caption", n.tone)}>{n.text}</small>
          </span>
        );
      },
    },
  ];

  const clinicianStep = (a: BatteryAssignment) =>
    a.steps.find((s) => (s.state === "current" || s.state === "available") && s.administration === "clinician");

  const menu: MenuEntry[] = [
    {
      label: b.archived ? ut("mc.btUnarchive") : ut("mc.btArchive"),
      icon: b.archived ? <Mi.archiveRestore size={16} /> : <Ic.archive size={16} />,
      onSelect: () =>
        void run(async () => {
          await api.updateBattery(b.id, {
            title: b.title,
            description: b.description,
            groupId: b.groupId,
            strictOrder: b.strictOrder,
            archived: !b.archived,
            items: b.items.map((i) => ({ surveyId: i.surveyId, required: i.required })),
          });
          onChanged();
        }, b.archived ? ut("mc.btUnarchived") : ut("mc.btArchived")),
    },
    { label: ut("mc.btDelete"), icon: <Mi.trash size={16} />, ruled: true, onSelect: () => setDeleting(true) },
  ];

  return (
    <Page
      title={b.title}
      actions={
        <>
          <Button variant="secondary" icon={<ShellIcon name="pencil" size={15} />} onClick={onEdit} title={ut("mc.btEditHint")}>
            {ut("cl.editAction")}
          </Button>
          {b.archived ? null : (
            <Button variant="primary" icon={<Mi.clipboardPlus />} aria-expanded={assigning} onClick={() => setAssigning(true)}>
              {ut("acc.grant")}
            </Button>
          )}
          <ActionMenu label={ut("mc.btMenu")} entries={menu} triggerSize="icon" triggerClassName="bg-violet-tint hover:bg-violet-tint-2" />
        </>
      }
      below={
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-small text-text-2">
            {b.archived ? (
              <Tag tone="done" icon={<Ic.archive />}>
                {ut("bat.archived")}
              </Tag>
            ) : null}
            <Fact icon={<ShellIcon name="folder-tree" size={15} />}>{b.groupTitle ?? ut("bt.noGroup")}</Fact>
            <Fact icon={b.strictOrder ? <Mi.listOrdered size={15} /> : <Mi.shuffle size={15} />}>
              {b.strictOrder ? ut("bt.strictOrder") : ut("mc.btAnyOrder")}
            </Fact>
            <Fact icon={<Ic.list size={15} />}>{count(items, "items")}</Fact>
            {minutes !== null ? <Fact icon={<Ic.timer size={15} />}>{ut("mc.btMedian").replace("{n}", String(minutes))}</Fact> : null}
            <Fact icon={<Mi.calendar size={15} />}>{ut("mc.btCreated").replace("{date}", shortDate(b.createdAt))}</Fact>
          </div>
          {b.description ? <p className="m-0 mt-3 max-w-[72ch] text-body text-text-2">{b.description}</p> : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Panel
          title={ut("bt.composition")}
          icon={<Ic.layers />}
          count={b.items.length}
          actions={<span className="text-small text-muted">{b.strictOrder ? ut("mc.btStrictNote") : ut("mc.btFreeNote")}</span>}
        >
          <ol className="m-0 list-none p-0">
            {b.items.map((i, k) => {
              const { code, name } = splitCode(i.title);
              const retired = retiredIds.has(i.surveyId);
              return (
                <li
                  key={i.surveyId}
                  className="grid grid-cols-[28px_auto_minmax(0,1fr)_auto_96px] items-center gap-2.5 border-t border-divider py-2 first:border-t-0 first:pt-0.5 max-[1180px]:grid-cols-[28px_auto_minmax(0,1fr)_auto]"
                >
                  <span className="grid size-6 place-items-center rounded-full bg-sunk text-[11.5px] font-extrabold text-text-2">{k + 1}</span>
                  {code ? (
                    <span className="inline-grid h-6 place-items-center rounded-[7px] bg-sunk px-2 text-caption font-extrabold text-text">{code}</span>
                  ) : (
                    <span />
                  )}
                  <span className="flex min-w-0 items-center gap-2">
                    <Link to={`/surveys/${i.surveyId}`} className={cx("truncate text-text no-underline hover:underline", retired && "text-muted line-through")}>
                      {name}
                    </Link>
                    {i.administration === "clinician" ? (
                      <Tag tone="attention" icon={<ShellIcon name="stethoscope" size={12} />}>
                        {ut("bt.byClinician")}
                      </Tag>
                    ) : null}
                    {retired ? <Tag tone="attention">{ut("mark.retired")}</Tag> : null}
                  </span>
                  <span className={cx("whitespace-nowrap text-small", i.required ? "text-muted" : "font-bold text-text-2")}>
                    {i.required ? ut("bt.required") : ut("bt.optional")}
                  </span>
                  <span className="flex flex-col items-end whitespace-nowrap text-caption text-muted max-[1180px]:hidden">
                    <b className="font-extrabold text-text">{count(i.questionCount, "items")}</b>
                    {i.medianMinutes === null
                      ? ut("bt.durationUnknown")
                      : i.medianMinutes < 1
                        ? ut("mc.btLessMin")
                        : ut("mc.btMin").replace("{n}", String(Math.round(i.medianMinutes)))}
                  </span>
                </li>
              );
            })}
          </ol>
          {mixed ? (
            <div className="mt-3">
              <Callout kind="warn" icon={<ShellIcon name="stethoscope" size={16} />} title={ut("mc.btMixedTitle")}>
                {ut("bt.mixedModes")}
              </Callout>
            </div>
          ) : null}
          {retiredSteps.length ? (
            <div className="mt-3">
              <Callout kind="warn" title={ut("mc.btRetiredTitle")}>
                {ut("mc.btRetiredText").replace("{codes}", retiredSteps.map((i) => shortOf(i.title)).join(", "))}
              </Callout>
            </div>
          ) : null}
        </Panel>

        <Panel
          title={ut("bt.assignments")}
          icon={<Ic.users />}
          sub={asg.data ? ut("mc.btActiveOf").replace("{n}", String(counts.active)).replace("{all}", String(counts.all)) : undefined}
          flush
          footer={
            <span className="ml-auto flex flex-wrap items-center gap-3 text-caption text-muted">
              <Legend tone="done" label={ut("bt.stepDone")} />
              <Legend tone="current" label={ut("bt.stepCurrent")} />
              <Legend tone="clinician" label={ut("mc.btWaitsClinician")} />
              <span className="inline-flex items-center gap-1">
                <Ic.lock size={12} />
                {ut("bt.stepLocked")}
              </span>
            </span>
          }
        >
          <div className="px-4 pb-3">
            <ViewPills
              value={view}
              onChange={(k) => setView(k as AsgView)}
              items={[
                { key: "all", label: ut("grp.filterAll"), count: counts.all },
                { key: "active", label: ut("mc.btViewActive"), count: counts.active },
                { key: "late", label: ut("mc.btViewLate"), count: counts.late },
                { key: "done", label: ut("mc.btViewDone"), count: counts.done },
              ]}
            />
          </div>
          {asg.data === null ? (
            <div className="border-t border-divider px-4 py-3">
              <p className="m-0 text-small text-muted">{asg.error ?? ut("common.loading")}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="border-t border-divider px-4">
              <Empty compact title={ut("bat.notAssigned")} hint={ut("bt.assignHint")} />
            </div>
          ) : (
            <DataTable
              rows={shownRows}
              columns={columns}
              rowKey={(a) => a.id}
              label={ut("bt.assignments")}
              pageSize={10}
              empty={
                <div className="border-t border-divider px-4">
                  <Empty compact title={ut("cat.emptySearch")} />
                </div>
              }
              rowActions={(a) =>
                state(a) === "done" ? null : (
                  <>
                    {clinicianStep(a) ? (
                      <ButtonLink size="xs" variant="ghost" to={`/surveys/${clinicianStep(a)!.surveyId}/administer`}>
                        <Ic.keyboard size={14} />
                        {ut("mc.administerShort")}
                      </ButtonLink>
                    ) : null}
                    <Button size="xs" variant="ghost" icon={<Mi.userX />} disabled={busy} onClick={() => setCancelling(a)}>
                      {ut("mc.accRevoke")}
                    </Button>
                  </>
                )
              }
            />
          )}
        </Panel>
      </div>

      <AssignDrawer
        open={assigning}
        onClose={() => setAssigning(false)}
        onReturn={() => setAssigning(true)}
        title={ut("mc.btAssignTitle")}
        sub={`«${b.title}», ${count(b.items.length, "methods")}, ${count(items, "items")}`}
        note={minutes !== null ? ut("mc.btAssignNote").replace("{n}", String(minutes)) : undefined}
        draftName={ut("mc.btAssignDraft").replace("{title}", b.title)}
        existing={existing}
        exclusive
        assignOne={(userId, due, note) => api.assignBattery(b.id, userId, due, note)}
        /* и список слева: число активных назначений на плитке набора — тоже от назначения */
        onAssigned={() => {
          asg.reload();
          onChanged();
        }}
      />

      {cancelling ? (
        <Modal
          title={ut("mc.btCancelTitle").replace("{name}", cancelling.userName)}
          icon={<Mi.userX />}
          tone="warn"
          onClose={() => setCancelling(null)}
          footer={
            <>
              <Button
                variant="secondary"
                icon={<Mi.userX />}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.cancelAssignment(cancelling.id);
                    setCancelling(null);
                    asg.reload();
                    onChanged();
                  }, ut("bt.assignmentRemoved"))
                }
              >
                {ut("mc.accRevoke")}
              </Button>
              <Button variant="quiet" onClick={() => setCancelling(null)}>
                {ut("ui.cancel")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mc.btCancelText")}</p>
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={ut("mc.btDeleteTitle").replace("{title}", b.title)}
          icon={<Mi.trash />}
          tone="warn"
          onClose={() => setDeleting(false)}
          footer={
            <>
              <Button
                variant="secondary"
                icon={<Mi.trash />}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.deleteBattery(b.id);
                    setDeleting(false);
                    onDeleted();
                  }, ut("bt.deleted"))
                }
              >
                {ut("mc.btDelete")}
              </Button>
              <Button variant="quiet" onClick={() => setDeleting(false)}>
                {ut("ui.cancel")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mc.btDeleteText")}</p>
        </Modal>
      ) : null}
    </Page>
  );
}

function Legend({ tone, label }: { tone: keyof typeof STEP_TONE; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className={cx("inline-block size-3.5 rounded-[4px]", STEP_TONE[tone])} />
      {label}
    </span>
  );
}

/* ─────────── правка набора ─────────── */

/**
 * Состав и настройки набора — в ящике (wide): название, группа, пояснение,
 * порядок, архив и шаги с «обов’язкова», порядком и удалением. Методики
 * добавляются поиском по каталогу: снятые не предлагаются, но шаг со
 * снятой методикой называется своим именем с пометкой (ui/choices.ts).
 */
function BatteryEditor({
  battery,
  surveys,
  groups,
  onClose,
  onSaved,
}: {
  battery: Battery | "new" | null;
  surveys: SurveyListItem[];
  groups: SurveyGroupWithCounts[];
  onClose: () => void;
  onSaved: (id: string | null) => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const b = battery === "new" ? null : battery;
  const [title, setTitle] = useState(b?.title ?? "");
  const [description, setDescription] = useState(b?.description ?? "");
  const [groupId, setGroupId] = useState(b?.groupId ?? "");
  const [strictOrder, setStrictOrder] = useState(b?.strictOrder ?? true);
  const [archived, setArchived] = useState(b?.archived ?? false);
  const [items, setItems] = useState<{ surveyId: string; required: boolean }[]>(
    b?.items.map((i) => ({ surveyId: i.surveyId, required: i.required })) ?? [],
  );
  const [find, setFind] = useState("");

  const live = surveys.filter((s) => !s.archivedAt && s.status === "published");
  const itemTitles = new Map(b?.items.map((i) => [i.surveyId, i.title]) ?? []);
  const known = (id: string) => {
    const s = surveys.find((x) => x.id === id);
    if (s) return { title: s.title, retired: !!s.archivedAt };
    const t = itemTitles.get(id);
    return t ? { title: t, retired: false } : null;
  };
  const choices = new Map(keepChosen(live, items.map((i) => i.surveyId), known).map((c) => [c.id, c]));
  const words = { retired: ut("mark.retired"), unavailable: ut("choice.unavailable"), unknown: ut("am.testUnavailable") };
  const titleOf = (id: string) => {
    const c = choices.get(id);
    return c ? choiceLabel(c, words) : id;
  };
  const move = (index: number, delta: number) => {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setItems(next);
  };
  const needle = find.trim().toLowerCase();
  const addable = live.filter((s) => !items.some((i) => i.surveyId === s.id)).filter((s) => !needle || s.title.toLowerCase().includes(needle));
  const dirty =
    title !== (b?.title ?? "") ||
    description !== (b?.description ?? "") ||
    items.length !== (b?.items.length ?? 0) ||
    items.some((i, k) => i.surveyId !== b?.items[k]?.surveyId || i.required !== b?.items[k]?.required);

  const save = () =>
    void run(async () => {
      const payload = { title: title.trim(), description: description.trim() || null, groupId: groupId || null, strictOrder, archived, items };
      if (b) {
        await api.updateBattery(b.id, payload);
        onSaved(b.id);
      } else {
        const created = await api.createBattery(payload);
        onSaved(created.id);
      }
    }, b ? ut("bt.updated") : ut("bt.assembled"));

  return (
    <Drawer
      open={battery !== null}
      onClose={onClose}
      wide
      title={b ? ut("bt.editTitle") : ut("bt.newTitle")}
      sub={b ? b.title : undefined}
      icon={<Ic.layers />}
      dirty={dirty}
      draftName={ut("mc.btEditDraft")}
      footer={
        <>
          <Button variant="primary" icon={<Ic.check />} disabled={busy || !title.trim() || !items.length} onClick={save}>
            {ut("ui.save")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {ut("ui.cancel")}
          </Button>
        </>
      }
    >
      <DrawerSection>
        <Field label={ut("f.name")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ut("bt.namePlaceholder")} data-autofocus maxLength={200} />
        </Field>
        <Field label={ut("f.group")}>
          <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">{ut("mark.outsideGroups")}</option>
            {/*
              Снятые группы не предлагаются, но выбранная остаётся: <select>
              без совпадающего значения показывает первый вариант, и правка
              названия молча переносила бы набор в чужую группу.
            */}
            {groups
              .filter((g) => !g.archivedAt || g.id === groupId)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={ut("f.description")} optional>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </Field>
        <div className="flex flex-col gap-2">
          <CheckLabel
            control={<Checkbox checked={strictOrder} onChange={(e) => setStrictOrder(e.target.checked)} />}
            label={ut("bat.strictOrder")}
            sub={ut("bt.strictOrderHint")}
          />
          <CheckLabel control={<Checkbox checked={archived} onChange={(e) => setArchived(e.target.checked)} />} label={ut("mc.btInArchive")} />
        </div>
      </DrawerSection>
      <DrawerSection title={ut("bt.composition")} sub={items.length ? String(items.length) : undefined}>
        {items.length ? (
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {items.map((item, i) => (
              <li key={item.surveyId} className="flex items-center gap-2 rounded-[10px] bg-sunk py-1.5 pl-2.5 pr-1.5">
                <span className="w-5 shrink-0 text-center text-caption font-extrabold text-text-2">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-small font-semibold text-text">{titleOf(item.surveyId)}</span>
                <CheckLabel
                  className="shrink-0"
                  control={
                    <Checkbox
                      checked={item.required}
                      onChange={(e) => setItems(items.map((x, j) => (i === j ? { ...x, required: e.target.checked } : x)))}
                    />
                  }
                  label={ut("bt.required")}
                />
                <Button size="icon-sm" variant="quiet" aria-label={ut("mark.above")} disabled={i === 0} onClick={() => move(i, -1)}>
                  <Ic.arrowUp />
                </Button>
                <Button size="icon-sm" variant="quiet" aria-label={ut("mark.below")} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                  <Ic.arrowDown />
                </Button>
                <Button size="icon-sm" variant="quiet" aria-label={ut("ui.remove")} onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  <Ic.x />
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="m-0 text-small text-muted">{ut("bat.emptyAddBelow")}</p>
        )}
      </DrawerSection>
      <DrawerSection title={ut("mc.btAddMethod")}>
        <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder={ut("mc.searchPh")} icon={<Ic.search />} look="fill" />
        <div className="mt-2 flex max-h-[260px] flex-col overflow-y-auto">
          {addable.slice(0, 40).map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setItems([...items, { surveyId: s.id, required: true }])}
              className="flex min-h-0 cursor-pointer items-center gap-2 rounded-[8px] border-0 bg-transparent px-2 py-1.5 text-left text-small text-text hover:bg-sunk"
            >
              <Ic.plus size={14} className="shrink-0 text-violet-ink" />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <small className="shrink-0 text-caption text-muted">{s.questionCount}</small>
            </button>
          ))}
          {!addable.length ? <p className="m-0 px-2 py-1.5 text-small text-muted">{ut("cat.emptySearch")}</p> : null}
        </div>
      </DrawerSection>
    </Drawer>
  );
}
