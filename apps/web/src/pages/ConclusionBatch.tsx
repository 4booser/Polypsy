import { useState } from "react";
import { api } from "../api";
import { dateTime, day } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { PageHead } from "../ui";

/**
 * Пакет заключений: подразделение за период одним документом.
 *
 * Отчёты подшивают в дело, и печатать их по одному — это открыть карту,
 * нажать печать, дождаться, вернуться, и так семьдесят раз.
 *
 * Документ устроен как подшивка: оглавление на первой странице, дальше по
 * заключению на страницу. Разрыв ставится принудительно, а не «как ляжет»:
 * два заключения на одном листе нельзя подшить в разные дела.
 */
export default function ConclusionBatch() {
  const { ut } = useLang();
  const [unit, setUnit] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<{ unit: string; from: string; to: string } | null>(null);

  const res = useResource(
    () => api.conclusionBatch(applied!.unit, applied!.from, applied!.to),
    [applied],
    { enabled: !!applied },
  );
  const units = useResource(() => api.unitReportUnits(), []);
  const items = res.data?.items ?? [];

  return (
    <>
      <PageHead title={ut("cbatch.title")} sub={ut("cbatch.sub")} />

      <div className="card no-print">
        <div className="row tight">
          <div className="field">
            <label>{ut("person.unit")}</label>
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="">{ut("cbatch.allUnits")}</option>
              {(units.data ?? []).map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{ut("cbatch.from")}</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>{ut("cbatch.to")}</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ alignSelf: "end" }}>
            <button className="primary" onClick={() => setApplied({ unit, from, to })}>
              {ut("cbatch.collect")}
            </button>
          </div>
        </div>
        {applied ? (
          <div className="row tight" style={{ marginTop: 8 }}>
            <span className="muted">
              {ut("cbatch.collected")}: {items.length}
            </span>
            {items.length ? (
              <button onClick={() => window.print()}>{ut("cbatch.print")}</button>
            ) : null}
          </div>
        ) : null}
      </div>

      {applied && !items.length && !res.loading ? (
        <p className="muted">{ut("cbatch.nothing")}</p>
      ) : null}

      {items.length ? (
        <div className="batch">
          {/* оглавление: подшивку листают по нему, а не перебором страниц */}
          <section className="batch-toc">
            <h2>{ut("cbatch.toc")}</h2>
            <p className="hint">
              {res.data?.unit ?? ut("cbatch.allUnits")} ·{" "}
              {res.data?.from ? day(res.data.from) : "…"} — {res.data?.to ? day(res.data.to) : "…"} ·{" "}
              {ut("cbatch.printedAt")} {dateTime(new Date().toISOString())}
            </p>
            <ol>
              {items.map((i) => (
                <li key={i.id}>
                  {i.patientName} · {i.surveyTitle} · {i.signedAt ? day(i.signedAt) : ""}
                </li>
              ))}
            </ol>
          </section>

          {items.map((i, n) => (
            <article key={i.id} className="batch-item">
              <header>
                <h2>
                  {n + 1}. {i.patientName}
                </h2>
                <p className="hint">
                  {i.unit ?? "—"} · {i.surveyTitle} ·{" "}
                  {i.submittedAt ? day(i.submittedAt) : ""}
                </p>
              </header>
              <p className="batch-text">{i.text}</p>
              <footer className="hint">
                {ut("cbatch.signedBy")} {i.authorName} ·{" "}
                {i.signedAt ? dateTime(i.signedAt) : ""} · {ut("note.version")} {i.version}
              </footer>
            </article>
          ))}
        </div>
      ) : null}
    </>
  );
}
