import { useState } from "react";
import type { LocalizedText } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Loading, Search, useAction } from "../ui";
import { Grid, Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, SectionLabel, Tag } from "../ui/primitives";

/**
 * Экран прав.
 *
 * Отвечает на два вопроса и в этом порядке: что человек может сейчас и
 * почему именно это. Итог без происхождения бесполезен — по нему нельзя
 * решить, что менять: непонятно, пришло право от роли или от исключения, и
 * что снимать.
 *
 * Роли слева, человек справа. Так потому, что роль настраивают редко, а
 * права конкретному человеку смотрят часто — и обычно приходят на этот экран
 * именно за вторым.
 */
export default function Permissions() {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newTitle, setNewTitle] = useState("");

  const catalogue = useResource(() => api.permissionCatalogue(), []);
  const rolesRes = useResource(() => api.permissionRoles(), []);
  const staff = useResource(() => api.users(), []);
  const active = useResource(() => api.activeExceptions(), []);
  const card = useResource(() => api.userPermissions(picked!), [picked], { enabled: !!picked });

  /* язык оболочки, с откатом: у методик перевод бывает неполным, у справочника прав — нет,
     но одна и та же функция ходит по обоим */
  const t = (v: LocalizedText): string => v[lang] ?? v.uk ?? v.ru ?? "";
  const titleOf = (code: string): string => {
    for (const g of catalogue.data?.groups ?? []) {
      const found = g.permissions.find((p) => p.code === code);
      if (found) return t(found.title);
    }
    return code;
  };

  if (catalogue.error) return <p className="text-danger">{catalogue.error}</p>;
  if (!catalogue.data || !rolesRes.data) return <Loading rows={6} />;

  const people = (staff.data ?? []).filter(
    (u) => u.role !== "user" && `${u.fullName} ${u.email}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <Page title={ut("perm.title")} sub={ut("perm.sub")}>
      <Grid min={420}>
        <Stack>
          <Panel
            title={ut("perm.roles")}
            hint={ut("perm.builtinHint")}
            actions={
              <Button size="sm" onClick={() => setCreating((v) => !v)}>
                {ut("perm.newRole")}
              </Button>
            }
          >
            {creating ? (
              /*
                Новая роль заводится пустой: набор прав отмечают уже в ней.
                Так меньше шагов до понятного состояния — роль сразу видна в
                списке рядом с остальными, и её набор правится тем же способом,
                что и у прочих, а не отдельной формой, которую надо помнить.
              */
              <div className="mb-4 flex flex-col gap-3 rounded-md bg-surface-2 p-4">
                <Field label={ut("perm.roleTitle")}>
                  <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
                </Field>
                <Field label={ut("perm.roleCode")} hint={ut("perm.roleCodeHint")}>
                  <Input
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value.replace(/[^a-z0-9_-]/g, ""))}
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    disabled={busy || newCode.length < 2 || newTitle.trim().length < 2}
                    onClick={() =>
                      void run(async () => {
                        await api.createRole({
                          code: newCode,
                          title: { uk: newTitle.trim(), ru: newTitle.trim() },
                          permissions: [],
                        });
                        setCreating(false);
                        setNewCode("");
                        setNewTitle("");
                        rolesRes.reload();
                      })
                    }
                  >
                    {ut("perm.newRole")}
                  </Button>
                  <Button variant="quiet" onClick={() => setCreating(false)}>
                    {ut("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              {rolesRes.data.map((role) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  groups={catalogue.data!.groups}
                  lang={lang}
                  busy={busy}
                  onSave={(permissions) =>
                    void run(async () => {
                      await api.setRolePermissions(role.id, permissions);
                      rolesRes.reload();
                    }, ut("perm.roleSaved"))
                  }
                />
              ))}
            </div>
          </Panel>

          <Panel title={ut("perm.activeAll")} flush>
            {(active.data ?? []).length === 0 ? (
              <p className="m-0 px-5 pb-5 text-caption text-muted">{ut("perm.noExceptions")}</p>
            ) : (
              <div className="flex flex-col">
                {(active.data ?? []).map((e) => (
                  <div key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-hairline px-5 py-2.5">
                    <button
                      type="button"
                      className="min-h-0 border-0 bg-transparent p-0 text-small font-medium text-primary"
                      onClick={() => setPicked(e.userId)}
                    >
                      {e.userName}
                    </button>
                    <Tag tone={e.mode === "grant" ? "primary" : "danger"}>
                      {e.mode === "grant" ? ut("perm.grant") : ut("perm.revoke")}
                    </Tag>
                    <span className="text-small">{titleOf(e.permission)}</span>
                    <span className="w-full text-caption text-muted">
                      {e.reason}
                      {" · "}
                      {e.expiresAt ? `${ut("perm.until")} ${day(e.expiresAt)}` : ut("perm.forever")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </Stack>

        <Stack>
          <Panel
            title={ut("perm.person")}
            actions={<Search value={query} onChange={setQuery} placeholder={ut("ui.search")} />}
            flush
          >
            <div className="max-h-[260px] overflow-y-auto">
              {people.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setPicked(u.id)}
                  className={`flex w-full items-center justify-between gap-3 border-t border-hairline px-5 py-2 text-left text-small ${
                    picked === u.id ? "bg-surface-2 font-medium" : "hover:bg-surface-2"
                  }`}
                >
                  <span className="truncate">{u.fullName}</span>
                  <span className="shrink-0 text-caption text-muted">{u.email}</span>
                </button>
              ))}
            </div>
          </Panel>

          {!picked ? (
            <p className="text-caption text-muted">{ut("perm.pickPerson")}</p>
          ) : card.loading ? (
            <Loading rows={4} />
          ) : card.data ? (
            <PersonCard
              card={card.data}
              roles={rolesRes.data}
              exceptionable={catalogue.data.exceptionable}
              titleOf={titleOf}
              busy={busy}
              onChanged={() => {
                card.reload();
                active.reload();
                rolesRes.reload();
              }}
              run={run}
            />
          ) : null}
        </Stack>
      </Grid>
    </Page>
  );
}

/** Набор прав одной роли: галочки по группам справочника */
function RoleRow({
  role,
  groups,
  lang,
  busy,
  onSave,
}: {
  role: { id: string; code: string; title: LocalizedText; isBuiltin: boolean; permissions: string[]; people: number };
  groups: { code: string; title: LocalizedText; permissions: { code: string; title: LocalizedText }[] }[];
  lang: "uk" | "ru";
  busy: boolean;
  onSave: (permissions: string[]) => void;
}) {
  const { ut } = useLang();
  const [draft, setDraft] = useState<string[] | null>(null);
  const chosen = draft ?? role.permissions;
  const dirty = draft !== null && draft.join() !== role.permissions.join();

  const toggle = (code: string) =>
    setDraft(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code]);

  return (
    <div className="border-b border-hairline pb-4 last:border-0 last:pb-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <strong className="text-small font-medium">{role.title[lang]}</strong>
        {role.isBuiltin ? <Tag>{ut("perm.builtin")}</Tag> : null}
        <span className="text-caption text-muted">
          {role.people} {ut("perm.people")}
        </span>
      </div>

      {groups.map((g) => (
        <div key={g.code} className="mb-2">
          <SectionLabel className="mb-1">{g.title[lang]}</SectionLabel>
          <div className="flex flex-col gap-1">
            {g.permissions.map((p) => (
              <label key={p.code} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(p.code)}
                  disabled={role.isBuiltin}
                  onChange={() => toggle(p.code)}
                />
                {p.title[lang]}
              </label>
            ))}
          </div>
        </div>
      ))}

      {role.isBuiltin ? null : (
        <Button variant="primary" size="sm" disabled={!dirty || busy} onClick={() => onSave(chosen)}>
          {ut("perm.saveRole")}
        </Button>
      )}
    </div>
  );
}

/**
 * Что может конкретный человек — и откуда это взялось.
 *
 * Сначала итог, потом происхождение. Порядок обратный тому, в каком это
 * устроено внутри, и он правильный: пришли сюда узнать, может ли человек
 * подписывать заключения, а не изучать модель прав.
 */
function PersonCard({
  card,
  roles,
  exceptionable,
  titleOf,
  busy,
  onChanged,
  run,
}: {
  card: {
    userId: string;
    fullName: string;
    role: string;
    readOnly: boolean;
    roles: { roleId: string; code: string; title: LocalizedText; isBuiltin: boolean }[];
    exceptions: {
      id: string;
      permission: string;
      mode: "grant" | "revoke";
      reason: string;
      grantedAt: string;
      expiresAt: string | null;
      revokedAt: string | null;
    }[];
    effective: string[];
  };
  roles: { id: string; code: string; title: LocalizedText; isBuiltin: boolean }[];
  exceptionable: string[];
  titleOf: (code: string) => string;
  busy: boolean;
  onChanged: () => void;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
}) {
  const { ut, lang } = useLang();
  const [adding, setAdding] = useState<string | null>(null);
  const [mode, setMode] = useState<"grant" | "revoke">("grant");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("");

  const isSuper = card.role === "superadmin";
  const live = card.exceptions.filter(
    (e) => !e.revokedAt && (!e.expiresAt || new Date(e.expiresAt) > new Date()),
  );

  return (
    <Stack>
      <Panel title={card.fullName}>
        {isSuper ? (
          /*
            Суперадмину права не раздают: он обходит справочник целиком.
            Сказать это прямо дешевле, чем показать экран, где галочки ничего
            не меняют.
          */
          <p className="m-0 text-caption text-muted">{ut("perm.superadminNote")}</p>
        ) : (
          <>
            <SectionLabel className="mb-1.5">{ut("perm.effective")}</SectionLabel>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {card.effective.length === 0 ? (
                <span className="text-caption text-muted">—</span>
              ) : (
                card.effective.map((p) => <Tag key={p}>{titleOf(p)}</Tag>)
              )}
            </div>

            <SectionLabel className="mb-1.5">{ut("perm.fromRoles")}</SectionLabel>
            <div className="mb-4 flex flex-col gap-1">
              {roles.map((r) => (
                <label key={r.id} className="check">
                  <input
                    type="checkbox"
                    checked={card.roles.some((x) => x.roleId === r.id)}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...card.roles.map((x) => x.roleId), r.id]
                        : card.roles.map((x) => x.roleId).filter((id) => id !== r.id);
                      void run(async () => {
                        await api.setUserRoles(card.userId, next);
                        onChanged();
                      });
                    }}
                  />
                  {r.title[lang]}
                </label>
              ))}
            </div>
          </>
        )}
      </Panel>

      {isSuper ? null : (
        <Panel title={ut("perm.exceptions")} hint={ut("perm.quickHint")}>
          {live.length === 0 ? (
            <p className="m-0 mb-3 text-caption text-muted">{ut("perm.noExceptions")}</p>
          ) : (
            <div className="mb-3 flex flex-col gap-2">
              {live.map((e) => (
                <div key={e.id} className="flex flex-wrap items-baseline gap-2 border-b border-hairline pb-2">
                  <Tag tone={e.mode === "grant" ? "primary" : "danger"}>
                    {e.mode === "grant" ? ut("perm.grant") : ut("perm.revoke")}
                  </Tag>
                  <span className="text-small">{titleOf(e.permission)}</span>
                  <span className="text-caption text-muted">
                    {e.expiresAt ? `${ut("perm.until")} ${day(e.expiresAt)}` : ut("perm.forever")}
                  </span>
                  <Button
                    variant="quiet"
                    size="sm"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.revokeException(e.id);
                        onChanged();
                      }, ut("perm.cancelled"))
                    }
                  >
                    {ut("perm.cancel")}
                  </Button>
                  <span className="w-full text-caption text-muted">{e.reason}</span>
                </div>
              ))}
            </div>
          )}

          <SectionLabel className="mb-1.5">{ut("perm.quick")}</SectionLabel>
          <div className="mb-3 flex flex-wrap gap-2">
            {exceptionable.map((p) => (
              <Button
                key={p}
                size="sm"
                onClick={() => {
                  setAdding(p);
                  setReason("");
                  setDays("");
                }}
              >
                {titleOf(p)}
              </Button>
            ))}
          </div>

          {adding ? (
            <div className="flex flex-col gap-3 rounded-md bg-surface-2 p-4">
              <strong className="text-small font-medium">{titleOf(adding)}</strong>
              <div className="flex gap-2">
                {(["grant", "revoke"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`chip${mode === m ? " active" : ""}`}
                    onClick={() => setMode(m)}
                  >
                    {m === "grant" ? ut("perm.grant") : ut("perm.revoke")}
                  </button>
                ))}
              </div>
              <Field label={ut("perm.reason")} hint={ut("perm.reasonHint")}>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Field label={ut("perm.days")} hint={ut("perm.forever")}>
                <Input
                  value={days}
                  inputMode="numeric"
                  onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
                  className="w-[120px]"
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={busy || reason.trim().length < 10}
                  onClick={() =>
                    void run(async () => {
                      await api.addException(card.userId, {
                        permission: adding,
                        mode,
                        reason: reason.trim(),
                        days: days ? Number(days) : undefined,
                      });
                      setAdding(null);
                      onChanged();
                    }, ut("perm.added"))
                  }
                >
                  {ut("perm.addException")}
                </Button>
                <Button variant="quiet" onClick={() => setAdding(null)}>
                  {ut("common.cancel")}
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
      )}
    </Stack>
  );
}
