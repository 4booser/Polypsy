import { dateTime } from "../format";
import { useLang } from "../lang";
import { Button } from "../ui/primitives";
import type { OutboxItem } from "./outbox";

/**
 * Полоса отложенных сдач в оболочке кабинета (PatientApp).
 *
 * Ждущие — числом и кнопкой «Відправити зараз», как и было. Отвергнутые
 * сервером раньше были только числом (#172): запись лежала в браузере, а
 * повторить её или отказаться от неё было нечем — у мобилки для этого свой
 * экран очереди, у кабинета не было ничего. Теперь каждая отвергнутая —
 * строкой: какая методика, когда, почему не принята, и два решения
 * человека: повторить или отказаться (с подтверждением — его спрашивает
 * оболочка).
 *
 * Без состояния и без хранилища — чтобы рисовалась в проверке
 * (test/outboxRetry.test.tsx).
 */
export function OutboxStrip({
  waiting,
  rejected,
  busy,
  onSend,
  onRetry,
  onDiscard,
}: {
  waiting: number;
  rejected: OutboxItem[];
  busy: boolean;
  onSend: () => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const { ut } = useLang();
  if (!waiting && !rejected.length) return null;
  return (
    /*
      Отложенные сдачи видны, пока не ушли: человек, закрывший методику во
      время работ, должен знать, что ответы не пропали, а ждут.
    */
    <div className="border-b border-hairline px-4 py-2 text-small">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {waiting ? (
          <span className="text-text">
            {ut("pt.outboxWaiting")}: <span className="font-mono tabular-nums">{waiting}</span>
          </span>
        ) : null}
        {rejected.length ? (
          <span className="text-danger">
            {ut("pt.outboxRejected")}: <span className="font-mono tabular-nums">{rejected.length}</span>
          </span>
        ) : null}
        {waiting ? (
          <Button variant="quiet" className="ml-auto" disabled={busy} onClick={onSend}>
            {ut("pt.outboxSend")}
          </Button>
        ) : null}
      </div>
      {rejected.length ? (
        <>
          <p className="m-0 mt-1 text-muted">{ut("pt.outboxRejectedHint")}</p>
          <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
            {rejected.map((item) => (
              <li key={item.id} className="rounded-[10px] border border-hairline bg-surface-2 p-3">
                <p className="m-0 text-text">
                  {item.title ?? ut("pt.outboxItem")} · <span className="tabular-nums">{dateTime(item.queuedAt)}</span>
                </p>
                {item.rejectedReason ? <p className="m-0 mt-0.5 text-muted">{item.rejectedReason}</p> : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="quiet" disabled={busy} onClick={() => onRetry(item.id)}>
                    {ut("mq.retry")}
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => onDiscard(item.id)}>
                    {ut("pt.outboxDiscard")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
