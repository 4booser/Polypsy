import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { app, appApi, db, makeUser, root, type Person } from "./fixtures";
import { asAppRole } from "./appRole";
import { permissionExceptions } from "../src/db/schema";
import { publish } from "../src/lib/events";
import { eventStreamTiming } from "../src/routes/events";

/**
 * Открытый поток событий гаснет вместе с доступом (#140).
 *
 * requireAuth проверял токен только при открытии потока: выключили учётку,
 * завершили все её сессии, закончилась сессия «от имени», отняли
 * alerts.review — тот же токен на /me уже получал 401, а события о
 * пациентах зоны продолжали идти в открытую вкладку часами. Теперь пульс
 * перечитывает строку пользователя и право и закрывает поток.
 *
 * Поток — под ролью приложения: строка users читается системным контекстом,
 * право — в контексте строк сотрудника, и под владельцем базы политики
 * этого не проверили бы.
 */

const PULSE = 120;
let savedPulse = 0;

beforeAll(() => {
  savedPulse = eventStreamTiming.pulseMs;
  eventStreamTiming.pulseMs = PULSE;
});

afterAll(() => {
  eventStreamTiming.pulseMs = savedPulse;
});

async function openStream(token: string) {
  const res = await asAppRole(async () =>
    app.request("/api/events", { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } }),
  );
  expect(res.status).toBe(200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  let ended = false;
  const first = await reader.read();
  seen += first.value ?? "";
  expect(seen).toContain("ready");
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += value;
      }
      ended = true;
    } catch {
      /* поток закрыт отменой */
    }
  })();
  return {
    text: () => seen,
    pings: () => seen.split("event: ping").length - 1,
    ended: () => ended,
    close: async () => {
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

async function until(check: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

/** Системное событие: видно всем сотрудникам, зона на него не влияет */
function systemEvent(mark: string) {
  return publish(db, {
    kind: "action",
    action: "test.mark",
    surveyIds: null,
    userId: null,
    resourceId: mark,
    at: new Date().toISOString(),
  });
}

const post = (body?: unknown) => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/** Поток открыт и живой; после `revoke` он закрывается за пару пульсов, и событие после этого в него не уходит */
async function expectClosedBy(token: string, revoke: () => Promise<void>): Promise<void> {
  const stream = await openStream(token);
  const mark = crypto.randomUUID();
  try {
    await systemEvent(`before-${mark}`);
    expect(await until(() => stream.text().includes(`before-${mark}`)), "поток не доставил событие до отзыва").toBe(
      true,
    );

    await revoke();

    expect(await until(() => stream.ended(), PULSE * 20), "поток пережил отзыв доступа").toBe(true);
    await systemEvent(`after-${mark}`);
    await Bun.sleep(PULSE * 2);
    expect(stream.text().includes(`after-${mark}`), "событие ушло в поток после отзыва").toBe(false);
  } finally {
    await stream.close();
  }
}

async function freshStaff(tag: string): Promise<Person> {
  return makeUser("admin", `ev-${tag}-${crypto.randomUUID()}@test`);
}

describe("поток событий и отзыв доступа (#140)", () => {
  test(
    "без изменений поток живёт и пульсирует — контроль",
    async () => {
      const staff = await freshStaff("alive");
      const stream = await openStream(staff.token);
      const mark = crypto.randomUUID();
      try {
        expect(await until(() => stream.pings() >= 3), "поток перестал пульсировать").toBe(true);
        expect(stream.ended(), "поток закрылся без причины").toBe(false);
        await systemEvent(mark);
        expect(await until(() => stream.text().includes(mark)), "живой поток не доставил событие").toBe(true);
      } finally {
        await stream.close();
      }
    },
    15_000,
  );

  test(
    "«завершить все сессии» закрывает открытый поток",
    async () => {
      const staff = await freshStaff("sessions");
      await expectClosedBy(staff.token, async () => {
        const res = await appApi(`/api/ops/users/${staff.id}/revoke-sessions`, root.token, post());
        expect(res.status).toBe(200);
      });
    },
    15_000,
  );

  test(
    "выключение учётки закрывает открытый поток",
    async () => {
      const staff = await freshStaff("disable");
      await expectClosedBy(staff.token, async () => {
        const res = await appApi(`/api/ops/users/${staff.id}/disable`, root.token, post({ reason: "Перевірка потоку" }));
        expect(res.status).toBe(200);
      });
    },
    15_000,
  );

  test(
    "отнятое alerts.review закрывает открытый поток",
    async () => {
      const staff = await freshStaff("perm");
      await expectClosedBy(staff.token, async () => {
        await db.insert(permissionExceptions).values({
          id: crypto.randomUUID(),
          userId: staff.id,
          permission: "alerts.review",
          mode: "revoke",
          reason: "Перевірка потоку подій",
          grantedBy: root.id,
        });
      });
    },
    15_000,
  );

  test(
    "конец сессии «от имени» закрывает поток, открытый её токеном",
    async () => {
      const staff = await freshStaff("imp");
      const start = await appApi(`/api/ops/people/impersonate/${staff.id}`, root.token, post({ reason: "Перевірка потоку подій" }));
      expect(start.status).toBe(201);
      await expectClosedBy(start.body.token as string, async () => {
        const end = await appApi(`/api/ops/people/impersonate/${start.body.sessionId}/end`, root.token, post());
        expect(end.body.ended).toBe(true);
      });
    },
    15_000,
  );
});
