import { useState } from "react";
import { Callout, Ic, Modal } from "../ui";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Button, ButtonLink, Tag } from "../ui/primitives";
import { Glyph } from "./icons";
import type { OutboxItem } from "./outbox";
import { COLUMN, CodeTile, MetaLine, PtPanel } from "./parts";
import { whenSaid } from "./when";

/**
 * Очередь несданных ответов в кабинете (patient/outbox.ts).
 *
 * Два вида. На «Моїх тестах» — панелью с решениями по каждой сдаче
 * (pt-outbox «Виразної»): ждущие — строкой «піде сама», отвергнутые
 * сервером — с причиной и двумя решениями человека: повторить или
 * отказаться (с подтверждением, #172). На остальных экранах — строкой на
 * полосе под шапкой: ответы не пропали, а ждут, и где ими распорядиться.
 *
 * Без состояния очереди и без хранилища — чтобы рисовалось в проверке
 * (test/outboxRetry.test.tsx); подтверждение отказа — своё, внутри панели.
 */

export interface OutboxView {
  waiting: OutboxItem[];
  rejected: OutboxItem[];
  busy: boolean;
  flush: () => void;
  retry: (id: string) => void;
  discard: (id: string) => void;
}

/** Строка на полосе: сколько ждёт и сколько не принято, переход к решениям и «Відправити зараз» */
export function OutboxStrip({ outbox }: { outbox: OutboxView }) {
  const { ut } = useLang();
  const waiting = outbox.waiting.length;
  const rejected = outbox.rejected.length;
  if (!waiting && !rejected) return null;
  return (
    <div className="bg-band">
      <div className={`${COLUMN} pb-1`}>
        <Callout
          kind="warn"
          role="status"
          icon={<ShellIcon name="clipboard-list" size={16} />}
          className="items-center text-[15px] leading-[22px] max-[600px]:flex-wrap"
        >
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex flex-wrap gap-x-3">
              {waiting ? (
                <b className="font-extrabold text-warn">
                  {ut("pt.outboxWaiting")}: <span className="tabular-nums">{waiting}</span>
                </b>
              ) : null}
              {rejected ? (
                <b className="font-extrabold text-warn">
                  {ut("pt.outboxRejected")}: <span className="tabular-nums">{rejected}</span>
                </b>
              ) : null}
              <span>{ut("ptw.outboxSafe")}</span>
            </span>
            <span className="ml-auto flex flex-wrap gap-2">
              {waiting ? (
                <Button variant="paper" disabled={outbox.busy} onClick={outbox.flush}>
                  {ut("pt.outboxSend")}
                </Button>
              ) : null}
              <ButtonLink variant="paper" to="/me/tests">
                {ut("ptw.outboxDecide")}
              </ButtonLink>
            </span>
          </span>
        </Callout>
      </div>
    </div>
  );
}

