import { Platform } from "react-native";

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
      } catch {
        /* квота — офлайн-слой деградирует молча, сеть остаётся основным путём */
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

  return {
    read<T>(name: string): T | null {
      try {
        const f = new File(dir, fileName(name));
        if (!f.exists) return null;
        return JSON.parse(f.textSync()) as T;
      } catch {
        return null;
      }
    },
    write(name, value) {
      /*
       * Через временный файл с переименованием.
       *
       * Прямая запись поверх — не атомарная операция: если телефон выключится
       * посреди неё, на диске останется обрезанный JSON, и черновик двухсот
       * ответов превратится в ничто. Переименование в пределах одной
       * директории атомарно, поэтому наблюдатель видит либо старую запись,
       * либо новую целиком.
       */
      const tmp = new File(dir, `${fileName(name)}.tmp`);
      try {
        if (tmp.exists) tmp.delete();
        tmp.create();
        tmp.write(JSON.stringify(value));
        const target = new File(dir, fileName(name));
        if (target.exists) target.delete();
        tmp.move(target);
      } catch (error) {
        try {
          if (tmp.exists) tmp.delete();
        } catch {
          /* мусорный временный файл переживём */
        }
        console.warn("offline store: запись не удалась", name, error);
      }
    },
    remove(name) {
      try {
        const f = new File(dir, fileName(name));
        if (f.exists) f.delete();
      } catch {
        /* уже нет */
      }
    },
    keys(prefix) {
      try {
        return dir
          .list()
          .filter((e): e is InstanceType<typeof File> => e instanceof File)
          .filter((f) => !f.name.endsWith(".tmp"))
          .map((f) => decodeURIComponent(f.name.replace(/\.json$/, "")))
          .filter((n) => n.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}

export const store: JsonStore =
  Platform.OS === "web" && typeof localStorage !== "undefined" ? webStore() : nativeStore();
