import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  adminA,
  api,
  appApi,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  makeUser,
  root,
  runDueSchedules,
  sr45,
  submitSurvey,
  surveyInA,
  surveys,
  type Person,
} from "./fixtures";
import {
  auditLog,
  batteries,
  batteryAssignments,
  decisionRules,
  filterPresets,
  ruleHits,
  schedules,
  statModels,
  surveyAccess,
} from "../src/db/schema";

/**
 * Сторож, отделённый от записи (волна 18, участок races; внешний разбор
 * 2026-09-29…10-01, #104, #106, #107, #108).
 *
 * Четыре находки об одном: обработчик читает строку, решает по прочитанному
 * («ещё предложено», «моделей нет», «назначений нет», «не в архиве») и пишет
 * по одному идентификатору. Всё, что другой запрос успел зафиксировать между
 * чтением и записью, сторож не видит: решение по срабатыванию затирается
 * вторым решением, удалённый пресет оставляет модель, которую не запустить,
 * удаление набора каскадом уносит назначение, чей id уже отдан клиенту, а
 * архивный набор назначается.
 *
 * Приём — ревьюера (test/transitionRaces.test.ts, batteryLifecycle.test.ts):
 * строку держит блокировкой отдельное соединение владельца, запросы под
 * ролью приложения (appApi) запускаются по одному и каждый дожидается, пока
 * встанет в очередь за замком; порядок в очереди — порядок прохода. Когда
 * стоят все, строка отпускается. Каждая проверка падала на прежнем коде.
 */

/** Отдельное соединение — им «держат строку», как служебной транзакцией у ревьюера */
const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

/**
 * Сколько запросов к этой базе стоят в очереди за замком — из тех, чей
 * текст касается проверяемого. Фрагменты, а не одно имя: до правки и после
 * неё запрос встаёт в очередь разными операторами.
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

/** Дождаться, пока в очереди окажется n запросов, — по факту, а не по таймеру */
async function untilWaiting(n: number, fragments: string[], timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await lockWaiters(fragments)) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`в очереди за замком меньше ${n} запросов — гонка не воспроизведена`);
}

/**
 * Дождаться, пока запрос либо встанет в очередь n-м, либо завершится сам.
 *
 * Для запросов, которые на прежнем коде за замком не стоят вовсе (создание
 * модели не трогало строку пресета): проверка должна увидеть и это — иначе
 * на прежнем коде она падала бы на ожидании, а не на гонке.
 */
async function queuedOrDone(p: Promise<unknown>, n: number, fragments: string[], timeoutMs = 20_000) {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (done || (await lockWaiters(fragments)) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`запрос ни встал в очередь, ни завершился за ${timeoutMs} мс`);
}

/** Держать строку, пока все действия не встанут за ней в очередь, и отпустить */
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

const myRules: string[] = [];
const people: string[] = [];

afterAll(async () => {
  /*
   * Ничего живого в общих очередях: включённое правило создавало бы
   * предложения в чужих файлах, открытое назначение — висело бы в общем
   * списке назначений.
   */
  if (myRules.length) await db.update(decisionRules).set({ enabled: false }).where(inArray(decisionRules.id, myRules));
  if (people.length) {
    await db
      .update(batteryAssignments)
      .set({ cancelledAt: new Date().toISOString() })
      .where(
        and(
          inArray(batteryAssignments.userId, people),
          isNull(batteryAssignments.completedAt),
          isNull(batteryAssignments.cancelledAt),
        ),
      );
  }
  await holder.end();
});

async function patient(tag: string): Promise<Person> {
  const p = await makeUser("user", `gr-${tag}-${crypto.randomUUID()}@test`, { sex: "male", birthDate: "1990-01-01" });
  people.push(p.id);
  return p;
}

