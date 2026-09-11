import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * Секреты установки: чего процесс не прощает и что от чего отделено.
 *
 * Проверяется в отдельных процессах, и иначе нельзя: конфигурация читается
 * один раз при загрузке модуля, а модуль в bun один на весь тестовый
 * процесс. Подменить переменные «на ходу» — значит проверить не то, что
 * происходит при запуске сервера.
 *
 * Два обязательства:
 *
 *  1. Установка в бою не поднимается без ключа шифрования. Раньше
 *     поднималась — и писала ФИО, телефоны, свободные ответы, заключения,
 *     заметки приёма и стенограммы приёмов открытым текстом, ничем себя не
 *     выдавая: экраны те же, работа та же, предупреждение в логе при старте
 *     видит только тот, кто смотрит лог при старте.
 *
 *  2. Слепой индекс телефона и коды выгрузок не зависят от JWT_SECRET.
 *     Пока зависели, отделение ENCRYPTION_KEY не значило ничего: владелец
 *     дампа, знающий секрет подписи (он есть в окружении каждого процесса,
 *     в CI, в отладочных выгрузках), восстанавливал телефоны перебором —
 *     украинских номеров порядка 10^9. И наоборот: ротация JWT_SECRET,
 *     штатная реакция на утечку, молча ломала дедупликацию номеров.
 */

const API = resolve(import.meta.dir, "..");
const LONG = (c: string) => c.repeat(40);

const BASE = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://nobody@localhost:5432/nowhere",
  JWT_SECRET: LONG("j"),
  PHONE_INDEX_SECRET: LONG("p"),
  EXPORT_SECRET: LONG("e"),
  ENCRYPTION_KEY: `v1:${Buffer.alloc(32, 7).toString("base64")}`,
};

/** Запустить кусок кода отдельным процессом с заданным окружением */
async function run(
  code: string,
  env: Record<string, string>,
): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["bun", "-e", code], {
    cwd: API,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code_ = await proc.exited;
  return { ok: code_ === 0, out: `${out}${err}` };
}

const startEnv = (patch: Record<string, string>) =>
  run(`await import(${JSON.stringify(`${API}/src/env.ts`)}); console.log("ЗАПУСТИЛСЯ")`, {
    ...BASE,
    ...patch,
  });

describe("ключ шифрования обязателен в бою", () => {
  test("с ключом процесс стартует — иначе проверки ниже ничего не значат", async () => {
    const res = await startEnv({});
    expect(res.out).toContain("ЗАПУСТИЛСЯ");
    expect(res.ok).toBe(true);
  });

  test("без ключа процесс не стартует и говорит, что делать", async () => {
    const res = await startEnv({ ENCRYPTION_KEY: "" });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("ENCRYPTION_KEY");
    // сообщение обязано быть руководством к действию: установка живая, и
    // «молча упало после обновления» — это остановленный приём
    expect(res.out).toContain("ОТКРЫТЫМ ТЕКСТОМ");
    expect(res.out).toContain("db:encrypt");
  });

  test("ключ-опечатка тоже не проходит", async () => {
    /*
     * «v1» без самого ключа, «ENCRYPTION_KEY=,», случайная строка — всё это
     * непустые значения, из которых не получается ни одного ключа. Проверка
     * «переменная не пуста» их пропускает, и установка считает себя
     * шифрованной, оставаясь открытой. Поэтому вторая проверка — в модуле
     * шифрования, по факту загруженных ключей.
     */
    const res = await run(
      `await import(${JSON.stringify(`${API}/src/lib/crypto.ts`)}); console.log("ЗАПУСТИЛСЯ")`,
      { ...BASE, ENCRYPTION_KEY: "v1" },
    );
    expect(res.ok).toBe(false);
    expect(res.out).toContain("ENCRYPTION_KEY");
  });

  test("вне боя ключ не обязателен: dev поднимается без него", async () => {
    const res = await startEnv({ NODE_ENV: "development", ENCRYPTION_KEY: "" });
    expect(res.out).toContain("ЗАПУСТИЛСЯ");
  });
});

describe("секреты разных контуров", () => {
  test("без своего секрета слепого индекса бой не поднимается", async () => {
    const res = await startEnv({ PHONE_INDEX_SECRET: "" });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("PHONE_INDEX_SECRET");
  });

  test("без секрета выгрузок бой не поднимается", async () => {
    const res = await startEnv({ EXPORT_SECRET: "" });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("EXPORT_SECRET");
  });

  test("вписать всюду одно значение нельзя", async () => {
    /*
     * Самый вероятный способ «настроить» новые переменные — скопировать в
     * них JWT_SECRET. Это возвращает ровно ту связку, ради разрыва которой
     * они заведены, и потому запрещено явно.
     */
    const res = await startEnv({ PHONE_INDEX_SECRET: BASE.JWT_SECRET });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("PHONE_INDEX_SECRET = JWT_SECRET");
  });
});

describe("слепой индекс телефона отвязан от секрета подписи", () => {
  const print = (env: Record<string, string>) =>
    run(
      `const m = await import(${JSON.stringify(`${API}/src/lib/phone.ts`)});
       console.log(m.phoneFingerprint("+380501112233"));`,
      { ...BASE, ...env },
    );

  test("ротация JWT_SECRET не меняет отпечаток", async () => {
    /*
     * Это и есть та самая поломка: сменить секрет подписи — штатная реакция
     * на утечку, и до разделения она молча превращала все отпечатки в
     * новые. Дедупликация переставала находить дубликаты («номер уже
     * используется» не срабатывало), а лонгитюд по человеку разрывался.
     */
    const before = await print({ JWT_SECRET: LONG("a") });
    const after = await print({ JWT_SECRET: LONG("b") });

    expect(before.out.trim()).not.toBe("");
    expect(after.out.trim()).toBe(before.out.trim());
  });

  test("смена PHONE_INDEX_SECRET отпечаток меняет", async () => {
    // обратная проверка: «совпало» ничего не доказывает, если не совпадать
    // оно не умеет вовсе
    const one = await print({ PHONE_INDEX_SECRET: LONG("x") });
    const two = await print({ PHONE_INDEX_SECRET: LONG("y") });

    expect(one.out.trim()).not.toBe(two.out.trim());
  });
});
