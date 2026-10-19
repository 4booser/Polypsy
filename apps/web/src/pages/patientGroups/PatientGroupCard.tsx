import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useMatch, useNavigate, useParams } from "react-router-dom";
import { t, type PatientGroupMember, type PatientGroupSurvey } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { Avatar, KbdHints, Loading, Modal, PersonCell, useAction, useToast } from "../../ui";
import { DataTable, type Column } from "../../ui/DataTable";
import { FilterBar, FilterChip } from "../../ui/filters";
import { Ic } from "../../ui/icons";
import { Count, IconTile, Page, Panel } from "../../ui/layout";
import { Popover, Tooltip } from "../../ui/Popover";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { PickGroupDialog } from "./dialogs";
import { AddMembersDrawer, AssignDrawer, GroupEditDrawer, useGroupKeys } from "./drawers";
import { GroupState } from "./GroupState";
import { HeartIcon, Pi } from "./icons";
import { pluralForm } from "../../ui/plural";
import { fill, grantEach, matchesQuery, newProgress, partialFailure, shortDate, surveyCode } from "./model";

/*
 * Карточка группы пациентов (patients-group-card «Виразної»).
 *
 * Шапка: имя группы, закладка «обрана», факты (учасників, тестів, хто веде,
 * с ризиком — поповером с именами) и действия: открыть группу в реестре,
 * редактировать, назначить тест. Ниже две колонки — «Тести групи» с тем, кто
 * уже прошёл, и «Опис групи» слева, «Стан групи» по шкале справа, — и
 * «Пацієнти групи» таблицей во всю ширину: отметки тестов группы, ризик,
 * выбор строк и действия над выбранными.
 *
 * Всё о группе приходит одним ответом GET /api/patient-groups/:id (описание,
 * состав, методики — сервер отдаёт их вместе, потому что экран открывает их
 * вместе); «Стан групи» — аналитикой методики со срезом по группе.
 *
 * Правка, назначение и добавление людей — в ящиках: карточка остаётся на
 * месте. Адрес /patient-groups/:id/edit открывает карточку с ящиком правки
 * (дверь «Редагувати групу» в колонке подразделов, shell/nav.ts).
 *
 * Чего на макете есть, а здесь нет: «PCL-5 від вступу» в строке состава
 * (баллов людей ответ группы не несёт), «Нагадати» (маршрута напоминания о
 * тесте нет), «Дублювати» и «В архів» (у группы нет ни того, ни другого).
 */

type DrawerKind = "edit" | "assign" | "assignPicked" | "add" | null;

