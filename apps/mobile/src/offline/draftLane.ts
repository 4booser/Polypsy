/**
 * Сохранения черновика на сервер — по одному и по порядку правок.
 *
 * Автосохранение срабатывает на каждом переходе между вопросами, и запросы
 * шли параллельно. Медленная сеть отвечает не по порядку: правка 5 доходит
 * до сервера позже правки 6 — серверный черновик откатывается к пятой, а
 * запоздалый ответ ещё и помечал на устройстве старую копию
 * синхронизированной поверх свежей. После перезапуска последние ответы
 * пропадали с обеих сторон.
 *
 * Дорожка на черновик (владелец + методика): одновременно в пути не больше
 * одного сохранения; пока оно идёт, ждёт только самое свежее, промежуточные
 * отбрасываются («superseded») — сервер получает правки строго по
 * возрастанию номера, и старая никогда не приходит после новой. Правка не
 * новее уже подтверждённой или уже стоящей в очереди не отправляется вовсе.
 * Ту же дорожку проходит и досылка черновиков из прогона очереди
 * (api.flushQueue), так что экран и фоновый прогон не обгоняют друг друга.
 *
 * Отказ сети правку не «съедает»: номер не считается подтверждённым, и та
 * же правка может уйти следующей попыткой.
 *
 * Без react-native — проверяется тестом.
 */

export type LaneResult<T> = { status: "sent"; value: T } | { status: "superseded" };

interface Job {
  revision: number;
  run: () => Promise<unknown>;
  resolve: (result: LaneResult<unknown>) => void;
  reject: (error: unknown) => void;
}

interface Lane {
  confirmed: number;
  inFlight: number | null;
  next: Job | null;
}

export function createLanes() {
  const lanes = new Map<string, Lane>();

  function start(lane: Lane, job: Job): void {
    lane.inFlight = job.revision;
    void job
      .run()
      .then(
        (value) => {
          lane.confirmed = Math.max(lane.confirmed, job.revision);
          job.resolve({ status: "sent", value });
        },
        (error) => job.reject(error),
      )
      .finally(() => {
        lane.inFlight = null;
        const next = lane.next;
        lane.next = null;
        if (next) start(lane, next);
      });
  }

  return {
    submit<T>(key: string, revision: number, run: () => Promise<T>): Promise<LaneResult<T>> {
      const lane: Lane = lanes.get(key) ?? { confirmed: -1, inFlight: null, next: null };
      lanes.set(key, lane);
      const floor = Math.max(lane.confirmed, lane.inFlight ?? -1, lane.next?.revision ?? -1);
      if (revision <= floor) return Promise.resolve({ status: "superseded" });

      return new Promise<LaneResult<T>>((resolve, reject) => {
        const job: Job = { revision, run, resolve: resolve as Job["resolve"], reject };
        if (lane.inFlight !== null) {
          // ждущая, но уже не самая свежая, — не уйдёт: её правки есть в новой
          lane.next?.resolve({ status: "superseded" });
          lane.next = job;
          return;
        }
        start(lane, job);
      });
    },

    /**
     * Прохождение сдано — ждущее сохранение черновика больше не нужно и
     * вредно: дойдя до сервера после сдачи, оно завело бы там «незавершённое
     * прохождение» уже сданной методики. То, что уже в пути, не отменить —
     * но хотя бы очередь за ним пуста.
     */
    cancelPending(key: string): void {
      const lane = lanes.get(key);
      if (!lane?.next) return;
      lane.next.resolve({ status: "superseded" });
      lane.next = null;
    },
  };
}

/** Одна на приложение: и экран прохождения, и прогон очереди идут через неё */
export const draftLanes = createLanes();

export const draftLaneKey = (owner: string, surveyId: string) => `${owner}:${surveyId}`;
