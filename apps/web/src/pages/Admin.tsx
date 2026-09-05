import { Fragment, useEffect, useState } from "react";
import type { UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useResource } from "../useResource";
import { Devices } from "../components/Devices";
import { day } from "../format";
import { Loading, Search, useAction } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Button, Field, Input, Select, Tag, Textarea } from "../ui/primitives";
import { useLang } from "../lang";

/*
 * Экран групп переехал в собственный файл.
 *
 * Он вырос из «списка с кнопкой удалить» в администрирование плюс аналитику
 * и рядом с учётными записями держаться перестал: два несвязанных экрана в
 * одном файле — это диффы, в которых не видно, что менялось.
 *
 * Реэкспорт остаётся: маршрут «/groups» в App.tsx подгружает `Groups`
 * именно отсюда, и убрать эту строку значит сломать его — а App.tsx сейчас
 * правят другие.
 */
export { default as Groups } from "./Groups";

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
                      {day(u.createdAt)}
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

  /*
   * Отдельный экран открывается по своему адресу — значит у него должен быть
   * заголовок экрана, а не заголовок панели.
   *
   * Панель без страницы вокруг оставляла консоль без единственного h1: экран
   * выглядел цельным, но читалка с экрана начинала с поля ввода, а проверка
   * полноты перевода, ждущая заголовок, зависала именно здесь.
   */
  return (
    <Page
      title={ut("adm.consentTitle")}
      sub={ut("adm.consentHint")}
      actions={
        <Tag tone="plain">
          {version ? `${ut("adm.consentVersion")} ${version}` : ut("adm.consentUnset")}
        </Tag>
      }
    >
      <Panel>
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
    </Page>
  );
}
