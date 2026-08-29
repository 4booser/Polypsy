import { useState } from "react";
import { api } from "../api";
import { dateTime } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useAction } from "../ui";
import { useLiveReload } from "../events";

/**
 * Полоса кризисного режима.
 *
 * Режим меняет поведение системы, и человек обязан видеть, что оно изменено,
 * без открытия настроек. Изменившийся порядок очереди без объяснения читается
 * как сбой, а не как решение руководителя.
 *
 * Что именно меняется, написано прямо в полосе: режим, про который непонятно,
 * что он делает, страшнее любого потока пациентов.
 */
export function CrisisBar({ canSwitch }: { canSwitch: boolean }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.crisis(), []);
  const [starting, setStarting] = useState(false);
  const [reason, setReason] = useState("");
  useLiveReload(["schedule.run"], res.reload);

  const state = res.data;
  if (!state) return null;

  if (!state.active) {
    if (!canSwitch) return null;
    return starting ? (
      <div className="row tight crisis-start">
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={ut("crisis.reason")}
        />
        <button
          className="danger"
          disabled={busy || reason.trim().length < 3}
          onClick={() =>
            void run(async () => {
              await api.startCrisis(reason.trim());
              setStarting(false);
              setReason("");
              res.reload();
            })
          }
        >
          {ut("crisis.start")}
        </button>
        <button className="ghost" onClick={() => setStarting(false)}>
          {ut("common.cancel")}
        </button>
      </div>
    ) : (
      <button className="ghost crisis-start" onClick={() => setStarting(true)}>
        {ut("crisis.start")}
      </button>
    );
  }

  return (
    <div className="crisis-bar" role="status">
      <strong>{ut("crisis.on")}</strong>
      <span>{state.reason}</span>
      <span className="muted">
        {ut("crisis.since")} {state.startedAt ? dateTime(state.startedAt) : ""}
      </span>
      <span className="muted">· {ut("crisis.effects")}</span>
      {canSwitch ? (
        <button
          className="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.endCrisis();
              res.reload();
            })
          }
        >
          {ut("crisis.end")}
        </button>
      ) : null}
    </div>
  );
}
