import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ReferralDestination, ReferralUrgency } from "@quizzy/shared";
import { api } from "../api";
import { SeverityTag } from "../charts/advanced";
import { day, dateTime } from "../format";
import { useAuth } from "../auth";
import { PageHead, Screen, useAction } from "../ui";
import { useLang } from "../lang";
import { NotesEditor } from "../components/NotesEditor";
import { SafetyPlanEditor } from "../components/SafetyPlanEditor";
import { Goals } from "../components/Goals";
import { Conferences } from "../components/Conferences";
import { useResource } from "../useResource";
/*
 * Подписи направлений берутся из экрана направлений: держать вторую копию
 * тех же словарей — верный способ однажды показать «принято» в одном месте
 * и «прийнято» в другом.
 */
import { DESTINATION_KEY, NEXT_STATUS, STATUS_KEY, URGENCY_KEY } from "./Referrals";


/**
 * Сводка для консилиума: всё о пациенте на одной странице.
 *
 * Новизна не в данных — они уже есть на семи экранах, — а в том, что их не
 * надо собирать за минуту до заседания. Печать даёт документ, который
 * подшивается.
 */
export default function CaseSummaryPage() {
  const { userId } = useParams<{ userId: string }>();
  const [showForm, setShowForm] = useState(false);
  const { user } = useAuth();
  const { ut } = useLang();
  const run = useAction();

  const res = useResource(() => api.caseSummary(userId!), [userId], { enabled: !!userId });
  const reload = res.reload;

  return (
    <Screen res={res}>
      {(data) => (
    <>
      {/* штамп для подшивки: без «кто и когда распечатал» лист в деле безымянный */}
      <p className="print-only hint">
        {ut("sum.formedAt")} {dateTime(new Date().toISOString())}
        {user ? ` · ${user.lastName ?? ""} ${user.firstName ?? ""}`.trimEnd() : ""}
      </p>
      <PageHead
        title={data.fullName}
        crumbs={<Link to={`/patients/${data.userId}`}>← {ut("pt.dynamics")}</Link>}
        sub={[
          data.sex === "male" ? ut("adm.male") : data.sex === "female" ? ut("adm.female") : null,
          data.age !== null ? `${data.age}` : null,
          data.unit,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <div className="row tight">
            <Link className="btn" to={`/patients/${data.userId}/timeline`}>{ut("tl.title")}</Link>
            <button onClick={() => setShowForm((v) => !v)}>{ut("ref.new")}</button>
            <button onClick={() => window.print()}>{ut("sum.print")}</button>
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
          <h2>{ut("sum.openAlerts")}: {data.openAlerts.length}</h2>
          {data.openAlerts.map((a) => (
            <p key={a.id} style={{ margin: "4px 0", fontSize: 13 }}>
              <strong>{a.surveyTitle}</strong> · {a.label} · {dateTime(a.at)}
            </p>
          ))}
        </div>
      ) : null}

      {/*
        Две колонки, а не один столбец: карта выросла до двух экранов
        прокрутки, и «что измерено» перестало помещаться рядом с «что делать».
        Слева — измерения и цели, справа — клинические действия: план
        безопасности, записи приёма, консилиум, направления.
      */}
      <div className="patient-card">
        <div className="pc-measures">
      {data.surveys.map((s) => (
        <div className="card scroll-x" key={s.surveyId}>
          <div className="card-head">
            <h2>{s.title}</h2>
            <span className="hint">
              {ut("sum.measurements")} {s.count}
              {s.lastAt ? ` · ${ut("sum.lastAt")} ${day(s.lastAt)}` : ""}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>{ut("sum.scale")}</th>
                <th className="num">{ut("sum.lastScore")}</th>
                <th>{ut("sum.interpretation")}</th>
                <th>{ut("sum.trend")}</th>
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
                      <span className="muted">{ut("sum.oneMeasure")}</span>
                    ) : sc.reliableChange.significant ? (
                      <strong style={{ color: "var(--accent)" }}>
                        {sc.reliableChange.direction === "up" ? ut("sum.reliableUp") : ut("sum.reliableDown")} (RCI{" "}
                        {sc.reliableChange.rci})
                      </strong>
                    ) : (
                      <span className="muted">{ut("sum.withinError")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <Goals userId={data.userId} summary={data} />
        </div>

        <div className="pc-actions">
          {/* план безопасности первым: в кризис открывают его */}
          <SafetyPlanEditor userId={data.userId} />

          <div className="card">
            <NotesEditor userId={data.userId} />
          </div>

          <Conferences userId={data.userId} />

          {data.conclusions.length ? (
        <div className="card">
          <h2>{ut("sum.conclusions")}</h2>
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
        <h2>{ut("ref.title")}</h2>
        {data.referrals.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{ut("ref.none")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{ut("ref.where")}</th><th>{ut("ref.urgency")}</th><th>{ut("ref.status")}</th><th>{ut("ref.reason")}</th>
                <th>{ut("ref.issuedToast")}</th><th /></tr>
            </thead>
            <tbody>
              {data.referrals.map((r) => (
                <tr key={r.id}>
                  <td>{ut(DESTINATION_KEY[r.destination])}</td>
                  <td className={r.urgency === "immediate" ? "bad" : undefined}>{ut(URGENCY_KEY[r.urgency])}</td>
                  <td>{ut(STATUS_KEY[r.status])}</td>
                  <td className="muted" style={{ maxWidth: 260, fontSize: 12 }}>
                    {r.reason ?? "—"}
                    {r.outcomeNote ? <div>{ut("ref.answer")}: {r.outcomeNote}</div> : null}
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
                            }, ut(n.key))
                          }
                        >
                          {ut(n.key)}
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
        </div>
      </div>
    </>
      )}
    </Screen>
  );
}

function ReferralForm({ userId, onDone }: { userId: string; onDone: () => void }) {
  const { ut } = useLang();
  const [destination, setDestination] = useState<ReferralDestination>("psychiatrist");
  const [urgency, setUrgency] = useState<ReferralUrgency>("routine");
  const [reason, setReason] = useState("");
  const run = useAction();

  return (
    <div className="card no-print">
      <div className="card-head">
        <h2>{ut("ref.new")}</h2>
        <button onClick={onDone}>{ut("ui.close")}</button>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>{ut("ref.where")}</span>
          <select value={destination} onChange={(e) => setDestination(e.target.value as ReferralDestination)}>
            {Object.entries(DESTINATION_KEY).map(([v, k]) => (
              <option key={v} value={v}>{ut(k)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{ut("ref.urgency")}</span>
          <select value={urgency} onChange={(e) => setUrgency(e.target.value as ReferralUrgency)}>
            {Object.entries(URGENCY_KEY).map(([v, k]) => (
              <option key={v} value={v}>{ut(k)}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>{ut("ref.reason")}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={ut("ref.reasonPlaceholder")} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="primary"
          onClick={() =>
            run(async () => {
              await api.createReferral({ userId, destination, urgency, reason: reason || null });
              onDone();
            }, ut("ref.issuedToast"))
          }
        >
          {ut("ref.issue")}
        </button>
      </div>
    </div>
  );
}
