import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { serverText } from "@quizzy/shared";
import { client, db, eq, groupAdmins, makeUser, root, submitSurvey, surveyGroups, surveyInA, surveys, users } from "./fixtures";
import { alertNotifications, responses, riskAlerts } from "../src/db/schema";
import { runNotifierOnce, setTransportForTests, STAFF_OUTBOUND_LANG } from "../src/lib/notify";
import { registerDevice, setPushSenderForTests } from "../src/lib/push";

/**
 * Доставка уведомлений о тревогах: что считается «дошло», и сколько раз
 * одно уведомление может уйти.
 *
 * Своя методика со своим названием и своим админом группы: письма
 * рассыльщика не несут номера тревоги, и отличить свои письма от писем по
 * тревогам соседних файлов можно только по названию методики в теме и по
 * адресату. Тревоги соседей перед началом помечаются разосланными — так
 * же, как это делает alerts.test.ts, — чтобы проход рассыльщика был о
 * наших тревогах, а не о случайном хвосте базы.
 */

interface Mail {
  to: string;
  subject: string;
}

const tag = crypto.randomUUID().slice(0, 8);
const title = `Методика доставки ${tag}`;
const groupId = crypto.randomUUID();
const surveyId = crypto.randomUUID();
let admin: { id: string; token: string };
let adminEmail: string;
let responseId: string;
const mine: string[] = [];

/** Транспорт, который собирает письма; hold — задержать отправку конкретного письма */
function capture(hold?: (mail: Mail) => Promise<void> | undefined) {
  const sent: Mail[] = [];
  const transport = {
    sendMail: async (mail: { to: string; subject: string }) => {
      const m = { to: String(mail.to), subject: String(mail.subject) };
      sent.push(m);
      await hold?.(m);
      return { messageId: crypto.randomUUID() };
    },
  };
  setTransportForTests(transport as never);
  return {
    sent,
    /** Только письма по нашей методике */
    ours: () => sent.filter((m) => m.subject.includes(title)),
  };
}

async function alert(minutesAgo = 0): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(riskAlerts).values({
    id,
    responseId,
    surveyId,
    label: "Тестова тривога",
    severity: "severe",
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  mine.push(id);
  return id;
}

async function journal(alertId: string, kind = "initial") {
  const [row] = await client`select * from alert_deliveries where alert_id = ${alertId} and kind = ${kind}`;
  return row as Record<string, unknown> | undefined;
}

async function notified(alertId: string) {
  return db.select().from(alertNotifications).where(eq(alertNotifications.alertId, alertId));
}

/**
 * Закрыть свои тревоги: подтверждённая тревога не повторяется рассыльщиком.
 * Каждый тест закрывает свои сам — иначе следующий получал бы в проходе и
 * чужие письма по той же методике.
 */
async function closeAlerts(ids: string[]) {
  await db
    .update(riskAlerts)
    .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: root.id })
    .where(inArray(riskAlerts.id, ids));
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

beforeAll(async () => {
  adminEmail = `delivery-${tag}@test`;
  admin = await makeUser("admin", adminEmail);
  await db.insert(surveyGroups).values({ id: groupId, title: `Група доставки ${tag}`, createdBy: root.id });
  await db.insert(groupAdmins).values({ groupId, userId: admin.id, addedBy: root.id });
  await db.insert(surveys).values({
    id: surveyId,
    groupId,
    title: { uk: title, ru: title, en: title },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "restricted",
    createdBy: admin.id,
  } as never);

  // прохождение нужно только ради ссылки тревоги на него
  const person = await makeUser("user", `delivery-p-${tag}@test`);
  await submitSurvey(surveyInA, person.token);
  const [response] = await db.select({ id: responses.id }).from(responses).where(eq(responses.userId, person.id));
  responseId = response!.id;

  // хвост тревог соседних файлов — «уже разослан», как в alerts.test.ts
  const pending = await db.select({ id: riskAlerts.id }).from(riskAlerts);
  if (pending.length) {
    await db
      .insert(alertNotifications)
      .values(
        pending.flatMap((a) =>
          (["initial", "escalation"] as const).map((kind) => ({
            id: crypto.randomUUID(),
            alertId: a.id,
            kind,
            recipients: "",
            channel: "none" as const,
          })),
        ),
      )
      .onConflictDoNothing();
  }
}, 30_000);

