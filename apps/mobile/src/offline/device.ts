import { store } from "./store";

/**
 * Идентификатор устройства и стирание локальных данных.
 *
 * Планшет носят по отделению, и потерять его проще, чем ноутбук, а на нём
 * лежит кэш обхода: имена, баллы, планы безопасности. Отсюда команда стирания.
 *
 * Ограничение честное: стирание срабатывает, когда устройство в следующий раз
 * выйдет на связь. Устройство, которое больше не включат, так не очистить — от
 * этого защищает шифрование хранилища и блокировка экрана.
 */

const DEVICE_KEY = "device:id";

/**
 * Идентификатор живёт в том же хранилище, что и остальной офлайн-слой.
 *
 * Значит, стирание его тоже уносит — и это правильно: после стирания устройство
 * должно выглядеть новым, а не продолжать отзываться под прежним именем, по
 * которому кто-то мог бы отследить, что оно снова в сети.
 */
export function deviceId(): string {
  const saved = store.read<{ id: string }>(DEVICE_KEY);
  if (saved?.id) return saved.id;
  const id = crypto.randomUUID();
  store.write(DEVICE_KEY, { id });
  return id;
}

/**
 * Что именно стирается.
 *
 * Всё, что офлайн-слой сложил на устройство: кэш методик и списков, черновики,
 * очередь несданных прохождений, карты обхода, план безопасности.
 *
 * Очередь тоже. Это спорно и решено сознательно: в очереди лежат клинические
 * ответы, которых больше нигде нет, и стирание их теряет. Но команда стирания
 * отдаётся, когда устройство считают потерянным, — а потерянное устройство с
 * несданными ответами хуже, чем несданные ответы. Поэтому очередь чистится, а
 * решение о команде остаётся за человеком, который знает обстоятельства.
 */
export function wipeLocalData(): number {
  let removed = 0;
  for (const key of store.keys("")) {
    store.remove(key);
    removed++;
  }
  return removed;
}

/**
 * Платформа для учёта устройств; web-сборка тоже считается устройством.
 *
 * Импорт react-native внутри функции, а не наверху файла: иначе сам модуль
 * нельзя загрузить в тестовом процессе — react-native написан на Flow и не
 * разбирается. Стирание данных проверяется тестом, значит модуль обязан
 * грузиться без него.
 */
export function platformName(): string {
  const { Platform } = require("react-native") as typeof import("react-native");
  return Platform.OS;
}

/**
 * Версия приложения и номер сборки — для учёта устройств (техпанель).
 *
 * Версия — из app.json (expoConfig.version): её видит человек в магазине.
 * Номер сборки — из самого бинарника (iOS buildNumber, Android versionCode):
 * две сборки одной версии различаются только им, а исправление движка
 * подсчёта может приехать именно пересборкой. В Expo Go номера нет — null.
 *
 * Импорт внутри функции по той же причине, что у platformName: модуль
 * должен грузиться в тестовом процессе без react-native.
 */
export function appBuildInfo(): { appVersion: string | null; appBuild: string | null } {
  try {
    const Constants = (require("expo-constants") as typeof import("expo-constants")).default;
    const version = Constants.expoConfig?.version ?? null;
    const build =
      Constants.platform?.ios?.buildNumber ?? Constants.platform?.android?.versionCode ?? null;
    return {
      appVersion: version && /^[0-9][0-9A-Za-z.+-]*$/.test(version) ? version.slice(0, 32) : null,
      appBuild: build === null || build === undefined ? null : String(build).slice(0, 32),
    };
  } catch {
    return { appVersion: null, appBuild: null };
  }
}
