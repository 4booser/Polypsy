import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { db } from "./fixtures";
import { departments } from "../src/db/schema";
import { unwrapDbError } from "../src/db/errors";

/**
 * Ошибки базы приходят в код ошибками драйвера, а не обёрткой drizzle
 * (db/errors.ts).
 *
 * drizzle 0.44 стал заворачивать каждую ошибку драйвера в DrizzleQueryError
 * с SQL и ЗНАЧЕНИЯМИ ПАРАМЕТРОВ в тексте. Текст ошибки у нас уходит в лог,
 * в группы техпанели и в сборщик ошибок — все три построены на том, что
 * персональных данных в нём нет; а код отказа (23505, 42501) и текст
 * Postgres из сообщения пропадали. Этот сторож держит обе стороны: в
 * ошибке есть код и текст драйвера, в её сообщении нет значений параметров.
 */

/** Уникальная метка, которую не должно быть видно в тексте ошибки */
const marker = `секрет-${crypto.randomUUID()}`;

async function failing<T>(work: Promise<T>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("запрос не упал");
}

describe("ошибки базы — ошибки драйвера", () => {
  test("нарушение ограничения: код Postgres на самой ошибке, параметров в тексте нет, текст запроса — рядом", async () => {
    const id = crypto.randomUUID();
    const row = { id, title: { uk: marker, ru: marker }, timezone: "Europe/Kyiv" };
    await db.insert(departments).values(row);
    const error = (await failing(db.insert(departments).values(row))) as Error & { code?: string; query?: string };

    expect(error).not.toBeInstanceOf(DrizzleQueryError);
    expect(error.code).toBe("23505");
    expect(error.message).toMatch(/duplicate key|unique/i);
    expect(error.message).not.toContain(marker);
    expect(error.message).not.toContain(id);
    expect(String(error)).not.toContain(marker);
    // текст запроса — параметризованный: значений в нём нет
    expect(error.query).toMatch(/insert into "departments"/);
    expect(error.query).not.toContain(marker);
    // и не сериализуется заодно с ошибкой
    expect(JSON.stringify(error)).not.toContain("insert into");
  });

  test("ошибка внутри транзакции и в db.execute(sql) — тоже драйвера", async () => {
    const inTx = (await failing(
      db.transaction(async (tx) => {
        await tx.execute(sql`select ${marker}::int`);
      }),
    )) as Error & { code?: string };
    expect(inTx).not.toBeInstanceOf(DrizzleQueryError);
    expect(inTx.code).toBe("22P02");
    // текст Postgres (не обёртки): 22P02 сам цитирует значение — это его дело, не наше
    expect(inTx.message).toMatch(/invalid input syntax/);

    const direct = (await failing(db.execute(sql`select * from no_such_table_${sql.raw(marker.slice(7, 15))}`))) as Error & {
      code?: string;
    };
    expect(direct.code).toBe("42P01");
  });

  test("недоступная база: наружу ошибка соединения, а не TypeError распаковки", async () => {
    // postgres.js держит на ошибке соединения неконфигурируемое query=undefined
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const client = postgres("postgres://nobody@127.0.0.1:1/nowhere", { connect_timeout: 2, max: 1 });
    const dead = drizzle(client);
    let caught: unknown;
    try {
      await dead.execute(sql`select 1`);
    } catch (e) {
      caught = e;
    } finally {
      await client.end({ timeout: 1 }).catch(() => {});
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).not.toBe("TypeError");
    expect(String(caught)).toMatch(/ECONNREFUSED|CONNECT_TIMEOUT|connect/i);
  }, 10_000);

  test("unwrapDbError: не обёртка и обёртка без причины возвращаются как есть", () => {
    const plain = new Error("своя");
    expect(unwrapDbError(plain)).toBe(plain);
    const hollow = new DrizzleQueryError("select 1", [], undefined);
    expect(unwrapDbError(hollow)).toBe(hollow);
    expect(unwrapDbError("строка")).toBe("строка");
  });
});
