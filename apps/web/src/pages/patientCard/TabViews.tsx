import { Link } from "react-router-dom";
import { dateTime } from "../../format";
import { useLang } from "../../lang";
import { Empty, Ic, Loading, TextAction } from "../../ui";
import { Panel } from "../../ui/layout";
import { Button, SeverityTag, Tag } from "../../ui/primitives";
import { InlineAction } from "./Banner";
import { dm } from "./format";
import { Pi } from "./icons";
import { resultRows } from "./model";
import type { CardView } from "./types";

/*
 * Вкладки рабочего места, у которых нет своей логики: «Заміри» — все сданные
 * методики с результатом по шкалам — и «Листування». Остальные — в своих
 * файлах: «Огляд» (Overview), «Динаміка» (Dynamics), «Записи» (Records),
 * «Направлення» (ReferralsTab), «Хронологія» (Timeline).
 */

/**
 * «Заміри»: дата, методика, результат — по шкале в строке — и заключение
 * по этому замеру. Колонки «Статистика» нет: она повторяла дату и печатала
 * служебные коды шкал с долей от максимума («anxiety 68,2%»).
 */
export function MeasuresTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  const list = v.card.responses;
  return (
    <Panel title={ut("card.tMeasures")} icon={<Ic.clipboard />} count={list.length} flush>
      {!list.length ? (
        <Empty compact title={ut("pcard.noTests")} />
      ) : (
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="[&>th]:h-[34px] [&>th]:border-y [&>th]:border-divider [&>th]:bg-panel-2 [&>th]:px-3 [&>th]:text-left [&>th]:text-caption [&>th]:font-bold [&>th]:text-muted">
              <th className="w-[76px] !pl-4">{ut("card.colDate")}</th>
              <th className="w-[30%]">{ut("card.colInstrument")}</th>
              <th>{ut("pcard.result")}</th>
              <th className="w-[150px] !pr-4">{ut("pcard.conclusions")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const rows = resultRows(r.scales);
              const concl = v.card.conclusions.filter((c) => c.responseId === r.responseId);
              const signed = concl.find((c) => c.status === "signed");
              const draft = concl.find((c) => c.status === "draft");
              return (
                <tr key={r.responseId} className="[&>td]:border-b [&>td]:border-divider [&>td]:px-3 [&>td]:py-2.5 [&>td]:align-top hover:[&>td]:bg-panel-2">
                  <td className="!pl-4 whitespace-nowrap tabular-nums text-text-2">{r.submittedAt ? dm(r.submittedAt) : "—"}</td>
                  <td>
                    {/* у замера с баллами — сразу его графики, рядом с протоколом (решение заказчика 2026-09-26) */}
                    <Link
                      to={
                        r.scales.length
                          ? `/surveys/${r.surveyId}/responses/${r.responseId}/charts`
                          : `/surveys/${r.surveyId}/responses/${r.responseId}`
                      }
                      className="font-bold text-violet-ink"
                    >
                      {r.surveyTitle}
                    </Link>
                  </td>
                  <td className="text-small text-text-2">
                    {rows.length ? (
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {rows.map((s, i) => (
                          <li key={s.title} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="text-muted">{s.title}:</span> <b className="font-extrabold text-text">{s.value}</b>
                            {s.band ? (
                              <SeverityTag level={r.scales[i]?.severity ?? "none"} small className="!h-auto min-h-[20px] !whitespace-normal py-[2px] leading-[14px]">
                                {s.band}
                              </SeverityTag>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-muted">{ut("pcard.noScores")}</span>
                    )}
                    {/* недостоверный протокол — словом при результате: читать его балл как обычный нельзя */}
                    {r.reliable ? null : <span className="mt-1 block font-bold text-warn">{ut("pcard.unreliable")}</span>}
                  </td>
                  <td className="!pr-4 text-small">
                    {signed ? (
                      <Link to={`/responses/${r.responseId}/conclusion`} className="inline-flex items-center gap-1 font-bold text-good">
                        <Ic.check size={13} />
                        {ut("ws.conclSignedOn").replace("{d}", dm(signed.signedAt ?? signed.createdAt))}
                      </Link>
                    ) : null}
                    {draft ? (
                      <span className="flex items-center gap-1.5">
                        <Tag icon={<Pi.filePen />}>{ut("card.draft")}</Tag>
                        {v.can("conclusions.write") ? (
                          <InlineAction onClick={() => v.open("concl", { responseId: r.responseId })}>{ut("card.continue")}</InlineAction>
                        ) : null}
                      </span>
                    ) : null}
                    {!signed && !draft && v.can("conclusions.write") ? (
                      <InlineAction onClick={() => v.open("concl", { responseId: r.responseId })}>{ut("ws.writeConcl")}</InlineAction>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function MessagesTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  const list = v.messages ?? [];
  return (
    <Panel
      title={ut("card.tMessages")}
      icon={<Pi.messageSquare />}
      count={list.length || null}
      actions={
        <>
          {v.thread ? <TextAction to={`/messages/${v.thread.id}`}>{ut("card.toMessages")}</TextAction> : null}
          {v.can("messages.write") ? (
            <Button variant="primary" size="xs" icon={<Ic.reply />} onClick={() => v.open("thread")}>
              {ut("card.write")}
            </Button>
          ) : null}
        </>
      }
    >
      {!v.messages && v.thread ? (
        <Loading rows={3} bare />
      ) : !list.length ? (
        <p className="m-0 text-small text-muted">{ut("card.noMessages")}</p>
      ) : (
        <div className="flex max-w-[720px] flex-col gap-2">
          {list.map((m) => (
            <div
              key={m.id}
              className={
                m.mine
                  ? "max-w-[84%] self-end rounded-[16px] rounded-br-[6px] bg-violet-tint px-[13px] py-[9px] text-[13px] leading-[19px] text-text"
                  : "max-w-[84%] self-start rounded-[16px] rounded-bl-[6px] bg-sunk px-[13px] py-[9px] text-[13px] leading-[19px] text-text"
              }
            >
              <span className="whitespace-pre-wrap">{m.text}</span>
              <small className="mt-[3px] block text-[11.5px] leading-[15px] text-muted">{dateTime(m.sentAt)}</small>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