afterAll(async () => {
  setTransportForTests(null);
  setPushSenderForTests(null);
  if (mine.length) await closeAlerts(mine);
});

describe("что считается «дошло»", () => {
  test("тревога, о которой не узнал никто, не числится разосланной и уходит, когда почта появилась", async () => {
    /*
     * SMTP не настроен (или слать некому), пуша у дежурного нет. Прежде
     * рассыльщик всё равно писал «initial» с каналом none — и после того, как
     * почту настроили, первичное уведомление по этой тревоге не уходило уже
     * никогда: она числилась разосланной.
     */
    setTransportForTests(null);
    const id = await alert();

    await runNotifierOnce();
    expect(await notified(id), "недоставленное записано как разосланное").toHaveLength(0);
    expect(await journal(id)).toMatchObject({ state: "undelivered", email: "none", pushed: 0 });

    // почту настроили — следующий же проход догоняет
    const mail = capture();
    const pass = await runNotifierOnce();
    expect(pass.initial).toBeGreaterThanOrEqual(1);
    expect(mail.ours()).toHaveLength(1);
    expect(mail.ours()[0]!.to).toContain(adminEmail);
    const [row] = await notified(id);
    expect(row).toMatchObject({ kind: "initial", channel: "email" });
    expect(await journal(id)).toMatchObject({ state: "delivered", email: "sent", attempts: 2, mails: 1 });

    // и больше не повторяет
    await runNotifierOnce();
    expect(mail.ours()).toHaveLength(1);
    await closeAlerts([id]);
  });

  test("пуш без почты — тоже доставка", async () => {
    setTransportForTests(null);
    await registerDevice(admin.id, `ExponentPushToken[${crypto.randomUUID()}]`, "ios", "uk");
    const pushed: string[] = [];
    setPushSenderForTests(async (messages) => {
      for (const m of messages) pushed.push(m.to);
    });
    const id = await alert();

    await runNotifierOnce();
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    const [row] = await notified(id);
    expect(row, "пуш дошёл, а тревога числится недоставленной").toMatchObject({ channel: "push" });
    expect(await journal(id)).toMatchObject({ state: "delivered", email: "none", pushed: 1 });

    setPushSenderForTests(null);
    await client`delete from push_tokens where user_id = ${admin.id}`;
    await closeAlerts([id]);
  });

  test("подтверждённую тревогу рассыльщик задним числом не догоняет", async () => {
    /*
     * Почту чинили неделю; за это время тревогу разобрали в консоли.
     * Письмо «откройте консоль» по разобранной тревоге — шум, а шум приучает
     * не читать тревоги. В журнале она остаётся недоставленной — это правда.
     */
    setTransportForTests(null);
    const id = await alert();
    await runNotifierOnce();
    await closeAlerts([id]);

    const mail = capture();
    await runNotifierOnce();
    expect(mail.ours()).toHaveLength(0);
    expect(await journal(id)).toMatchObject({ state: "undelivered" });
  });

  test("эскалация без почты тоже не считается разосланной", async () => {
    await db.update(surveys).set({ alertEscalateMinutes: 30 }).where(eq(surveys.id, surveyId));
    try {
      setTransportForTests(null);
      const id = await alert(40);
      await runNotifierOnce();
      expect(await notified(id)).toHaveLength(0);
      expect(await journal(id, "escalation")).toMatchObject({ state: "undelivered" });

      const mail = capture();
      await runNotifierOnce();
      // тема — из словаря на языке отделения (волна 14); прежде — русское «ЭСКАЛАЦИЯ», набранное в notify.ts
      const escalation = serverText("mail.escalation.subject", STAFF_OUTBOUND_LANG).split("{")[0]!;
      expect(mail.ours().filter((m) => m.subject.startsWith(escalation))).toHaveLength(1);
      expect((await notified(id)).map((n) => n.kind).sort()).toEqual(["escalation", "initial"]);
      await closeAlerts([id]);
    } finally {
      await db.update(surveys).set({ alertEscalateMinutes: null }).where(eq(surveys.id, surveyId));
    }
  });
});

