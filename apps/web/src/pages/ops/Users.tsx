import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { OpsUserRow, Role } from "@quizzy/shared";
import { api, ApiError } from "../../api";
import { useAuth } from "../../auth";
import { dateTime, day } from "../../format";
import { useLang } from "../../lang";
import { Loading, Modal, useAction } from "../../ui";
import { IconDots, IconPlusThick } from "../../ui/glyphs";
import { ActionMenu, type MenuEntry } from "../../ui/menu";
import { Pager } from "../../ui/pager";
import { pageCount, pageFrom, perFrom } from "../../ui/paging";
import { Button, ButtonLink, Field, Input, Select, Tag, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { Cell, ColumnHead, FilterSelect, SearchField, metaClass, nameClass, rowClass, useDebounced } from "./controls";
import { ConfirmPlain, ConfirmTyped, OneTimePassword } from "./dialogs";
import { type Hold, ROLE_KEY, generatePassword, holdKey, holdsOfRow, personHref, traceParts } from "./model";
import { UserDevices } from "./UserDevices";

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
 * Строки, а не таблица: имя 17/700 ссылкой на карточку человека, под ним
 * почта; дальше роль, последний вход, сессии, состояние и след. Отбор,
 * порядок и страница — в адресе, как у остальных списков консоли: «вимкнені
 * за останній місяць» пересылают коллеге ссылкой.
 *
 * Что человеку нельзя, в меню остаётся погашенным с объяснением, а не
 * пропадает: на своей строке нет «вимкнути» потому, что себя выключить
 * нельзя, — и об этом лучше прочитать, чем гадать, куда делся пункт.
 */

const GRID =
  "grid grid-cols-[minmax(0,2.3fr)_minmax(0,1.4fr)_minmax(0,1.3fr)_56px_minmax(0,1.6fr)_44px] gap-x-[20px]";

type Dialog =
  | { kind: "create" }
  | { kind: "role"; row: OpsUserRow }
  | { kind: "reset"; row: OpsUserRow }
  | { kind: "password"; row: OpsUserRow; password: string }
  | { kind: "revoke"; row: OpsUserRow }
  | { kind: "disable"; row: OpsUserRow }
  | { kind: "enable"; row: OpsUserRow }
  | { kind: "delete"; row: OpsUserRow }
  | { kind: "held"; row: OpsUserRow; holds: Hold[] }
  | { kind: "devices"; row: OpsUserRow };

export default function OpsUsers() {
  const { ut } = useLang();
  const { user, can } = useAuth();
  const isSuper = user?.role === "superadmin";
  const [params, setParams] = useSearchParams();

  const q = params.get("q") ?? "";
  const role = params.get("role") ?? "";
  const status = params.get("status") ?? "";
  const sort = params.get("sort") ?? "name";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));
  const settledQ = useDebounced(q);

  /* `replace`: каждая буква поиска — не шаг в истории браузера; смена отбора возвращает на первую страницу */
  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const res = useResource(
    () =>
      api.opsUsers({
        q: settledQ,
        role: role || undefined,
        status: status || undefined,
        sort,
        page: String(page),
        per: String(per),
      }),
    [settledQ, role, status, sort, page, per],
  );
  const pages = pageCount(res.data?.total ?? 0, per);

  /* страница за концом списка (сузили отбор) — на последнюю существующую */
  useEffect(() => {
    if (res.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [res.data, page, pages, update]);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const done = () => {
    setDialog(null);
    res.reload();
  };

  function entriesFor(row: OpsUserRow): MenuEntry[] {
    const self = row.id === user?.id;
    /* над суперадмином действует только суперадмин — то же правило стоит на сервере */
    const locked = row.role === "superadmin" && !isSuper;
    const why = self ? ut("ops.users.notSelf") : locked ? ut("ops.users.superOnly") : undefined;
    const entries: MenuEntry[] = [
      { label: ut("ops.users.changeRole"), onSelect: () => setDialog({ kind: "role", row }), disabled: self || locked, hint: why },
      {
        label: ut("ops.users.permissions"),
        to: `/permissions?user=${row.id}`,
        disabled: row.role === "user",
        hint: ut("ops.users.patientNoPerms"),
      },
      { label: ut("dev.title"), onSelect: () => setDialog({ kind: "devices", row }), disabled: !isSuper, hint: ut("ops.users.superOnly") },
      { label: ut("ops.users.sessionsOf"), to: `/ops/sessions?user=${row.id}` },
    ];
    if (can("audit.read")) {
      entries.push(
        { label: ut("ops.users.actorLog"), to: `/ops/audit?actor=${row.id}` },
        { label: ut("ops.users.subjectLog"), to: `/ops/audit?subject=${row.id}` },
      );
    }
    entries.push(
      { label: ut("ops.users.resetPassword"), onSelect: () => setDialog({ kind: "reset", row }), disabled: self || locked, hint: why },
      {
        label: ut("ops.users.revokeSessions"),
        onSelect: () => setDialog({ kind: "revoke", row }),
        disabled: locked || row.sessions === 0,
        hint: locked ? ut("ops.users.superOnly") : ut("ops.users.noSessions"),
      },
      row.disabledAt
        ? { label: ut("ops.users.enable"), onSelect: () => setDialog({ kind: "enable", row }), disabled: locked, hint: why }
        : { label: ut("ops.users.disable"), onSelect: () => setDialog({ kind: "disable", row }), disabled: self || locked, hint: why },
      {
        label: ut("ops.users.delete"),
        danger: true,
        disabled: !isSuper || self,
        hint: self ? ut("ops.users.notSelf") : ut("ops.users.deleteSuperOnly"),
        /* учётка со следом — сразу объяснение, а не подтверждение, которое кончится отказом */
        onSelect: () => {
          const holds = holdsOfRow(row);
          setDialog(holds.length ? { kind: "held", row, holds } : { kind: "delete", row });
        },
      },
    );
    return entries;
  }

  return (
    <>
      {/*
        Строка отбора: поиск тянется, три выбора по колонке, «+» — заведение.
        Всё — залитыми полями фильтра (look="fill"), как фильтры «Статистики»:
        это отбор, а не форма.
      */}
      <div className="mb-[12px] grid grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] items-center gap-[12px] max-[900px]:grid-cols-1">
        <SearchField label={ut("ops.users.search")} value={q} onChange={(v) => update({ q: v, page: null })} />
        <FilterSelect
          label={ut("adm.role")}
          value={role}
          onChange={(v) => update({ role: v, page: null })}
          options={[
            { value: "", label: ut("ops.users.allRoles") },
            { value: "superadmin", label: ut("adm.roleSuper") },
            { value: "admin", label: ut("adm.roleAdmin") },
            { value: "user", label: ut("adm.rolePatient") },
          ]}
        />
        <FilterSelect
          label={ut("ops.users.state")}
          value={status}
          onChange={(v) => update({ status: v, page: null })}
          options={[
            { value: "", label: ut("ops.users.allStates") },
            { value: "active", label: ut("ops.users.active") },
            { value: "disabled", label: ut("ops.users.disabledMany") },
          ]}
        />
        <FilterSelect
          label={ut("ppl.sort")}
          value={sort}
          onChange={(v) => update({ sort: v === "name" ? null : v, page: null })}
          options={[
            { value: "name", label: ut("ppl.sortByName") },
            { value: "created", label: ut("ops.users.sortCreated") },
            { value: "lastSeen", label: ut("ops.users.sortLastSeen") },
            { value: "role", label: ut("ops.users.sortRole") },
          ]}
        />
        <Button size="glyph" variant="ghost" aria-label={ut("adm.newUser")} onClick={() => setDialog({ kind: "create" })}>
          <IconPlusThick />
        </Button>
      </div>

      <div className="mb-[18px] flex flex-wrap items-center justify-between gap-[12px]">
        <div className="flex flex-wrap items-center gap-[16px]">
          <span className="font-mono text-[13px] text-muted tabular-nums" aria-live="polite">
            {res.data ? `${ut("ppl.found")} ${res.data.total}` : ""}
          </span>
          {/*
            Текст згоди жил вкладкой прежнего экрана учёток; экран снят, дверь
            к тексту согласия остаётся здесь — править его может суперадмин.
          */}
          {isSuper ? (
            <ButtonLink to="/consent-text" variant="ghost">
              {ut("adm.consentTitle")}
            </ButtonLink>
          ) : null}
        </div>
        <Pager
          page={page}
          pages={pages}
          per={per}
          onPer={(n) => update({ per: String(n), page: null })}
          onPage={(p) => update({ page: p > 1 ? String(p) : null })}
        />
      </div>

      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={6} />
      ) : res.data.items.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{ut("pt.nobodyFound")}</p>
      ) : (
        <>
          <ColumnHead
            grid={GRID}
            labels={[ut("ops.users.account"), ut("adm.role"), ut("ops.users.lastSeen"), ut("ops.tab.sessions"), ut("ops.users.state"), null]}
          />
          <ul className="m-0 list-none p-0" aria-label={ut("adm.allAccounts")}>
            {res.data.items.map((row) => (
              <UserRow key={row.id} row={row} menu={entriesFor(row)} />
            ))}
          </ul>
        </>
      )}

      {dialog?.kind === "create" ? <CreateDialog isSuper={isSuper} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "role" ? <RoleDialog row={dialog.row} isSuper={isSuper} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "reset" ? (
        <ResetDialog row={dialog.row} onClose={close} onReset={(password) => setDialog({ kind: "password", row: dialog.row, password })} />
      ) : null}
      {dialog?.kind === "password" ? (
        <Modal title={ut("ops.users.tempPassword")} onClose={done}>
          <p className="m-0 mb-[12px] text-[15px] leading-[21px] text-text-2 [overflow-wrap:anywhere]">
            {dialog.row.email}: {ut("ops.users.resetDone")}
          </p>
          <OneTimePassword password={dialog.password} />
          <div className="mt-[20px] flex justify-end">
            <Button onClick={done}>{ut("ops.users.gotIt")}</Button>
          </div>
        </Modal>
      ) : null}
      {dialog?.kind === "revoke" ? <RevokeDialog row={dialog.row} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "disable" ? <DisableDialog row={dialog.row} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "enable" ? <EnableDialog row={dialog.row} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog
          row={dialog.row}
          onClose={close}
          onDone={done}
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
      {dialog?.kind === "devices" ? <UserDevices userId={dialog.row.id} name={dialog.row.fullName} onClose={close} /> : null}
    </>
  );
}

