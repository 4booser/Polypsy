import { mock } from "bun:test";
import { StoreWriteError } from "../src/offline/writeError";

/**
 * Хранилище офлайн-слоя в памяти.
 *
 * Настоящее (`src/offline/store.ts`) выбирает между файлами устройства и
 * localStorage по `Platform.OS` и тянет react-native — в тестовом процессе его
 * не импортировать. Подменяем модуль целиком: проверяется логика очереди,
 * а не то, как байты ложатся на диск.
 */
const data = new Map<string, string>();

/*
 * Отказ записи по заказу теста: кончилось место, файловая система отказала.
 * Настоящее хранилище в таком случае бросает StoreWriteError (store.ts) — и
 * память ведёт себя так же, иначе проверять «запись упала, черновик цел»
 * было бы не на чем.
 */
export const storeFaults: {
  failWrite: ((name: string) => boolean) | null;
  /*
   * Запись «прошла», а на диске ничего: ровно так вело себя прежнее
   * хранилище при отказе квоты — глотало исключение и возвращалось как ни в
   * чём не бывало. Очередь обязана поймать и это (enqueue читает запись назад).
   */
  swallowWrite: ((name: string) => boolean) | null;
} = { failWrite: null, swallowWrite: null };

export const memoryStore = {
  read<T>(name: string): T | null {
    const raw = data.get(name);
    return raw ? (JSON.parse(raw) as T) : null;
  },
  write(name: string, value: unknown): void {
    if (storeFaults.failWrite?.(name)) throw new StoreWriteError(name);
    if (storeFaults.swallowWrite?.(name)) return;
    // через JSON, как настоящее хранилище: ссылка на объект не должна
    // «протекать» в тест и маскировать отсутствие записи
    data.set(name, JSON.stringify(value));
  },
  remove(name: string): void {
    data.delete(name);
  },
  keys(prefix: string): string[] {
    return [...data.keys()].filter((k) => k.startsWith(prefix));
  },
};

export function resetStore(): void {
  data.clear();
  storeFaults.failWrite = null;
  storeFaults.swallowWrite = null;
}

mock.module("../src/offline/store", () => ({ store: memoryStore }));
mock.module("./store", () => ({ store: memoryStore }));
