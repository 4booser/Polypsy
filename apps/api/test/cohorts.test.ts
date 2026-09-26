import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, adminB, api, db, eq, makeUser, root, sql, submitSurvey, surveyInA, surveyInB, users } from "./fixtures";

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

  test("порог берётся из общего места, а не назначается экраном", async () => {
    /*
     * Раньше здесь сверялись два экрана между собой: подбор людей и отчёт
     * подразделения. Отчёт убран, но проверка не потеряла смысла —
     * сверяться надо было не с соседним экраном, а с источником: два числа
     * в разных файлах однажды разойдутся, и разойдутся молча.
     */
    const { SMALL_CELL_FLOOR } = await import("../src/lib/privacy");
    const cohort = await preview({});
    expect(cohort.body.smallCellFloor).toBe(SMALL_CELL_FLOOR);
  });
});

describe("порог действует на обоих маршрутах", () => {
  /*
   * Предпросмотр прятал размер когорты из трёх человек, а поимённый список с
   * тем же самым правилом отбора отдавал этих троих по фамилиям. Подавление
   * в предпросмотре при этом не защищало ничего — имена брались следующим
   * запросом с того же экрана, — но создавало впечатление, что порог
   * действует, и вопрос считался закрытым.
   */
  test("малая когорта не отдаёт имён", async () => {
    const spec = { units: [unit], sex: "female" };

    const small = await preview(spec);
    expect(small.body.size).toBeNull();

    const named = await api("/api/cohorts/members", adminA.token, {
      method: "POST",
      body: JSON.stringify(spec),
    });
    expect(named.status).toBe(200);
    expect(named.body.items).toEqual([]);
    // пустой список и «ниже порога» — разные ответы, и различать их обязан клиент
    expect(named.body.suppressed).toBe(true);
    expect(named.body.smallCellFloor).toBe(FLOOR);
  });

  test("когорта от порога и выше имена отдаёт", async () => {
    // обратная проверка: «не отдаёт» ничего не значит, если не отдаёт никогда
    const named = await api("/api/cohorts/members", adminA.token, {
      method: "POST",
      body: JSON.stringify({ units: [unit] }),
    });
    expect(named.body.suppressed).toBe(false);
    expect(named.body.items.length).toBeGreaterThanOrEqual(FLOOR);
  });

  test("отказанная попытка видна в журнале", async () => {
    /*
     * Подбор параметров, пока когорта не сожмётся до одного человека, — это
     * то, что разбирают по журналу. Отказ, которого в журнале нет, разбору
     * не поддаётся.
     */
    const { auditLog } = await import("../src/db/schema");
    const { sql } = await import("drizzle-orm");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'cohort.members' and ${auditLog.details}->>'reason' = 'small_cell'`)
      .limit(1);
    expect(entry?.outcome).toBe("denied");
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

  test("як і назва населеного пункту", async () => {
    const odd = await preview({ localities: ["Село 'Б'; --"] });
    expect(odd.status).toBe(200);
    expect(odd.body.size).toBe(0);
  });
});

/* ─────────── волна 9: адекватные фильтры подбора ─────────── */

/**
 * Шестеро с датой рождения ровно «тридцать лет и десять дней назад», пятеро
 * из них в одном населённом пункте, один — в другом. Своё подразделение,
 * чтобы соседние проверки не зависели от того, кто ещё успел сдать методику.
 */
let aged: string;
const KYIV = `Київ-${crypto.randomUUID().slice(0, 6)}`;
const LVIV = `Львів-${crypto.randomUUID().slice(0, 6)}`;

beforeAll(async () => {
  aged = `Рота-В-${crypto.randomUUID().slice(0, 6)}`;
  const born = new Date();
  born.setUTCFullYear(born.getUTCFullYear() - 30);
  born.setUTCDate(born.getUTCDate() - 10);
  const birthDate = born.toISOString().slice(0, 10);
  for (let i = 0; i < 6; i++) {
    const person = await makeUser("user", `cohort-aged-${crypto.randomUUID()}@test`, {
      birthDate,
      sex: "male",
      unit: aged,
      locality: i === 5 ? LVIV : KYIV,
    });
    await submitSurvey(surveyInA, person.token);
  }
});

describe("населений пункт", () => {
  test("кілька пунктів і без урахування регістру", async () => {
    const both = await preview({ units: [aged], localities: [KYIV.toUpperCase(), LVIV.toLowerCase()] });
    expect(both.body.size).toBe(6);
    const one = await preview({ units: [aged], localities: [KYIV] });
    expect(one.body.size).toBe(5);
  });

  /*
   * Мутация: вернуть в разбивках `suppress` по одной ячейке — «Київ: 5» при
   * «у вибірці 6» называет единственного во Львове вычитанием, и проверка
   * падает на показанном Киеве.
   */
  test("одна прихована клітинка не відновлюється відніманням від розміру", async () => {
    const res = await preview({ units: [aged] });
    expect(res.body.size).toBe(6);
    const cells = res.body.byLocality as { key: string; count: number | null }[];
    expect(cells.map((c) => c.key).sort()).toEqual([KYIV, LVIV].sort());
    for (const cell of cells) expect(cell.count, `${cell.key} показано`).toBeNull();
  });

  test("підбір знає пункти й підрозділи лише своєї зони", async () => {
    const mine = await api("/api/cohorts/options", adminA.token);
    expect(mine.status).toBe(200);
    expect(mine.body.units).toContain(aged);
    expect(mine.body.localities).toContain(KYIV);

    const foreign = await api("/api/cohorts/options", adminB.token);
    expect(foreign.body.units).not.toContain(aged);
    expect(foreign.body.localities).not.toContain(KYIV);
  });
});

describe("вік — повних років на момент проходження", () => {
  /*
   * Мутация: вернуть перевод возраста в полосы снимка — «від 25 до 29»
   * отвечает всей полосой «25–34», то есть шестью тридцатилетними, и
   * проверка падает на них.
   */
  test("діапазон рахується роками, а не віковою смугою", async () => {
    expect((await preview({ units: [aged], ageMin: 30, ageMax: 30 })).body.size).toBe(6);
    expect((await preview({ units: [aged], ageMin: 25, ageMax: 29 })).body.size).toBe(0);
    expect((await preview({ units: [aged], ageMin: 31 })).body.size).toBe(0);
    expect((await preview({ units: [aged], ageMax: 30 })).body.size).toBe(6);
  });

  test("перевернутий діапазон — помилка набору, а не порожня когорта", async () => {
    const res = await preview({ units: [aged], ageMin: 40, ageMax: 30 });
    expect(res.status).toBe(400);
  });
});

describe("період проходження", () => {
  test("кінець періоду — увесь день включно", async () => {
    const [row] = await db.execute<{ today: string; yesterday: string }>(
      sql`select current_date::text as today, (current_date - 1)::text as yesterday`,
    );
    /* мутация: сравнивать `submitted_at <= to` — сданное сегодня после полуночи выпадает */
    expect((await preview({ units: [aged], from: row!.today, to: row!.today })).body.size).toBe(6);
    expect((await preview({ units: [aged], to: row!.yesterday })).body.size).toBe(0);
  });

  test("дата — лише РРРР-ММ-ДД, початок не пізніше кінця", async () => {
    expect((await preview({ from: "вчора" })).status).toBe(400);
    expect((await preview({ from: "2026-09-30", to: "2026-09-01" })).status).toBe(400);
  });
});

describe("вираженість", () => {
  /*
   * Мутация: считать человека в каждой ступени, где у него есть хоть одна
   * шкала (как было), — у шестерых с одинаковыми ответами ступеней
   * становится несколько, и строки перестают складываться в когорту.
   */
  test("кожна людина — в одній ступені, найтяжчій", async () => {
    const res = await preview({ units: [aged] });
    const cells = res.body.bySeverity as { key: string; count: number | null }[];
    expect(cells).toHaveLength(1);
    expect(cells[0]!.count).toBe(6);
  });

  test("«не нижче» відбирає ту саму ступінь і відсікає вищу", async () => {
    const order = ["none", "mild", "moderate", "severe"];
    const res = await preview({ units: [aged] });
    const top = (res.body.bySeverity as { key: string }[])[0]!.key;
    const at = order.indexOf(top);
    expect(at, `ступінь «${top}»`).toBeGreaterThanOrEqual(0);
    if (at >= 1) expect((await preview({ units: [aged], minSeverity: top })).body.size).toBe(6);
    if (at < 3) expect((await preview({ units: [aged], minSeverity: order[at + 1] })).body.size).toBe(0);
  });
});

describe("поіменний список", () => {
  test("рядок несе пошту, рік і останнє проходження вибірки", async () => {
    const named = await api("/api/cohorts/members", adminA.token, {
      method: "POST",
      body: JSON.stringify({ units: [aged] }),
    });
    expect(named.body.suppressed).toBe(false);
    expect(named.body.truncated).toBe(false);
    expect(named.body.items).toHaveLength(6);
    const first = named.body.items[0];
    expect(first.email).toContain("@test");
    expect(first.birthYear).toBeGreaterThan(1900);
    expect(first.locality === KYIV || first.locality === LVIV).toBe(true);
    expect(first.last.surveyId).toBe(surveyInA);
    expect(typeof first.last.submittedAt).toBe("string");
    // телефона в подборе нет: см. CohortMember
    expect("phone" in first).toBe(false);
  });
});

describe("збережені: перейменування", () => {
  test("своя — перейменовується, правило замінюється цілком", async () => {
    const saved = await api("/api/cohorts", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Стара назва", spec: { units: [aged], sex: "male" } }),
    });
    const renamed = await api(`/api/cohorts/${saved.body.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Нова назва", spec: { units: [aged] } }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe("Нова назва");
    // слитое правило вернуло бы снятый пол
    expect(renamed.body.spec).toEqual({ units: [aged] });
  });

  test("чужа — «не знайдено»", async () => {
    const saved = await api("/api/cohorts", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Моя", spec: {} }),
    });
    const theirs = await api(`/api/cohorts/${saved.body.id}`, adminB.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Чужа" }),
    });
    expect(theirs.status).toBe(404);
  });
});