/* ─────────── строка ─────────── */

function UserRow({ row, menu }: { row: OpsUserRow; menu: MenuEntry[] }) {
  const { ut } = useLang();
  const trace = traceParts(row.trace);
  return (
    <li className={rowClass(GRID)}>
      <div className="min-w-0">
        <Link to={personHref(row)} className={nameClass}>
          {row.fullName || row.email}
          {/* учётка под кодом: вместо имени — псевдоним, и это сказано словами */}
          {row.anonymous ? <span className="font-normal text-muted"> {ut("sel.noName")}</span> : null}
        </Link>
        <span className={metaClass}>{row.email}</span>
      </div>
      <Cell label={ut("adm.role")}>
        <span className="block">{ut(ROLE_KEY[row.role])}</span>
        {row.roleTitles.length || row.exceptions ? (
          <span className={metaClass}>
            {row.roleTitles.join(", ")}
            {row.exceptions ? `${row.roleTitles.length ? " · " : ""}${ut("ops.users.exceptions")}: ${row.exceptions}` : ""}
          </span>
        ) : null}
      </Cell>
      <Cell label={ut("ops.users.lastSeen")}>
        <span className="block">{row.lastSeenAt ? dateTime(row.lastSeenAt) : ut("ops.users.neverSeen")}</span>
        <span className={metaClass}>
          {ut("adm.createdAt")} {day(row.createdAt)}
        </span>
      </Cell>
      <Cell label={ut("ops.tab.sessions")}>
        <span className="font-mono tabular-nums">{row.sessions}</span>
      </Cell>
      <Cell label={ut("ops.users.state")}>
        <span className="flex flex-wrap items-center gap-[6px]">
          {/*
            Состояние словом, а не цветом: «вимкнено» — метка с текстом. Не
            янтарём и не красным: выключенная учётка не требует внимания и не
            опасна, это просто закрытая дверь.
          */}
          {row.disabledAt ? <Tag>{ut("ops.users.disabledOne")}</Tag> : <span>{ut("ops.users.activeOne")}</span>}
          {row.mustChangePassword ? <Tag>{ut("ops.users.tempMark")}</Tag> : null}
        </span>
        {row.disabledAt ? (
          <span className={metaClass}>
            {day(row.disabledAt)}
            {row.disabledByEmail ? ` · ${row.disabledByEmail}` : ""}
            {row.disabledReason ? ` · ${row.disabledReason}` : ""}
          </span>
        ) : null}
        <span className={metaClass}>
          {trace.length
            ? trace
                .slice(0, 3)
                .map((h) => `${ut(holdKey(h.key))} ${h.count}`)
                .join(" · ") + (trace.length > 3 ? " · …" : "")
            : ut("ops.users.noTrace")}
        </span>
      </Cell>
      <div className="flex justify-end max-[900px]:justify-start">
        <ActionMenu label={`${ut("ops.users.actions")}: ${row.fullName || row.email}`} glyph={<IconDots />} entries={menu} plateClassName="min-w-[280px]" />
      </div>
    </li>
  );
}

