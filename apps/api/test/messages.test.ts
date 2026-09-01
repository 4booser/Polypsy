import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { adminA, api, db, makeUser } from "./fixtures";
import { messages, threads, users } from "../src/db/schema";

/**
 * Переписка с границами.
 *
 * Проверяется не «сообщение доставлено», а четыре вещи, каждая из которых
 * ломается тихо: пациент не выбирает адресата, чужой разговор не читается,
 * текст лежит зашифрованным, а непрочитанное попадает в общую очередь работы,
 * а не в отдельное место, куда надо не забыть зайти.
 */

/** Пациент со своим специалистом */
async function pair(tag: string) {
  const specialist = await makeUser("admin", `ms-s-${tag}-${crypto.randomUUID()}@test`);
  const patient = await makeUser("user", `ms-p-${tag}-${crypto.randomUUID()}@test`);
  await db.update(users).set({ leadSpecialistId: specialist.id }).where(eq(users.id, patient.id));
  return { specialist, patient };
}

describe("кто с кем переписывается", () => {
  test("пациент пишет своему специалисту, не выбирая адресата", async () => {
    const { specialist, patient } = await pair("a");

    const sent = await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Стало тяжелее засыпать" }),
    });
    expect(sent.status).toBe(201);

    const [thread] = await db.select().from(threads).where(eq(threads.id, sent.body.threadId));
    expect(thread!.patientId).toBe(patient.id);
    expect(thread!.specialistId).toBe(specialist.id);
  });

  test("без ведущего специалиста переписки нет", async () => {
    /*
     * Писать «в отделение» означало бы письмо, за которое никто не отвечает,
     * а такое письмо хуже отсутствия переписки: человек ждёт ответа, которого
     * никто не собирается давать.
     */
    const lonely = await makeUser("user", `ms-lonely-${crypto.randomUUID()}@test`);
    const res = await api("/api/messages", lonely.token, {
      method: "POST",
      body: JSON.stringify({ text: "Есть кто-нибудь?" }),
    });
    expect(res.status).toBe(400);
  });

  test("текст лежит зашифрованным", async () => {
    const { patient } = await pair("b");
    await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Уникальное слово фазаньев" }),
    });

    const rows = await db.select().from(messages);
    const mine = rows.find((m) => m.authorId === patient.id);
    expect(mine).toBeDefined();
    expect(mine!.textEnc).not.toContain("фазаньев");
  });

  test("чужой разговор не читается", async () => {
    const { patient } = await pair("c");
    const sent = await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Личное" }),
    });

    const stranger = await makeUser("user", `ms-x-${crypto.randomUUID()}@test`);
    const res = await api(`/api/messages/${sent.body.threadId}`, stranger.token);
    // «не найдено», а не «нельзя»: по коду отказа нельзя узнать, что разговор есть
    expect(res.status).toBe(404);
  });
});

describe("прочитано", () => {
  test("отметка ставится при открытии, а не при ответе", async () => {
    /*
     * «Прочитано» означает ровно «специалист это видел» — по нему человек
     * понимает, что письмо не потерялось. Ждать ответа, чтобы поставить
     * отметку, значило бы оставлять его в неведении именно тогда, когда
     * ответ готовится дольше обычного.
     */
    const { specialist, patient } = await pair("d");
    const sent = await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Вопрос" }),
    });

    const beforeRows = await db.select().from(messages).where(eq(messages.id, sent.body.id));
    expect(beforeRows[0]!.readAt).toBeNull();

    await api(`/api/messages/${sent.body.threadId}`, specialist.token);

    const afterRows = await db.select().from(messages).where(eq(messages.id, sent.body.id));
    expect(afterRows[0]!.readAt).not.toBeNull();
  });

  test("своё сообщение прочитанным себе не помечается", async () => {
    const { patient } = await pair("e");
    const sent = await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Своё" }),
    });
    await api(`/api/messages/${sent.body.threadId}`, patient.token);

    const [row] = await db.select().from(messages).where(eq(messages.id, sent.body.id));
    expect(row!.readAt).toBeNull();
  });
});

describe("очередь работы", () => {
  test("непрочитанное попадает в общую очередь, а не в отдельное место", async () => {
    /*
     * Отдельный экран переписки означал бы, что письмо ждёт ровно столько,
     * сколько специалист не вспоминал о нём, — а вспоминают о таких экранах
     * в конце дня.
     */
    const { specialist, patient } = await pair("f");
    await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Жду ответа" }),
    });

    const work = await api("/api/worklist", specialist.token);
    const item = work.body.items.find(
      (i: { kind: string; userId: string }) => i.kind === "message" && i.userId === patient.id,
    );
    expect(item).toBeDefined();
    expect(item.signals).toBe(1);
  });

  test("прочитанное из очереди уходит", async () => {
    const { specialist, patient } = await pair("g");
    const sent = await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Прочитай" }),
    });
    await api(`/api/messages/${sent.body.threadId}`, specialist.token);

    const work = await api("/api/worklist", specialist.token);
    expect(
      work.body.items.some(
        (i: { kind: string; userId: string }) => i.kind === "message" && i.userId === patient.id,
      ),
    ).toBe(false);
  });

  test("чужая переписка в очередь не попадает", async () => {
    const { patient } = await pair("h");
    await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Не для всех" }),
    });

    const work = await api("/api/worklist", adminA.token);
    expect(
      work.body.items.some(
        (i: { kind: string; userId: string }) => i.kind === "message" && i.userId === patient.id,
      ),
    ).toBe(false);
  });
});
