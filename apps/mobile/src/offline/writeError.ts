/**
 * Запись на устройство не удалась.
 *
 * Хранилище офлайн-слоя глотало такие ошибки: кончилась квота localStorage,
 * переполнен диск, файловая система отказала — а `write` возвращался как ни в
 * чём не бывало. Для кэша это терпимо, для очереди несданных прохождений —
 * нет: enqueue считал запись сделанной, экран показывал «збережено, відправимо
 * пізніше» и стирал черновик, и ответы исчезали насовсем после слов о том,
 * что они сохранены.
 *
 * Теперь отказ записи — исключение. Кто пишет данные, которых больше нигде
 * нет (очередь, черновик), обязан его увидеть; кто пишет кэш, глотает его сам
 * и осознанно (cache.ts).
 *
 * Отдельным модулем, а не в store.ts: store.ts тянет react-native и в тестах
 * подменяется целиком, а класс ошибки должен быть одним и тем же и там, и там.
 */
export class StoreWriteError extends Error {
  constructor(
    readonly record: string,
    readonly cause?: unknown,
  ) {
    super(`offline store write failed: ${record}`);
    this.name = "StoreWriteError";
  }
}

export function isStoreWriteError(error: unknown): boolean {
  return error instanceof StoreWriteError || (error as { name?: string } | null)?.name === "StoreWriteError";
}
