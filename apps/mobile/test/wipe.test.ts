import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { memoryStore, resetStore, storeFaults } from "./store.mock";
import { deviceId, wipeLocalData } from "../src/offline/device";
import { carryOutWipe, resumeWipe, WIPE_STATE_KEY, type WipeDeps, type WipeState } from "../src/offline/wipe";

/**
 * Удалённое стирание на устройстве (волна 15, внешний разбор, п. 3 — P1).
 *
 * Было: клиент подтверждал серверу стирание ДО очистки — POST
 * /api/devices/wiped, потом wipeLocalData и токены. Хранилище, бросившее
 * исключение посреди очистки, оставляло на планшете и кэш, и сессию, а
 * сервер уже считал устройство стёртым и больше команды не выдавал. Врать
 * здесь хуже, чем промолчать: «стёрто» в консоли снимает с людей заботу о
 * потерянном планшете.
 *
 * Стало (offline/wipe.ts): подтверждение — только после проверенной очистки;
 * незавершённая операция записана на устройство и доводится при следующем
 * запуске; подтверждение, не дошедшее по сети, уходит от имени того же
 * человека, когда он снова войдёт.
 */

beforeEach(() => {
  resetStore();
});

/** Токен с нужным sub — владелец офлайн-данных определяется по нему (offline/owner.ts) */
function tokenOf(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ sub })}.sig`;
}

interface Fake extends WipeDeps {
  current: string | null;
  confirms: { deviceId: string; token: string; dataLeft: string[]; tokenInStorage: string | null }[];
  clears: number;
  confirmFails: ((n: number) => { status: number } | null) | null;
  clearFails: ((n: number) => boolean) | null;
}

/** Хранилище токенов и сервер — подменой; хранилище данных — память из store.mock.ts */
function fake(token: string | null): Fake {
  const box: Fake = {
    current: token,
    confirms: [],
    clears: 0,
    confirmFails: null,
    clearFails: null,
    token: async () => box.current,
    clearTokens: async () => {
      box.clears += 1;
      if (box.clearFails?.(box.clears)) throw new Error("simulated secure store failure");
      box.current = null;
    },
    confirm: async (id, t) => {
      const fail = box.confirmFails?.(box.confirms.length + 1);
      box.confirms.push({
        deviceId: id,
        token: t,
        dataLeft: memoryStore.keys("").filter((k) => k !== WIPE_STATE_KEY),
        tokenInStorage: box.current,
      });
      if (fail) throw Object.assign(new Error("fail"), fail);
    },
  };
  return box;
}

/** Что лежит на планшете, пока его не потеряли */
function fillDevice(): string {
  memoryStore.write("rounds:s1", { items: [{ id: "p1" }] });
  memoryStore.write("card:s1:p1", { fullName: "Петров" });
  memoryStore.write("queue:s1:x", { answers: [] });
  return deviceId();
}

const state = () => memoryStore.read<WipeState>(WIPE_STATE_KEY);
const dataLeft = () => memoryStore.keys("").filter((k) => k !== WIPE_STATE_KEY);

describe("стирание подтверждается после очистки, а не до", () => {
  test("очистка прошла — подтверждение уходит, когда данных уже нет и сессии в хранилище тоже", async () => {
    const id = fillDevice();
    const deps = fake(tokenOf("staff-1"));

    const outcome = await carryOutWipe(id, deps);

    expect(outcome).toEqual({ erased: true, signedOut: true, confirmed: true });
    expect(dataLeft()).toEqual([]);
    expect(deps.confirms).toHaveLength(1);
    const [sent] = deps.confirms;
    expect(sent!.deviceId).toBe(id);
    // в момент подтверждения на устройстве уже пусто: сервер слышит о свершившемся, а не об обещании
    expect(sent!.dataLeft).toEqual([]);
    // сессия снята раньше подтверждения; оно идёт токеном, запомненным до снятия
    expect(sent!.tokenInStorage).toBeNull();
    expect(sent!.token).toBe(tokenOf("staff-1"));
    // операция завершена — следа не остаётся
    expect(state()).toBeNull();
  });

  test("хранилище бросило посреди очистки — сервер не слышит «стёрто», сессия всё равно снята", async () => {
    // проба ревьюера (proof-wipe.ts): хранилище, бросающее исключение
    const id = fillDevice();
    storeFaults.failRemove = (name) => name.startsWith("card:");
    const deps = fake(tokenOf("staff-1"));

    const outcome = await carryOutWipe(id, deps);

    expect(outcome.erased).toBe(false);
    expect(outcome.confirmed).toBe(false);
    expect(deps.confirms).toEqual([]);
    // нашедший планшет не должен открыть отделение: выход — даже при неудачной очистке
    expect(outcome.signedOut).toBe(true);
    expect(deps.current).toBeNull();
    // операция записана и переживёт перезапуск
    expect(state()).toMatchObject({ deviceId: id, owner: "staff-1", erased: false, signedOut: true });
  });

  test("хранилище молча не удалило запись — это тоже не очистка", async () => {
    /*
     * Нативное хранилище глотает отказ удаления (store.ts: «останется целой,
     * повтор удалит»). Счёт удалённых здесь врёт так же, как ранний ответ
     * серверу: очистка проверяется тем, что осталось, а не тем, что просили.
     */
    const id = fillDevice();
    storeFaults.swallowRemove = (name) => name.startsWith("queue:");
    const deps = fake(tokenOf("staff-1"));

    const outcome = await carryOutWipe(id, deps);

    expect(outcome.erased).toBe(false);
    expect(deps.confirms).toEqual([]);
    expect(dataLeft()).toEqual(["queue:s1:x"]);
  });
});

describe("незавершённое стирание переживает перезапуск", () => {
  test("следующий запуск доводит очистку без сети; подтверждение — после входа того же человека", async () => {
    const id = fillDevice();
    storeFaults.failRemove = (name) => name.startsWith("card:");
    const deps = fake(tokenOf("staff-1"));
    await carryOutWipe(id, deps);

    // перезапуск: хранилище ожило, сессии нет (снята в прошлый раз), сети может не быть
    storeFaults.failRemove = null;
    const resumed = await resumeWipe(deps);
    expect(resumed).toEqual({ erased: true, signedOut: true, confirmed: false });
    expect(dataLeft()).toEqual([]);
    // подтверждать нечем: сессии нет, а чужой вход подтверждать не вправе
    expect(deps.confirms).toEqual([]);
    expect(state()).toMatchObject({ erased: true, signedOut: true });

    // на планшет вошёл другой сотрудник — команда была не его, подтверждение от его имени не уходит
    deps.current = tokenOf("staff-2");
    await resumeWipe(deps);
    expect(deps.confirms).toEqual([]);
    expect(deps.current, "чужую свежую сессию стирание не трогает").toBe(tokenOf("staff-2"));
    expect(state()).not.toBeNull();

    // вошёл тот, чья была команда, — подтверждение уходит за прежнюю установку
    deps.current = tokenOf("staff-1");
    const done = await resumeWipe(deps);
    expect(done?.confirmed).toBe(true);
    expect(deps.confirms.map((c) => c.deviceId)).toEqual([id]);
    expect(deps.current, "свежую сессию того же человека не снимаем").toBe(tokenOf("staff-1"));
    expect(state()).toBeNull();

    // больше нечего доводить
    expect(await resumeWipe(deps)).toBeNull();
  });

  test("подтверждение не дошло по сети — ждёт, а не теряется и не отправляется заранее", async () => {
    const id = fillDevice();
    const deps = fake(tokenOf("staff-1"));
    deps.confirmFails = () => ({ status: 0 });

    const outcome = await carryOutWipe(id, deps);
    expect(outcome).toEqual({ erased: true, signedOut: true, confirmed: false });
    expect(state()).toMatchObject({ deviceId: id, erased: true, signedOut: true });

    deps.confirmFails = null;
    deps.current = tokenOf("staff-1");
    expect((await resumeWipe(deps))?.confirmed).toBe(true);
    expect(state()).toBeNull();
  });

  test("сервер подтверждения не ждёт (404) — след снимается, а не висит вечно", async () => {
    const id = fillDevice();
    const deps = fake(tokenOf("staff-1"));
    deps.confirmFails = () => ({ status: 404 });

    await carryOutWipe(id, deps);
    expect(state()).toBeNull();
  });

  test("не снялась сессия — снимается при следующем запуске", async () => {
    const id = fillDevice();
    const deps = fake(tokenOf("staff-1"));
    deps.clearFails = (n) => n === 1;

    const outcome = await carryOutWipe(id, deps);
    expect(outcome.signedOut).toBe(false);
    expect(outcome.erased).toBe(true);
    expect(state()).toMatchObject({ erased: true, signedOut: false });

    const resumed = await resumeWipe(deps);
    expect(resumed?.signedOut).toBe(true);
    expect(deps.current).toBeNull();
  });

  test("след операции записан и в хранилище, которое бросает на записи, стирание всё равно идёт", async () => {
    /*
     * Не записалось состояние — значит, не будет и довода при запуске. Тогда
     * держится второй рубеж: сервер не получил подтверждения и выдаст команду
     * снова при следующей отметке.
     */
    const id = fillDevice();
    storeFaults.failWrite = (name) => name === WIPE_STATE_KEY;
    const deps = fake(tokenOf("staff-1"));

    const outcome = await carryOutWipe(id, deps);
    expect(outcome.erased).toBe(true);
    expect(outcome.confirmed).toBe(true);
    expect(dataLeft()).toEqual([]);
  });
});

/**
 * Проба ревьюера на самом исходнике клиента.
 *
 * Модуль стирания проверен выше, но сломать его можно и снаружи: отметка
 * устройства (src/api/client.ts, deviceCheckin) могла бы снова послать
 * подтверждение сама, в обход модуля. Клиент в тестовом процессе не
 * грузится (react-native), поэтому, как у ревьюера (proof-wipe.ts), тело
 * метода вынимается из исходника компилятором и выполняется с подменёнными
 * запросом и хранилищем токенов.
 */
describe("отметка устройства в клиенте", () => {
  const CLIENT = resolve(import.meta.dir, "../src/api/client.ts");

  function initializerOf(source: ts.SourceFile, name: string): string | null {
    let found: string | null = null;
    const walk = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) found = node.initializer.getText(source);
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
        found = node.initializer.getText(source);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    return found;
  }

  function loadCheckin(env: {
    request: (path: string, init?: RequestInit) => Promise<unknown>;
    tokenStorage: { get(): Promise<string | null>; clear(): Promise<void> };
  }): (label: string | null) => Promise<boolean> {
    const text = readFileSync(CLIENT, "utf8");
    const source = ts.createSourceFile("client.ts", text, ts.ScriptTarget.Latest, true);
    const method = initializerOf(source, "deviceCheckin");
    if (!method) throw new Error("deviceCheckin не найден в client.ts");
    // зависимости стирания — там, где их собирает клиент (если собирает)
    const deps = initializerOf(source, "wipeDeps");
    const body = `${deps ? `const wipeDeps = ${deps};` : ""} const method = ${method}; return method;`;
    const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const names = [
      "deviceId",
      "request",
      "platformName",
      "appBuildInfo",
      "deviceCounts",
      "wipeLocalData",
      "tokenStorage",
      "resumeWipe",
      "carryOutWipe",
    ];
    const values = [
      deviceId,
      env.request,
      () => "android",
      () => ({ appVersion: null, appBuild: null }),
      () => ({ pending: 0, rejected: 0 }),
      wipeLocalData,
      env.tokenStorage,
      resumeWipe,
      carryOutWipe,
    ];
    return new Function(...names, js)(...values) as (label: string | null) => Promise<boolean>;
  }

  test("хранилище бросило при стирании — /api/devices/wiped не отправлен", async () => {
    fillDevice();
    let token: string | null = tokenOf("staff-1");
    const calls: string[] = [];
    const checkin = loadCheckin({
      request: async (path) => {
        calls.push(path);
        return path === "/api/devices/checkin" ? { wipe: true } : { ok: true };
      },
      tokenStorage: {
        get: async () => token,
        clear: async () => {
          token = null;
        },
      },
    });

    storeFaults.failRemove = (name) => name.startsWith("card:");
    expect(await checkin(null)).toBe(false);
    expect(calls).toEqual(["/api/devices/checkin"]);
    expect(token, "сессия снимается и при неудачной очистке").toBeNull();

    // перезапуск с ожившим хранилищем: очистка доводится до отметки, подтверждать пока нечем
    storeFaults.failRemove = null;
    await checkin(null).catch(() => false);
    expect(dataLeft().filter((k) => k !== "device:id")).toEqual([]);
    expect(calls.filter((p) => p === "/api/devices/wiped")).toEqual([]);
  });

  test("очистка прошла — подтверждение уходит после неё", async () => {
    fillDevice();
    let token: string | null = tokenOf("staff-1");
    const seen: { path: string; left: string[] }[] = [];
    const checkin = loadCheckin({
      request: async (path) => {
        seen.push({ path, left: dataLeft() });
        return path === "/api/devices/checkin" ? { wipe: true } : { ok: true };
      },
      tokenStorage: {
        get: async () => token,
        clear: async () => {
          token = null;
        },
      },
    });

    expect(await checkin(null)).toBe(true);
    const confirm = seen.find((s) => s.path === "/api/devices/wiped");
    expect(confirm, "подтверждение не отправлено").toBeDefined();
    expect(confirm!.left).toEqual([]);
    expect(token).toBeNull();
  });
});
