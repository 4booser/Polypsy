import { describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { adminA, api, db, makeUser, root } from "./fixtures";
import { auditLog, messages, threads, users } from "../src/db/schema";
import { encryptField } from "../src/lib/crypto";

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

/**
 * Открыть разговор так, как это делает клиент: прочитать страницу и
 * отметить прочитанными показанные письма собеседника. С волны 12 чтение
 * само ничего не помечает — «прочитано» отдельный POST.
 */
async function openThread(threadId: string, token: string) {
  const page = await api(`/api/messages/${threadId}`, token);
  const ids = (page.body.items as { id: string; mine: boolean; readAt: string | null }[])
    .filter((m) => !m.mine && !m.readAt)
    .map((m) => m.id);
  if (ids.length) {
    await api(`/api/messages/${threadId}/read`, token, { method: "POST", body: JSON.stringify({ ids }) });
  }
  return page;
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

    await openThread(sent.body.threadId, specialist.token);

    const afterRows = await db.select().from(messages).where(eq(messages.id, sent.body.id));
    expect(afterRows[0]!.readAt).not.toBeNull();
  });

  test("своё сообщение прочитанным себе не помечается", async () => {
    const { patient } = await pair("e");
    const sent = await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Своё" }),
    });
    await openThread(sent.body.threadId, patient.token);
    // и прямой просьбой своё не помечается
    const direct = await api(`/api/messages/${sent.body.threadId}/read`, patient.token, {
      method: "POST",
      body: JSON.stringify({ ids: [sent.body.id] }),
    });
    expect(direct.body.marked).toBe(0);

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
    await openThread(sent.body.threadId, specialist.token);

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

/* ─────────── волна 12: длинный разговор, чтение без побочных записей ─────────── */

/** Разговор из n писем пациента, положенных прямо в базу — через API это минуты */
async function longThread(tag: string, n: number) {
  const { specialist, patient } = await pair(tag);
  const first = await api("/api/messages", patient.token, { method: "POST", body: JSON.stringify({ text: "Лист 0" }) });
  const threadId = first.body.threadId as string;
  const start = Date.now() - n * 60_000;
  const rows = Array.from({ length: n - 1 }, (_, i) => ({
    id: crypto.randomUUID(),
    threadId,
    authorId: patient.id,
    textEnc: encryptField(`Лист ${i + 1}`)!,
    sentAt: new Date(start + (i + 1) * 1000).toISOString(),
  }));
  // первое письмо — самое раннее, остальные по секунде после него
  await db.update(messages).set({ sentAt: new Date(start).toISOString() }).where(eq(messages.id, first.body.id));
  for (let i = 0; i < rows.length; i += 200) await db.insert(messages).values(rows.slice(i, i + 200));
  return { specialist, patient, threadId };
}

describe("длинный разговор", () => {
  test("после пятисот писем видны последние, и назад можно дойти до первого", async () => {
    const { specialist, threadId } = await longThread("long", 501);
    const page = await api(`/api/messages/${threadId}`, specialist.token);
    expect(page.status).toBe(200);
    expect(page.body.hasMore).toBe(true);
    // последнее письмо — на экране; внутри страницы — по возрастанию
    expect(page.body.items.at(-1).text).toBe("Лист 500");
    const times = page.body.items.map((m: { sentAt: string }) => Date.parse(m.sentAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const seen = new Set<string>(page.body.items.map((m: { id: string }) => m.id));
    let before: string | null = page.body.nextBefore;
    let texts: string[] = page.body.items.map((m: { text: string }) => m.text);
    while (before) {
      const older = await api(`/api/messages/${threadId}?before=${encodeURIComponent(before)}`, specialist.token);
      for (const m of older.body.items as { id: string }[]) {
        expect(seen.has(m.id), "письмо повторилось на соседней странице").toBe(false);
        seen.add(m.id);
      }
      texts = [...older.body.items.map((m: { text: string }) => m.text), ...texts];
      before = older.body.hasMore ? older.body.nextBefore : null;
    }
    expect(seen.size).toBe(501);
    expect(texts[0]).toBe("Лист 0");
  });

  test("чтение не помечает ничего; «прочитано» — только показанные", async () => {
    const { specialist, threadId } = await longThread("marks", 501);
    const page = await api(`/api/messages/${threadId}`, specialist.token);
    const unreadAfterGet = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), isNull(messages.readAt)));
    expect(unreadAfterGet[0]!.n, "открытие пометило письма само").toBe(501);

    const shown = page.body.items.map((m: { id: string }) => m.id);
    const read = await api(`/api/messages/${threadId}/read`, specialist.token, {
      method: "POST",
      body: JSON.stringify({ ids: shown }),
    });
    expect(read.body.marked).toBe(shown.length);
    const unread = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), isNull(messages.readAt)));
    expect(unread[0]!.n, "помечены письма за пределами показанного").toBe(501 - shown.length);
  });

  test("отметить в чужом разговоре нельзя", async () => {
    const { threadId } = await longThread("foreign-read", 3);
    const stranger = await makeUser("admin", `ms-x-${crypto.randomUUID()}@test`);
    const page = await db.select({ id: messages.id }).from(messages).where(eq(messages.threadId, threadId));
    const res = await api(`/api/messages/${threadId}/read`, stranger.token, {
      method: "POST",
      body: JSON.stringify({ ids: page.map((m) => m.id) }),
    });
    expect(res.status).toBe(404);
  });
});

