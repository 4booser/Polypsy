import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LocalizedText, PermissionEffectKind } from "@quizzy/shared";
import { ROLE_LADDER, roleRank, t } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { daysLeft } from "../format";
import { useLang } from "../lang";
import { useResource, type Resource } from "../useResource";
import {
  Avatar,
  Callout,
  Drawer,
  DrawerSection,
  Empty,
  FilterChip,
  Ic,
  Loading,
  NotLoaded,
  SearchField,
  TextAction,
  Tooltip,
  loadView,
  selectAllState,
  toggleAll,
  useAction,
} from "../ui";
import { cx } from "../ui/cx";
import { Count, Page, Panel } from "../ui/layout";
import { Button, Checkbox, Field, Input, Segmented, Select, Tag } from "../ui/primitives";
import { AIc, dm, fill, plural, shortName } from "./people/parts";

/**
 * Экран прав — Polypsy 2.0, макеты admin-permissions и
 * admin-permissions-person.
 *
 * Отвечает на два вопроса и в этом порядке: что человек может сейчас и
 * почему именно это. Итог без происхождения бесполезен — по нему нельзя
 * решить, что менять: непонятно, пришло право от роли или от исключения.
 *
 * Сверху — действующие исключения в учреждении: их читают через год, когда
 * разбираются, был ли исключение осмыслен, и потому причина и «кто выдал» —
 * прямо в строке. Ниже — матрица «права × ролі»: роль собирается не из
 * кодов, а из последствий, и рядом с правом стоит, что оно открывает
 * (раздел меню, действие, аналитика). Набор правится нажатием клетки; правка
 * копится черновиком и сохраняется одной кнопкой, со строкой «кого
 * торкнеться». Встроенную роль не правит никто — её задаёт справочник.
 *
 * «Права людини» — в ящике: роли (ступенью ниже своей), что может сейчас,
 * что закрыто исключением, личные исключения и добавление нового — с
 * причиной и сроком. Ящик открывается и по адресу (`?user=<id>`): так ведут
 * сюда карточка фахівця и техпанель.
 *
 * Кто что может здесь — решает сервер: наборы ролей, новые роли и
 * исключения — суперадмину, роли людей — по лестнице (ступень ниже своей).
 * Экран не прячет запрещённое, а гасит его с подписью.
 */

interface CataloguePermission {
  code: string;
  title: LocalizedText;
  effect: { kind: PermissionEffectKind; opens: LocalizedText };
}

interface CatalogueGroup {
  code: string;
  title: LocalizedText;
  permissions: CataloguePermission[];
}

interface RoleItem {
  id: string;
  code: string;
  title: LocalizedText;
  isBuiltin: boolean;
  permissions: string[];
  people: number;
  /** вправе ли я выдать эту роль — считает сервер по лестнице должностей */
  assignable: boolean;
}

type ActiveException = Awaited<ReturnType<typeof api.activeExceptions>>[number];

/**
 * Экрану нужны две загрузки сразу — справочник прав и роли; что показать,
 * пока их нет.
 *
 * Раньше отказ справочника показывался голой строкой без «повторить», а
 * отказ ролей не показывался вовсе: экран ждал `rolesRes.data`, которого
 * после отказа не будет, и стоял скелетом, пока человек не перезагрузит
 * страницу. Теперь отказ любой из двух — отказ с текстом, и «Повторити»
 * перечитывает ровно то, что не пришло.
 */
export function gateOf(parts: Pick<Resource<unknown>, "data" | "error" | "reload">[]): {
  view: "wait" | "failed" | "ready";
  error: string | null;
  retry: () => void;
} {
  const failed = parts.filter((r) => r.data === null && r.error);
  const retry = () => {
    for (const r of failed) r.reload();
  };
  if (failed.length) return { view: "failed", error: failed[0]!.error, retry };
  return { view: parts.every((r) => r.data !== null) ? "ready" : "wait", error: null, retry };
}

