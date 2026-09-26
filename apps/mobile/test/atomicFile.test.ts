import { describe, expect, test } from "bun:test";
import { listRecords, readRecord, removeRecord, writeRecord, type RawFiles } from "../src/offline/atomicFile";

/**
 * Замещение записи файлом переживает сбой между любыми шагами.
 *
 * Дефект: запись удаляла основной файл отдельным шагом перед перемещением
 * временного. Выключение между ними оставляло хранилище без основной копии,
 * а временный при чтении никто не поднимал. Здесь каталог — в памяти, и
 * «выключение» — исключение на N-м изменяющем шаге: всё, что после него, не
 * происходит, как при настоящей смерти процесса. Затем — «перезапуск»:
 * чтение с того состояния, что осталось на диске.
 */

class PowerCut extends Error {}

/**
 * Каталог в памяти. `cutAt` — номер изменяющего шага (запись, удаление,
 * переименование), на котором «гаснет свет»; запись на этом шаге успевает
 * лечь наполовину — как обрезанный файл.
 */
function memoryDir(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const state = { steps: 0, cutAt: Number.POSITIVE_INFINITY };
  const step = () => {
    state.steps++;
    if (state.steps === state.cutAt) throw new PowerCut();
  };
  const fs: RawFiles = {
    exists: (n) => files.has(n),
    read: (n) => {
      const text = files.get(n);
      if (text === undefined) throw new Error("no file");
      return text;
    },
    write: (n, text) => {
      if (state.steps + 1 === state.cutAt) files.set(n, text.slice(0, Math.floor(text.length / 2)));
      step();
      files.set(n, text);
    },
    remove: (n) => {
      step();
      files.delete(n);
    },
    rename: (from, to) => {
      step();
      const text = files.get(from);
      if (text === undefined) throw new Error("no file");
      files.delete(from);
      files.set(to, text);
    },
    list: () => [...files.keys()],
  };
  return { fs, files, state };
}

const OLD = JSON.stringify({ answers: 199 });
const NEW = JSON.stringify({ answers: 200 });

/** Сколько изменяющих шагов у полной записи поверх существующей */
function stepsOfWrite(): number {
  const { fs, state } = memoryDir({ "d.json": OLD });
  writeRecord(fs, "d.json", NEW);
  return state.steps;
}

describe("сбой посреди записи поверх существующей", () => {
  test("на любом шаге после перезапуска есть копия — прежняя или новая, но не пустота", () => {
    const total = stepsOfWrite();
    expect(total).toBe(3); // временный → удалить основной → переместить

    for (let cut = 1; cut <= total; cut++) {
      const { fs, state } = memoryDir({ "d.json": OLD });
      state.cutAt = cut;
      expect(() => writeRecord(fs, "d.json", NEW)).toThrow(PowerCut);

      state.cutAt = Number.POSITIVE_INFINITY; // перезапуск
      const back = readRecord(fs, "d.json");
      expect([OLD, NEW]).toContain(back!);
      // и перечисление её видит — очередь ищет свои записи именно так
      expect(listRecords(fs)).toEqual(["d.json"]);
    }
  });

  test("ровно дефект: свет погас между удалением основного и перемещением — поднимается новая", () => {
    const { fs, files, state } = memoryDir({ "d.json": OLD });
    state.cutAt = 3; // временный записан, основной удалён, до перемещения не дошло
    expect(() => writeRecord(fs, "d.json", NEW)).toThrow(PowerCut);
    expect(files.has("d.json")).toBe(false);

    state.cutAt = Number.POSITIVE_INFINITY;
    expect(readRecord(fs, "d.json")).toBe(NEW);
    // поднята на место основного, временного больше нет
    expect([...files.keys()]).toEqual(["d.json"]);
  });

  test("оборвалась до удаления основного — остаётся прежняя, недописанный временный стирается", () => {
    const { fs, files, state } = memoryDir({ "d.json": OLD });
    state.cutAt = 1; // временный лёг наполовину
    expect(() => writeRecord(fs, "d.json", NEW)).toThrow(PowerCut);

    state.cutAt = Number.POSITIVE_INFINITY;
    expect(readRecord(fs, "d.json")).toBe(OLD);
    expect([...files.keys()]).toEqual(["d.json"]);
  });

  test("отказ на последнем шаге не стирает временный, если основного уже нет", () => {
    /*
     * Прежний обработчик ошибки удалял временный файл всегда — в том числе
     * когда тот был единственной копией.
     */
    const { fs, files } = memoryDir({ "d.json": OLD });
    const broken: RawFiles = {
      ...fs,
      rename: () => {
        throw new Error("rename failed");
      },
    };
    expect(() => writeRecord(broken, "d.json", NEW)).toThrow("rename failed");
    expect(files.has("d.json.tmp")).toBe(true);
    expect(readRecord(fs, "d.json")).toBe(NEW);
  });
});

