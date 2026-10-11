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
 * Номера правок — внутри одной попытки (#129). Экран считает их с нуля, а
 * дорожка жила до перезапуска и помнила подтверждённое прошлым
 * прохождением: второе прохождение той же методики в том же запуске
 * отбрасывалось целиком как «устаревшее», и до сервера не доходило ни одной
 * правки. Поэтому конец попытки — сдача, стирание черновика, выход,
 * стирание устройства — сбрасывает дорожку (reset).
 *
 * Без react-native — проверяется тестом.
 */

export type LaneResult<T> = { status: "sent"; value: T } | { status: "superseded" };

interface Job {
  revision: number;
  /** Попытка, к которой относится правка (Lane.attempt) */
  attempt: number;
  run: () => Promise<unknown>;
  resolve: (result: LaneResult<unknown>) => void;
  reject: (error: unknown) => void;
}

interface Lane {
  confirmed: number;
  inFlight: Job | null;
  next: Job | null;
  /** Номер текущей попытки: растёт с каждым reset */
  attempt: number;
}

export function createLanes() {
  const lanes = new Map<string, Lane>();

  function start(lane: Lane, job: Job): void {
    lane.inFlight = job;
    void job
      .run()
      .then(
        (value) => {
          // подтверждение прошлой попытки нынешней не указ: у неё свой счёт
          if (job.attempt === lane.attempt) lane.confirmed = Math.max(lane.confirmed, job.revision);
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

  function reset(lane: Lane): void {
    lane.next?.resolve({ status: "superseded" });
    lane.next = null;
    lane.confirmed = -1;
    lane.attempt++;
  }

  return {
    submit<T>(key: string, revision: number, run: () => Promise<T>): Promise<LaneResult<T>> {
      const lane: Lane = lanes.get(key) ?? { confirmed: -1, inFlight: null, next: null, attempt: 0 };
      lanes.set(key, lane);
      const inFlight = lane.inFlight?.attempt === lane.attempt ? lane.inFlight.revision : -1;
      const floor = Math.max(lane.confirmed, inFlight, lane.next?.revision ?? -1);
      if (revision <= floor) return Promise.resolve({ status: "superseded" });

      return new Promise<LaneResult<T>>((resolve, reject) => {
        const job: Job = { revision, attempt: lane.attempt, run, resolve: resolve as Job["resolve"], reject };
        /*
         * В пути запрос — ждём его, даже если он прошлой попытки: иначе он мог
         * бы дойти до сервера позже первой правки новой и затереть её.
         */
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
     * Попытка кончилась: прохождение сдано, черновик стёрт (#129).
     *
     * Ждущее сохранение больше не нужно и вредно: дойдя до сервера после
     * сдачи, оно завело бы там «незавершённое прохождение» уже сданной
     * методики. То, что уже в пути, не отменить — но следующая попытка
     * уйдёт только после него, и её номера считаются заново: первая правка
     * второго прохождения — не «устаревшая».
     */
    reset(key: string): void {
      const lane = lanes.get(key);
      if (lane) reset(lane);
    },

    /** Сбросить все дорожки с этим началом ключа: выход владельца, стирание устройства */
    resetAll(prefix = ""): void {
      for (const [key, lane] of lanes) if (key.startsWith(prefix)) reset(lane);
    },
  };
}

/** Одна на приложение: и экран прохождения, и прогон очереди идут через неё */
export const draftLanes = createLanes();

export const draftLaneKey = (owner: string, surveyId: string) => `${owner}:${surveyId}`;

/** Начало ключей всех дорожек владельца (resetAll) */
export const ownerLanePrefix = (owner: string) => `${owner}:`;
