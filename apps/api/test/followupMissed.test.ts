import { describe, expect, test } from "bun:test";
import { adminA, and, api, db, eq, groupA, makeUser, surveys } from "./fixtures";
import { asAppRole } from "./appRole";
import { surveyAccess, surveyFollowups } from "../src/db/schema";
import { openFollowUps } from "../src/lib/followup";

/**
 * Окно повтора, прошедшее неоткрытым, и окно поверх более долгого доступа.
 *
 * Внешний разбор 2026-09-28 (P2): тик планировщика выбирал окна по
 * opens_at и не смотрел на closes_at, а доступ выдавал перевыдачей со
 * сроком окна. Окно, закрывшееся десять дней назад и так и не открытое
 * (планировщик стоял, учётка была выключена), при следующем тике
 * переписывало действующий ручной доступ — ещё на 30 дней — прошедшей
 * датой: доступ отзывался задним числом. И даже открытое вовремя окно
 * укорачивало более долгий доступ до своего закрытия.
 *
 * Тик идёт под ролью приложения — как в бою (asAppRole): окна и доступ
 * пишет системная автоматика под политиками строк, а не владелец базы.
 */

const DAY = 86_400_000;

async function freshSurvey(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: "Повтор", ru: "Повтор", en: "Follow-up" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "restricted",
    createdBy: adminA.id,
  } as never);
  return id;
}

async function accessOf(surveyId: string, userId: string) {
  const [row] = await db
    .select()
    .from(surveyAccess)
    .where(and(eq(surveyAccess.surveyId, surveyId), eq(surveyAccess.userId, userId)));
  return row;
}

async function windowOf(id: string) {
  const [row] = await db.select().from(surveyFollowups).where(eq(surveyFollowups.id, id));
  return row!;
}

describe("окна повторов и действующий доступ", () => {
  test("окно, закрывшееся неоткрытым, — пропуск: доступ не трогается, а пропуск виден в очереди работы", async () => {
    const now = new Date();
    const surveyId = await freshSurvey();
    const person = await makeUser("user", `fu-missed-${crypto.randomUUID()}@test`);
    // ручной доступ от специалиста — действует ещё 30 дней, одна попытка из двух уже потрачена
    await db.insert(surveyAccess).values({
      surveyId,
      userId: person.id,
      grantedBy: adminA.id,
      expiresAt: new Date(now.getTime() + 30 * DAY).toISOString(),
      note: "ручна видача",
      attemptsAllowed: 2,
      attemptsUsed: 1,
    } as never);
    const before = await accessOf(surveyId, person.id);
    const windowId = crypto.randomUUID();
    await db.insert(surveyFollowups).values({
      id: windowId,
      surveyId,
      userId: person.id,
      afterDays: 7,
      opensAt: new Date(now.getTime() - 25 * DAY).toISOString(),
      closesAt: new Date(now.getTime() - 10 * DAY).toISOString(),
    });

    await asAppRole(() => openFollowUps(now));

    expect(await accessOf(surveyId, person.id), "доступ специалиста остался как был").toEqual(before);
    const w = await windowOf(windowId);
    expect(w.openedAt).toBeNull();
    expect(w.missedAt).not.toBeNull();

    // пропуск — в очереди работы специалиста, как прежде давала истёкшая выдача
    const work = await api("/api/worklist", adminA.token);
    expect(work.status).toBe(200);
    const item = (work.body.items as { kind: string; id: string; days: number }[]).find(
      (i) => i.id === `${person.id}:${surveyId}`,
    );
    expect(item?.kind).toBe("followup");
    expect(item?.days).toBe(10);

    // повторный тик пропуск не переоткрывает и не трогает доступ
    await asAppRole(() => openFollowUps(new Date(now.getTime() + 3_600_000)));
    expect(await accessOf(surveyId, person.id)).toEqual(before);
    expect((await windowOf(windowId)).openedAt).toBeNull();
  }, 30_000);

  test("окно открывается поверх более долгого доступа, не укорачивая его, и даёт новую попытку", async () => {
    const now = new Date();
    const surveyId = await freshSurvey();
    const person = await makeUser("user", `fu-longer-${crypto.randomUUID()}@test`);
    const manualUntil = new Date(now.getTime() + 30 * DAY).toISOString();
    await db.insert(surveyAccess).values({
      surveyId,
      userId: person.id,
      grantedBy: adminA.id,
      expiresAt: manualUntil,
      note: "ручна видача",
      attemptsAllowed: 1,
      attemptsUsed: 1,
    } as never);
    const windowId = crypto.randomUUID();
    await db.insert(surveyFollowups).values({
      id: windowId,
      surveyId,
      userId: person.id,
      afterDays: 7,
      opensAt: new Date(now.getTime() - DAY).toISOString(),
      closesAt: new Date(now.getTime() + 13 * DAY).toISOString(),
    });

    await asAppRole(() => openFollowUps(now));

    const access = await accessOf(surveyId, person.id);
    expect(new Date(access!.expiresAt!).getTime(), "срок — поздний из двух").toBe(new Date(manualUntil).getTime());
    // повтор — новое разрешение пройти: счётчик сдвинут, лимит прежний
    expect(access!.attemptsUsed).toBe(0);
    expect(access!.attemptsAllowed).toBe(1);
    expect((await windowOf(windowId)).openedAt).not.toBeNull();
  }, 30_000);

  test("окно поверх истёкшего доступа продлевает его до своего закрытия; бессрочный остаётся бессрочным", async () => {
    const now = new Date();
    const surveyId = await freshSurvey();
    const expired = await makeUser("user", `fu-expired-${crypto.randomUUID()}@test`);
    const unlimited = await makeUser("user", `fu-unlimited-${crypto.randomUUID()}@test`);
    await db.insert(surveyAccess).values([
      {
        surveyId,
        userId: expired.id,
        grantedBy: adminA.id,
        expiresAt: new Date(now.getTime() - 5 * DAY).toISOString(),
        note: null,
      },
      { surveyId, userId: unlimited.id, grantedBy: adminA.id, expiresAt: null, note: null },
    ] as never);
    const closesAt = new Date(now.getTime() + 13 * DAY).toISOString();
    for (const person of [expired, unlimited]) {
      await db.insert(surveyFollowups).values({
        id: crypto.randomUUID(),
        surveyId,
        userId: person.id,
        afterDays: 7,
        opensAt: new Date(now.getTime() - DAY).toISOString(),
        closesAt,
      });
    }

    await asAppRole(() => openFollowUps(now));

    expect(new Date((await accessOf(surveyId, expired.id))!.expiresAt!).getTime()).toBe(new Date(closesAt).getTime());
    expect((await accessOf(surveyId, unlimited.id))!.expiresAt).toBeNull();
  }, 30_000);
});
