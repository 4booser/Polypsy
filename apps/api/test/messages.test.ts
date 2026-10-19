import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { adminA, api, appApi, db, makeUser, root } from "./fixtures";
import { appointments, auditLog, departments, messages, slots, specialistProfiles, threads, users } from "../src/db/schema";
import { encryptField } from "../src/lib/crypto";
import { requestSql } from "../src/lib/opsSql";
import { underAppRole } from "./appRole";

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

/*
 * Строка списка в консоли 2.0 (v2-comms): кому я должен ответить и когда
 * следующая встреча. Приёмы, заведённые здесь, к концу файла отменяются:
 * живой приём в общей очереди мешал бы файлам, которые идут следом.
 */
const liveVisits: string[] = [];
afterAll(async () => {
  if (liveVisits.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
      .where(inArray(appointments.id, liveVisits));
  }
});

async function visit(specialistId: string, patientId: string, departmentId: string, hoursAhead: number, status = "booked") {
  const startsAt = new Date(Date.now() + hoursAhead * 3600_000).toISOString();
  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    specialistId,
    departmentId,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 50 * 60_000).toISOString(),
  });
  const id = crypto.randomUUID();
  await db
    .insert(appointments)
    .values({ id, slotId, patientId, specialistId, status: status as "booked" | "cancelled" });
  liveVisits.push(id);
  return id;
}

async function department(tag: string) {
  const id = crypto.randomUUID();
  await db.insert(departments).values({ id, title: { uk: `Відділення ${tag}`, ru: `Отделение ${tag}` }, timezone: "Europe/Kyiv" });
  return id;
}

type ListItem = {
  id: string;
  preview: string | null;
  lastMine: boolean | null;
  lastReadAt: string | null;
  next: { id: string; startsAt: string; room: string | null; status: string } | null;
};

