import { isTransientStatus, uiText } from "@quizzy/shared";
import { currentLang } from "../currentLang";
import { isPasswordGate } from "../auth/passwordGate";
import { isOwnerChanged } from "./owner";
import { store } from "./store";
import { StoreWriteError } from "./writeError";

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
 *
 * У каждой записи есть владелец — тот, чьим токеном её положено отправить
 * (owner.ts). Прогон берёт только записи владельца текущего токена; чужие
 * лежат и ждут, пока их хозяин войдёт на этом устройстве снова. Раньше
 * владельца не было, и после смены учётной записи ответы пациента А уходили
 * на сервер от имени пациента Б.
 *
 * Почему «ждут», а не «стираются при выходе». Стереть — значит молча
 * потерять ответы, которых больше нигде нет: человек вышел в подвале без
 * сети, не зная, что сдача ещё не ушла. Отправить под следующим вошедшим —
 * хуже потери: чужие ответы в чужой карте. Остаётся хранить до входа
 * владельца. Цена решения честная: если он на этом устройстве больше не
 * войдёт, записи так и пролежат до стирания устройства (device.ts) — и
 * поэтому при выходе человеку говорят, сколько его ответов остаётся здесь
 * (profile.tsx, logoutNotice).
 */

export interface QueuedSubmission {
  id: string;
  /**
   * Чей токен вправе отправить запись. У записей, положенных до появления
   * владельца, поля нет: чьи они — неизвестно, и сами они не уходят
   * никогда (см. ownerless, claim).
   */
  ownerId?: string;
  surveyId: string;
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  /** Отказ сервера (4xx): в вечный ретрай не уходит, ждёт разбора */
  rejectedReason?: string;
}

const key = (id: string) => `queue:${id}`;

