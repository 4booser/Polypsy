import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { adminA, appApi, db, makeUser, surveyInA, type Person } from "./fixtures";
import { mailingRecipients, mailings, referrals, safetyPlans, surveyAccess } from "../src/db/schema";

/**
 * Переходы состояния под настоящей гонкой (волна 15, участок transitions).
 *
 * Общая причина трёх находок внешнего разбора — проверка «из какого
 * состояния можно» отделена от записи. Обработчик читает строку, решает по
 * прочитанному и пишет по одному идентификатору; всё, что другой запрос
 * успел сделать между чтением и записью, либо молча затирается (направление
 * из «відхилено» становилось «прийнято»), либо смешивается с решением,
 * принятым до него (рассылка уходила прежним адресатам с новым текстом),
 * либо роняет запрос пятисоткой на уникальном индексе (план безопасности).
 *
 * Последовательные запросы этого не ловят, поэтому здесь приём ревьюера:
 * строку держит блокировкой ОТДЕЛЬНОЕ соединение (владельцем — ему
 * политики строк ни к чему), проверяемые запросы запускаются по одному и
 * каждый дожидается, пока встанет в очередь за замком, — порядок в очереди
 * и есть порядок, в котором они потом пройдут. Когда стоят все, строка
 * отпускается.
 *
 * Сами запросы — под ролью приложения (appApi): так их видит бой, с
 * политиками строк. Каждая проверка падала на прежнем коде.
 */

/** Отдельное соединение — им «держат строку», как служебной транзакцией у ревьюера */
const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

/**
 * Сколько запросов к этой базе сейчас стоят в очереди за замком (строки или
 * консультативным) — из тех, чей текст касается проверяемого.
 *
 * Фрагменты, а не одно имя таблицы: до правки и после неё запрос встаёт в
 * очередь разными операторами (UPDATE прежде, SELECT … FOR UPDATE или
 * консультативная блокировка теперь), и проверка должна ловить оба —
 * иначе на прежнем коде она падала бы не на гонке, а на ожидании.
 */
async function lockWaiters(fragments: string[]): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
      and query ilike any (array[${sql.join(
        fragments.map((f) => sql`${`%${f}%`}`),
        sql`, `,
      )}]::text[])
  `);
  return Number(row?.n ?? 0);
}

/**
 * Дождаться, пока в очереди окажется n запросов.
 *
 * По факту, а не по таймеру: «подождать сто миллисекунд» на загруженной
 * машине проверяло бы скорость диска, а не гонку.
 */
async function untilWaiting(n: number, fragments: string[], timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await lockWaiters(fragments)) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`в очереди за замком меньше ${n} запросов — гонка не воспроизведена`);
}

/**
 * Держать строку, пока все действия не встанут за ней в очередь, и отпустить.
 *
 * Действия запускаются по одному: второе стартует, когда первое уже ждёт, —
 * иначе порядок их прохода был бы случайным и проверка — тоже.
 */
async function whileHeld<T>(
  hold: (tx: postgres.TransactionSql) => Promise<unknown>,
  actions: (() => Promise<T>)[],
  waitsOn: string[],
): Promise<T[]> {
  const pending: Promise<T>[] = [];
  await holder.begin(async (tx) => {
    await hold(tx);
    for (const [i, start] of actions.entries()) {
      const p = start();
      // проигравший не должен упасть раньше, чем его дождутся
      p.catch(() => {});
      pending.push(p);
      await untilWaiting(i + 1, waitsOn);
    }
  });
  return Promise.all(pending);
}

/** Пациент в зоне adminA — штатным путём, назначением методики группы А */
async function patientOfA(tag: string): Promise<Person> {
  const person = await makeUser("user", `tr-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
  return person;
}

const myReferrals: string[] = [];

afterAll(async () => {
  /*
   * Ничего живого в общих очередях: реестр направлений и счётчик в
   * навигации обходят всю базу, и открытое направление из этого файла
   * виделось бы чужим проверкам.
   */
  if (myReferrals.length) {
    await db
      .update(referrals)
      .set({ status: "completed" })
      .where(inArray(referrals.id, myReferrals));
  }
  await holder.end();
});

/* ═══════════ направления ═══════════ */