describe("строка списка: последнее письмо и ближайший приём", () => {
  test("начало последнего письма, чьё оно и прочитано ли моё", async () => {
    const { specialist, patient } = await pair("row");
    const asked = await api("/api/messages", patient.token, {
      method: "POST",
      body: JSON.stringify({ text: "Можна перенести суботу\nна вечір?   Маю зміну." }),
    });
    const own = (await api("/api/messages", specialist.token)).body.items.find((t: ListItem) => t.id === asked.body.threadId) as ListItem;
    expect(own.preview, "переводы строк и пробелы схлопнуты").toBe("Можна перенести суботу на вечір? Маю зміну.");
    expect(own.lastMine, "последнее письмо — пациента: ждёт ответа").toBe(false);

    // ответ специалиста — строкой в базе: право писать и зона проверяются в других тестах, здесь — список
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      threadId: asked.body.threadId,
      authorId: specialist.id,
      textEnc: encryptField("Так, переношу.")!,
      sentAt: new Date(Date.now() + 1000).toISOString(),
    });
    const replied = (await api("/api/messages", specialist.token)).body.items.find((t: ListItem) => t.id === asked.body.threadId) as ListItem;
    expect(replied.preview).toBe("Так, переношу.");
    expect(replied.lastMine).toBe(true);
    expect(replied.lastReadAt, "пациент ещё не открыл").toBeNull();

    await openThread(asked.body.threadId, patient.token);
    const read = (await api("/api/messages", specialist.token)).body.items.find((t: ListItem) => t.id === asked.body.threadId) as ListItem;
    expect(read.lastReadAt, "пациент открыл — «прочитав»").toBeTruthy();
  });

  test("длинное письмо режется по слову, а не посреди", async () => {
    const { specialist, patient } = await pair("long");
    const long = `${"слово ".repeat(60)}хвіст`;
    const sent = await api("/api/messages", patient.token, { method: "POST", body: JSON.stringify({ text: long }) });
    const row = (await api("/api/messages", specialist.token)).body.items.find((t: ListItem) => t.id === sent.body.threadId) as ListItem;
    expect(row.preview!.length).toBeLessThanOrEqual(161);
    expect(row.preview!.endsWith("слово…"), row.preview!).toBe(true);
  });

  test("ближайший живой приём у этого специалиста, с кабинетом; чужие и отменённые — мимо", async () => {
    const { specialist, patient } = await pair("next");
    const colleague = await makeUser("admin", `ms-col-${crypto.randomUUID()}@test`);
    const dep = await department("next");
    await db.insert(specialistProfiles).values({ userId: specialist.id, departmentId: dep, room: "214" });
    await db.insert(specialistProfiles).values({ userId: colleague.id, departmentId: dep, room: "101" });

    await visit(colleague.id, patient.id, dep, 2);
    await visit(specialist.id, patient.id, dep, 3, "cancelled");
    const later = await visit(specialist.id, patient.id, dep, 48);
    const sooner = await visit(specialist.id, patient.id, dep, 26);
    await visit(specialist.id, patient.id, dep, -5);
    void later;

    const sent = await api("/api/messages", patient.token, { method: "POST", body: JSON.stringify({ text: "Добрий день" }) });
    const row = (await api("/api/messages", specialist.token)).body.items.find((t: ListItem) => t.id === sent.body.threadId) as ListItem;
    expect(row.next?.id, "не ближайший свой живой приём").toBe(sooner);
    expect(row.next?.room).toBe("214");
    expect(row.next?.status).toBe("booked");
  });

  test("без будущего приёма — next пуст, а не прошлый приём", async () => {
    const { specialist, patient } = await pair("none");
    const sent = await api("/api/messages", patient.token, { method: "POST", body: JSON.stringify({ text: "Дякую" }) });
    const row = (await api("/api/messages", specialist.token)).body.items.find((t: ListItem) => t.id === sent.body.threadId) as ListItem;
    expect(row.next).toBeNull();
  });

  /**
   * Под боевой ролью: письма, приёмы, слоты и профиль специалиста читаются
   * политиками строк, а не владельцем базы. Владелец обходит их, и проверки
   * выше прошли бы, даже если в бою список приходил бы с пустыми полями.
   */
  test("под боевой ролью поля строки на месте", async () => {
    const email = `ms-rls-s-${crypto.randomUUID()}@test.dev`;
    const specialist = await makeUser("admin", email);
    const patient = await makeUser("user", `ms-rls-p-${crypto.randomUUID()}@test.dev`);
    await db.update(users).set({ leadSpecialistId: specialist.id }).where(eq(users.id, patient.id));
    const dep = await department("rls");
    await db.insert(specialistProfiles).values({ userId: specialist.id, departmentId: dep, room: "7" });
    const soon = await visit(specialist.id, patient.id, dep, 30);
    const sent = await api("/api/messages", patient.token, { method: "POST", body: JSON.stringify({ text: "Під роллю" }) });

    const out = await underAppRole<{ login: number; list: number; row: ListItem | undefined }>(`
      const login = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: "secret12345" }),
      });
      out.login = login.status;
      const auth = { Authorization: "Bearer " + (await login.json()).token };
      const list = await app.request("/api/messages", { headers: auth });
      out.list = list.status;
      out.row = ((await list.json()).items ?? []).find((t) => t.id === ${JSON.stringify(sent.body.threadId)});
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive, "роль обходит политики — проверка ничего не доказывает").toBe(true);
    expect(out.login).toBe(200);
    expect(out.list).toBe(200);
    expect(out.row?.preview).toBe("Під роллю");
    expect(out.row?.lastMine).toBe(false);
    expect(out.row?.next?.id, "приём не дочитался под ролью").toBe(soon);
    expect(out.row?.next?.room).toBe("7");
  });
});

/* ─────────── волна 27: счётчик непрочитанного одним числом ─────────── */

/**
 * Разговор специалиста с новым пациентом: `unread` непрочитанных писем
 * пациента, а для шума — прочитанное письмо пациента и своё письмо
 * специалиста (оба в счёт специалиста не идут). Письма — строками в базе:
 * право писать и зона проверяются выше, здесь — счёт.
 */
async function talk(specialistId: string, tag: string, unread: number, opts: { closed?: boolean } = {}) {
  const patient = await makeUser("user", `ms-uc-${tag}-${crypto.randomUUID()}@test`, { leadSpecialistId: specialistId });
  const threadId = crypto.randomUUID();
  const at = Date.now() - 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  await db.insert(threads).values({
    id: threadId,
    patientId: patient.id,
    specialistId,
    lastMessageAt: iso(at + 60_000),
    closedAt: opts.closed ? iso(at) : null,
  });
  await db.insert(messages).values([
    { id: crypto.randomUUID(), threadId, authorId: patient.id, textEnc: encryptField("Прочитане")!, sentAt: iso(at), readAt: iso(at + 500) },
    { id: crypto.randomUUID(), threadId, authorId: specialistId, textEnc: encryptField("Моє")!, sentAt: iso(at + 1000) },
    ...Array.from({ length: unread }, (_, i) => ({
      id: crypto.randomUUID(),
      threadId,
      authorId: patient.id,
      textEnc: encryptField(`Нове ${i}`)!,
      sentAt: iso(at + 2000 + i * 1000),
    })),
  ]);
  return { patient, threadId };
}

type CountedRow = { id: string; unread: number };

/** Число запросов к базе за один запрос к приложению (lib/opsSql.ts, по x-request-id) */
async function sqlOf(path: string, token: string): Promise<number> {
  const requestId = `ms-uc-${crypto.randomUUID()}`;
  const res = await api(path, token, { headers: { "x-request-id": requestId } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return requestSql(requestId)?.count ?? 0;
}

describe("счётчик непрочитанного (GET /api/messages/unread-count)", () => {
  test("одно число — сумма непрочитанного по строкам списка; прочитанное и своё не считаются", async () => {
    const specialist = await makeUser("admin", `ms-uc-s-${crypto.randomUUID()}@test`);
    const counts = [0, 1, 3, 2];
    const made = [];
    for (const [i, n] of counts.entries()) made.push(await talk(specialist.id, `sum${i}`, n));

    const list = await api<{ items: CountedRow[] }>("/api/messages", specialist.token);
    const byThread = new Map(list.body.items.map((t) => [t.id, t.unread]));
    for (const [i, m] of made.entries()) expect(byThread.get(m.threadId), `строка ${i}`).toBe(counts[i]!);

    const count = await api("/api/messages/unread-count", specialist.token);
    expect(count.status, "маршрут ушёл в /:id").toBe(200);
    // только число: ни имён, ни текста писем
    expect(count.body).toEqual({ unread: 6 });
  });

  test("круг — как у списка: закрытого и чужого разговора нет ни в списке, ни в числе", async () => {
    const specialist = await makeUser("admin", `ms-uc-s-${crypto.randomUUID()}@test`);
    const colleague = await makeUser("admin", `ms-uc-c-${crypto.randomUUID()}@test`);
    const open = await talk(specialist.id, "open", 2);
    const closed = await talk(specialist.id, "closed", 5, { closed: true });
    await talk(colleague.id, "foreign", 4);

    const list = await api<{ items: CountedRow[] }>("/api/messages", specialist.token);
    const ids = list.body.items.map((t) => t.id);
    expect(ids).toContain(open.threadId);
    expect(ids).not.toContain(closed.threadId);
    expect((await api("/api/messages/unread-count", specialist.token)).body).toEqual({ unread: 2 });
    expect((await api("/api/messages/unread-count", colleague.token)).body).toEqual({ unread: 4 });
  });

  test("пациент: непрочитанное своего разговора; разговора нет — ноль, и он не заводится", async () => {
    const specialist = await makeUser("admin", `ms-uc-s-${crypto.randomUUID()}@test`);
    const lonely = await makeUser("user", `ms-uc-l-${crypto.randomUUID()}@test`, { leadSpecialistId: specialist.id });
    expect((await api("/api/messages/unread-count", lonely.token)).body).toEqual({ unread: 0 });
    expect(await db.select().from(threads).where(eq(threads.patientId, lonely.id)), "счётчик завёл разговор").toEqual([]);

    // у пациента непрочитанное — письма специалиста: в разговоре talk() одно такое
    const { patient } = await talk(specialist.id, "pt", 3);
    const list = await api<{ items: CountedRow[] }>("/api/messages", patient.token);
    expect(list.body.items[0]?.unread).toBe(1);
    expect((await api("/api/messages/unread-count", patient.token)).body).toEqual({ unread: 1 });

    const noLead = await makeUser("user", `ms-uc-n-${crypto.randomUUID()}@test`);
    expect((await api("/api/messages/unread-count", noLead.token)).body).toEqual({ unread: 0 });
  });

  test("список считает непрочитанное одним запросом: запросов к базе не больше с ростом числа разговоров", async () => {
    const few = await makeUser("admin", `ms-uc-f-${crypto.randomUUID()}@test`);
    const many = await makeUser("admin", `ms-uc-m-${crypto.randomUUID()}@test`);
    for (let i = 0; i < 2; i++) await talk(few.id, `few${i}`, 1);
    for (let i = 0; i < 22; i++) await talk(many.id, `many${i}`, 1);
    // первый запрос учётки может отметить вход — меряем со второго
    await api("/api/messages", few.token);
    await api("/api/messages", many.token);

    const listFew = await sqlOf("/api/messages", few.token);
    const listMany = await sqlOf("/api/messages", many.token);
    expect(listFew).toBeGreaterThan(0);
    // прежде — запрос счёта на каждую строку: на двадцать строк больше было бы +20
    expect(listMany - listFew, `запросов: ${listFew} на 2 разговора, ${listMany} на 22`).toBeLessThan(5);

    const countMany = await sqlOf("/api/messages/unread-count", many.token);
    expect(countMany, `счётчик: ${countMany}, список: ${listMany}`).toBeLessThan(listMany);
    expect((await api("/api/messages/unread-count", many.token)).body).toEqual({ unread: 22 });
  });

  test("счётчик в журнал не пишет — как не писал и список, который он заменил", async () => {
    const specialist = await makeUser("admin", `ms-uc-s-${crypto.randomUUID()}@test`);
    await talk(specialist.id, "audit", 2);
    const rows = async () =>
      (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.actorId, specialist.id)))[0]!.n;

    const start = await rows();
    await api("/api/messages", specialist.token);
    const afterList = await rows();
    for (let i = 0; i < 3; i++) await api("/api/messages/unread-count", specialist.token);
    const afterCount = await rows();
    expect(afterList - start, "список писал в журнал").toBe(0);
    expect(afterCount - afterList, "опрос счётчика пишет в журнал").toBe(0);
  });

  test("под боевой ролью число то же, что сумма по строкам списка", async () => {
    const specialist = await makeUser("admin", `ms-uc-r-${crypto.randomUUID()}@test`);
    for (const [i, n] of [2, 0, 1].entries()) await talk(specialist.id, `rls${i}`, n);
    const list = await appApi<{ items: CountedRow[] }>("/api/messages", specialist.token);
    const count = await appApi<{ unread: number }>("/api/messages/unread-count", specialist.token);
    expect(list.status).toBe(200);
    expect(count.status).toBe(200);
    expect(list.body.items.reduce((n, t) => n + t.unread, 0)).toBe(3);
    expect(count.body).toEqual({ unread: 3 });
  });
});