describe("сбой посреди записи новой", () => {
  test("до перемещения — записи нет; после — есть; обрезка не выдаётся за запись", () => {
    for (let cut = 1; cut <= 2; cut++) {
      const { fs, state } = memoryDir();
      state.cutAt = cut;
      expect(() => writeRecord(fs, "q.json", NEW)).toThrow(PowerCut);
      state.cutAt = Number.POSITIVE_INFINITY;
      const back = readRecord(fs, "q.json");
      expect(back === null || back === NEW).toBe(true);
      if (cut === 1) expect(back).toBeNull(); // временный лёг наполовину
    }
  });
});

describe("оба файла на диске — решает целость", () => {
  test("основной цел — он и есть последняя подтверждённая копия", () => {
    const { fs, files } = memoryDir({ "d.json": OLD, "d.json.tmp": NEW });
    expect(readRecord(fs, "d.json")).toBe(OLD);
    expect(files.has("d.json.tmp")).toBe(false);
  });

  test("основной обрезан, временный цел — поднимается временный", () => {
    const { fs } = memoryDir({ "d.json": OLD.slice(0, 5), "d.json.tmp": NEW });
    expect(readRecord(fs, "d.json")).toBe(NEW);
    expect(readRecord(fs, "d.json")).toBe(NEW);
  });

  test("оба обрезаны — записи нет, а не мусор", () => {
    const { fs } = memoryDir({ "d.json": OLD.slice(0, 5), "d.json.tmp": NEW.slice(0, 5) });
    expect(readRecord(fs, "d.json")).toBeNull();
  });
});

describe("удаление не воскрешает запись", () => {
  test("сбой между шагами удаления — запись либо цела, либо удалена, но не поднимается из временного", () => {
    /*
     * Отправленная сдача удаляется из очереди. Останься от неё бесхозный
     * временный файл — чтение подняло бы её, и она ушла бы второй раз.
     */
    for (let cut = 1; cut <= 2; cut++) {
      const { fs, state } = memoryDir({ "q.json": OLD, "q.json.tmp": NEW });
      state.cutAt = cut;
      expect(() => removeRecord(fs, "q.json")).toThrow(PowerCut);
      state.cutAt = Number.POSITIVE_INFINITY;
      const back = readRecord(fs, "q.json");
      expect(back === null || back === OLD).toBe(true);
    }
  });

  test("без сбоя — ни основного, ни временного", () => {
    const { fs, files } = memoryDir({ "q.json": OLD, "q.json.tmp": NEW });
    removeRecord(fs, "q.json");
    expect([...files.keys()]).toEqual([]);
    expect(listRecords(fs)).toEqual([]);
  });
});

describe("перечисление", () => {
  test("недописанный бесхозный временный не выдаётся за запись и убирается", () => {
    const { fs, files } = memoryDir({ "a.json": OLD, "b.json.tmp": NEW.slice(0, 4) });
    expect(listRecords(fs)).toEqual(["a.json"]);
    expect(files.has("b.json.tmp")).toBe(false);
  });
});
