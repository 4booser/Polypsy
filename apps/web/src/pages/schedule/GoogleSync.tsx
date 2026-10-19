import { useState } from "react";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { Modal, useAction } from "../../ui";
import { Ic } from "../../ui/icons";
import { IconTile, Panel } from "../../ui/layout";
import { Button, Tag } from "../../ui/primitives";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { G } from "./glyphs";

/**
 * Календарь Google специалиста — для ссылок Meet на онлайн-прийоми.
 *
 * Сервер создаёт событие со ссылкой сам, когда онлайн-прийом записан к
 * специалисту с подключённым календарём, переносит его вместе с приёмом и
 * снимает при отмене (lib/meetSync.ts); в название события имя пациента не
 * идёт. Здесь — честное состояние этой связи и отключение.
 *
 * Панели нет вовсе, когда на сервере Google не настроен или состояние
 * спрашивать нельзя (нет права вести приёмы): говорить «не підключено» там,
 * где подключить нечем, — значит обещать то, чего не будет.
 */
export function GoogleSync() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  /* без права вести приёмы сервер ответит отказом и запишет его в журнал: не спрашиваем вовсе */
  const allowed = useAuth().can("appointments.manage");
  const res = useResource(() => api.meetStatus(), [], { enabled: allowed });
  const [asking, setAsking] = useState(false);
  const s = res.data;
  if (!allowed || !s || !s.configured) return null;

  return (
    <Panel title={ut("v2s.google")} icon={<Ic.refresh />} sub={ut("v2s.googleSub")}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <IconTile icon={<Ic.calendar />} tone="info" />
          <div className="min-w-0">
            <b className="block text-h3 font-extrabold text-text">{ut("v2s.googleCalendar")}</b>
            {s.connected ? (
              <Tag tone="good" icon={<Ic.check />} className="mt-1">
                {ut("v2s.googleOn")}
              </Tag>
            ) : (
              <Tag className="mt-1">{ut("v2s.googleOff")}</Tag>
            )}
            {s.connected && s.email ? <p className="m-0 mt-1.5 text-small text-text-2">{s.email}</p> : null}
          </div>
        </div>
        <p className="m-0 min-w-[240px] flex-1 text-small text-text-2">
          {ut(s.connected ? "v2s.googleOnNote" : "v2s.googleOffNote")}
        </p>
        {s.connected ? (
          <Button size="xs" variant="ghost" icon={<G.unplug />} disabled={busy} onClick={() => setAsking(true)}>
            {ut("v2s.googleDisconnect")}
          </Button>
        ) : null}
      </div>
      {asking ? (
        <Modal
          title={ut("v2s.googleDisconnectAsk")}
          sub={s.email ?? undefined}
          icon={<G.unplug />}
          tone="warn"
          width={480}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.meetDisconnect();
                    setAsking(false);
                    res.reload();
                  }, ut("v2s.googleDisconnected"))
                }
              >
                {ut("v2s.googleDisconnect")}
              </Button>
              <Button onClick={() => setAsking(false)}>{ut("visit.cancel")}</Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("v2s.googleDisconnectBody")}</p>
        </Modal>
      ) : null}
    </Panel>
  );
}
