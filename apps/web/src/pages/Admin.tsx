import { Fragment, useEffect, useState } from "react";
import type { GroupAdmin, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useResource } from "../useResource";
import { Devices } from "../components/Devices";
import { useAuth } from "../auth";
import { dateTime } from "../format";
import { Loading, Search, useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Select, SectionLabel, Tag, Textarea } from "../ui/primitives";
import { cx } from "../ui/cx";
import { useLang } from "../lang";

const PRESET_COLORS = ["#3b5bfd", "#1baf7a", "#eb6834", "#4a3aa7", "#e87ba4"];

/** Группы методик и назначение их администраторов */
export function Groups() {
  const { ut } = useLang();
  const { run } = useAction();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]!);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const res = useResource(async () => {
    const [groups, users] = await Promise.all([
      api.groups(),
      isSuper ? api.users() : Promise.resolve([]),
    ]);
    return { groups, staff: users.filter((u) => u.role !== "user") };
  }, [isSuper]);
  const load = async () => res.reload();
  const groups = res.data?.groups ?? null;
  const staff = res.data?.staff ?? [];

  if (!groups) return <Loading error={res.error} />;

  return (
    <Page title={ut("adm.groupsTitle")} sub={ut("adm.groupsSub")} count={groups.length}>
      <Stack>
        {isSuper ? (
          <Panel title={ut("adm.newGroup")}>
            <div className="flex flex-wrap items-end gap-3">
              <Field label={ut("f.name")} className="min-w-[200px] flex-1">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ut("adm.groupExample")} />
              </Field>
              <Field label={ut("f.description")} className="min-w-[240px] flex-[2]">
                <Input value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <div className="flex items-center gap-1.5">
                {PRESET_COLORS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setColor(p)}
                    title={p}
                    className={cx(
                      "size-[26px] rounded-sm border-2 p-0",
                      color === p ? "border-[var(--text)]" : "border-transparent",
                    )}
                    style={{ background: p }}
                  />
                ))}
              </div>
              <Button
                variant="primary"
                disabled={!title.trim()}
                onClick={async () => {
                  await api
                    .createGroup({ title: title.trim(), description: description.trim() || null, color })
                    .catch((e) => setError(e.message));
                  setTitle("");
                  setDescription("");
                  await load();
                }}
              >
                {ut("adm.create")}
              </Button>
            </div>
          </Panel>
        ) : (
          <Panel>
            <p className="m-0 text-caption text-muted">{ut("adm.groupsReadOnlyHint")}</p>
          </Panel>
        )}

        {error ? <p className="text-caption text-danger">{error}</p> : null}

        {groups.map((g) => (
          <Panel
            key={g.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {g.color ? <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: g.color }} /> : null}
                {g.title}
                <span className="text-caption font-normal text-muted">
                  {g.surveyCount} {ut("adm.methodsCount")} · {g.publishedCount} {ut("dash.published")} · {g.responseCount} {ut("adm.responsesCount")}
                </span>
              </span>
            }
            actions={
              isSuper ? (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() =>
                    run(async () => {
                      if (!confirm(`${ut("adm.confirmDeleteGroup")} «${g.title}»?`)) return;
                      // отказ сервера нужно показать: непустая группа не удаляется,
                      // и молчаливая кнопка выглядела бы сломанной
                      await api.deleteGroup(g.id);
                      await load();
                    }, ut("adm.groupDeleted"))
                  }
                >
                  {ut("adm.delete")}
                </Button>
              ) : null
            }
            hint={g.description || undefined}
          >
            {isSuper ? (
              <>
                <SectionLabel className="mb-2">{ut("adm.admins")}</SectionLabel>
                {g.admins.length === 0 ? (
                  <p className="m-0 text-caption text-muted">{ut("adm.noAdmins")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table>
                      <thead><tr><th>{ut("adm.fullName")}</th><th>Email</th><th>{ut("adm.assignedAt")}</th><th /></tr></thead>
                      <tbody>
                        {g.admins.map((a: GroupAdmin) => (
                          <tr key={a.userId}>
                            <td>{a.fullName}</td>
                            <td className="text-muted">{a.email}</td>
                            <td className="text-muted">{dateTime(a.addedAt)}</td>
                            <td>
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={async () => {
                                  await api.revokeGroupAdmin(g.id, a.userId).catch(() => null);
                                  await load();
                                }}
                              >
                                {ut("acc.revoke")}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {assigning === g.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Select
                      defaultValue=""
                      className="max-w-[420px]"
                      onChange={async (e) => {
                        if (!e.target.value) return;
                        await api.assignGroupAdmin(g.id, e.target.value).catch((err) => setError(err.message));
                        setAssigning(null);
                        await load();
                      }}
                    >
                      <option value="">{ut("sel.pickStaff")}</option>
                      {staff
                        .filter((u) => !g.admins.some((a) => a.userId === u.id))
                        .map((u) => (
                          <option key={u.id} value={u.id}>{u.fullName} · {u.email}</option>
                        ))}
                    </Select>
                    <Button variant="quiet" onClick={() => setAssigning(null)}>{ut("ui.cancel")}</Button>
                  </div>
                ) : (
                  <Button variant="ghost" className="mt-3" onClick={() => setAssigning(g.id)}>
                    {ut("adm.addAdmin")}
                  </Button>
                )}
              </>
            ) : null}
          </Panel>
        ))}
      </Stack>
    </Page>
  );
}

