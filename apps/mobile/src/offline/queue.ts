import { store } from "./store";

/**
 * Очередь несданных прохождений.
 *
 * Ответы — клинические данные, потеря недопустима: сдача без сети пишется
 * сюда и уходит при первой возможности. Порядок сохраняется (батареи со
 * строгим порядком!): очередь шлётся последовательно, и сетевая ошибка
 * останавливает проход — следующая попытка начнёт с того же места.
 *
 * Каждая запись несёт clientRequestId: сервер по нему отбрасывает дубль,
 * если прошлая попытка закоммитилась, а ответ до клиента не дошёл.
 */

export interface QueuedSubmission {
  id: string;
  surveyId: string;
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  /** Отказ сервера (4xx): в вечный ретрай не уходит, ждёт разбора */
  rejectedReason?: string;
}

const key = (id: string) => `queue:${id}`;

export function enqueue(surveyId: string, payload: Record<string, unknown>): QueuedSubmission {
  const item: QueuedSubmission = {
    id: crypto.randomUUID(),
    surveyId,
    payload: { ...payload, clientRequestId: crypto.randomUUID() },
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  store.write(key(item.id), item);
  return item;
}

export function pending(): QueuedSubmission[] {
  return store
    .keys("queue:")
    .map((k) => store.read<QueuedSubmission>(k))
    .filter((x): x is QueuedSubmission => !!x)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export function pendingCount(): number {
  return pending().filter((x) => !x.rejectedReason).length;
}

export function rejectedItems(): QueuedSubmission[] {
  return pending().filter((x) => !!x.rejectedReason);
}

export interface FlushResult {
  sent: number;
  left: number;
  rejected: number;
}

let flushing = false;

/**
 * Прогон очереди. submit — функция реальной отправки; сетевые ошибки
 * (status 0) останавливают прогон, серверные отказы помечают запись и
 * пропускаются: битую сдачу нельзя ни потерять молча, ни ретраить вечно.
 */
export async function flush(
  submit: (item: QueuedSubmission) => Promise<void>,
): Promise<FlushResult> {
  if (flushing) return { sent: 0, left: pendingCount(), rejected: rejectedItems().length };
  flushing = true;
  let sent = 0;
  try {
    for (const item of pending()) {
      if (item.rejectedReason) continue;
      try {
        await submit(item);
        store.remove(key(item.id));
        sent++;
      } catch (error) {
        const status = (error as { status?: number }).status ?? 0;
        if (status === 0) break; // сети нет — остальные тоже не уйдут
        // сервер отказал по существу: фиксируем причину, не блокируем остальных
        store.write(key(item.id), {
          ...item,
          attempts: item.attempts + 1,
          rejectedReason: error instanceof Error ? error.message : `Ошибка ${status}`,
        });
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, left: pendingCount(), rejected: rejectedItems().length };
}

/** Отправить отклонённую запись заново (после разбора) или удалить её */
export function retryRejected(id: string): void {
  const item = store.read<QueuedSubmission>(key(id));
  if (!item) return;
  const { rejectedReason: _dropped, ...rest } = item;
  store.write(key(id), rest);
}

export function discard(id: string): void {
  store.remove(key(id));
}
