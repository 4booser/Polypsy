import { useState } from "react";
import { api, type Conference } from "../api";
import { dateTime } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Консилиум по случаю.
 *
 * Решение принимали в кабинете и записывали в тетрадь; через полгода
 * восстановить, кто что предлагал и почему решили именно так, было
 * невозможно.
 *
 * Особое мнение показывается отдельно и заметно: в клинике несогласие
 * участника должно быть видно, иначе протокол выглядит единогласным, каким
 * он не был.
 */
export function Conferences({ userId }: { userId: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.conferences(userId), [userId]);
  const [reason, setReason] = useState("");
  const items = res.data ?? [];

  return (
    <div className="card">
      <div className="card-head">
        <h2>{ut("cc.title")}</h2>
      </div>
      <p className="hint">{ut("cc.hint")}</p>

      <div className="row tight" style={{ marginBottom: 12 }}>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={ut("cc.reasonPlaceholder")}
        />
        <button
          disabled={busy || (!reason.trim())}
          onClick={() =>
            void run(async () => {
              await api.openConference(userId, reason.trim());
              setReason("");
              res.reload();
            }, ut("cc.opened"))
          }
        >
          {ut("cc.open")}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>{ut("cc.empty")}</p>
      ) : (
        items.map((cf) => <ConferenceCard key={cf.id} cf={cf} onChanged={res.reload} run={run} busy={busy} />)
      )}
    </div>
  );
}

function ConferenceCard({
  cf,
  onChanged,
  run,
  busy,
}: {
  cf: Conference;
  onChanged: () => void;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  busy: boolean;
}) {
  const { ut } = useLang();
  const [text, setText] = useState("");
  const [decision, setDecision] = useState("");
  const open = cf.status === "open";

  return (
    <div className="conference">
      <div className="row tight">
        <strong>{cf.reason}</strong>
        <span className="muted">{dateTime(cf.createdAt)}</span>
        {open ? (
          <span className="badge accent">{ut("cc.statusOpen")}</span>
        ) : (
          <span className="badge">{ut(`cc.status.${cf.status}` as never)}</span>
        )}
        {cf.opinions.some((o) => o.kind === "dissent") ? (
          <span className="badge warn">{ut("cc.hasDissent")}</span>
        ) : null}
      </div>

      {cf.opinions.map((o) => (
        <div key={o.id} className={`opinion${o.kind === "dissent" ? " dissent" : ""}`}>
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{o.text}</p>
          <p className="hint" style={{ margin: 0 }}>
            {o.authorName} · {dateTime(o.createdAt)}
            {o.kind === "dissent" ? ` · ${ut("cc.dissent")}` : ""}
          </p>
        </div>
      ))}

      {cf.decision ? (
        <div className="conclusion-view" style={{ marginTop: 8 }}>
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{cf.decision}</p>
          <p className="hint">
            {ut("cc.decided")}: {cf.decidedByName} · {dateTime(cf.decidedAt ?? "")}
          </p>
        </div>
      ) : null}

      {open ? (
        <div className="conference-actions">
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ut("cc.opinionPlaceholder")}
          />
          <div className="row tight">
            <button
              disabled={busy || (!text.trim())}
              onClick={() =>
                void run(async () => {
                  await api.addOpinion(cf.id, text.trim(), "opinion");
                  setText("");
                  onChanged();
                }, ut("cc.opinionSaved"))
              }
            >
              {ut("cc.addOpinion")}
            </button>
            <button
              className="ghost"
              disabled={busy || (!text.trim())}
              onClick={() =>
                void run(async () => {
                  await api.addOpinion(cf.id, text.trim(), "dissent");
                  setText("");
                  onChanged();
                }, ut("cc.opinionSaved"))
              }
            >
              {ut("cc.addDissent")}
            </button>
          </div>

          <input
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            placeholder={ut("cc.decisionPlaceholder")}
          />
          <button
            className="primary"
            disabled={busy || !decision.trim() || cf.opinions.length === 0}
            title={cf.opinions.length === 0 ? ut("cc.needOpinion") : undefined}
            onClick={() =>
              void run(async () => {
                await api.decideConference(cf.id, decision.trim());
                setDecision("");
                onChanged();
              }, ut("cc.decidedToast"))
            }
          >
            {ut("cc.decide")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
