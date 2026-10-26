import { useMemo, useState } from "react";
import { GROUP_COLORS, type GroupAdmin, type GroupAnalytics, type SurveyGroupWithCounts, type User } from "@quizzy/shared";
import { api } from "../api";
import { HBars, ShareBar, TimeColumns } from "../charts/clinical";
import { duration, severityKey } from "../format";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Avatar, eachOf, Modal, Screen, selectAllState, toggleAll, toggleKey, useAction, useToast } from "../ui";
import { cx } from "../ui/cx";
import { Drawer, DrawerSection } from "../ui/Drawer";
import { SearchField } from "../ui/filters";
import { Ic } from "../ui/icons";
import { useHotkeys } from "../ui/keys";
import { Count, Page, Panel } from "../ui/layout";
import { ActionMenu, type MenuEntry } from "../ui/menu";
import { Tooltip } from "../ui/Popover";
import { ListGroup, ListTile, TextAction } from "../ui/records";
import { Button, ButtonLink, CheckLabel, Checkbox, Field, Input, Tag } from "../ui/primitives";
import { Callout, Empty, Loading } from "../ui/states";
import { useUrlState } from "../ui/urlState";
import { useResource } from "../useResource";
import { Mi } from "./methods/icons";
import { ListAndRecord, ListColumn, ListEmpty } from "./methods/ListColumn";
import { Fact } from "./methods/MethodPage";
import { dayDiff, shortDate } from "./methods/model";
import { useSettledSelection } from "./methods/settle";
import { num, useCount } from "./methods/useCount";

/*
 * Групи методик — UI 3, «Виразна» (methods-groups), список і запис.
 *
 * Группа методик — единица разграничения доступа: администратор видит
 * только методики своих групп. Слева — все группы, и снятые тоже:
 * расформированное отделение никуда не делось, у него остались люди,
 * прохождения и открытые случаи. Справа — выбранная группа: аналитика
 * (считает сервер одним ответом — человек, прошедший три методики группы,
 * один, а не три), администраторы и риск.
 *
 * Кнопки правки — по ответу сервера (`manageable`), а не по роли: право
 * `groups.manage` выдаётся, и заведующий отделением получает его без роли
 * суперадмина. Завести и переименовать — в ящике, удалить — окном.
 *
 * Чего нет из макета: переключателя «30 днів / 90 днів / Рік» — аналитика
 * группы у сервера за весь час, без периода; график по дням показывает
 * последние 30 днів из неё.
 */

type View = "all" | "active" | "retired";

export default function Groups() {
  /*
   * Сотрудники грузятся вместе с группами и только если есть кого назначать:
   * список учётных записей закрыт правом, и его отказ не должен прятать
   * экран групп — он про другое.
   */
  const res = useResource(async () => {
    const groups = await api.groups();
    const staff = groups.some((g) => g.manageable)
      ? /* сотрудники отбираются на сервере: реестр страничный, отбор по первой странице потерял бы людей */
        await api.users({ staff: true, limit: 500 }).then((p) => p.items).catch(() => [] as User[])
      : [];
    return { groups, staff };
  }, []);
  return <Screen res={res}>{({ groups, staff }) => <GroupsScreen groups={groups} staff={staff} reload={res.reload} />}</Screen>;
}