export default function PatientGroupCard() {
  const { ut, lang } = useLang();
  const { id } = useParams<{ id: string }>();
  const groupId = id!;
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const { can } = useAuth();
  const canAssign = can("assignments.manage");

  /* keep: false (#200): состав прежней группы под адресом новой — и «Видалити» ушло бы не тем людям */
  const card = useResource(() => api.patientGroup(groupId), [groupId], { keep: false });
  const group = card.data;

  /* ─── ящики ─── */

  const editing = useMatch("/patient-groups/:id/edit") !== null;
  const [drawer, setDrawer] = useState<DrawerKind>(editing ? "edit" : null);
  const open = (d: DrawerKind) => setDrawer(d);
  /*
   * Переход с карточки на «Редагувати групу» в колонке подразделов — тот же
   * экран под другим адресом: React оставляет его смонтированным, и ящик
   * открывается по смене адреса, а не только при первом открытии.
   */
  useEffect(() => {
    if (editing) setDrawer("edit");
  }, [editing]);
  const close = () => {
    setDrawer(null);
    /* ящик правки, открытый адресом, при закрытии возвращает адрес карточки: иначе перезагрузка открыла бы его снова */
    if (editing) navigate(`/patient-groups/${groupId}`, { replace: true });
  };
  /*
   * Ящик добавления людей что-то изменил — карточку надо перечитать после
   * закрытия. Перечитывание только по флагу: GET /api/patient-groups/:id
   * пишет в журнал доступа чтение поимённого состава, и закрытый без
   * добавлений ящик не должен оставлять там след.
   */
  const dirty = useRef(false);
  const closeAdd = () => {
    setDrawer(null);
    if (dirty.current) card.reload();
    dirty.current = false;
  };

  /* ─── состав ─── */

  const [q, setQ] = useState("");
  const [riskOnly, setRiskOnly] = useState(false);
  const [notDone, setNotDone] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<PatientGroupMember[] | null>(null);
  const [moving, setMoving] = useState(false);
  const groups = useResource(() => api.patientGroups(), [moving], { enabled: moving });

  const surveys = group?.surveys ?? [];
  const members = useMemo(
    () =>
      (group?.members ?? []).filter(
        (m) =>
          matchesQuery(q, m.fullName, m.email, m.unit) &&
          (!riskOnly || m.openRisk) &&
          (!notDone || m.completedSurveyIds.length < surveys.length),
      ),
    [group, q, riskOnly, notDone, surveys.length],
  );
  const risky = (group?.members ?? []).filter((m) => m.openRisk);
  const memberIds = useMemo(() => new Set((group?.members ?? []).map((m) => m.userId)), [group]);
  const picked = (group?.members ?? []).filter((m) => selected.has(m.userId));

  /* назначение выбранным — по запросу на человека; выданное в этом ящике помнится (model.ts, grantEach) */
  const progress = useRef(newProgress());

  const toggleFavourite = async () => {
    if (!group) return;
    const next = !group.favourite;
    card.patch({ ...group, favourite: next });
    try {
      await api.favouritePatientGroup(group.id, next);
    } catch (e) {
      card.reload();
      toast(e instanceof Error ? e.message : ut("ui.actionFailed"), "err");
    }
  };

  useGroupKeys({ edit: () => open("edit"), fav: () => void toggleFavourite() }, drawer === null && !!group);

  if (card.error) return <Loading error={card.error} onRetry={card.reload} />;
  if (!group) return <Loading rows={6} />;

  /* «Стан групи» — когда есть что мерить и есть право на аналитику; иначе две панели встают рядом */
  const showState = surveys.length > 0 && can("analytics.read");

  const remove = (people: PatientGroupMember[]) =>
    void run(async () => {
      await api.removePatientGroupMembers(groupId, people.map((p) => p.userId));
      setRemoving(null);
      setSelected(new Set());
      card.reload();
    }, ut("pg.removed"));

  const columns: Column<PatientGroupMember>[] = [
    {
      key: "name",
      header: ut("pg.patient"),
      required: true,
      sort: (m) => m.fullName,
      render: (m) => (
        <PersonCell
          name={m.fullName}
          to={`/patients/${m.userId}`}
          avatar={<Avatar name={m.fullName} size={34} />}
          sub={[m.birthYear ? `${m.birthYear} ${ut("pg.yearSuffix")}` : null, fill(ut("pg2.inGroupSince"), { date: shortDate(m.addedAt) })]
            .filter(Boolean)
            .join(", ")}
        />
      ),
    },
    {
      key: "state",
      header: ut("pg2.colState"),
      width: 190,
      required: true,
      sort: (m) => (m.openRisk ? 0 : 1),
      render: (m) =>
        m.openRisk ? (
          <Link to={`/alerts?patientGroup=${groupId}`} className="no-underline">
            <Tag tone="danger" icon={<Ic.alert />}>
              {ut("pg2.openRisk")}
            </Tag>
          </Link>
        ) : (
          <span className="text-small text-muted">{ut("pg2.noOpenRisk")}</span>
        ),
    },
    {
      key: "tests",
      header: surveys.length ? fill(ut("pg2.colGroupTests"), { codes: surveys.map((s) => surveyCode(t(s.title, lang))).join(", ") }) : ut("pg2.colTests"),
      required: true,
      sort: (m) => m.completedSurveyIds.length,
      render: (m) => <TestMarks member={m} surveys={surveys} />,
    },
  ];

  const facts = (
    <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-text-2">
      <span className="inline-flex items-center gap-1.5">
        <Pi.usersRound size={14} className="text-muted" />
        {fill(ut(`pg2.membersN.${pluralForm(group.members.length, lang)}`), { n: group.members.length })}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Pi.clipboardList size={14} className="text-muted" />
        {fill(ut(`pg2.testsN.${pluralForm(surveys.length, lang)}`), { n: surveys.length })}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Avatar name={group.ownerName} size={22} />
        {fill(ut("pg2.leads"), { name: group.ownerName })}
      </span>
      {risky.length ? (
        <Popover
          title={ut("pg2.riskInGroup")}
          note={`${risky.length} ${ut("common.of")} ${group.members.length}`}
          content={
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small">
              {risky.map((m) => (
                <li key={m.userId}>
                  <Link to={`/patients/${m.userId}`} className="font-bold text-text">
                    {m.fullName}
                  </Link>
                </li>
              ))}
            </ul>
          }
          actions={
            <ButtonLink to={`/alerts?patientGroup=${groupId}`} variant="risk" size="xs">
              {ut("pg2.riskCases")}
            </ButtonLink>
          }
        >
          <span tabIndex={0} className="rounded-pill">
            <Tag tone="danger" icon={<Ic.alert />}>
              {fill(ut("pg2.withRisk"), { n: risky.length })}
            </Tag>
          </span>
        </Popover>
      ) : null}
    </span>
  );

  return (
    <Page
      title={
        <span className="inline-flex items-center gap-3">
          <IconTile icon={<Pi.usersRound />} size={48} />
          {group.title}
        </span>
      }
      back={{ to: "/patient-groups", label: ut("sn.patientGroups") }}
      actions={
        <>
          <Tooltip label={group.favourite ? ut("pg2.unfavourite") : ut("pg2.favourite")} kbd="F">
            <button
              type="button"
              aria-label={ut("pg.favorite")}
              aria-pressed={group.favourite}
              onClick={() => void toggleFavourite()}
              className={
                group.favourite
                  ? "inline-grid size-10 min-h-0 cursor-pointer place-items-center rounded-control border-0 bg-violet-tint p-0 text-violet-ink"
                  : "inline-grid size-10 min-h-0 cursor-pointer place-items-center rounded-control border-0 bg-sunk p-0 text-muted hover:bg-sunk-2 hover:text-text"
              }
            >
              <HeartIcon size={17} filled={group.favourite} />
            </button>
          </Tooltip>
          <Tooltip label={ut("pg2.openInRegistry")}>
            <ButtonLink to={`/patients?group=${groupId}`} size="icon" aria-label={ut("pg2.openInRegistry")}>
              <Pi.tableProps />
            </ButtonLink>
          </Tooltip>
          <Tooltip label={ut("pg.edit")} kbd="E">
            <Button icon={<Pi.pencilLine />} onClick={() => open("edit")} aria-expanded={drawer === "edit"}>
              {ut("pg2.edit")}
            </Button>
          </Tooltip>
          {canAssign ? (
            <Button
              variant="primary"
              icon={<Pi.clipboardPlus />}
              disabled={group.members.length === 0}
              onClick={() => open("assign")}
              aria-expanded={drawer === "assign"}
            >
              {ut("cn.assignGroup")}
            </Button>
          ) : null}
        </>
      }
    >
      {/* факты — строкой под именем, как на макете: справа от длинного имени им не хватило бы места на 1280 */}
      <div className="-mt-3 mb-4 pl-[106px] max-[700px]:pl-0">{facts}</div>
      <div className="grid items-start gap-4 min-[1180px]:grid-cols-2">
        <div className={showState ? "flex min-w-0 flex-col gap-4" : "contents"}>
          <Panel
            title={ut("pg2.groupTests")}
            icon={<Pi.clipboardList />}
            count={surveys.length}
            flush
            actions={
              canAssign && group.members.length ? (
                <Button variant="ghost" size="xs" icon={<Pi.clipboardPlus />} onClick={() => open("assign")}>
                  {ut("cn.assignGroup")}
                </Button>
              ) : null
            }
          >
            {surveys.length === 0 ? (
              <p className="m-0 px-4 pb-4 text-small text-muted">{ut("pg.noTests")}</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {surveys.map((s) => (
                  <GroupTestRow key={s.surveyId} survey={s} total={group.members.length} />
                ))}
              </ul>
            )}
          </Panel>
          <Panel
            title={ut("pg2.descriptionLabel")}
            icon={<Pi.text />}
            actions={
              <Tooltip label={ut("pg.edit")} kbd="E">
                <Button variant="ghost" size="xs" icon={<Pi.pencilLine />} onClick={() => open("edit")}>
                  {ut("pg2.edit")}
                </Button>
              </Tooltip>
            }
          >
            {group.description ? (
              <p className="m-0 whitespace-pre-line text-body leading-[21px] text-text">{group.description}</p>
            ) : (
              <p className="m-0 text-body font-semibold text-warn">{ut("pg2.noDescription")}</p>
            )}
            <p className="m-0 mt-2.5 text-caption text-muted">
              {fill(ut("pg2.descriptionNote"), { date: shortDate(group.createdAt, new Date(0)), name: group.ownerName })}
            </p>
          </Panel>
        </div>
        {showState ? <GroupState groupId={groupId} surveys={surveys} /> : null}
      </div>

      <Panel
        className="mt-4"
        title={ut("pg2.groupPatients")}
        icon={<Pi.usersRound />}
        count={group.members.length}
        flush
      >
        <div className="px-4 pb-3">
          <FilterBar
            search={{ value: q, onChange: setQ, placeholder: ut("pg.patientSearch"), width: 240 }}
            chips={
              <>
                <FilterChip
                  label={ut("pg2.chipRisk")}
                  on={riskOnly}
                  onClick={() => setRiskOnly((v) => !v)}
                  onClear={() => setRiskOnly(false)}
                />
                {surveys.length ? (
                  <FilterChip
                    label={ut("pg2.chipNotDone")}
                    on={notDone}
                    onClick={() => setNotDone((v) => !v)}
                    onClear={() => setNotDone(false)}
                  />
                ) : null}
              </>
            }
            right={
              canAssign ? (
                <Button variant="ghost" size="xs" icon={<Pi.userPlus />} onClick={() => open("add")}>
                  {ut("pg.addPatient")}
                </Button>
              ) : null
            }
          />
        </div>
        <DataTable
          rows={members}
          columns={columns}
          rowKey={(m) => m.userId}
          label={ut("pg2.groupPatients")}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          hotkeys={drawer === null}
          pageSize={25}
          empty={
            <p className="m-0 px-4 pb-5 text-small text-muted">
              {group.members.length ? ut("pt.nobodyFound") : ut("pg2.noMembers")}
            </p>
          }
          bulkActions={(rows) => (
            <>
              {canAssign ? (
                <Button variant="panel" size="xs" icon={<Pi.clipboardPlus />} onClick={() => {
                  progress.current = newProgress();
                  open("assignPicked");
                }}>
                  {ut("pg.assignTest")}
                </Button>
              ) : null}
              <Button variant="panel" size="xs" icon={<Pi.usersRound />} onClick={() => setMoving(true)}>
                {ut("pg2.toOtherGroup")}
              </Button>
              <Button variant="panel" size="xs" icon={<Pi.userMinus />} onClick={() => setRemoving(rows)}>
                {ut("pg.removeFromGroup")}
              </Button>
            </>
          )}
          rowActions={(m) => (
            <>
              <Tooltip label={ut("pg2.openCase")}>
                <ButtonLink to={`/patients/${m.userId}/case`} variant="quiet" size="icon-sm" aria-label={`${ut("pg2.openCase")}: ${m.fullName}`}>
                  <Pi.folderOpen />
                </ButtonLink>
              </Tooltip>
              <Tooltip label={ut("pg.removeFromGroup")}>
                <Button variant="quiet" size="icon-sm" aria-label={`${ut("pg.removeFromGroup")}: ${m.fullName}`} onClick={() => setRemoving([m])}>
                  <Pi.userMinus />
                </Button>
              </Tooltip>
            </>
          )}
        />
        <KbdHints
          bar
          keys={[
            ["J K", ut("pg2.kRows")],
            ["X", ut("pg2.kSelect")],
            ["E", ut("pg2.kEdit")],
            ["F", ut("pg2.kFav")],
            ["/", ut("pg2.kSearch")],
          ]}
        />
      </Panel>

      <GroupEditDrawer
        open={drawer === "edit"}
        group={{ ...group, memberCount: group.members.length }}
        neighbours={{ all: null, next: null }}
        onClose={close}
        onReturn={() => open("edit")}
        onSaved={(saved, favourite) => {
          /* состав и методики не менялись — подменяем шапку, не перечитывая всё */
          card.patch({ ...group, title: saved.title, description: saved.description, favourite });
          close();
        }}
      />
      <AssignDrawer
        open={drawer === "assign"}
        who={fill(ut(`pg2.whoGroup.${pluralForm(group.members.length, lang)}`), { name: group.title, n: group.members.length })}
        whoNote={ut("pg2.assignGroupNote")}
        already={new Set(surveys.map((s) => s.surveyId))}
        onAssign={async (surveyId, expiresAt) => {
          const res = await api.assignSurveyToPatientGroup(groupId, { surveyId, expiresAt });
          card.reload();
          return `${ut("cn.assignedToGroup")} «${group.title}»: ${ut("cn.recipients")} — ${res.recipients}`;
        }}
        onClose={() => setDrawer(null)}
        onReturn={() => open("assign")}
      />
      <AssignDrawer
        open={drawer === "assignPicked"}
        who={fill(ut("pg2.whoPicked"), { n: picked.length })}
        whoNote={ut("pg2.assignPickedNote")}
        onAssign={async (surveyId, expiresAt) => {
          const outcome = await grantEach(progress.current, `${surveyId}|${expiresAt ?? ""}`, [...selected], (userId) =>
            api.grant(surveyId, userId, undefined, expiresAt),
          );
          if (outcome.error) {
            const reason = outcome.error instanceof Error ? outcome.error.message : ut("acc.grantFailed");
            throw new Error(partialFailure(outcome, reason, { done: ut("pg.assigned"), of: ut("an.of") }));
          }
          card.reload();
          return `${ut("pg.assigned")} — ${outcome.done}`;
        }}
        onClose={() => setDrawer(null)}
        onReturn={() => open("assignPicked")}
      />
      <AddMembersDrawer
        open={drawer === "add"}
        groupId={groupId}
        groupTitle={group.title}
        members={memberIds}
        onAdded={() => {
          dirty.current = true;
        }}
        onClose={closeAdd}
      />

      {removing ? (
        <Modal
          title={fill(ut(`pg2.removeTitle.${pluralForm(removing.length, lang)}`), { n: removing.length })}
          sub={group.title}
          icon={<Pi.userMinus />}
          tone="warn"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="danger" disabled={busy} onClick={() => remove(removing)}>
                {ut("pg.removeFromGroup")}
              </Button>
              <Button onClick={() => setRemoving(null)}>{ut("common.cancel")}</Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">
            {fill(ut("pg2.removeBody"), { names: removing.map((m) => m.fullName).join(", ") })}
          </p>
        </Modal>
      ) : null}
      {moving ? (
        groups.data ? (
          <PickGroupDialog
            groups={groups.data.filter((g) => g.id !== groupId)}
            count={selected.size}
            onPick={async (target) => {
              /* списком, а не запросом на человека: сервер проверяет пачку целиком; повтор — «уже там» */
              await api.addPatientGroupMembers(target, [...selected]);
              setMoving(false);
              toast(ut("pg.added"), "ok");
            }}
            onClose={() => setMoving(false)}
          />
        ) : (
          <Modal title={ut("pg.addToGroup")} onClose={() => setMoving(false)}>
            <Loading rows={2} error={groups.error} onRetry={groups.reload} bare />
          </Modal>
        )
      ) : null}
    </Page>
  );
}

