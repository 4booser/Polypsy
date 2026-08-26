import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";

export function SurveyList() {
  const [rows, setRows] = useState<SurveyListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setRows(await api.surveys());
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  if (!rows) return <p className="muted">{error ?? "Загрузка…"}</p>;

  return (
    <>
      <h1>Методики</h1>
      <p className="sub">Создание, правка и назначение</p>
      <Link className="btn" to="/constructor">Создать методику</Link>

      <div className="card scroll-x" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr><th>Название</th><th>Статус</th><th>Заполняет</th><th>Видимость</th><th className="num">Вопросов</th><th className="num">Прохождений</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/surveys/${s.id}`}>{s.title}</Link></td>
                <td className="muted">{s.status}</td>
                <td className="muted">{s.administration === "clinician" ? "специалист" : "респондент"}</td>
                <td className="muted">{s.visibility === "restricted" ? "по назначению" : "общая"}</td>
                <td className="num">{s.questionCount}</td>
                <td className="num">{s.responseCount}</td>
                <td>
                  <div className="row">
                    <Link className="btn" to={`/constructor/${s.id}`}>Править</Link>
                    <Link className="btn" to={`/surveys/${s.id}/key`}>Ключи</Link>
                    <Link className="btn" to={`/surveys/${s.id}/access`}>Доступ</Link>
                    <button
                      onClick={async () => {
                        await api.duplicateSurvey(s.id).catch(() => null);
                        await load();
                      }}
                    >
                      Копия
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