describe("чтение без записи: «от имени» и «только просмотр»", () => {
  test("суперадмин «от имени» врача читает переписку — 200, «прочитано» не ставится, след в журнале", async () => {
    const { specialist, patient } = await pair("imp");
    const sent = await api("/api/messages", patient.token, { method: "POST", body: JSON.stringify({ text: "Для врача" }) });
    const start = await api(`/api/ops/people/impersonate/${specialist.id}`, root.token, {
      method: "POST",
      body: JSON.stringify({ reason: "Разбор жалобы на переписку" }),
    });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const token = start.body.token as string;

    const list = await api("/api/messages", token);
    expect(list.status).toBe(200);
    const page = await api(`/api/messages/${sent.body.threadId}`, token);
    expect(page.status).toBe(200);
    expect(page.body.items.map((m: { text: string }) => m.text)).toContain("Для врача");
    // отметка — запись, а запись «от имени» закрыта
    const mark = await api(`/api/messages/${sent.body.threadId}/read`, token, {
      method: "POST",
      body: JSON.stringify({ ids: [sent.body.id] }),
    });
    expect(mark.status).toBe(403);

    const [row] = await db.select().from(messages).where(eq(messages.id, sent.body.id));
    expect(row!.readAt, "суперадмин пометил прочитанным за врача").toBeNull();

    const views = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "impersonation.view"), sql`${auditLog.details}->>'impersonation' = ${start.body.sessionId}`));
    expect(views.length).toBeGreaterThan(0);

    await api(`/api/ops/people/impersonate/${start.body.sessionId}/end`, root.token, { method: "POST" });
  });

  test("учётка «только просмотр»: переписка читается, разговор не заводится, отметки нет", async () => {
    const specialist = await makeUser("admin", `ms-ro-s-${crypto.randomUUID()}@test`);
    const viewer = await makeUser("user", `ms-ro-p-${crypto.randomUUID()}@test`, { readOnly: true });
    await db.update(users).set({ leadSpecialistId: specialist.id }).where(eq(users.id, viewer.id));

    // разговора ещё нет: список пуст, и открытие его не заводит
    const empty = await api("/api/messages", viewer.token);
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);
    expect(await db.select().from(threads).where(eq(threads.patientId, viewer.id))).toEqual([]);

    // разговор есть (специалист написал) — читается, но не помечается
    const threadId = crypto.randomUUID();
    await db.insert(threads).values({ id: threadId, patientId: viewer.id, specialistId: specialist.id });
    await db
      .insert(messages)
      .values({ id: crypto.randomUUID(), threadId, authorId: specialist.id, textEnc: encryptField("Вітаю")! });

    const page = await api(`/api/messages/${threadId}`, viewer.token);
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBe(1);
    const mark = await api(`/api/messages/${threadId}/read`, viewer.token, {
      method: "POST",
      body: JSON.stringify({ ids: [page.body.items[0].id] }),
    });
    expect(mark.status).toBe(403);
    const unread = await db.select().from(messages).where(and(eq(messages.threadId, threadId), isNull(messages.readAt)));
    expect(unread.length).toBe(1);
  });
});
