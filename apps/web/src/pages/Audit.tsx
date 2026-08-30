import { useState } from "react";
import type { UiKey } from "@quizzy/shared";
import { api } from "../api";
import { BarList, Chart } from "../charts";
import { dateTime } from "../format";
import { Screen } from "../ui";
import { Page, Panel, Grid, Stack } from "../ui/layout";
import { Stat, Tag, Toolbar } from "../ui/primitives";
import { cx } from "../ui/cx";
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
        <Page
          title={ut("aud.title")}
          sub={ut("aud.sub")}
          toolbar={
            <Toolbar>
              {FILTERS.map(([v, label]) => (
                <button
                  key={v}
                  className={cx("chip", filter === v && "active")}
                  aria-pressed={filter === v}
                  onClick={() => setFilter(v)}
                >
                  {ut(label)}
                </button>
              ))}
            </Toolbar>
          }
        >
          <Stack>
            <Grid min={200}>
              <Panel>
                <Stat value={total} label={ut("aud.totalEvents")} />
              </Panel>
              <Panel>
                <Stat
                  value={summary?.deniedCount ?? 0}
                  label={ut("aud.denied")}
                  tone={summary?.deniedCount ? "danger" : "plain"}
                />
              </Panel>
            </Grid>

            {summary ? (
              <Grid min={320}>
                <Chart title={ut("aud.whoOften")} hint={ut("aud.perAccount")}>
                  <BarList items={summary.byActor.map((a) => ({ label: a.actorEmail, value: a.count }))} />
                </Chart>
                <Chart title={ut("aud.whatDo")} hint={ut("aud.byActionType")}>
                  <BarList items={summary.byAction.slice(0, 12).map((a) => ({ label: actionLabel(a.action), value: a.count }))} />
                </Chart>
              </Grid>
            ) : null}

            <Panel flush>
              <div className="overflow-x-auto">
                <table>
                  <thead><tr><th>{ut("aud.when")}</th><th>{ut("aud.action")}</th><th>{ut("aud.who")}</th><th>{ut("aud.outcome")}</th><th>{ut("aud.patient")}</th><th>{ut("aud.details")}</th></tr></thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id}>
                        <td className="text-muted">{dateTime(e.at)}</td>
                        <td>{actionLabel(e.action)}</td>
                        <td className="text-muted">{e.actorEmail ?? "—"}</td>
                        <td>
                          {e.outcome === "success" ? (
                            "ок"
                          ) : (
                            <Tag tone="danger">{e.outcome === "denied" ? "отказано" : "ошибка"}</Tag>
                          )}
                        </td>
                        <td className="text-muted">{e.subjectUserId ? e.subjectUserId.slice(0, 8) : "—"}</td>
                        <td className="max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap text-muted">
                          {e.details ? JSON.stringify(e.details) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Storage />
          </Stack>
        </Page>
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
  const max = stats.tables[0]?.totalBytes ?? 1;
  return (
    <Panel
      title={ut("aud.storage")}
      actions={<span className="text-caption text-muted">{ut("aud.wholeDatabase")}: {stats.database.pretty}</span>}
    >
      <div className="overflow-x-auto">
        <table>
          <tbody>
            {stats.tables.slice(0, 10).map((t) => (
              <tr key={t.table}>
                <td className="w-[200px] font-mono text-caption">{t.table}</td>
                <td>
                  <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-3">
                    <i
                      className="absolute inset-y-0 left-0 block rounded-full bg-[var(--s1)]"
                      style={{ width: `${Math.max(2, (t.totalBytes / max) * 100)}%` }}
                    />
                  </div>
                </td>
                <td className="num w-[90px]">{t.totalPretty}</td>
                <td className="num w-[110px] text-muted">{t.rows.toLocaleString("uk-UA")} {ut("aud.rows")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mb-0 mt-3 text-caption text-muted">
        answer_events сдерживается ретенцией; audit_log растёт вечно by design — его
        партиционирование по месяцам станет актуальным после первых миллионов записей.
      </p>
    </Panel>
  );
}
