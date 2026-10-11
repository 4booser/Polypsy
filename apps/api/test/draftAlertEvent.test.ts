import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, inArray } from "drizzle-orm";
import { adminA, appApi, createSurveySchema, createVersion, db, eq, groupA, isNull, makeUser, surveys } from "./fixtures";
import { alertCases, riskAlerts } from "../src/db/schema";
import { subscribe, type AppEvent } from "../src/lib/events";

/**
 * Тревога автосохранения выходит в поток событий (#134).
 *
 * Черновик с тяжёлым ответом заводил тревогу и случай, но события не
 * выпускал: экран тревог и очередь дежурного обновляются по событиям, и
 * ранняя тревога была не видна до чужого события или ручного обновления. У
 * сдачи то же самое выпускало `alert.created`. Теперь автосохранение
 * выпускает его тем же путём — на новый факт: впервые отмеченный пункт и
 * повышение до тяжёлого. Повтор того же ответа события не порождает.
 *
 * Черновики пишет пациент ролью приложения (appApi); события ловит
 * подписчик шины процесса — тот же, через которого их получает поток
 * консоли (routes/events.ts).
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const people: string[] = [];
const caught: AppEvent[] = [];
let off: (() => void) | null = null;

beforeAll(async () => {
  off = await subscribe((event) => {
    if (event.kind === "alert.created") caught.push(event);
  });
});

afterAll(async () => {
  off?.();
  // тревоги и случаи проверочных людей — в конечном состоянии: разобраны
  if (people.length) {
    const now = new Date().toISOString();
    await db
      .update(riskAlerts)
      .set({ acknowledgedAt: now, acknowledgedBy: adminA.id })
      .where(and(inArray(riskAlerts.userId, people), isNull(riskAlerts.acknowledgedAt)));
    await db
      .update(alertCases)
      .set({ acknowledgedAt: now, acknowledgedBy: adminA.id, outcome: "not_confirmed" })
      .where(and(inArray(alertCases.userId, people), isNull(alertCases.acknowledgedAt)));
  }
});

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };

/** Один пункт: «Ні» — без тревоги, «Іноді» — умеренная, «Часто» — тяжёлая */
async function makeSurvey(): Promise<string> {
  const id = crypto.randomUUID();
  const label = (uk: string) => ({ uk, ru: uk, en: uk });
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: label(`Рання тривога ${tag()}`),
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(
    id,
    createSurveySchema.parse({
      title: label("Рання тривога"),
      administration: "self",
      questions: [
        {
          type: "single",
          title: label("Чи бувають думки про небажання жити?"),
          required: true,
          options: [
            { text: label("Ні") },
            { text: label("Іноді"), riskFlag: true, riskLabel: label("Іноді"), riskSeverity: "moderate" },
            { text: label("Часто"), riskFlag: true, riskLabel: label("Часто"), riskSeverity: "severe" },
          ],
        },
      ],
    }),
    adminA.id,
    "v1",
  );
  return id;
}

async function draftOf() {
  const surveyId = await makeSurvey();
  const person = await makeUser("user", `draft-event-${tag()}@test.dev`, { sex: "female", birthDate: "1992-02-02" });
  people.push(person.id);
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
  const save = async (option: 0 | 1 | 2) => {
    const q = shown.questions[0]!;
    const res = await appApi(`/api/surveys/${surveyId}/draft`, person.token, {
      method: "PUT",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 20_000,
        versionId: shown.versionId,
        answers: [{ questionId: q.id, optionIds: [q.options[option]!.id], durationMs: 1500, changeCount: 0, visitCount: 1 }],
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const events = () => caught.filter((e) => e.userId === person.id);
  return { surveyId, save, events };
}

/** Дождаться n событий человека — по факту, а не по таймеру */
async function untilCount(events: () => AppEvent[], n: number, ms = 4000): Promise<AppEvent[]> {
  const until = Date.now() + ms;
  while (Date.now() < until && events().length < n) await Bun.sleep(20);
  return events();
}

/** Новых событий нет: подождать дольше, чем доходит уведомление, и пересчитать */
async function quiet(events: () => AppEvent[], ms = 1000): Promise<AppEvent[]> {
  await Bun.sleep(ms);
  return events();
}

describe("тревога автосохранения в потоке событий (#134)", () => {
  test("критический ответ — alert.created; тот же ответ ещё раз — тишина; повышение до тяжёлого — снова событие", async () => {
    const d = await draftOf();

    await d.save(1);
    const first = await untilCount(d.events, 1);
    expect(first.length, "ранняя тревога не вышла в поток").toBe(1);
    expect(first[0]).toMatchObject({ kind: "alert.created", surveyIds: [d.surveyId], severity: "moderate" });

    await d.save(1);
    expect((await quiet(d.events)).length, "повтор того же ответа выпустил событие").toBe(1);

    await d.save(2);
    const upgraded = await untilCount(d.events, 2);
    expect(upgraded.length, "повышение до тяжёлого не вышло в поток").toBe(2);
    expect(upgraded[1]).toMatchObject({ kind: "alert.created", surveyIds: [d.surveyId], severity: "severe" });

    await d.save(2);
    expect((await quiet(d.events)).length, "повтор тяжёлого ответа выпустил событие").toBe(2);
    // снятая тяжесть — не новый факт: тревога не понижается, события нет
    await d.save(1);
    expect((await quiet(d.events)).length).toBe(2);
  }, 30_000);

  test("сразу тяжёлый ответ — одно событие severe", async () => {
    const d = await draftOf();
    await d.save(2);
    const got = await untilCount(d.events, 1);
    expect(got.map((e) => e.severity)).toEqual(["severe"]);
  }, 30_000);

  test("контроль: черновик без критического ответа — ни тревоги, ни события", async () => {
    const d = await draftOf();
    await d.save(0);
    expect(await quiet(d.events)).toEqual([]);
  }, 30_000);
});