describe("направление: переход атомарен", () => {
  async function referral(tag: string) {
    const person = await patientOfA(tag);
    const made = await appApi("/api/referrals", adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, destination: "psychiatrist", reason: "Проверка гонки" }),
    });
    expect(made.status, `направление: ${JSON.stringify(made.body)}`).toBe(201);
    myReferrals.push(made.body.id);
    return made.body.id as string;
  }

  const move = (id: string, status: string) => () =>
    appApi(`/api/referrals/${id}`, adminA.token, { method: "PATCH", body: JSON.stringify({ status }) });

  test("«відхилено» и «прийнято» одновременно: проходит одно, второму 409, отказ не воскресает", async () => {
    /*
     * Воспроизведение из разбора (п. 4): оба PATCH прочитали «створено»,
     * оба решили, что их переход разрешён, и оба записали по идентификатору.
     * Итог — «прийнято» поверх «відхилено», и обоим 200.
     */
    const id = await referral("rf-race");
    const [declined, accepted] = await whileHeld(
      (tx) => tx`select id from referrals where id = ${id} for update`,
      [move(id, "declined"), move(id, "accepted")],
      ['"referrals"'],
    );

    expect(declined!.status, `первый в очереди: ${JSON.stringify(declined!.body)}`).toBe(200);
    expect(accepted!.status, "второй переход прошёл поверх первого").toBe(409);
    expect(accepted!.body.error).toBeTruthy();

    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row!.status, "отклонённое направление вернулось в принятое").toBe("declined");
  }, 30_000);

  test("проигравший получает 409, даже когда его переход разрешён из нового состояния", async () => {
    /*
     * «прийнято» → «відхилено» разрешено. Но человек решал, глядя на
     * «створено», и отказ, записанный поверх чужого «прийнято», — решение о
     * том, чего он не видел. Отказ — 409, экран перечитает направление.
     */
    const id = await referral("rf-seen");
    const [accepted, declined] = await whileHeld(
      (tx) => tx`select id from referrals where id = ${id} for update`,
      [move(id, "accepted"), move(id, "declined")],
      ['"referrals"'],
    );
    expect(accepted!.status).toBe(200);
    expect(declined!.status, "решение по устаревшему состоянию записалось").toBe(409);
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row!.status).toBe("accepted");
  }, 30_000);
});

/* ═══════════ рассылки ═══════════ */

