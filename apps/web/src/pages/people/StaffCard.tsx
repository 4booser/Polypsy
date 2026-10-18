import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from "react-router-dom";
import type { AuditEntry, PatientGroupWithCounts, PatientListItem, Sex, UiKey } from "@quizzy/shared";
import { ROLE_LADDER, t } from "@quizzy/shared";
import { ApiError, api } from "../../api";
import { useAuth } from "../../auth";
import { locale, severityKey } from "../../format";
import { useLang } from "../../lang";
import {
  ActivityList,
  AlertChip,
  AlertStrip,
  Avatar,
  Callout,
  type Column,
  CourseDigits,
  DataTable,
  Drawer,
  DrawerSection,
  Empty,
  FilterBar,
  Ic,
  KV,
  KbdHints,
  Loading,
  Modal,
  PersonCell,
  TextAction,
  Tooltip,
  useAction,
  useHotkeys,
  useToast,
} from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { ActionMenu } from "../../ui/menu";
import { Button, Field, Input, Select, SeverityTag, Tag, Textarea } from "../../ui/primitives";
import { kitSeverity, shownSeries, shownValue } from "../patients/model";
import { shortCode } from "../patients/instruments";
import { useResource } from "../../useResource";
import { actionLabel } from "../ops/model";
import { forgetDirectory, ladderReadable, loadDirectory, loadMember } from "./data";
import { type StaffRow, STALE_DAYS, accountState, birthYear, isDoctor, isStale, mainRole, ownGroups, peopleLists, workplaceOf } from "./model";
import { AIc, daysAgo, dm, dmy, fill, hm, plural, shortName, whenShort } from "./parts";

/*
 * Картка фахівця — Polypsy 2.0, макеты admin-staff-card, admin-staff-patients,
 * admin-staff-transfer-dialog и admin-staff-groups.
 *
 * Полоса человека сверху (как карточка пациента): кружок, имя, должность и
 * відділення, возраст; строка открытого — роль, пациенты, второй фактор,
 * состояние записи; действия «Змінити роль», «Редагувати» (только своя
 * анкета — чужую сервер не правит) и «…». Под полосой вкладки: Профіль,
 * Пацієнти, Групи — разделы карточки, адресами /staff/:id/*; «Права й
 * винятки» и «Журнал дій» ведут туда, где это делается (экран прав с
 * человеком, журнал доступа с отбором по нему).
 *
 * Что с макета не пришло и почему: норма пациентов, смены и неявки,
 * «прийоми за 8 тижнів», висновки на підпис, устройства сессий — этого у
 * сервера нет для чужого человека (см. отчёт участка). Профиль прийому —
 * настоящий: кабинет и длительность приёма из профиля отделения, неделя из
 * шаблона расписания, если смотрящему он открыт.
 */

interface CardCtx {
  row: StaffRow;
  /** Своя карточка: правка анкеты — только в ней (PATCH /api/auth/me пишет в себя) */
  me: boolean;
  isSuper: boolean;
  reload: () => void;
  /** Группы этого человека, если смотрящему открыты пациенты (patients.read); null — ещё едут или закрыты */
  groups: PatientGroupWithCounts[] | null;
  /** Отказ загрузки групп — с «Повторити», а не вечный скелет */
  groupsError: string | null;
  reloadGroups: () => void;
  canPatients: boolean;
  /** Открыть правку своей анкеты (ящик); у чужой карточки — null */
  edit: (() => void) | null;
}

export default function StaffCard() {
  const { id } = useParams<{ id: string }>();
  const { user, refreshUser, can } = useAuth();
  const { ut } = useLang();
  const navigate = useNavigate();
  const me = !!user && user.id === id;
  const isSuper = user?.role === "superadmin";
  const canManage = can("users.manage");
  const canPatients = can("patients.read");

  const viewerId = user?.id ?? "";
  /* keep: false — карточка прежнего сотрудника не стоит под адресом следующего, и действия не уходят на него (#177) */
  const res = useResource(() => loadMember(id!, { id: viewerId, canManageUsers: canManage }), [id, viewerId, canManage], {
    enabled: !!id && !!user,
    keep: false,
  });
  /* группы пациентов — под правом patients.read: без права не спрашиваем (отказ лёг бы в журнал доступа) */
  const groupsRes = useResource(() => api.patientGroups(), [], { enabled: canPatients });
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<null | "reset" | "revoke" | "disable" | "enable">(null);

  /* уход с карточки на другую сбрасывает режимы: правка одного человека не переезжает к другому */
  useEffect(() => {
    setEditing(false);
    setDialog(null);
  }, [id]);

  const reload = useCallback(() => {
    res.reload();
    /* своя запись живёт ещё и в оболочке: имя в меню учётной записи обязано смениться вместе с карточкой */
    if (me) refreshUser();
  }, [res.reload, me, refreshUser]);

  useHotkeys({ e: () => setEditing(true) }, me && !!res.data?.row);

  if (res.error) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={6} />;
  const row = res.data.row;
  if (!row) {
    return (
      <div className="p-5">
        <h1 className="m-0 text-page font-extrabold text-text">{ut("ppl.notFound")}</h1>
        <p className="m-0 mt-2 text-small text-muted">{ut("adm2.notFoundHint")}</p>
      </div>
    );
  }

  const groups = groupsRes.data ? ownGroups(groupsRes.data, row.id, "") : canPatients ? null : [];
  const ctx: CardCtx = {
    row,
    me,
    isSuper,
    reload,
    groups,
    groupsError: groupsRes.error,
    reloadGroups: groupsRes.reload,
    canPatients,
    edit: me ? () => setEditing(true) : null,
  };
  const name = row.fullName || row.email;
  const base = `/staff/${row.id}`;
  /* под суперадмином нет лестницы: роль ему не меняют, и отключить его может только другой суперадмин (сервер решит) */
  const canRole = !me && row.role !== "superadmin";
  const state = accountState(row.account);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section aria-label={ut("adm2.staffBanner")} className="shrink-0 bg-band px-5 pb-1 pt-3.5">
        <div className="rounded-drawer border border-band-card-line bg-band-card px-4 pb-3 pt-3 shadow-banner">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link
              to={row.role === "superadmin" || (row.account?.ladderRank ?? 0) > 1 ? "/admins" : "/staff"}
              aria-label={ut("adm2.backToList")}
              title={ut("adm2.backToList")}
              className="-mr-1.5 inline-grid size-9 shrink-0 place-items-center rounded-control text-muted hover:bg-sunk hover:text-text"
            >
              <Ic.chevronLeft size={18} />
            </Link>
            <Avatar name={name} size={56} tone="violet" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="m-0 truncate text-title font-extrabold leading-[32px] text-text">{name}</h1>
              <Facts row={row} />
            </div>
            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
              {canRole ? (
                <Button icon={<AIc.key size={15} />} onClick={() => navigate(`/permissions?user=${row.id}`)}>
                  {ut("adm2.changeRole")}
                </Button>
              ) : null}
              {me ? (
                <Tooltip label={ut("adm2.editData")} kbd="E">
                  <Button icon={<Ic.pen size={15} />} onClick={() => setEditing(true)} aria-expanded={editing}>
                    {ut("ppl.edit")}
                  </Button>
                </Tooltip>
              ) : null}
              <ActionMenu
                label={ut("adm2.moreActions")}
                triggerSize="icon"
                entries={[
                  ...((row.account?.patients ?? 0) > 0 && canManage
                    ? [{ label: ut("adm2.transfer"), icon: <AIc.transfer size={15} />, to: `${base}/patients` }]
                    : []),
                  ...(me ? [{ label: ut("acct.changePassword"), icon: <AIc.key size={15} />, to: "/account" }] : []),
                  ...(!me && canManage
                    ? [
                        { label: ut("adm2.resetPassword"), icon: <AIc.rotate size={15} />, onSelect: () => setDialog("reset") },
                        { label: ut("adm2.revokeSessions"), icon: <AIc.logOut size={15} />, onSelect: () => setDialog("revoke") },
                      ]
                    : []),
                  ...(can("audit.read") ? [{ label: ut("adm2.actionLog"), icon: <Ic.history size={15} />, to: `/ops/audit?actor=${row.id}` }] : []),
                  ...(!me && canManage
                    ? [
                        state === "disabled"
                          ? { label: ut("adm2.enableAccount"), icon: <AIc.userCheck size={15} />, onSelect: () => setDialog("enable"), ruled: true }
                          : { label: ut("adm2.disableAccount"), icon: <AIc.userX size={15} />, onSelect: () => setDialog("disable"), ruled: true },
                      ]
                    : []),
                ]}
              />
            </div>
          </div>
          <OpenStrip row={row} me={me} />
        </div>
        <nav aria-label={ut("ppl.tabsLabel")} className="mt-2 flex flex-wrap items-center gap-1 pb-2">
          <CardTab to={base} end label={ut("ppl.tabProfile")} />
          <CardTab to={`${base}/patients`} label={ut("top.patients")} count={row.account?.patients ?? null} />
          <CardTab to={`${base}/groups`} label={ut("top.groups")} count={groups ? groups.length : null} />
          {ladderReadable({ id: viewerId, isSuper }, row) && (peopleLists(user).admins || me) ? (
            <CardTab to={`/permissions?user=${row.id}`} label={ut("adm2.tabPermissions")} external />
          ) : null}
          {can("audit.read") ? <CardTab to={`/ops/audit?actor=${row.id}`} label={ut("adm2.actionLog")} external /> : null}
        </nav>
      </section>
      <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-8 pt-4 outline-none">
        <Outlet context={ctx} />
      </div>

      {me ? (
        <ProfileDrawer
          row={row}
          open={editing}
          onReturn={() => setEditing(true)}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            reload();
          }}
        />
      ) : null}
      {dialog ? <AccountDialog kind={dialog} row={row} onClose={() => setDialog(null)} onDone={reload} /> : null}
    </div>
  );
}

