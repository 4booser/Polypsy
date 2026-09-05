import { useState } from "react";
import type { GroupAdmin, GroupAnalytics, Severity, SurveyGroupWithCounts, User } from "@quizzy/shared";
import { api } from "../api";
import { useResource } from "../useResource";
import { duration, dateTime, severityColor, severityKey } from "../format";
import { BarList } from "../charts";
import { Empty, Loading, useAction, useUrlState } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Num, SectionLabel, Select, Stat, Tag } from "../ui/primitives";
import { cx } from "../ui/cx";
import { useLang } from "../lang";

/**
 * Группы методик: все, что есть, вместе с администрированием и аналитикой.
 *
 * Экран собирает три вещи, которые раньше жили порознь или не жили вовсе.
 *
 * 1. Список всех групп, включая снятые с использования. Снятые показываются
 *    здесь намеренно: расформированное отделение никуда не делось, у него
 *    остались люди, прохождения и открытые случаи, и убирать его из виду
 *    значит терять к ним дорогу. Отсеиваются они там, где список работает
 *    выбором, — в конструкторе методики и в сборке батареи.
 *
 * 2. Администрирование: завести, переименовать, набрать администраторов,
 *    снять с использования. Кнопки показываются по ответу сервера
 *    (`manageable`), а не по роли: право `groups.manage` стало выдаваемым, и
 *    заведующий отделением, ради которого его заводили, при проверке роли
 *    кнопок не видел вовсе, хотя сервер его пропускал.
 *
 * 3. Аналитика по группе — по запросу, не сразу. Считает её сервер одним
 *    ответом: сложить «сколько людей» из аналитики каждой методики нельзя,
 *    человек, прошедший три методики группы, — один человек, а не три.
 */

const PRESET_COLORS = ["#3b5bfd", "#1baf7a", "#eb6834", "#4a3aa7", "#e87ba4"];

export default function Groups() {
  const { ut } = useLang();
  const [scope, setScope] = useUrlState("scope");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Сотрудники грузятся вместе с группами и только если есть кого назначать:
   * список учётных записей закрыт правом, и его отказ не должен прятать сам
   * экран групп — он про другое.
   */
  const res = useResource(async () => {
    const groups = await api.groups();
    const staff = groups.some((g) => g.manageable)
      ? await api.users().then((u) => u.filter((x) => x.role !== "user")).catch(() => [] as User[])
      : [];
    return { groups, staff };
  }, []);

  const groups = res.data?.groups ?? null;
  const staff = res.data?.staff ?? [];
  const reload = res.reload;

  if (!groups) return <Loading error={res.error} />;

  const canManage = groups.some((g) => g.manageable);
  const showAll = scope === "all";
  const shown = showAll ? groups : groups.filter((g) => !g.archivedAt);
  const archivedCount = groups.filter((g) => g.archivedAt).length;

  return (
    <Page
      title={ut("adm.groupsTitle")}
      sub={ut("adm.groupsSub")}
      count={shown.length}
      actions={
        canManage ? (
          <Button variant="primary" onClick={() => setCreating((v) => !v)}>
            {ut("adm.newGroup")}
          </Button>
        ) : null
      }
      toolbar={
        /*
         * Переключатель показывается, только когда есть что показывать:
         * «Действующие / Все» при нуле снятых групп — кнопка, которая ничего
         * не меняет, и человек нажимает её, чтобы это выяснить.
         */
        archivedCount ? (
          <div className="segmented" role="group">
            <button
              className={showAll ? "" : "active"}
              aria-pressed={!showAll}
              onClick={() => setScope("")}
            >
              {ut("grp.filterActive")}
            </button>
            <button
              className={showAll ? "active" : ""}
              aria-pressed={showAll}
              onClick={() => setScope("all")}
            >
              {ut("grp.filterAll")}
            </button>
          </div>
        ) : null
      }
    >
      <Stack>
        {creating && canManage ? (
          <NewGroup
            onDone={async () => {
              setCreating(false);
              reload();
            }}
            onError={setError}
          />
        ) : null}

        {!canManage ? (
          <Panel>
            <p className="m-0 text-caption text-muted">{ut("grp.noPermissionHint")}</p>
          </Panel>
        ) : null}

        {error ? <p className="text-caption text-danger">{error}</p> : null}

        {shown.length === 0 ? (
          <Empty
            title={showAll ? ut("grp.emptyAll") : ut("grp.emptyActive")}
            hint={ut("grp.emptyHint")}
          />
        ) : (
          shown.map((g) => (
            <GroupCard key={g.id} group={g} staff={staff} onChanged={reload} onError={setError} />
          ))
        )}
      </Stack>
    </Page>
  );
}

