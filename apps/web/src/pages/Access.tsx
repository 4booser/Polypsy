import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SurveyFull, SurveyGrant } from "@quizzy/shared";
import { api, type Patient } from "../api";
import { dateTime } from "../format";
import { Loading, PageHead } from "../ui";

/** Назначение методики конкретным пациентам */
export default function Access() {
  const { id } = useParams<{ id: string }>();
  const [survey, setSurvey] = useState<SurveyFull | null>(null);
  const [grants, setGrants] = useState<SurveyGrant[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!id) return;
    const [s, g, p] = await Promise.all([api.survey(id), api.grants(id), api.patients().then((p) => p.items)]);
    setSurvey(s);
    setGrants(g);
    setPatients(p);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [id]);

  async function grant() {
    if (!id || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.grant(id, selected, note.trim() || undefined, expires || null);
      setSelected("");
      setNote("");
      setExpires("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось назначить");
    } finally {
      setBusy(false);
    }
  }

  if (!survey) return <Loading error={error} />;

  const free = patients.filter((p) => !grants.some((g) => g.userId === p.id));

  return (
    <>
      <PageHead
        title="Доступ к методике"
        crumbs={<Link to={`/surveys/${survey.id}`}>← {survey.title}</Link>}
        sub={survey.visibility === "restricted" ? "Видимость: только по назначению" : "Видимость: общая"}
      />

      {survey.visibility === "public" ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            Методика общедоступна — её видят все пациенты, и персональные назначения ни на что не влияют.
            Чтобы ограничить доступ, переключите видимость методики на «по назначению».
          </p>
        </div>
      ) : null}

      <div className="card">
        <h2>Назначить пациенту</h2>
        <p className="hint">Пациент увидит методику в мобильном приложении сразу после назначения</p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: 2, minWidth: 240, marginBottom: 0 }}>
            <label>Пациент</label>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">— выберите —</option>
              {free.map((p) => (
                <option key={p.id} value={p.id}>{p.fullName} · {p.email}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 2, minWidth: 200, marginBottom: 0 }}>
            <label>Комментарий</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: назначено на приёме" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 170, marginBottom: 0 }}>
            <label>Действует до (необязательно)</label>
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
          <button className="primary" onClick={grant} disabled={!selected || busy}>Назначить</button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>

      <div className="card scroll-x">
        <h2>Назначено ({grants.length})</h2>
        {grants.length === 0 ? (
          <p className="muted">Пока никому не назначено</p>
        ) : (
          <table>
            <thead>
              <tr><th>Пациент</th><th>Email</th><th>Назначил</th><th>Когда</th><th>До</th><th>Пройдено</th><th>Комментарий</th><th /></tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.userId}>
                  <td>{g.fullName}</td>
                  <td className="muted">{g.email}</td>
                  <td className="muted">{g.grantedByName ?? "—"}</td>
                  <td className="muted">{dateTime(g.grantedAt)}</td>
                  <td className="muted">{g.expiresAt ? g.expiresAt.slice(0, 10) : "бессрочно"}</td>
                  <td>{g.completed ? "да" : "нет"}</td>
                  <td className="muted">{g.note ?? "—"}</td>
                  <td>
                    <button
                      className="danger"
                      onClick={async () => {
                        await api.revoke(survey.id, g.userId).catch(() => null);
                        await load();
                      }}
                    >
                      Отозвать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
