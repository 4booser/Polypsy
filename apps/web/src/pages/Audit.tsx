import { useState } from "react";
import type { UiKey } from "@quizzy/shared";
import { api } from "../api";
import { BarList, Chart } from "../charts";
import { dateTime } from "../format";
import { PageHead, Screen } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/*
 * Ключи, а не готовые подписи: карта живёт вне компонента, и язык должен
 * определяться при отрисовке, а не при загрузке модуля.
 */
const ACTION_KEY = {
  "auth.login": "act.auth_login",
  "auth.login_failed": "act.auth_login_failed",
  "auth.register": "act.auth_register",
  "user.create": "act.user_create",
  "user.list": "act.user_list",
  "survey.create": "act.survey_create",
  "survey.update": "act.survey_update",
  "survey.publish": "act.survey_publish",
  "survey.delete": "act.survey_delete",
  "survey.duplicate": "act.survey_duplicate",
  "group.create": "act.group_create",
  "group.admin_assign": "act.group_admin_assign",
  "group.admin_revoke": "act.group_admin_revoke",
  "access.grant": "act.access_grant",
  "access.revoke": "act.access_revoke",
  "access.grant_list": "act.access_grant_list",
  "access.denied": "act.access_denied",
  "response.submit": "act.response_submit",
  "response.list": "act.response_list",
  "response.read": "act.response_read",
  "response.draft": "act.response_draft",
  "analytics.overview": "act.analytics_overview",
  "analytics.survey": "act.analytics_survey",
  "analytics.export": "act.analytics_export",
  "report.render": "act.report_render",
  "alert.list": "act.alert_list",
  "alert.acknowledge": "act.alert_acknowledge",
  "audit.read": "act.audit_read",
} as const satisfies Record<string, UiKey>;

// пары «фильтр → ключ подписи»: язык берётся при отрисовке
const FILTERS = [
  ["", "aud.allEvents"],
  ["response.read", "aud.cardAccess"],
  ["analytics.export", "aud.exports"],
  ["access.grant", "aud.grants"],
  ["access.denied", "aud.denials"],
  ["auth.login_failed", "aud.failedLogins"],
] as const satisfies readonly (readonly [string, UiKey])[];

export default function Audit() {
  const { ut } = useLang();
  // незнакомое действие показываем как есть: лучше сырой код, чем пустая ячейка
  const actionLabel = (a: string) => (a in ACTION_KEY ? ut(ACTION_KEY[a as keyof typeof ACTION_KEY]) : a);
  const [filter, setFilter] = useState("");

  const res = useResource(async () => {
    const [page, summary] = await Promise.all([
      api.audit({ action: filter || undefined }),
      api.auditSummary(),
    ]);
    return { entries: page.entries, total: page.total, summary };
  }, [filter]);

  return (
    <Screen res={res} rows={6}>
      {({ entries, total, summary }) => (
    <>
      <PageHead
        title={ut("aud.title")}
        sub={ut("aud.sub")}
      />

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="tile"><div className="label">{ut("aud.totalEvents")}</div><div className="value">{total}</div></div>
        <div className="tile">
          <div className="label">{ut("aud.denied")}</div>
          <div className="value" style={{ color: summary?.deniedCount ? "var(--danger)" : undefined }}>{summary?.deniedCount ?? 0}</div>
        </div>
      </div>

      {summary ? (
        <div className="grid cols-2">
          <Chart title={ut("aud.whoOften")} hint={ut("aud.perAccount")}>
            <BarList items={summary.byActor.map((a) => ({ label: a.actorEmail, value: a.count }))} />
          </Chart>
          <Chart title={ut("aud.whatDo")} hint={ut("aud.byActionType")}>
            <BarList items={summary.byAction.slice(0, 12).map((a) => ({ label: actionLabel(a.action), value: a.count }))} />
          </Chart>
        </div>
      ) : null}

      <div className="row" style={{ marginBottom: 12 }}>
        {FILTERS.map(([v, label]) => (
          <button key={v} className={`chip ${filter === v ? "active" : ""}`} onClick={() => setFilter(v)}>
            {ut(label)}
          </button>
        ))}
      </div>

      <div className="card scroll-x">
        <table>
          <thead><tr><th>{ut("aud.when")}</th><th>{ut("aud.action")}</th><th>{ut("aud.who")}</th><th>{ut("aud.outcome")}</th><th>{ut("aud.patient")}</th><th>{ut("aud.details")}</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="muted">{dateTime(e.at)}</td>
                <td>{actionLabel(e.action)}</td>
                <td className="muted">{e.actorEmail ?? "—"}</td>
                <td style={{ color: e.outcome !== "success" ? "var(--danger)" : undefined }}>
                  {e.outcome === "success" ? "ок" : e.outcome === "denied" ? "отказано" : "ошибка"}
                </td>
                <td className="muted">{e.subjectUserId ? e.subjectUserId.slice(0, 8) : "—"}</td>
                <td className="muted" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {e.details ? JSON.stringify(e.details) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Storage />
    </>
      )}
    </Screen>
  );
}

/** Рост хранилища: что распухает — видно до того, как кончится диск */
function Storage() {
  const { ut } = useLang();
  // блок вспомогательный: не загрузился — просто не показываем, экран цел
  const { data: stats } = useResource(() => api.storageStats(), []);
  if (!stats) return null;
  const max = stats.tables[0]?.bytes ?? 1;
  return (
    <div className="card">
      <div className="card-head">
        <h2>{ut("aud.storage")}</h2>
        <span className="hint">база целиком: {stats.database}</span>
      </div>
      <table>
        <tbody>
          {stats.tables.slice(0, 10).map((t) => (
            <tr key={t.table}>
              <td style={{ width: 200, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{t.table}</td>
              <td>
                <div style={{ position: "relative", height: 10, background: "var(--surface-3)", borderRadius: 5 }}>
                  <i style={{
                    position: "absolute", left: 0, top: 0, height: "100%",
                    width: `${Math.max(2, (t.bytes / max) * 100)}%`,
                    background: "var(--s1)", borderRadius: 5, display: "block",
                  }} />
                </div>
              </td>
              <td className="num" style={{ width: 90 }}>{t.pretty}</td>
              <td className="num muted" style={{ width: 110 }}>{t.rows.toLocaleString("ru-RU")} строк</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        answer_events сдерживается ретенцией; audit_log растёт вечно by design — его
        партиционирование по месяцам станет актуальным после первых миллионов записей.
      </p>
    </div>
  );
}