/** Заведение группы: цвет выбирается из готовых, а не пипеткой — их читают в списках */
function NewGroup({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const { ut } = useLang();
  const { run } = useAction();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]!);

  return (
    <Panel title={ut("adm.newGroup")}>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={ut("f.name")} className="min-w-[200px] flex-1">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ut("adm.groupExample")} />
        </Field>
        <Field label={ut("f.description")} className="min-w-[240px] flex-[2]">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ColorPicker value={color} onChange={setColor} />
        <Button
          variant="primary"
          disabled={!title.trim()}
          onClick={() =>
            run(async () => {
              await api
                .createGroup({ title: title.trim(), description: description.trim() || null, color })
                .catch((e: Error) => {
                  onError(e.message);
                  throw e;
                });
              onDone();
            })
          }
        >
          {ut("adm.create")}
        </Button>
      </div>
    </Panel>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {PRESET_COLORS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          title={p}
          className={cx(
            "size-[26px] rounded-sm border-2 p-0",
            value === p ? "border-[var(--text)]" : "border-transparent",
          )}
          style={{ background: p }}
        />
      ))}
    </div>
  );
}

/**
 * Одна группа: счётчики, администраторы и — по требованию — аналитика.
 *
 * Аналитика не грузится вместе со списком. На двадцати группах это двадцать
 * тяжёлых запросов ради панели, которую откроют у одной, и экран открывался
 * бы секундами.
 */
