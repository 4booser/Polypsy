import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, adminB, api, db, eq, makeUser, root, submitSurvey, surveyInA, surveyInB, users } from "./fixtures";

/**
 * Конструктор когорт.
 *
 * Проверяются два обязательства, ради которых он написан именно так:
 * когорта не выходит за зону ответственности, и малые ячейки подавляются так
 * же, как в отчётах. Остальное — удобство.
 */

const FLOOR = 5;
let unit: string;

beforeAll(async () => {
  /*
   * Подразделение с шестью людьми: на единицу больше порога подавления, чтобы
   * различать «когорта мала» и «когорта пуста».
   */
  unit = `Рота-К-${crypto.randomUUID().slice(0, 6)}`;
  for (let i = 0; i < 6; i++) {
    const person = await makeUser("user", `cohort-${crypto.randomUUID()}@test`);
    await db.update(users).set({ unit, sex: i % 2 === 0 ? "male" : "female" }).where(eq(users.id, person.id));
    await submitSurvey(surveyInA, person.token);
  }
});

const preview = (spec: object, token = adminA.token) =>
  api("/api/cohorts/preview", token, { method: "POST", body: JSON.stringify(spec) });

describe("отбор", () => {
  test("подразделение сужает выборку", async () => {
    /*
     * Сравнивается с заведомо своими людьми, а не с «всеми в базе»: сколько
     * там всех, зависит от того, какие тесты успели отработать раньше, и
     * такое сравнение проверяло бы порядок запуска, а не отбор.
     */
    const outside = await makeUser("user", `cohort-out-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, outside.token);

    const all = await preview({});
    const mine = await preview({ units: [unit] });

    expect(mine.body.size).toBe(6);
    expect(all.body.size).toBeGreaterThanOrEqual(7);

    const named = await api("/api/cohorts/members", adminA.token, {
      method: "POST",
      body: JSON.stringify({ units: [unit] }),
    });
    expect(named.body.items.some((p: { userId: string }) => p.userId === outside.id)).toBe(false);
  });

  test("пол сужает дальше", async () => {
    const men = await preview({ units: [unit], sex: "male" });
    // трое мужчин — ниже порога, число не показывается
    expect(men.body.size).toBeNull();
  });

  test("несуществующее подразделение даёт честный ноль", async () => {
    /*
     * Ноль показывается, а не прячется: «никого нет» не выдаёт никого, а
     * спрятанный ноль заставляет думать, что там кто-то есть.
     */
    const none = await preview({ units: ["Такой роты нет"] });
    expect(none.body.size).toBe(0);
  });
});

describe("подавление малых ячеек", () => {
  test("у малой когорты разбивки не показываются вовсе", async () => {
    /*
     * В когорте из трёх человек строка «мужчин: 1» указывает на конкретного —
     * ровно так же, как в отчёте по роте.
     */
    const small = await preview({ units: [unit], sex: "female" });
    expect(small.body.breakdownAllowed).toBe(false);
    expect(small.body.bySex).toEqual([]);
    expect(small.body.byUnit).toEqual([]);
  });

  test("у достаточной когорты разбивки есть, но мелкие ячейки скрыты", async () => {
    const enough = await preview({ units: [unit] });
    expect(enough.body.breakdownAllowed).toBe(true);
    expect(enough.body.smallCellFloor).toBe(FLOOR);

    // внутри шести человек по полу — по трое, то есть ниже порога
    for (const cell of enough.body.bySex) {
      expect(cell.count === null || cell.count >= FLOOR).toBe(true);
    }
  });

  test("порог тот же, что в отчёте по подразделению", async () => {
    // два числа в разных файлах однажды разойдутся, и разойдутся молча
    const cohort = await preview({});
    const report = await api(`/api/unit-report?unit=${encodeURIComponent(unit)}`, adminA.token);
    expect(cohort.body.smallCellFloor).toBe(report.body.smallCellFloor);
  });
});

describe("зона ответственности", () => {
  test("чужой админ той же когорты не видит", async () => {
    const foreign = await preview({ units: [unit] }, adminB.token);
    expect(foreign.body.size).toBe(0);
  });

  test("методика вне зоны — отказ, а не пустая когорта", async () => {
    /*
     * Пустой ответ читался бы как «таких нет», хотя правильный ответ
     * «вам не видно».
     */
    const denied = await preview({ surveyId: surveyInB }, adminA.token);
    expect(denied.status).toBe(400);
  });

  test("поимённый список не выходит за зону", async () => {
    const mine = await api("/api/cohorts/members", adminA.token, {
      method: "POST",
      body: JSON.stringify({ units: [unit] }),
    });
    expect(mine.body.items).toHaveLength(6);

    const foreign = await api("/api/cohorts/members", adminB.token, {
      method: "POST",
      body: JSON.stringify({ units: [unit] }),
    });
    expect(foreign.body.items).toEqual([]);
  });
});

describe("сохранённые когорты", () => {
  test("хранится правило, а не список людей", async () => {
    /*
     * «Мужчины 20–30 с низким ЛАП» через месяц — это другие люди. Список
     * отвечал бы на вопрос «кто подходил в день сохранения», который никто не
     * задаёт.
     */
    const saved = await api("/api/cohorts", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Проба", spec: { units: [unit], sex: "male" } }),
    });
    expect(saved.status).toBe(201);

    const list = await api("/api/cohorts", adminA.token);
    const found = list.body.items.find((c: { id: string }) => c.id === saved.body.id);
    expect(found.spec).toEqual({ units: [unit], sex: "male" });
  });

  test("чужие когорты не видны и не удаляются", async () => {
    const saved = await api("/api/cohorts", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Только моя", spec: {} }),
    });

    const theirs = await api("/api/cohorts", adminB.token);
    expect(theirs.body.items.some((c: { id: string }) => c.id === saved.body.id)).toBe(false);

    const drop = await api(`/api/cohorts/${saved.body.id}`, adminB.token, { method: "DELETE" });
    expect(drop.status).toBe(404);
  });
});

describe("название подразделения с кавычкой", () => {
  test("не ломает запрос", async () => {
    /*
     * Подразделения называют как угодно. Значения уходят параметрами, и это
     * проверяется, а не подразумевается: собранный строкой запрос падал бы
     * здесь пятисоткой, а в худшем случае выполнил бы чужой текст.
     */
    const odd = await preview({ units: ["Рота 'А'; drop table users --"] });
    expect(odd.status).toBe(200);
    expect(odd.body.size).toBe(0);

    // и таблица на месте
    const still = await api("/api/cohorts/preview", root.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(still.body.size).toBeGreaterThan(0);
  });
});
