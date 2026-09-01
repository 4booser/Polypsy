import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { day } from "../format";
import { Empty, Screen, useAction } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Button, Num, Textarea } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Переписка с пациентом.
 *
 * Границы названы в самом окне, а не в правилах: ответ в рабочее время, это
 * не экстренная связь. Пациент видит ту же строку у себя — обещание
 * круглосуточного ответа в психологическом отделе опаснее отсутствия
 * переписки вовсе.
 */
export default function MessagesPage() {
  const { id } = useParams();
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [text, setText] = useState("");

  const list = useResource(() => api.threads(), []);
  const thread = useResource(() => (id ? api.thread(id) : Promise.resolve(null)), [id]);

  return (
    <Screen res={list} rows={4}>
      {(data) => {
        const current = data.items.find((t) => t.id === id) ?? null;
        return (
          <Page title={ut("ms.title")} count={data.items.length || null} bleed>
            <div className="grid gap-3 p-4 max-[900px]:grid-cols-1 grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
              <Panel>
                {data.items.length === 0 ? (
                  <Empty title={ut("ms.none")} />
                ) : (
                  data.items.map((t) => (
                    <a
                      key={t.id}
                      href={`/messages/${t.id}`}
                      className={`flex items-center gap-2 border-t border-hairline px-4 py-3 first:border-t-0 ${
                        t.id === id ? "bg-surface-3" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{t.withName}</span>
                      {/*
                        Число непрочитанных, а не точка: одно письмо — обычная
                        работа, три подряд без ответа — другая история, и по
                        точке их не различить.
                      */}
                      {t.unread > 0 ? (
                        <Num className="rounded-sm bg-accent px-1.5 text-micro text-bg">
                          {t.unread}
                        </Num>
                      ) : null}
                      <Num className="text-caption text-muted">{day(t.lastMessageAt)}</Num>
                    </a>
                  ))
                )}
              </Panel>

              <Panel title={current?.withName ?? ut("ms.title")}>
                <p className="px-4 pb-3 text-caption text-muted">{ut("ms.boundaries")}</p>
                {!id ? (
                  <Empty title={ut("ms.none")} />
                ) : (
                  <>
                    <div className="flex flex-col gap-2 px-4">
                      {(thread.data?.items ?? []).length === 0 ? (
                        <Empty title={ut("ms.empty")} />
                      ) : (
                        thread.data!.items.map((m) => (
                          <div
                            key={m.id}
                            className={`max-w-[70ch] rounded-md border border-hairline p-2 ${
                              m.mine ? "self-end bg-surface-3" : "self-start"
                            }`}
                          >
                            <p className="whitespace-pre-wrap text-body">{m.text}</p>
                            <p className="mt-1 text-micro text-faint">
                              {day(m.sentAt)}
                              {m.mine ? ` · ${m.readAt ? ut("ms.read") : ut("ms.sent")}` : ""}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="flex flex-col gap-2 p-4">
                      <Textarea
                        rows={3}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={ut("ms.placeholder")}
                      />
                      <Button
                        size="sm"
                        disabled={busy || !text.trim() || !current?.patientId}
                        onClick={() =>
                          run(async () => {
                            await api.sendMessage({ patientId: current!.patientId, text });
                            setText("");
                            await thread.reload();
                            await list.reload();
                          })
                        }
                      >
                        {ut("ms.send")}
                      </Button>
                    </div>
                  </>
                )}
              </Panel>
            </div>
          </Page>
        );
      }}
    </Screen>
  );
}
