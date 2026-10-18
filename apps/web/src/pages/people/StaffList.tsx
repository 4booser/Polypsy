import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { PERMISSION_GROUPS, ROLE_LADDER, roleRank, t, type AuditEntry, type Lang, type LocalizedText, type UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import {
  ActivityList,
  Avatar,
  Callout,
  type Column,
  DataTable,
  Drawer,
  DrawerSection,
  Empty,
  FilterBar,
  FilterChip,
  Ic,
  KV,
  KbdHints,
  Loading,
  PersonCell,
  TextAction,
  Tooltip,
  tableToCsv,
  useHotkeys,
  useUrlState,
} from "../../ui";
import { cx } from "../../ui/cx";
import { Count, IconTile, Page, Panel } from "../../ui/layout";
import { ActionMenu, MenuButton, menuItemClass } from "../../ui/menu";
import { Button, Tabs, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { actionLabel } from "../ops/model";
import { loadDirectory, withLadder } from "./data";
import {
  type StaffRow,
  type StaffView,
  accountState,
  facetChoice,
  facetValues,
  filterStaff,
  inView,
  isAdministrator,
  isDoctor,
  isStale,
  ladderCounts,
  mainRole,
  orderRegistry,
  parseRegistrySort,
  peopleLists,
  viewCounts,
  workplaceOf,
} from "./model";
import { AIc, daysAgo, dm, fill, hm, plural, saveFile, shortName, whenShort } from "./parts";

/*
 * Реестр «Лікарі» и «Адміністратори» — Polypsy 2.0, макеты admin-staff и
 * admin-admins.
 *
 * Один экран в двух прочтениях, как и прежде: справочник сотрудников
 * загружается целиком (data.ts — какой маршрут и почему), а кто «лікар» и
 * кто «адміністратор», решает model.ts по классу записи и ступени лестницы.
 *
 * «Лікарі» — таблица набора (DataTable): поиск по ФИО, логину и телефону,
 * отбор по відділенню и посаді, виды (без второго фактора, давно не входили,
 * временный пароль), порядок; всё, кроме выбора строк, — в адресе (?q,
 * ?unit, ?position, ?sort, ?view, ?off): «вот эти люди» пересылаются ссылкой.
 * Строка открывает «Хто це» в ящике, имя ведёт в карточку.
 *
 * «Адміністратори» — ланцюжок призначення по ступеням, таблица
 * администраторов, «Що може кожен» (административные права из ролей) и
 * журнал назначений, если смотрящему открыт журнал доступа.
 *
 * Чего с макета нет и почему (сервер этого не знает): норма пациентов на
 * лікаря («41 з 40»), смены, дежурства и отпуска («на зміні», «вихідний»),
 * письмо-приглашение (запись заводится с паролем) и массовые «нагадати про
 * другий фактор» / «призначити роль». Вместо выдуманного — то, что есть:
 * сколько пациентов человек ведёт, вход и второй фактор, состояние записи.
 */

export type StaffKind = "doctors" | "admins";

/** Перевод по ключу — как ut из useLang, для помощников вне компонента */
type UT = (k: UiKey) => string;

const VIEWS: StaffView[] = ["all", "nomfa", "stale", "invited", "disabled"];

export default function StaffList({ kind }: { kind: StaffKind }) {
  const { ut, lang } = useLang();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  /*
   * Право вести учётные записи — не класс: заведующий с таким правом заводит
   * людей наравне с суперадмином, а суперадмину сервер отвечает «да» без
   * справочника. По нему же выбирается маршрут за справочником (см. data.ts).
   */
  const canManage = can("users.manage");
  const viewerId = user?.id ?? "";
  const isSuper = user?.role === "superadmin";
  const isAdmins = kind === "admins";

  /*
   * Вкладки — тем, кому открыты оба списка: вкладка на адрес, которого у
   * человека нет, увела бы его на сводку. Правило одно с маршрутами App.tsx.
   */
  const lists = peopleLists(user);
  const bothLists = lists.doctors && lists.admins;

  /*
   * Ступени лестницы справочник 2.0 отдаёт сам (model.ts, withAccount);
   * withLadder догружает их поштучно только для строк без учётной записи —
   * старый сервер или усечённый справочник.
   */
  const res = useResource(
    async () => {
      const dir = await loadDirectory({ id: viewerId, canManageUsers: canManage });
      return isAdmins ? { ...dir, rows: await withLadder(dir.rows, { id: viewerId, isSuper }) } : dir;
    },
    [kind, viewerId, canManage, isSuper],
    { enabled: !!user },
  );
  const rows = res.data?.rows ?? [];
  const doctors = useMemo(() => rows.filter(isDoctor), [rows]);
  const admins = useMemo(() => rows.filter(isAdministrator), [rows]);

  const addTo = isAdmins ? "/admins/new" : "/staff/new";
  useHotkeys({ n: () => navigate(addTo) }, canManage);

  const tabs = bothLists ? (
    <Tabs
      label={ut("ppl.listsLabel")}
      items={[
        { to: "/staff", label: ut("ppl.staff"), end: true, count: res.data ? doctors.length : null },
        { to: "/admins", label: ut("adm.admins"), end: true, count: res.data ? admins.length : null },
      ]}
    />
  ) : null;

  const addButton = canManage ? (
    <Tooltip label={isAdmins ? ut("adm.addAdmin") : ut("ppl.addDoctor")} kbd="N">
      <Button variant="primary" icon={<AIc.userPlus />} onClick={() => navigate(addTo)}>
        {isAdmins ? ut("adm.addAdmin") : ut("ppl.addDoctor")}
      </Button>
    </Tooltip>
  ) : null;

  const body = res.error ? (
    <Loading error={res.error} onRetry={res.reload} />
  ) : !res.data ? (
    <Loading rows={8} />
  ) : null;

  if (isAdmins) {
    return (
      <Page
        title={ut("adm.admins")}
        meta={res.data ? adminsMeta(admins, ut, lang) : undefined}
        actions={addButton}
        toolbar={tabs}
      >
        {body ?? <AdminsView admins={admins} all={rows} />}
      </Page>
    );
  }

  return (
    <DoctorsView
      doctors={doctors}
      ready={!!res.data}
      partial={!!res.data?.partial}
      fallback={body}
      tabs={tabs}
      addButton={addButton}
    />
  );
}

/* ─────────── шапка ─────────── */

function doctorsMeta(rows: StaffRow[], u: UT, lang: Lang): [string, string] {
  const units = new Set(rows.map((r) => workplaceOf(r)).filter(Boolean)).size;
  const withMfa = rows.filter((r) => r.account?.mfa && !r.account.disabledAt).length;
  const active = rows.filter((r) => !r.account?.disabledAt).length;
  const first = fill(u("adm2.doctorsInUnits"), {
    doctors: plural(u("adm2.nDoctors"), rows.length, lang),
    units: plural(u("adm2.nUnits"), units, lang),
  });
  return [first, fill(u("adm2.mfaOf"), { n: withMfa, total: active })];
}

function adminsMeta(rows: StaffRow[], u: UT, lang: Lang): [string, string] {
  const steps = new Set(rows.map((r) => (r.role === "superadmin" ? "s" : String(r.account?.ladderRank ?? 0)))).size;
  const exceptions = rows.reduce((n, r) => n + (r.account?.exceptions ?? 0), 0);
  const withMfa = rows.filter((r) => r.account?.mfa).length;
  return [
    fill(u("adm2.adminsOnSteps"), { admins: plural(u("adm2.nAdmins"), rows.length, lang), steps: plural(u("adm2.nSteps"), steps, lang) }),
    fill(u("adm2.adminsMfa"), { n: withMfa, total: rows.length, exceptions }),
  ];
}

/* ─────────── «Лікарі» ─────────── */

function DoctorsView({
  doctors,
  ready,
  partial,
  fallback,
  tabs,
  addButton,
}: {
  doctors: StaffRow[];
  ready: boolean;
  partial: boolean;
  fallback: ReactNode;
  tabs: ReactNode;
  addButton: ReactNode;
}) {
  const { ut, lang } = useLang();
  const now = Date.now();
  /*
   * Поиск, отбор и порядок — в адресе: «вот эти люди» пересылаются ссылкой,
   * как и в списке пациентов, каталоге тестов и перечне аналитики. Пишется
   * через replace (useUrlState): «назад» уводит со страницы, а не отматывает
   * набранное по букве.
   */
  const [q, setQ] = useUrlState("q");
  const [unit, setUnit] = useUrlState("unit");
  const [position, setPosition] = useUrlState("position");
  const [sortParam, setSort] = useUrlState("sort", "name");
  const [viewParam, setView] = useUrlState("view", "all");
  /* «Працюють» — умолчание: выключенные записи прячутся, пока фильтр не снят (?off=1) */
  const [offParam, setOff] = useUrlState("off");
  const sort = parseRegistrySort(sortParam);
  const view = (VIEWS as string[]).includes(viewParam) ? (viewParam as StaffView) : "all";
  const working = offParam !== "1";

  const [who, setWho] = useState<StaffRow | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);

  const departments = useMemo(() => facetValues(doctors, "unit"), [doctors]);
  const positions = useMemo(() => facetValues(doctors, "position"), [doctors]);
  /* виды считаются по отобранному полями, но до самого вида: число на пилюле — сколько покажет её нажатие */
  const filtered = useMemo(
    () => filterStaff(doctors, { q, unit, position }).filter((r) => !working || !r.account?.disabledAt || view === "disabled"),
    [doctors, q, unit, position, working, view],
  );
  const counts = useMemo(() => viewCounts(filtered, now), [filtered, now]);
  const shown = useMemo(() => orderRegistry(filtered.filter((r) => inView(r, view, now)), sort), [filtered, view, sort, now]);

  const columns = useDoctorColumns(now);
  const exportRows = (list: StaffRow[]) =>
    saveFile(tableToCsv(list, columns), `${ut("ppl.staff")}-${new Date().toISOString().slice(0, 10)}.csv`);

  const viewLabel: Record<StaffView, string> = {
    all: ut("adm2.viewAll"),
    nomfa: ut("adm2.viewNoMfa"),
    stale: ut("adm2.viewStale"),
    invited: ut("adm2.viewInvited"),
    disabled: ut("adm2.viewDisabled"),
  };

  return (
    <Page
      title={ut("ppl.staff")}
      meta={ready ? doctorsMeta(doctors, ut, lang) : undefined}
      actions={
        <>
          {ready ? (
            <Tooltip label={ut("adm2.exportCsv")}>
              <Button variant="secondary" size="icon" aria-label={ut("adm2.exportCsv")} onClick={() => exportRows(shown)}>
                <Ic.download size={17} />
              </Button>
            </Tooltip>
          ) : null}
          {addButton}
        </>
      }
      toolbar={tabs}
    >
      {fallback ?? (
        <Panel flush>
          <div className="px-4 pb-2.5 pt-3.5">
            <FilterBar
              search={{ value: q, onChange: setQ, placeholder: ut("adm2.searchStaff"), label: ut("ppl.searchStaff"), width: 260 }}
              chips={
                <>
                  <FilterChip label={ut("adm2.working")} on={working} onClick={() => setOff(working ? "1" : "")} onClear={() => setOff("1")} />
                  <ValueChip label={ut("ppl.department")} values={departments} current={unit} onChange={setUnit} />
                  <ValueChip label={ut("mp.position")} values={positions} current={position} onChange={setPosition} />
                </>
              }
              sort={{
                value: sort,
                onChange: setSort,
                options: [
                  { key: "name", label: ut("adm2.sortName") },
                  { key: "unit", label: ut("adm2.sortUnit") },
                  { key: "position", label: ut("adm2.sortPosition") },
                  { key: "patients", label: ut("adm2.sortPatients") },
                  { key: "seen", label: ut("adm2.sortSeen") },
                ],
              }}
            />
          </div>
          <div className="px-4 pb-3">
            <div role="group" aria-label={ut("kit.savedViews")} className="flex flex-wrap gap-x-[5px] gap-y-1.5">
              {VIEWS.filter((v) => v === "all" || v === view || counts[v] > 0).map((v) => (
                <ViewButton key={v} on={v === view} label={viewLabel[v]} count={counts[v]} onClick={() => setView(v === "all" ? "" : v)} />
              ))}
            </div>
          </div>
          {/*
            Число найденных и оговорка о неполном справочнике — для диктора:
            список он не окидывает взглядом, а неполноту справочника иначе
            узнать неоткуда. Глазу неполноту говорит строка ниже.
          */}
          <p className="sr-only" aria-live="polite">
            {`${ut("ppl.found")} ${shown.length}`}
          </p>
          {partial ? (
            <div className="px-4 pb-3">
              <Callout kind="info">{ut("ppl.directoryPartial")}</Callout>
            </div>
          ) : null}
          <DataTable
            rows={shown}
            columns={columns}
            rowKey={(r) => r.id}
            label={ut("ppl.staff")}
            selectable
            bulkActions={(picked) => (
              <Button variant="panel" size="xs" icon={<Ic.download size={14} />} onClick={() => exportRows(picked)}>
                {ut("adm2.export")}
              </Button>
            )}
            onRowClick={(r) => {
              setWho(r);
              setWhoOpen(true);
            }}
            isRowActive={(r) => whoOpen && who?.id === r.id}
            rowActions={(r) => <RowMenu row={r} />}
            pageSize={25}
            hotkeys
            empty={
              <div className="px-4 pb-6">
                <Empty compact title={ut("pt.nobodyFound")} />
              </div>
            }
          />
          <KbdHints
            bar
            keys={[
              ["J K", ut("adm2.keyRows")],
              ["Enter", ut("adm2.keyWho")],
              ["/", ut("adm2.keySearch")],
              ...(addButton ? ([["N", ut("ppl.addDoctor")]] as [string, string][]) : []),
            ]}
          />
        </Panel>
      )}
      <WhoDrawer row={who} open={whoOpen} onClose={() => setWhoOpen(false)} now={now} />
    </Page>
  );
}

/** Пилюля вида с числом — ViewPill набора, но с подписью для диктора «вид: …» */
function ViewButton({ on, label, count, onClick }: { on: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "inline-flex h-8 min-h-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-2xl border-0 px-2.5 text-small leading-none",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        on ? "bg-violet font-bold text-onfill" : "bg-sunk font-semibold text-text-2 hover:bg-sunk-2 hover:text-text",
      )}
    >
      {label}
      <span className={cx("font-bold tabular-nums", on ? "text-onfill-muted" : "text-muted")}>{count}</span>
    </button>
  );
}

