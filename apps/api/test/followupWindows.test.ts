import { describe, expect, test } from "bun:test";
import { desc } from "drizzle-orm";
import { adminA, and, createSurveySchema, createVersion, db, eq, groupA, makeUser, sr45, submitSurvey, surveys } from "./fixtures";
import { scaleBands, scales, surveyAccess, surveyFollowups, surveyVersions } from "../src/db/schema";
import { followUpWindows, openFollowUps } from "../src/lib/followup";

/**
 * Протокол наблюдения: у каждого повтора своё окно.
 *
 * Прежде «повторить через 7 и 30 дней» выдавало один доступ сразу — на
 * 30 + 14 = 44 дня — и сбрасывало счётчик попыток: замер «через неделю»
 * проходился в тот же день, «через месяц» — на десятый, а пропуск недельного
 * всплывал в очереди работы только на 44-й день.
 */

const DAY = 86_400_000;

describe("границы окон", () => {
  test("окно открывается в начале своего дня и закрывается через две недели — по Киеву, с переводом часов", () => {
    // 27.09.2026, 13:00 по Киеву
    const from = new Date("2026-09-27T10:00:00.000Z");
    const [week, month] = followUpWindows(from, [30, 7]);
    // 04.10 00:00 по Киеву (летнее, UTC+3) … конец 17.10
    expect(week).toEqual({
      afterDays: 7,
      opensAt: "2026-10-03T21:00:00.000Z",
      closesAt: "2026-10-17T20:59:59.999Z",
    });
    // 27.10 00:00 по Киеву — уже зимнее время (UTC+2, перевод 25.10) … конец 09.11
    expect(month).toEqual({
      afterDays: 30,
      opensAt: "2026-10-26T22:00:00.000Z",
      closesAt: "2026-11-09T21:59:59.999Z",
    });
  });

  test("замер у полуночи дня перевода часов: окно считается по календарю (#23)", () => {
    // 25.10.2026 00:30 по Киеву (UTC+3); «через 1 день» — 26.10 целиком, не 25-е
    const [next] = followUpWindows(new Date("2026-10-24T21:30:00.000Z"), [1]);
    expect(next).toEqual({
      afterDays: 1,
      opensAt: "2026-10-25T22:00:00.000Z",
      closesAt: "2026-11-08T21:59:59.999Z",
    });
    // 28.03.2026 23:30 по Киеву (UTC+2); «через 1 день» — 29.03 (23 часа), не 30-е
    const [spring] = followUpWindows(new Date("2026-03-28T21:30:00.000Z"), [1]);
    expect(spring!.opensAt).toBe("2026-03-28T22:00:00.000Z");
  });

  test("близкие повторы не сливаются: окно закрывается к открытию следующего", () => {
    const [a, b] = followUpWindows(new Date("2026-09-27T10:00:00.000Z"), [7, 10]);
    expect(new Date(a!.closesAt).getTime()).toBe(new Date(b!.opensAt).getTime() - 1);
  });
});

describe("окна в работе", () => {
  test("замер в полосе ставит окна, а не открывает доступ на 44 дня; окна открываются в свой день", async () => {
    const surveyId = crypto.randomUUID();
    await db.insert(surveys).values({
      id: surveyId,
      groupId: groupA,
      title: { uk: "Протокол спостереження", ru: "Протокол наблюдения", en: "Follow-up protocol" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(surveyId, createSurveySchema.parse(sr45), adminA.id, "v1");
    const [version] = await db
      .select()
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, surveyId))
      .orderBy(desc(surveyVersions.version))
      .limit(1);
    const scale = await db.query.scales.findFirst({
      where: and(eq(scales.versionId, version!.id), eq(scales.code, "Sr")),
    });
    // повторы — на всех полосах шкалы: какая бы ни выпала, протокол сработает
    await db.update(scaleBands).set({ followUpDays: "7,30" }).where(eq(scaleBands.scaleId, scale!.id));

    const person = await makeUser("user", `fw-${crypto.randomUUID()}@test`);
    const before = Date.now();
    const res = await submitSurvey(surveyId, person.token);
    expect(res.status).toBe(201);
    expect(res.body.cascade.scheduledFollowUps).toBe(2);

    const accessOf = async () =>
      (
        await db
          .select()
          .from(surveyAccess)
          .where(and(eq(surveyAccess.surveyId, surveyId), eq(surveyAccess.userId, person.id)))
      )[0];
    expect(await accessOf(), "доступ открыт сразу — до окна первого повтора").toBeUndefined();

    const windows = await db
      .select()
      .from(surveyFollowups)
      .where(and(eq(surveyFollowups.surveyId, surveyId), eq(surveyFollowups.userId, person.id)))
      .orderBy(surveyFollowups.afterDays);
    expect(windows.map((w) => w.afterDays)).toEqual([7, 30]);

    // шестой день — окно ещё закрыто
    await openFollowUps(new Date(before + 6 * DAY));
    expect(await accessOf()).toBeUndefined();

    // седьмой — открыто до конца своего окна, а не до 44-го дня
    await openFollowUps(new Date(before + 7 * DAY + 3_600_000));
    let access = await accessOf();
    expect(new Date(access!.expiresAt!).getTime()).toBe(new Date(windows[0]!.closesAt).getTime());
    expect(access!.note).toContain("7");

    // тридцатый — следующее окно, со своим сроком
    await openFollowUps(new Date(before + 30 * DAY + 3_600_000));
    access = await accessOf();
    expect(new Date(access!.expiresAt!).getTime()).toBe(new Date(windows[1]!.closesAt).getTime());
  }, 30_000);
});
