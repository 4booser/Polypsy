/**
 * Замещение записи файлом — так, чтобы сбой между шагами не оставлял хранилище
 * без основной копии.
 *
 * Прежняя запись шла так: временный файл → удалить основной → переместить
 * временный на его место. Переименование атомарно, но удаление было отдельным
 * шагом: выключись телефон между ним и перемещением — основной копии нет, а
 * временный при чтении никто не искал. Для очереди несданных прохождений это
 * значило потерять сдачу, для черновика — двести ответов. Ещё хуже вёл себя
 * отказ на последнем шаге: обработчик ошибки стирал временный файл — то есть
 * единственное, что оставалось.
 *
 * Атомарной замены поверх существующего файла платформа не даёт: у
 * expo-file-system `move({ overwrite: true })` внутри делает то же «удалить,
 * потом переместить» (FileSystemPath.swift, DestinationSink.kt). Поэтому
 * целостность восстанавливается при чтении — по состоянию, которое каждый
 * шаг оставляет на диске:
 *
 *   основной есть, временного нет — обычное состояние;
 *   основной есть, временный есть — запись оборвалась ДО удаления основного:
 *     она не завершилась и об успехе не сообщала; основной — последняя
 *     подтверждённая копия, временный стирается. Если основной не
 *     разбирается (обрезан), а временный цел — поднимается временный;
 *   основного нет, временный есть — запись оборвалась МЕЖДУ удалением и
 *     перемещением: временный к этому моменту был дописан целиком, он и есть
 *     новая копия — поднимается на место основного;
 *   ничего нет — записи нет.
 *
 * «Цел» — значит разбирается как JSON: обрезанная запись не разбирается.
 *
 * Удаление идёт в обратном порядке — сначала временный, потом основной:
 * иначе сбой между шагами оставил бы бесхозный временный файл, и чтение
 * «восстановило» бы уже удалённую запись — отправленная сдача ушла бы на
 * сервер второй раз.
 *
 * Модель над абстрактными файлами, без expo-file-system: сбой между любыми
 * двумя шагами имитируется в тесте (test/atomicFile.test.ts).
 */

export interface RawFiles {
  exists(name: string): boolean;
  /** Бросает, если файл не читается */
  read(name: string): string;
  /** Создаёт или перезаписывает целиком */
  write(name: string, text: string): void;
  remove(name: string): void;
  /** В пределах одного каталога; назначение не существует */
  rename(from: string, to: string): void;
  list(): string[];
}

export const TMP_SUFFIX = ".tmp";

const tmpOf = (file: string) => `${file}${TMP_SUFFIX}`;

/** Текст файла, если файл есть и разбирается как JSON; иначе null */
function intact(fs: RawFiles, name: string): string | null {
  try {
    if (!fs.exists(name)) return null;
    const text = fs.read(name);
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

function quietRemove(fs: RawFiles, name: string): void {
  try {
    if (fs.exists(name)) fs.remove(name);
  } catch {
    /* не удалился — следующее чтение разберётся по тем же правилам */
  }
}

/**
 * Записать. Бросает, если запись не завершилась; при этом на диске остаётся
 * состояние, из которого readRecord поднимет либо прежнюю копию, либо новую
 * — но не пустоту.
 */
export function writeRecord(fs: RawFiles, file: string, text: string): void {
  const tmp = tmpOf(file);
  try {
    fs.write(tmp, text);
    if (fs.exists(file)) fs.remove(file);
    fs.rename(tmp, file);
  } catch (error) {
    /*
     * Временный стирается, только если основной на месте: тогда он —
     * недописанная попытка, а прежняя копия цела. Основного нет — временный
     * и есть запись, и стереть его значило бы стереть её.
     */
    if (fs.exists(file)) quietRemove(fs, tmp);
    throw error;
  }
}

/** Прочитать с восстановлением оборванной записи (правила — в шапке) */
export function readRecord(fs: RawFiles, file: string): string | null {
  const tmp = tmpOf(file);
  const hasTmp = fs.exists(tmp);
  const main = intact(fs, file);
  if (main !== null) {
    if (hasTmp) quietRemove(fs, tmp);
    return main;
  }
  if (!hasTmp) return null;

  const pending = intact(fs, tmp);
  if (pending === null) {
    // недописанный временный, основного нет или он обрезан: записи не было
    quietRemove(fs, tmp);
    return null;
  }
  try {
    if (fs.exists(file)) fs.remove(file);
    fs.rename(tmp, file);
  } catch {
    /* поднять не вышло — текст всё равно отдаём, следующее чтение повторит */
  }
  return pending;
}

/**
 * Удалить: сначала временный, потом основной (почему — в шапке). Не удалился
 * временный — основной не трогается и отказ летит дальше: запись остаётся
 * целой, а не превращается в бесхозный временный, который поднимет чтение.
 */
export function removeRecord(fs: RawFiles, file: string): void {
  const tmp = tmpOf(file);
  if (fs.exists(tmp)) fs.remove(tmp);
  if (fs.exists(file)) fs.remove(file);
}

/**
 * Имена записей в каталоге. Запись, от которой остался только временный
 * файл, — тоже запись: без этого очередь, которая ищет свои элементы
 * перечислением, не увидела бы сдачу, оборванную между удалением и
 * перемещением, до первого прямого чтения — а его бы и не было.
 */
export function listRecords(fs: RawFiles): string[] {
  const names = fs.list();
  const out = new Set(names.filter((n) => !n.endsWith(TMP_SUFFIX)));
  for (const name of names) {
    if (!name.endsWith(TMP_SUFFIX)) continue;
    const file = name.slice(0, -TMP_SUFFIX.length);
    if (out.has(file)) continue;
    if (readRecord(fs, file) !== null) out.add(file);
  }
  return [...out];
}
