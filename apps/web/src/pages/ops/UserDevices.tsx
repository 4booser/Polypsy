import { useState } from "react";
import { api } from "../../api";
import { dateTime } from "../../format";
import { useLang } from "../../lang";
import { Loading, Modal, useAction } from "../../ui";
import { Button, SeverityTag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { ColumnHead } from "./controls";
import { ConfirmTyped } from "./dialogs";

const GRID = "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-x-[24px]";

/**
 * Устройства человека и команда стирания — окно из меню строки «Користувачі».
 *
 * Переехало с прежнего экрана учётных записей (/users, components/Devices):
 * снимая тот экран, возможность терять нельзя — планшет носят по отделению,
 * и потерять его проще, чем ноутбук, а на нём кэш обхода.
 *
 * Показывается суперадмину и только по выбранному человеку: список устройств
 * — сведения о нём самом, где он бывает и с чего работает (GET /api/devices
 * с чужим userId сервер отдаёт только суперадмину).
 *
 * Стирание подтверждается перепечатыванием имени устройства: команда
 * необратима, а строки различаются одним словом.
 */
export function UserDevices({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.devices(userId), [userId]);
  const [wiping, setWiping] = useState<{ id: string; name: string } | null>(null);

  if (wiping) {
    return (
      <ConfirmTyped
        title={ut("dev.wipe")}
        expected={wiping.name}
        warning={ut("dev.wipeHint")}
        actionLabel={ut("dev.wipe")}
        busy={busy}
        onClose={() => setWiping(null)}
        onConfirm={() =>
          void run(async () => {
            await api.wipeDevice(wiping.id);
            setWiping(null);
            res.reload();
          }, ut("dev.requested"))
        }
      />
    );
  }

  return (
    <Modal title={`${ut("dev.title")} · ${name}`} onClose={onClose} wide>
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={3} />
      ) : res.data.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">{ut("dev.none")}</p>
      ) : (
        <>
        <ColumnHead grid={GRID} labels={[ut("dev.device"), ut("dev.lastSeen"), ut("dev.state"), null]} />
        <ul className="m-0 list-none p-0">
          {res.data.map((d) => {
            const label = d.label ?? d.id.slice(0, 8);
            return (
              <li key={d.id} className={`${GRID} items-center border-b border-hairline py-[10px] max-[900px]:grid-cols-1 max-[900px]:gap-y-[4px]`}>
                <span className="min-w-0">
                  <span className="block text-[17px] font-bold leading-[22px] text-primary [overflow-wrap:anywhere]">{label}</span>
                  <span className="block text-[13px] text-muted">{d.platform ?? "—"}</span>
                </span>
                <span className="text-[13px] text-muted">{dateTime(d.lastSeenAt)}</span>
                <span className="text-[13px]">
                  {d.wipedAt ? (
                    <span className="text-muted">
                      {ut("dev.wiped")} {dateTime(d.wipedAt)}
                    </span>
                  ) : d.wipeRequestedAt ? (
                    /* «ждёт связи», а не «стёрто»: команда исполнится при следующем выходе на связь */
                    <SeverityTag level="severe">{ut("dev.waiting")}</SeverityTag>
                  ) : (
                    <span className="text-muted">{ut("dev.active")}</span>
                  )}
                </span>
                <span>
                  {!d.wipedAt && !d.wipeRequestedAt ? (
                    <Button variant="danger" disabled={busy} onClick={() => setWiping({ id: d.id, name: label })}>
                      {ut("dev.wipe")}
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </Modal>
  );
}
