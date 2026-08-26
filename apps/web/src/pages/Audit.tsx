import { useEffect, useState } from "react";
import type { AuditEntry } from "@quizzy/shared";
import { api } from "../api";
import { BarList, Chart } from "../charts";
import { dateTime } from "../format";

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Вход",
  "auth.login_failed": "Неудачный вход",
  "auth.register": "Регистрация",
  "user.create": "Создание учётной записи",
  "user.list": "Просмотр учётных записей",
  "survey.create": "Создание методики",
  "survey.update": "Правка методики",
  "survey.publish": "Публикация методики",
  "survey.delete": "Удаление методики",
  "survey.duplicate": "Копия методики",
  "group.create": "Создание группы",
  "group.admin_assign": "Назначение админа группы",
  "group.admin_revoke": "Снятие админа группы",
  "access.grant": "Назначение методики пациенту",
  "access.revoke": "Отзыв назначения",
  "access.grant_list": "Просмотр назначений",
  "access.denied": "Отказ в доступе",
  "response.submit": "Прохождение отправлено",
  "response.list": "Просмотр прохождений",
  "response.read": "Просмотр карты",
  "response.draft": "Черновик",
  "analytics.overview": "Просмотр сводки",
  "analytics.survey": "Просмотр аналитики",
  "analytics.export": "Выгрузка данных",
  "report.render": "Печать заключения",
  "alert.list": "Просмотр тревог",
  "alert.acknowledge": "Разбор тревоги",
  "audit.read": "Чтение журнала",
};

const FILTERS = [
  ["", "Всё"],
  ["response.read", "Доступ к картам"],
  ["analytics.export", "Выгрузки"],
  ["access.grant", "Назначения"],
  ["access.denied", "Отказы"],
  ["auth.login_failed", "Неудачные входы"],
] as const;

export default function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.auditSummary>> | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.audit({ action: filter || undefined }), api.auditSummary()])
      .then(([page, s]) => {
        setEntries(page.entries);
        setTotal(page.total);
        setSummary(s);
      })
      .catch((e) => setError(e.message));
  }, [filter]);

  if (error) return <p className="error">{error}</p>;
  if (!entries) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <h1>Журнал доступа</h1>
      <p className="sub">Фиксируются и обращения к данным пациентов, а не только изменения. Записи не редактируются.</p>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="tile"><div className="label">Всего событий</div><div className="value">{total}</div></div>
        <div className="tile">
          <div className="label">Отказов в доступе</div>
          <div className="value" style={{ color: summary?.deniedCount ? "var(--danger)" : undefined }}>{summary?.deniedCount ?? 0}</div>
        </div>
      </div>

      {summary ? (
        <div className="grid cols-2">
          <Chart title="Кто чаще обращается" hint="Событий на учётную запись">
            <BarList items={summary.byActor.map((a) => ({ label: a.actorEmail, value: a.count }))} />
          </Chart>
          <Chart title="Что делают" hint="Распределение по типам действий">
            <BarList items={summary.byAction.slice(0, 12).map((a) => ({ label: ACTION_LABEL[a.action] ?? a.action, value: a.count }))} />
          </Chart>
        </div>
      ) : null}

      <div className="row" style={{ marginBottom: 12 }}>
        {FILTERS.map(([v, label]) => (
          <button key={v} className={`chip ${filter === v ? "active" : ""}`} onClick={() => setFilter(v)}>{label}</button>
        ))}
      </div>

      <div className="card scroll-x">
        <table>
          <thead><tr><th>Когда</th><th>Действие</th><th>Кто</th><th>Исход</th><th>Пациент</th><th>Подробности</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="muted">{dateTime(e.at)}</td>
                <td>{ACTION_LABEL[e.action] ?? e.action}</td>
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
    </>
  );
}
