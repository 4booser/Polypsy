import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Issue, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { ConfirmByName, Loading, useToast } from "../../ui";
import { Page, Panel } from "../../ui/layout";
import { Button, Tag } from "../../ui/primitives";
import { cx } from "../../ui/cx";
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
    <Page
      title={ut("cl.title")}
      sub={ut("cl.sub")}
      count={rows.length}
      actions={
        <Link to="/constructor" className="btn primary">{ut("cl.create")}</Link>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => fileRef.current?.click()}>{ut("cl.importFile")}</Button>
          <Button onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? ut("cl.activeOnly") : ut("cl.showArchived")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = "";
            }}
          />
        </div>
      }
    >
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
              <p className="m-0 mb-1.5">
                {ut("cl.archiveWarnBody")}
              </p>
              <p className="m-0 text-muted">
                {ut("cl.responsesKeptPrefix")} ({confirming.responseCount}) {ut("cl.responsesKeptSuffix")}
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

      {error ? <p className="mb-3 text-small text-danger">{error}</p> : null}
      {importIssues?.length ? (
        <Panel
          className={cx(
            "mb-4",
            importIssues.some((i) => i.level === "error")
              ? "border border-[color-mix(in_srgb,var(--danger)_45%,transparent)]"
              : "border border-[color-mix(in_srgb,var(--accent)_45%,transparent)]",
          )}
          title={ut("cl.fileIssues")}
        >
          {importIssues.map((i, k) => (
            <p key={k} className="my-1 text-small">
              <span className={i.level === "error" ? "text-danger" : "text-accent"}>
                {i.level === "error" ? "✖" : "⚠"}
              </span>{" "}
              <strong>{i.where}:</strong> <span className="text-muted">{i.message}</span>
            </p>
          ))}
        </Panel>
      ) : null}

      <Panel flush>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr><th>{ut("cl.name")}</th><th>{ut("cl.status")}</th><th>{ut("cl.filledBy")}</th><th>{ut("cl.visibility")}</th><th className="num">{ut("cl.questions")}</th><th className="num">{ut("cl.responses")}</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/surveys/${s.id}`}>{s.title}</Link>
                    {s.isDemo ? <Tag className="ml-2">{ut("mark.demo")}</Tag> : null}
                  </td>
                  <td className="text-muted">
                    {s.archivedAt ? (
                      <span title={`${ut("cl.retiredOn")} ${s.archivedAt.slice(0, 10)}`}>{ut("mark.retired")}</span>
                    ) : (
                      s.status
                    )}
                    {/*
                      Правовой статус стоит рядом со статусом публикации: это
                      единственное место, где решают, выдавать ли методику.
                    */}
                    {s.isDemo ? <Tag className="ml-1.5">{ut("cl.demo")}</Tag> : null}
                    {!s.rightsStatus || s.rightsStatus === "unclear" ? (
                      <span title={ut("cl.rightsHint")}>
                        <Tag tone="attention" className="ml-1.5">{ut("cl.rightsUnclear")}</Tag>
                      </span>
                    ) : null}
                  </td>
                  <td className="text-muted">{s.administration === "clinician" ? ut("cl.clinician") : ut("cl.respondent")}</td>
                  <td className="text-muted">{s.visibility === "restricted" ? ut("cl.byGrant") : ut("dash.public")}</td>
                  <td className="num">{s.questionCount}</td>
                  <td className="num">{s.responseCount}</td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link to={`/constructor/${s.id}`} className="btn">{ut("cl.editAction")}</Link>
                      <Link to={`/surveys/${s.id}/key`} className="btn">{ut("cl.keysAction")}</Link>
                      <Link to={`/surveys/${s.id}/access`} className="btn">{ut("cl.accessAction")}</Link>
                      <Button
                        onClick={async () => {
                          await api.duplicateSurvey(s.id).catch(() => null);
                          await load();
                        }}
                      >
                        {ut("cl.duplicateAction")}
                      </Button>
                      {s.archivedAt ? (
                        <Button
                          onClick={async () => {
                            await api.restoreSurvey(s.id);
                            await load();
                            toast(ut("cl.restored"), "ok");
                          }}
                        >
                          {ut("cl.restoreAction")}
                        </Button>
                      ) : (
                        <Button variant="danger" onClick={() => setConfirming(s)}>
                          {ut("cl.archiveButton")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </Page>
  );
}