/* ─────────── окна ─────────── */

/** Текст отказа сервера — как есть: право и причина читаются словами сервера */
function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/**
 * «Новий обліковий запис»: штатный POST /api/users с паролем, который
 * генерирует экран и показывает один раз, и с отметкой «сменить при входе».
 *
 * Пароль виден и до заведения — его копируют, пока форма открыта, — и
 * последний раз после: окно показывает его вместе с «створено», а закрывшись,
 * забывает. Суперадмина заводит только суперадмин (так решено и на сервере):
 * заведующему с users.manage пункта в выборе нет.
 */
function CreateDialog({ isSuper, onClose, onDone }: { isSuper: boolean; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const [form, setForm] = useState({ lastName: "", firstName: "", middleName: "", email: "" });
  const [role, setRole] = useState<Role>("admin");
  const [password, setPassword] = useState(() => generatePassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  if (created) {
    return (
      <Modal title={ut("adm.newUser")} onClose={onDone}>
        <p className="m-0 mb-[12px] text-[15px] leading-[21px] text-text-2 [overflow-wrap:anywhere]">
          {created}: {ut("ops.users.createdDone")}
        </p>
        <OneTimePassword password={password} />
        <div className="mt-[20px] flex justify-end">
          <Button onClick={onDone}>{ut("ops.users.gotIt")}</Button>
        </div>
      </Modal>
    );
  }

  const ready = form.lastName.trim() && form.firstName.trim() && /\S+@\S+/.test(form.email.trim());

  return (
    <Modal title={ut("adm.newUser")} onClose={onClose}>
      <p className="m-0 mb-[15px] text-[13px] leading-[18px] text-muted">{ut("adm.accountsSub")}</p>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          setBusy(true);
          setError(null);
          api
            .createUser({
              lastName: form.lastName.trim(),
              firstName: form.firstName.trim(),
              middleName: form.middleName.trim() || null,
              email: form.email.trim(),
              password,
              role,
              mustChangePassword: true,
            })
            .then((u) => setCreated(u.email))
            .catch((err) => setError(errorText(err, ut("adm.createFailed"))))
            .finally(() => setBusy(false));
        }}
      >
        <Field label={ut("adm.lastName")}>
          <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} autoFocus required maxLength={80} />
        </Field>
        <Field label={ut("adm.firstName")}>
          <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required maxLength={80} />
        </Field>
        <Field label={ut("adm.middleName")}>
          <Input value={form.middleName} onChange={(e) => setForm({ ...form, middleName: e.target.value })} maxLength={80} />
        </Field>
        <Field label={ut("person.email")}>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoComplete="off" />
        </Field>
        <Field label={ut("adm.role")} labelClassName="mb-[6px] block text-[13px] font-bold text-muted">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">{ut("adm.roleAdmin")}</option>
            <option value="user">{ut("adm.rolePatient")}</option>
            {isSuper ? <option value="superadmin">{ut("adm.roleSuper")}</option> : null}
          </Select>
        </Field>
        <div className="mb-[15px]">
          <span className="mb-[6px] block text-[13px] font-bold text-muted">{ut("ops.users.tempPassword")}</span>
          <OneTimePassword password={password} />
          <Button variant="quiet" className="mt-[6px]" onClick={() => setPassword(generatePassword())}>
            {ut("ops.users.regenerate")}
          </Button>
        </div>
        {error ? <p className="m-0 mb-[15px] text-[13px] text-danger">{error}</p> : null}
        <div className="flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" disabled={!ready || busy}>
            {ut("adm.create")}
          </Button>
        </div>
      </form>
    </Modal>
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
    <Modal title={`${ut("ops.users.changeRole")} · ${row.fullName || row.email}`} onClose={onClose}>
      <Field label={ut("adm.role")} labelClassName="mb-[6px] block text-[13px] font-bold text-muted">
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="admin">{ut("adm.roleAdmin")}</option>
          <option value="user">{ut("adm.rolePatient")}</option>
          {isSuper ? <option value="superadmin">{ut("adm.roleSuper")}</option> : null}
        </Select>
      </Field>
      <p className="m-0 mt-[10px] text-[13px] leading-[18px] text-muted">{ut("ops.users.roleHint")}</p>
      {row.role !== "user" ? (
        <p className="m-0 mt-[10px] text-[13px]">
          <Link to={`/permissions?user=${row.id}`} className="text-primary">
            {ut("ops.users.permissions")}
          </Link>
        </p>
      ) : null}
      <div className="mt-[20px] flex justify-end gap-[14px]">
        <Button variant="ghost" onClick={onClose}>
          {ut("common.cancel")}
        </Button>
        <Button
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
      </div>
    </Modal>
  );
}