/**
 * Отбор по значению (відділення, посада) — пилюля фильтра с меню значений.
 * Значения — из самого списка (facetValues), выбранное из адреса, которого в
 * данных нет, остаётся пунктом (facetChoice): иначе пилюля показывала бы
 * «все», а список — пустоту.
 */
function ValueChip({
  label,
  values,
  current,
  onChange,
}: {
  label: string;
  values: string[];
  current: string;
  onChange: (v: string) => void;
}) {
  const choice = facetChoice(values, current);
  const on = !!choice.value;
  return (
    <MenuButton
      label={label}
      trigger={(p) => (
        <span className="inline-flex" {...{ "aria-label": undefined }}>
          <FilterChip
            label={label}
            value={on ? choice.value : undefined}
            on={on}
            expanded={p["aria-expanded"]}
            onClick={p.onClick}
            onClear={on ? () => onChange("") : undefined}
          />
        </span>
      )}
    >
      {(close) =>
        choice.options.length ? (
          choice.options.map((v) => (
            <button
              key={v}
              type="button"
              role="menuitemradio"
              aria-checked={v === choice.value}
              className={menuItemClass("left")}
              onClick={() => {
                close();
                onChange(v === choice.value ? "" : v);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{v}</span>
              {v === choice.value ? <Ic.check size={15} className="text-violet-ink" /> : null}
            </button>
          ))
        ) : (
          <span className="block px-2.5 py-2 text-small text-muted">{label}</span>
        )
      }
    </MenuButton>
  );
}

/* ─────────── колонки ─────────── */

function useDoctorColumns(now: number): Column<StaffRow>[] {
  const { ut } = useLang();
  return useMemo(
    () => [
      {
        key: "name",
        header: ut("adm2.colDoctor"),
        required: true,
        sort: (r) => r.fullName,
        csv: (r) => r.fullName,
        render: (r) => (
          <PersonCell
            name={r.fullName || r.email}
            sub={r.position ?? r.specialty ?? r.email}
            avatar={<Avatar name={r.fullName || r.email} size={30} tone="soft" />}
            to={`/staff/${r.id}`}
            peek={<PersonPeek row={r} />}
          />
        ),
      },
      {
        key: "unit",
        header: ut("ppl.department"),
        required: true,
        sort: (r) => workplaceOf(r),
        csv: (r) => workplaceOf(r),
        render: (r) => <span className="text-text-2">{workplaceOf(r) ?? ""}</span>,
      },
      {
        key: "role",
        header: ut("adm.role"),
        required: true,
        sort: (r) => mainRole(r)?.title ?? null,
        csv: (r) => mainRole(r)?.title ?? null,
        render: (r) => <RoleCell row={r} />,
      },
      {
        key: "patients",
        header: ut("top.patients"),
        num: true,
        required: true,
        sort: (r) => r.account?.patients ?? null,
        csv: (r) => r.account?.patients ?? null,
        render: (r) =>
          r.account ? (
            r.account.patients ? (
              <b className="font-extrabold tabular-nums text-text">{r.account.patients}</b>
            ) : (
              <span className="text-muted">{ut("adm2.none")}</span>
            )
          ) : null,
      },
      {
        key: "seen",
        header: ut("adm2.colSeen"),
        required: true,
        sort: (r) => r.account?.lastSeenAt ?? null,
        csv: (r) => r.account?.lastSeenAt ?? null,
        render: (r) => <SeenCell row={r} now={now} />,
      },
      {
        key: "state",
        header: ut("adm2.colState"),
        required: true,
        sort: (r) => accountState(r.account) ?? null,
        csv: (r) => {
          const s = accountState(r.account);
          return s ? ut(STATE_LABEL[s]) : null;
        },
        render: (r) => <StateTag row={r} />,
      },
    ],
    [ut, now],
  );
}

const STATE_LABEL = {
  disabled: "adm2.stateDisabled",
  invited: "adm2.stateInvited",
  temp: "adm2.stateTemp",
  never: "adm2.stateNever",
  active: "adm2.stateActive",
} as const;

function RoleCell({ row }: { row: StaffRow }) {
  const { ut, lang } = useLang();
  const role = mainRole(row);
  const ex = row.account?.exceptions ?? 0;
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="text-text-2">{role?.title ?? (row.account ? ut("ppl.roleNone") : "")}</span>
      {ex ? (
        <Tag tone="primary" icon={<AIc.key />}>
          {plural(ut("adm2.nExceptions"), ex, lang)}
        </Tag>
      ) : null}
    </span>
  );
}

function SeenCell({ row, now }: { row: StaffRow; now: number }) {
  const { ut } = useLang();
  const a = row.account;
  if (!a) return null;
  if (!a.lastSeenAt) {
    return <span className="text-muted">{ut("adm2.neverSeen")}</span>;
  }
  const stale = isStale(a, now);
  return (
    <span className="flex flex-col gap-px leading-[17px]">
      <span className={cx("whitespace-nowrap tabular-nums", stale ? "font-bold text-warn" : "text-text")}>{whenShort(a.lastSeenAt, ut)}</span>
      {stale ? (
        <small className="whitespace-nowrap text-caption font-bold text-warn">{fill(ut("adm2.daysNoLogin"), { n: daysAgo(a.lastSeenAt) })}</small>
      ) : a.mfa ? (
        <small className="inline-flex items-center gap-1 whitespace-nowrap text-caption text-good">
          <Ic.shieldCheck size={13} />
          {ut("adm2.withMfa")}
        </small>
      ) : (
        <small className="inline-flex items-center gap-1 whitespace-nowrap text-caption font-bold text-warn">
          <AIc.shieldAlert size={13} />
          {ut("adm2.withoutMfa")}
        </small>
      )}
    </span>
  );
}

function StateTag({ row }: { row: StaffRow }) {
  const { ut } = useLang();
  const s = accountState(row.account);
  if (!s) return null;
  if (s === "disabled") return <Tag tone="done" icon={<Ic.ban />}>{ut(STATE_LABEL[s])}</Tag>;
  if (s === "invited" || s === "temp") return <Tag tone="attention" icon={<AIc.mail />}>{ut(STATE_LABEL[s])}</Tag>;
  if (s === "never") return <Tag tone="plain" icon={<AIc.moon />}>{ut(STATE_LABEL[s])}</Tag>;
  return <Tag tone="plain" icon={<AIc.dot />}>{ut(STATE_LABEL[s])}</Tag>;
}

/** Поповер «хто це» на имени: работа и вход, без перехода */
function PersonPeek({ row }: { row: StaffRow }) {
  const { ut } = useLang();
  const role = mainRole(row);
  return (
    <KV
      w={92}
      rows={[
        [ut("adm2.login"), row.email],
        ...(row.phone ? ([[ut("ppl.phone"), row.phone]] as [string, string][]) : []),
        [ut("ppl.department"), workplaceOf(row) ?? "—"],
        [ut("adm.role"), role?.title ?? "—"],
        ...(row.account ? ([[ut("top.patients"), String(row.account.patients)]] as [string, string][]) : []),
      ]}
    />
  );
}

/** Меню строки: карточка, роль и права, пациенты, журнал — переходами туда, где это делается */
function RowMenu({ row }: { row: StaffRow }) {
  const { ut } = useLang();
  const { can } = useAuth();
  return (
    <ActionMenu
      label={ut("adm2.rowMenu")}
      triggerSize="icon-sm"
      entries={[
        { label: ut("adm2.openCard"), icon: <AIc.panel size={15} />, to: `/staff/${row.id}` },
        { label: ut("adm2.changeRole"), icon: <AIc.key size={15} />, to: `/permissions?user=${row.id}` },
        ...(row.account?.patients
          ? [{ label: ut("adm2.transfer"), icon: <AIc.transfer size={15} />, to: `/staff/${row.id}/patients` }]
          : []),
        ...(can("audit.read") ? [{ label: ut("adm2.actionLog"), icon: <Ic.history size={15} />, to: `/ops/audit?actor=${row.id}`, ruled: true }] : []),
      ]}
    />
  );
}

/* ─────────── «Хто це» ─────────── */

function WhoDrawer({ row, open, onClose, now }: { row: StaffRow | null; open: boolean; onClose: () => void; now: number }) {
  const { ut, lang } = useLang();
  const navigate = useNavigate();
  if (!row) return null;
  const a = row.account;
  const role = mainRole(row);
  const builtin = a?.roles.find((r) => r.code === "psychologist");
  const roleText = [role?.title, builtin && builtin !== role ? builtin.title : null].filter(Boolean).join(", ");
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={row.fullName || row.email}
      sub={[row.position, workplaceOf(row)].filter(Boolean).join(", ")}
      icon={<Ic.user />}
      footer={
        <>
          <Button variant="primary" icon={<AIc.panel size={15} />} onClick={() => navigate(`/staff/${row.id}`)}>
            {ut("adm2.openCard")}
          </Button>
          <Button icon={<AIc.key size={15} />} onClick={() => navigate(`/permissions?user=${row.id}`)}>
            {ut("adm2.changeRole")}
          </Button>
        </>
      }
    >
      <DrawerSection title={ut("adm2.account")}>
        <KV
          w={110}
          rows={[
            [ut("adm2.login"), <b key="l">{row.email}</b>],
            ...(row.phone ? ([[ut("ppl.phone"), row.phone]] as [string, ReactNode][]) : []),
            [ut("adm.role"), roleText || "—"],
            [ut("adm2.exceptions"), a?.exceptions ? plural(ut("adm2.nExceptions"), a.exceptions, lang) : ut("adm2.noneShe")],
            [
              ut("adm2.seen"),
              a?.lastSeenAt ? `${whenShort(a.lastSeenAt, ut)}${isStale(a, now) ? `, ${fill(ut("adm2.daysNoLogin"), { n: daysAgo(a.lastSeenAt) })}` : ""}` : ut("adm2.neverSeen"),
            ],
            [ut("adm2.mfa"), a ? (a.mfa ? ut("adm2.mfaOn") : ut("adm2.mfaOff")) : "—"],
          ]}
        />
        {row.phone ? (
          <p className="m-0 mt-2.5 flex items-center gap-1.5 text-caption text-muted">
            <Ic.eye size={13} />
            {ut("adm2.phoneLogged")}
          </p>
        ) : null}
      </DrawerSection>
      <DrawerSection title={ut("adm2.work")}>
        <KV
          w={110}
          rows={[
            [ut("ppl.department"), workplaceOf(row) ?? "—"],
            [ut("mp.position"), row.position ?? "—"],
            [ut("ppl.specialty"), row.specialty ?? "—"],
            [ut("top.patients"), a ? String(a.patients) : "—"],
          ]}
        />
      </DrawerSection>
    </Drawer>
  );
}

