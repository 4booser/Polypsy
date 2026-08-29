import { describe, expect, test } from "bun:test";
import { adminA, adminB, api, makeUser, submitSurvey, surveyInA } from "./fixtures";
import { fingerprint, indexOf, stems } from "../src/lib/searchIndex";

/**
 * Поиск по зашифрованным записям.
 *
 * Проверяется и правило нормализации, и то, ради чего слепой индекс вообще
 * существует: искать можно, а восстановить текст из индекса — нельзя.
 */

describe("основы слов", () => {
  test("формы одного слова дают одну основу", () => {
    /*
     * Морфологии здесь нет намеренно: украинский стеммер в PostgreSQL не
     * встроен, а свой — отдельная работа со своими ошибками. Обрезание до
     * основы грубее, зато правило видно целиком и предсказуемо.
     */
    expect(stems("тревожность")).toEqual(stems("тревожности"));
    expect(stems("тривожність")).toEqual(stems("тривожністю"));
  });

  test("разные слова остаются разными", () => {
    expect(stems("тревога")).not.toEqual(stems("сонливость"));
  });

  test("«ё» и «е» — одно слово", () => {
    // одно и то же слово пишут и так, и так
    expect(stems("ещё")).toEqual(stems("еще"));
  });

  test("предлоги и союзы выброшены", () => {
    // они есть в каждой записи и только раздувают индекс
    expect(stems("не спит и не ест")).toEqual(stems("спит ест"));
  });

  test("знаки препинания не склеивают слова", () => {
    expect(stems("сон: прерывистый, тревожный")).toHaveLength(3);
  });

  test("повторы считаются один раз", () => {
    expect(stems("тревога тревога тревога")).toHaveLength(1);
  });
});

describe("отпечатки", () => {
  test("одинаковые основы дают одинаковые отпечатки", () => {
    expect(fingerprint("тревож")).toBe(fingerprint("тревож"));
  });

  test("текст из отпечатка не восстанавливается", () => {
    /*
     * Ровно то, ради чего индекс слепой: в базе лежит не слово, а его
     * отпечаток, и в нём нет ни исходных букв, ни их длины.
     */
    const fp = fingerprint("суицидальн");
    expect(fp).not.toContain("суиц");
    expect(fp.length).toBe(22);
  });

  test("индекс не хранит порядок слов", () => {
    // порядок восстановил бы фразы; индекс отвечает только «встречается ли»
    expect(indexOf("сон тревога").sort()).toEqual(indexOf("тревога сон").sort());
  });
});

describe("поиск", () => {
  async function noteFor(text: string) {
    const person = await makeUser("user", `search-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text, baseVersion: 0, kind: "session" }),
    });
    return person;
  }

  test("находит по форме слова, отличной от записанной", async () => {
    const person = await noteFor("Жалуется на тревожность по вечерам, сон прерывистый");

    const found = await api("/api/search/notes?q=тревожности", adminA.token);
    expect(found.status).toBe(200);
    expect(found.body.items.some((i: { userId: string }) => i.userId === person.id)).toBe(true);
  });

  test("все слова запроса обязаны встретиться", async () => {
    /*
     * «Или» здесь было бы почти бесполезно: запрос из двух слов выдавал бы
     * всё, где есть хоть одно.
     */
    const person = await noteFor("Сон нормальный, аппетит сохранён");

    const both = await api("/api/search/notes?q=сон тревожность", adminA.token);
    expect(both.body.items.some((i: { userId: string }) => i.userId === person.id)).toBe(false);

    const one = await api("/api/search/notes?q=аппетит сохранён", adminA.token);
    expect(one.body.items.some((i: { userId: string }) => i.userId === person.id)).toBe(true);
  });

  test("отрывок показывает место совпадения, а не всю запись", async () => {
    const long = `${"Вводная часть. ".repeat(20)}Отмечается выраженная раздражительность. ${"Заключение. ".repeat(20)}`;
    const person = await noteFor(long);

    const found = await api("/api/search/notes?q=раздражительность", adminA.token);
    const mine = found.body.items.find((i: { userId: string }) => i.userId === person.id);
    expect(mine.excerpt.length).toBeLessThan(long.length);
    expect(mine.excerpt).toContain("раздражительн");
  });

  test("чужой админ чужих записей не находит", async () => {
    const person = await noteFor("Уникальнейшее слово фазаньев");

    const foreign = await api("/api/search/notes?q=фазаньев", adminB.token);
    expect(foreign.body.items.some((i: { userId: string }) => i.userId === person.id)).toBe(false);
  });

  test("правка записи убирает её из поиска по старым словам", async () => {
    /*
     * Индекс переписывается целиком: дописывать новые отпечатки, не убирая
     * старые, значит находить запись по словам, которых в ней уже нет.
     */
    const person = await noteFor("Первоначальная формулировка сновидение");
    await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Переписано полностью бодрствование", baseVersion: 1, kind: "session" }),
    });

    const stale = await api("/api/search/notes?q=сновидение", adminA.token);
    expect(stale.body.items.some((i: { userId: string }) => i.userId === person.id)).toBe(false);

    const fresh = await api("/api/search/notes?q=бодрствование", adminA.token);
    expect(fresh.body.items.some((i: { userId: string }) => i.userId === person.id)).toBe(true);
  });

  test("запрос из одних предлогов — честный отказ", async () => {
    // «ничего не найдено» означало бы «в записях нет слова “на”», что неправда
    const empty = await api("/api/search/notes?q=на и в", adminA.token);
    expect(empty.status).toBe(400);
  });
});