export function enqueue(ownerId: string, surveyId: string, payload: Record<string, unknown>): QueuedSubmission {
  const item: QueuedSubmission = {
    id: crypto.randomUUID(),
    ownerId,
    surveyId,
    /*
     * Идентификатор первой попытки сохраняется, если он был. Сдача, упавшая
     * на 502/504, могла успеть закоммититься: прокси не дождался ответа, а
     * приложение своё сделало. Повтор с новым id завёл бы второе
     * прохождение; с тем же — сервер узнает дубль.
     */
    payload: { ...payload, clientRequestId: payload.clientRequestId ?? crypto.randomUUID() },
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  /*
   * Запись подтверждается чтением, а не только отсутствием исключения.
   *
   * Отсюда экран узнаёт, что можно стереть черновик и сказать «збережено».
   * Раньше enqueue возвращал запись безусловно — и хранилище, проглотившее
   * отказ квоты, превращало «сохранено в очередь» в потерю всех ответов.
   * Исключение хранилища летит дальше как есть; запись, которая «легла»,
   * но не читается, — тот же отказ.
   */
  store.write(key(item.id), item);
  const back = store.read<QueuedSubmission>(key(item.id));
  if (!back || back.id !== item.id) throw new StoreWriteError(key(item.id));
  return item;
}

/** Всё, что лежит в очереди на устройстве, — в порядке сдачи, без разбора владельцев */
function everything(): QueuedSubmission[] {
  return store
    .keys("queue:")
    .map((k) => store.read<QueuedSubmission>(k))
    .filter((x): x is QueuedSubmission => !!x)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/**
 * Записи владельца. Без владельца (никто не вошёл) — ничего: показать или
 * отправить «ничьё» некому.
 */
export function pending(owner: string | null): QueuedSubmission[] {
  if (!owner) return [];
  return everything().filter((x) => x.ownerId === owner);
}

export function pendingCount(owner: string | null): number {
  return pending(owner).filter((x) => !x.rejectedReason).length;
}

export function rejectedItems(owner: string | null): QueuedSubmission[] {
  return pending(owner).filter((x) => !!x.rejectedReason);
}

/**
 * Записи без владельца — положенные до того, как он появился.
 *
 * Отдать их текущему вошедшему молча нельзя: ровно так и уходили чужие
 * ответы. Стереть — тоже: чаще всего это ответы того самого человека,
 * который сейчас держит телефон. Решает человек — экран очереди показывает
 * их отдельно, с названием методики и временем, и кнопкой «це мої» (claim).
 */
export function ownerless(): QueuedSubmission[] {
  return everything().filter((x) => !x.ownerId);
}

/**
 * Счёт очереди устройства целиком, для отметки устройства (техпанель).
 * Только числа и по всем владельцам: вопрос техпанели — «сколько сдач
 * застряло на этом телефоне», а не «чьих».
 */
export function deviceCounts(): { pending: number; rejected: number } {
  const all = everything();
  return {
    pending: all.filter((x) => !x.rejectedReason).length,
    rejected: all.filter((x) => !!x.rejectedReason).length,
  };
}

export interface FlushResult {
  sent: number;
  left: number;
  rejected: number;
}

let flushing = false;

/**
 * Прогон очереди владельца. submit — функция реальной отправки; временные
 * отказы останавливают прогон, отказы по существу помечают запись и
 * пропускаются: битую сдачу нельзя ни потерять молча, ни ретраить вечно.
 *
 * Временный — не только «сети нет» (status 0), но и 502/503/504
 * (isTransientStatus). Режим обслуживания отвечает 503 на всякую запись, и
 * до него очередь помечала бы каждую сдачу «отклонённой сервером»: она
 * ждала бы разбора человеком, а не конца работ.
 *
 * Чужие записи прогон не видит вовсе. Смена токена посреди прогона
 * (OwnerChanged из клиента) — тоже остановка, а не отказ: запись цела и
 * дождётся своего владельца.
 */
export async function flush(
  owner: string | null,
  submit: (item: QueuedSubmission) => Promise<void>,
): Promise<FlushResult> {
  if (!owner || flushing) {
    return { sent: 0, left: pendingCount(owner), rejected: rejectedItems(owner).length };
  }
  flushing = true;
  let sent = 0;
  try {
    for (const item of pending(owner)) {
      if (item.rejectedReason) continue;
      try {
        await submit(item);
        store.remove(key(item.id));
        sent++;
      } catch (error) {
        if (isOwnerChanged(error)) break; // токен уже чужой — ни эта, ни следующие от его имени не уйдут
        /*
         * «Сначала смените пароль» — не отказ по существу: сдача цела и уйдёт,
         * как только пароль будет сменён. Пометить её отвергнутой значило бы
         * отправить человека разбирать очередь из-за временного пароля.
         */
        if (isPasswordGate(error)) break;
        const status = (error as { status?: number }).status ?? 0;
        if (isTransientStatus(status)) break; // сети нет или идут работы — остальные тоже не уйдут
        // сервер отказал по существу: фиксируем причину, не блокируем остальных
        try {
          store.write(key(item.id), {
            ...item,
            attempts: item.attempts + 1,
            rejectedReason: error instanceof Error ? error.message : `${uiText("net.failed", currentLang)} ${status}`,
          });
        } catch {
          /*
           * Пометку записать не удалось — запись остаётся неотмеченной и
           * будет предложена серверу снова. Лишняя попытка лучше, чем
           * потерянная сдача.
           */
        }
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, left: pendingCount(owner), rejected: rejectedItems(owner).length };
}

/** Своя запись по id; чужая или безхозная — как будто её нет */
function own(owner: string | null, id: string): QueuedSubmission | null {
  const item = store.read<QueuedSubmission>(key(id));
  return owner && item?.ownerId === owner ? item : null;
}

/** Отправить отклонённую запись заново (после разбора) */
export function retryRejected(owner: string | null, id: string): void {
  const item = own(owner, id);
  if (!item) return;
  const { rejectedReason: _dropped, ...rest } = item;
  store.write(key(id), rest);
}

/**
 * «Це мої відповіді»: запись без владельца переходит к тому, кто её
 * опознал, и уходит обычным порядком. Решение — человека, а не кода; у
 * записи уже с владельцем сменить его так нельзя.
 */
export function claim(owner: string | null, id: string): void {
  if (!owner) return;
  const item = store.read<QueuedSubmission>(key(id));
  if (!item || item.ownerId) return;
  const { rejectedReason: _dropped, ...rest } = item;
  store.write(key(id), { ...rest, ownerId: owner });
}

export function discard(owner: string | null, id: string): void {
  if (own(owner, id)) store.remove(key(id));
}