/** Вкладка карточки: свои разделы — ссылками NavLink, чужие экраны — обычной ссылкой со стрелкой */
function CardTab({ to, label, count, end, external }: { to: string; label: string; count?: number | null; end?: boolean; external?: boolean }) {
  const cls = (on: boolean) =>
    cx(
      "relative inline-flex h-9 min-h-0 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-control border-0 px-[13px] text-body leading-none no-underline hover:no-underline",
      "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
      on ? "bg-panel font-extrabold text-violet-ink shadow-tile" : "bg-transparent font-semibold text-text-2 hover:bg-tab-hover hover:text-text",
    );
  const counter =
    count !== undefined && count !== null ? (
      <span className="inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-tab-count px-1.5 text-[11.5px] font-bold text-text-2">{count}</span>
    ) : null;
  if (external) {
    return (
      <Link to={to} className={cls(false)}>
        {label}
        <Ic.arrowRight size={13} className="text-muted" />
      </Link>
    );
  }
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cls(isActive)}>
      {label}
      {counter}
    </NavLink>
  );
}

/** Строка фактов под именем: должность и відділення, возраст и пол, кабинет */
function Facts({ row }: { row: StaffRow }) {
  const { ut, lang } = useLang();
  const year = birthYear(row.birthDate);
  const age = row.birthDate ? ageOf(row.birthDate) : year ? new Date().getFullYear() - year : null;
  const sex = row.sex === "male" ? ut("adm2.sexMale") : row.sex === "female" ? ut("adm2.sexFemale") : null;
  const place = workplaceOf(row);
  const facts: ReactNode[] = [];
  if (row.position || place) {
    facts.push(
      <span key="w" className="inline-flex items-center gap-1.5">
        <AIc.briefcase size={15} className="text-muted" />
        <span>
          {row.position ? `${row.position}${place ? ", " : ""}` : ""}
          {place ? <b className="font-bold text-text">{place}</b> : null}
        </span>
      </span>,
    );
  }
  if (age !== null || sex) {
    facts.push(
      <span key="a" className="inline-flex items-center gap-1.5">
        <Ic.user size={15} className="text-muted" />
        <span>
          {age !== null ? <b className="font-bold text-text">{plural(ut("adm2.nYears"), age, lang)}</b> : null}
          {age !== null && sex ? ", " : ""}
          {sex}
        </span>
      </span>,
    );
  }
  facts.push(
    <span key="l" className="inline-flex items-center gap-1.5">
      <AIc.at size={15} className="text-muted" />
      <span>{row.email}</span>
    </span>,
  );
  return <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-text-2">{facts}</span>;
}

function ageOf(birthDate: string): number | null {
  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age;
}

/**
 * Строка открытого по фахівцю: роль (с поповером ролей и исключений),
 * пациенты, вход и второй фактор, состояние записи. Каждая пилюля — со своим
 * действием: роль ведёт в права, пациенты — во вкладку.
 */
function OpenStrip({ row, me }: { row: StaffRow; me: boolean }) {
  const { ut, lang } = useLang();
  const navigate = useNavigate();
  const a = row.account;
  const role = mainRole(row);
  const now = Date.now();
  const state = accountState(a);
  const chips: ReactNode[] = [];
  if (row.role === "superadmin") {
    chips.push(<AlertChip key="role" icon={<AIc.shieldHalf />} label={ut("perm.superadminTitle")} detail={ut("adm2.allRights")} />);
  } else if (role) {
    const others = (a?.roles ?? []).filter((r) => r.code !== role.code).map((r) => r.title);
    const detail = [others.length ? fill(ut("adm2.andRoles"), { roles: others.join(", ") }) : null, a?.exceptions ? plural(ut("adm2.nExceptions"), a.exceptions, lang) : ut("adm2.noExceptions")]
      .filter(Boolean)
      .join(", ");
    chips.push(
      <AlertChip
        key="role"
        icon={<AIc.key />}
        label={role.title}
        detail={detail}
        onClick={me ? undefined : () => navigate(`/permissions?user=${row.id}`)}
        popTitle={ut("adm2.roles")}
        pop={
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {(a?.roles ?? []).map((r) => (
              <li key={r.code}>
                <b>{r.title}</b>
                {(ROLE_LADDER as readonly string[]).includes(r.code) ? ` — ${fill(ut("adm2.stepN"), { n: ROLE_LADDER.indexOf(r.code as never) + 1 })}` : r.code === "psychologist" ? ` — ${ut("adm2.builtin")}` : ""}
              </li>
            ))}
          </ul>
        }
      />,
    );
  }
  if (a && isDoctor(row)) {
    chips.push(
      <AlertChip
        key="pts"
        icon={<Ic.users />}
        label={fill(ut("adm2.leadsN"), { n: a.patients })}
        onClick={() => navigate(`/staff/${row.id}/patients`)}
      />,
    );
  }
  if (state === "disabled") {
    chips.push(<AlertChip key="st" icon={<Ic.ban />} label={ut("adm2.stateDisabled")} detail={a?.disabledAt ? dm(a.disabledAt) : undefined} />);
  } else if (state === "invited" || state === "temp") {
    chips.push(<AlertChip key="st" kind="warn" icon={<AIc.mail />} label={ut(state === "invited" ? "adm2.stateInvited" : "adm2.stateTemp")} pop={ut("adm2.tempPasswordPop")} />);
  }
  if (a?.lastSeenAt && isStale(a, now)) {
    chips.push(
      <AlertChip key="stale" kind="warn" icon={<Ic.timer />} label={fill(ut("adm2.daysNoLogin"), { n: daysAgo(a.lastSeenAt) })} detail={dm(a.lastSeenAt)} />,
    );
  } else if (a?.lastSeenAt) {
    chips.push(<AlertChip key="seen" icon={<AIc.logOut />} label={ut("adm2.seen")} detail={whenShort(a.lastSeenAt, ut)} />);
  }
  if (a && !a.disabledAt) {
    chips.push(
      a.mfa ? (
        <AlertChip key="mfa" kind="good" icon={<Ic.shieldCheck />} label={ut("adm2.mfaOn")} />
      ) : (
        <AlertChip key="mfa" kind="warn" icon={<AIc.shieldAlert />} label={ut("adm2.withoutMfa")} pop={ut("adm2.noMfaPop")} />
      ),
    );
  }
  if (!chips.length) return null;
  return (
    <div className="mt-2.5">
      <AlertStrip label={ut("adm2.openAboutStaff")}>{chips}</AlertStrip>
    </div>
  );
}

