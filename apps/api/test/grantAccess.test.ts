import { describe, expect, test } from "bun:test";
import { adminA, and, api, db, eq, makeUser, submitSurvey, surveyInA } from "./fixtures";
import { auditLog, surveyAccess } from "../src/db/schema";
import { grantAccess } from "../src/lib/grantAccess";

/**
 * Выдача и перевыдача назначения.
 *
 * Люди здесь каждый раз новые (почта с randomUUID): таблица назначений
 * общая на всю сюиту, и тест, который надеется, что у пациента из
 * фикстур ещё нет выдачи этой методики, зависит от порядка файлов.
 */

const grantOf = async (userId: string) =>
  (
    await db
      .select()
      .from(surveyAccess)
      .where(and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, userId)))
  )[0];

const base = (userId: string) => ({
  surveyId: surveyInA,
  userId,
  grantedBy: adminA.id,
  expiresAt: null,
  note: null,
});

describe("перевыдача: лимит попыток", () => {
  test("перевыдача без лимита не снимает ограничение, явный null — снимает", async () => {
    /*
     * Так перевыдают планировщик, каскад по скринингу и протокол
     * наблюдения: лимит они не знают и не указывают. Контракт Grant
     * обещает для undefined «не менять», а upsert писал
     * excluded.attempts_allowed — то есть умолчание колонки, null, — и
     * методика с одной попыткой после планового повтора становилась
     * проходимой сколько угодно раз.
     */
    const person = await makeUser("user", `grant-limit-${crypto.randomUUID()}@test`);
    await grantAccess(db, [{ ...base(person.id), attemptsAllowed: 2 }], { term: "set" });
    await db.update(surveyAccess).set({ attemptsUsed: 2 }).where(eq(surveyAccess.userId, person.id));

    await grantAccess(db, [{ ...base(person.id), grantedBy: null, note: "повтор за розкладом" }], { term: "set" });
    let row = await grantOf(person.id);
    expect(row!.attemptsAllowed, "перевыдача без лимита сняла ограничение").toBe(2);
    // всё остальное перевыдача по-прежнему переписывает — это новое разрешение пройти
    expect(row!.attemptsUsed).toBe(0);
    expect(row!.note).toBe("повтор за розкладом");
    expect(row!.grantedBy).toBeNull();

    await grantAccess(db, [{ ...base(person.id), attemptsAllowed: null }], { term: "set" });
    row = await grantOf(person.id);
    expect(row!.attemptsAllowed, "явный null — «не ограничивать»").toBeNull();

    await grantAccess(db, [{ ...base(person.id), attemptsAllowed: 3 }], { term: "set" });
    expect((await grantOf(person.id))!.attemptsAllowed).toBe(3);
  });

  test("в одной пачке лимит указан у одних и не указан у других", async () => {
    // групповая выдача — одна вставка на всех; у каждого своё «не менять»
    const kept = await makeUser("user", `grant-kept-${crypto.randomUUID()}@test`);
    const changed = await makeUser("user", `grant-changed-${crypto.randomUUID()}@test`);
    const fresh = await makeUser("user", `grant-fresh-${crypto.randomUUID()}@test`);
    await grantAccess(db, [
      { ...base(kept.id), attemptsAllowed: 1 },
      { ...base(changed.id), attemptsAllowed: 1 },
    ], { term: "set" });

    await grantAccess(db, [base(kept.id), { ...base(changed.id), attemptsAllowed: 4 }, base(fresh.id)], { term: "set" });

    expect((await grantOf(kept.id))!.attemptsAllowed).toBe(1);
    expect((await grantOf(changed.id))!.attemptsAllowed).toBe(4);
    // новой выдаче без лимита нечего сохранять — умолчание колонки, без ограничения
    expect((await grantOf(fresh.id))!.attemptsAllowed).toBeNull();
  });

  test("после перевыдачи планировщиком пациент проходит столько раз, сколько назначено, а не сколько угодно", async () => {
    const person = await makeUser("user", `grant-e2e-${crypto.randomUUID()}@test`);
    const granted = await api(`/api/access/surveys/${surveyInA}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, attemptsAllowed: 1 }),
    });
    expect(granted.status).toBe(201);
    expect((await submitSurvey(surveyInA, person.token)).status).toBe(201);
    expect((await submitSurvey(surveyInA, person.token)).status).toBe(400);

    // плановый повтор: новая попытка — одна, как и была назначена
    await grantAccess(db, [{ ...base(person.id), grantedBy: null }], { term: "set" });
    expect((await submitSurvey(surveyInA, person.token)).status).toBe(201);
    const extra = await submitSurvey(surveyInA, person.token);
    expect(extra.status, "лишнее прохождение принято: лимит снят перевыдачей").toBe(400);
  });
});

describe("журнал выдачи: расширение собственной зоны", () => {
  const grantEvents = async (userId: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "access.grant"), eq(auditLog.subjectUserId, userId)))
      .orderBy(auditLog.at);

  test("выдача человеку вне своей зоны помечается, выдача своему — нет", async () => {
    /*
     * Пометка widenedOwnScope ради одного события: сотрудник выписал себе
     * доступ к карте человека, которого до этого не видел. Проверка «был ли
     * в зоне» стояла ПОСЛЕ выдачи — когда человек уже в зоне именно
     * благодаря ей, — и пометка не появлялась никогда.
     */
    const stranger = await makeUser("user", `grant-stranger-${crypto.randomUUID()}@test`);
    const first = await api(`/api/access/surveys/${surveyInA}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: stranger.id }),
    });
    expect(first.status).toBe(201);

    // теперь человек в зоне — повторная выдача обычная работа
    const again = await api(`/api/access/surveys/${surveyInA}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: stranger.id }),
    });
    expect(again.status).toBe(201);

    const events = await grantEvents(stranger.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.details, "расширение зоны не отмечено").toMatchObject({ widenedOwnScope: true });
    expect(events[1]!.details).not.toHaveProperty("widenedOwnScope");
  });
});