describe("рассылка: правка и отправка одновременно", () => {
  async function draftFor(author: Person, to: Person) {
    const res = await appApi("/api/mailings", author.token, {
      method: "POST",
      body: JSON.stringify({
        title: `Для A ${crypto.randomUUID().slice(0, 8)}`,
        body: "Повідомлення для A",
        options: ["Так", "Ні"],
        patientIds: [to.id],
      }),
    });
    expect(res.status, `черновик: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as { id: string; revision: number };
  }

  const PRIVATE_B = "Особисте повідомлення лише для B";

  const edit = (id: string, to: Person, extra: Record<string, unknown> = {}) => () =>
    appApi(`/api/mailings/${id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Лише для B", body: PRIVATE_B, patientIds: [to.id], ...extra }),
    });

  test("новый текст не уходит прежним адресатам: адресаты и текст — из одной редакции", async () => {
    /*
     * Воспроизведение из разбора (28.09, п. 1): отправка прочитала черновик
     * и развернула адресатов ДО блокировки строки, правка в это время
     * записала новый текст и нового адресата. Обе — 200; в рассылке новый
     * текст, получатель — прежний, и A читал письмо, написанное для B.
     */
    const a = await patientOfA("ml-a");
    const b = await patientOfA("ml-b");
    const { id } = await draftFor(adminA, a);

    const [edited, sent] = await whileHeld(
      (tx) => tx`select id from mailings where id = ${id} for update`,
      [edit(id, b), () => appApi(`/api/mailings/${id}/send`, adminA.token, { method: "POST", body: "{}" })],
      ['"mailings"'],
    );
    expect(edited!.status, `правка: ${JSON.stringify(edited!.body)}`).toBe(200);
    expect(sent!.status, `отправка: ${JSON.stringify(sent!.body)}`).toBe(200);

    const [row] = await db.select().from(mailings).where(eq(mailings.id, id));
    const delivered = await db
      .select({ userId: mailingRecipients.userId })
      .from(mailingRecipients)
      .where(eq(mailingRecipients.mailingId, id));
    expect(row!.status).toBe("sent");
    expect(
      delivered.map((d) => d.userId),
      "получатели не совпадают с адресатами отправленной редакции",
    ).toEqual(row!.patientIds);

    const inboxA = await appApi("/api/mailings/inbox", a.token);
    expect(
      inboxA.body.items.map((m: { body: string }) => m.body),
      "письмо для B пришло A",
    ).not.toContain(PRIVATE_B);
    const inboxB = await appApi("/api/mailings/inbox", b.token);
    expect(inboxB.body.items.map((m: { body: string }) => m.body)).toContain(PRIVATE_B);
  }, 30_000);

  test("отправка той редакции, что видел отправитель: изменённый черновик — 409 и не уходит", async () => {
    /*
     * Сериализация делает отправку согласованной, но не отвечает на вопрос
     * «то ли уходит, что человек видел». Отправитель называет редакцию; если
     * черновик успели переписать, отправка отказывает, а не рассылает чужую
     * правку от его имени.
     */
    const a = await patientOfA("ml-rev-a");
    const b = await patientOfA("ml-rev-b");
    const { id, revision } = await draftFor(adminA, a);
    expect(revision, "черновик заводится первой редакцией").toBe(1);

    const [edited, sent] = await whileHeld(
      (tx) => tx`select id from mailings where id = ${id} for update`,
      [
        edit(id, b),
        () =>
          appApi(`/api/mailings/${id}/send`, adminA.token, {
            method: "POST",
            body: JSON.stringify({ revision }),
          }),
      ],
      ['"mailings"'],
    );
    expect(edited!.status).toBe(200);
    expect(edited!.body.revision, "правка поднимает редакцию").toBe(revision + 1);
    expect(sent!.status, "ушла редакция, которой отправитель не видел").toBe(409);

    const [row] = await db.select().from(mailings).where(eq(mailings.id, id));
    expect(row!.status).toBe("draft");
    const delivered = await db.select().from(mailingRecipients).where(eq(mailingRecipients.mailingId, id));
    expect(delivered).toHaveLength(0);
  }, 30_000);

  test("правка поверх устаревшей редакции — 409; по свежей — проходит", async () => {
    const a = await patientOfA("ml-stale");
    const { id, revision } = await draftFor(adminA, a);

    const first = await appApi(`/api/mailings/${id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ body: "Перша правка", baseRevision: revision }),
    });
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(revision + 1);

    const stale = await appApi(`/api/mailings/${id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ body: "Друга правка з тієї ж вкладки", baseRevision: revision }),
    });
    expect(stale.status, "вторая вкладка затёрла первую").toBe(409);

    const fresh = await appApi(`/api/mailings/${id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ body: "Друга правка після перечитування", baseRevision: first.body.revision }),
    });
    expect(fresh.status).toBe(200);

    const sent = await appApi(`/api/mailings/${id}/send`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ revision: fresh.body.revision }),
    });
    expect(sent.status, `отправка свежей редакции: ${JSON.stringify(sent.body)}`).toBe(200);
  }, 30_000);
});

/* ═══════════ план безопасности ═══════════ */

describe("план безопасности: одновременные сохранения", () => {
  const content = (tag: string) => ({
    warningSigns: [`Ознака ${tag}`],
    copingStrategies: [],
    distractions: [],
    people: [],
    professionals: [],
    meansRestriction: `Редакція ${tag}`,
    reasonsToLive: [],
  });

  /* очередь плана: запись в строку плана (прежде) или консультативная блокировка по пациенту (теперь) */
  const SAFETY_QUEUE = ['"safety_plans"', "pg_advisory_xact_lock"];

  const save = (userId: string, body: Record<string, unknown>) => () =>
    appApi(`/api/safety/patients/${userId}`, adminA.token, { method: "PUT", body: JSON.stringify(body) });

  async function planWithFirstVersion(tag: string) {
    const person = await patientOfA(tag);
    const first = await save(person.id, { ...content("1"), baseVersion: 0 })();
    expect(first.status, `первая версия: ${JSON.stringify(first.body)}`).toBe(201);
    expect(first.body.version).toBe(1);
    return person;
  }

  async function versionsOf(userId: string) {
    return db
      .select({ version: safetyPlans.version, active: safetyPlans.active })
      .from(safetyPlans)
      .where(eq(safetyPlans.userId, userId))
      .orderBy(safetyPlans.version);
  }

  test("четыре сохранения поверх одной редакции: одно 201, три 409, ни одной пятисотки", async () => {
    /*
     * Воспроизведение из разбора (п. 9): все четыре прочитали последнюю
     * версию до того, как хоть одно записалось, и посчитали следующей одну и
     * ту же. Уникальный индекс пропустил одну, три — пятисотка «внутренняя
     * ошибка». Здесь каждое сохранение называет редакцию, поверх которой
     * правили, — как у заключений, — и устаревшим отвечают 409.
     */
    const person = await planWithFirstVersion("sp-race");
    const results = await whileHeld(
      (tx) => tx`select id from safety_plans where user_id = ${person.id} for update`,
      [0, 1, 2, 3].map((i) => save(person.id, { ...content(`r${i}`), baseVersion: 1 })),
      SAFETY_QUEUE,
    );
    const statuses = results.map((r) => r.status);
    expect(statuses, `ответы: ${JSON.stringify(results.map((r) => r.body))}`).not.toContain(500);
    expect([...statuses].sort()).toEqual([201, 409, 409, 409]);

    const rows = await versionsOf(person.id);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows.filter((r) => r.active).map((r) => r.version), "действующей должна быть одна, последняя").toEqual([2]);
  }, 30_000);

  test("без названной редакции сохранения встают в очередь: версии подряд, без пятисоток", async () => {
    /*
     * Клиент, не знающий о редакции (старая вкладка, внешний вызов), теряет
     * только сверку, но не согласованность: номер версии выделяется под
     * блокировкой, и четыре одновременных сохранения дают четыре версии.
     */
    const person = await planWithFirstVersion("sp-queue");
    const results = await whileHeld(
      (tx) => tx`select id from safety_plans where user_id = ${person.id} for update`,
      [0, 1, 2, 3].map((i) => save(person.id, content(`q${i}`))),
      SAFETY_QUEUE,
    );
    expect(
      results.map((r) => r.status),
      `ответы: ${JSON.stringify(results.map((r) => r.body))}`,
    ).toEqual([201, 201, 201, 201]);
    const rows = await versionsOf(person.id);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.filter((r) => r.active)).toHaveLength(1);
  }, 30_000);

  test("первую версию заводят наперегонки — строки ещё нет, а очередь есть", async () => {
    /*
     * Строки для FOR UPDATE ещё нет — поэтому очередь держит консультативная
     * блокировка по пациенту. Держим её тем же ключом, что маршрут.
     */
    const person = await patientOfA("sp-first");
    const results = await whileHeld(
      (tx) => tx`select pg_advisory_xact_lock(hashtext(${`safety:${person.id}`}))`,
      [0, 1].map((i) => save(person.id, { ...content(`f${i}`), baseVersion: 0 })),
      SAFETY_QUEUE,
    );
    expect(results.map((r) => r.status)).toEqual([201, 409]);
    expect((await versionsOf(person.id)).map((r) => r.version)).toEqual([1]);
  }, 30_000);
});

/* ═══════════ диспансерный учёт ═══════════ */

describe("диспансерный учёт: повторная постановка не сбрасывает срок", () => {
  const mine: string[] = [];
  afterAll(async () => {
    // просроченная запись — строка общей очереди работы: снимаем свои
    const { dispensary } = await import("../src/db/schema");
    if (mine.length) {
      await db
        .update(dispensary)
        .set({ removedAt: new Date().toISOString() })
        .where(and(inArray(dispensary.patientId, mine), isNull(dispensary.removedAt)));
    }
  });

  const put = (patientId: string, body: Record<string, unknown>) =>
    appApi("/api/episodes/dispensary", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ patientId, groupLabel: "Д-II", intervalMonths: 1, ...body }),
    });
  const state = (patientId: string) => appApi(`/api/episodes/dispensary/${patientId}`, adminA.token);
  const DAY = 86_400_000;

  async function overdueRecord(tag: string) {
    const person = await patientOfA(tag);
    mine.push(person.id);
    expect((await put(person.id, {})).status).toBe(200);
    /*
     * Поставлен сто дней назад, осмотр был сорок дней назад, срок вышел
     * десять дней назад — как в пробе ревьюера.
     */
    const { dispensary } = await import("../src/db/schema");
    await db
      .update(dispensary)
      .set({
        addedAt: new Date(Date.now() - 100 * DAY).toISOString(),
        lastSeenAt: new Date(Date.now() - 40 * DAY).toISOString(),
        nextDueAt: new Date(Date.now() - 10 * DAY).toISOString(),
      })
      .where(eq(dispensary.patientId, person.id));
    return person;
  }

  test("правка заметки у действующей записи оставляет просрочку", async () => {
    /*
     * Воспроизведение из разбора (п. 14): тот же интервал, другая заметка —
     * и просрочка в десять дней становилась нулём при неизменном lastSeenAt.
     * Человек, которого не осматривали, пропадал из очереди работы.
     */
    const person = await overdueRecord("dp-note");
    const before = await state(person.id);
    expect(before.body.overdueDays).toBeGreaterThanOrEqual(9);

    expect((await put(person.id, { note: "змінено лише примітку", groupLabel: "Д-III" })).status).toBe(200);
    const after = await state(person.id);
    expect(after.body.note).toBe("змінено лише примітку");
    expect(after.body.groupLabel).toBe("Д-III");
    expect(after.body.nextDueAt, "срок пересчитан от сегодня").toBe(before.body.nextDueAt);
    expect(after.body.overdueDays, "просрочка сброшена правкой").toBe(before.body.overdueDays);
    expect(after.body.lastSeenAt).toBe(before.body.lastSeenAt);
  }, 30_000);

  test("смена периодичности считает срок от прежнего основания, а не от сегодня", async () => {
    /*
     * Основание срока — последний осмотр. Сорок дней назад плюс два месяца —
     * срок ещё впереди; от сегодня получилось бы два месяца вперёд, и
     * пропущенный месяц растворился бы.
     */
    const person = await overdueRecord("dp-interval");
    const before = await state(person.id);
    expect((await put(person.id, { intervalMonths: 2 })).status).toBe(200);
    const after = await state(person.id);
    const due = new Date(after.body.nextDueAt).getTime();
    const seen = new Date(before.body.lastSeenAt).getTime();
    // два месяца от осмотра: 59–62 дня, а не ~60 дней от сегодня (это было бы ~100 от осмотра)
    expect((due - seen) / DAY).toBeGreaterThanOrEqual(58);
    expect((due - seen) / DAY).toBeLessThanOrEqual(63);
    expect(after.body.intervalMonths).toBe(2);

    // и обратно на месяц — снова просрочка, та же, что до правок
    expect((await put(person.id, { intervalMonths: 1 })).status).toBe(200);
    const back = await state(person.id);
    expect(back.body.overdueDays).toBeGreaterThanOrEqual(9);
  }, 30_000);

  test("возврат на учёт после снятия считает срок от решения о возврате", async () => {
    /*
     * Возврат — новая постановка: прежний осмотр был до снятия, и срок от
     * него сделал бы вернувшегося просроченным в первый же день.
     */
    const person = await overdueRecord("dp-return");
    expect(
      (await appApi(`/api/episodes/dispensary/${person.id}`, adminA.token, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await put(person.id, { intervalMonths: 3 })).status).toBe(200);
    const after = await state(person.id);
    expect(after.body.on).toBe(true);
    expect(after.body.overdueDays).toBe(0);
    const ahead = (new Date(after.body.nextDueAt).getTime() - Date.now()) / DAY;
    expect(ahead).toBeGreaterThanOrEqual(85);

    // а правка уже вернувшегося снова держит его срок
    expect((await put(person.id, { intervalMonths: 3, note: "після повернення" })).status).toBe(200);
    expect((await state(person.id)).body.nextDueAt).toBe(after.body.nextDueAt);

    /*
     * И основание после возврата — сам возврат, а не осмотр до снятия: смена
     * периодичности на месяц не делает вернувшегося просроченным.
     */
    expect((await put(person.id, { intervalMonths: 1 })).status).toBe(200);
    const monthly = await state(person.id);
    expect(monthly.body.overdueDays).toBe(0);
    const monthAhead = (new Date(monthly.body.nextDueAt).getTime() - Date.now()) / DAY;
    expect(monthAhead).toBeGreaterThanOrEqual(27);
    expect(monthAhead).toBeLessThanOrEqual(32);
  }, 30_000);
});
