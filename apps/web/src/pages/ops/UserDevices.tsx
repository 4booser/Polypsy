import { useState } from "react";
import { api } from "../../api";
import { useLang } from "../../lang";
import { DrawerSection, Loading, useAction } from "../../ui";
import { Ic } from "../../ui/icons";
import { Button, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { ConfirmTyped } from "./dialogs";
import { Ix } from "./people2/icons";
import { fill, numDay, stamp } from "./users/parts";

/**
 * Устройства застосунку человека и команда стирания — раздел панели записи
 * в «Користувачах» (Polypsy 2.0; прежде — окно из меню строки).
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
 *
 * Строка списка — привязка этого человека к установке (миграция 0113), и
 * команда уходит этой привязке: на общем планшете у других вошедших свои
 * строки и свои команды.
 */
export function DevicesSection({ userId, name }: { userId: string; name: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.devices(userId), [userId]);
  const [wiping, setWiping] = useState<{ id: string; name: string } | null>(null);

  return (
    <DrawerSection title={ut("oppu.devices")} sub={ut("oppu.devicesSub")}>
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} bare />
      ) : !res.data ? (
        <Loading rows={2} bare />
      ) : res.data.length === 0 ? (
        <p className="m-0 text-small text-muted">{ut("dev.none")}</p>
      ) : (
        <>
          <ul className="m-0 list-none p-0" aria-label={`${ut("dev.title")}: ${name}`}>
            {res.data.map((d) => {
              const label = d.label ?? d.id.slice(0, 8);
              return (
                <li
                  key={d.id}
                  className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-divider py-2.5 first:border-t-0"
                >
                  <span className="inline-grid size-7 place-items-center rounded-[9px] bg-sunk text-muted">
                    <Ix.smartphone size={15} />
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <b className="text-body font-bold leading-5 text-text [overflow-wrap:anywhere]">{label}</b>
                      {d.wipedAt ? (
                        <Tag tone="done" icon={<Ic.check />}>
                          {`${ut("dev.wiped")} ${numDay(d.wipedAt).slice(0, 5)}`}
                        </Tag>
                      ) : d.wipeRequestedAt ? (
                        /* «ждёт связи», а не «стёрто»: команда исполнится при следующем выходе на связь */
                        <Tag tone="attention" icon={<Ix.hourglass />}>
                          {ut("dev.waiting")}
                        </Tag>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-small font-semibold text-text-2">
                          <i aria-hidden className="size-2 rounded-full bg-good" />
                          {ut("dev.active")}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-caption text-muted tabular-nums">
                      {fill(ut("oppu.deviceSeen"), { p: d.platform ?? "—", t: stamp(d.lastSeenAt) })}
                    </span>
                  </span>
                  <span className="self-center">
                    {!d.wipedAt && !d.wipeRequestedAt ? (
                      <Button size="xs" icon={<Ix.eraser />} disabled={busy} onClick={() => setWiping({ id: d.id, name: label })}>
                        {ut("dev.wipe")}
                      </Button>
                    ) : d.wipeRequestedAt && !d.wipedAt ? (
                      <span className="block text-right text-caption leading-[15px] text-muted">
                        {fill(ut("oppu.wipeOrdered"), { d: numDay(d.wipeRequestedAt).slice(0, 5) })}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="m-0 mt-2 text-caption text-muted">{ut("dev.wipeHint")}</p>
        </>
      )}
      {wiping ? (
        <ConfirmTyped
          title={ut("dev.wipe")}
          expected={wiping.name}
          warning={ut("dev.wipeHint")}
          actionLabel={ut("dev.wipe")}
          busy={busy}
          onClose={() => setWiping(null)}
          onConfirm={() =>
            void run(async () => {
              await api.wipeDevice(wiping.id, userId);
              setWiping(null);
              res.reload();
            }, ut("dev.requested"))
          }
        />
      ) : null}
    </DrawerSection>
  );
}
