import { describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { adminA, adminB, api, db, makeUser, submitSurvey, surveyInA } from "./fixtures";
import { baseDb } from "../src/db";
import { systemContext } from "../src/db/context";
import { securityJobs } from "../src/db/schema";
import { env } from "../src/env";
import { ensureSearchIndexCurrent } from "../src/lib/noteReindex";
import { fingerprint, indexOf, searchSecretMark, stems } from "../src/lib/searchIndex";

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

describe("секрет индекса — свой, и его смена не теряет поиск (внешний разбор, #25)", () => {
  async function noteFor(text: string) {
    const person = await makeUser("user", `search-rot-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);
    await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text, baseVersion: 0, kind: "session" }),
    });
    return person;
  }
  const finds = async (q: string, userId: string) => {
    const res = await api("/api/search/notes?q=" + encodeURIComponent(q), adminA.token);
    expect(res.status).toBe(200);
    return res.body.items.some((i: { userId: string }) => i.userId === userId);
  };
  const lastJob = async () =>
    (
      await db
        .select()
        .from(securityJobs)
        .where(eq(securityJobs.kind, "search_reindex"))
        .orderBy(desc(securityJobs.startedAt))
        .limit(1)
    )[0];

  test("отпечатки не зависят от JWT_SECRET", () => {
    /*
     * Ровно то, что ломалось: ротация секрета подписи — штатная реакция на
     * утечку токена — меняла отпечатки запросов, а индекс оставался прежним.
     */
    const before = fingerprint("тревож");
    const jwt = env.jwtSecret;
    env.jwtSecret = `rotated-${crypto.randomUUID()}`;
    try {
      expect(fingerprint("тревож")).toBe(before);
    } finally {
      env.jwtSecret = jwt;
    }
    const search = env.searchIndexSecret;
    env.searchIndexSecret = `rotated-${crypto.randomUUID()}`;
    try {
      expect(fingerprint("тревож"), "смена секрета индекса не меняет отпечатки — значит, он не используется").not.toBe(before);
    } finally {
      env.searchIndexSecret = search;
    }
  });

  test("смена SEARCH_INDEX_SECRET замечается при старте и индекс пересобирается с проверяемым итогом", async () => {
    const person = await noteFor("Отмечается ангедония и утрата интересов");
    expect(await finds("ангедония", person.id)).toBe(true);

    // индекс приводится к текущему секрету: журнал есть, отпечаток совпадает
    await systemContext(baseDb, () => db.delete(securityJobs).where(eq(securityJobs.kind, "search_reindex")));
    expect(await ensureSearchIndexCurrent()).toBe("reindexed");
    expect(await ensureSearchIndexCurrent()).toBe("current");

    const original = env.searchIndexSecret;
    env.searchIndexSecret = `rotated-${crypto.randomUUID()}`;
    try {
      // новый процесс с новым секретом: запрос считает другие отпечатки, индекс прежний
      expect(await finds("ангедония", person.id), "старый индекс нашёл запись новым секретом").toBe(false);

      // первый запуск с новым секретом — пересборка
      expect(await ensureSearchIndexCurrent()).toBe("reindexed");
      expect(await finds("ангедония", person.id), "после переиндексации запись не найдена").toBe(true);

      // итог проверяем по журналу: на каком секрете, сколько записей, чем закончилось
      const job = await lastJob();
      expect(job).toMatchObject({ status: "done", targetKey: searchSecretMark(), skipped: 0 });
      expect(job!.processed).toBeGreaterThanOrEqual(1);
      expect(job!.total).toBe(job!.processed);
      expect(job!.finishedAt).not.toBeNull();
      expect(await ensureSearchIndexCurrent()).toBe("current");
    } finally {
      env.searchIndexSecret = original;
      // вернуть индекс к секрету процесса — иначе соседние тесты искали бы по чужим отпечаткам
      await ensureSearchIndexCurrent();
    }
    expect(await finds("ангедония", person.id)).toBe(true);
  });
});