/** Панель очереди на «Моїх тестах»: каждая сдача строкой, у отвергнутой — причина и решения */
export function OutboxPanel({ outbox }: { outbox: OutboxView }) {
  const { ut } = useLang();
  const [asking, setAsking] = useState<OutboxItem | null>(null);
  const total = outbox.waiting.length + outbox.rejected.length;
  if (!total) return null;
  const name = (item: OutboxItem) => item.title ?? ut("pt.outboxItem");

  return (
    <>
      <PtPanel
        title={ut("pt.outboxWaiting")}
        icon={<Ic.inbox size={16} />}
        tone="warn"
        count={total}
        flush
        actions={
          outbox.waiting.length ? (
            <Button variant="primary" icon={<Glyph name="send" size={16} />} disabled={outbox.busy} onClick={outbox.flush}>
              {ut("pt.outboxSend")}
            </Button>
          ) : null
        }
      >
        <ul className="m-0 list-none p-0">
          {outbox.waiting.map((item) => (
            <li
              key={item.id}
              className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-x-4 border-t border-divider px-[18px] py-4 max-[600px]:grid-cols-[48px_minmax(0,1fr)]"
            >
              <CodeTile title={name(item)} tone="neutral" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[17px] font-extrabold leading-6">
                  {name(item)}
                  <Tag tone="attention" icon={<Glyph name="clock" size={12} />}>
                    {ut("ptw.outboxWaitingTag")}
                  </Tag>
                </div>
                <MetaLine
                  items={[
                    { key: "at", icon: <Ic.check size={15} />, text: `${ut("ptw.finished")} ${whenSaid(item.queuedAt, ut)}` },
                    { key: "dev", icon: <Glyph name="hard-drive" size={15} />, text: ut("ptw.onDeviceOnly") },
                  ]}
                />
              </div>
              <p className="m-0 w-[180px] text-right text-[14px] leading-5 text-text-2 max-[600px]:col-span-2 max-[600px]:mt-2 max-[600px]:w-auto max-[600px]:text-left">
                {ut("ptw.outboxAuto")}
              </p>
            </li>
          ))}
          {outbox.rejected.map((item) => (
            <li
              key={item.id}
              className="grid grid-cols-[48px_minmax(0,1fr)] items-start gap-x-4 border-t border-divider px-[18px] py-4"
            >
              <CodeTile title={name(item)} tone="neutral" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[17px] font-extrabold leading-6">
                  {name(item)}
                  <Tag tone="attention" icon={<Ic.circleX size={12} />}>
                    {ut("ptw.outboxRejectedTag")}
                  </Tag>
                </div>
                <MetaLine
                  items={[
                    { key: "at", icon: <Ic.check size={15} />, text: `${ut("ptw.finished")} ${whenSaid(item.queuedAt, ut)}` },
                    { key: "dev", icon: <Glyph name="hard-drive" size={15} />, text: ut("ptw.onDeviceOnly") },
                  ]}
                />
                {item.rejectedReason ? (
                  <p className="m-0 mt-3 rounded-[12px] bg-sunk px-3.5 py-2.5 text-[15px] leading-[22px] text-text-2">
                    <b className="font-extrabold text-text">{ut("pt.outboxRejected")}:</b> {item.rejectedReason}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {/* повтор — главное решение, отказ — с подтверждением: стирает ответы безвозвратно */}
                  <Button icon={<Ic.refresh size={16} />} disabled={outbox.busy} onClick={() => outbox.retry(item.id)}>
                    {ut("mq.retry")}
                  </Button>
                  <Button variant="danger" icon={<Glyph name="trash" size={16} />} disabled={outbox.busy} onClick={() => setAsking(item)}>
                    {ut("pt.outboxDiscard")}
                  </Button>
                </div>
                <p className="m-0 mt-2 text-[14px] leading-5 text-text-2">{ut("pt.outboxRejectedHint")}</p>
              </div>
            </li>
          ))}
        </ul>
      </PtPanel>
      {asking ? (
        <Modal
          title={ut("ptw.discardTitle")}
          sub={ut("ptw.discardSub")}
          icon={<Glyph name="trash" size={18} />}
          tone="warn"
          onClose={() => setAsking(null)}
          footer={
            <>
              <Button
                variant="danger"
                icon={<Glyph name="trash" size={16} />}
                onClick={() => {
                  outbox.discard(asking.id);
                  setAsking(null);
                }}
              >
                {ut("ptw.discardYes")}
              </Button>
              <Button variant="quiet" onClick={() => setAsking(null)}>
                {ut("ptw.discardKeep")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-[16px] leading-6 text-text">
            <b className="font-extrabold">{name(asking)}</b>, {ut("ptw.finished")} {whenSaid(asking.queuedAt, ut)}.
          </p>
          <p className="m-0 mt-2 text-[16px] leading-6 text-text-2">{ut("ptw.discardText")}</p>
        </Modal>
      ) : null}
    </>
  );
}