async function auditRows(action: string, resourceId: string) {
  return db
    .select({ actorId: auditLog.actorId, details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
}

/* ═══════════ #104: решение по срабатыванию правила ═══════════ */

describe("решение по срабатыванию: принимается ровно одно", () => {
  async function suggestedHit(tag: string): Promise<string> {
    const survey = await api(`/api/surveys/${surveyInA}`, adminA.token);
    const scale = survey.body.scales[0].code as string;
    const rule = await api("/api/decisions/rules", root.token, {
      method: "POST",
      body: JSON.stringify({
        title: `Гонка решений ${tag}`,
        conditions: [{ kind: "scale", surveyId: surveyInA, scaleCode: scale, metric: "raw", op: ">=", value: -1 }],
        actions: [{ kind: "notify_duty" }],
      }),
    });
    expect(rule.status, `правило: ${JSON.stringify(rule.body)}`).toBe(201);
    myRules.push(rule.body.id);

    const person = await patient(`hit-${tag}`);
    const submitted = await submitSurvey(surveyInA, person.token);
    expect(submitted.status, `сдача: ${JSON.stringify(submitted.body)}`).toBe(201);

    const hits = await db
      .select({ id: ruleHits.id })
      .from(ruleHits)
      .where(and(eq(ruleHits.userId, person.id), eq(ruleHits.ruleId, rule.body.id), eq(ruleHits.status, "suggested")));
    expect(hits.length, "срабатывание не появилось").toBe(1);
    return hits[0]!.id;
  }

  const decide = (id: string, status: string, note?: string) => () =>
    appApi(`/api/decisions/hits/${id}`, adminA.token, { method: "PATCH", body: JSON.stringify({ status, note }) });

  test("принять и отклонить одновременно: первому 200, второму 409, решение и заметка — первого", async () => {
    /*
     * Воспроизведение из разбора (#104, пп. 2–4): оба PATCH прочитали
     * «предложено», оба решили, что решения ещё нет, и оба записали по id.
     * Итог — declined с заметкой второго поверх accepted первого, и обоим
     * 200. Последовательный повтор при этом честно отвечал 400.
     */
    const id = await suggestedHit("acc-dec");
    const [accepted, declined] = await whileHeld(
      (tx) => tx`select id from rule_hits where id = ${id} for update`,
      [decide(id, "accepted"), decide(id, "declined", "Пацієнт уже на маршруті")],
      ['"rule_hits"'],
    );
    expect(accepted!.status, `первый в очереди: ${JSON.stringify(accepted!.body)}`).toBe(200);
    expect(declined!.status, "второе решение записалось поверх первого").toBe(409);
    expect(declined!.body.error).toBeTruthy();

    const [row] = await db.select().from(ruleHits).where(eq(ruleHits.id, id));
    expect(row!.status).toBe("accepted");
    expect(row!.decidedBy).toBe(adminA.id);
    expect(row!.decisionNote, "заметка проигравшего попала в принятое решение").toBeNull();
    expect(row!.decidedAt).not.toBeNull();

    // журнал согласован с решением: одна запись, и она о принятии
    const audits = await auditRows("rule.decide", id);
    expect(audits.map((a) => a.details?.status)).toEqual(["accepted"]);
  }, 30_000);

  test("два одинаковых решения одновременно: одно проходит, второе — 409", async () => {
    const id = await suggestedHit("dec-dec");
    const [first, second] = await whileHeld(
      (tx) => tx`select id from rule_hits where id = ${id} for update`,
      [decide(id, "declined", "Перша заметка"), decide(id, "declined", "Друга заметка")],
      ['"rule_hits"'],
    );
    expect(first!.status).toBe(200);
    expect(second!.status, "одинаковое решение — тоже решение, принятое дважды").toBe(409);

    const [row] = await db.select().from(ruleHits).where(eq(ruleHits.id, id));
    expect(row!.status).toBe("declined");
    expect(row!.decisionNote).toBe("Перша заметка");
    expect((await auditRows("rule.decide", id)).length).toBe(1);
  }, 30_000);

  test("повтор после фиксации — 409 «решение уже принято», как проигранная гонка", async () => {
    const id = await suggestedHit("again");
    expect((await decide(id, "accepted")()).status).toBe(200);
    const again = await decide(id, "declined", "передумав")();
    expect(again.status).toBe(409);
    const [row] = await db.select().from(ruleHits).where(eq(ruleHits.id, id));
    expect(row!.status).toBe("accepted");
  });
});

/* ═══════════ #106: пресет фильтров и статистическая модель ═══════════ */

describe("пресет фильтров: удаление и создание модели на нём согласованы", () => {
  async function preset(tag: string): Promise<string> {
    const res = await appApi("/api/filter-presets", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: `Чоловіки ${tag}`, criteria: { sex: "male" } }),
    });
    expect(res.status, `пресет: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body.id as string;
  }

  const removePreset = (id: string) => () => appApi(`/api/filter-presets/${id}`, adminA.token, { method: "DELETE" });

  const createModel = (presetId: string, title: string) => () =>
    appApi("/api/stat-models", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title, columns: [{ presetId, surveyId: surveyInA }] }),
    });

  async function modelsTitled(title: string) {
    return db.select({ id: statModels.id }).from(statModels).where(eq(statModels.title, title));
  }

  test("удаление раньше создания: пресет удалён, модель не создана (404), без модели-сироты", async () => {
    /*
     * Воспроизведение из разбора (#106, пп. 2–4): DELETE прошёл проверку
     * «моделей нет» и ждал самой строки; создание модели строку пресета не
     * трогало и прошло — 201; DELETE затем — 204. Модель осталась в списке,
     * а её запуск отвечал 404 «пресет не найден».
     */
    const id = await preset("del-first");
    const title = `Сирота ${crypto.randomUUID().slice(0, 8)}`;

    let deleting!: Promise<{ status: number; body: any }>;
    let creating!: Promise<{ status: number; body: any }>;
    await holder.begin(async (tx) => {
      await tx`select id from filter_presets where id = ${id} for update`;
      deleting = removePreset(id)();
      deleting.catch(() => {});
      await untilWaiting(1, ['"filter_presets"']);
      creating = createModel(id, title)();
      creating.catch(() => {});
      // прежний код: создание не ждёт никого; новый — встаёт за строкой пресета
      await queuedOrDone(creating, 2, ['"filter_presets"']);
    });
    const [deleted, created] = await Promise.all([deleting, creating]);

    expect(deleted.status, `удаление: ${JSON.stringify(deleted.body)}`).toBe(204);
    expect(created.status, "модель создана на пресете, который удалили").toBe(404);
    expect(await modelsTitled(title)).toHaveLength(0);
    expect(await db.select({ id: filterPresets.id }).from(filterPresets).where(eq(filterPresets.id, id))).toHaveLength(0);
  }, 30_000);

  test("создание раньше удаления: модель создана и запускается, удаление — отказ «пресет используется»", async () => {
    const id = await preset("create-first");
    const title = `Тримає пресет ${crypto.randomUUID().slice(0, 8)}`;

    let creating!: Promise<{ status: number; body: any }>;
    let deleting!: Promise<{ status: number; body: any }>;
    await holder.begin(async (tx) => {
      await tx`select id from filter_presets where id = ${id} for update`;
      creating = createModel(id, title)();
      creating.catch(() => {});
      await queuedOrDone(creating, 1, ['"filter_presets"']);
      deleting = removePreset(id)();
      deleting.catch(() => {});
      // прежний код: удаление отказывает сразу, увидев модель; новый — ждёт строку пресета
      await queuedOrDone(deleting, 1, ['"filter_presets"']);
    });
    const [created, deleted] = await Promise.all([creating, deleting]);

    expect(created.status, `модель: ${JSON.stringify(created.body)}`).toBe(201);
    expect(deleted.status, "пресет удалён из-под созданной модели").toBe(400);

    const run = await appApi(`/api/stat-models/${created.body.id}/run`, adminA.token, { method: "POST", body: "{}" });
    expect(run.status, `запуск созданной модели: ${JSON.stringify(run.body)}`).toBe(200);
  }, 30_000);

  test("модель суперадмина на чужом пресете держит его от удаления владельцем", async () => {
    /*
     * Та же дыра без гонки: модели считались под политикой строк владельца
     * пресета, а модель суперадмина на этом пресете ему не видна — счёт
     * давал ноль, пресет удалялся, модель переставала запускаться.
     */
    const id = await preset("root-model");
    const title = `Модель root ${crypto.randomUUID().slice(0, 8)}`;
    const created = await appApi("/api/stat-models", root.token, {
      method: "POST",
      body: JSON.stringify({ title, columns: [{ presetId: id, surveyId: surveyInA }] }),
    });
    expect(created.status, `модель суперадмина: ${JSON.stringify(created.body)}`).toBe(201);

    const deleted = await removePreset(id)();
    expect(deleted.status, "пресет удалён из-под модели, которой владелец не видит").toBe(400);
    const run = await appApi(`/api/stat-models/${created.body.id}/run`, root.token, { method: "POST", body: "{}" });
    expect(run.status).toBe(200);
  });
});

/* ═══════════ #107, #108: набор — удаление, архивирование и выдача ═══════════ */

/** Закрытая методика группы А: открывается пациенту только по назначению */
async function restrictedSurvey(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: title, ru: title, en: title },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "restricted",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(sr45), adminA.id, "v1");
  return id;
}

/** Набор штатным путём (POST /batteries) — так же, как собирает его сотрудник */
async function makeBattery(title: string, surveyIds: string[]): Promise<string> {
  const res = await appApi("/api/batteries", adminA.token, {
    method: "POST",
    body: JSON.stringify({ title, groupId: groupA, strictOrder: false, items: surveyIds.map((surveyId) => ({ surveyId })) }),
  });
  expect(res.status, `набор: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.id as string;
}

const assign = (batteryId: string, who: Person) => () =>
  appApi(`/api/batteries/${batteryId}/assign`, adminA.token, { method: "POST", body: JSON.stringify({ userId: who.id }) });

const removeBattery = (batteryId: string) => () => appApi(`/api/batteries/${batteryId}`, adminA.token, { method: "DELETE" });

const archiveBattery = (batteryId: string, title: string, surveyIds: string[]) => () =>
  appApi(`/api/batteries/${batteryId}`, adminA.token, {
    method: "PUT",
    body: JSON.stringify({
      title,
      groupId: groupA,
      strictOrder: false,
      archived: true,
      items: surveyIds.map((surveyId) => ({ surveyId })),
    }),
  });

async function assignmentsOf(batteryId: string, userId: string) {
  return db
    .select({ id: batteryAssignments.id })
    .from(batteryAssignments)
    .where(and(eq(batteryAssignments.batteryId, batteryId), eq(batteryAssignments.userId, userId)));
}

async function accessOf(surveyId: string, userId: string) {
  return db
    .select({ surveyId: surveyAccess.surveyId })
    .from(surveyAccess)
    .where(and(eq(surveyAccess.surveyId, surveyId), eq(surveyAccess.userId, userId)));
}

/* до правки выдача ждёт на вставке назначения (FK к набору), удаление — на самой строке; после — обе на строке набора */
const BATTERY_QUEUE = ['"batteries"', '"battery_assignments"'];

describe("удаление набора и выдача назначения", () => {
  test("выдача раньше удаления: назначение (201) сохранено, удаление — отказ, доступ выдан", async () => {
    /*
     * Воспроизведение из разбора (#107, пп. 2–4): выдача ждала FK-проверки
     * на строке набора, удаление успело посчитать «назначений нет» и ждало
     * той же строки. После отпускания: 201 с id назначения, затем 204 — и
     * каскад унёс назначение, чей id уже отдан, а доступ пациента остался.
     */
    const tag = crypto.randomUUID().slice(0, 8);
    const s = await restrictedSurvey(`Видалення A ${tag}`);
    const batteryId = await makeBattery(`Видалення A ${tag}`, [s]);
    const p = await patient("del-assign");

    const [assigned, deleted] = await whileHeld(
      (tx) => tx`select id from batteries where id = ${batteryId} for update`,
      [assign(batteryId, p), removeBattery(batteryId)],
      BATTERY_QUEUE,
    );
    expect(assigned!.status, `назначение: ${JSON.stringify(assigned!.body)}`).toBe(201);
    expect(deleted!.status, "набор с назначением удалён").toBe(400);

    const rows = await assignmentsOf(batteryId, p.id);
    expect(rows.map((r) => r.id), "назначение, чей id уже отдан, исчезло").toEqual([assigned!.body.id]);
    expect(await accessOf(s, p.id)).toHaveLength(1);
    expect(await db.select({ id: batteries.id }).from(batteries).where(eq(batteries.id, batteryId))).toHaveLength(1);
  }, 30_000);

  test("удаление раньше выдачи: набор удалён (204), выдача — 404, доступа не осталось", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const s = await restrictedSurvey(`Видалення B ${tag}`);
    const batteryId = await makeBattery(`Видалення B ${tag}`, [s]);
    const p = await patient("assign-del");

    const [deleted, assigned] = await whileHeld(
      (tx) => tx`select id from batteries where id = ${batteryId} for update`,
      [removeBattery(batteryId), assign(batteryId, p)],
      BATTERY_QUEUE,
    );
    expect(deleted!.status, `удаление: ${JSON.stringify(deleted!.body)}`).toBe(204);
    expect(assigned!.status, "назначение на удалённый набор прошло").toBe(404);
    expect(await assignmentsOf(batteryId, p.id)).toHaveLength(0);
    expect(await accessOf(s, p.id), "отказ выдачи оставил доступ").toHaveLength(0);
  }, 30_000);

  test("завершённое назначение держит набор от удаления и на уровне базы", async () => {
    /*
     * Сторож в маршруте — не единственная защита: внешний ключ назначений
     * теперь RESTRICT, и удаление набора с историей падает в базе даже
     * мимо маршрута (миграция 0119).
     */
    const tag = crypto.randomUUID().slice(0, 8);
    const s = await restrictedSurvey(`Історія ${tag}`);
    const batteryId = await makeBattery(`Історія ${tag}`, [s]);
    const p = await patient("history");
    const made = await assign(batteryId, p)();
    expect(made.status).toBe(201);
    await db
      .update(batteryAssignments)
      .set({ completedAt: new Date().toISOString() })
      .where(eq(batteryAssignments.id, made.body.id));

    expect((await removeBattery(batteryId)()).status).toBe(400);
    await expect(
      (async () => {
        await db.delete(batteries).where(eq(batteries.id, batteryId));
      })(),
    ).rejects.toThrow();
    expect(await assignmentsOf(batteryId, p.id)).toHaveLength(1);
  });
});

describe("архивирование набора и выдача назначения", () => {
  test("архив раньше выдачи: набор архивный (200), выдача — отказ, ни назначения, ни доступа", async () => {
    /*
     * Воспроизведение из разбора (#108, пп. 2–4): PUT archived=true ждал
     * строки набора; выдача прочитала archived=false и ждала FK на вставке
     * назначения. После отпускания PUT — 200, затем выдача — 201: назначение
     * архивного набора и доступ к его методике.
     */
    const tag = crypto.randomUUID().slice(0, 8);
    const s = await restrictedSurvey(`Архів ${tag}`);
    const title = `Архів ${tag}`;
    const batteryId = await makeBattery(title, [s]);
    const p = await patient("archive-assign");

    const [archived, assigned] = await whileHeld(
      (tx) => tx`select id from batteries where id = ${batteryId} for update`,
      [archiveBattery(batteryId, title, [s]), assign(batteryId, p)],
      BATTERY_QUEUE,
    );
    expect(archived!.status, `архивирование: ${JSON.stringify(archived!.body)}`).toBe(200);
    expect(assigned!.status, "архивный набор назначен").toBe(400);

    const [row] = await db.select({ archived: batteries.archived }).from(batteries).where(eq(batteries.id, batteryId));
    expect(row!.archived).toBe(true);
    expect(await assignmentsOf(batteryId, p.id)).toHaveLength(0);
    expect(await accessOf(s, p.id), "доступ к методике архивного набора выдан").toHaveLength(0);
  }, 30_000);

  test("выдача раньше архива: назначение сохранено, архивирование проходит и знает об открытом назначении", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const s = await restrictedSurvey(`Архів B ${tag}`);
    const title = `Архів B ${tag}`;
    const batteryId = await makeBattery(title, [s]);
    const p = await patient("assign-archive");

    const [assigned, archived] = await whileHeld(
      (tx) => tx`select id from batteries where id = ${batteryId} for update`,
      [assign(batteryId, p), archiveBattery(batteryId, title, [s])],
      BATTERY_QUEUE,
    );
    expect(assigned!.status, `назначение: ${JSON.stringify(assigned!.body)}`).toBe(201);
    expect(archived!.status).toBe(200);
    expect(await assignmentsOf(batteryId, p.id)).toHaveLength(1);
    expect(await accessOf(s, p.id)).toHaveLength(1);

    // журнал архивирования считал открытые назначения после замка, а не до него
    const [entry] = await auditRows("battery.update", batteryId);
    expect(entry?.details?.openAssignmentsKept).toBe(1);
  }, 30_000);

  test("расписание, вставшее за архивированием, архивный набор не выдаёт", async () => {
    /*
     * Тот же сторож у автоматической выдачи: расписание читало archived до
     * своей транзакции и выдавало набор, который за это время архивировали.
     * Теперь строка набора берётся под замок внутри транзакции выдачи
     * (lib/batteries.ts, lockBatteryForAssign) — то же у каскада и приглашения.
     */
    const tag = crypto.randomUUID().slice(0, 8);
    const s = await restrictedSurvey(`Архів за розкладом ${tag}`);
    const title = `Архів за розкладом ${tag}`;
    const batteryId = await makeBattery(title, [s]);
    const unit = `Взвод ${tag}`;
    const p = await makeUser("user", `gr-sched-${tag}@test`, { sex: "male", birthDate: "1990-01-01", unit });
    people.push(p.id);
    await db.insert(schedules).values({
      id: crypto.randomUUID(),
      title: `Розклад ${tag}`,
      batteryId,
      scope: "unit",
      unit,
      intervalDays: 30,
      dueDays: 7,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      active: true,
      createdBy: adminA.id,
    });

    const [archived] = await whileHeld<unknown>(
      (tx) => tx`select id from batteries where id = ${batteryId} for update`,
      [archiveBattery(batteryId, title, [s]), () => runDueSchedules()],
      BATTERY_QUEUE,
    );
    expect((archived as { status: number }).status).toBe(200);
    expect(await assignmentsOf(batteryId, p.id), "расписание выдало архивный набор").toHaveLength(0);
    expect(await accessOf(s, p.id)).toHaveLength(0);
  }, 30_000);
});
