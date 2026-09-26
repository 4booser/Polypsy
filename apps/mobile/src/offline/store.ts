import { Platform } from "react-native";
import { listRecords, readRecord, removeRecord, writeRecord, type RawFiles } from "./atomicFile";
import { StoreWriteError } from "./writeError";

/**
 * JSON-хранилище офлайн-слоя.
 *
 * На устройстве — файлы в документной директории (переживают перезапуск и
 * не выбрасываются системой, в отличие от кэша). В web-сборке — localStorage.
 * SecureStore сюда не годится: у него лимит на размер записи, а методика
 * МЛО-200 с контентом — сотни килобайт.
 */

interface JsonStore {
  read<T>(name: string): T | null;
  /**
   * Бросает StoreWriteError, если запись не легла. Глотать отказ здесь
   * нельзя: хранилище не знает, кэш ему дали или единственную копию ответов,
   * — решает вызывающий (см. writeError.ts).
   */
  write(name: string, value: unknown): void;
  remove(name: string): void;
  /** Имена записей с данным префиксом */
  keys(prefix: string): string[];
}

const PREFIX = "quizzy-offline";

function webStore(): JsonStore {
  return {
    read<T>(name: string): T | null {
      try {
        const raw = localStorage.getItem(`${PREFIX}:${name}`);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
      }
    },
    write(name, value) {
      try {
        localStorage.setItem(`${PREFIX}:${name}`, JSON.stringify(value));
      } catch (error) {
        /*
         * Квота. Раньше здесь офлайн-слой «деградировал молча» — и молча же
         * терял сдачу, которую очередь считала сохранённой.
         */
        throw new StoreWriteError(name, error);
      }
    },
    remove(name) {
      localStorage.removeItem(`${PREFIX}:${name}`);
    },
    keys(prefix) {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(`${PREFIX}:${prefix}`)) out.push(k.slice(PREFIX.length + 1));
      }
      return out;
    },
  };
}

function nativeStore(): JsonStore {
  // импорт внутри: web-бандл не должен тащить нативный модуль

  const { File, Directory, Paths } = require("expo-file-system") as typeof import("expo-file-system");

  const dir = new Directory(Paths.document, PREFIX);
  try {
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    /* создана параллельно — не страшно */
  }

  // имя записи может содержать ':' и id — в файловое имя кодируем безопасно
  const fileName = (name: string) => `${encodeURIComponent(name)}.json`;

  /*
   * Файлы каталога — в виде, в каком их понимает модель замещения
   * (atomicFile.ts): она решает порядок шагов и что поднимать после сбоя.
   */
  const files: RawFiles = {
    exists: (n) => new File(dir, n).exists,
    read: (n) => new File(dir, n).textSync(),
    write: (n, text) => {
      const f = new File(dir, n);
      if (f.exists) f.delete();
      f.create();
      f.write(text);
    },
    remove: (n) => new File(dir, n).delete(),
    rename: (from, to) => new File(dir, from).move(new File(dir, to)),
    list: () =>
      dir
        .list()
        .filter((e): e is InstanceType<typeof File> => e instanceof File)
        .map((f) => f.name),
  };

  return {
    read<T>(name: string): T | null {
      try {
        const text = readRecord(files, fileName(name));
        return text === null ? null : (JSON.parse(text) as T);
      } catch {
        return null;
      }
    },
    write(name, value) {
      /*
       * Через временный файл, и так, чтобы сбой между любыми шагами не
       * оставлял хранилище без основной копии (atomicFile.ts). Прямая запись
       * поверх не годится: выключение посреди неё оставляет обрезанный JSON,
       * и черновик двухсот ответов превращается в ничто.
       */
      try {
        writeRecord(files, fileName(name), JSON.stringify(value));
      } catch (error) {
        console.warn("offline store: запись не удалась", name, error);
        // вызывающий обязан узнать: для него это не кэш, а, может быть, единственная копия ответов
        throw new StoreWriteError(name, error);
      }
    },
    remove(name) {
      try {
        removeRecord(files, fileName(name));
      } catch {
        /* не удалилась — останется целой (atomicFile.ts); повтор удалит */
      }
    },
    keys(prefix) {
      try {
        return listRecords(files)
          .map((n) => decodeURIComponent(n.replace(/\.json$/, "")))
          .filter((n) => n.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}

export const store: JsonStore =
  Platform.OS === "web" && typeof localStorage !== "undefined" ? webStore() : nativeStore();
