import { useState } from "react";
import { Link, useParams } from "react-router-dom";
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
            {/*
              Панели тянутся на высоту экрана, а не сжимаются до содержимого.
              Переписку читают сверху вниз, и панель в двести пикселей на
              пустом экране означает, что три письма уже не помещаются, а
              место под ними пустует.
            */}
            <div className="grid min-h-[70vh] items-stretch gap-3 p-4 max-[900px]:grid-cols-1 grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
              <Panel>
                {data.items.length === 0 ? (
                  <Empty title={ut("ms.none")} />
                ) : (
                  data.items.map((t) => (
                    /*
                      Link, а не <a href>: обычная ссылка перезагружала всю
                      консоль на каждое переключение переписки — заново вход,
                      заново боковая колонка, заново все запросы.
                    */
                    <Link
                      key={t.id}
                      to={`/messages/${t.id}`}
                      className={`block border-t border-hairline px-4 py-3 first:border-t-0 ${
                        t.id === id ? "bg-surface-3" : ""
                      }`}
                    >
                      {/*
                        Имя занимает строку целиком, дата и непрочитанное —
                        следующую. В одну строку имя не помещалось и
                        обрезалось на «Гончаренко Та…», хотя справа пустовало
                        три четверти экрана: собеседника в переписке узнают
                        по имени, и обрезать надо что угодно, только не его.
                      */}
                      <span className="block truncate">{t.withName}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-caption text-muted">
                        <span>{day(t.lastMessageAt)}</span>
                        {/*
                          Число непрочитанных, а не точка: одно письмо —
                          обычная работа, три подряд без ответа — другая
                          история, и по точке их не различить.
                        */}
                        {t.unread > 0 ? (
                          <Num className="rounded-sm bg-accent px-1.5 text-micro text-bg">
                            {t.unread}
                          </Num>
                        ) : null}
                      </span>
                    </Link>
                  ))
                )}
              </Panel>

              {/*
                Заголовок панели — имя собеседника, и только оно. Запасным
                значением стояло название экрана, и слово «Переписка»
                оказывалось на экране трижды: в заголовке страницы, в
                заголовке панели и в пустом состоянии.
              */}
              <Panel title={current?.withName}>
                <p className="px-4 pb-3 text-caption text-muted">{ut("ms.boundaries")}</p>
                {!id ? (
                  /*
                    «Выберите переписку», а не «Переписки нет»: переписки
                    есть, просто ни одна не открыта. Панель путала «ничего не
                    выбрано» с «ничего нет» — и сообщала об отсутствии того,
                    что стояло слева в списке.
                  */
                  <Empty title={ut(data.items.length ? "ms.pick" : "ms.none")} />
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
