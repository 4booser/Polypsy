import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, makeUser } from "./fixtures";
import { refreshTokens } from "../src/db/schema";
import { claimRotation, issuePair, rotateRefresh } from "../src/lib/refresh";

/**
 * Жизненный цикл refresh-токена.
 *
 * Модель держится на одном: refresh одноразов, и повторное его предъявление
 * означает, что копий у него две — значит одну украли. Тогда гасится вся
 * «семья», разлогинивая и вора, и жертву.
 *
 * До этого механизм не покрывался ни одной проверкой, хотя именно он решает,
 * что делать с украденной сессией.
 */
describe("ротация refresh-токена", () => {
  test("обычная ротация выдаёт новую пару, старый токен гаснет", async () => {
    const person = await makeUser("admin", `rt-ok-${crypto.randomUUID()}@test`);
    const pair = await issuePair(person as never);

    const first = await rotateRefresh(pair.refreshToken);
    expect(first.ok).toBe(true);

    const again = await rotateRefresh(pair.refreshToken);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("reused");
  });

  test("повторное предъявление гасит всю семью", async () => {
    // у вора и жертвы оказались копии одного токена; отобрать надо у обоих,
    // потому что различить их в этот момент нечем
    const person = await makeUser("admin", `rt-fam-${crypto.randomUUID()}@test`);
    const pair = await issuePair(person as never);
    const rotated = await rotateRefresh(pair.refreshToken);
    expect(rotated.ok).toBe(true);

    await rotateRefresh(pair.refreshToken); // повтор

    const alive = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, person.id)));
    expect(alive.every((t) => t.revokedAt !== null), "живой токен пережил гашение семьи").toBe(true);
  });

  test("притязание на обмен однократно", async () => {
    /*
     * Ключевая проверка, и она не про гонку, а про то, чем гонка чинится.
     *
     * Чтение токена и проверка «не погашен ли» шли вне транзакции, а запись
     * была безусловной: два параллельных запроса с одним украденным токеном
     * оба проходили проверку и оба получали живую пару в одной семье. Вор
     * уходил с собственной действующей цепочкой, жертва ничего не замечала.
     *
     * Гонку в этом стенде воспроизвести надёжно не выходит — соединения
     * успевают сериализоваться, и проверка через Promise.all проходит даже
     * на сломанном коде, то есть лжёт. Поэтому проверяется само притязание:
     * гашение выражено условием UPDATE, и второй раз оно не срабатывает.
     * Именно это и делает параллельный случай безопасным.
     */
    const person = await makeUser("admin", `rt-claim-${crypto.randomUUID()}@test`);
    const pair = await issuePair(person as never);
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, person.id));
    expect(row).toBeTruthy();

    expect(await claimRotation(db, row!.id), "первое притязание должно пройти").toBe(true);
    expect(
      await claimRotation(db, row!.id),
      "тот же токен погашен дважды — значит два запроса получили бы по живой паре",
    ).toBe(false);
  });
});