/* ─────────── профиль ─────────── */

export function StaffProfile() {
  const { row, me, edit } = useOutletContext<CardCtx>();
  const { user, can } = useAuth();
  /*
   * Карточку прав суперадмина сервер открывает только суперадмину — прочим
   * запрос заведомо вернулся бы отказом, и он не уходит (ladderReadable,
   * волна 12).
   */
  const readable = ladderReadable({ id: user?.id ?? "", isSuper: user?.role === "superadmin" }, row);
  const perms = useResource(
    () => (readable && row.role !== "superadmin" ? api.userPermissions(row.id).catch(() => null) : Promise.resolve(null)),
    [row.id, readable],
  );
  const catalogue = useResource(() => api.permissionCatalogue().catch(() => null), []);

  return (
    <div className="grid items-start gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <DataPanel row={row} onEdit={edit} />
        <ReceptionPanel row={row} me={me} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <AccessPanel row={row} perms={perms.data ?? null} catalogue={catalogue.data ?? null} loading={perms.loading} />
        <SecurityPanel row={row} me={me} />
        {can("audit.read") ? <ActivityPanel row={row} /> : null}
      </div>
    </div>
  );
}

function DataPanel({ row, onEdit }: { row: StaffRow; onEdit: (() => void) | null }) {
  const { ut } = useLang();
  const sex = row.sex === "male" ? ut("person.sex.male") : row.sex === "female" ? ut("person.sex.female") : null;
  const age = row.birthDate ? ageOf(row.birthDate) : null;
  const dash = <span className="text-muted">—</span>;
  const v = (x: ReactNode | null | undefined) => (x ? x : dash);
  const left: [ReactNode, ReactNode][] = [
    [ut("person.lastName"), v(row.lastName)],
    [ut("person.firstName"), v(row.firstName)],
    [ut("adm2.middleName"), v(row.middleName)],
    [ut("person.sex"), v(sex)],
    [ut("adm2.born"), row.birthDate ? `${dmy(row.birthDate)}${age !== null ? `, ${age} ${ut("ppl.yearShort")}` : ""}` : dash],
    [ut("adm2.since"), row.createdAt ? dmy(row.createdAt) : dash],
  ];
  const right: [ReactNode, ReactNode][] = [
    [ut("ppl.specialty"), v(row.specialty)],
    [ut("ppl.department"), v(workplaceOf(row))],
    [ut("mp.position"), v(row.position)],
    [ut("adm2.phone"), row.phone ? <b className="font-bold tabular-nums">{row.phone}</b> : dash],
    [ut("adm2.login"), row.email],
    [ut("ppl.organization"), v(row.unit)],
    [ut("adm2.seen"), row.account?.lastSeenAt ? whenShort(row.account.lastSeenAt, ut) : row.account ? ut("adm2.neverSeen") : dash],
  ];
  return (
    <Panel
      title={ut("adm2.data")}
      icon={<Ic.idCard />}
      actions={
        onEdit ? (
          <Button variant="ghost" size="xs" icon={<Ic.pen size={14} />} onClick={onEdit}>
            {ut("ppl.edit")}
          </Button>
        ) : null
      }
    >
      <div className="grid gap-x-8 gap-y-2 min-[900px]:grid-cols-2">
        <KV rows={left} w={118} />
        <KV rows={right} w={118} />
      </div>
      {row.phone ? (
        <p className="m-0 mt-3 flex items-center gap-1.5 text-caption text-muted">
          <Ic.eye size={13} />
          {ut("adm2.phoneLogged")}
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Профиль приёма: кабинет и длительность — из профиля в отделении (список
 * принимающих), неделя — из шаблона расписания. Шаблон чужого человека
 * сервер открывает тем, кто ведёт запись (appointments.manage); без права
 * запрос не уходит, и панель говорит, что неделя — в «Розкладі».
 */
function ReceptionPanel({ row, me }: { row: StaffRow; me: boolean }) {
  const { ut, lang } = useLang();
  const { can } = useAuth();
  const mayWeek = me ? can("schedule.own") : can("appointments.manage") && can("schedule.own");
  const week = useResource(() => (mayWeek ? api.schedule(me ? undefined : row.id).catch(() => null) : Promise.resolve(null)), [row.id, mayWeek]);
  const profiles = useResource(() => api.specialists().catch(() => null), []);
  const profile = profiles.data?.items.find((p) => p.userId === row.id) ?? null;
  const templates = week.data?.templates ?? [];
  if (!profile && !templates.length) {
    if (week.loading || profiles.loading) return null;
    return (
      <Panel title={ut("adm2.reception")} icon={<Ic.calendar />} sub={ut("adm2.receptionSub")}>
        <Empty compact title={ut("adm2.noReception")} />
      </Panel>
    );
  }
  const minutes = templates[0]?.slotMinutes;
  return (
    <Panel
      title={ut("adm2.reception")}
      icon={<Ic.calendar />}
      sub={ut("adm2.receptionSub")}
      actions={me ? <TextAction to="/schedule">{ut("adm2.change")}</TextAction> : null}
    >
      <div className="grid items-start gap-6 min-[1360px]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <KV
          w={120}
          rows={[
            [ut("adm2.room"), profile?.room ?? <span className="text-muted">—</span>],
            [ut("adm2.slot"), minutes ? fill(ut("adm2.minutes"), { n: minutes }) : <span className="text-muted">—</span>],
            [ut("adm2.newPatients"), profile ? ut("adm2.accepts") : ut("adm2.notAccepting")],
            [ut("adm2.workDays"), templates.length ? plural(ut("adm2.nDays"), new Set(templates.map((x) => x.weekday)).size, lang) : "—"],
          ]}
        />
        {templates.length ? <WeekHours templates={templates} /> : <p className="m-0 text-small text-muted">{ut("adm2.weekClosed")}</p>}
      </div>
    </Panel>
  );
}

/** Неделя приёма полосами: 08…21, сегодняшний день ярче */
function WeekHours({ templates }: { templates: { weekday: number; startsAt: string; endsAt: string }[] }) {
  const { ut } = useLang();
  const from = 8;
  const to = 21;
  const span = to - from;
  const toH = (s: string) => {
    const [h = "0", m = "0"] = s.split(":");
    return Number(h) + Number(m) / 60;
  };
  const today = ((new Date().getDay() + 6) % 7) + 1;
  const loc = locale();
  return (
    <div className="flex flex-col gap-1.5" role="list" aria-label={ut("adm2.week")}>
      {[1, 2, 3, 4, 5, 6, 7].map((d) => {
        const mine = templates.filter((x) => x.weekday === d);
        const label = new Date(2024, 0, d).toLocaleDateString(loc, { weekday: "short" });
        const on = d === today;
        return (
          <div key={d} role="listitem" className="grid grid-cols-[28px_minmax(0,1fr)_minmax(96px,auto)] items-center gap-2.5 text-small">
            <span className={cx("font-bold", on ? "text-violet-ink" : "text-text-2")}>{label}</span>
            <span className="relative h-2 rounded-[4px] bg-track">
              {mine.map((x) => (
                <b
                  key={`${x.startsAt}-${x.endsAt}`}
                  className={cx("absolute inset-y-0 rounded-[4px]", on ? "bg-violet" : "bg-violet-line")}
                  style={{ left: `${((toH(x.startsAt) - from) / span) * 100}%`, width: `${((toH(x.endsAt) - toH(x.startsAt)) / span) * 100}%` }}
                />
              ))}
            </span>
            <span className={cx("whitespace-nowrap text-right tabular-nums", on ? "font-bold text-text" : mine.length ? "text-text-2" : "text-muted")}>
              {mine.length ? mine.map((x) => `${x.startsAt}–${x.endsAt}`).join(", ") : ut("adm2.dayOff")}
            </span>
          </div>
        );
      })}
      <div className="grid grid-cols-[28px_minmax(0,1fr)_minmax(96px,auto)] gap-2.5 text-caption text-muted">
        <span />
        <span className="flex justify-between tabular-nums">
          <span>08</span>
          <span>12</span>
          <span>16</span>
          <span>21</span>
        </span>
        <span />
      </div>
    </div>
  );
}

type PermCard = Awaited<ReturnType<typeof api.userPermissions>>;
type Catalogue = Awaited<ReturnType<typeof api.permissionCatalogue>>;

/**
 * Доступ: роли и сколько прав действует сейчас — по группам справочника,
 * полосой «є з усіх». Подробности и правка — на экране прав.
 */
function AccessPanel({ row, perms, catalogue, loading }: { row: StaffRow; perms: PermCard | null; catalogue: Catalogue | null; loading: boolean }) {
  const { ut, lang } = useLang();
  const total = catalogue?.groups.reduce((n, g) => n + g.permissions.length, 0) ?? 0;
  const live = perms?.exceptions.filter((e) => !e.revokedAt && (!e.expiresAt || new Date(e.expiresAt) > new Date())) ?? [];
  const sup = row.role === "superadmin";
  return (
    <Panel
      title={ut("adm2.access")}
      icon={<AIc.shieldHalf />}
      actions={!sup ? <TextAction to={`/permissions?user=${row.id}`}>{ut("adm2.details")}</TextAction> : null}
    >
      {sup ? (
        <p className="m-0 text-small text-text-2">{ut("perm.superadminNote")}</p>
      ) : !perms ? (
        loading ? (
          <Loading rows={3} bare />
        ) : (
          <p className="m-0 text-small text-muted">{ut("adm2.accessClosed")}</p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {perms.roles.map((r) => (
              <Tag key={r.roleId} tone={r.isBuiltin ? "plain" : "primary"} icon={r.isBuiltin ? undefined : <AIc.key />}>
                {t(r.title, lang)}
              </Tag>
            ))}
          </div>
          <p className="m-0 mt-3 flex items-baseline gap-1.5">
            <b className="text-[26px] font-extrabold leading-none tabular-nums text-text">{perms.effective.length}</b>
            <span className="text-small text-text-2">{fill(ut("adm2.rightsOf"), { total })}</span>
          </p>
          {catalogue ? (
            <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0">
              {catalogue.groups.map((g) => {
                const have = g.permissions.filter((p) => perms.effective.includes(p.code)).length;
                return (
                  <li key={g.code} className="grid grid-cols-[minmax(0,1fr)_84px_38px] items-center gap-2.5 text-small">
                    <span className="truncate text-text-2">{t(g.title, lang)}</span>
                    <span className="h-1.5 overflow-hidden rounded-[3px] bg-track">
                      <b className="block h-full rounded-[3px] bg-violet" style={{ width: `${(have / Math.max(1, g.permissions.length)) * 100}%` }} />
                    </span>
                    <span className="text-right text-caption tabular-nums text-muted">
                      {fill(ut("adm2.nOf"), { n: have, total: g.permissions.length })}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="m-0 mt-3 flex items-center gap-1.5 text-small text-muted">
            <AIc.key size={14} />
            {live.length ? plural(ut("adm2.nPersonalExceptions"), live.length, lang) : ut("adm2.noPersonalExceptions")}
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * Безпека входу: второй фактор, временный пароль, Google, живые сессии —
 * и два действия техпанели (users.manage): сбросить пароль, оборвать сессии.
 * Своя карточка ведёт в «Обліковий запис»: там пароль меняют с повторным
 * входом, а не здесь.
 */
function SecurityPanel({ row, me }: { row: StaffRow; me: boolean }) {
  const { ut } = useLang();
  const { can } = useAuth();
  const canManage = can("users.manage");
  const mfa = useResource(() => (me ? api.mfaStatus() : Promise.resolve(null)), [me]);
  const sessions = useResource(
    () => (!me && canManage ? api.opsSessions({ userId: row.id, per: "10" }).catch(() => null) : Promise.resolve(null)),
    [row.id, me, canManage],
  );
  const [dialog, setDialog] = useState<null | "reset" | "revoke">(null);
  const a = row.account;
  const mfaOn = me ? mfa.data?.enabled : a?.mfa;
  const items: { icon: ReactNode; tone?: "good" | "warn"; title: ReactNode; sub?: ReactNode; right?: ReactNode }[] = [];
  if (mfaOn !== undefined && mfaOn !== null) {
    items.push(
      mfaOn
        ? {
            icon: <AIc.smartphone size={15} />,
            tone: "good",
            title: ut("adm2.mfaOn"),
            sub: me && mfa.data ? fill(ut("adm2.codesLeft"), { n: mfa.data.recoveryLeft }) : ut("adm2.authenticator"),
          }
        : { icon: <AIc.shieldAlert size={15} />, tone: "warn", title: ut("adm2.mfaOff"), sub: ut("adm2.noMfaPop") },
    );
  }
  if (a?.mustChangePassword) {
    items.push({ icon: <AIc.key size={15} />, tone: "warn", title: ut("adm2.stateTemp"), sub: ut("adm2.tempPasswordPop") });
  }
  if (row.googleLinked !== undefined) {
    items.push({ icon: <AIc.globe size={15} />, title: row.googleLinked ? ut("adm2.googleOn") : ut("adm2.googleOff") });
  }
  const live = sessions.data?.items ?? [];
  return (
    <Panel
      title={ut("adm2.security")}
      icon={<Ic.lock />}
      actions={me ? <TextAction to="/account">{ut("acct.title")}</TextAction> : null}
    >
      <ul className="m-0 flex list-none flex-col p-0">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2.5 border-b border-divider py-2 last:border-0">
            <span
              className={cx(
                "inline-grid size-7 shrink-0 place-items-center rounded-[9px]",
                it.tone === "good" ? "bg-good-tint text-good" : it.tone === "warn" ? "bg-warn-tint text-warn" : "bg-sunk text-muted",
              )}
            >
              {it.icon}
            </span>
            <span className="min-w-0 flex-1 text-small leading-[18px]">
              <b className="block font-bold text-text">{it.title}</b>
              {it.sub ? <span className="text-text-2">{it.sub}</span> : null}
            </span>
            {it.right}
          </li>
        ))}
      </ul>
      {!me && canManage && sessions.data ? (
        <>
          <p className="m-0 mt-3 text-caption font-bold text-muted">{fill(ut("adm2.liveSessions"), { n: sessions.data.total })}</p>
          <ul className="m-0 mt-1 flex list-none flex-col p-0">
            {live.map((s) => (
              <li key={s.id} className="flex items-center gap-2.5 border-b border-divider py-2 text-small last:border-0">
                <AIc.monitor size={15} className="text-muted" />
                <span className="min-w-0 flex-1 text-text-2">{fill(ut("adm2.sessionSince"), { at: whenShort(s.startedAt, ut) })}</span>
                <span className="whitespace-nowrap tabular-nums text-muted">{whenShort(s.lastUsedAt, ut)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {!me && canManage ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="xs" icon={<AIc.rotate size={14} />} onClick={() => setDialog("reset")}>
            {ut("adm2.resetPassword")}
          </Button>
          <Button size="xs" icon={<AIc.logOut size={14} />} onClick={() => setDialog("revoke")} disabled={sessions.data?.total === 0}>
            {ut("adm2.revokeSessionsShort")}
          </Button>
        </div>
      ) : null}
      {dialog ? <AccountDialog kind={dialog} row={row} onClose={() => setDialog(null)} onDone={sessions.reload} /> : null}
    </Panel>
  );
}

/**
 * Окна действий над чужой учётной записью — те же маршруты техпанели
 * (/api/ops/users/:id/*, право users.manage), и правило «не себе, только
 * ниже своего положения» держит сервер (lib/accountClass.ts). Окно, а не
 * ящик: шаг обрывает чужие сессии и прерывает работу намеренно.
 */
function AccountDialog({
  kind,
  row,
  onClose,
  onDone,
}: {
  kind: "reset" | "revoke" | "disable" | "enable";
  row: StaffRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState<string | null>(null);
  const name = shortName(row.fullName || row.email);

  if (password) {
    /* временный пароль — один раз: окно не закрывается подложкой, пока его не переписали */
    return (
      <Modal
        title={ut("adm2.tempPasswordTitle")}
        sub={name}
        icon={<AIc.key />}
        secret
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            {ut("adm2.done")}
          </Button>
        }
      >
        <p className="m-0 text-small text-text-2">{ut("adm2.tempPasswordHint")}</p>
        <output className="mt-3 block rounded-control bg-sunk px-3.5 py-3 font-mono text-[18px] font-bold tracking-[0.04em] text-text select-all">
          {password}
        </output>
      </Modal>
    );
  }

  const spec = {
    reset: { title: ut("adm2.resetPassword"), body: ut("adm2.resetHint"), act: ut("adm2.resetPassword"), icon: <AIc.rotate /> },
    revoke: { title: ut("adm2.revokeSessions"), body: ut("adm2.revokeHint"), act: ut("adm2.revokeSessionsShort"), icon: <AIc.logOut /> },
    disable: { title: ut("adm2.disableAccount"), body: ut("adm2.disableHint"), act: ut("adm2.disableAccount"), icon: <AIc.userX /> },
    enable: { title: ut("adm2.enableAccount"), body: ut("adm2.enableHint"), act: ut("adm2.enableAccount"), icon: <AIc.userCheck /> },
  }[kind];

  const submit = () =>
    void run(async () => {
      if (kind === "reset") {
        const r = await api.resetUserPassword(row.id);
        setPassword(r.password);
        onDone();
        return;
      }
      if (kind === "revoke") await api.revokeUserSessions(row.id);
      if (kind === "disable") await api.disableUser(row.id, reason.trim());
      if (kind === "enable") await api.enableUser(row.id);
      onDone();
      onClose();
    }, kind === "reset" ? undefined : ut("adm2.doneToast"));

  return (
    <Modal
      title={spec.title}
      sub={name}
      icon={spec.icon}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" disabled={busy || (kind === "disable" && reason.trim().length < 3)} onClick={submit}>
            {spec.act}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-small text-text-2">{spec.body}</p>
      {kind === "disable" ? (
        <div className="mt-3">
          <Field label={ut("adm2.reason")} hint={ut("adm2.reasonLogged")}>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

/** Остання активність: последние записи журнала, где человек — действующее лицо */
function ActivityPanel({ row }: { row: StaffRow }) {
  const { ut } = useLang();
  const log = useResource(() => api.auditPage({ actor: row.id, limit: "6" }), [row.id]);
  return (
    <Panel title={ut("adm2.lastActivity")} icon={<Ic.history />} flush actions={<TextAction to={`/ops/audit?actor=${row.id}`}>{ut("adm2.journal")}</TextAction>}>
      {log.error ? (
        <div className="px-4 pb-4">
          <Loading bare error={log.error} onRetry={log.reload} />
        </div>
      ) : !log.data ? (
        <div className="px-4 pb-4">
          <Loading rows={3} bare />
        </div>
      ) : log.data.entries.length ? (
        <ActivityList events={log.data.entries.map((e) => activityEvent(e, ut))} />
      ) : (
        <div className="px-4 pb-4">
          <Empty compact title={ut("adm2.noActivity")} />
        </div>
      )}
    </Panel>
  );
}

function activityEvent(e: AuditEntry, ut: (k: UiKey) => string) {
  return {
    date: dm(e.at),
    time: hm(e.at),
    icon: e.action.startsWith("auth.") ? <AIc.logOut /> : e.action.startsWith("permission.") ? <AIc.key /> : <Ic.clipboard />,
    tone: e.outcome === "denied" ? ("warn" as const) : undefined,
    text: actionLabel(e.action, ut),
  };
}

/* ─────────── правка своей анкеты ─────────── */

/**
 * Правка своей анкеты — в ящике: то, что принимает PATCH /api/auth/me (ФИО,
 * пол, дата рождения, специальность, подразделение). Почту, телефон и роль
 * сервер здесь не меняет — их в форме нет, а не погашенными: их меняет
 * администратор, и это сказано строкой под формой.
 */
function ProfileDrawer({
  row,
  open,
  onClose,
  onReturn,
  onDone,
}: {
  row: StaffRow;
  open: boolean;
  onClose: () => void;
  onReturn: () => void;
  onDone: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [firstName, setFirstName] = useState(row.firstName);
  const [lastName, setLastName] = useState(row.lastName);
  const [middleName, setMiddleName] = useState(row.middleName ?? "");
  const [sex, setSex] = useState<Sex | "">(row.sex ?? "");
  const [specialty, setSpecialty] = useState(row.specialty ?? "");
  const [unit, setUnit] = useState(row.unit ?? "");
  const [birthDate, setBirthDate] = useState(row.birthDate ?? "");
  const dirty =
    firstName !== row.firstName ||
    lastName !== row.lastName ||
    middleName !== (row.middleName ?? "") ||
    sex !== (row.sex ?? "") ||
    specialty !== (row.specialty ?? "") ||
    unit !== (row.unit ?? "") ||
    birthDate !== (row.birthDate ?? "");

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      title={ut("adm2.editData")}
      sub={row.fullName}
      icon={<Ic.pen />}
      dirty={dirty}
      draftName={ut("adm2.draftData")}
      kbd="E"
      footer={
        <>
          <Button
            variant="primary"
            icon={<Ic.check size={15} />}
            disabled={busy || !firstName.trim() || !lastName.trim()}
            onClick={() =>
              void run(async () => {
                await api.updateMe({
                  firstName: firstName.trim(),
                  lastName: lastName.trim(),
                  middleName: middleName.trim() || null,
                  sex: sex || null,
                  specialty: specialty.trim() || null,
                  unit: unit.trim() || null,
                  birthDate: birthDate || null,
                });
                onDone();
              }, ut("acct.saved"))
            }
          >
            {ut("common.save")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <DrawerSection title={ut("adm2.data")}>
        <div className="grid gap-x-3 min-[520px]:grid-cols-2">
          <Field label={ut("person.lastName")}>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} required data-autofocus />
          </Field>
          <Field label={ut("person.firstName")}>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={80} required />
          </Field>
          <Field label={ut("adm2.middleName")} optional>
            <Input value={middleName} onChange={(e) => setMiddleName(e.target.value)} maxLength={80} />
          </Field>
          <Field label={ut("person.sex")}>
            <Select value={sex} onChange={(e) => setSex(e.target.value as Sex | "")}>
              <option value="">{ut("ppl.unset")}</option>
              <option value="male">{ut("person.sex.male")}</option>
              <option value="female">{ut("person.sex.female")}</option>
            </Select>
          </Field>
          <Field label={ut("person.birthDate")} optional>
            <Input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          </Field>
          <Field label={ut("ppl.organization")} optional>
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={160} />
          </Field>
        </div>
        <Field label={ut("ppl.specialty")} optional>
          <Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} maxLength={160} />
        </Field>
        <p className="m-0 text-caption text-muted">{ut("adm2.adminChanges")}</p>
      </DrawerSection>
    </Drawer>
  );
}

/* ─────────── пациенты ─────────── */

/**
 * Пациенты фахівця: кого он ведёт (закрепление ведущим), в пределах зоны
 * смотрящего — GET /api/patients?lead=. Только имя, возраст и когда был
 * последний замер: ответов на методики и записей приёма администратор здесь
 * не видит.
 *
 * Пациентов отдаёт маршрут под правом patients.read, и без права запрос
 * заведомо кончился бы отказом — а отказ в праве сервер пишет в журнал как
 * access.denied. Право проверяется до запроса, и вместо списка стоит
 * объяснение.
 */
export function StaffPatients() {
  const { ut } = useLang();
  const { can } = useAuth();
  if (can("patients.read")) return <LedPatients />;
  return (
    <Panel>
      <Empty compact title={ut("ppl.noPatientsRight")} />
    </Panel>
  );
}

type PatientView = "all" | "risk" | "noshow" | "stale" | "never" | "record";

/**
 * Что сейчас главное про человека — одно слово для колонки «Стан», вида и
 * порядка «увага спершу». Красным — только случай ризику; неявка, давний
 * замір и прострочений огляд — янтарём; остальное спокойно.
 */
export function patientState(p: PatientListItem, now: number): "risk" | "noshow" | "stale" | "record" | "never" | "ok" {
  if (p.risk) return "risk";
  if (p.lastNoShowAt) return "noshow";
  if (p.lastResponseAt && now - new Date(p.lastResponseAt).getTime() >= STALE_DAYS * 86_400_000) return "stale";
  if (p.dispensary?.overdue) return "record";
  if (!p.lastResponseAt) return "never";
  return "ok";
}

const STATE_RANK = { risk: 0, noshow: 1, stale: 2, record: 3, never: 4, ok: 5 } as const;

function LedPatients() {
  const { row, reload } = useOutletContext<CardCtx>();
  const { ut, lang } = useLang();
  const { can } = useAuth();
  const canTransfer = can("users.manage");
  const page = useResource(() => api.patientsLedBy(row.id), [row.id]);
  const [q, setQ] = useState("");
  const [view, setView] = useState<PatientView>("all");
  const [sort, setSort] = useState("attention");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [transfer, setTransfer] = useState(false);
  const [now] = useState(() => Date.now());
  const items = page.data?.items ?? [];
  const stateOf = (p: PatientListItem) => patientState(p, now);
  const inPatientView = (p: PatientListItem, v: PatientView) => {
    if (v === "all") return true;
    const s = stateOf(p);
    if (v === "record") return !!p.dispensary;
    return s === v;
  };
  const views: PatientView[] = ["all", "risk", "noshow", "stale", "never", "record"];
  const counts = Object.fromEntries(views.map((v) => [v, items.filter((p) => inPatientView(p, v)).length])) as Record<PatientView, number>;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = items.filter((p) => (!needle || `${p.name} ${p.email}`.toLowerCase().includes(needle)) && inPatientView(p, view));
    const at = (p: PatientListItem) => (p.lastResponseAt ? new Date(p.lastResponseAt).getTime() : 0);
    if (sort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name, "uk"));
    if (sort === "recent") return [...list].sort((a, b) => at(b) - at(a));
    /* увага спершу: випадок ризику, неявка, давній замір, прострочений огляд, ще не проходили — потім решта */
    return [...list].sort((a, b) => STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)] || at(a) - at(b) || a.name.localeCompare(b.name, "uk"));
  }, [items, q, view, sort, now]);
  useHotkeys({ t: () => picked.size && setTransfer(true) }, canTransfer && !transfer);
  /*
   * Отметка — только у тех, кто в списке есть: после перечитывания (передача,
   * 409 «уже ведёт другой») ушедший к другому лікарю из неё выпадает, и
   * полоса отметки не считает людей, которых на экране нет.
   */
  useEffect(() => {
    if (!page.data) return;
    const present = new Set(page.data.items.map((p) => p.id));
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [page.data]);

  const columns: Column<PatientListItem>[] = [
    {
      key: "name",
      header: ut("adm2.colPatient"),
      required: true,
      sort: (p) => p.name,
      render: (p) => (
        <PersonCell
          name={p.name}
          sub={[
            p.birthYear ? plural(ut("adm2.nYears"), new Date().getFullYear() - p.birthYear, lang) : null,
            p.sex === "male" ? ut("adm2.sexMaleShort") : p.sex === "female" ? ut("adm2.sexFemaleShort") : null,
            p.unit,
          ]
            .filter(Boolean)
            .join(", ")}
          avatar={<Avatar name={p.name} size={30} tone="soft" />}
          to={`/patients/${p.id}`}
        />
      ),
    },
    {
      key: "state",
      header: ut("adm2.colState"),
      required: true,
      sort: (p) => STATE_RANK[stateOf(p)],
      render: (p) => <PatientStateCell p={p} now={now} />,
    },
    {
      key: "measure",
      header: ut("adm2.colLastMeasure"),
      required: true,
      render: (p) => {
        const m = p.measure;
        if (!m) return <span className="text-small text-muted">—</span>;
        const v = shownValue(m.values.at(-1) ?? 0, m.normalization);
        return (
          <span className="flex min-w-0 flex-col gap-0.5" title={m.title}>
            <span className="inline-flex items-center gap-2">
              <b className="text-[15px] font-extrabold tabular-nums text-text">
                {v.text}
                {v.unit ? <small className="ml-0.5 text-caption font-bold text-muted">{v.unit}</small> : null}
              </b>
              {m.severity || m.bandLabel ? (
                <SeverityTag level={kitSeverity(m.severity)} small>
                  {m.bandLabel ?? ut(severityKey[m.severity ?? "none"])}
                </SeverityTag>
              ) : null}
            </span>
            {m.better ? (
              <CourseDigits code={shortCode(m.code)} values={shownSeries(m.values, m.normalization)} better={m.better} />
            ) : (
              <span className="text-caption text-text-2">
                <b className="mr-1 text-[11px] font-bold text-muted">{shortCode(m.code)}</b>
                {shownSeries(m.values, m.normalization).join(" → ")}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "last",
      header: ut("adm2.colMeasureDate"),
      required: true,
      sort: (p) => p.lastResponseAt ?? null,
      render: (p) =>
        p.lastResponseAt ? (
          <span className="flex flex-col leading-[17px]">
            <span className={cx("tabular-nums", stateOf(p) === "stale" ? "font-bold text-warn" : "text-text")}>{dm(p.lastResponseAt)}</span>
            {stateOf(p) === "stale" ? (
              <small className="text-caption font-bold text-warn">{fill(ut("adm2.daysAgo"), { n: daysAgo(p.lastResponseAt) })}</small>
            ) : null}
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: "next",
      header: ut("adm2.colNextVisit"),
      required: true,
      sort: (p) => p.nextVisit?.at ?? null,
      render: (p) =>
        p.nextVisit ? (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums text-text">
            {visitWhen(p.nextVisit.at)}
            {p.nextVisit.mode === "remote" ? <Tag tone="info">{ut("adm2.remote")}</Tag> : null}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-small font-semibold text-warn">
            <Ic.calendar size={13} />
            {ut("adm2.notBooked")}
          </span>
        ),
    },
  ];

  const viewLabel: Record<PatientView, string> = {
    all: ut("adm2.viewAll"),
    risk: ut("adm2.viewRisk"),
    noshow: ut("adm2.viewNoShow"),
    stale: ut("adm2.viewNoMeasure"),
    never: ut("adm2.viewNotYet"),
    record: ut("adm2.viewRecord"),
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel flush>
        <div className="px-4 pb-2.5 pt-3.5">
          <FilterBar
            search={{ value: q, onChange: setQ, placeholder: ut("adm2.searchPatient"), width: 260 }}
            sort={{
              value: sort,
              onChange: setSort,
              options: [
                { key: "attention", label: ut("adm2.sortAttention") },
                { key: "name", label: ut("adm2.sortName") },
                { key: "recent", label: ut("adm2.sortRecent") },
              ],
            }}
          />
        </div>
        <div className="flex flex-wrap gap-x-[5px] gap-y-1.5 px-4 pb-3" role="group" aria-label={ut("kit.savedViews")}>
          {views
            .filter((v) => v === "all" || v === view || counts[v] > 0)
            .map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={v === view}
                onClick={() => setView(v)}
                className={cx(
                  "inline-flex h-8 min-h-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-2xl border-0 px-2.5 text-small leading-none",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                  v === view ? "bg-violet font-bold text-onfill" : "bg-sunk font-semibold text-text-2 hover:bg-sunk-2 hover:text-text",
                )}
              >
                {viewLabel[v]}
                <span
                  className={cx(
                    "font-bold tabular-nums",
                    v === view ? "text-onfill-muted" : v === "risk" ? "text-risk-ink" : "text-muted",
                  )}
                >
                  {counts[v]}
                </span>
              </button>
            ))}
        </div>
        {page.error ? (
          <div className="px-4 pb-4">
            <Loading error={page.error} onRetry={page.reload} bare />
          </div>
        ) : !page.data ? (
          <div className="px-4 pb-4">
            <Loading rows={6} bare />
          </div>
        ) : (
          <DataTable
            rows={shown}
            columns={columns}
            rowKey={(p) => p.id}
            label={ut("top.patients")}
            selectable={canTransfer}
            selected={picked}
            onSelectedChange={setPicked}
            rowTone={(p) => (p.risk ? "risk" : undefined)}
            bulkActions={(rows) => (
              <Button variant="primary" size="xs" icon={<AIc.transfer size={14} />} onClick={() => rows.length && setTransfer(true)}>
                {ut("adm2.transferTo")}
              </Button>
            )}
            pageSize={25}
            hotkeys
            empty={
              <div className="px-4 pb-6">
                <Empty compact title={items.length ? ut("pt.nobodyFound") : ut("adm2.leadsNobody")} />
              </div>
            }
          />
        )}
        <KbdHints
          bar
          keys={[
            ["J K", ut("adm2.keyRows")],
            ["/", ut("adm2.keySearch")],
            ...(canTransfer ? ([["T", ut("adm2.keyTransfer")]] as [string, string][]) : []),
          ]}
        />
      </Panel>
      {/* сервер отдаёт не больше 200 строк за раз: если людей больше — сказать прямо, а не притворяться полным списком */}
      {page.data && page.data.total > items.length ? (
        <Callout kind="warn">{fill(ut("adm2.partialPatients"), { n: items.length, total: page.data.total })}</Callout>
      ) : null}
      <Callout kind="info">{ut("adm2.transferNote")}</Callout>
      {transfer ? (
        <TransferModal
          from={row}
          patients={items.filter((p) => picked.has(p.id))}
          total={items.length}
          onClose={() => setTransfer(false)}
          onDone={() => {
            setTransfer(false);
            setPicked(new Set());
            page.reload();
            /* числа в полосе и во вкладке — из справочника: перечитать его, а не показывать прежнюю нагрузку */
            forgetDirectory();
            reload();
          }}
          onStale={() => {
            /* окно остаётся: в нём — те из отмеченных, кого этот лікар ещё ведёт */
            page.reload();
            forgetDirectory();
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** «ср 14.10, 09:00» — ближайший прием: день недели помогает больше даты */
function visitWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(locale(), { weekday: "short" })} ${dm(iso)}, ${hm(iso)}`;
}

/** Колонка «Стан» пациента: одно главное, с пояснением строкой ниже */
function PatientStateCell({ p, now }: { p: PatientListItem; now: number }) {
  const { ut, lang } = useLang();
  const s = patientState(p, now);
  if (s === "risk" && p.risk) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Tag tone={p.risk.assigneeName ? "handover" : "danger"} icon={<Ic.alert />}>
          {plural(ut("adm2.nRiskCases"), p.risk.cases, lang)}
        </Tag>
        <small className="text-caption text-text-2">{fill(ut("adm2.caseSince"), { date: `${dm(p.risk.openedAt)}, ${hm(p.risk.openedAt)}` })}</small>
      </span>
    );
  }
  if (s === "noshow" && p.lastNoShowAt) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Tag tone="attention" icon={<Ic.calendar />}>
          {fill(ut("adm2.noShowOn"), { date: dm(p.lastNoShowAt) })}
        </Tag>
        {!p.nextVisit ? <small className="text-caption text-text-2">{ut("adm2.notBooked")}</small> : null}
      </span>
    );
  }
  if (s === "stale" && p.lastResponseAt) {
    return (
      <Tag tone="attention" icon={<Ic.timer />}>
        {fill(ut("adm2.noMeasureDays"), { n: daysAgo(p.lastResponseAt) })}
      </Tag>
    );
  }
  if (p.dispensary) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Tag tone={p.dispensary.overdue ? "attention" : "plain"} icon={p.dispensary.overdue ? <Ic.timer /> : <Ic.eye />}>
          {p.dispensary.overdue ? ut("adm2.checkOverdue") : ut("adm2.onRecord")}
        </Tag>
        <small className="truncate text-caption text-text-2">{p.dispensary.groupLabel}</small>
      </span>
    );
  }
  if (s === "never") return <Tag icon={<Ic.clipboard />}>{ut("adm2.notYetMeasured")}</Tag>;
  return (
    <Tag tone="done" icon={<Ic.check />}>
      {ut("adm2.measuring")}
    </Tag>
  );
}

/**
 * Передача пациентов другому лікарю: кого, кому (сначала то же відділення,
 * потом по нагрузке), что переходит и причина в журнал. Окно, а не ящик:
 * шаг меняет того, кто ведёт людей, и должен прервать работу.
 */
function TransferModal({
  from,
  patients,
  total,
  onClose,
  onDone,
  onStale,
}: {
  from: StaffRow;
  patients: PatientListItem[];
  total: number;
  onClose: () => void;
  onDone: () => void;
  /** 409: кого-то из отмеченных уже ведёт другой — список перечитывается */
  onStale: () => void;
}) {
  const { ut, lang } = useLang();
  const { user, can } = useAuth();
  const toast = useToast();
  const { run, busy } = useAction();
  const [to, setTo] = useState<string>("");
  const [q, setQ] = useState("");
  const [reason, setReason] = useState("");
  const dir = useResource(() => loadDirectory({ id: user?.id ?? "", canManageUsers: can("users.manage") }), [user?.id]);
  const place = workplaceOf(from);
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (dir.data?.rows ?? [])
      .filter((r) => isDoctor(r) && r.id !== from.id && !r.account?.disabledAt)
      .filter((r) => !needle || `${r.fullName} ${workplaceOf(r) ?? ""}`.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(workplaceOf(b) === place) - Number(workplaceOf(a) === place) ||
          (a.account?.patients ?? 0) - (b.account?.patients ?? 0) ||
          a.fullName.localeCompare(b.fullName, "uk"),
      );
  }, [dir.data, q, from.id, place]);
  const target = candidates.find((c) => c.id === to) ?? null;
  const n = patients.length;

  return (
    <Modal
      title={ut("adm2.transferTo")}
      sub={fill(ut("adm2.transferSub"), { from: shortName(from.fullName) })}
      icon={<AIc.transfer />}
      width={600}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            icon={<AIc.transfer size={15} />}
            disabled={busy || !target || reason.trim().length < 10 || !n}
            onClick={() =>
              void run(async () => {
                try {
                  const r = await api.transferPatients(from.id, { patientIds: patients.map((p) => p.id), to: target!.id, reason: reason.trim() });
                  toast(fill(ut("adm2.transferred"), { n: plural(ut("adm2.nPatients"), r.moved, lang), to: shortName(target!.fullName) }), "ok");
                  onDone();
                } catch (e) {
                  /* «оновіть список» — экран перечитывает его сам; отказ словами сервера показывает run */
                  if (e instanceof ApiError && e.status === 409) onStale();
                  throw e;
                }
              })
            }
          >
            {fill(ut("adm2.transferN"), { n: plural(ut("adm2.nPatientsAcc"), n, lang) })}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <span className="ml-auto text-caption text-muted max-[640px]:hidden">{ut("adm2.authorsStay")}</span>
        </>
      }
    >
      <section className="border-b border-divider pb-3.5">
        <h3 className="m-0 flex items-baseline gap-2 text-h3 font-extrabold text-text">
          {ut("top.patients")}
          <span className="text-small font-medium text-muted">{fill(ut("adm2.pickedOf"), { n, total })}</span>
        </h3>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {patients.map((p) => (
            <span key={p.id} className="inline-flex h-8 items-center gap-1.5 rounded-pill bg-sunk pl-1 pr-3 text-small font-bold text-text">
              <Avatar name={p.name} size={24} tone="soft" />
              {shortName(p.name)}
            </span>
          ))}
        </div>
      </section>
      <section className="border-b border-divider py-3.5">
        <h3 className="m-0 flex items-baseline gap-2 text-h3 font-extrabold text-text">
          {ut("adm2.newDoctor")}
          <span className="text-small font-medium text-muted">{ut("adm2.newDoctorSub")}</span>
        </h3>
        <label className="mt-2.5 flex h-10 items-center gap-2 rounded-[12px] bg-sunk px-3 text-muted">
          <Ic.search size={15} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={ut("adm2.searchDoctor")}
            aria-label={ut("adm2.searchDoctor")}
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-body text-text outline-none placeholder:text-muted"
          />
        </label>
        <div role="radiogroup" aria-label={ut("adm2.newDoctor")} className="mt-2 flex max-h-[260px] flex-col gap-1.5 overflow-y-auto">
          {!dir.data ? (
            <Loading rows={3} bare error={dir.error} onRetry={dir.reload} />
          ) : candidates.length ? (
            candidates.map((c) => {
              const on = c.id === to;
              const now = c.account?.patients ?? 0;
              return (
                <label
                  key={c.id}
                  className={cx(
                    "m-0 grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-3 py-2",
                    on ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-sunk hover:bg-sunk-2",
                  )}
                >
                  <input type="radio" className="kit-radio" name="transfer-to" value={c.id} checked={on} onChange={() => setTo(c.id)} />
                  <Avatar name={c.fullName} size={30} tone={on ? "violet" : "soft"} />
                  <span className="min-w-0">
                    <b className={cx("block truncate text-[13px] font-extrabold", on ? "text-violet-ink" : "text-text")}>{c.fullName}</b>
                    <small className="block truncate text-caption text-muted">{[workplaceOf(c), c.position].filter(Boolean).join("; ")}</small>
                  </span>
                  <span className="whitespace-nowrap text-small tabular-nums text-text-2">
                    <b className="font-extrabold text-text">{now}</b> → <b className="font-extrabold text-text">{now + n}</b>
                  </span>
                </label>
              );
            })
          ) : (
            <Empty compact title={ut("pt.nobodyFound")} />
          )}
        </div>
        <p className="m-0 mt-1.5 text-caption text-muted">{ut("adm2.loadAfter")}</p>
      </section>
      <section className="pt-3.5">
        <h3 className="m-0 text-h3 font-extrabold text-text">{ut("adm2.whatMoves")}</h3>
        <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0 text-small">
          <li className="flex items-start gap-2">
            <Ic.check size={15} className="mt-px text-good" />
            <span>{ut("adm2.movesLead")}</span>
          </li>
          <li className="flex items-start gap-2">
            <Ic.check size={15} className="mt-px text-good" />
            <span>{ut("adm2.movesMessages")}</span>
          </li>
          <li className="flex items-start gap-2">
            <Ic.minus size={15} className="mt-px text-muted" />
            <span className="text-text-2">{ut("adm2.staysAuthors")}</span>
          </li>
        </ul>
        <div className="mt-3">
          <Field label={ut("adm2.reason")} hint={ut("adm2.reasonLogged")}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={ut("adm2.reasonExample")} />
          </Field>
        </div>
      </section>
    </Modal>
  );
}

/* ─────────── группы ─────────── */

/**
 * Группы пациентов, которые ведёт фахівець. Данные — GET /api/patient-groups
 * с отбором по владельцу (ownGroups): сервер отдаёт суперадмину все группы,
 * остальным только свои. «Нова група» — только в своей карточке: владельцем
 * группы становится тот, кто её заводит, и завести её другому нельзя.
 */
export function StaffGroups() {
  const { me, isSuper, groups, groupsError, reloadGroups, canPatients } = useOutletContext<CardCtx>();
  const { ut, lang } = useLang();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const all = groups;
  const shown = useMemo(
    () => (all ? all.filter((g) => !q.trim() || `${g.title} ${g.description ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) : null),
    [all, q],
  );
  const [open, setOpen] = useState<string | null>(null);

  const columns: Column<PatientGroupWithCounts>[] = [
    {
      key: "title",
      header: ut("adm2.colGroup"),
      required: true,
      sort: (g) => g.title,
      render: (g) => (
        <span className="flex items-center gap-2.5">
          {g.description ? (
          <button
            type="button"
            aria-expanded={open === g.id}
            aria-label={ut("adm2.groupDetails")}
            onClick={() => setOpen(open === g.id ? null : g.id)}
            className={cx(
              "inline-grid size-8 min-h-0 shrink-0 cursor-pointer place-items-center rounded-[9px] border-0 text-muted",
              open === g.id ? "bg-violet-tint text-violet-ink" : "bg-transparent hover:bg-sunk",
            )}
          >
            {open === g.id ? <Ic.chevronDown size={15} /> : <Ic.chevronRight size={15} />}
          </button>
          ) : (
            <span aria-hidden className="size-8 shrink-0" />
          )}
          <span className="flex min-w-0 flex-col">
            <Link to={`/patient-groups/${g.id}`} className="truncate font-bold text-text no-underline hover:underline">
              {g.title}
            </Link>
            {open === g.id && g.description ? <small className="mt-0.5 whitespace-normal text-caption text-text-2">{g.description}</small> : null}
          </span>
        </span>
      ),
    },
    {
      key: "members",
      header: ut("adm2.colMembers"),
      num: true,
      required: true,
      sort: (g) => g.memberCount,
      render: (g) => <b className="font-extrabold tabular-nums text-text">{g.memberCount}</b>,
    },
    {
      key: "surveys",
      header: ut("adm2.colSurveys"),
      num: true,
      required: true,
      sort: (g) => g.surveyCount,
      render: (g) => <span className="tabular-nums text-text-2">{g.surveyCount}</span>,
    },
    {
      key: "created",
      header: ut("adm2.colCreated"),
      required: true,
      sort: (g) => g.createdAt,
      render: (g) => <span className="tabular-nums text-text-2">{dmy(g.createdAt)}</span>,
    },
  ];

  return (
    <Panel
      title={ut("top.groups")}
      icon={<Ic.layers />}
      count={all ? all.length : null}
      flush
      actions={
        <>
          <label className="flex h-9 w-[220px] items-center gap-2 rounded-[12px] bg-sunk px-3 text-muted max-[700px]:w-[150px]">
            <Ic.search size={15} />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={ut("ppl.searchGroups")}
              aria-label={ut("ppl.searchGroups")}
              className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-small text-text outline-none placeholder:text-muted"
            />
          </label>
          {me ? (
            <Button variant="primary" size="xs" icon={<Ic.plus size={14} />} onClick={() => navigate("/patient-groups")}>
              {ut("adm.newGroup")}
            </Button>
          ) : null}
        </>
      }
      footer={
        <span className="flex items-center gap-1.5 text-caption text-muted">
          <Ic.info size={13} />
          {me ? ut("adm2.groupsOwnNote") : ut("adm2.groupsOtherNote")}
        </span>
      }
    >
      {!canPatients ? (
        <div className="px-4 pb-4">
          <Empty compact title={ut("ppl.noPatientsRight")} />
        </div>
      ) : !shown ? (
        <div className="px-4 pb-4">
          <Loading rows={4} bare error={groupsError} onRetry={reloadGroups} />
        </div>
      ) : (
        <DataTable
          rows={shown}
          columns={columns}
          rowKey={(g) => g.id}
          label={ut("top.groups")}
          empty={
            <div className="px-4 pb-6">
              <Empty compact title={!me && !isSuper ? ut("ppl.groupsOthersHint") : ut("ppl.noGroups")} />
            </div>
          }
        />
      )}
      <span className="sr-only">{plural(ut("adm2.nGroups"), all?.length ?? 0, lang)}</span>
    </Panel>
  );
}
