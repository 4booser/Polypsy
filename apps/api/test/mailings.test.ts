import { afterAll, describe, expect, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  adminA,
  adminB,
  api,
  db,
  makeUser,
  root,
  surveyInA,
  type Person,
} from "./fixtures";
import { auditLog, mailingRecipients, mailings, pushTokens, surveyAccess } from "../src/db/schema";
import { pushMailings } from "../src/lib/mailingPush";
import { setPushSenderForTests } from "../src/lib/push";
import { ROUTE_DOCS } from "../src/lib/openapi";

/**
 * Рассылки — сообщение «одному многим» с вариантами ответа (кадры f09/f16/f22).
 *
 * Проверяется не «работает ли кнопка», а то, что ломается молча: кто видит
 * чужую рассылку, кому она уходит при отправке, что текст после отправки
 * неизменен, что ответ один, и что политики строк на месте.
 *
 * Каждая защита проверена мутацией — снималась, и тест обязан был упасть,
 * назвав виновника. Тестовый пользователь базы обходит RLS, поэтому
 * разграничение проверяется через API от лица разных людей, а политики —
 * текстом из pg_policies и прямым вызовом предикатов.
 */

afterAll(() => setPushSenderForTests(null));

/** Пациент в зоне adminA — штатным путём, назначением методики группы А */
async function patientOfA(tag: string): Promise<Person> {
  const person = await makeUser("user", `ml-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
  return person;
}

async function makeGroup(owner: Person, title: string, members: Person[] = []): Promise<string> {
  const res = await api("/api/patient-groups", owner.token, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  expect(res.status, `заведение группы «${title}»`).toBe(201);
  if (members.length) {
    const added = await api(`/api/patient-groups/${res.body.id}/members`, owner.token, {
      method: "POST",
      body: JSON.stringify({ userIds: members.map((m) => m.id) }),
    });
    expect(added.status, "состав группы").toBe(201);
  }
  return res.body.id as string;
}

async function draft(
  author: Person,
  input: Record<string, unknown> = {},
): Promise<{ id: string; title: string }> {
  const res = await api("/api/mailings", author.token, {
    method: "POST",
    body: JSON.stringify({
      title: `Тема ${crypto.randomUUID().slice(0, 8)}`,
      body: "Перші рядки тексту повідомлення. Далі — довгий текст.",
      options: ["Так", "Ні"],
      ...input,
    }),
  });
  expect(res.status, `черновик: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body;
}

async function send(author: Person, id: string) {
  return api(`/api/mailings/${id}/send`, author.token, { method: "POST", body: "{}" });
}

const titlesOf = (body: { items: { title: string }[] }) => body.items.map((m) => m.title);

describe("черновик живёт у автора", () => {
  test("заводится и возвращается с расшифрованными темой и текстом", async () => {
    const created = await draft(adminA, { title: "Анкета настрою", body: "Чи готові пройти?" });
    expect(created.title).toBe("Анкета настрою");

    const card = await api(`/api/mailings/${created.id}`, adminA.token);
    expect(card.status).toBe(200);
    expect(card.body.status).toBe("draft");
    expect(card.body.body).toBe("Чи готові пройти?");
    expect(card.body.options).toEqual(["Так", "Ні"]);
    // у черновика получателей нет: адресаты до отправки — намерение, не факт
    expect(card.body.recipients).toBeNull();
    expect(card.body.counts).toBeNull();

    // а в базе — шифртекст, не тема открытым текстом
    const [row] = await db.select().from(mailings).where(eq(mailings.id, created.id));
    expect(row!.titleEnc).not.toBe("Анкета настрою");
    expect(row!.bodyEnc).not.toContain("готові");
  });

  /**
   * Главная проверка области видимости.
   *
   * Чужая рассылка не в списке, не открывается, не правится, не отправляется
   * и не удаляется — и отвечает «не найдено», а не «нельзя»: 403 подтвердил
   * бы, что коллега такую рассылку завёл.
   *
   * Мутация: убрать условие по автору из запроса списка
   * (`eq(mailings.authorId, user.id)`) и проверку автора из
   * `assertMailingAccess` в lib/scope.ts — падают все пять проверок ниже,
   * каждая называет свой маршрут.
   */
  test("чужая рассылка не видна, не открывается, не правится, не отправляется", async () => {
    const own = await draft(adminA, { title: "Тільки моя" });

    const list = await api("/api/mailings", adminB.token);
    expect(titlesOf(list.body), "GET /api/mailings отдал чужому специалисту рассылку adminA").not.toContain(
      "Тільки моя",
    );

    const card = await api(`/api/mailings/${own.id}`, adminB.token);
    expect(card.status, `GET /api/mailings/:id открыл чужую рассылку ${own.id}`).toBe(404);

    const patched = await api(`/api/mailings/${own.id}`, adminB.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Захоплено" }),
    });
    expect(patched.status, `PATCH /api/mailings/:id правит чужую рассылку ${own.id}`).toBe(404);

    const sent = await send(adminB, own.id);
    expect(sent.status, `POST /api/mailings/:id/send отправил чужую рассылку ${own.id}`).toBe(404);

    const deleted = await api(`/api/mailings/${own.id}`, adminB.token, { method: "DELETE" });
    expect(deleted.status, `DELETE /api/mailings/:id удалил чужую рассылку ${own.id}`).toBe(404);
  });

  test("суперадмин видит рассылки сотрудников", async () => {
    const own = await draft(adminA, { title: `Під наглядом ${crypto.randomUUID().slice(0, 6)}` });
    const list = await api("/api/mailings?limit=200", root.token);
    expect(titlesOf(list.body)).toContain(own.title);
  });

  test("пациенту раздел автора закрыт", async () => {
    const person = await patientOfA("no-staff");
    const res = await api("/api/mailings", person.token);
    expect(res.status).toBe(403);
  });

  /**
   * Мутация: снять `assertAddressees` из POST / — три проверки ниже падают
   * и называют чужого пациента, чужую группу и сотрудника в адресатах.
   */
  test("адресат вне зоны, чужая группа и сотрудник в адресатах — отказ", async () => {
    const stranger = await makeUser("user", `ml-stranger-${crypto.randomUUID()}@test`);
    const byId = await api("/api/mailings", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Чужий", body: "…", patientIds: [stranger.id] }),
    });
    expect(byId.status, `в адресаты попал пациент вне зоны: ${stranger.id}`).toBe(404);

    const foreignGroup = await makeGroup(adminB, "Група Б");
    const byGroup = await api("/api/mailings", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Чужа група", body: "…", patientGroupId: foreignGroup }),
    });
    expect(byGroup.status, `в адресаты попала чужая группа ${foreignGroup}`).toBe(404);

    // у суперадмина зона не ограничена — до проверки роли адресата дело доходит
    const toStaff = await api("/api/mailings", root.token, {
      method: "POST",
      body: JSON.stringify({ title: "Колезі", body: "…", patientIds: [adminB.id] }),
    });
    expect(toStaff.status, `сотрудник ${adminB.id} принят как адресат рассылки`).toBe(400);
  });
});

