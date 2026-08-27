import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CaseSummary as Summary, ReferralDestination, ReferralUrgency } from "@quizzy/shared";
import { api } from "../api";
import { SeverityTag } from "../charts/advanced";
import { day, dateTime } from "../format";
import { useAuth } from "../auth";
import { Loading, PageHead, useAction } from "../ui";

const DEST: Record<ReferralDestination, string> = {
  psychiatrist: "психиатр",
  inpatient: "стационар",
  outpatient: "амбулаторно",
  commander: "командиру",
  other: "иное",
};
const URGENCY: Record<ReferralUrgency, string> = {
  routine: "планово",
  urgent: "срочно",
  immediate: "немедленно",
};
const STATUS: Record<string, string> = {
  created: "выписано",
  accepted: "принято",
  completed: "завершено",
  declined: "отклонено",
};
const NEXT_STATUS: Record<string, { value: string; label: string }[]> = {
  created: [
    { value: "accepted", label: "Принято" },
    { value: "declined", label: "Отклонено" },
  ],
  accepted: [
    { value: "completed", label: "Завершено" },
    { value: "declined", label: "Отклонено" },
  ],
  completed: [],
  declined: [],
};

/**
 * Сводка для консилиума: всё о пациенте на одной странице.
 *
 * Новизна не в данных — они уже есть на семи экранах, — а в том, что их не
 * надо собирать за минуту до заседания. Печать даёт документ, который
 * подшивается.
 */
export default function CaseSummaryPage() {
  const { userId } = useParams<{ userId: string }>();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const { user } = useAuth();
  const run = useAction();

  const reload = () => {
    if (!userId) return;
    api.caseSummary(userId).then(setData).catch((e) => setError(e.message));
  };
  useEffect(reload, [userId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading />;

  return (
    <>
      {/* штамп для подшивки: без «кто и когда распечатал» лист в деле безымянный */}
      <p className="print-only hint">
        Сводка сформирована {dateTime(new Date().toISOString())}
        {user ? ` · ${user.lastName ?? ""} ${user.firstName ?? ""}`.trimEnd() : ""}
      </p>
      <PageHead
        title={data.fullName}
        crumbs={<Link to={`/patients/${data.userId}`}>← Динамика пациента</Link>}
        sub={[
          data.sex === "male" ? "муж." : data.sex === "female" ? "жен." : null,
          data.age !== null ? `${data.age} лет` : null,
          data.unit,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <div className="row tight">
            <button onClick={() => setShowForm((v) => !v)}>Выписать направление</button>
            <button onClick={() => window.print()}>Печать сводки</button>
          </div>
        }
      />

      {showForm ? (
        <ReferralForm
          userId={data.userId}
          onDone={() => {
            setShowForm(false);
            reload();
          }}
        />
      ) : null}

      {data.openAlerts.length ? (
        <div className="card alarm">
          <h2>Открытые тревоги: {data.openAlerts.length}</h2>
          {data.openAlerts.map((a) => (
            <p key={a.id} style={{ margin: "4px 0", fontSize: 13 }}>
              <strong>{a.surveyTitle}</strong> · {a.label} · {dateTime(a.at)}
            </p>
          ))}
        </div>
      ) : null}

      {data.surveys.map((s) => (
        <div className="card scroll-x" key={s.surveyId}>
          <div className="card-head">
            <h2>{s.title}</h2>
            <span className="hint">
              замеров {s.count}
              {s.lastAt ? ` · последний ${day(s.lastAt)}` : ""}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Шкала</th>
                <th className="num">Последний балл</th>
                <th>Интерпретация</th>
                <th>Динамика</th>
              </tr>
            </thead>
            <tbody>
              {s.scales.map((sc) => (
                <tr key={sc.code}>
                  <td>{sc.code} — {sc.title}</td>
                  <td className="num">{sc.lastValue}</td>
                  <td>
                    {sc.severity ? (
                      <SeverityTag severity={sc.severity} label={sc.bandLabel ?? undefined} />
                    ) : (
                      <span className="muted">{sc.bandLabel ?? "—"}</span>
                    )}
                  </td>
                  <td>
                    {!sc.reliableChange ? (
                      <span className="muted">один замер</span>
                    ) : sc.reliableChange.significant ? (
                      <strong style={{ color: "var(--accent)" }}>
                        достоверный {sc.reliableChange.direction === "up" ? "рост" : "спад"} (RCI{" "}
                        {sc.reliableChange.rci})
                      </strong>
                    ) : (
                      <span className="muted">в пределах ошибки</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {data.conclusions.length ? (
        <div className="card">
          <h2>Заключения специалистов</h2>
          {data.conclusions.map((c, i) => (
            <div className="conclusion-view" key={i} style={{ marginTop: 8 }}>
              <p style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>{c.text}</p>
              <p className="hint">
                {c.surveyTitle} · {c.authorName}
                {c.signedAt ? `, ${day(c.signedAt)}` : ""}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="card scroll-x">
        <h2>Направления</h2>
        {data.referrals.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Направлений нет</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Куда</th><th>Срочность</th><th>Статус</th><th>Основание</th>
                <th>Выписал</th><th /></tr>
            </thead>
            <tbody>
              {data.referrals.map((r) => (
                <tr key={r.id}>
                  <td>{DEST[r.destination]}</td>
                  <td className={r.urgency === "immediate" ? "bad" : undefined}>{URGENCY[r.urgency]}</td>
                  <td>{STATUS[r.status]}</td>
                  <td className="muted" style={{ maxWidth: 260, fontSize: 12 }}>
                    {r.reason ?? "—"}
                    {r.outcomeNote ? <div>Ответ: {r.outcomeNote}</div> : null}
                  </td>
                  <td className="muted">{r.createdByName}, {day(r.createdAt)}</td>
                  <td>
                    <div className="row tight no-print">
                      {(NEXT_STATUS[r.status] ?? []).map((n) => (
                        <button
                          key={n.value}
                          onClick={() =>
                            run(async () => {
                              await api.updateReferral(r.id, n.value);
                              reload();
                            }, `Направление: ${n.label.toLowerCase()}`)
                          }
                        >
                          {n.label}
                        </button>
                      ))}
                    </div>
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

function ReferralForm({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [destination, setDestination] = useState<ReferralDestination>("psychiatrist");
  const [urgency, setUrgency] = useState<ReferralUrgency>("routine");
  const [reason, setReason] = useState("");
  const run = useAction();

  return (
    <div className="card no-print">
      <div className="card-head">
        <h2>Новое направление</h2>
        <button onClick={onDone}>Закрыть</button>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Куда</span>
          <select value={destination} onChange={(e) => setDestination(e.target.value as ReferralDestination)}>
            {Object.entries(DEST).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Срочность</span>
          <select value={urgency} onChange={(e) => setUrgency(e.target.value as ReferralUrgency)}>
            {Object.entries(URGENCY).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Основание</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="что послужило поводом" />
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="primary"
          onClick={() =>
            run(async () => {
              await api.createReferral({ userId, destination, urgency, reason: reason || null });
              onDone();
            }, "Направление выписано")
          }
        >
          Выписать
        </button>
      </div>
    </div>
  );
}
