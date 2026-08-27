import { useCallback, useEffect, useState } from "react";
import type { GroupAdmin, SurveyGroupWithCounts, User } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dateTime } from "../format";
import { Loading, PageHead, useAction } from "../ui";
import { useLang } from "../lang";

const PRESET_COLORS = ["#3b5bfd", "#1baf7a", "#eb6834", "#4a3aa7", "#e87ba4"];

/** Группы методик и назначение их администраторов */
export function Groups() {
  const { ut } = useLang();
  const run = useAction();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const [groups, setGroups] = useState<SurveyGroupWithCounts[] | null>(null);
  const [staff, setStaff] = useState<User[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]!);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setGroups(await api.groups());
    if (isSuper) setStaff((await api.users()).filter((u) => u.role !== "user"));
  }, [isSuper]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  if (!groups) return <Loading error={error} />;

  return (
    <>
      <PageHead
        title="Группы методик"
        sub="Группа — единица разграничения доступа: администратор видит только методики своих групп"
      />

      {isSuper ? (
        <div className="card">
          <h2>{ut("adm.newGroup")}</h2>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
              <label>{ut("f.name")}</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Приёмное отделение" />
            </div>
            <div className="field" style={{ flex: 2, minWidth: 240, marginBottom: 0 }}>
              <label>{ut("f.description")}</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="row" style={{ gap: 6 }}>
              {PRESET_COLORS.map((p) => (
                <button
                  key={p}
                  onClick={() => setColor(p)}
                  title={p}
                  style={{
                    width: 26,
                    height: 26,
                    padding: 0,
                    background: p,
                    borderColor: color === p ? "var(--text)" : "transparent",
                    borderWidth: 2,
                  }}
                />
              ))}
            </div>
            <button
              className="primary"
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
              Создать
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <p style={{ margin: 0 }} className="muted">
            Вы видите только группы, на которые назначены. Создавать группы и назначать
            администраторов может суперадминистратор.
          </p>
        </div>
      )}

      {error ? <p className="error">{error}</p> : null}

      {groups.map((g) => (
        <div className="card" key={g.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              {g.color ? <i className="dot" style={{ background: g.color }} /> : null}
              <strong>{g.title}</strong>
              <span className="muted">
                {g.surveyCount} методик · {g.publishedCount} опубликовано · {g.responseCount} прохождений
              </span>
            </div>
            {isSuper ? (
              <button
                className="danger"
                onClick={() =>
                  run(async () => {
                    if (!confirm(`Удалить группу «${g.title}»?`)) return;
                    // отказ сервера нужно показать: непустая группа не удаляется,
                    // и молчаливая кнопка выглядела бы сломанной
                    await api.deleteGroup(g.id);
                    await load();
                  }, "Группа удалена")
                }
              >
                Удалить
              </button>
            ) : null}
          </div>
          {g.description ? <p className="hint">{g.description}</p> : null}

          {isSuper ? (
            <>
              <h2 style={{ fontSize: 14, marginTop: 12 }}>{ut("adm.admins")}</h2>
              {g.admins.length === 0 ? (
                <p className="muted">Никто не назначен — группой управляет только суперадмин</p>
              ) : (
                <table>
                  <thead><tr><th>ФИО</th><th>Email</th><th>Назначен</th><th /></tr></thead>
                  <tbody>
                    {g.admins.map((a: GroupAdmin) => (
                      <tr key={a.userId}>
                        <td>{a.fullName}</td>
                        <td className="muted">{a.email}</td>
                        <td className="muted">{dateTime(a.addedAt)}</td>
                        <td>
                          <button
                            className="danger"
                            onClick={async () => {
                              await api.revokeGroupAdmin(g.id, a.userId).catch(() => null);
                              await load();
                            }}
                          >
                            Снять
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {assigning === g.id ? (
                <div className="row" style={{ marginTop: 10 }}>
                  <select
                    defaultValue=""
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      await api.assignGroupAdmin(g.id, e.target.value).catch((err) => setError(err.message));
                      setAssigning(null);
                      await load();
                    }}
                    style={{ maxWidth: 420 }}
                  >
                    <option value="">— выберите сотрудника —</option>
                    {staff
                      .filter((u) => !g.admins.some((a) => a.userId === u.id))
                      .map((u) => (
                        <option key={u.id} value={u.id}>{u.fullName} · {u.email}</option>
                      ))}
                  </select>
                  <button onClick={() => setAssigning(null)}>{ut("ui.cancel")}</button>
                </div>
              ) : (
                <button style={{ marginTop: 10 }} onClick={() => setAssigning(g.id)}>
                  Назначить администратора
                </button>
              )}
            </>
          ) : null}
        </div>
      ))}
    </>
  );
}

const ROLE_LABEL: Record<string, string> = {
  superadmin: "Суперадминистратор",
  admin: "Администратор группы",
  user: "Пациент",
};

/** Учётные записи персонала */
export function Users() {
  const { ut } = useLang();
  const [users, setUsers] = useState<User[] | null>(null);
  const [form, setForm] = useState({ lastName: "", firstName: "", middleName: "", email: "", password: "" });
  const [role, setRole] = useState<"admin" | "superadmin">("admin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => setUsers(await api.users()), []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  if (!users) return <Loading error={error} />;

  const shown = users.filter((u) =>
    `${u.fullName} ${u.email}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <PageHead
        title="Учётные записи"
        sub="Единственный способ выдать доступ сотрудника: самостоятельная регистрация всегда создаёт пациента"
      />

      <div className="card">
        <h2>{ut("adm.newUser")}</h2>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
            <label>Фамилия</label>
            <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
            <label>Имя</label>
            <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
            <label>Отчество</label>
            <input value={form.middleName} onChange={(e) => setForm({ ...form, middleName: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
            <label>Email</label>
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 160, marginBottom: 0 }}>
            <label>Пароль (от 8 знаков)</label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div className="field" style={{ width: 190, marginBottom: 0 }}>
            <label>{ut("adm.role")}</label>
            <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "superadmin")}>
              <option value="admin">Администратор группы</option>
              <option value="superadmin">Суперадминистратор</option>
            </select>
          </div>
          <button
            className="primary"
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
                setError(e instanceof Error ? e.message : "Не удалось создать");
              } finally {
                setBusy(false);
              }
            }}
          >
            Создать
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>

      <div className="card scroll-x">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Все учётные записи ({shown.length})</h2>
          <input
            placeholder="Поиск по ФИО или email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 280 }}
          />
        </div>
        <table>
          <thead><tr><th>ФИО</th><th>Email</th><th>{ut("adm.role")}</th><th>Пол</th><th>Создан</th></tr></thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.fullName}
                  {u.anonymous ? <span className="muted"> · без имени</span> : null}
                </td>
                <td className="muted">{u.email}</td>
                <td>{ROLE_LABEL[u.role]}</td>
                <td className="muted">{u.sex === "male" ? "муж." : u.sex === "female" ? "жен." : "—"}</td>
                <td className="muted">{u.createdAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Текст информированного согласия. Правка создаёт новую версию, и все
 * пациенты увидят экран согласия заново — у каждого принятия зафиксировано,
 * какую редакцию человек читал.
 */
export function ConsentText() {
  const [uk, setUk] = useState("");
  const [ru, setRu] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const run = useAction();

  useEffect(() => {
    api
      .consentText()
      .then((t) => {
        if (!t) return;
        setVersion(t.version);
        setUk(t.body.uk ?? "");
        setRu(t.body.ru ?? "");
      })
      .catch(() => {});
  }, []);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Информированное согласие</h2>
        {version ? <span className="hint">версия {version}</span> : <span className="hint">не настроено</span>}
      </div>
      <p className="hint">
        Показывается пациенту после входа. Сохранение создаёт новую версию — все пациенты
        подтвердят согласие заново, и в журнале останется, какую редакцию читал каждый.
      </p>
      <div className="form-grid">
        <label className="field grow">
          <span>Українською</span>
          <textarea rows={5} value={uk} onChange={(e) => setUk(e.target.value)} />
        </label>
        <label className="field grow">
          <span>По-русски</span>
          <textarea rows={5} value={ru} onChange={(e) => setRu(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="primary"
          disabled={uk.trim().length < 10 || ru.trim().length < 10}
          onClick={() =>
            run(async () => {
              const res = await api.saveConsentText({ uk: uk.trim(), ru: ru.trim() });
              setVersion(res.version);
            }, "Новая версия согласия сохранена — пациенты подтвердят её при следующем входе")
          }
        >
          Сохранить новой версией
        </button>
      </div>
    </div>
  );
}