function GroupCard({
  group: g,
  staff,
  onChanged,
  onError,
}: {
  group: SurveyGroupWithCounts;
  staff: User[];
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const { ut } = useLang();
  const { run } = useAction();
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [openAnalytics, setOpenAnalytics] = useState(false);
  const archived = !!g.archivedAt;

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          {g.color ? (
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: g.color }} />
          ) : null}
          {g.title}
          {archived ? <Tag>{ut("grp.archived")}</Tag> : null}
          {g.openCaseCount ? <Tag tone="danger">{ut("grp.openCases")}: {g.openCaseCount}</Tag> : null}
        </span>
      }
      hint={g.description || undefined}
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => setOpenAnalytics((v) => !v)}>
            {openAnalytics ? ut("grp.hideAnalytics") : ut("grp.showAnalytics")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {ut("grp.rename")}
          </Button>
          {g.manageable ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  run(
                    async () => {
                      await api.archiveGroup(g.id, !archived);
                      onChanged();
                    },
                    archived ? ut("grp.restoredToast") : ut("grp.archivedToast"),
                  )
                }
              >
                {archived ? ut("grp.restore") : ut("grp.archive")}
              </Button>
              {/*
                Удаление стоит последним и остаётся только для пустой группы —
                отказ сервера показывается тостом. Для непустой правильное
                действие рядом: снять с использования.
              */}
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  run(async () => {
                    if (!confirm(`${ut("adm.confirmDeleteGroup")} «${g.title}»?`)) return;
                    await api.deleteGroup(g.id);
                    onChanged();
                  }, ut("adm.groupDeleted"))
                }
              >
                {ut("adm.delete")}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption text-muted">
        <span>
          <Num>{g.surveyCount}</Num> {ut("adm.methodsCount")}
        </span>
        <span>
          <Num>{g.publishedCount}</Num> {ut("dash.published")}
        </span>
        <span>
          <Num>{g.responseCount}</Num> {ut("adm.responsesCount")}
        </span>
        <span>
          <Num>{g.patientCount}</Num> {ut("grp.people").toLowerCase()}
        </span>
      </div>

      {archived ? <p className="mt-2 max-w-[68ch] text-caption text-muted">{ut("grp.archiveHint")}</p> : null}

      {editing ? (
        <EditGroup
          group={g}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
          onError={onError}
        />
      ) : null}

      <SectionLabel className="mb-2 mt-4">{ut("adm.admins")}</SectionLabel>
      {g.admins.length === 0 ? (
        <p className="m-0 text-caption text-muted">{ut("adm.noAdmins")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{ut("adm.fullName")}</th>
                <th>Email</th>
                <th>{ut("adm.assignedAt")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {g.admins.map((a: GroupAdmin) => (
                <tr key={a.userId}>
                  <td>{a.fullName}</td>
                  <td className="text-muted">{a.email}</td>
                  <td className="text-muted">{dateTime(a.addedAt)}</td>
                  <td>
                    {g.manageable ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() =>
                          run(async () => {
                            await api.revokeGroupAdmin(g.id, a.userId);
                            onChanged();
                          })
                        }
                      >
                        {ut("acc.revoke")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {g.manageable ? (
        assigning ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select
              defaultValue=""
              className="max-w-[420px]"
              onChange={(e) => {
                if (!e.target.value) return;
                void run(async () => {
                  await api.assignGroupAdmin(g.id, e.target.value).catch((err: Error) => {
                    onError(err.message);
                    throw err;
                  });
                  setAssigning(false);
                  onChanged();
                });
              }}
            >
              <option value="">{ut("sel.pickStaff")}</option>
              {staff
                .filter((u) => !g.admins.some((a) => a.userId === u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} · {u.email}
                  </option>
                ))}
            </Select>
            <Button variant="quiet" onClick={() => setAssigning(false)}>
              {ut("ui.cancel")}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" className="mt-3" onClick={() => setAssigning(true)}>
            {ut("adm.addAdmin")}
          </Button>
        )
      ) : null}

      {openAnalytics ? <GroupInsight groupId={g.id} /> : null}
    </Panel>
  );
}

/** Правка названия, пояснения и цвета — тем же маршрутом, что и переименование */
function EditGroup({
  group: g,
  onDone,
  onError,
}: {
  group: SurveyGroupWithCounts;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const { ut } = useLang();
  const { run } = useAction();
  const [title, setTitle] = useState(g.title);
  const [description, setDescription] = useState(g.description ?? "");
  const [color, setColor] = useState(g.color ?? PRESET_COLORS[0]!);

  return (
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <Field label={ut("f.name")} className="min-w-[200px] flex-1">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={ut("f.description")} className="min-w-[240px] flex-[2]">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <ColorPicker value={color} onChange={setColor} />
      <Button
        variant="primary"
        disabled={!title.trim()}
        onClick={() =>
          run(async () => {
            await api
              .updateGroup(g.id, {
                title: title.trim(),
                description: description.trim() || null,
                color,
              })
              .catch((e: Error) => {
                onError(e.message);
                throw e;
              });
            onDone();
          }, ut("grp.renamed"))
        }
      >
        {ut("ui.save")}
      </Button>
    </div>
  );
}

const SEVERITIES: Severity[] = ["none", "mild", "moderate", "severe"];

/**
 * Аналитика группы.
 *
 * Три вопроса, ради которых её открывают: сколько людей прошло, сколько
 * получилось прохождений и как они распределились по степеням выраженности.
 * Людей и прохождения разведены намеренно — двадцать замеров одного человека
 * читаются как двадцать обследованных ровно до тех пор, пока стоит одно
 * число.
 */
function GroupInsight({ groupId }: { groupId: string }) {
  const { ut } = useLang();
  const res = useResource(() => api.groupAnalytics(groupId), [groupId]);
  const data: GroupAnalytics | null = res.data;

  if (!data) return <Loading rows={3} error={res.error} />;
  if (!data.responseCount) {
    return <p className="mt-4 text-caption text-muted">{ut("grp.noResponses")}</p>;
  }

  const severityItems = data.severityBreakdown.map((s) => ({
    label: ut(severityKey[s.severity]),
    value: s.count,
    color: severityColor[s.severity],
  }));

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-hairline pt-4">
      <div className="flex flex-wrap gap-8">
        <Stat value={data.patientCount} label={ut("grp.people")} />
        <Stat value={data.responseCount} label={ut("adm.responsesCount")} />
        <Stat value={data.completionRate} unit="%" label={ut("grp.completion")} />
        <Stat
          value={data.avgDurationMs ? duration(data.avgDurationMs) : null}
          label={ut("grp.avgDuration")}
        />
        <Stat
          value={data.openCaseCount}
          label={ut("grp.openCases")}
          tone={data.openCaseCount ? "danger" : "plain"}
        />
      </div>

      <div>
        <SectionLabel className="mb-2">{ut("grp.severityTitle")}</SectionLabel>
        <BarList items={severityItems} />
        <p className="mt-2 max-w-[68ch] text-caption text-muted">{ut("grp.severityHint")}</p>
      </div>

      <div>
        <SectionLabel className="mb-2">{ut("grp.bySurvey")}</SectionLabel>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{ut("f.name")}</th>
                <th>{ut("adm.responsesCount")}</th>
                <th>{ut("grp.people")}</th>
                {SEVERITIES.map((s) => (
                  <th key={s}>{ut(severityKey[s])}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.surveys.map((s) => (
                <tr key={s.surveyId}>
                  <td>
                    {s.title}
                    {s.archived ? <span className="text-muted"> · {ut("grp.surveyRetired")}</span> : null}
                  </td>
                  <td>
                    <Num>{s.responseCount}</Num>
                  </td>
                  <td>
                    <Num>{s.patientCount}</Num>
                  </td>
                  {SEVERITIES.map((sev) => {
                    const n = s.severityBreakdown.find((b) => b.severity === sev)?.count ?? 0;
                    return (
                      <td key={sev} style={{ color: n ? severityColor[sev] : undefined }}>
                        <Num>{n || "—"}</Num>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {data.timeline.length > 1 ? (
        <div>
          <SectionLabel className="mb-2">{ut("grp.byDay")}</SectionLabel>
          <BarList items={data.timeline.slice(-14).map((p) => ({ label: p.date, value: p.count }))} />
        </div>
      ) : null}
    </div>
  );
}