function GroupsScreen({ groups, staff, reload }: { groups: SurveyGroupWithCounts[]; staff: User[]; reload: () => void }) {
  const { ut } = useLang();
  const count = useCount();
  const [selected, setSelected] = useUrlState("id");
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("all");
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState<SurveyGroupWithCounts | "new" | null>(null);
  const canManage = groups.some((g) => g.manageable);

  const needle = q.trim().toLowerCase();
  const matches = (g: SurveyGroupWithCounts) => !needle || g.title.toLowerCase().includes(needle);
  const byUse = (a: SurveyGroupWithCounts, b: SurveyGroupWithCounts) => b.responseCount - a.responseCount;
  const active = groups.filter((g) => !g.archivedAt).filter(matches).sort(byUse);
  const retired = groups.filter((g) => !!g.archivedAt).filter(matches).sort(byUse);
  const showActive = view !== "retired";
  const showRetired = view !== "active";
  const order = [...(showActive ? active : []), ...(showRetired ? retired : [])];
  const current = groups.find((g) => g.id === selected) ?? order[0] ?? null;
  /* аналитика записи — по строке, на которой остановились: шаг J/K догоняет, щелчок грузит сразу (methods/settle.ts) */
  const { settled, stepped } = useSettledSelection(current?.id ?? null);

  const step = (dir: 1 | -1) => {
    if (!order.length) return;
    const at = current ? order.findIndex((g) => g.id === current.id) : -1;
    const next = order[Math.min(order.length - 1, Math.max(0, at + dir))];
    if (!next || next.id === current?.id) return;
    stepped();
    setSelected(next.id);
  };

  const tile = (g: SurveyGroupWithCounts) => (
    <ListTile
      key={g.id}
      to={`/groups?id=${g.id}`}
      selected={current?.id === g.id}
      title={g.title}
      meta={count(g.surveyCount, "methods")}
      reason={
        <span className="flex min-w-0 items-center gap-1.5">
          {g.admins.length ? (
            <span className="flex -space-x-1">
              {g.admins.slice(0, 3).map((a) => (
                <Avatar key={a.userId} name={a.fullName} size={24} tone={current?.id === g.id ? "violet" : "soft"} className="ring-2 ring-panel" />
              ))}
            </span>
          ) : null}
          <span className="truncate text-caption text-muted">{count(g.admins.length, "admins")}</span>
        </span>
      }
      aside={
        g.openCaseCount ? (
          <Tag tone="danger" icon={<Ic.alert />}>
            {ut("mc.grOpenCases").replace("{n}", String(g.openCaseCount))}
          </Tag>
        ) : g.archivedAt ? (
          <Tag tone="done">{ut("grp.surveyRetired")}</Tag>
        ) : undefined
      }
      next={count(g.responseCount, "responses")}
      nextIcon={<ShellIcon name="activity" size={13} />}
      when={count(g.patientCount, "people")}
    />
  );

  const list = (
    <ListColumn
      title={ut("adm.groupsTitle")}
      count={groups.filter((g) => !g.archivedAt).length}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      onStep={step}
      search={{ value: q, onChange: setQ, placeholder: ut("mc.grSearch") }}
      views={{
        value: view,
        onChange: (k) => setView(k as View),
        items: [
          { key: "all", label: ut("grp.filterAll"), count: groups.length },
          { key: "active", label: ut("grp.filterActive"), count: groups.filter((g) => !g.archivedAt).length },
          { key: "retired", label: ut("mc.grRetiredView"), count: groups.filter((g) => !!g.archivedAt).length },
        ],
      }}
      sortNote={ut("mc.grSortNote")}
      /* число групп — в шапке и на вкладках отбора; в подвале оно не помещалось рядом с подсказками клавиш на 1280 */
      actions={
        canManage ? (
          <Tooltip label={ut("adm.newGroup")} side="bottom">
            <Button size="icon-sm" variant="quiet" aria-label={ut("adm.newGroup")} onClick={() => setEditing("new")}>
              <Mi.folderPlus />
            </Button>
          </Tooltip>
        ) : null
      }
    >
      {showActive && active.length ? (
        <>
          <ListGroup label={ut("grp.filterActive")} count={active.length} mark="violet" />
          {active.map(tile)}
        </>
      ) : null}
      {showRetired && retired.length ? (
        <>
          <ListGroup label={ut("mc.grRetiredGroup")} count={retired.length} mark="ok" />
          {retired.map(tile)}
        </>
      ) : null}
      {!order.length ? <ListEmpty>{groups.length ? ut("cat.emptySearch") : ut("grp.emptyHint")}</ListEmpty> : null}
    </ListColumn>
  );

  return (
    <ListAndRecord list={list}>
      {current ? (
        <GroupRecord
          key={current.id}
          group={current}
          load={settled === current.id}
          staff={staff}
          onEdit={() => setEditing(current)}
          onChanged={reload}
          onDeleted={() => {
            setSelected("");
            reload();
          }}
        />
      ) : (
        <Page
          title={ut("adm.groupsTitle")}
          actions={
            canManage ? (
              <Button variant="primary" icon={<Mi.folderPlus />} onClick={() => setEditing("new")}>
                {ut("adm.newGroup")}
              </Button>
            ) : null
          }
        >
          <Panel>
            <Empty title={ut("grp.emptyAll")} hint={canManage ? ut("grp.emptyHint") : ut("grp.noPermissionHint")} />
          </Panel>
        </Page>
      )}
      <GroupEditor
        key={editing === "new" ? "editor-new" : `editor-${editing?.id ?? "closed"}`}
        group={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </ListAndRecord>
  );
}

/* ─────────── администраторы ─────────── */

/**
 * «Додати адміністраторів» — сотрудники галочками.
 *
 * Прежде здесь был селект на одного и «Додати»: группу, которую должны видеть
 * все врачи отделения (каталог методик), раздавали двадцать раз подряд.
 * Теперь — поиск, «Вибрати всіх» и одна кнопка. Маршрут назначает одного
 * (POST /api/groups/:id/admins), поэтому — по запросу на человека, и отказ
 * одному не отменяет остальных: не прошедшие остаются отмеченными.
 */
function AddAdminsDrawer({
  open,
  groupId,
  groupTitle,
  candidates,
  onClose,
  onAdded,
}: {
  open: boolean;
  groupId: string;
  groupTitle: string;
  /** Сотрудники, которые ещё не администраторы группы */
  candidates: User[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const { ut } = useLang();
  const toast = useToast();
  const { run, busy } = useAction();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const needle = q.trim().toLowerCase();
  const shown = candidates.filter((u) => !needle || `${u.fullName} ${u.email}`.toLowerCase().includes(needle));
  const shownKeys = shown.map((u) => u.id);
  const all = selectAllState(shownKeys, picked);
  /* назначаются только те, кто ещё в списке: уже назначенного список не держит */
  const chosen = candidates.filter((u) => picked.has(u.id));

  const submit = () =>
    void run(async () => {
      const { done, failed } = await eachOf(chosen, (u) => api.assignGroupAdmin(groupId, u.id));
      if (done.length) {
        toast(ut("mc.grAdminsAddedN").replace("{n}", String(done.length)), "ok");
        onAdded();
      }
      if (failed.length) {
        toast(`${ut("mc.bulkFailed").replace("{n}", String(failed.length))}: ${failed.map((f) => f.item.fullName).join(", ")}`, "err");
        setPicked(new Set(failed.map((f) => f.item.id)));
        return;
      }
      setPicked(new Set());
      setQ("");
      onClose();
    });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={ut("mc.grAddAdmins")}
      sub={groupTitle}
      icon={<ShellIcon name="user-plus" />}
      note={ut("mc.grAdminsHint")}
      noteIcon={<ShellIcon name="user-cog" />}
      footer={
        <>
          <Button variant="primary" icon={<ShellIcon name="user-plus" size={15} />} disabled={!chosen.length || busy} onClick={submit}>
            {chosen.length ? ut("mc.grAddN").replace("{n}", String(chosen.length)) : ut("mc.grAdd")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {ut("ui.cancel")}
          </Button>
        </>
      }
    >
      <DrawerSection>
        {candidates.length > 8 ? (
          <SearchField value={q} onChange={setQ} placeholder={ut("mc.grStaffSearch")} width={0} className="mb-2.5 w-full" />
        ) : null}
        {shown.length ? (
          <div className="flex flex-col">
            {shown.length > 1 ? (
              <CheckLabel
                className="border-b border-divider pb-2.5"
                control={
                  <Checkbox
                    checked={all === "all"}
                    indeterminate={all === "some"}
                    onChange={() => setPicked(toggleAll(shownKeys, picked))}
                  />
                }
                label={<b className="font-bold text-text">{ut("mc.grPickAll").replace("{n}", String(shown.length))}</b>}
              />
            ) : null}
            {shown.map((u) => (
              <CheckLabel
                key={u.id}
                className="border-b border-divider py-2 last:border-b-0"
                control={<Checkbox checked={picked.has(u.id)} onChange={() => setPicked(toggleKey(picked, u.id))} />}
                label={
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={u.fullName} size={28} tone="neutral" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-body font-semibold text-text">{u.fullName}</span>
                      <small className="truncate text-caption text-muted">{u.email}</small>
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        ) : (
          <p className="m-0 text-small text-muted">{ut("pt.nobodyFound")}</p>
        )}
      </DrawerSection>
    </Drawer>
  );
}

/* ─────────── запись ─────────── */

function GroupRecord({
  group: g,
  load,
  staff,
  onEdit,
  onChanged,
  onDeleted,
}: {
  group: SurveyGroupWithCounts;
  /** Выбор устоялся: аналитику группы (чтение со строкой журнала) можно грузить */
  load: boolean;
  staff: User[];
  onEdit: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { ut } = useLang();
  const count = useCount();
  const { run, busy } = useAction();
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState<GroupAdmin | null>(null);
  const [adding, setAdding] = useState(false);
  const archived = !!g.archivedAt;
  const analytics = useResource(() => api.groupAnalytics(g.id), [g.id], { enabled: load });

  useHotkeys({
    e: () => {
      if (g.manageable) onEdit();
    },
  });

  const menu: MenuEntry[] = g.manageable
    ? [
        {
          label: archived ? ut("grp.restore") : ut("grp.archive"),
          icon: archived ? <Mi.archiveRestore size={16} /> : <Ic.archive size={16} />,
          onSelect: () =>
            void run(
              async () => {
                await api.archiveGroup(g.id, !archived);
                onChanged();
              },
              archived ? ut("grp.restoredToast") : ut("grp.archivedToast"),
            ),
        },
        { label: ut("mc.grDelete"), icon: <Mi.trash size={16} />, ruled: true, onSelect: () => setDeleting(true) },
      ]
    : [];

  const candidates = staff.filter((u) => !g.admins.some((a) => a.userId === u.id));

  return (
    <Page
      title={
        <span className="inline-flex items-center gap-2.5">
          {g.color ? <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: g.color }} /> : null}
          {g.title}
        </span>
      }
      actions={
        <>
          <ButtonLink to={`/surveys?group=${g.id}`} variant="secondary">
            <ShellIcon name="library" size={15} />
            {ut("mc.grMethods")}
            <Count n={g.surveyCount} tone="tint" />
          </ButtonLink>
          {g.manageable ? (
            <Button variant="secondary" icon={<ShellIcon name="pencil" size={15} />} onClick={onEdit}>
              {ut("grp.rename")}
            </Button>
          ) : null}
          {menu.length ? (
            <ActionMenu label={ut("mc.grMenu")} entries={menu} triggerSize="icon" triggerClassName="bg-violet-tint hover:bg-violet-tint-2" />
          ) : null}
        </>
      }
      below={
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-small text-text-2">
            {archived ? (
              <Tag tone="done" icon={<Ic.archive />}>
                {ut("grp.archived")}
              </Tag>
            ) : null}
            <Fact icon={<Mi.calendar size={15} />}>{ut("mc.grCreated").replace("{date}", shortDate(g.createdAt))}</Fact>
            <Fact icon={<ShellIcon name="library" size={15} />}>
              {ut("mc.grSurveys").replace("{all}", count(g.surveyCount, "methods")).replace("{pub}", num(g.publishedCount))}
            </Fact>
            <Fact icon={<Ic.users size={15} />}>{count(g.patientCount, "people")}</Fact>
            <Fact icon={<ShellIcon name="user-cog" size={15} />}>{count(g.admins.length, "admins")}</Fact>
          </div>
          {g.description ? <p className="m-0 mt-3 max-w-[72ch] text-body text-text-2">{g.description}</p> : null}
          {archived ? <p className="m-0 mt-2 max-w-[72ch] text-small text-muted">{ut("grp.archiveHint")}</p> : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {analytics.data ? (
          <GroupInsight data={analytics.data} />
        ) : (
          <Panel title={ut("grp.showAnalytics")} icon={<Ic.chart />}>
            <Loading rows={3} error={analytics.error} onRetry={analytics.reload} bare />
          </Panel>
        )}
        <div className="grid grid-cols-2 items-stretch gap-4 max-[1180px]:grid-cols-1">
          <Panel title={ut("adm.admins")} icon={<ShellIcon name="user-cog" />} count={g.admins.length}>
            <p className="m-0 mb-2 text-small text-muted">{ut("mc.grAdminsHint")}</p>
            {g.admins.length ? (
              <ul className="m-0 list-none p-0">
                {g.admins.map((a) => (
                  <li key={a.userId} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-divider py-2 first:border-t-0">
                    <Avatar name={a.fullName} size={28} tone="neutral" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-body font-semibold text-text">{a.fullName}</span>
                      <small className="truncate text-caption text-muted">{`${a.email}, ${ut("mc.grSince").replace("{date}", shortDate(a.addedAt))}`}</small>
                    </span>
                    {g.manageable ? (
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => setRemoving(a)}>
                        {ut("acc.revoke")}
                      </Button>
                    ) : (
                      <span />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-small text-muted">{ut("adm.noAdmins")}</p>
            )}
            {g.manageable && candidates.length ? (
              <Button className="mt-3" variant="secondary" icon={<ShellIcon name="user-plus" size={15} />} onClick={() => setAdding(true)}>
                {ut("mc.grAddAdmins")}
              </Button>
            ) : null}
          </Panel>
          <Panel
            title={ut("mc.grRisk")}
            icon={<Mi.siren />}
            tone={g.openCaseCount ? "risk" : "neutral"}
            actions={<TextAction to="/alerts">{ut("mc.grAllCases")}</TextAction>}
          >
            {g.openCaseCount ? (
              <Callout
                kind="risk"
                icon={<Ic.alert />}
                title={ut("mc.grOpenCases").replace("{n}", String(g.openCaseCount))}
                actions={
                  <ButtonLink to="/alerts" variant="risk" size="xs">
                    {ut("mc.grReview")}
                  </ButtonLink>
                }
              >
                {ut("mc.grOpenCasesText")}
              </Callout>
            ) : (
              <Callout kind="good" icon={<Ic.circleCheck />}>
                {ut("mc.grNoCases")}
              </Callout>
            )}
          </Panel>
        </div>
      </div>

      <AddAdminsDrawer
        key={g.id}
        open={adding}
        groupId={g.id}
        groupTitle={g.title}
        candidates={candidates}
        onClose={() => setAdding(false)}
        onAdded={onChanged}
      />
      {removing ? (
        <Modal
          title={ut("mc.grRemoveTitle").replace("{name}", removing.fullName)}
          icon={<Mi.userX />}
          tone="warn"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.revokeGroupAdmin(g.id, removing.userId);
                    setRemoving(null);
                    onChanged();
                  }, ut("mc.grAdminRemoved"))
                }
              >
                {ut("acc.revoke")}
              </Button>
              <Button variant="quiet" onClick={() => setRemoving(null)}>
                {ut("ui.cancel")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mc.grRemoveText").replace("{group}", g.title)}</p>
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={ut("mc.grDeleteTitle").replace("{title}", g.title)}
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
                    await api.deleteGroup(g.id);
                    setDeleting(false);
                    onDeleted();
                  }, ut("adm.groupDeleted"))
                }
              >
                {ut("mc.grDelete")}
              </Button>
              <Button variant="quiet" onClick={() => setDeleting(false)}>
                {ut("ui.cancel")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mc.grDeleteText")}</p>
        </Modal>
      ) : null}
    </Page>
  );
}

/**
 * Аналитика группы (за весь час): проходження, люди, доходимість, время;
 * распределение по тяжести (содержательные шкалы, достоверные протоколы);
 * по методикам; по дням — последние 30.
 */
function GroupInsight({ data }: { data: GroupAnalytics }) {
  const { ut } = useLang();
  if (!data.responseCount) {
    return (
      <Panel title={ut("grp.showAnalytics")} icon={<Ic.chart />}>
        <Empty compact title={ut("grp.noResponses")} />
      </Panel>
    );
  }
  const lost = Math.max(0, data.startedCount - data.responseCount);
  const sorted = [...data.surveys].sort((a, b) => b.responseCount - a.responseCount);
  const top = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const now = new Date();
  const days: { key: string; label: string; value: number; tip: string }[] = [];
  const byDate = new Map(data.timeline.map((p) => [p.date, p.count] as const));
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push({ key, label: shortDate(key), value: byDate.get(key) ?? 0, tip: shortDate(key) });
  }
  const last30 = days.reduce((s, d) => s + d.value, 0);
  const lastActive = data.timeline.at(-1)?.date ?? null;

  return (
    <Panel title={ut("grp.showAnalytics")} icon={<Ic.chart />} sub={ut("mc.grAllTime")}>
      <p className="m-0 text-body text-text-2">
        {ut("mc.grSummary")
          .replace("{responses}", num(data.responseCount))
          .replace("{people}", num(data.patientCount))
          .replace("{rate}", num(data.completionRate))
          .replace("{lost}", num(lost))
          .replace("{avg}", data.avgDurationMs ? duration(data.avgDurationMs) : "—")}
      </p>
      <div className="mt-4">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <b className="text-small font-extrabold text-text">{ut("grp.severityTitle")}</b>
          {data.unreliableCount ? (
            <span className="text-caption text-muted">{`${ut("stats.unreliableLeftOut")} ${num(data.unreliableCount)}`}</span>
          ) : null}
        </div>
        <ShareBar
          label={ut("grp.severityTitle")}
          parts={data.severityBreakdown.map((s) => ({ key: s.severity, label: ut(severityKey[s.severity]), value: s.count, severity: s.severity }))}
        />
        <p className="m-0 mt-2 text-small text-muted">{ut("grp.severityHint")}</p>
      </div>
      {/*
        Две колонки — только когда в панели есть место: рядом со списком групп
        на 1280 полосе «За методиками» доставалось 80 px на название, и
        методики читались как «Скринінг е…», «СР-45. Схи…».
      */}
      <div className="@container mt-4 border-t border-divider pt-4">
        <div className="grid grid-cols-1 gap-6 @[820px]:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <b className="text-small font-extrabold text-text">{ut("grp.bySurvey")}</b>
              <span className="text-caption text-muted">{ut("mc.grResponsesCol")}</span>
            </div>
            <HBars
              items={[
                ...top.map((s, i) => ({
                  key: s.surveyId,
                  label: s.archived ? `${s.title} (${ut("grp.surveyRetired")})` : s.title,
                  value: s.responseCount,
                  strong: i === 0,
                })),
                ...(rest.length
                  ? [
                      {
                        key: "rest",
                        label: ut("mc.grMoreMethods").replace("{n}", String(rest.length)),
                        value: rest.reduce((sum, s) => sum + s.responseCount, 0),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
          <div className="min-w-0">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <b className="text-small font-extrabold text-text">{ut("grp.byDay")}</b>
              <span className="text-caption text-muted">
                {ut("mc.grLast30").replace("{n}", num(last30))}
                {lastActive && dayDiff(new Date(`${lastActive}T00:00:00`), now) > 30 ? `, ${ut("mc.grLastActive").replace("{date}", shortDate(lastActive))}` : ""}
              </span>
            </div>
            <TimeColumns columns={days} label={ut("grp.byDay")} height={180} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ─────────── группа: завести или переименовать ─────────── */

/** Название, пояснение и цвет; цвет — из готовых (они хранятся хексом и читаются телефоном) */
function GroupEditor({ group, onClose, onSaved }: { group: SurveyGroupWithCounts | "new" | null; onClose: () => void; onSaved: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const g = group === "new" ? null : group;
  const [title, setTitle] = useState(g?.title ?? "");
  const [description, setDescription] = useState(g?.description ?? "");
  const [color, setColor] = useState<string>(g?.color ?? GROUP_COLORS[0]);
  const dirty = title !== (g?.title ?? "") || description !== (g?.description ?? "");
  const colors = useMemo(() => (g?.color && !(GROUP_COLORS as readonly string[]).includes(g.color) ? [g.color, ...GROUP_COLORS] : [...GROUP_COLORS]), [g]);

  const save = () =>
    void run(async () => {
      const input = { title: title.trim(), description: description.trim() || null, color };
      if (g) await api.updateGroup(g.id, input);
      else await api.createGroup(input);
      onSaved();
    }, g ? ut("grp.renamed") : ut("mc.grCreatedToast"));

  return (
    <Drawer
      open={group !== null}
      onClose={onClose}
      title={g ? ut("grp.rename") : ut("adm.newGroup")}
      sub={g?.title}
      icon={<Mi.folderPlus />}
      dirty={dirty}
      draftName={ut("mc.grDraft")}
      footer={
        <>
          <Button variant="primary" icon={<Ic.check />} disabled={busy || !title.trim()} onClick={save}>
            {g ? ut("ui.save") : ut("adm.create")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {ut("ui.cancel")}
          </Button>
        </>
      }
    >
      <DrawerSection>
        <Field label={ut("f.name")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ut("adm.groupExample")} data-autofocus maxLength={200} />
        </Field>
        <Field label={ut("f.description")} optional>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </Field>
        <div role="radiogroup" aria-label={ut("mc.grColor")}>
          <span className="mb-1.5 block text-caption font-bold text-muted">{ut("mc.grColor")}</span>
          <div className="flex items-center gap-2">
            {colors.map((c, i) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={ut("mc.grColorN").replace("{n}", String(i + 1))}
                onClick={() => setColor(c)}
                className={cx(
                  "size-8 min-h-0 cursor-pointer rounded-full border-0 p-0",
                  color === c ? "shadow-[0_0_0_2px_var(--panel),0_0_0_4px_var(--vring)]" : "hover:shadow-[0_0_0_2px_var(--panel),0_0_0_4px_var(--ctl)]",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
          <p className="m-0 mt-1.5 text-small text-muted">{ut("mc.grColorHint")}</p>
        </div>
      </DrawerSection>
    </Drawer>
  );
}