/**
 * Строка «Тести групи»: код и название (ссылка на методику), когда назначено
 * и до какого срока, полоса «пройшли N з M» — и «усі пройшли», когда сделано.
 */
function GroupTestRow({ survey, total }: { survey: PatientGroupSurvey; total: number }) {
  const { ut, lang } = useLang();
  const title = t(survey.title, lang);
  const code = surveyCode(title);
  const done = Math.min(survey.completedCount, total);
  const full = total > 0 && done >= total;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const when = [
    fill(ut("pg2.assignedOn"), { date: shortDate(survey.assignedAt) }),
    survey.expiresAt ? fill(ut("pg2.dueOn"), { date: shortDate(survey.expiresAt) }) : ut("pg2.noDeadline"),
  ].join(", ");
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_128px_auto] items-center gap-4 border-t border-divider px-4 py-3 first:border-t-0 max-[700px]:grid-cols-1">
      <span className="min-w-0">
        <Link to={`/surveys/${survey.surveyId}`} className="block no-underline">
          <b className="font-extrabold text-text">{code}</b>
          {code !== title ? <span className="ml-1.5 font-semibold text-text-2">{title}</span> : null}
        </Link>
        <small className="block text-caption text-muted">{when}</small>
      </span>
      <span>
        <span className="mb-[5px] flex items-baseline justify-between text-caption text-muted">
          <span>{ut("pg.completed")}</span>
          <span>
            <b className="text-[13px] font-extrabold text-text">{done}</b> {ut("common.of")} {total}
          </span>
        </span>
        <span aria-hidden className="relative block h-2 overflow-hidden rounded-[4px] bg-track">
          <i className={`absolute inset-y-0 left-0 rounded-[4px] ${full ? "bg-good" : "bg-violet"}`} style={{ width: `${pct}%` }} />
        </span>
      </span>
      <span className="flex justify-end">
        {full ? (
          <span className="inline-flex items-center gap-1.5 text-small font-bold text-good">
            <Ic.circleCheck size={15} />
            {ut("pg2.allDone")}
          </span>
        ) : (
          <Count n={fill(ut("pg2.waiting"), { n: total - done })} />
        )}
      </span>
    </li>
  );
}