/*
 * Ключи, а не готовые строки: карта живёт вне компонента, а перевод зависит
 * от выбранного языка и должен браться в момент отрисовки.
 */
const ROLE_KEY = {
  superadmin: "adm.roleSuper",
  admin: "adm.roleAdmin",
  user: "adm.rolePatient",
} as const satisfies Record<string, UiKey>;

/*
 * Users и ConsentText не переведены на <Page>.
 *
 * Оба экрана делят один маршрут: App.tsx рендерит их вместе как
 * `<><Users /><ConsentText /></>` (роут «/users»). <Page> рассчитан на то,
 * что на маршруте ровно один экран, и растягивает его на всю рабочую
 * область через `position: absolute`. Если обернуть в <Page> хотя бы один
 * из двух компонентов, он перекроет собой другой целиком: позиционированный
 * слой в CSS всегда рисуется поверх непозиционированных соседей, независимо
 * от порядка в разметке, — так что сработай это здесь, «Личные дела» или
 * текст согласия просто исчезли бы с экрана, оставшись в DOM, но не на
 * виду. Поэтому оба используют только Panel/Field/Button — тот же язык
 * компонентов, без общей рамки экрана. Это стоит поправить в App.tsx:
 * развести их по отдельным маршрутам либо свести в один компонент — тогда
 * оба смогут вернуться к <Page>, как остальные перенесённые экраны.
 */

