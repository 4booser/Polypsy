import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Issue, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { ConfirmByName, Loading, PageHead, useToast } from "../../ui";
import { useLang } from "../../lang";

export function SurveyList() {
  const { ut } = useLang();
  const [showArchived, setShowArchived] = useState(false);
  // ошибка импорта — про действие, а не про загрузку списка: состояния разные
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<SurveyListItem | null>(null);
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
      setError(ut("cl.badJson"));
      return;
    }
    try {
      const res = await api.importSurvey(draft);
      if (res.issues.length) setImportIssues(res.issues);
      toast(ut("cl.imported"), "ok");
      navigate(`/constructor/${res.id}`);
    } catch (e) {
      // 422: сервер вернул список структурных проблем — показываем целиком
      const body = (e as { body?: { issues?: Issue[] } }).body;
      if (body?.issues) setImportIssues(body.issues);
      setError(e instanceof Error ? e.message : ut("cl.importFailed"));
    }
  }

  const res = useResource(() => api.surveys(showArchived), [showArchived]);
  const rows = res.data;
  const load = async () => res.reload();

  if (!rows) return <Loading error={res.error} rows={5} />;

  return (
    <>
      <PageHead
        title={ut("cl.title")}
        sub={ut("cl.sub")}
        actions={<Link className="btn primary" to="/constructor">{ut("cl.create")}</Link>}
      />
      <div className="row">
        <button onClick={() => fileRef.current?.click()}>{ut("cl.importFile")}</button>
        <button onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? ut("cl.activeOnly") : ut("cl.showArchived")}
        </button>
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

      {confirming ? (
        /*
         * Ничего не удаляется: методика перестаёт выдаваться и проходиться, но
         * все собранные прохождения остаются. Формулировка обязана это
         * отражать — «удалить» здесь было бы враньём. Название всё равно
         * просим напечатать: в списке однотипных методик легко снять соседнюю.
         */
        <ConfirmByName
          title={ut("cl.archiveConfirm")}
          name={confirming.title}
          actionLabel={ut("cl.archive")}
          warning={
            <>
              <p style={{ margin: "0 0 6px" }}>
                Методику перестанут выдавать и проходить: она исчезнет из списков,
                батарей, киоска и расписаний.
              </p>
              <p style={{ margin: 0 }} className="muted">
                Собранные прохождения ({confirming.responseCount}) останутся на месте —
                в карте пациента, аналитике и журнале. Решение обратимо.
              </p>
            </>
          }
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            await api.archiveSurvey(confirming.id);
            setConfirming(null);
            await load();
            toast(ut("cl.archived"), "ok");
          }}
        />
      ) : null}

      {error ? <p className="error">{error}</p> : null}
      {importIssues?.length ? (
        <div className="card" style={{ borderColor: "var(--sev-mild)", marginTop: 12 }}>
          <h2>{ut("cl.fileIssues")}</h2>
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
            <tr><th>{ut("cl.name")}</th><th>{ut("cl.status")}</th><th>{ut("cl.filledBy")}</th><th>{ut("cl.visibility")}</th><th className="num">{ut("cl.questions")}</th><th className="num">{ut("cl.responses")}</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/surveys/${s.id}`}>{s.title}</Link>
                  {s.isDemo ? <span className="chip static" style={{ marginLeft: 8, fontSize: 10 }}>демо</span> : null}
                </td>
                <td className="muted">
                  {s.archivedAt ? (
                    <span title={`Снята ${s.archivedAt.slice(0, 10)}`}>снята с использования</span>
                  ) : (
                    s.status
                  )}
                </td>
                <td className="muted">{s.administration === "clinician" ? ut("cl.clinician") : ut("cl.respondent")}</td>
                <td className="muted">{s.visibility === "restricted" ? ut("cl.byGrant") : ut("dash.public")}</td>
                <td className="num">{s.questionCount}</td>
                <td className="num">{s.responseCount}</td>
                <td>
                  <div className="row">
                    <Link className="btn" to={`/constructor/${s.id}`}>{ut("cl.editAction")}</Link>
                    <Link className="btn" to={`/surveys/${s.id}/key`}>{ut("cl.keysAction")}</Link>
                    <Link className="btn" to={`/surveys/${s.id}/access`}>{ut("cl.accessAction")}</Link>
                    <button
                      onClick={async () => {
                        await api.duplicateSurvey(s.id).catch(() => null);
                        await load();
                      }}
                    >
                      Копия
                    </button>
                    {s.archivedAt ? (
                      <button
                        onClick={async () => {
                          await api.restoreSurvey(s.id);
                          await load();
                          toast(ut("cl.restored"), "ok");
                        }}
                      >
                        Вернуть в работу
                      </button>
                    ) : (
                      <button className="danger" onClick={() => setConfirming(s)}>
                        Снять
                      </button>
                    )}
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
