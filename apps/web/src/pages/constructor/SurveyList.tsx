import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Issue, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useToast } from "../../ui";

export function SurveyList() {
  const [rows, setRows] = useState<SurveyListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importIssues, setImportIssues] = useState<Issue[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const toast = useToast();

  /**
   * Импорт файла экспорта. Ошибочный файл методику не создаёт — сервер
   * возвращает 422 со списком проблем, и он показывается целиком: чинить
   * нужно файл, а не половину методики в базе.
   */
  async function importFile(file: File) {
    setImportIssues(null);
    setError(null);
    let draft: unknown;
    try {
      draft = JSON.parse(await file.text());
    } catch {
      setError("Файл не является корректным JSON");
      return;
    }
    try {
      const res = await api.importSurvey(draft);
      if (res.issues.length) setImportIssues(res.issues);
      toast("Методика импортирована черновиком — сверьте ключи перед публикацией", "ok");
      navigate(`/constructor/${res.id}`);
    } catch (e) {
      // 422: сервер вернул список структурных проблем — показываем целиком
      const body = (e as { body?: { issues?: Issue[] } }).body;
      if (body?.issues) setImportIssues(body.issues);
      setError(e instanceof Error ? e.message : "Импорт не удался");
    }
  }

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
      <div className="row">
        <Link className="btn" to="/constructor">Создать методику</Link>
        <button onClick={() => fileRef.current?.click()}>Импорт из файла</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {error ? <p className="error">{error}</p> : null}
      {importIssues?.length ? (
        <div className="card" style={{ borderColor: "var(--sev-mild)", marginTop: 12 }}>
          <h2>Замечания к файлу</h2>
          {importIssues.map((i, k) => (
            <p key={k} style={{ margin: "4px 0", fontSize: 13 }}>
              <span style={{ color: i.level === "error" ? "var(--sev-severe)" : "var(--sev-mild)" }}>
                {i.level === "error" ? "✖" : "⚠"}
              </span>{" "}
              <strong>{i.where}:</strong> <span className="muted">{i.message}</span>
            </p>
          ))}
        </div>
      ) : null}

      <div className="card scroll-x" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr><th>Название</th><th>Статус</th><th>Заполняет</th><th>Видимость</th><th className="num">Вопросов</th><th className="num">Прохождений</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/surveys/${s.id}`}>{s.title}</Link>
                  {s.isDemo ? <span className="chip static" style={{ marginLeft: 8, fontSize: 10 }}>демо</span> : null}
                </td>
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