/* ─────────── «Адміністратори» ─────────── */

/** Административные права — группы «Адміністрування» и «Технічна служба» и вывоз данных с именами */
const ADMIN_PERMISSIONS: string[] = [
  ...PERMISSION_GROUPS.filter((g) => g.code === "admin" || g.code === "ops").flatMap((g) => [...g.permissions] as string[]),
  "export.full",
];

function AdminsView({ admins, all }: { admins: StaffRow[]; all: StaffRow[] }) {
  const { ut, lang } = useLang();
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const now = Date.now();
  const roles = useResource(() => api.permissionRoles(), []);
  const catalogue = useResource(() => api.permissionCatalogue(), []);
  /* журнал назначений — тем, кому открыт журнал доступа; без права запрос не уходит (отказ лёг бы в журнал) */
  const canAudit = can("audit.read");
  const journal = useResource(
    async () => {
      const actions = ["user.roles_change", "permission.exception", "permission.exception_revoke", "user.role_change", "user.create"];
      const pages = await Promise.all(actions.map((action) => api.auditPage({ action, limit: "8" }).catch(() => null)));
      return pages
        .flatMap((p) => p?.entries ?? [])
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 8);
    },
    [],
    { enabled: canAudit },
  );

  const shown = admins
    .filter((r) => `${r.fullName} ${r.email}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => rankOf(b) - rankOf(a) || a.fullName.localeCompare(b.fullName, "uk"));

  return (
    <div className="flex flex-col gap-4">
      <Ladder all={all} roles={roles.data ?? null} />
      <Panel
        title={ut("adm.admins")}
        icon={<AIc.userCog />}
        count={admins.length}
        flush
        actions={<SearchSmall value={q} onChange={setQ} />}
      >
        <DataTable
          rows={shown}
          columns={adminColumns(all, roles.data ?? [], ut, lang, now)}
          rowKey={(r) => r.id}
          label={ut("adm.admins")}
          rowActions={(r) => (
            <ActionMenu
              label={ut("adm2.rowMenu")}
              triggerSize="icon-sm"
              entries={[
                { label: ut("adm2.openCard"), icon: <AIc.panel size={15} />, to: `/staff/${r.id}` },
                ...(r.role === "superadmin"
                  ? []
                  : [{ label: ut("adm2.changeStep"), icon: <AIc.key size={15} />, to: `/permissions?user=${r.id}` }]),
                ...(canAudit ? [{ label: ut("adm2.actionLog"), icon: <Ic.history size={15} />, to: `/ops/audit?actor=${r.id}` }] : []),
              ]}
            />
          )}
          empty={
            <div className="px-4 pb-6">
              <Empty compact title={ut("pt.nobodyFound")} />
            </div>
          }
        />
      </Panel>
      <div className="grid items-start gap-4 min-[1360px]:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title={ut("adm2.whoCan")}
          icon={<Ic.list />}
          sub={ut("adm2.whoCanSub")}
          flush
          actions={<TextAction to="/permissions">{ut("adm2.changeInPermissions")}</TextAction>}
          footer={
            <div className="flex flex-col gap-2">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
                <Mark kind="role" label={ut("adm2.markRole")} />
                {ut("adm2.markRole")}
                <Mark kind="super" label={ut("adm2.markSuper")} />
                {ut("adm2.markSuper")}
                <Mark kind="no" label={ut("adm2.markNo")} />
                {ut("adm2.markNo")}
              </span>
              <span className="text-caption text-muted">{ut("adm2.superNote")}</span>
            </div>
          }
        >
          {catalogue.data && roles.data ? (
            <AdminMatrix admins={shown} titles={catalogue.data} />
          ) : (
            <Loading rows={4} bare error={catalogue.error ?? roles.error} onRetry={() => (catalogue.reload(), roles.reload())} />
          )}
        </Panel>
        {canAudit ? (
          <Panel title={ut("adm2.assignLog")} icon={<Ic.history />} flush actions={<TextAction to="/ops/audit">{ut("adm2.wholeLog")}</TextAction>}>
            {journal.error ? (
              <Loading bare error={journal.error} onRetry={journal.reload} />
            ) : !journal.data ? (
              <Loading rows={4} bare />
            ) : journal.data.length ? (
              <ActivityList events={journal.data.map((e) => auditEvent(e, all, ut))} />
            ) : (
              <div className="px-4 pb-4">
                <Empty compact title={ut("adm2.noAssignments")} />
              </div>
            )}
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

function rankOf(r: StaffRow): number {
  return r.role === "superadmin" ? 99 : (r.account?.ladderRank ?? 0);
}

function SearchSmall({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { ut } = useLang();
  return (
    <label className="flex h-9 w-[220px] items-center gap-2 rounded-[12px] bg-sunk px-3 text-muted max-[700px]:w-[160px]">
      <Ic.search size={15} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={ut("adm2.searchAdmins")}
        aria-label={ut("adm2.searchAdmins")}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-small text-text outline-none placeholder:text-muted"
      />
    </label>
  );
}

/**
 * Ланцюжок призначення: технічний суперадміністратор → головний лікар →
 * завідувач → спеціаліст. Кто на ступени — по справочнику; правило «каждый
 * назначает лишь ступень ниже» держит сервер, и это сказано словами.
 */
function Ladder({ all, roles }: { all: StaffRow[]; roles: { code: string; title: LocalizedText; people: number; isBuiltin: boolean }[] | null }) {
  const { ut, lang } = useLang();
  const counts = ladderCounts(all);
  const byCode = new Map((roles ?? []).map((r) => [r.code, r]));
  const peopleOn = (rank: number) => all.filter((r) => (rank < 0 ? r.role === "superadmin" : r.role !== "superadmin" && r.account?.ladderRank === rank));
  const steps = [
    { rank: -1, title: ut("perm.superadminTitle"), note: ut("adm2.stepSuperNote"), icon: <AIc.shieldHalf /> },
    ...[...ROLE_LADDER].reverse().map((code) => ({
      rank: roleRank(code),
      title: byCode.has(code) ? t(byCode.get(code)!.title, lang) : code,
      note:
        code === "specialist"
          ? ut("adm2.stepAssignsNobody")
          : fill(ut("adm2.stepAssigns"), {
              role: (() => {
                const below = ROLE_LADDER[ROLE_LADDER.indexOf(code) - 1];
                return below && byCode.has(below) ? t(byCode.get(below)!.title, lang) : (below ?? "");
              })(),
            }),
      icon: code === "chief" ? <AIc.building /> : code === "head" ? <Ic.users /> : <AIc.stethoscope />,
    })),
  ];
  const outside = (roles ?? []).filter((r) => !(ROLE_LADDER as readonly string[]).includes(r.code));
  return (
    <Panel
      title={ut("perm.chain")}
      icon={<AIc.network />}
      sub={ut("adm2.chainSub")}
      actions={<TextAction to="/permissions">{ut("adm2.rolesAndPermissions")}</TextAction>}
    >
      <ol className="m-0 grid list-none grid-cols-4 gap-3 p-0 max-[1100px]:grid-cols-2">
        {steps.map((s, i) => {
          const people = peopleOn(s.rank);
          const n = counts.get(s.rank) ?? 0;
          return (
            <li
              key={s.rank}
              className={cx(
                "relative flex min-h-[112px] flex-col gap-1.5 rounded-panel p-3.5",
                i === 0 ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]" : "bg-sunk",
              )}
            >
              <span className="flex items-start gap-2.5">
                <IconTile icon={s.icon} size={32} tone={i === 0 ? "violet" : "neutral"} />
                <b className={cx("min-w-0 flex-1 text-h3 font-extrabold leading-[19px]", i === 0 ? "text-violet-ink" : "text-text")}>{s.title}</b>
                <Count n={i === 0 ? 4 : 4 - i} tone={i === 0 ? "tint" : "plain"} />
              </span>
              <span className="text-small text-text-2">
                {n === 0 ? ut("adm2.nobodyHere") : n <= 2 ? people.map((p) => shortName(p.fullName)).join(", ") : plural(ut("adm2.nPeople"), n, lang)}
              </span>
              <small className="text-caption leading-[16px] text-muted">{s.note}</small>
              {i < steps.length - 1 ? (
                <Ic.chevronRight size={16} className="absolute -right-[14px] top-1/2 -translate-y-1/2 text-muted max-[1100px]:hidden" />
              ) : null}
            </li>
          );
        })}
      </ol>
      {outside.length ? (
        <div className="mt-3">
          <Callout kind="line">
            {fill(ut("adm2.outsideChain"), {
              roles: outside.map((r) => `${t(r.title, lang)} (${r.people})`).join(", "),
            })}
          </Callout>
        </div>
      ) : null}
    </Panel>
  );
}

function adminColumns(
  all: StaffRow[],
  roles: { code: string; title: LocalizedText }[],
  u: UT,
  lang: Lang,
  now: number,
): Column<StaffRow>[] {
  const titleOf = (code: string) => {
    const r = roles.find((x) => x.code === code);
    return r ? t(r.title, lang) : code;
  };
  const stepName = (r: StaffRow) => (r.role === "superadmin" ? u("perm.superadminTitle") : (mainRole(r)?.title ?? ""));
  const assigns = (r: StaffRow) => {
    if (r.role === "superadmin") return u("adm2.assignsSuper");
    const rank = r.account?.ladderRank ?? 0;
    const below = ROLE_LADDER[rank - 2];
    return below ? titleOf(below) : "";
  };
  const under = (r: StaffRow) => {
    const rank = rankOf(r);
    return all.filter((x) => x.id !== r.id && x.role !== "superadmin" && (x.account?.ladderRank ?? 0) < rank).length;
  };
  return [
    {
      key: "name",
      header: u("adm2.colAdmin"),
      required: true,
      sort: (r) => r.fullName,
      render: (r) => (
        <PersonCell
          name={r.fullName || r.email}
          sub={r.position ?? r.email}
          avatar={<Avatar name={r.fullName || r.email} size={30} tone="soft" />}
          to={`/staff/${r.id}`}
        />
      ),
    },
    {
      key: "step",
      header: u("adm2.colStep"),
      required: true,
      sort: (r) => rankOf(r),
      render: (r) =>
        r.role === "superadmin" ? (
          <Tag tone="primary" icon={<AIc.shieldHalf />}>
            {stepName(r)}
          </Tag>
        ) : (
          <Tag>{stepName(r)}</Tag>
        ),
    },
    { key: "assigns", header: u("adm2.colAssigns"), required: true, render: (r) => <span className="text-text-2">{assigns(r)}</span> },
    {
      key: "under",
      header: u("adm2.colUnder"),
      num: true,
      required: true,
      sort: (r) => under(r),
      render: (r) => (
        <span className="whitespace-nowrap">
          <b className="font-extrabold tabular-nums text-text">{under(r)}</b>{" "}
          <span className="text-muted">{u("adm2.people")}</span>
        </span>
      ),
    },
    {
      key: "seen",
      header: u("adm2.colLogin"),
      required: true,
      sort: (r) => r.account?.lastSeenAt ?? null,
      render: (r) => <SeenCell row={r} now={now} />,
    },
  ];
}

/**
 * Клетка «Що може кожен»: у суперадмина — всё; карточка прав не прочитана
 * (человек на ступени не ниже смотрящего — сервер её не отдаёт — или запрос
 * не удался) — «не известно», а не «не може»: прежде пустой ответ рисовался
 * минусом, и главный лікар выглядел в матрице человеком без прав.
 */
export function adminMark(
  admin: { role: string },
  effective: readonly string[] | null | undefined,
  code: string,
): "super" | "role" | "no" | "unknown" {
  if (admin.role === "superadmin") return "super";
  if (!effective) return "unknown";
  return effective.includes(code) ? "role" : "no";
}

/**
 * Читается ли карточка прав этого человека — то же правило, что у сервера
 * (GET /api/permissions/users/:id): свою, суперадмину — любую, иначе — того,
 * кто ступенью ниже. Заведомый отказ не запрашивается.
 */
export function permissionCardReadable(
  viewer: { id: string; role: string; ladderRank: number },
  row: { id: string; role: string; ladderRank: number },
): boolean {
  if (viewer.role === "superadmin" || viewer.id === row.id) return true;
  return row.role !== "superadmin" && row.ladderRank < viewer.ladderRank;
}

/** Отметка в матрице: даёт роль, у суперадмина — всё, не может; «не известно» — пустая, с подписью */
function Mark({ kind, label }: { kind: "role" | "super" | "no" | "unknown"; label: string }) {
  if (kind === "unknown") {
    return <span role="img" aria-label={label} title={label} className="inline-grid size-[22px] place-items-center" />;
  }
  if (kind === "no") {
    return (
      <span role="img" aria-label={label} className="inline-grid size-[22px] place-items-center text-muted">
        <Ic.minus size={13} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      className={cx(
        "inline-grid size-[22px] place-items-center rounded-[7px]",
        kind === "role" ? "bg-violet text-onfill" : "bg-violet-tint text-violet-ink",
      )}
    >
      <Ic.check size={13} />
    </span>
  );
}

/**
 * «Що може кожен»: административные права × администраторы. Права — из
 * действующего набора человека (карточка прав, роли и исключения вместе);
 * у суперадмина всё и светлее: права ему не раздают, он их обходит.
 */
function AdminMatrix({
  admins,
  titles,
}: {
  admins: StaffRow[];
  titles: { groups: { permissions: { code: string; title: LocalizedText }[] }[] };
}) {
  const { ut, lang } = useLang();
  const { user } = useAuth();
  const viewer = { id: user?.id ?? "", role: user?.role ?? "", ladderRank: user?.ladderRank ?? 0 };
  const cards = useResource(
    () =>
      Promise.all(
        admins.map((a) =>
          a.role === "superadmin" || !permissionCardReadable(viewer, { id: a.id, role: a.role, ladderRank: a.account?.ladderRank ?? 0 })
            ? Promise.resolve(null)
            : api.userPermissions(a.id).then((c) => c.effective).catch(() => null),
        ),
      ),
    [admins.map((a) => a.id).join(), viewer.id, viewer.ladderRank],
  );
  const titleOf = (code: string) => {
    for (const g of titles.groups) for (const p of g.permissions) if (p.code === code) return t(p.title, lang);
    return code;
  };
  if (!cards.data) return <Loading rows={4} bare error={cards.error} onRetry={cards.reload} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-body">
        <thead>
          <tr>
            <th className="h-[38px] border-y border-divider bg-panel-2 px-4 text-left text-caption font-bold text-muted">{ut("adm2.permission")}</th>
            {admins.map((a) => (
              <th key={a.id} className="h-[38px] w-[124px] border-y border-divider bg-panel-2 px-2 text-center text-caption font-bold text-text-2">
                <span className="inline-flex items-center gap-1.5">
                  <Avatar name={a.fullName || a.email} size={22} tone="soft" />
                  {a.lastName || shortName(a.fullName).split(" ")[0]}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ADMIN_PERMISSIONS.map((code) => (
            <tr key={code}>
              <td className="border-b border-divider px-4 py-2">
                <b className="block font-bold leading-[18px] text-text">{titleOf(code)}</b>
                <code className="font-mono text-[11.5px] text-muted">{code}</code>
              </td>
              {admins.map((a, i) => {
                const kind = adminMark(a, cards.data?.[i], code);
                const label =
                  kind === "super"
                    ? ut("adm2.markSuper")
                    : kind === "role"
                      ? ut("adm2.markRole")
                      : kind === "unknown"
                        ? ut("adm2.accessClosed")
                        : ut("adm2.markNo");
                return (
                  <td key={a.id} className="border-b border-divider px-2 text-center">
                    <Mark kind={kind} label={label} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Строка журнала назначений: что сделано, над кем и кто */
function auditEvent(e: AuditEntry, all: StaffRow[], u: UT) {
  const nameOf = (id: string | null) => {
    const r = id ? all.find((x) => x.id === id) : null;
    return r ? shortName(r.fullName) : null;
  };
  const actor = nameOf(e.actorId) ?? e.actorEmail ?? "";
  const subject = nameOf(e.subjectUserId);
  const icon = e.action.startsWith("permission.") ? <AIc.key /> : e.action === "user.create" ? <AIc.userPlus /> : <AIc.userCog />;
  return {
    date: dm(e.at),
    time: hm(e.at),
    icon,
    tone: e.outcome === "denied" ? ("warn" as const) : undefined,
    text: (
      <>
        <b>{actionLabel(e.action, u)}</b>
        {subject ? `: ${subject}` : ""}
        <span className="block text-caption text-muted">{actor}</span>
      </>
    ),
  };
}
