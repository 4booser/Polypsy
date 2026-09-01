import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, db, makeUser } from "./fixtures";
import { departments, scheduleTemplates, specialistProfiles } from "../src/db/schema";
import { syncSlots } from "../src/lib/schedule";

/**
 * Нагрузка на расписание.
 *
 * Отделение из десяти специалистов, принимающих пять дней в неделю по восемь
 * слотов, — это около двадцати тысяч слотов в год. Проверка не про «быстро
 * ли», а про то, что генерация остаётся идемпотентной и не становится
 * квадратичной: на сотне слотов лишний обход незаметен, а на двадцати тысячах
 * кладёт сервер, и обнаруживается это через полгода работы.
 */

async function specialistWithWeek(tag: string, hoursPerDay: number) {
  const departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення", ru: "Отделение" },
    timezone: "Europe/Kyiv",
  });
  const person = await makeUser("admin", `load-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId });

  for (const weekday of [1, 2, 3, 4, 5]) {
    await db.insert(scheduleTemplates).values({
      id: crypto.randomUUID(),
      specialistId: person.id,
      weekday,
      startsAt: "09:00",
      endsAt: `${String(9 + hoursPerDay).padStart(2, "0")}:00`,
      slotMinutes: 60,
      kind: "any",
      capacity: 1,
    });
  }
  return person.id;
}

async function slotCount(specialistId: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(
    `select count(*)::int as n from slots where specialist_id = '${specialistId}'`,
  );
  return Number(row?.n ?? 0);
}

describe("год расписания", () => {
  test(
    "генерируется и остаётся идемпотентной",
    async () => {
      const specialistId = await specialistWithWeek("year", 8);

      const first = await syncSlots(specialistId, 52);
      // пять дней в неделю по восемь слотов на год — около двух тысяч
      expect(first.added).toBeGreaterThan(1500);
      expect(await slotCount(specialistId)).toBe(first.added);

      /*
       * Повторный прогон на двух тысячах строк обязан не добавить ни одной.
       * Идемпотентность держится на уникальном индексе, а не на аккуратности
       * вызывающего, — и проверять её надо на объёме: на десяти слотах
       * дубликат можно не заметить.
       */
      const second = await syncSlots(specialistId, 52);
      expect(second.added).toBe(0);
      expect(second.removed).toBe(0);
      expect(await slotCount(specialistId)).toBe(first.added);
    },
    180_000,
  );

  test(
    "повторный прогон не дороже первого в разы",
    async () => {
      /*
       * Не «быстро», а «не квадратично»: если повторный прогон на готовой
       * сетке стоит заметно дороже первого, значит где-то обход по каждой
       * строке умножается на все остальные — и на пяти годах это перестанет
       * работать.
       */
      const specialistId = await specialistWithWeek("speed", 6);

      const t1 = Date.now();
      await syncSlots(specialistId, 26);
      const firstMs = Date.now() - t1;

      const t2 = Date.now();
      await syncSlots(specialistId, 26);
      const secondMs = Date.now() - t2;

      // порог грубый намеренно: ловим порядок величины, а не дрожание машины
      expect(secondMs).toBeLessThan(firstMs * 3 + 2000);
    },
    180_000,
  );

  test(
    "сужение расписания на годовой сетке снимает лишнее за один проход",
    async () => {
      const specialistId = await specialistWithWeek("shrink", 8);
      await syncSlots(specialistId, 52);

      await db
        .update(scheduleTemplates)
        .set({ endsAt: "11:00" })
        .where(eq(scheduleTemplates.specialistId, specialistId));

      const result = await syncSlots(specialistId, 52);
      expect(result.removed).toBeGreaterThan(1000);

      // осталось по два слота в день пять дней в неделю на год
      const left = await slotCount(specialistId);
      expect(left).toBeGreaterThan(400);
      expect(left).toBeLessThan(700);
    },
    180_000,
  );
});

describe("выдача свободного времени на годовой сетке", () => {
  test(
    "отвечает и не отдаёт больше своего потолка",
    async () => {
      /*
       * Потолок в две тысячи строк — это решение, а не случайность: пациенту
       * незачем листать год вперёд, он выбирает ближайшее. Но потолок обязан
       * быть виден в коде и проверен: молчаливое усечение выдачи выглядит как
       * «свободного времени нет», а это худшее, что может показать экран
       * записи.
       */
      const specialistId = await specialistWithWeek("free", 8);
      await syncSlots(specialistId, 52);

      const patient = await makeUser("user", `load-p-${crypto.randomUUID()}@test`);
      const t = Date.now();
      const res = await api(`/api/clinic/slots?specialistId=${specialistId}`, patient.token);
      const ms = Date.now() - t;

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(100);
      expect(res.body.items.length).toBeLessThanOrEqual(2000);
      // грубый порог: ловим порядок величины, а не дрожание машины
      expect(ms).toBeLessThan(5000);

      /*
       * Первым идёт ближайшее свободное время: список отсортирован по началу,
       * и человек выбирает из начала. Обратный порядок означал бы, что первое
       * предложенное — через год.
       */
      const first = new Date(res.body.items[0].startsAt).getTime();
      const second = new Date(res.body.items[1].startsAt).getTime();
      expect(first).toBeLessThan(second);
      expect(first).toBeGreaterThan(Date.now() - 60_000);
    },
    180_000,
  );
});
