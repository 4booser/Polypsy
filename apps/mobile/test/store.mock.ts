import { mock } from "bun:test";

/**
 * Хранилище офлайн-слоя в памяти.
 *
 * Настоящее (`src/offline/store.ts`) выбирает между файлами устройства и
 * localStorage по `Platform.OS` и тянет react-native — в тестовом процессе его
 * не импортировать. Подменяем модуль целиком: проверяется логика очереди,
 * а не то, как байты ложатся на диск.
 */
const data = new Map<string, string>();

export const memoryStore = {
  read<T>(name: string): T | null {
    const raw = data.get(name);
    return raw ? (JSON.parse(raw) as T) : null;
  },
  write(name: string, value: unknown): void {
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
}

mock.module("../src/offline/store", () => ({ store: memoryStore }));
mock.module("./store", () => ({ store: memoryStore }));
