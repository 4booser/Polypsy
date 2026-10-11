import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, root } from "./fixtures";
import { asAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { withRequestContext } from "../src/db/context";
import { securityJobs } from "../src/db/schema";
import { type StartOutcome, startReencrypt } from "../src/lib/keyRotation";

/**
 * Внешние вызовы и фоновые проходы вне транзакций (#204).
 *
 * Сеть не держит открытую транзакцию и не держит соединение пула; проход,
 * запущенный из запроса, живёт вне запроса — без его транзакции и без
 * отмены по его обрыву.
 */

/* ═══════════ перешифровка: запуск из запроса ═══════════ */

describe("перешифровка, запущенная запросом, идёт вне запроса (#204)", () => {
  /**
   * Запуск — как у маршрута POST /api/ops/sec/keys/reencrypt: в транзакции
   * запроса суперадмина, под ролью приложения. `leave` — клиент уходит
   * сразу, как получил ответ о запуске.
   */
  async function launch(leave: boolean) {
    const controller = new AbortController();
    const box: { outcome?: StartOutcome } = {};
    await asAppRole(() =>
      withRequestContext(
        baseDb,
        { userId: root.id, role: "superadmin" },
        async () => {
          box.outcome = await startReencrypt({ id: root.id, email: "root@test" });
          if (leave) controller.abort();
        },
        () => false,
        { signal: controller.signal },
      ),
    );
    const outcome = box.outcome!;
    if (!outcome.started) throw new Error(`перешифровка не запустилась: ${outcome.reason}`);
    await outcome.done;
    const [job] = await db.select().from(securityJobs).where(eq(securityJobs.id, outcome.job.id));
    return job!;
  }

  // первым: оборванный на прежнем коде проход висит «идущим» и не дал бы запустить следующий
  test("положительный контроль: клиент дождался — проход доходит до конца", async () => {
    const job = await launch(false);
    expect(job.status, job.error ?? "").toBe("done");
  }, 60_000);

  /*
   * Прежде проход выходил только из транзакции запроса (dbContext.exit), а
   * отмена по обрыву клиента (#186) оставалась на нём: каждый его запрос к
   * базе после обрыва отвергался, и перешифровка обрывалась вместе с
   * запросом, который лишь запустил её, — повиснув «идущей»: и отметка
   * сбоя, и строка журнала шли тем же отвергнутым путём. Изменяющие запросы
   * сегодня не отменяются (только чтение, middleware/auth.ts), но проход не
   * должен держаться за это.
   */
  test("клиент ушёл сразу после запуска — проход доходит до конца", async () => {
    const job = await launch(true);
    expect(job.status, job.error ?? "").toBe("done");
    expect(job.finishedAt).not.toBeNull();
  }, 60_000);
});