/** Порядок колонок: встроенная, лестница снизу вверх, потом роли учреждения */
export function roleOrder(roles: RoleItem[]): RoleItem[] {
  const rank = (r: RoleItem) => (r.isBuiltin ? -1 : (ROLE_LADDER as readonly string[]).includes(r.code) ? roleRank(r.code) : 10);
  return [...roles].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

/** Чем черновик роли отличается от сохранённого: что добавлено и что убрано */
export function draftDiff(saved: string[], draft: string[]): { added: string[]; removed: string[] } {
  return { added: draft.filter((c) => !saved.includes(c)), removed: saved.filter((c) => !draft.includes(c)) };
}

/**
 * Роли, у которых черновик набора и правда отличается от сохранённого.
 *
 * По разнице, а не по наличию черновика: клетка, нажатая дважды, вернула
 * набор к сохранённому, и роль больше не правится — ни в строке «кого
 * торкнеться», ни подсветкой колонки.
 */
export function roleChanges<R extends { id: string; permissions: string[] }>(
  roles: R[],
  drafts: Readonly<Record<string, string[]>>,
): { role: R; added: string[]; removed: string[] }[] {
  return roles
    .map((role) => ({ role, ...draftDiff(role.permissions, drafts[role.id] ?? role.permissions) }))
    .filter((c) => c.added.length || c.removed.length);
}

/**
 * Сохранить черновики наборов — роль за ролью. Сохранённая называется сразу
 * (`onSaved`), до следующей: откажет третья — первые две экран покажет
 * сохранёнными, а не прежними, и черновиком останется только несохранённое.
 */
export async function saveRoleSets(
  changes: { id: string; permissions: string[] }[],
  put: (id: string, permissions: string[]) => Promise<unknown>,
  onSaved: (id: string, permissions: string[]) => void,
): Promise<void> {
  for (const c of changes) {
    await put(c.id, c.permissions);
    onSaved(c.id, c.permissions);
  }
}

/** Значок того, что право открывает: раздел меню, действие, аналитика */
function KindIcon({ kind }: { kind: PermissionEffectKind }) {
  if (kind === "action") return <Ic.mousePointer size={15} />;
  if (kind === "analysis") return <Ic.chart size={15} />;
  return <Ic.layers size={15} />;
}

export default function Permissions() {
  const { ut, lang } = useLang();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const { run, busy } = useAction();
  /*
   * Человек из адреса (`?user=<id>`): техпанель и карточка фахівця ведут сюда
   * «права й винятки» конкретного человека, и экран открывается на нём.
   * Выбор пишется обратно в адрес: ссылку на права человека пересылают так
   * же, как на карточку.
   */
  const [params, setParams] = useSearchParams();
  const picked = params.get("user");
  const setPicked = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("user", id);
        else next.delete("user");
        return next;
      },
      { replace: true },
    );
  const [personOpen, setPersonOpen] = useState(!!picked);
  const [creating, setCreating] = useState(false);

  const catalogue = useResource(() => api.permissionCatalogue(), []);
  const rolesRes = useResource(() => api.permissionRoles(), []);
  const staff = useResource(() => api.assignableStaff(), []);
  const active = useResource(() => api.activeExceptions(), []);

  /*
   * Отказ и ожидание — внутри страницы, а не вместо неё: страница без
   * единого заголовка, к которому можно перейти, — хуже отказа с текстом.
   */
  const gate = gateOf([catalogue, rolesRes]);
  if (gate.view !== "ready" || !catalogue.data || !rolesRes.data) {
    return (
      <Page title={ut("perm.title")} sub={ut("perm.sub")}>
        <Loading rows={6} error={gate.error} onRetry={gate.retry} />
      </Page>
    );
  }

  const groups = catalogue.data.groups;
  const total = groups.reduce((n, g) => n + g.permissions.length, 0);
  /* плоский указатель: право по коду — чтобы список не обходился заново на каждую строку */
  const index = new Map<string, CataloguePermission>();
  for (const g of groups) for (const p of g.permissions) index.set(p.code, p);
  const roles = roleOrder(rolesRes.data);
  const exceptions = active.data ?? [];
  const openPerson = (id: string | null) => {
    setPicked(id);
    setPersonOpen(true);
  };

  return (
    <Page
      title={ut("perm.title")}
      meta={[
        fill(ut("adm2.permMeta"), {
          roles: plural(ut("adm2.nRoles"), roles.length, lang),
          rights: plural(ut("adm2.nRights"), total, lang),
          exceptions: plural(ut("adm2.nExceptions"), exceptions.length, lang),
        }),
        ut("perm.sub"),
      ]}
      actions={
        <>
          <Button icon={<AIc.userCog size={15} />} onClick={() => openPerson(picked)} aria-expanded={personOpen}>
            {ut("adm2.personRights")}
          </Button>
          {isSuper ? (
            <Button variant="primary" icon={<Ic.plus size={15} />} onClick={() => setCreating(true)}>
              {ut("perm.newRole")}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ExceptionsPanel
          res={active}
          index={index}
          isSuper={isSuper}
          busy={busy}
          onPerson={openPerson}
          onRevoke={(id) =>
            void run(async () => {
              await api.revokeException(id);
              active.reload();
            }, ut("perm.cancelled"))
          }
        />
        <RoleMatrix
          roles={roles}
          groups={groups}
          exceptions={exceptions}
          editable={isSuper}
          busy={busy}
          onPerson={openPerson}
          onSave={(changes) =>
            run(async () => {
              let shown = rolesRes.data ?? [];
              try {
                await saveRoleSets(changes, api.setRolePermissions, (id, permissions) => {
                  shown = shown.map((r) => (r.id === id ? { ...r, permissions } : r));
                  rolesRes.patch(shown);
                });
              } finally {
                /* и после отказа: что сохранено, а что нет, — по ответу сервера */
                rolesRes.reload();
              }
            }, ut("perm.roleSaved"))
          }
        />
      </div>

      <PersonDrawer
        open={personOpen}
        onClose={() => setPersonOpen(false)}
        onReturn={() => setPersonOpen(true)}
        picked={picked}
        onPick={setPicked}
        staff={staff}
        roles={roles}
        groups={groups}
        index={index}
        exceptionable={catalogue.data.exceptionable}
        total={total}
        isSuper={isSuper}
        onChanged={() => {
          active.reload();
          rolesRes.reload();
        }}
      />
      {isSuper ? (
        <NewRoleDrawer
          open={creating}
          onClose={() => setCreating(false)}
          onReturn={() => setCreating(true)}
          onCreated={() => {
            setCreating(false);
            rolesRes.reload();
          }}
        />
      ) : null}
    </Page>
  );
}

/* ─────────── действующие исключения ─────────── */

function ExceptionsPanel({
  res,
  index,
  isSuper,
  busy,
  onPerson,
  onRevoke,
}: {
  res: Resource<ActiveException[]>;
  index: Map<string, CataloguePermission>;
  isSuper: boolean;
  busy: boolean;
  onPerson: (id: string | null) => void;
  onRevoke: (id: string) => void;
}) {
  const { ut, lang } = useLang();
  const { can } = useAuth();
  const view = loadView(res, (d) => d.length === 0);
  const titleOf = (code: string) => (index.has(code) ? t(index.get(code)!.title, lang) : code);
  return (
    <Panel
      title={ut("perm.activeAll")}
      icon={<AIc.key />}
      count={res.data ? res.data.length : null}
      sub={ut("adm2.exceptionsSub")}
      flush
      actions={
        <>
          {can("audit.read") ? <TextAction to="/ops/audit?action=permission.exception">{ut("adm2.changeLog")}</TextAction> : null}
          {isSuper ? (
            <Button size="xs" icon={<Ic.plus size={14} />} onClick={() => onPerson(null)}>
              {ut("perm.addException")}
            </Button>
          ) : null}
        </>
      }
    >
      {view === "wait" || view === "failed" ? (
        <div className="px-4 pb-4">
          <NotLoaded res={res} />
        </div>
      ) : view === "empty" ? (
        <div className="px-4 pb-4">
          <Empty compact title={ut("perm.noExceptions")} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-body" aria-label={ut("perm.activeAll")}>
            <thead>
              <tr>
                {[ut("perm.person"), ut("adm2.what"), ut("adm2.permission"), ut("adm2.term"), ut("perm.reason")].map((h) => (
                  <th key={h} className="h-[38px] border-y border-divider bg-panel-2 px-2.5 text-left text-caption font-bold text-muted first:pl-4">
                    {h}
                  </th>
                ))}
                <th className="h-[38px] border-y border-divider bg-panel-2 pr-4" aria-label={ut("adm2.rowMenu")} />
              </tr>
            </thead>
            <tbody>
              {(res.data ?? []).map((e) => {
                const left = e.expiresAt ? daysLeft(e.expiresAt, Date.now()) : null;
                return (
                  <tr key={e.id} className="align-top">
                    <td className="border-b border-divider py-3 pl-4 pr-2.5">
                      <button
                        type="button"
                        onClick={() => onPerson(e.userId)}
                        className="flex min-h-0 cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left"
                      >
                        <Avatar name={e.userName} size={30} tone="soft" />
                        <b className="whitespace-nowrap font-bold text-text hover:underline">{shortName(e.userName)}</b>
                      </button>
                    </td>
                    <td className="border-b border-divider px-2.5 py-3.5">
                      <ModeTag mode={e.mode} />
                    </td>
                    <td className="border-b border-divider px-2.5 py-3">
                      <b className="block font-bold leading-[18px] text-text">{titleOf(e.permission)}</b>
                      <code className="font-mono text-[11.5px] text-muted">{e.permission}</code>
                    </td>
                    <td className="whitespace-nowrap border-b border-divider px-2.5 py-3">
                      {e.expiresAt ? (
                        <>
                          <span className="block tabular-nums text-text">{fill(ut("adm2.untilDate"), { date: dm(e.expiresAt) })}</span>
                          <small className={cx("block text-caption", left !== null && left <= 2 ? "font-bold text-warn" : "text-muted")}>
                            {left === null ? ut("opsp.grant.expired") : left <= 1 ? ut("perm.lastDay") : `${left} ${ut("perm.daysLeft")}`}
                          </small>
                        </>
                      ) : (
                        <span className="text-text-2">{ut("perm.forever")}</span>
                      )}
                    </td>
                    <td className="max-w-[360px] border-b border-divider px-2.5 py-3">
                      <span className="block text-small leading-[18px] text-text">{e.reason}</span>
                      <small className="block text-caption text-muted">
                        {fill(ut("adm2.grantedBy"), { who: e.grantedByName ? shortName(e.grantedByName) : "—", date: dm(e.grantedAt) })}
                      </small>
                    </td>
                    <td className="border-b border-divider py-3 pr-4 text-right">
                      {isSuper ? (
                        <Button variant="ghost" size="xs" disabled={busy} onClick={() => onRevoke(e.id)}>
                          {ut("perm.cancel")}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ModeTag({ mode }: { mode: "grant" | "revoke" }) {
  const { ut } = useLang();
  return mode === "grant" ? (
    <Tag tone="primary" icon={<Ic.plus />}>
      {ut("adm2.granted")}
    </Tag>
  ) : (
    <Tag icon={<Ic.minus />}>{ut("adm2.revoked")}</Tag>
  );
}

/* ─────────── матрица ролей ─────────── */

type KindView = "all" | PermissionEffectKind;

function RoleMatrix({
  roles,
  groups,
  exceptions,
  editable,
  busy,
  onPerson,
  onSave,
}: {
  roles: RoleItem[];
  groups: CatalogueGroup[];
  exceptions: ActiveException[];
  editable: boolean;
  busy: boolean;
  onPerson: (id: string) => void;
  /** true — сохранено всё; иначе черновик остаётся, сохранённое уже в ролях */
  onSave: (changes: { id: string; permissions: string[] }[]) => Promise<boolean>;
}) {
  const { ut, lang } = useLang();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KindView>("all");
  const [diffOnly, setDiffOnly] = useState(false);
  /* черновики наборов по ролям: что нажато, но ещё не сохранено */
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const setOf = (r: RoleItem) => drafts[r.id] ?? r.permissions;
  const changed = roleChanges(roles, drafts);
  const editing = new Set(changed.map((c) => c.role.id));

  const all = groups.flatMap((g) => g.permissions);
  const kindCount = (k: KindView) => (k === "all" ? all.length : all.filter((p) => p.effect.kind === k).length);
  const needle = q.trim().toLowerCase();
  const shown = (p: CataloguePermission) =>
    (kind === "all" || p.effect.kind === kind) &&
    (!needle || `${t(p.title, lang)} ${p.code}`.toLowerCase().includes(needle)) &&
    (!diffOnly || new Set(roles.map((r) => setOf(r).includes(p.code))).size > 1);
  const byPermission = new Map<string, ActiveException[]>();
  for (const e of exceptions) byPermission.set(e.permission, [...(byPermission.get(e.permission) ?? []), e]);

  const toggle = (r: RoleItem, code: string) => {
    const cur = setOf(r);
    const next = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
    setDrafts((d) => ({ ...d, [r.id]: next }));
  };
  /*
   * Все права группы у роли разом — отметка в строке группы. Действует на
   * показанные строки, как «выбрать все» таблицы: поиск или вид сузили
   * группу — меняется то, что на экране, а не скрытое за фильтром.
   */
  const toggleGroup = (r: RoleItem, codes: string[]) =>
    setDrafts((d) => ({ ...d, [r.id]: [...toggleAll(codes, new Set(d[r.id] ?? r.permissions))] }));

  const kinds: { key: KindView; label: string }[] = [
    { key: "all", label: ut("adm2.viewAll") },
    { key: "screen", label: ut("perm.kind.screen") },
    { key: "action", label: ut("adm2.kindActions") },
    { key: "analysis", label: ut("adm2.kindAnalysis") },
  ];

  return (
    <Panel title={ut("adm2.rolesAndPermissions")} icon={<AIc.shieldHalf />} sub={ut("perm.builtinHint")} flush>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5">
        <SearchField value={q} onChange={setQ} placeholder={ut("adm2.searchPermission")} slash width={240} />
        <div role="group" aria-label={ut("kit.savedViews")} className="flex flex-wrap gap-[5px]">
          {kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={kind === k.key}
              onClick={() => setKind(k.key)}
              className={cx(
                "inline-flex h-8 min-h-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-2xl border-0 px-2.5 text-small leading-none",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                kind === k.key ? "bg-violet font-bold text-onfill" : "bg-sunk font-semibold text-text-2 hover:bg-sunk-2 hover:text-text",
              )}
            >
              {k.label}
              <span className={cx("font-bold tabular-nums", kind === k.key ? "text-onfill-muted" : "text-muted")}>{kindCount(k.key)}</span>
            </button>
          ))}
        </div>
        <FilterChip label={ut("adm2.diffOnly")} on={diffOnly} onClick={() => setDiffOnly((v) => !v)} onClear={() => setDiffOnly(false)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 pb-3 text-caption text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Cell state="on" label={ut("adm2.markRole")} />
          {ut("adm2.markRole")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Cell state="builtin" label={ut("adm2.markBuiltin")} />
          {ut("adm2.markBuiltin")}
        </span>
        {editable ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <Cell state="added" label={ut("adm2.markAdded")} />
              {ut("adm2.markAdded")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Cell state="removed" label={ut("adm2.markRemoved")} />
              {ut("adm2.markRemoved")}
            </span>
          </>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <Cell state="off" label={ut("adm2.markOff")} />
          {ut("adm2.markOff")}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-body" aria-label={ut("adm2.rolesAndPermissions")}>
          <thead>
            <tr>
              <th className="sticky top-[var(--sticky-top,0px)] z-[3] min-w-[260px] border-y border-divider bg-panel-2 px-4 py-2 text-left align-bottom text-caption font-bold text-muted">
                {ut("adm2.permission")}
              </th>
              {roles.map((r) => (
                <th
                  key={r.id}
                  className={cx(
                    "sticky top-[var(--sticky-top,0px)] z-[3] w-[112px] border-y border-divider px-2 py-2 text-center align-bottom",
                    editing.has(r.id) ? "bg-violet-tint" : "bg-panel-2",
                  )}
                >
                  <span className="flex flex-col items-center gap-1">
                    <b className="inline-flex items-center gap-1 text-small font-extrabold leading-[16px] text-text">
                      {t(r.title, lang)}
                      {r.isBuiltin ? <Ic.lock size={12} className="text-muted" /> : null}
                    </b>
                    <RoleTag role={r} />
                    <small className="text-caption font-medium text-muted">{plural(ut("adm2.nPeople"), r.people, lang)}</small>
                  </span>
                </th>
              ))}
              <th className="sticky top-[var(--sticky-top,0px)] z-[3] min-w-[170px] border-y border-divider bg-panel-2 px-3 py-2 text-left align-bottom text-caption font-bold text-muted">
                {ut("perm.exceptions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const rows = g.permissions.filter(shown);
              if (!rows.length) return null;
              return [
                <tr key={g.code}>
                  <th scope="rowgroup" className="border-b border-divider bg-panel-2 px-4 py-2 text-left text-small font-extrabold text-text">
                    {t(g.title, lang)}
                  </th>
                  {roles.map((r) => {
                    const own = setOf(r);
                    const tally = fill(ut("adm2.nOf"), { n: g.permissions.filter((p) => own.includes(p.code)).length, total: g.permissions.length });
                    const codes = rows.map((p) => p.code);
                    const state = selectAllState(codes, new Set(own));
                    return (
                      <td key={r.id} className={cx("border-b border-divider px-2 py-2 text-center text-caption tabular-nums text-muted", editing.has(r.id) ? "bg-violet-tint" : "bg-panel-2")}>
                        {editable && !r.isBuiltin ? (
                          <label className="m-0 inline-flex cursor-pointer items-center gap-1.5">
                            <Checkbox
                              checked={state === "all"}
                              indeterminate={state === "some"}
                              disabled={busy}
                              aria-label={fill(ut("adm2.groupAll"), { role: t(r.title, lang), group: t(g.title, lang) })}
                              onChange={() => toggleGroup(r, codes)}
                            />
                            {tally}
                          </label>
                        ) : (
                          tally
                        )}
                      </td>
                    );
                  })}
                  <td className="border-b border-divider bg-panel-2" />
                </tr>,
                ...rows.map((p) => (
                  <tr key={p.code}>
                    <th scope="row" className="border-b border-divider px-4 py-2 text-left font-normal">
                      <span className="flex items-start gap-2.5">
                        <Tooltip label={t(p.effect.opens, lang)}>
                          <span tabIndex={0} className="mt-px text-muted outline-none focus-visible:text-violet-ink">
                            <KindIcon kind={p.effect.kind} />
                          </span>
                        </Tooltip>
                        <span className="min-w-0">
                          <b className="block font-bold leading-[18px] text-text">{t(p.title, lang)}</b>
                          <code className="font-mono text-[11.5px] text-muted">{p.code}</code>
                        </span>
                      </span>
                    </th>
                    {roles.map((r) => {
                      const now = setOf(r).includes(p.code);
                      const was = r.permissions.includes(p.code);
                      const state = r.isBuiltin ? (now ? "builtin" : "off") : now && !was ? "added" : !now && was ? "removed" : now ? "on" : "off";
                      const label = `${t(r.title, lang)}: ${t(p.title, lang)} — ${now ? ut("adm2.markRole") : ut("adm2.markOff")}`;
                      const canEdit = editable && !r.isBuiltin;
                      return (
                        <td key={r.id} className={cx("border-b border-divider px-2 py-2 text-center", editing.has(r.id) && "bg-violet-tint/60")}>
                          {canEdit ? (
                            <button
                              type="button"
                              aria-pressed={now}
                              aria-label={label}
                              disabled={busy}
                              onClick={() => toggle(r, p.code)}
                              className="inline-grid min-h-0 cursor-pointer place-items-center rounded-[8px] border-0 bg-transparent p-0.5 outline-none focus-visible:outline-2 focus-visible:outline-focus"
                            >
                              <Cell state={state} />
                            </button>
                          ) : (
                            <Cell state={state} label={label} />
                          )}
                        </td>
                      );
                    })}
                    <td className="border-b border-divider px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {(byPermission.get(p.code) ?? []).map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => onPerson(e.userId)}
                            className="inline-flex h-6 min-h-0 cursor-pointer items-center gap-1 rounded-pill border-0 bg-violet-tint px-2 text-[11.5px] font-bold text-violet-ink hover:bg-violet-tint-2"
                          >
                            <AIc.key size={11} />
                            {shortName(e.userName)} {e.mode === "grant" ? ut("adm2.granted") : ut("adm2.revoked")}
                          </button>
                        ))}
                      </span>
                    </td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
      {changed.length ? (
        <div className="sticky bottom-0 z-[4] flex flex-wrap items-center gap-3 border-t border-divider bg-violet-tint px-4 py-3">
          <Ic.pen size={15} className="text-violet-ink" />
          <span className="min-w-0 flex-1 text-small text-text">
            {changed.map((c) => (
              <span key={c.role.id} className="mr-3 inline-block">
                <b className="font-extrabold text-violet-ink">{fill(ut("adm2.roleChanged"), { role: t(c.role.title, lang) })}</b>{" "}
                {fill(ut("adm2.roleChangedDetail"), {
                  added: plural(ut("adm2.nRightsAdded"), c.added.length, lang),
                  removed: plural(ut("adm2.nRightsRemoved"), c.removed.length, lang),
                  people: plural(ut("adm2.nPeopleAcc"), c.role.people, lang),
                })}
              </span>
            ))}
          </span>
          <Button variant="ghost" size="xs" onClick={() => setDrafts({})} disabled={busy}>
            {ut("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="xs"
            icon={<Ic.check size={14} />}
            disabled={busy}
            onClick={() =>
              /* черновик снимается после сохранения, а не до: отказ не стирает нажатое */
              void onSave(changed.map((c) => ({ id: c.role.id, permissions: setOf(c.role) }))).then((ok) => {
                if (ok) setDrafts({});
              })
            }
          >
            {ut("perm.saveRole")}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

function RoleTag({ role }: { role: RoleItem }) {
  const { ut } = useLang();
  if (role.isBuiltin) return <Tag>{ut("perm.builtin")}</Tag>;
  if ((ROLE_LADDER as readonly string[]).includes(role.code)) return <Tag>{fill(ut("adm2.stepN"), { n: roleRank(role.code) })}</Tag>;
  return <Tag tone="info">{ut("perm.outsideChain")}</Tag>;
}

/** Клетка матрицы: даёт роль, даёт встроенная, добавлено/убрано черновиком, не даёт */
function Cell({ state, label }: { state: "on" | "builtin" | "added" | "removed" | "off"; label?: string }) {
  const box = "inline-grid size-[22px] place-items-center rounded-[7px]";
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  if (state === "on")
    return (
      <span {...a11y} className={cx(box, "bg-violet text-onfill")}>
        <Ic.check size={13} />
      </span>
    );
  if (state === "builtin")
    return (
      <span {...a11y} className={cx(box, "bg-violet-tint text-violet-ink")}>
        <Ic.check size={13} />
      </span>
    );
  if (state === "added")
    return (
      <span {...a11y} className={cx(box, "bg-violet text-onfill shadow-[0_0_0_2px_var(--panel),0_0_0_4px_var(--vring)]")}>
        <Ic.plus size={13} />
      </span>
    );
  if (state === "removed")
    return (
      <span {...a11y} className={cx(box, "border border-dashed border-text-2 text-text-2")}>
        <Ic.minus size={13} />
      </span>
    );
  return <span {...a11y} className={cx(box, "border border-field-border")} />;
}

/* ─────────── права человека ─────────── */

function PersonDrawer({
  open,
  onClose,
  onReturn,
  picked,
  onPick,
  staff,
  roles,
  groups,
  index,
  exceptionable,
  total,
  isSuper,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onReturn: () => void;
  picked: string | null;
  onPick: (id: string | null) => void;
  staff: Resource<{ id: string; email: string; role: string; fullName: string }[]>;
  roles: RoleItem[];
  groups: CatalogueGroup[];
  index: Map<string, CataloguePermission>;
  exceptionable: string[];
  total: number;
  isSuper: boolean;
  onChanged: () => void;
}) {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const [query, setQuery] = useState("");
  const card = useResource(() => api.userPermissions(picked!), [picked], { enabled: !!picked });
  const [adding, setAdding] = useState<string | null>(null);
  const [mode, setMode] = useState<"grant" | "revoke">("grant");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("");
  const titleOf = (code: string): string => (index.has(code) ? t(index.get(code)!.title, lang) : code);
  const opensOf = (code: string): string => (index.has(code) ? t(index.get(code)!.effect.opens, lang) : code);
  const pick = (code: string, effective: string[]) => {
    setAdding(code);
    setMode(effective.includes(code) ? "revoke" : "grant");
  };
  const people = (staff.data ?? []).filter((u) => `${u.fullName} ${u.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  /*
   * Карточка — только выбранного человека. Слой загрузки держит прежний
   * ответ, пока едет новый: после выбора другого человека здесь стояла бы
   * карточка предыдущего — с живыми кнопками, которые меняли бы права не
   * того, кто выбран.
   */
  const c = card.data?.userId === picked ? card.data : null;
  const dirty = !!adding && reason.trim().length > 0;

  const addFooter =
    c && isSuper && adding ? (
      <>
        <Button
          variant="primary"
          icon={<AIc.key size={15} />}
          disabled={busy || reason.trim().length < 10}
          onClick={() =>
            void run(async () => {
              await api.addException(c.userId, { permission: adding, mode, reason: reason.trim(), days: days ? Number(days) : undefined });
              setAdding(null);
              setReason("");
              setDays("");
              card.reload();
              onChanged();
            }, ut("perm.added"))
          }
        >
          {ut("perm.addException")}
        </Button>
        <Button variant="ghost" onClick={() => setAdding(null)}>
          {ut("common.cancel")}
        </Button>
      </>
    ) : undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      wide
      title={ut("adm2.personRights")}
      sub={ut("adm2.personRightsSub")}
      icon={<AIc.userCog />}
      dirty={dirty}
      draftName={ut("adm2.draftException")}
      note={addFooter ? ut("adm2.loggedNote") : undefined}
      noteIcon={addFooter ? <Ic.file size={14} /> : undefined}
      footer={addFooter}
    >
      {!picked ? (
        <DrawerSection title={ut("perm.pickPerson")} sub={ut("adm2.pickPersonSub")}>
          <SearchField value={query} onChange={setQuery} placeholder={ut("adm2.searchAdmins")} width={0} />
          <div className="mt-2 flex max-h-[420px] flex-col overflow-y-auto">
            {loadView(staff) === "wait" || loadView(staff) === "failed" ? (
              <NotLoaded res={staff} />
            ) : people.length ? (
              people.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => onPick(u.id)}
                  className="flex min-h-0 w-full cursor-pointer items-center gap-2.5 rounded-control border-0 bg-transparent px-2 py-2 text-left hover:bg-sunk"
                >
                  <Avatar name={u.fullName} size={30} tone="soft" />
                  <span className="min-w-0">
                    <b className="block truncate text-small font-bold text-text">{u.fullName}</b>
                    <small className="block truncate text-caption text-muted">{u.email}</small>
                  </span>
                </button>
              ))
            ) : (
              <Empty compact title={ut("pt.nobodyFound")} />
            )}
          </div>
        </DrawerSection>
      ) : !c ? (
        <DrawerSection>
          <NotLoaded res={card} rows={4} />
        </DrawerSection>
      ) : (
        <PersonView
          c={c}
          roles={roles}
          groups={groups}
          total={total}
          isSuper={isSuper}
          busy={busy}
          titleOf={titleOf}
          opensOf={opensOf}
          exceptionable={exceptionable}
          adding={adding}
          mode={mode}
          reason={reason}
          days={days}
          onAdd={pick}
          setMode={setMode}
          setReason={setReason}
          setDays={setDays}
          onOther={() => onPick(null)}
          onRoles={(next) =>
            void run(async () => {
              await api.setUserRoles(c.userId, next);
              /*
               * Карточка — свежей и до конца действия: следующий набор считается
               * от её ролей, и вторая галочка, нажатая раньше перечитывания,
               * отправила бы набор без первой — та молча снялась бы.
               */
              card.patch(await api.userPermissions(c.userId));
              onChanged();
            })
          }
          onRevoke={(id) =>
            void run(async () => {
              await api.revokeException(id);
              card.reload();
              onChanged();
            }, ut("perm.cancelled"))
          }
        />
      )}
    </Drawer>
  );
}

type PersonCard = Awaited<ReturnType<typeof api.userPermissions>>;

function PersonView({
  c,
  roles,
  groups,
  total,
  isSuper,
  busy,
  titleOf,
  opensOf,
  exceptionable,
  adding,
  mode,
  reason,
  days,
  onAdd,
  setMode,
  setReason,
  setDays,
  onOther,
  onRoles,
  onRevoke,
}: {
  c: PersonCard;
  roles: RoleItem[];
  groups: CatalogueGroup[];
  total: number;
  isSuper: boolean;
  busy: boolean;
  titleOf: (code: string) => string;
  opensOf: (code: string) => string;
  exceptionable: string[];
  adding: string | null;
  mode: "grant" | "revoke";
  reason: string;
  days: string;
  onAdd: (code: string, effective: string[]) => void;
  setMode: (m: "grant" | "revoke") => void;
  setReason: (v: string) => void;
  setDays: (v: string) => void;
  onOther: () => void;
  onRoles: (roleIds: string[]) => void;
  onRevoke: (id: string) => void;
}) {
  const { ut, lang } = useLang();
  const [allShown, setAllShown] = useState(false);
  const targetSuper = c.role === "superadmin";
  const live = c.exceptions.filter((e) => !e.revokedAt && (!e.expiresAt || new Date(e.expiresAt) > new Date()));
  /*
   * Что даёт роль — отдельно от итога. Разница между двумя списками и есть
   * работа исключений: что добавлено сверх роли и что отнято вопреки ей.
   * Отнятое не видно в итоге вовсе — а спрашивают чаще всего именно про него.
   */
  const mine = new Set(c.roles.map((r) => r.roleId));
  const fromRoles = new Set(roles.filter((r) => mine.has(r.id)).flatMap((r) => r.permissions));
  const byException = c.effective.filter((p) => !fromRoles.has(p));
  const takenAway = [...fromRoles].filter((p) => !c.effective.includes(p));
  const effectiveShown = allShown ? c.effective : c.effective.slice(0, 8);

  return (
    <>
      <DrawerSection>
        <div className="flex items-center gap-3 rounded-panel bg-sunk p-3">
          <Avatar name={c.fullName} size={40} tone="soft" />
          <span className="min-w-0 flex-1">
            <b className="block truncate text-body font-extrabold text-text">{c.fullName}</b>
            <small className="block text-caption text-muted">{targetSuper ? ut("perm.superadminTitle") : ut("adm2.staffClass")}</small>
          </span>
          <Button size="xs" icon={<AIc.transfer size={14} />} onClick={onOther}>
            {ut("adm2.otherPerson")}
          </Button>
        </div>
      </DrawerSection>

      {targetSuper ? (
        /* суперадмину права не раздают: он обходит справочник целиком — сказать это дешевле, чем показать галочки, которые ничего не меняют */
        <DrawerSection>
          <Callout kind="violet">{ut("perm.superadminNote")}</Callout>
        </DrawerSection>
      ) : (
        <>
          <DrawerSection title={ut("perm.fromRoles")} sub={ut("adm2.lowerSteps")}>
            <div className="flex flex-col gap-2">
              {roles.map((r) => {
                /*
                 * Роль не ниже собственной показывается, но не нажимается: спрятать
                 * её — значит нарисовать лестницу, обрывающуюся на читателе.
                 */
                const locked = r.isBuiltin || !r.assignable;
                return (
                  <label key={r.id} className={cx("m-0 flex items-start gap-2.5", locked ? "cursor-default" : "cursor-pointer")}>
                    <Checkbox
                      checked={mine.has(r.id)}
                      disabled={busy || locked}
                      className="mt-px"
                      onChange={(e) => {
                        const ids = c.roles.map((x) => x.roleId);
                        onRoles(e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id));
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <b className="block text-small font-bold text-text">{t(r.title, lang)}</b>
                      <small className="block text-caption text-muted">
                        {r.isBuiltin
                          ? ut("adm2.builtinEveryone")
                          : (ROLE_LADDER as readonly string[]).includes(r.code)
                            ? fill(ut("adm2.stepN"), { n: roleRank(r.code) })
                            : ut("perm.outsideChain")}
                        {!r.isBuiltin && !r.assignable ? `; ${ut("perm.notYours")}` : ""}
                      </small>
                    </span>
                    {locked ? <Ic.lock size={13} className="mt-1 text-muted" /> : null}
                  </label>
                );
              })}
            </div>
          </DrawerSection>

          <DrawerSection title={ut("perm.effective")} sub={fill(ut("adm2.rightsOfShort"), { n: c.effective.length, total })}>
            <div className="flex flex-wrap gap-1.5">
              {effectiveShown.map((code) => (
                <Tooltip key={code} label={opensOf(code)}>
                  <span tabIndex={0} className="inline-flex h-7 items-center rounded-pill bg-sunk px-2.5 text-caption font-bold text-text-2 outline-none focus-visible:outline-2 focus-visible:outline-focus">
                    {titleOf(code)}
                  </span>
                </Tooltip>
              ))}
              {c.effective.length > 8 ? (
                <button
                  type="button"
                  onClick={() => setAllShown((v) => !v)}
                  className="inline-flex h-7 min-h-0 cursor-pointer items-center rounded-pill border-0 bg-violet-tint px-2.5 text-caption font-bold text-violet-ink"
                >
                  {allShown ? ut("adm2.showLess") : fill(ut("adm2.andMore"), { n: c.effective.length - 8 })}
                </button>
              ) : null}
            </div>
            {byException.length ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Tag tone="primary" icon={<Ic.plus />}>
                  {ut("adm2.byException")}
                </Tag>
                {byException.map((p) => (
                  <span key={p} className="text-small font-bold text-text">
                    {titleOf(p)}
                  </span>
                ))}
              </div>
            ) : null}
            {takenAway.length ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Tag icon={<Ic.minus />}>{ut("perm.closedList")}</Tag>
                {takenAway.map((p) => (
                  <span key={p} className="text-small font-bold text-text">
                    {titleOf(p)}
                  </span>
                ))}
              </div>
            ) : null}
          </DrawerSection>

          <DrawerSection title={ut("perm.exceptions")} right={<Count n={live.length} />}>
            {live.length ? (
              <div className="flex flex-col gap-2">
                {live.map((e) => (
                  <div key={e.id} className="rounded-panel border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <ModeTag mode={e.mode} />
                      <b className="text-small font-extrabold text-text">{titleOf(e.permission)}</b>
                      <span className="ml-auto text-caption text-muted">
                        {e.expiresAt ? fill(ut("adm2.untilDate"), { date: dm(e.expiresAt) }) : ut("perm.forever")}
                      </span>
                    </div>
                    <p className="m-0 mt-1.5 text-small text-text">{e.reason}</p>
                    <p className="m-0 mt-1 text-caption text-muted">
                      {e.mode === "grant" ? ut("perm.willOpen") : ut("perm.willClose")}: {opensOf(e.permission)}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-caption text-muted">{dm(e.grantedAt)}</span>
                      {isSuper ? (
                        <Button size="xs" className="ml-auto" disabled={busy} onClick={() => onRevoke(e.id)}>
                          {ut("perm.cancel")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="m-0 text-small text-muted">{ut("perm.noExceptions")}</p>
            )}
          </DrawerSection>

          {isSuper ? (
            <DrawerSection title={ut("perm.addException")} sub={ut("perm.quickHint")}>
              <div className="flex flex-wrap gap-1.5">
                {exceptionable.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={adding === p}
                    onClick={() => onAdd(p, c.effective)}
                    className={cx(
                      "inline-flex h-8 min-h-0 cursor-pointer items-center rounded-2xl border-0 px-3 text-small font-bold",
                      adding === p ? "bg-violet text-onfill" : "bg-violet-tint text-violet-ink hover:bg-violet-tint-2",
                    )}
                  >
                    {titleOf(p)}
                  </button>
                ))}
              </div>
              <div className="mt-3 grid gap-x-3 min-[520px]:grid-cols-[minmax(0,1fr)_auto]">
                <Field label={ut("adm2.permission")}>
                  <Select value={adding ?? ""} onChange={(e) => e.target.value && onAdd(e.target.value, c.effective)}>
                    <option value="">{ut("perm.pickPermission")}</option>
                    {groups.map((g) => (
                      <optgroup key={g.code} label={t(g.title, lang) || g.code}>
                        {g.permissions.map((p) => (
                          <option key={p.code} value={p.code}>
                            {t(p.title, lang)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                </Field>
                <Field label={ut("adm2.action")}>
                  <Segmented
                    label={ut("adm2.action")}
                    value={mode}
                    onChange={setMode}
                    items={[
                      { key: "grant", label: ut("perm.grant") },
                      { key: "revoke", label: ut("perm.revoke") },
                    ]}
                  />
                </Field>
              </div>
              {adding ? (
                <>
                  {/* последствие названо до нажатия: «выдать surveys.edit» и «откроет ключи подсчёта» — одно действие, но второе останавливает */}
                  <Callout kind="violet" title={mode === "grant" ? ut("perm.willOpen") : ut("perm.willClose")}>
                    {opensOf(adding)}
                  </Callout>
                  {mode === "revoke" && !c.effective.includes(adding) ? (
                    <p className="m-0 mt-2 text-caption text-muted">{ut("perm.closedByException")}</p>
                  ) : null}
                  <div className="mt-3 grid gap-x-3 min-[520px]:grid-cols-[minmax(0,1fr)_140px]">
                    <Field label={ut("perm.reason")} hint={ut("perm.reasonHint")}>
                      <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                    </Field>
                    <Field label={ut("perm.days")} hint={ut("perm.forever")}>
                      <Input value={days} inputMode="numeric" onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} />
                    </Field>
                  </div>
                </>
              ) : null}
            </DrawerSection>
          ) : null}
        </>
      )}
    </>
  );
}

/* ─────────── новая роль ─────────── */

/**
 * Новая роль заводится пустой: набор прав отмечают уже в матрице. Так меньше
 * шагов до понятного состояния — роль сразу видна колонкой рядом с
 * остальными, и её набор правится тем же способом, что и у прочих.
 */
function NewRoleDrawer({
  open,
  onClose,
  onReturn,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** «Повернутися» из всплывашки «чернетку збережено»: ящик закрыли с набранным */
  onReturn: () => void;
  onCreated: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const dirty = !!(code || title);
  const ready = code.length >= 2 && title.trim().length >= 2;
  const preview = useMemo(() => code.replace(/[^a-z0-9_-]/g, ""), [code]);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      title={ut("perm.newRole")}
      sub={ut("adm2.newRoleSub")}
      icon={<AIc.shieldHalf />}
      dirty={dirty}
      draftName={ut("adm2.draftRole")}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Ic.check size={15} />}
            disabled={busy || !ready}
            onClick={() =>
              void run(async () => {
                await api.createRole({ code: preview, title: { uk: title.trim(), ru: title.trim() }, permissions: [] });
                setCode("");
                setTitle("");
                onCreated();
              }, ut("adm2.roleCreated"))
            }
          >
            {ut("perm.newRole")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <DrawerSection>
        <Field label={ut("perm.roleTitle")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} data-autofocus />
        </Field>
        <Field label={ut("perm.roleCode")} hint={ut("perm.roleCodeHint")}>
          <Input value={code} onChange={(e) => setCode(e.target.value.replace(/[^a-z0-9_-]/g, ""))} maxLength={40} className="font-mono" />
        </Field>
        <p className="m-0 text-small text-muted">{ut("adm2.newRoleNote")}</p>
      </DrawerSection>
    </Drawer>
  );
}
