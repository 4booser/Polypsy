import { useState } from "react";
import { api, type Conference } from "../api";
import { dateTime } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Panel } from "../ui/layout";
import { Button, Input, Textarea } from "../ui/primitives";

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
    <Panel title={ut("cc.title")} hint={ut("cc.hint")}>
      <div className="row tight mb-3">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={ut("cc.reasonPlaceholder")}
        />
        <Button
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
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="m-0 text-caption text-muted">{ut("cc.empty")}</p>
      ) : (
        items.map((cf) => <ConferenceCard key={cf.id} cf={cf} onChanged={res.reload} run={run} busy={busy} />)
      )}
    </Panel>
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
        <span className="text-muted">{dateTime(cf.createdAt)}</span>
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
          <p className="m-0 whitespace-pre-wrap">{o.text}</p>
          <p className="m-0 text-caption text-muted">
            {o.authorName} · {dateTime(o.createdAt)}
            {o.kind === "dissent" ? ` · ${ut("cc.dissent")}` : ""}
          </p>
        </div>
      ))}

      {cf.decision ? (
        <div className="conclusion-view mt-2">
          <p className="m-0 whitespace-pre-wrap">{cf.decision}</p>
          <p className="text-caption text-muted">
            {ut("cc.decided")}: {cf.decidedByName} · {dateTime(cf.decidedAt ?? "")}
          </p>
        </div>
      ) : null}

      {open ? (
        <div className="conference-actions">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ut("cc.opinionPlaceholder")}
          />
          <div className="row tight">
            <Button
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
            </Button>
            <Button
              variant="quiet"
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
            </Button>
          </div>

          <Input
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            placeholder={ut("cc.decisionPlaceholder")}
          />
          <Button
            variant="primary"
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
          </Button>
        </div>
      ) : null}
    </div>
  );
}