describe("заблокированный сотрудник тревог не получает (внешний разбор, #16)", () => {
  test("единственный админ группы заблокирован — письмо и пуш уходят активному суперадмину, а не ему", async () => {
    /*
     * Блокировка отзывает сессии, но членство в группе и токены устройств
     * остаются. Прежде отбор получателей шёл по group_admins без disabled_at:
     * письмо и пуш уходили заблокированному, доставка числилась выполненной,
     * а действующий суперадмин не узнавал о тревоге вовсе.
     */
    const t2 = crypto.randomUUID().slice(0, 8);
    const title2 = `Методика блокировки ${t2}`;
    const group2 = crypto.randomUUID();
    const survey2 = crypto.randomUUID();
    const blockedEmail = `blocked-${t2}@test`;
    const blocked = await makeUser("admin", blockedEmail);
    const blockedToken = `ExponentPushToken[${crypto.randomUUID()}]`;
    await registerDevice(blocked.id, blockedToken, "ios", "uk");
    const supEmail = `sup-${t2}@test`;
    const sup = await makeUser("superadmin", supEmail);
    const supToken = `ExponentPushToken[${crypto.randomUUID()}]`;
    await registerDevice(sup.id, supToken, "android", "uk");
    // выключенный суперадмин — тоже не адресат, ни письма, ни эскалации
    const deadSupEmail = `deadsup-${t2}@test`;
    const deadSup = await makeUser("superadmin", deadSupEmail);
    await db.update(users).set({ disabledAt: new Date().toISOString() }).where(inArray(users.id, [blocked.id, deadSup.id]));

    await db.insert(surveyGroups).values({ id: group2, title: `Група ${t2}`, createdBy: root.id });
    await db.insert(groupAdmins).values({ groupId: group2, userId: blocked.id, addedBy: root.id });
    await db.insert(surveys).values({
      id: survey2,
      groupId: group2,
      title: { uk: title2, ru: title2, en: title2 },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "restricted",
      createdBy: root.id,
      alertEscalateMinutes: 30,
    } as never);

    const pushed: string[] = [];
    setPushSenderForTests(async (messages) => {
      for (const m of messages) pushed.push(m.to);
    });
    const mail = capture();
    const id = crypto.randomUUID();
    await db.insert(riskAlerts).values({
      id,
      responseId,
      surveyId: survey2,
      label: "Тестова тривога",
      severity: "severe",
      // давнее — чтобы в том же проходе ушла и эскалация
      at: new Date(Date.now() - 40 * 60_000).toISOString(),
    });
    mine.push(id);
    try {
      await runNotifierOnce();
      const letters = mail.sent.filter((m) => m.subject.includes(title2));
      expect(letters.length, "письма по тревоге нет").toBeGreaterThanOrEqual(1);
      for (const m of letters) {
        expect(m.to, "письмо ушло заблокированному").not.toContain(blockedEmail);
        expect(m.to, "письмо ушло выключенному суперадмину").not.toContain(deadSupEmail);
        expect(m.to, "резервный активный адресат не выбран").toContain(supEmail);
      }
      expect(pushed, "пуш ушёл заблокированному").not.toContain(blockedToken);
      expect(pushed, "пуш не ушёл резервному адресату").toContain(supToken);
      const [row] = await notified(id);
      expect(row?.recipients ?? "").not.toContain(blockedEmail);
      expect(await journal(id)).toMatchObject({ state: "delivered" });
    } finally {
      setPushSenderForTests(null);
      await client`delete from push_tokens where user_id in (${blocked.id}, ${sup.id})`;
      await closeAlerts([id]);
    }
  });
});