function ResetDialog({ row, onClose, onReset }: { row: OpsUserRow; onClose: () => void; onReset: (password: string) => void }) {
  const { ut } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmPlain
      title={ut("ops.users.resetPassword")}
      actionLabel={ut("ops.users.resetPassword")}
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
      <p className="m-0 [overflow-wrap:anywhere]">
        {row.email}: {ut("ops.users.resetWarn")}
      </p>
    </ConfirmPlain>
  );
}

function RevokeDialog({ row, onClose, onDone }: { row: OpsUserRow; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  return (
    <ConfirmPlain
      title={ut("ops.users.revokeSessions")}
      actionLabel={ut("ops.users.revokeSessions")}
      busy={busy}
      onClose={onClose}
      onConfirm={() =>
        void run(async () => {
          await api.revokeUserSessions(row.id);
          onDone();
        }, ut("ops.users.sessionsEnded"))
      }
    >
      <p className="m-0 [overflow-wrap:anywhere]">
        {row.email}: {ut("ops.users.revokeWarn")}
      </p>
    </ConfirmPlain>
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
  return (
    <Modal title={`${ut("ops.users.disable")} · ${row.fullName || row.email}`} onClose={onClose}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length < 3) return;
          void run(async () => {
            await api.disableUser(row.id, reason.trim());
            onDone();
          }, ut("ops.users.disabledDone"));
        }}
      >
        <p className="m-0 mb-[15px] text-[15px] leading-[21px] text-text-2">{ut("ops.users.disableWarn")}</p>
        <Field label={ut("ops.users.reason")}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus required />
        </Field>
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={busy || reason.trim().length < 3}>
            {ut("ops.users.disable")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EnableDialog({ row, onClose, onDone }: { row: OpsUserRow; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  return (
    <ConfirmPlain
      title={ut("ops.users.enable")}
      actionLabel={ut("ops.users.enable")}
      busy={busy}
      onClose={onClose}
      onConfirm={() =>
        void run(async () => {
          await api.enableUser(row.id);
          onDone();
        }, ut("ops.users.enabledDone"))
      }
    >
      <p className="m-0 [overflow-wrap:anywhere]">
        {row.email}
        {row.disabledReason ? ` · ${row.disabledReason}` : ""}
      </p>
      <p className="m-0 mt-[8px]">{ut("ops.users.enableWarn")}</p>
    </ConfirmPlain>
  );
}

/**
 * Удаление: подтверждение перепечатыванием почты.
 *
 * Сюда попадают только строки без следа (см. entriesFor), но решает сервер:
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
  return (
    <ConfirmTyped
      title={ut("ops.users.delete")}
      expected={row.email}
      warning={ut("ops.users.deleteWarn")}
      actionLabel={ut("ops.users.delete")}
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() => {
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
      }}
    />
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
    <Modal title={ut("ops.users.cannotDelete")} onClose={onClose}>
      <p className="m-0 mb-[12px] text-[15px] leading-[21px] text-text-2 [overflow-wrap:anywhere]">
        {row.email}: {ut("ops.users.heldBy")}
      </p>
      <ul className="m-0 mb-[12px] list-none p-0">
        {holds.map((h) => (
          <li key={h.key} className="flex justify-between gap-[12px] border-b border-hairline py-[6px] text-[15px]">
            <span className="text-text-2">{ut(holdKey(h.key))}</span>
            <span className="font-mono tabular-nums text-muted">{h.count}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("ops.users.heldWhy")}</p>
      <div className="mt-[20px] flex justify-end gap-[14px]">
        <Button variant="ghost" onClick={onClose}>
          {ut("common.close")}
        </Button>
        {canDisable ? <Button onClick={onDisable}>{ut("ops.users.disableInstead")}</Button> : null}
      </div>
    </Modal>
  );
}