/** Учётные записи персонала */
export function Users() {
  const { ut } = useLang();
  const [form, setForm] = useState({ lastName: "", firstName: "", middleName: "", email: "", password: "" });
  const [role, setRole] = useState<"admin" | "superadmin">("admin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [devicesFor, setDevicesFor] = useState<string | null>(null);

  const res = useResource(() => api.users(), []);
  const load = async () => res.reload();
  const users = res.data;

  if (!users) return <Loading error={res.error} />;

  const shown = users.filter((u) =>
    `${u.fullName} ${u.email}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <Page title={ut("adm.accountsTitle")} sub={ut("adm.accountsSub")} count={users.length}>
      <Panel title={ut("adm.newUser")}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={ut("adm.lastName")} className="min-w-[140px] flex-1">
            <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </Field>
          <Field label={ut("adm.firstName")} className="min-w-[140px] flex-1">
            <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </Field>
          <Field label={ut("adm.middleName")} className="min-w-[140px] flex-1">
            <Input value={form.middleName} onChange={(e) => setForm({ ...form, middleName: e.target.value })} />
          </Field>
          <Field label="Email" className="min-w-[200px] flex-1">
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label={ut("adm.password8")} className="min-w-[160px] flex-1">
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Field label={ut("adm.role")} className="w-[190px]">
            <Select value={role} onChange={(e) => setRole(e.target.value as "admin" | "superadmin")}>
              <option value="admin">{ut("adm.roleAdmin")}</option>
              <option value="superadmin">{ut("adm.roleSuper")}</option>
            </Select>
          </Field>
          <Button
            variant="primary"
            disabled={busy || !form.lastName.trim() || !form.firstName.trim() || form.password.length < 8}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.createUser({
                  lastName: form.lastName.trim(),
                  firstName: form.firstName.trim(),
                  middleName: form.middleName.trim() || null,
                  email: form.email.trim(),
                  password: form.password,
                  role,
                });
                setForm({ lastName: "", firstName: "", middleName: "", email: "", password: "" });
                await load();
              } catch (e) {
                setError(e instanceof Error ? e.message : ut("adm.createFailed"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {ut("adm.create")}
          </Button>
        </div>
        {error ? <p className="mt-2 text-caption text-danger">{error}</p> : null}
      </Panel>

      <Panel
        className="mt-4"
        title={`${ut("adm.allAccounts")} (${shown.length})`}
        actions={<Search value={query} onChange={setQuery} placeholder={ut("adm.searchPlaceholder")} />}
        flush
      >
        <div className="overflow-x-auto">
          <table>
            <thead><tr><th>{ut("adm.fullName")}</th><th>Email</th><th>{ut("adm.role")}</th><th>{ut("dq.sex")}</th><th>{ut("adm.createdAt")}</th></tr></thead>
            <tbody>
              {shown.map((u) => (
                <Fragment key={u.id}>
                  <tr>
                    <td>
                      {u.fullName}
                      {u.anonymous ? <span className="text-muted"> {ut("sel.noName")}</span> : null}
                    </td>
                    <td className="text-muted">{u.email}</td>
                    <td>{ut(ROLE_KEY[u.role as keyof typeof ROLE_KEY])}</td>
                    <td className="text-muted">{u.sex === "male" ? ut("adm.male") : u.sex === "female" ? ut("adm.female") : "—"}</td>
                    <td className="text-muted">
                      {u.createdAt.slice(0, 10)}
                      {/*
                        Устройства раскрываются по требованию, а не висят в
                        таблице: это сведения о человеке, и показывать их всем
                        подряд при каждом открытии списка незачем.
                      */}
                      <Button
                        variant="quiet"
                        size="sm"
                        className="ml-2"
                        onClick={() => setDevicesFor((v) => (v === u.id ? null : u.id))}
                      >
                        {ut("dev.title")}
                      </Button>
                    </td>
                  </tr>
                  {devicesFor === u.id ? (
                    <tr>
                      <td colSpan={5} className="bg-surface-2 px-4 py-3">
                        <Devices userId={u.id} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </Page>
  );
}

/**
 * Текст информированного согласия. Правка создаёт новую версию, и все
 * пациенты увидят экран согласия заново — у каждого принятия зафиксировано,
 * какую редакцию человек читал.
 *
 * Про отсутствие <Page> здесь — см. комментарий перед Users() выше: оба
 * экрана делят один маршрут.
 */
export function ConsentText() {
  const { ut } = useLang();
  const [uk, setUk] = useState("");
  const [ru, setRu] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const { run } = useAction();

  const current = useResource(() => api.consentText(), []).data;
  useEffect(() => {
    if (!current) return;
    setVersion(current.version);
    setUk(current.body.uk ?? "");
    setRu(current.body.ru ?? "");
  }, [current]);

  return (
    <Panel
      className="mt-4"
      title={ut("adm.consentTitle")}
      hint={ut("adm.consentHint")}
      actions={
        <Tag tone="plain">
          {version ? `${ut("adm.consentVersion")} ${version}` : ut("adm.consentUnset")}
        </Tag>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={ut("adm.inUkrainian")}>
          <Textarea rows={5} value={uk} onChange={(e) => setUk(e.target.value)} />
        </Field>
        <Field label={ut("adm.inRussian")}>
          <Textarea rows={5} value={ru} onChange={(e) => setRu(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <Button
          variant="primary"
          disabled={uk.trim().length < 10 || ru.trim().length < 10}
          onClick={() =>
            run(async () => {
              const res = await api.saveConsentText({ uk: uk.trim(), ru: ru.trim() });
              setVersion(res.version);
            }, ut("adm.consentSaved"))
          }
        >
          {ut("adm.consentSave")}
        </Button>
      </div>
    </Panel>
  );
}
