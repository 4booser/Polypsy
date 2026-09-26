import { useState } from "react";
import type { OpsServiceStatus } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { dateTime } from "../../../format";
import { useLang } from "../../../lang";
import { refreshServiceStatus } from "../../../service/status";
import { Screen, useAction } from "../../../ui";
import { Button, Field, Input, Select, Textarea } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { StatusLine } from "../../Status";
import { localInputToIso } from "./model";

/**
 * Раздел «Обслуговування» техпанели: режим обслуживания одной кнопкой,
 * объявления о состоянии, история объявлений с авторами.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункты 8 и 10).
 *
 * Смотрит ops.read, меняет ops.manage. Без права на изменение форма не
 * рисуется вовсе, а не рисуется выключенной: выключенная кнопка обещает,
 * что её можно включить, и человек ищет, чего не хватает. Вместо формы —
 * строка, какое право нужно.
 */
export default function OpsMaintenance() {
  const { ut } = useLang();
  const { can } = useAuth();
  const manage = can("ops.manage");
  const res = useResource(() => api.opsStatus(), []);
  const { run, busy } = useAction();

  const [message, setMessage] = useState("");
  const [until, setUntil] = useState("");
  const [kind, setKind] = useState<"ok" | "degraded">("degraded");
  const [note, setNote] = useState("");

  async function publish(input: Parameters<typeof api.opsAnnounce>[0]) {
    await api.opsAnnounce(input);
    res.reload();
    // баннер этой же вкладки — сразу, а не через две минуты опроса
    await refreshServiceStatus();
  }

  return (
    <Screen res={res}>
      {(data: OpsServiceStatus) => {
        const on = data.current.status === "maintenance";
        return (
          <>
            <RuleSection title={ut("mt.mode")} hint={ut("mt.modeHint")}>
              <div className="mb-[18px] flex flex-col gap-[6px]">
                <StatusLine status={data.current.status} />
                {data.current.since ? (
                  <span className="text-[13px] text-muted">
                    {ut("svc.since")} <span className="font-mono tabular-nums">{dateTime(data.current.since)}</span>
                    {data.history[0]?.by ? ` · ${data.history[0].by}` : ""}
                  </span>
                ) : null}
                {data.current.expectedEnd ? (
                  <span className="text-[13px] text-muted">
                    {ut("svc.until")} <span className="font-mono tabular-nums">{dateTime(data.current.expectedEnd)}</span>
                  </span>
                ) : null}
                {data.current.auto === "db" ? <span className="text-[13px] text-accent">{ut("svc.autoDb")}</span> : null}
              </div>

              {manage ? (
                <div className="flex max-w-[560px] flex-col">
                  {on ? null : (
                    <>
                      <Field label={ut("mt.message")}>
                        <Textarea rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
                      </Field>
                      <Field label={ut("mt.until")} labelClassName="mb-[4px] block text-[13px] font-bold text-muted">
                        <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className="w-[260px]" />
                      </Field>
                    </>
                  )}
                  {/*
                    Одна кнопка — главное действие раздела: «включить» и
                    «выключить» не стоят рядом, чтобы не промахнуться. Включение
                    спрашивает подтверждение: оно закрывает запись всем сразу,
                    включая пациентов посреди методики. Выключение — нет:
                    возвращать работу людям незачем переспрашивать.
                  */}
                  <Button
                    size="md"
                    className="mt-[8px] w-fit px-[24px]"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (on) {
                          await publish({ status: "ok", message: null, expectedEnd: null });
                        } else {
                          if (!window.confirm(ut("mt.confirmOn"))) return false;
                          await publish({
                            status: "maintenance",
                            message: message.trim() || null,
                            expectedEnd: localInputToIso(until),
                          });
                          setMessage("");
                          setUntil("");
                        }
                      }, ut("mt.done"))
                    }
                  >
                    {on ? ut("mt.off") : ut("mt.on")}
                  </Button>
                </div>
              ) : (
                <p className="m-0 text-[13px] text-muted">{ut("mt.needManage")}</p>
              )}
            </RuleSection>

            {manage ? (
              <RuleSection title={ut("mt.announce")} hint={ut("mt.announceHint")}>
                <div className="flex max-w-[560px] flex-col">
                  <Field label={ut("mt.status")}>
                    <Select value={kind} onChange={(e) => setKind(e.target.value as "ok" | "degraded")} className="w-[260px]">
                      <option value="degraded">{ut("svc.status.degraded")}</option>
                      <option value="ok">{ut("svc.status.ok")}</option>
                    </Select>
                  </Field>
                  <Field label={ut("mt.message")}>
                    <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  <Button
                    variant="quiet"
                    className="mt-[8px] w-fit"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await publish({ status: kind, message: note.trim() || null, expectedEnd: null });
                        setNote("");
                      }, ut("mt.done"))
                    }
                  >
                    {ut("mt.publish")}
                  </Button>
                </div>
              </RuleSection>
            ) : null}

            <RuleSection title={ut("svc.history")}>
              {data.history.length ? (
                <ul className="m-0 list-none p-0">
                  <li
                    aria-hidden
                    className="grid grid-cols-[200px_170px_1fr_200px] gap-x-[24px] pb-[6px] text-[13px] font-bold text-muted max-[900px]:hidden"
                  >
                    <span>{ut("mt.when")}</span>
                    <span>{ut("mt.status")}</span>
                    <span>{ut("mt.message")}</span>
                    <span>{ut("mt.by")}</span>
                  </li>
                  {data.history.map((a) => (
                    <li
                      key={a.id}
                      className="grid grid-cols-[200px_170px_1fr_200px] gap-x-[24px] border-t border-hairline py-[10px] text-[14px] leading-[20px] max-[900px]:grid-cols-1 max-[900px]:gap-y-[2px]"
                    >
                      <span className="font-mono tabular-nums text-muted">{dateTime(a.at)}</span>
                      <StatusLine status={a.status} small />
                      <span className="min-w-0 whitespace-pre-line text-text [overflow-wrap:anywhere]">
                        {a.message ?? "—"}
                        {a.expectedEnd ? (
                          <span className="block text-muted">
                            {ut("svc.until")} <span className="font-mono tabular-nums">{dateTime(a.expectedEnd)}</span>
                          </span>
                        ) : null}
                      </span>
                      <span className="min-w-0 truncate text-muted">{a.by ?? "—"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-[13px] text-muted">{ut("svc.noHistory")}</p>
              )}
            </RuleSection>
          </>
        );
      }}
    </Screen>
  );
}
