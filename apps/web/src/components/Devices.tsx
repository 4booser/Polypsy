import { api } from "../api";
import { dateTime } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useState } from "react";
import { ConfirmByName, useAction } from "../ui";

/**
 * Устройства сотрудника и команда стирания.
 *
 * Показывается только суперадмину и только по явно выбранному человеку:
 * список устройств — это сведения о нём самом, где он бывает и с чего
 * работает.
 *
 * Стирание подтверждается печатанием имени устройства. Это не бюрократия:
 * команда необратима, а строки в списке различаются одним словом — промах
 * мышью стоил бы чужой рабочей смены.
 */
export function Devices({ userId }: { userId: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.devices(userId), [userId]);
  const [confirming, setConfirming] = useState<{ id: string; name: string } | null>(null);
  const items = res.data ?? [];

  if (!items.length) return <p className="muted">{ut("dev.none")}</p>;

  const table = (
    <table>
      <thead>
        <tr>
          <th>{ut("dev.device")}</th>
          <th>{ut("dev.lastSeen")}</th>
          <th>{ut("dev.state")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id}>
            <td>
              {d.label ?? d.id.slice(0, 8)}
              <span className="muted"> · {d.platform ?? "—"}</span>
            </td>
            <td className="muted">{dateTime(d.lastSeenAt)}</td>
            <td>
              {d.wipedAt ? (
                <span className="muted">
                  {ut("dev.wiped")} {dateTime(d.wipedAt)}
                </span>
              ) : d.wipeRequestedAt ? (
                /*
                 * «Ждёт связи», а не «стёрто». Команда исполнится, когда
                 * устройство в следующий раз выйдет на связь, и называть
                 * заявку свершившимся фактом опаснее, чем неудобно.
                 */
                <span className="chip static bad">{ut("dev.waiting")}</span>
              ) : (
                <span className="muted">{ut("dev.active")}</span>
              )}
            </td>
            <td>
              {!d.wipedAt && !d.wipeRequestedAt ? (
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => setConfirming({ id: d.id, name: d.label ?? d.id.slice(0, 8) })}
                >
                  {ut("dev.wipe")}
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      {table}
      {confirming ? (
        <ConfirmByName
          title={ut("dev.wipe")}
          name={confirming.name}
          actionLabel={ut("dev.wipe")}
          warning={<p style={{ margin: 0 }}>{ut("dev.wipeHint")}</p>}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            void run(async () => {
              await api.wipeDevice(confirming.id);
              setConfirming(null);
              res.reload();
            }, ut("dev.requested"))
          }
        />
      ) : null}
    </>
  );
}
