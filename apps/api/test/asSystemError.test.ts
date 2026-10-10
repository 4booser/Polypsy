import { describe, expect, test } from "bun:test";
import { db, makeUser, sql } from "./fixtures";
import { baseDb } from "../src/db";
import { asSystem, withDbContext } from "../src/db/context";
import { asAppRole } from "./appRole";

/**
 * asSystem отдаёт наружу исходную ошибку, а не ошибку возврата роли.
 *
 * Возврат роли стоял в finally. Ошибка базы вне точки сохранения прерывает
 * транзакцию, возврат падает следом с «current transaction is aborted» и
 * подменяет причину: сдача, снятая базой как жертва взаимоблокировки, в
 * логе и в ответе была «прерванной транзакцией» (#145, разбор сборщика).
 *
 * Ролью приложения, в контексте пациента — как в запросе.
 */

const person = await makeUser("user", `as-system-${crypto.randomUUID().slice(0, 8)}@test.dev`);

function asPatient<T>(fn: () => Promise<T>): Promise<T> {
  return asAppRole(() => withDbContext(baseDb, { userId: person.id, role: "user" }, fn));
}

async function caught(work: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await work;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("не упало");
}

const role = async () => {
  const [row] = (await db.execute(sql`select current_setting('app.role', true) as role`)) as unknown as { role: string }[];
  return row!.role;
};

describe("asSystem и упавшая транзакция", () => {
  test("ошибка базы внутри — наружу она сама, а не «current transaction is aborted»", async () => {
    /*
     * Ловим внутри контекста — там, где её ловит обработчик запроса (onError
     * пишет её в лог и отвечает по ней). На выходе из транзакции postgres.js
     * сам подставляет первую ошибку вместо 25P02, и снаружи подмены не видно.
     */
    let inside: Error & { code?: string } = new Error("не дошло");
    await caught(
      asPatient(async () => {
        inside = await caught(asSystem(() => db.execute(sql`select 1 / x from (values (1), (0)) v(x)`)));
      }),
    );
    expect(inside.code, inside.message).toBe("22012");
    expect(inside.message).toMatch(/division by zero/);
  });

  test("контроль: ошибка не из базы — роль возвращается, транзакция идёт дальше прежней ролью", async () => {
    const seen = await asPatient(async () => {
      const inside = await caught(
        asSystem(async () => {
          expect(await role()).toBe("system");
          throw new Error("сбой обработчика");
        }),
      );
      return { message: inside.message, after: await role() };
    });
    expect(seen).toEqual({ message: "сбой обработчика", after: "user" });
  });

  test("контроль: удачный вызов — результат и прежняя роль", async () => {
    const seen = await asPatient(async () => {
      const value = await asSystem(async () => role());
      return { value, after: await role() };
    });
    expect(seen).toEqual({ value: "system", after: "user" });
  });
});