describe("сколько раз уходит одно уведомление", () => {
  test("два рассыльщика одновременно — одно письмо", async () => {
    /*
     * Два процесса API на время выкатки, у каждого свой минутный тик. Прежде
     * оба видели тревогу без отметки (отметка первого ещё не закоммичена —
     * весь проход шёл одной транзакцией) и оба отправляли. Первое письмо
     * задерживается, пока второй проход не закончится: так проходы
     * гарантированно перекрываются, а не расходятся по времени случайно.
     */
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mail = capture((m) => (m.subject.includes(title) && mail.ours().length === 1 ? gate : undefined));
    const id = await alert();

    const first = runNotifierOnce();
    expect(await until(() => mail.ours().length === 1), "первый проход не дошёл до отправки").toBe(true);
    let secondDone = false;
    const second = runNotifierOnce().finally(() => {
      secondDone = true;
    });
    // второй проход либо закончится сам (исправно), либо отправит второе письмо (дефект)
    await until(() => secondDone || mail.ours().length > 1);
    release();
    await Promise.all([first, second]);

    expect(mail.ours(), "одна тревога — два письма").toHaveLength(1);
    expect(await notified(id)).toHaveLength(1);
    expect(await journal(id)).toMatchObject({ state: "delivered", mails: 1 });
    await closeAlerts([id]);
  });

  test("процесс упал после отправки: письмо повторяется, но не бесконечно", async () => {
    /*
     * «Упал после отправки» ставится так: почтовый сервер письмо принял, а
     * проход дальше не идёт — отправка не возвращается. Для базы это то же,
     * что процесс, убитый в эту секунду: захват остался, отметки нет. Срок
     * захвата тест отматывает сам, а не ждёт десять минут.
     *
     * Решение — «хотя бы один раз», с потолком. Для клинической тревоги
     * пропущенное уведомление дороже лишнего: дежурный, не узнавший о
     * суицидальном риске, — это и есть отказ, ради которого рассыльщик
     * существует. Но письмо, приходящее каждую минуту, приучает тревоги не
     * читать, поэтому после трёх отправок без подтверждения рассыльщик
     * останавливается и оставляет след (abandoned, журнал, лог).
     */
    const hung: ((error: Error) => void)[] = [];
    const mail = capture((m) =>
      m.subject.includes(title)
        ? new Promise<void>((_, reject) => {
            hung.push(reject);
          })
        : undefined,
    );
    const id = await alert();
    const expire = () => client`update alert_deliveries set lease_until = now() - interval '1 minute' where alert_id = ${id}`;

    try {
      for (let crash = 1; crash <= 3; crash++) {
        void runNotifierOnce();
        expect(await until(() => mail.ours().length === crash), `отправка №${crash} не состоялась`).toBe(true);
        // пока захват жив, другой проход письмо не повторяет
        await runNotifierOnce();
        expect(mail.ours()).toHaveLength(crash);
        await expire();
      }

      // три письма ушли, подтверждения нет — четвёртого не будет
      await runNotifierOnce();
      await runNotifierOnce();
      expect(mail.ours(), "повтор после сбоя не ограничен").toHaveLength(3);
      expect(await journal(id)).toMatchObject({ state: "abandoned", mails: 3 });
      expect(await notified(id)).toHaveLength(0);
    } finally {
      for (const reject of hung) reject(new Error("проход прерван тестом"));
      await closeAlerts([id]);
    }
  });

  test("один сбой после отправки — один повтор, и дальше тишина", async () => {
    const hung: ((error: Error) => void)[] = [];
    let crashed = false;
    const mail = capture((m) => {
      if (!m.subject.includes(title) || crashed) return undefined;
      crashed = true;
      return new Promise<void>((_, reject) => {
        hung.push(reject);
      });
    });
    const id = await alert();
    try {
      void runNotifierOnce();
      expect(await until(() => mail.ours().length === 1)).toBe(true);
      await client`update alert_deliveries set lease_until = now() - interval '1 minute' where alert_id = ${id}`;

      await runNotifierOnce();
      expect(mail.ours()).toHaveLength(2);
      expect(await journal(id)).toMatchObject({ state: "delivered", mails: 2, attempts: 2 });

      await runNotifierOnce();
      expect(mail.ours()).toHaveLength(2);
    } finally {
      for (const reject of hung) reject(new Error("проход прерван тестом"));
      await closeAlerts([id]);
    }
  });
});