describe("отправка", () => {
  /**
   * Адресаты разворачиваются по группе И списку, без дублей, только из
   * нынешней зоны. Мутация: снять фильтр по `visible` в `expandRecipients` —
   * проверка падает и называет выбывшего, которому рассылка доехала.
   */
  test("группа и список сливаются, выбывший из зоны не получает", async () => {
    const inGroup = await patientOfA("g1");
    const both = await patientOfA("g2");
    const byList = await patientOfA("l1");
    const left = await patientOfA("left");
    const groupId = await makeGroup(adminA, "Розсилка", [inGroup, both, left]);
    // единственное основание видеть этого человека исчезает
    await db.delete(surveyAccess).where(and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, left.id)));

    const m = await draft(adminA, { patientGroupId: groupId, patientIds: [both.id, byList.id] });
    const res = await send(adminA, m.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.recipients, "адресаты по группе и списку не слились без дублей").toBe(3);

    const rows = await db.select().from(mailingRecipients).where(eq(mailingRecipients.mailingId, m.id));
    const ids = rows.map((r) => r.userId).sort();
    expect(ids).toEqual([inGroup.id, both.id, byList.id].sort());
    expect(ids, `рассылка доехала до выбывшего из зоны: ${left.id}`).not.toContain(left.id);

    // в журнале — сводка с числом адресатов и поимённые строки
    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, m.id), eq(auditLog.actorId, adminA.id)));
    const summary = entries.find((e) => e.action === "mailing.send");
    expect((summary?.details as { recipients?: number })?.recipients).toBe(3);
    expect(entries.filter((e) => e.action === "mailing.deliver").map((e) => e.subjectUserId).sort()).toEqual(
      ids,
    );
  });

  test("без единого адресата в зоне — отказ, а не тихий успех", async () => {
    const empty = await makeGroup(adminA, "Порожня");
    const m = await draft(adminA, { patientGroupId: empty });
    const res = await send(adminA, m.id);
    expect(res.status).toBe(400);
    const [row] = await db.select().from(mailings).where(eq(mailings.id, m.id));
    expect(row!.status).toBe("draft");
  });

  /**
   * Главное правило рассылки: после отправки текст и варианты не меняются —
   * получатели отвечали на конкретный текст.
   *
   * Мутация: убрать `if (row.status === "sent") conflict(...)` и условие
   * `eq(mailings.status, "draft")` из PATCH — проверка падает и называет
   * рассылку, у которой тема сменилась после отправки.
   */
  test("после отправки текст, варианты и адресаты не меняются", async () => {
    const person = await patientOfA("frozen");
    const m = await draft(adminA, { title: "До відправки", body: "Текст до", patientIds: [person.id] });
    expect((await send(adminA, m.id)).status).toBe(200);

    const patched = await api(`/api/mailings/${m.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Після відправки", body: "Текст після", options: ["Можливо"] }),
    });
    expect(patched.status, `PATCH изменил отправленную рассылку ${m.id}`).toBe(409);

    const card = await api(`/api/mailings/${m.id}`, adminA.token);
    expect(card.body.title, `тема рассылки ${m.id} сменилась после отправки`).toBe("До відправки");
    expect(card.body.body).toBe("Текст до");
    expect(card.body.options).toEqual(["Так", "Ні"]);

    // и второй раз не отправляется: получатели получили бы дубль
    expect((await send(adminA, m.id)).status).toBe(409);
    const rows = await db.select().from(mailingRecipients).where(eq(mailingRecipients.mailingId, m.id));
    expect(rows).toHaveLength(1);
  });

  /**
   * Отправленную не удалить — только скрыть. Мутация: снять проверку
   * статуса из DELETE — проверка падает и называет рассылку, исчезнувшую
   * вместе с ответами получателей.
   */
  test("отправленную не удалить, но можно скрыть и вернуть; черновик удаляется", async () => {
    const person = await patientOfA("hide");
    const m = await draft(adminA, { title: "Приховати", patientIds: [person.id] });
    await send(adminA, m.id);

    const deleted = await api(`/api/mailings/${m.id}`, adminA.token, { method: "DELETE" });
    expect(deleted.status, `отправленная рассылка ${m.id} удалена`).toBe(409);
    expect(await db.select().from(mailings).where(eq(mailings.id, m.id))).toHaveLength(1);

    const hidden = await api(`/api/mailings/${m.id}/hide`, adminA.token, { method: "POST", body: "{}" });
    expect(hidden.status).toBe(200);
    expect(hidden.body.hiddenAt).toBeTruthy();
    expect(titlesOf((await api("/api/mailings?limit=200", adminA.token)).body)).not.toContain("Приховати");
    expect(titlesOf((await api("/api/mailings?hidden=1&limit=200", adminA.token)).body)).toContain("Приховати");

    // у получателя скрытая автором рассылка остаётся: скрытие — про экран автора
    const inbox = await api("/api/mailings/inbox", person.token);
    expect(inbox.body.items.map((i: { id: string }) => i.id)).toContain(m.id);

    const back = await api(`/api/mailings/${m.id}/unhide`, adminA.token, { method: "POST", body: "{}" });
    expect(back.body.hiddenAt).toBeNull();
    expect(titlesOf((await api("/api/mailings?limit=200", adminA.token)).body)).toContain("Приховати");

    const d = await draft(adminA, { title: "Чернетка геть" });
    expect((await api(`/api/mailings/${d.id}`, adminA.token, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(mailings).where(eq(mailings.id, d.id))).toHaveLength(0);
  });
});

describe("получатель", () => {
  test("видит отправленную в inbox с непрочитанным, черновик — нет; чужая — не найдено", async () => {
    const me = await patientOfA("inbox");
    const other = await patientOfA("inbox-other");
    const sentToMe = await draft(adminA, { title: "Для мене", patientIds: [me.id] });
    await send(adminA, sentToMe.id);
    const stillDraft = await draft(adminA, { title: "Ще чернетка", patientIds: [me.id] });
    const sentToOther = await draft(adminA, { title: "Не мені", patientIds: [other.id] });
    await send(adminA, sentToOther.id);

    const inbox = await api("/api/mailings/inbox", me.token);
    expect(inbox.status).toBe(200);
    const titles = inbox.body.items.map((i: { title: string }) => i.title);
    expect(titles).toContain("Для мене");
    expect(titles, `получателю виден черновик ${stillDraft.id}`).not.toContain("Ще чернетка");
    expect(titles, `получателю видна чужая рассылка ${sentToOther.id}`).not.toContain("Не мені");
    expect(inbox.body.unread).toBeGreaterThanOrEqual(1);
    const mine = inbox.body.items.find((i: { id: string }) => i.id === sentToMe.id);
    expect(mine.readAt).toBeNull();
    expect(mine.answer).toBeNull();
    expect(mine.options).toEqual(["Так", "Ні"]);
    expect(mine.authorName).toBeTruthy();

    // чужая и черновик — «не найдено», а не «нельзя»
    for (const id of [stillDraft.id, sentToOther.id]) {
      const read = await api(`/api/mailings/${id}/read`, me.token, { method: "POST", body: "{}" });
      expect(read.status, `получатель отметил прочитанной не свою рассылку ${id}`).toBe(404);
      const answer = await api(`/api/mailings/${id}/answer`, me.token, {
        method: "POST",
        body: JSON.stringify({ answer: 0 }),
      });
      expect(answer.status, `получатель ответил на не свою рассылку ${id}`).toBe(404);
    }
  });

  test("прочитано при открытии; повтор отметку не сдвигает", async () => {
    const me = await patientOfA("read");
    const m = await draft(adminA, { patientIds: [me.id] });
    await send(adminA, m.id);

    const first = await api(`/api/mailings/${m.id}/read`, me.token, { method: "POST", body: "{}" });
    expect(first.status).toBe(200);
    expect(first.body.readAt).toBeTruthy();
    const again = await api(`/api/mailings/${m.id}/read`, me.token, { method: "POST", body: "{}" });
    expect(again.body.readAt).toBe(first.body.readAt);

    const inbox = await api("/api/mailings/inbox", me.token);
    expect(inbox.body.unread).toBe(0);
  });

  /**
   * Ответ — один раз. Мутация: снять `if (r.answer !== null) conflict(...)`
   * и `isNull(mailingRecipients.answer)` из UPDATE — проверка падает и
   * называет получателя, чей ответ переписался.
   */
  test("отвечает один раз, только существующим вариантом; счётчики у автора", async () => {
    const yes = await patientOfA("yes");
    const no = await patientOfA("no");
    const silent = await patientOfA("silent");
    const m = await draft(adminA, { options: ["Так", "Ні", "Пізніше"], patientIds: [yes.id, no.id, silent.id] });
    await send(adminA, m.id);

    const bad = await api(`/api/mailings/${m.id}/answer`, yes.token, {
      method: "POST",
      body: JSON.stringify({ answer: 3 }),
    });
    expect(bad.status).toBe(400);

    const first = await api(`/api/mailings/${m.id}/answer`, yes.token, {
      method: "POST",
      body: JSON.stringify({ answer: 0 }),
    });
    expect(first.status).toBe(200);
    expect(first.body.answer).toBe(0);
    expect(first.body.answeredAt).toBeTruthy();

    const twice = await api(`/api/mailings/${m.id}/answer`, yes.token, {
      method: "POST",
      body: JSON.stringify({ answer: 1 }),
    });
    expect(twice.status, `получатель ${yes.id} ответил дважды`).toBe(409);
    const [row] = await db
      .select()
      .from(mailingRecipients)
      .where(and(eq(mailingRecipients.mailingId, m.id), eq(mailingRecipients.userId, yes.id)));
    expect(row!.answer, `ответ получателя ${yes.id} переписан вторым нажатием`).toBe(0);
    // ответ означает и «видел»
    expect(row!.readAt).toBeTruthy();

    await api(`/api/mailings/${m.id}/answer`, no.token, { method: "POST", body: JSON.stringify({ answer: 1 }) });

    const card = await api(`/api/mailings/${m.id}`, adminA.token);
    expect(card.body.counts).toEqual({ recipients: 3, read: 2, answered: 2 });
    expect(card.body.answers).toEqual([
      { index: 0, text: "Так", count: 1 },
      { index: 1, text: "Ні", count: 1 },
      { index: 2, text: "Пізніше", count: 0 },
    ]);
    const byUser = new Map(
      (card.body.recipients as { userId: string; answer: number | null; fullName: string }[]).map((r) => [r.userId, r]),
    );
    expect(byUser.get(yes.id)?.answer).toBe(0);
    expect(byUser.get(no.id)?.answer).toBe(1);
    expect(byUser.get(silent.id)?.answer).toBeNull();
    expect(byUser.get(yes.id)?.fullName).toBeTruthy();
  });

  test("на рассылку без вариантов отвечать нечем", async () => {
    const me = await patientOfA("notice");
    const m = await draft(adminA, { options: [], patientIds: [me.id] });
    await send(adminA, m.id);
    const res = await api(`/api/mailings/${m.id}/answer`, me.token, {
      method: "POST",
      body: JSON.stringify({ answer: 0 }),
    });
    expect(res.status).toBe(400);
  });

  /**
   * Имена в карточке — только из нынешней зоны читателя, счётчики — по всем.
   * Мутация: снять фильтр по `visible` в GET /:id — проверка падает и
   * называет выбывшего, чьё имя осталось в списке.
   */
  test("выбывший из зоны исчезает из списка получателей, но не из счётчиков", async () => {
    const stays = await patientOfA("stays");
    const leaves = await patientOfA("leaves");
    const m = await draft(adminA, { patientIds: [stays.id, leaves.id] });
    await send(adminA, m.id);
    await api(`/api/mailings/${m.id}/answer`, leaves.token, { method: "POST", body: JSON.stringify({ answer: 0 }) });
    await db.delete(surveyAccess).where(and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, leaves.id)));

    const card = await api(`/api/mailings/${m.id}`, adminA.token);
    const ids = (card.body.recipients as { userId: string }[]).map((r) => r.userId);
    expect(ids).toEqual([stays.id]);
    expect(ids, `в получателях остался человек вне зоны: ${leaves.id}`).not.toContain(leaves.id);
    expect(card.body.counts.recipients).toBe(2);
    expect(card.body.answers[0].count).toBe(1);
  });
});

describe("список автора: порядок, страницы, поиск", () => {
  test("свежие сверху, страницы с total, поиск по теме и тексту", async () => {
    const author = await makeUser("admin", `ml-author-${crypto.randomUUID()}@test`);
    const older = await draft(author, { title: "Перша", body: "перший текст про сон" });
    const middle = await draft(author, { title: "Друга", body: "другий текст про настрій" });
    const newest = await draft(author, { title: "Третя", body: "третій текст" });
    // порядок — по последней правке: у черновика дата строки — updatedAt
    const stamp = (id: string, minutesAgo: number) =>
      db
        .update(mailings)
        .set({ updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
        .where(eq(mailings.id, id));
    await stamp(older.id, 30);
    await stamp(middle.id, 20);
    await stamp(newest.id, 10);

    const page1 = await api("/api/mailings?limit=2&offset=0", author.token);
    expect(page1.body.total).toBe(3);
    expect(titlesOf(page1.body)).toEqual(["Третя", "Друга"]);
    expect(page1.body.items[0].preview).toBe("третій текст");
    expect(page1.body.items[0].status).toBe("draft");

    const page2 = await api("/api/mailings?limit=2&offset=2", author.token);
    expect(titlesOf(page2.body)).toEqual(["Перша"]);

    const bySubject = await api("/api/mailings?q=друга", author.token);
    expect(titlesOf(bySubject.body)).toEqual(["Друга"]);
    const byBody = await api("/api/mailings?q=про%20сон", author.token);
    expect(titlesOf(byBody.body)).toEqual(["Перша"]);
    expect(byBody.body.total).toBe(1);
  });

  test("у отправленной строка датируется отправкой и считает адресатов", async () => {
    const author = await makeUser("admin", `ml-sent-${crypto.randomUUID()}@test`);
    // адресаты — из зоны автора; у нового сотрудника зона пуста, даём ему группу А
    const { groupAdmins } = await import("../src/db/schema");
    const { groupA } = await import("./fixtures");
    await db.insert(groupAdmins).values({ groupId: groupA, userId: author.id, addedBy: root.id });
    const one = await patientOfA("row-1");
    const two = await patientOfA("row-2");
    const m = await draft(author, { patientIds: [one.id, two.id] });
    await send(author, m.id);
    await api(`/api/mailings/${m.id}/answer`, one.token, { method: "POST", body: JSON.stringify({ answer: 1 }) });

    const list = await api("/api/mailings", author.token);
    const row = list.body.items.find((i: { id: string }) => i.id === m.id);
    expect(row.status).toBe("sent");
    expect(row.sentAt).toBeTruthy();
    expect(row.at).toBe(row.sentAt);
    expect(row.recipientCount).toBe(2);
    expect(row.answeredCount).toBe(1);
  });
});

describe("пуш о рассылке", () => {
  test("уходит получателю с устройством один раз, без темы и текста", async () => {
    const withDevice = await patientOfA("push");
    const noDevice = await patientOfA("push-none");
    await db.insert(pushTokens).values({
      id: crypto.randomUUID(),
      userId: withDevice.id,
      token: `ExponentPushToken[${crypto.randomUUID()}]`,
      platform: "ios",
    } as never);
    const m = await draft(adminA, { title: "Група ризику: анкета", patientIds: [withDevice.id, noDevice.id] });
    await send(adminA, m.id);

    const sentMessages: { title: string; body: string }[] = [];
    setPushSenderForTests(async (messages) => {
      for (const msg of messages) sentMessages.push({ title: msg.title, body: msg.body });
    });

    const first = await pushMailings();
    expect(first).toBeGreaterThanOrEqual(1);
    const ours = sentMessages.filter((s) => s.title === "Нове повідомлення");
    expect(ours.length).toBeGreaterThanOrEqual(1);
    // экран блокировки видят посторонние: ни темы, ни текста
    for (const s of sentMessages) {
      expect(s.title).not.toContain("Група ризику");
      expect(s.body).not.toContain("анкета");
    }

    // второй тик никого не тревожит: ключ события — рассылка и человек
    sentMessages.length = 0;
    await pushMailings();
    expect(sentMessages).toHaveLength(0);
  });
});

describe("страховочная сетка под рассылками", () => {
  const TABLES = ["mailings", "mailing_recipients"];

  test("на новых таблицах есть политики и они включены", async () => {
    /*
     * Мутация: удалить любой блок CREATE POLICY или ENABLE ROW LEVEL SECURITY
     * из миграции 0083_mailings.sql — проверка называет таблицу.
     */
    const rows = await db.execute<{ relname: string; relrowsecurity: boolean; n: number }>(sql`
      select c.relname, c.relrowsecurity,
             (select count(*)::int from pg_policies p where p.tablename = c.relname) as n
        from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname in ('mailings', 'mailing_recipients')
    `);
    const byName = new Map([...rows].map((r) => [String(r.relname), r]));
    for (const table of TABLES) {
      expect(byName.get(table)?.relrowsecurity, `RLS выключен на ${table}`).toBe(true);
      expect(Number(byName.get(table)?.n ?? 0), `на ${table} нет ни одной политики`).toBeGreaterThan(0);
    }
  });

  test("получатель читает только отправленную и адресованную ему; пишет только персонал", async () => {
    /*
     * Условия читаются из текста политик: половину можно потерять правкой,
     * и покрытие этого не заметит. Мутация: убрать `status = 'sent'` из
     * mailings_read — падает первая проверка; убрать WITH CHECK по автору
     * из mailings_write — вторая.
     */
    const rows = await db.execute<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }>(sql`
      select policyname, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = 'mailings'
    `);
    const all = [...rows];
    const read = all.find((r) => String(r.policyname) === "mailings_read");
    expect(read, "нет политики чтения mailings_read").toBeTruthy();
    expect(String(read!.qual)).toContain("rls_mailing_addressed_to_me");
    expect(String(read!.qual)).toContain("'sent'");

    const write = all.find((r) => String(r.policyname) === "mailings_write");
    expect(write, "нет политики записи mailings_write").toBeTruthy();
    expect(String(write!.with_check)).toContain("author_id");
    expect(String(write!.with_check)).toContain("app_uid");
    // у получателя на mailings нет ни INSERT, ни UPDATE: ни одна политика не пускает роль user на запись
    expect(String(write!.with_check)).not.toContain("'user'");
  });

  test("свою строку доставки получатель правит, чужую — нет, заводить не может", async () => {
    const rows = await db.execute<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }>(sql`
      select policyname, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = 'mailing_recipients'
    `);
    const all = [...rows];
    const names = all.map((r) => String(r.policyname)).sort();
    expect(names).toEqual(["mailing_recipients_self_read", "mailing_recipients_self_update", "mailing_recipients_staff"]);

    const staff = all.find((r) => String(r.policyname) === "mailing_recipients_staff")!;
    expect(String(staff.qual)).toContain("rls_authored_mailing");
    expect(String(staff.with_check)).toContain("rls_authored_mailing");

    const selfUpdate = all.find((r) => String(r.policyname) === "mailing_recipients_self_update")!;
    expect(String(selfUpdate.cmd)).toBe("UPDATE");
    expect(String(selfUpdate.qual)).toContain("user_id");
    // WITH CHECK на своей строке: без него пациент переписал бы user_id и «ответил» за другого
    expect(String(selfUpdate.with_check)).toContain("user_id");
    expect(String(selfUpdate.with_check)).toContain("app_uid");
    // INSERT получателю не разрешён ни одной политикой
    expect(all.some((r) => String(r.cmd) === "INSERT" && String(r.with_check ?? "").includes("'user'"))).toBe(false);
  });

  /**
   * Предикаты политик — спрошенные у базы напрямую: тесты ходят владельцем,
   * который политики обходит, и проверить их поведением нельзя (см.
   * patientGroups.test.ts). Мутация: расширить `rls_authored_mailing` до
   * «любой admin» — падает проверка постороннего сотрудника.
   */
  test("предикаты отвечают «да» автору и адресату, «нет» посторонним", async () => {
    const me = await patientOfA("pred");
    const other = await patientOfA("pred-other");
    const m = await draft(adminA, { patientIds: [me.id] });
    await send(adminA, m.id);

    const { baseDb } = await import("../src/db");
    const { withDbContext } = await import("../src/db/context");
    const askAs = (userId: string, role: "admin" | "user") =>
      withDbContext(baseDb, { userId, role }, async () => {
        const rows = await db.execute<{ authored: boolean; addressed: boolean }>(sql`
          select rls_authored_mailing(${m.id}) as authored,
                 rls_mailing_addressed_to_me(${m.id}) as addressed
        `);
        return [...rows][0]!;
      });

    expect((await askAs(adminA.id, "admin")).authored, "автор не признан автором").toBe(true);
    expect((await askAs(adminB.id, "admin")).authored, `предикат признал автором постороннего ${adminB.id}`).toBe(false);
    expect((await askAs(me.id, "user")).addressed, "адресат не признан адресатом").toBe(true);
    expect((await askAs(other.id, "user")).addressed, `предикат признал адресатом постороннего ${other.id}`).toBe(false);
  });

  test("право mailings.manage выдано ролям-шаблонам специалиста, заведующего и главного врача", async () => {
    const { rolePermissions } = await import("../src/db/schema");
    const rows = await db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .where(eq(rolePermissions.permission, "mailings.manage"));
    const roles = rows.map((r) => r.roleId);
    for (const id of ["role-specialist", "role-head", "role-chief"]) {
      expect(roles, `у роли ${id} нет mailings.manage`).toContain(id);
    }
  });
});

describe("описание маршрутов", () => {
  test("все маршруты рассылок объявлены: авторские — под правом, получательские — с причиной", () => {
    const keys = Object.keys(ROUTE_DOCS).filter((k) => k.includes("/api/mailings"));
    expect(keys.length).toBe(11);
    for (const key of keys) {
      const doc = ROUTE_DOCS[key]!;
      if (doc.access === "staff") {
        expect(doc.permission, `${key} без права`).toBe("mailings.manage");
      } else {
        expect(doc.access, key).toBe("user");
        expect((doc.whyNoPermission ?? "").length, `${key} без причины`).toBeGreaterThan(40);
      }
    }
  });

  test("последняя запись журнала об отправке — сводкой, с числом адресатов", async () => {
    const person = await patientOfA("journal");
    const m = await draft(adminA, { patientIds: [person.id] });
    await send(adminA, m.id);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "mailing.send"), eq(auditLog.resourceId, m.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(entry!.actorId).toBe(adminA.id);
    expect((entry!.details as { recipients: number }).recipients).toBe(1);
  });
});
