import { type ReactNode, useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { BulkUserAction, OpsUserRow, Permission, Role, UiKey } from "@quizzy/shared";
import { api, ApiError } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { BulkBar, DataTable, FilterBar, KbdHints, Loading, Modal, useAction, type Column } from "../../ui";
import { Ic } from "../../ui/icons";
import { useHotkeys } from "../../ui/keys";
import { Panel } from "../../ui/layout";
import { ActionMenu, MenuButton, menuItemClass, type MenuEntry } from "../../ui/menu";
import { Tooltip } from "../../ui/Popover";
import { Pager } from "../../ui/pager";
import { listBody, pageCount } from "../../ui/paging";
import { Button, ErrorText, Field, Input, Select, Tabs, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { useDebounced } from "./controls";
import { OneTimePassword } from "./dialogs";
import { type Hold, ROLE_KEY, generatePassword, holdKey, holdsOfRow } from "./model";
import { importTemplateCsv } from "./people2/model";
import { saveText } from "./people2/parts";
import { SectionPage } from "./people2/frame";
import { Ix } from "./people2/icons";
import { BulkDialog, ImpersonateDialog, ImportDialog, ResetMfaDialog, type RowExtrasOpen, useRowExtras } from "./people2/UserTools";
import { AttentionPanel } from "./users/attention";
import {
  AccountCell,
  ChoiceChip,
  FactorCell,
  fill,
  LastSeenCell,
  RoleCell,
  SessionsCell,
  StateCell,
} from "./users/parts";
import { RegistrySummary } from "./users/summary";
import { UserDrawer } from "./users/UserDrawer";
import {
  type AccountDraft,
  type AccountEvent,
  type AccountForm,
  USER_VIEWS,
  accountBody,
  accountOutOfReach,
  accountProblems,
  accountReady,
  accountStep,
  applyPatch,
  newAccount,
  readUsersFilters,
  usersIdsQuery,
  usersPatch,
  usersQuery,
  viewCounts,
  viewOf,
  viewPatch,
} from "./usersModel";

/*
 * Техпанель → «Користувачі»: весь реестр учётных записей и всё, что с ними
 * делают.
 *
 * Решение заказчика 2026-09-26: «посмотреть всех пользователей, выдать
 * кому-то доступ, удалить или создать акк и подобное». Экран заменил прежние
 * «Облікові записи» (/users теперь ведёт сюда) и умеет всё, что умели они:
 * заведение, список, устройства с удалённым стиранием. Сверх того — роль,
 * права и исключения (ссылкой на экран прав с выбранным человеком), сброс
 * пароля, завершение сессий, выключение и удаление того, что удалять можно.
 *
 * Polypsy 2.0 («Виразна»): реестр — таблицей (сравнивают многие строки по
 * многим колонкам), запись — панелью справа, а не переходом: строка, Enter,
 * имя в «Потребує уваги» и ссылка `?user=:id` открывают её рядом, J/K ведут
 * по соседним. Над таблицей — что требует внимания сейчас и сводка всего
 * реестра. Отбор, порядок, страница и открытая запись — в адресе, как у
 * остальных списков консоли: «вимкнені за останній місяць» пересылают
 * коллеге ссылкой.
 *
 * Что человеку нельзя, в меню остаётся погашенным с объяснением, а не
 * пропадает: на своей строке нет «вимкнути» потому, что себя выключить
 * нельзя, — и об этом лучше прочитать, чем гадать, куда делся пункт.
 *
 * Исключение — учётки на ступени смотрящего и выше (w19:ui): действий над
 * ними не-суперадмину не показывают вовсе, остаются переходы «посмотреть»
 * (userRowMenu, accountOutOfReach в usersModel.ts).
 */

export type Dialog =
  | { kind: "create" }
  | { kind: "role"; row: OpsUserRow }
  | { kind: "reset"; row: OpsUserRow }
  | { kind: "password"; row: OpsUserRow; password: string }
  | { kind: "revoke"; row: OpsUserRow }
  | { kind: "disable"; row: OpsUserRow }
  | { kind: "enable"; row: OpsUserRow }
  | { kind: "delete"; row: OpsUserRow }
  | { kind: "held"; row: OpsUserRow; holds: Hold[] }
  | { kind: "devices"; row: OpsUserRow }
  /* people2: вход «от имени», сброс второго фактора, массовое действие, импорт */
  | { kind: "impersonate"; row: OpsUserRow }
  | { kind: "resetMfa"; row: OpsUserRow }
  | { kind: "bulk"; action: BulkUserAction }
  | { kind: "import" };

const VIEW_LABEL: Record<(typeof USER_VIEWS)[number], UiKey> = {
  all: "oppu.view.all",
  staff: "oppu.view.staff",
  patients: "oppu.view.patients",
  disabled: "oppu.view.disabled",
};

export default function OpsUsers() {
  const { ut } = useLang();
  const { user, can } = useAuth();
  const isSuper = user?.role === "superadmin";
  const [params, setParams] = useSearchParams();
  const { run } = useAction();

  /*
   * Отбор — из адреса, но через разбор (usersModel.ts): незнакомая роль,
   * состояние или порядок из старой закладки значат «фильтра нет», а не
   * отказ сервера на весь экран.
   */
  const filters = readUsersFilters(params);
  const { q, role, status, sort, page, per } = filters;
  const settledQ = useDebounced(q);

  /* `replace`: каждая буква поиска — не шаг в истории браузера; смена отбора возвращает на первую страницу (usersPatch) */
  const update = useCallback(
    (patch: Record<string, string | null>) => setParams((prev) => applyPatch(prev, patch), { replace: true }),
    [setParams],
  );

  /* перечитать всё, что зависит от записей: список, сводку, «Потребує уваги», открытую запись */
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const query = usersQuery(filters, settledQ);
  const res = useResource(() => api.opsUsers(query), [query, version]);
  const summary = useResource(() => api.opsUsersSummary(), [version]);
  const attention = useResource(() => api.opsUsersAttention(), [version]);
  const pages = pageCount(res.data?.total ?? 0, per);

  /* страница за концом списка (сузили отбор) — на последнюю существующую */
  useEffect(() => {
    if (res.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [res.data, page, pages, update]);

  /* открытая запись — в адресе: ссылку на запись пересылают; Esc закрывает, страница остаётся */
  const openId = params.get("user");
  const openUser = useCallback((id: string) => setParams((prev) => applyPatch(prev, { user: id })), [setParams]);
  const closeUser = useCallback(() => setParams((prev) => applyPatch(prev, { user: null }), { replace: true }), [setParams]);
  const items = res.data?.items ?? [];
  const place = listBody(res.data?.items ?? null, res.error);
  const openRow = items.find((r) => r.id === openId) ?? null;
  const step = (d: 1 | -1) => {
    if (!items.length) return;
    const at = items.findIndex((r) => r.id === openId);
    const next = items[at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + d))];
    if (next && next.id !== openId) openUser(next.id);
  };

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const done = () => {
    setDialog(null);
    bump();
  };
  /* «Пристрої» из меню строки — раздел панели записи, а не отдельное окно */
  const open = (d: Dialog) => {
    if (d.kind === "devices") openUser(d.row.id);
    else setDialog(d);
  };

  /* N — новая запись, когда ни окна, ни панели нет */
  useHotkeys({ n: () => setDialog({ kind: "create" }) }, !dialog && !openId);

  /*
   * Выбор для массовых действий (people2). Живёт через листание, но не через
   * смену отбора: «выбрал сорок врачей, сменил фильтр на пациентов и нажал
   * вимкнути» не должно выключать врачей, которых на экране уже нет.
   */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [settledQ, role, status]);
  const extras = useRowExtras();

  const entriesFor = (row: OpsUserRow): MenuEntry[] => userRowMenu(row, { me: user, can, ut, open, extras });
  const view = viewOf(filters);
  const counts = summary.data ? viewCounts(summary.data.roles) : null;
  const total = counts?.all ?? null;
  const staffN = counts?.staff ?? null;
  const patientsN = counts?.patients ?? null;

  const columns: Column<OpsUserRow>[] = [
    {
      key: "account",
      header: ut("ops.users.account"),
      required: true,
      width: 260,
      render: (r) => <AccountCell row={r} self={r.id === user?.id} />,
    },
    { key: "role", header: ut("adm.role"), required: true, width: 250, render: (r) => <RoleCell row={r} /> },
    { key: "last", header: ut("ops.users.lastSeen"), required: true, width: 132, render: (r) => <LastSeenCell row={r} /> },
    {
      key: "sessions",
      header: ut("ops.tab.sessions"),
      required: true,
      num: true,
      width: 72,
      render: (r) => <SessionsCell row={r} onOpen={() => setParams((prev) => applyPatch(prev, { user: r.id }))} />,
    },
    { key: "mfa", header: ut("ops.tab.mfa"), required: true, width: 124, render: (r) => <FactorCell row={r} /> },
    { key: "state", header: ut("ops.users.state"), required: true, render: (r) => <StateCell row={r} /> },
  ];

  const roleChoices: { value: string; label: string }[] = [
    { value: "", label: ut("ops.users.allRoles") },
    { value: "staff", label: ut("oppu.view.staff") },
    { value: "superadmin", label: ut("adm.roleSuper") },
    { value: "admin", label: ut("adm.roleAdmin") },
    { value: "user", label: ut("adm.rolePatient") },
  ];
  const stateChoices = [
    { value: "", label: ut("ops.users.allStates") },
    { value: "active", label: ut("ops.users.active") },
    { value: "disabled", label: ut("ops.users.disabledMany") },
  ];

  return (
    <SectionPage
      title={ut("ops.tab.users")}
      meta={
        total !== null
          ? [fill(ut("oppu.metaTotal"), { n: total }), fill(ut("oppu.metaSplit"), { s: staffN ?? "—", p: patientsN ?? "—" })]
          : staffN !== null
            ? [fill(ut("oppu.metaStaff"), { s: staffN }), ut("oppu.metaPatientsHidden")]
            : undefined
      }
      perm="users.manage"
      actions={
        <>
          <Button icon={<Ix.fileUp />} onClick={() => setDialog({ kind: "import" })}>
            {ut("ops.import.button")}
          </Button>
          <Tooltip label={ut("adm.newUser")} kbd="N">
            <Button variant="primary" icon={<Ix.userPlus />} onClick={() => setDialog({ kind: "create" })}>
              {ut("adm.newUser")}
            </Button>
          </Tooltip>
          <MenuButton label={ut("oppu.moreHeader")} glyph={<Ic.ellipsis />} triggerSize="icon" align="right" plateClassName="min-w-[260px]">
            {(closeMenu) => (
              <>
                {/*
                  Текст згоди жил вкладкой прежнего экрана учёток; экран снят, дверь
                  к тексту согласия остаётся здесь — править его может суперадмин.
                */}
                {isSuper ? (
                  <Link to="/consent-text" role="menuitem" className={menuItemClass("left")} onClick={closeMenu}>
                    <Ix.fileText size={16} className="text-muted" />
                    {ut("adm.consentTitle")}
                  </Link>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass("left")}
                  onClick={() => {
                    closeMenu();
                    saveText(importTemplateCsv(), "polypsy-staff-template.csv");
                  }}
                >
                  <Ix.fileSpreadsheet size={16} className="text-muted" />
                  {ut("oppu.templateCsv")}
                </button>
              </>
            )}
          </MenuButton>
        </>
      }
      lead={ut("oppu.lead")}
      toolbar={
        <Tabs
          label={ut("oppu.views")}
          items={USER_VIEWS.map((v) => ({
            id: `ops-users-view-${v}`,
            label: ut(VIEW_LABEL[v]),
            count: counts?.[v] ?? undefined,
            active: view === v,
            onSelect: () => update(viewPatch(v)),
          }))}
        />
      }
    >
      <div className="flex flex-col gap-4">
        {attention.data ? <AttentionPanel data={attention.data} onOpen={openUser} /> : null}
        <RegistrySummary data={summary.data} error={summary.error} onRetry={summary.reload} />

        <Panel flush>
          <div className="px-4 pb-3 pt-3.5">
            <FilterBar
              search={{
                value: q,
                onChange: (v) => update(usersPatch("q", v)),
                placeholder: ut("oppu.searchPh"),
                label: ut("ops.users.search"),
                width: 250,
              }}
              chips={
                <>
                  <ChoiceChip
                    label={ut("adm.role")}
                    choices={roleChoices}
                    value={role}
                    onChange={(v) => update(usersPatch("role", v))}
                  />
                  <ChoiceChip
                    label={ut("ops.users.state")}
                    choices={stateChoices}
                    value={status}
                    onChange={(v) => update(usersPatch("status", v))}
                  />
                </>
              }
              count={
                res.data ? (
                  <span className="whitespace-nowrap text-small text-muted" aria-live="polite">
                    {ut("ppl.found")} <b className="font-extrabold tabular-nums text-text">{res.data.total}</b>
                  </span>
                ) : undefined
              }
              sort={{
                label: ut("ppl.sort"),
                value: sort,
                onChange: (v) => update(usersPatch("sort", v)),
                options: [
                  { key: "name", label: ut("ppl.sortByName") },
                  { key: "lastSeen", label: ut("ops.users.sortLastSeen") },
                  { key: "created", label: ut("ops.users.sortCreated") },
                  { key: "role", label: ut("ops.users.sortRole") },
                ],
              }}
            />
          </div>
          <BulkBar
            className="mx-3 mb-2.5"
            count={selected.size}
            total={res.data?.total}
            /*
              Отказ «вибрати всіх у відборі» — всплывающим отказом, а не
              молчанием (w14:webtails): прежде он глотался, выбор оставался
              одной страницей, и человек, уверенный, что выбрал весь отбор,
              отправлял массовое действие на её часть.
            */
            onSelectAll={() =>
              void run(async () => {
                const r = await api.opsUserIds(usersIdsQuery(filters, settledQ));
                setSelected(new Set(r.ids));
              })
            }
            onClear={() => setSelected(new Set())}
          >
            <Button size="xs" variant="panel" icon={<Ix.logOut />} onClick={() => setDialog({ kind: "bulk", action: "revoke-sessions" })}>
              {ut("ops.bulk.revoke")}
            </Button>
            {isSuper || (user?.ladderRank ?? 0) > 1 ? (
              <Button size="xs" variant="panel" icon={<Ix.shieldPlus />} onClick={() => setDialog({ kind: "bulk", action: "assign-role" })}>
                {ut("ops.bulk.assignRole")}
              </Button>
            ) : (
              /* погашена с объяснением, а не пропала: кому ролей не назначать, тот видит почему */
              <Tooltip label={ut("ops.bulk.notAssigner")}>
                <span tabIndex={0} className="inline-flex rounded-[9px]">
                  <Button size="xs" variant="panel" icon={<Ix.shieldPlus />} disabled>
                    {ut("ops.bulk.assignRole")}
                  </Button>
                </span>
              </Tooltip>
            )}
            <Button size="xs" variant="panel" icon={<Ic.circleCheck />} onClick={() => setDialog({ kind: "bulk", action: "enable" })}>
              {ut("ops.bulk.enable")}
            </Button>
            <Button size="xs" variant="panel" icon={<Ic.ban />} onClick={() => setDialog({ kind: "bulk", action: "disable" })}>
              {ut("ops.bulk.disable")}
            </Button>
          </BulkBar>
          {/*
            Место списка — по общему правилу консоли (listBody, ui/paging.ts):
            пока строк нет — скелет или отказ с «повторити» на их месте; когда
            строки есть — отказ перечитывания строкой над ними, а строки
            остаются. Упавшее перечитывание после «вимкнути» не стирает реестр.
          */}
          {place.body === "loading" || place.body === "failed" ? (
            <div className="px-4 pb-4">
              <Loading rows={6} error={res.error} onRetry={res.reload} bare />
            </div>
          ) : (
            <>
              {place.stale ? (
                <div role="alert" className="mx-4 mb-2.5 flex items-center gap-2.5">
                  <ErrorText className="min-w-0 flex-1">{place.stale}</ErrorText>
                  <Button size="xs" variant="quiet" onClick={res.reload}>
                    {ut("common.retry")}
                  </Button>
                </div>
              ) : null}
              {place.body === "empty" ? (
                <p className="m-0 px-4 pb-5 pt-2 text-small text-muted">{ut("pt.nobodyFound")}</p>
              ) : (
                <DataTable
                  rows={items}
                  columns={columns}
                  rowKey={(r) => r.id}
                  label={ut("adm.allAccounts")}
                  selectable
                  selected={selected}
                  onSelectedChange={(keys) => setSelected(keys)}
                  onRowClick={(r) => openUser(r.id)}
                  isRowActive={(r) => r.id === openId}
                  hotkeys={!openId && !dialog}
                  rowActions={(r) => <RowActions row={r} entries={entriesFor(r)} onOpen={() => openUser(r.id)} onDialog={open} />}
                />
              )}
            </>
          )}
          <div className="border-t border-divider py-2.5 pl-4 pr-3">
            <Pager
              page={page}
              pages={pages}
              per={per}
              total={res.data?.total ?? null}
              onPer={(n) => update(usersPatch("per", String(n)))}
              onPage={(p) => update({ page: p > 1 ? String(p) : null })}
            />
          </div>
          <KbdHints
            bar
            label={ut("oppu.keys")}
            keys={[
              ["J K", ut("oppu.kRows")],
              ["X", ut("oppu.kSelect")],
              ["Enter", ut("oppu.kOpen")],
              ["/", ut("hotkey.search")],
              ["N", ut("oppu.kNew")],
            ]}
          />
        </Panel>
      </div>

      <UserDrawer
        open={!!openId}
        id={openId}
        hint={openRow}
        version={version}
        keys={!dialog}
        onClose={closeUser}
        onDialog={open}
        menu={entriesFor}
        onStep={step}
      />

      {dialog?.kind === "create" ? <CreateDialog isSuper={isSuper} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "role" ? <RoleDialog row={dialog.row} isSuper={isSuper} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "reset" ? (
        <ResetDialog row={dialog.row} onClose={close} onReset={(password) => setDialog({ kind: "password", row: dialog.row, password })} />
      ) : null}
      {dialog?.kind === "password" ? (
        <Modal
          title={ut("ops.users.tempPassword")}
          onClose={done}
          secret
          sub={dialog.row.email}
          icon={<Ix.keyRound />}
          footer={
            <Button variant="primary" onClick={done}>
              {ut("ops.users.gotIt")}
            </Button>
          }
        >
          <p className="m-0 mb-3 text-body text-text-2 [overflow-wrap:anywhere]">{ut("ops.users.resetDone")}</p>
          <OneTimePassword password={dialog.password} />
        </Modal>
      ) : null}
      {dialog?.kind === "revoke" ? <RevokeDialog row={dialog.row} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "disable" ? <DisableDialog row={dialog.row} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "enable" ? <EnableDialog row={dialog.row} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog
          row={dialog.row}
          onClose={close}
          onDone={() => {
            closeUser();
            done();
          }}
          onHeld={(holds) => setDialog({ kind: "held", row: dialog.row, holds })}
        />
      ) : null}
      {dialog?.kind === "held" ? (
        <HeldDialog
          row={dialog.row}
          holds={dialog.holds}
          canDisable={!dialog.row.disabledAt && dialog.row.id !== user?.id && (dialog.row.role !== "superadmin" || isSuper)}
          onClose={close}
          onDisable={() => setDialog({ kind: "disable", row: dialog.row })}
        />
      ) : null}
      {dialog?.kind === "impersonate" ? <ImpersonateDialog row={dialog.row} onClose={close} /> : null}
      {dialog?.kind === "resetMfa" ? <ResetMfaDialog id={dialog.row.id} email={dialog.row.email} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "bulk" ? (
        <BulkDialog
          action={dialog.action}
          ids={[...selected]}
          onClose={close}
          onDone={() => {
            setSelected(new Set());
            done();
          }}
        />
      ) : null}
      {dialog?.kind === "import" ? <ImportDialog onClose={close} onDone={done} /> : null}
    </SectionPage>
  );
}

/* ─────────── действия строки ─────────── */

/** Всплывают справа на наведении и фокусе: открыть запись, завершить сессии, меню */
function RowActions({
  row,
  entries,
  onOpen,
  onDialog,
}: {
  row: OpsUserRow;
  entries: MenuEntry[];
  onOpen: () => void;
  onDialog: (d: Dialog) => void;
}) {
  const { ut } = useLang();
  const { user } = useAuth();
  const canRevoke = row.sessions > 0 && !accountOutOfReach(user, row);
  const name = row.fullName || row.email;
  return (
    <span className="flex items-center gap-1">
      <Tooltip label={ut("oppu.openRecord")} kbd="Enter">
        <Button size="icon-sm" variant="quiet" aria-label={`${ut("oppu.openRecord")}: ${name}`} icon={<Ix.panelRightOpen />} onClick={onOpen} />
      </Tooltip>
      {canRevoke ? (
        <Tooltip label={ut("ops.users.revokeSessions")}>
          <Button
            size="icon-sm"
            variant="quiet"
            aria-label={`${ut("ops.users.revokeSessions")}: ${name}`}
            icon={<Ix.logOut />}
            onClick={() => onDialog({ kind: "revoke", row })}
          />
        </Tooltip>
      ) : null}
      <ActionMenu
        label={`${ut("ops.users.actions")}: ${name}`}
        glyph={<Ic.ellipsis />}
        entries={entries}
        triggerSize="icon-sm"
        align="right"
        plateClassName="min-w-[280px]"
      />
    </span>
  );
}

/* ─────────── меню строки ─────────── */

export interface RowMenuContext {
  /** Кто смотрит: id, класс и ступень лестницы (из /api/auth/me) */
  me: { id: string; role: Role; ladderRank?: number | null } | null | undefined;
  can: (permission: Permission) => boolean;
  ut: (key: UiKey) => string;
  open: (dialog: Dialog) => void;
  /** Пункты people2: вход «от имени» и сброс второго фактора (rowExtrasFor) */
  extras: (row: OpsUserRow, open: RowExtrasOpen) => MenuEntry[];
}

/**
 * Пункты меню строки «Користувачів» — без React (test/opsUsersMenu.test.ts).
 *
 * Учётка вне досягаемости (accountOutOfReach: на ступени смотрящего или
 * выше, суперадмин для не-суперадмина) — без действий вовсе: сервер на
 * каждое ответил бы err.accountAtOrAboveYours. Остаются переходы
 * «посмотреть» — сессии и журнал, — меню у строки не пустеет. Суперадмину
 * вне досягаемости только он сам, и меню у него — как прежде.
 */
export function userRowMenu(row: OpsUserRow, ctx: RowMenuContext): MenuEntry[] {
  const { me, can, ut, open } = ctx;
  const isSuper = me?.role === "superadmin";
  const self = row.id === me?.id;

  const views: MenuEntry[] = [
    { label: ut("ops.users.sessionsOf"), to: `/ops/sessions?user=${row.id}`, icon: <Ix.monitorSmartphone /> },
  ];
  if (can("audit.read")) {
    views.push(
      { label: ut("ops.users.actorLog"), to: `/ops/audit?actor=${row.id}`, icon: <Ix.fileSearch /> },
      { label: ut("ops.users.subjectLog"), to: `/ops/audit?subject=${row.id}`, icon: <Ix.fileText /> },
    );
  }
  if (accountOutOfReach(me, row)) return views;

  /*
   * Дальше учётка строго ниже смотрящего — или его собственная. Прежний
   * замок «суперадмина трогает только суперадмин» здесь уже не нужен:
   * чужой суперадмин для не-суперадмина вне досягаемости и ушёл выше.
   */
  const why = self ? ut("ops.users.notSelf") : undefined;
  return [
    { label: ut("ops.users.changeRole"), onSelect: () => open({ kind: "role", row }), disabled: self, hint: why, icon: <Ix.userCog /> },
    {
      label: ut("ops.users.permissions"),
      to: `/permissions?user=${row.id}`,
      disabled: row.role === "user",
      hint: ut("ops.users.patientNoPerms"),
      icon: <Ix.keyRound />,
    },
    {
      label: ut("dev.title"),
      onSelect: () => open({ kind: "devices", row }),
      disabled: !isSuper,
      hint: ut("ops.users.superOnly"),
      icon: <Ix.smartphone />,
    },
    ...views.map((v, i) => (i === 0 ? { ...v, ruled: true } : v)),
    {
      label: ut("ops.users.resetPassword"),
      onSelect: () => open({ kind: "reset", row }),
      disabled: self,
      hint: why,
      icon: <Ix.rotateCcw />,
      ruled: true,
    },
    {
      label: ut("ops.users.revokeSessions"),
      onSelect: () => open({ kind: "revoke", row }),
      disabled: row.sessions === 0,
      hint: ut("ops.users.noSessions"),
      icon: <Ix.logOut />,
    },
    row.disabledAt
      ? { label: ut("ops.users.enable"), onSelect: () => open({ kind: "enable", row }), icon: <Ic.circleCheck /> }
      : { label: ut("ops.users.disable"), onSelect: () => open({ kind: "disable", row }), disabled: self, hint: why, icon: <Ic.ban /> },
    {
      label: ut("ops.users.delete"),
      danger: true,
      disabled: !isSuper || self,
      hint: self ? ut("ops.users.notSelf") : ut("ops.users.deleteSuperOnly"),
      icon: <Ix.trash />,
      /* учётка со следом — сразу объяснение, а не подтверждение, которое кончится отказом */
      onSelect: () => {
        const holds = holdsOfRow(row);
        open(holds.length ? { kind: "held", row, holds } : { kind: "delete", row });
      },
    },
    /* people2: «переглянути як ця людина» и сброс второго фактора — оба только суперадмину */
    ...ctx
      .extras(row, {
        impersonate: () => open({ kind: "impersonate", row }),
        resetMfa: () => open({ kind: "resetMfa", row }),
      })
      .map((e, i) => (i === 0 ? { ...e, ruled: true } : e)),
  ];
}

/* ─────────── окна ─────────── */

/** Текст отказа сервера — как есть: право и причина читаются словами сервера */
function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Подпись окна над записью: почта и роль словом */
function whoOf(row: OpsUserRow, ut: (k: UiKey) => string): string {
  return `${row.email}, ${ut(ROLE_KEY[row.role]).toLowerCase()}`;
}

/**
 * «Новий обліковий запис»: штатный POST /api/users с паролем, который
 * генерирует экран и показывает один раз, и с отметкой «сменить при входе».
 *
 * Пароль виден и до заведения — его копируют, пока форма открыта, — и
 * последний раз после: окно показывает его вместе с «створено», а закрывшись,
 * забывает. Суперадмина заводит только суперадмин (так решено и на сервере):
 * заведующему с users.manage пункта в выборе нет.
 *
 * Состояние окна — шагами (usersModel.ts, accountStep): отказ сервера
 * снимается правкой поля, вторая отправка не уходит, пока летит первая.
 * Форма — отдельно (CreateAccountForm): её состояния проверяются без
 * браузера (test/opsUsersFilters.test.tsx).
 */
function CreateDialog({ isSuper, onClose, onDone }: { isSuper: boolean; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const [state, dispatch] = useReducer(accountStep, undefined, () => newAccount(generatePassword()));
  /*
   * Решение «отправлять ли» — по ref, а не по состоянию из замыкания: два
   * Enter подряд успевают до перерисовки, и оба увидели бы busy = false.
   */
  const inFlight = useRef(false);

  const send = () => {
    if (inFlight.current || accountStep(state, { type: "send" }) === state) return;
    inFlight.current = true;
    dispatch({ type: "send" });
    api
      .createUser(accountBody(state.form))
      .then((u) => dispatch({ type: "created", email: u.email }))
      .catch((err) => dispatch({ type: "failed", message: errorText(err, ut("adm.createFailed")) }))
      .finally(() => {
        inFlight.current = false;
      });
  };

  if (state.created) {
    return (
      <Modal
        title={ut("adm.newUser")}
        onClose={onDone}
        secret
        sub={state.created}
        icon={<Ix.userPlus />}
        footer={
          <Button variant="primary" onClick={onDone}>
            {ut("ops.users.gotIt")}
          </Button>
        }
      >
        <p className="m-0 mb-3 text-body text-text-2 [overflow-wrap:anywhere]">{ut("ops.users.createdDone")}</p>
        <OneTimePassword password={state.form.password} />
      </Modal>
    );
  }

  return (
    <Modal title={ut("adm.newUser")} onClose={onClose} sub={ut("adm.accountsSub")} icon={<Ix.userPlus />}>
      <CreateAccountForm
        state={state}
        isSuper={isSuper}
        onEvent={dispatch}
        onRegenerate={() => dispatch({ type: "edit", patch: { password: generatePassword() } })}
        onSubmit={send}
        onClose={onClose}
      />
    </Modal>
  );
}

/** Форма окна заведения: всё, что она показывает, — из состояния, без своих решений */
export function CreateAccountForm({
  state,
  isSuper,
  onEvent,
  onRegenerate,
  onSubmit,
  onClose,
}: {
  state: AccountDraft;
  isSuper: boolean;
  onEvent: (e: AccountEvent) => void;
  onRegenerate: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  const { form, busy, error } = state;
  const edit = (patch: Partial<AccountForm>) => onEvent({ type: "edit", patch });
  const problems = accountProblems(form);
  const ready = accountReady(form);

  return (
    <form
      className="flex flex-col gap-3 pt-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <Field label={ut("adm.lastName")}>
          <Input value={form.lastName} onChange={(e) => edit({ lastName: e.target.value })} autoFocus required maxLength={80} />
        </Field>
        <Field label={ut("adm.firstName")}>
          <Input value={form.firstName} onChange={(e) => edit({ firstName: e.target.value })} required maxLength={80} />
        </Field>
      </div>
      <Field label={ut("adm.middleName")} optional>
        <Input value={form.middleName} onChange={(e) => edit({ middleName: e.target.value })} maxLength={80} />
      </Field>
      {/* почта с ошибкой называется словами у поля: погашенная кнопка сама не говорит, чего ей не хватает */}
      <Field label={ut("person.email")} error={problems.email ? ut(problems.email) : null}>
        <Input
          type="email"
          value={form.email}
          onChange={(e) => edit({ email: e.target.value })}
          required
          autoComplete="off"
          aria-invalid={problems.email ? true : undefined}
        />
      </Field>
      <Field label={ut("adm.role")}>
        <Select value={form.role} onChange={(e) => edit({ role: e.target.value as Role })}>
          <option value="admin">{ut("adm.roleAdmin")}</option>
          <option value="user">{ut("adm.rolePatient")}</option>
          {isSuper ? <option value="superadmin">{ut("adm.roleSuper")}</option> : null}
        </Select>
      </Field>
      <div>
        <span className="mb-1.5 block text-caption font-bold text-text-2">{ut("ops.users.tempPassword")}</span>
        <OneTimePassword password={form.password} />
        <Button size="xs" variant="quiet" className="mt-1.5" icon={<Ix.rotateCcw />} onClick={onRegenerate}>
          {ut("ops.users.regenerate")}
        </Button>
      </div>
      {error ? (
        <div role="alert">
          <ErrorText>{error}</ErrorText>
        </div>
      ) : null}
      <div className="mt-1 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {ut("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" icon={<Ix.userPlus />} disabled={!ready || busy}>
          {ut("adm.create")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Смена роли — штатным PATCH /api/users/:id/role. Тонкие права и личные
 * исключения здесь не правятся: для них есть экран прав, и окно ведёт туда
 * с выбранным человеком — второй редактор прав разошёлся бы с первым.
 */
function RoleDialog({ row, isSuper, onClose, onDone }: { row: OpsUserRow; isSuper: boolean; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [role, setRole] = useState<Role>(row.role);
  return (
    <Modal
      title={ut("ops.users.changeRole")}
      sub={whoOf(row, ut)}
      icon={<Ix.userCog />}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            disabled={busy || role === row.role}
            onClick={() =>
              void run(async () => {
                await api.setUserRole(row.id, role);
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
      <div className="flex flex-col gap-3 pt-3.5">
        <Field label={ut("adm.role")}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">{ut("adm.roleAdmin")}</option>
            <option value="user">{ut("adm.rolePatient")}</option>
            {isSuper ? <option value="superadmin">{ut("adm.roleSuper")}</option> : null}
          </Select>
        </Field>
        <p className="m-0 text-small text-text-2">{ut("ops.users.roleHint")}</p>
        {row.role !== "user" ? (
          <Link to={`/permissions?user=${row.id}`} className="text-small font-bold text-violet-ink">
            {ut("ops.users.permissions")}
          </Link>
        ) : null}
      </div>
    </Modal>
  );
}

/** Подтверждение одним нажатием: текст, основная кнопка и «Скасувати» */
function Confirm({
  title,
  sub,
  icon,
  action,
  actionIcon,
  busy,
  error,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  sub: string;
  icon: ReactNode;
  action: string;
  actionIcon?: ReactNode;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { ut } = useLang();
  return (
    <Modal
      title={title}
      sub={sub}
      icon={icon}
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" icon={actionIcon} disabled={busy} onClick={onConfirm} autoFocus>
            {action}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <div className="pt-3.5 text-body text-text-2 [overflow-wrap:anywhere]">{children}</div>
      {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
    </Modal>
  );
}

function ResetDialog({ row, onClose, onReset }: { row: OpsUserRow; onClose: () => void; onReset: (password: string) => void }) {
  const { ut } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Confirm
      title={ut("ops.users.resetPassword")}
      sub={whoOf(row, ut)}
      icon={<Ix.rotateCcw />}
      action={ut("oppu.resetShow")}
      actionIcon={<Ix.rotateCcw />}
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() => {
        setBusy(true);
        setError(null);
        api
          .resetUserPassword(row.id)
          .then((r) => onReset(r.password))
          .catch((e) => setError(errorText(e, ut("ui.actionFailed"))))
          .finally(() => setBusy(false));
      }}
    >
      {ut("ops.users.resetWarn")}
    </Confirm>
  );
}

function RevokeDialog({ row, onClose, onDone }: { row: OpsUserRow; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  return (
    <Confirm
      title={ut("ops.users.revokeSessions")}
      sub={whoOf(row, ut)}
      icon={<Ix.logOut />}
      action={ut("ops.users.revokeSessions")}
      actionIcon={<Ix.logOut />}
      busy={busy}
      onClose={onClose}
      onConfirm={() =>
        void run(async () => {
          await api.revokeUserSessions(row.id);
          onDone();
        }, ut("ops.users.sessionsEnded"))
      }
    >
      {ut("ops.users.revokeWarn")}
    </Confirm>
  );
}

/**
 * Выключение — с причиной словами. Причина обязательна (сервер отвергнет
 * пустую): через год «кто и зачем выключил врача» разбирают по журналу.
 */
function DisableDialog({ row, onClose, onDone }: { row: OpsUserRow; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [reason, setReason] = useState("");
  const formId = useId();
  const ok = reason.trim().length >= 3;
  return (
    <Modal
      title={ut("oppu.disableTitle")}
      sub={whoOf(row, ut)}
      icon={<Ic.ban />}
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <Button type="submit" form={formId} variant="primary" icon={<Ic.ban />} disabled={busy || !ok}>
            {ut("oppu.disableAction")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3 pt-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          void run(async () => {
            await api.disableUser(row.id, reason.trim());
            onDone();
          }, ut("ops.users.disabledDone"));
        }}
      >
        <p className="m-0 text-body text-text-2">{ut("ops.users.disableWarn")}</p>
        <Field label={ut("ops.users.reason")}>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            autoFocus
            required
            placeholder={ut("oppu.disablePh")}
          />
        </Field>
      </form>
    </Modal>
  );
}

function EnableDialog({ row, onClose, onDone }: { row: OpsUserRow; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  return (
    <Confirm
      title={ut("ops.users.enable")}
      sub={whoOf(row, ut)}
      icon={<Ic.circleCheck />}
      action={ut("ops.users.enable")}
      actionIcon={<Ic.circleCheck />}
      busy={busy}
      onClose={onClose}
      onConfirm={() =>
        void run(async () => {
          await api.enableUser(row.id);
          onDone();
        }, ut("ops.users.enabledDone"))
      }
    >
      {row.disabledReason ? <p className="m-0 mb-2">«{row.disabledReason}»</p> : null}
      {ut("ops.users.enableWarn")}
    </Confirm>
  );
}

/**
 * Удаление: подтверждение перепечатыванием почты.
 *
 * Сюда попадают только строки без следа (см. userRowMenu), но решает сервер:
 * между загрузкой списка и нажатием человек мог пройти методику. Отказ 409
 * несёт перечень «что держит» — окно переходит в объяснение, а не
 * показывает голую ошибку.
 */
function DeleteDialog({
  row,
  onClose,
  onDone,
  onHeld,
}: {
  row: OpsUserRow;
  onClose: () => void;
  onDone: () => void;
  onHeld: (holds: Hold[]) => void;
}) {
  const { ut } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const formId = useId();
  const match = typed.trim() === row.email;
  const submit = () => {
    if (!match || busy) return;
    setBusy(true);
    setError(null);
    api
      .deleteUser(row.id)
      .then(onDone)
      .catch((e) => {
        const holds = e instanceof ApiError ? (e.body as { holds?: Hold[] } | undefined)?.holds : undefined;
        if (e instanceof ApiError && e.status === 409 && holds?.length) onHeld(holds);
        else setError(errorText(e, ut("ui.actionFailed")));
      })
      .finally(() => setBusy(false));
  };
  return (
    <Modal
      title={ut("ops.users.delete")}
      sub={whoOf(row, ut)}
      icon={<Ix.trash />}
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <Button type="submit" form={formId} variant="danger" icon={<Ix.trash />} disabled={!match || busy}>
            {ut("ops.users.delete")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3 pt-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="m-0 text-body text-text-2">{ut("ops.users.deleteWarn")}</p>
        <Field label={`${ut("ui.typeToConfirm")} «${row.email}»`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </Field>
        {error ? <ErrorText>{error}</ErrorText> : null}
      </form>
    </Modal>
  );
}

/**
 * «Видалити не можна» — и почему, числом по каждому источнику.
 *
 * Клинические данные не удаляются, журнал не переписывается
 * (docs/ARCHITECTURE.md). Окно не прячет это за «ошибкой», а называет, что
 * держит, и предлагает то, что можно сделать: выключить — вход закрыт,
 * история на месте.
 */
function HeldDialog({
  row,
  holds,
  canDisable,
  onClose,
  onDisable,
}: {
  row: OpsUserRow;
  holds: Hold[];
  canDisable: boolean;
  onClose: () => void;
  onDisable: () => void;
}) {
  const { ut } = useLang();
  return (
    <Modal
      title={ut("ops.users.cannotDelete")}
      sub={whoOf(row, ut)}
      icon={<Ic.info />}
      onClose={onClose}
      footer={
        <>
          {canDisable ? (
            <Button variant="primary" icon={<Ic.ban />} onClick={onDisable}>
              {ut("ops.users.disableInstead")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {ut("common.close")}
          </Button>
        </>
      }
    >
      <p className="m-0 mb-2 pt-3.5 text-body text-text-2">{ut("ops.users.heldBy")}</p>
      <ul className="m-0 mb-3 list-none p-0">
        {holds.map((h) => (
          <li key={h.key} className="flex justify-between gap-3 border-t border-divider py-1.5 text-body first:border-t-0">
            <span className="text-text-2">{ut(holdKey(h.key))}</span>
            <b className="font-extrabold tabular-nums text-text">{h.count}</b>
          </li>
        ))}
      </ul>
      <p className="m-0 text-small text-muted">{ut("ops.users.heldWhy")}</p>
    </Modal>
  );
}