/** Отметки тестов группы в строке состава: квадрат на методику и «2 з 3» */
function TestMarks({ member, surveys }: { member: PatientGroupMember; surveys: PatientGroupSurvey[] }) {
  const { ut, lang } = useLang();
  if (!surveys.length) return <span className="text-small text-muted">—</span>;
  const done = new Set(member.completedSurveyIds);
  return (
    <span className="flex items-center gap-1">
      {surveys.map((s) => {
        const ok = done.has(s.surveyId);
        const code = surveyCode(t(s.title, lang));
        return (
          <i
            key={s.surveyId}
            title={`${code}: ${ok ? ut("pg2.markDone") : ut("pg2.markNot")}`}
            className={
              ok
                ? "grid size-[22px] place-items-center rounded-[7px] bg-good-tint not-italic text-good"
                : "grid size-[22px] place-items-center rounded-[7px] not-italic shadow-[inset_0_0_0_1.5px_var(--ctl)]"
            }
          >
            {ok ? <Ic.check size={12} /> : null}
          </i>
        );
      })}
      <span className="ml-1 whitespace-nowrap text-caption font-bold text-muted">
        {done.size} {ut("common.of")} {surveys.length}
      </span>
      <span className="sr-only">
        {surveys
          .map((s) => `${surveyCode(t(s.title, lang))}: ${done.has(s.surveyId) ? ut("pg2.markDone") : ut("pg2.markNot")}`)
          .join(", ")}
      </span>
    </span>
  );
}
