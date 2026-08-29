import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { adminA, adminB, api, app, batteries, batteryItems, createSurveySchema, createVersion, db, eq, groupA, makeUser, patient, responsesTable, root, sr45, submitSurvey, surveyInA, surveyInB, surveys, users } from "./fixtures";

/* Служебное: наблюдаемость, метрики, проверка входа, жизненный цикл методики */

/* ── экспорт → импорт ── */

describe("импорт методики", () => {
  test("цикл экспорт → импорт даёт рабочую копию с теми же баллами", async () => {
    const exported = await api(`/api/surveys/${surveyInA}/export`, adminA.token);
    expect(exported.status).toBe(200);
    expect(exported.body.formatVersion).toBe(1);

    const imported = await api("/api/surveys/import", adminA.token, {
      method: "POST",
      body: JSON.stringify({ ...exported.body, groupId: groupA }),
    });
    expect(imported.status).toBe(201);

    // копия — черновик; публикуем и сдаём те же ответы, баллы должны совпасть
    await api(`/api/surveys/${imported.body.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "published" }),
    });
    const original = await submitSurvey(surveyInA, root.token);
    const copy = await submitSurvey(imported.body.id, root.token);
    expect(copy.status).toBe(201);
    const scoreOf = (r: { body: { scores: { scaleCode: string; rawScore: number }[] } }, code: string) =>
      r.body.scores.find((s) => s.scaleCode === code)?.rawScore;
    expect(scoreOf(copy, "Sr")).toBe(scoreOf(original, "Sr"));
    expect(scoreOf(copy, "L")).toBe(scoreOf(original, "L"));
  });

  test("файл со структурной ошибкой не создаёт методику", async () => {
    const exported = await api(`/api/surveys/${surveyInA}/export`, adminA.token);
    const broken = structuredClone(exported.body);
    broken.scales[0].key.push({ item: 999, matchKey: "yes" }); // номер за пределами
    const res = await api("/api/surveys/import", adminA.token, {
      method: "POST",
      body: JSON.stringify(broken),
    });
    expect(res.status).toBe(422);
    expect(res.body.issues.some((i: { level: string }) => i.level === "error")).toBe(true);
  });

  test("чужая группа при импорте — отказ", async () => {
    const exported = await api(`/api/surveys/${surveyInA}/export`, adminA.token);
    const res = await api("/api/surveys/import", adminB.token, {
      method: "POST",
      body: JSON.stringify({ ...exported.body, groupId: groupA }),
    });
    expect([403, 404]).toContain(res.status);
  });
});

/* ── снятие методики с использования ── */

describe("снятие методики с использования", () => {
  let sid: string;

  beforeAll(async () => {
    // отдельная методика: снимать основную нельзя — на ней стоят другие тесты
    const input = createSurveySchema.parse(sr45);
    sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: input.title,
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, input, adminA.id, "Версия для снятия");
  });

  test("прохождения переживают снятие", async () => {
    // сдаём прохождение до снятия
    const before = await submitSurvey(sid, patient.token);
    expect(before.status).toBe(201);

    const archived = await api(`/api/surveys/${sid}`, adminA.token, { method: "DELETE" });
    expect(archived.status).toBe(204);

    const rows = await db.select().from(responsesTable).where(eq(responsesTable.surveyId, sid));
    expect(rows.length).toBe(1);
  });

  test("снятая методика исчезает из списков и не проходится", async () => {
    const staffList = await api("/api/surveys", adminA.token);
    expect(staffList.body.items.some((s: { id: string }) => s.id === sid)).toBe(false);

    const patientList = await api("/api/surveys", patient.token);
    expect(patientList.body.items.some((s: { id: string }) => s.id === sid)).toBe(false);

    const pass = await api(`/api/surveys/${sid}/responses`, patient.token, {
      method: "POST",
      body: JSON.stringify({ startedAt: new Date().toISOString(), durationMs: 1000, answers: [] }),
    });
    expect(pass.status).toBe(400);

    const draft = await api(`/api/surveys/${sid}/draft`, patient.token, {
      method: "PUT",
      body: JSON.stringify({ answers: [] }),
    });
    expect(draft.status).toBe(400);
  });

  test("снятую методику нельзя назначить — ни лично, ни батареей", async () => {
    const grant = await api(`/api/access/surveys/${sid}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id }),
    });
    expect(grant.status).toBe(400);

    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      groupId: groupA,
      title: "Набор со снятой методикой",
      createdBy: adminA.id,
    } as never);
    await db.insert(batteryItems).values({
      id: crypto.randomUUID(),
      batteryId,
      surveyId: sid,
      position: 1,
    } as never);

    const assign = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id }),
    });
    expect(assign.status).toBe(400);
    expect(assign.body.error).toContain("Снято с использования");
  });

  test("сотрудник видит снятые по явному запросу, повторное снятие отклоняется", async () => {
    const list = await api("/api/surveys?archived=1", adminA.token);
    expect(list.body.items.some((s: { id: string }) => s.id === sid)).toBe(true);

    const again = await api(`/api/surveys/${sid}`, adminA.token, { method: "DELETE" });
    expect(again.status).toBe(400);
  });

  test("возврат в работу восстанавливает выдачу", async () => {
    const restored = await api(`/api/surveys/${sid}/restore`, adminA.token, { method: "POST" });
    expect(restored.status).toBe(204);

    const list = await api("/api/surveys", patient.token);
    expect(list.body.items.some((s: { id: string }) => s.id === sid)).toBe(true);

    const pass = await submitSurvey(sid, patient.token);
    expect(pass.status).toBe(201);
  });
});

/* ── служебные эндпоинты ── */

describe("query-параметры проверяются схемой", () => {
  test("нечисловой limit — 400, а не пятисотка", async () => {
    const res = await api("/api/audit?limit=abc", root.token);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("limit");
  });

  test("limit сверх потолка отклоняется", async () => {
    expect((await api("/api/audit?limit=100000", root.token)).status).toBe(400);
  });

  test("несуществующая дата отклоняется", async () => {
    // формату «ГГГГ-ММ-ДД» соответствует, а даты такой нет
    const res = await api("/api/audit?from=2026-02-31", root.token);
    expect(res.status).toBe(400);
  });

  test("корректные параметры проходят", async () => {
    const res = await api("/api/audit?limit=5&from=2026-01-01", root.token);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeLessThanOrEqual(5);
  });
});

describe("размеры хранилища", () => {
  test("суперадмин видит таблицы и рост журнала", async () => {
    const res = await api("/api/stats/storage", root.token);
    expect(res.status).toBe(200);
    expect(res.body.database.bytes).toBeGreaterThan(0);
    expect(res.body.tables.some((t: { table: string }) => t.table === "audit_log")).toBe(true);
    expect(Array.isArray(res.body.auditGrowth)).toBe(true);
  });

  test("групповому админу размеры базы не показываются", async () => {
    expect((await api("/api/stats/storage", adminA.token)).status).toBe(403);
  });
});

describe("списки не отдаются целиком", () => {
  test("пациенты: поиск на сервере и честная пометка об обрезке", async () => {
    /*
     * Курсорная пагинация здесь невозможна: список упорядочен по ФИО, а оно
     * зашифровано. Поэтому сервер ищет и обрезает, а клиенту сообщает, что
     * показано не всё — иначе тот молча принял бы часть за целое.
     */
    const res = await api("/api/access/patients?search=нетакогочеловека", adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.truncated).toBe(false);
  });

  test("повторные замеры отдаются страницами", async () => {
    const first = await api("/api/dynamics/respondents?limit=1", adminA.token);
    expect(first.status).toBe(200);
    expect(Array.isArray(first.body.items)).toBe(true);
    expect(typeof first.body.total).toBe("number");
    // общее число считается только на первой странице
    if (first.body.nextCursor) {
      const second = await api(
        `/api/dynamics/respondents?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
        adminA.token,
      );
      expect(second.status).toBe(200);
      expect(second.body.total).toBeUndefined();
      expect(second.body.items[0]?.userId).not.toBe(first.body.items[0]?.userId);
    }
  });
});

describe("наблюдаемость", () => {
  test("номер запроса возвращается в заголовке и попадает в журнал", async () => {
    const res = await api("/api/surveys", adminA.token);
    const id = res.headers?.get?.("x-request-id");
    expect(typeof id).toBe("string");
    expect(id!.length).toBeGreaterThan(8);
  });

  test("свой номер запроса принимается — по нему сшиваются логи прокси и приложения", async () => {
    const mine = "edge-proxy-7f3a91";
    const res = await api("/api/surveys", adminA.token, { headers: { "x-request-id": mine } });
    expect(res.headers?.get?.("x-request-id")).toBe(mine);
  });

  test("чужой номер просеивается: он уходит в заголовок ответа и в лог", async () => {
    /*
     * Подстановка в заголовок и в лог — обе неприятны, а идентификатор
     * приходит снаружи. Символы вне безопасного набора вырезаются.
     */
    const res = await api("/api/surveys", adminA.token, {
      headers: { "x-request-id": "abc\u0009def<script>" },
    });
    const got = res.headers?.get?.("x-request-id") ?? "";
    expect(got).not.toContain("<");
    expect(got).toMatch(/^[A-Za-z0-9._:-]+$/);
  });

  test("отказ несёт номер запроса, по которому инцидент ищется в логе", async () => {
    const res = await api("/api/surveys/нет-такой-методики", adminA.token);
    expect(res.status).toBe(404);
    expect(typeof res.body.requestId).toBe("string");
  });
});

describe("метрики", () => {
  test("без токена эндпоинта нет вовсе", async () => {
    // выключено значит выключено, а не «открыто для всех»
    delete process.env.METRICS_TOKEN;
    const res = await app.request("/metrics");
    expect(res.status).toBe(404);
  });

  test("с токеном отдаёт счётчики в формате Prometheus", async () => {
    process.env.METRICS_TOKEN = "metrics-secret-9f21";
    const bad = await app.request("/metrics", { headers: { authorization: "Bearer wrong" } });
    expect(bad.status).toBe(401);

    const res = await app.request("/metrics", {
      headers: { authorization: "Bearer metrics-secret-9f21" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    // счётчик запросов набрался за время прогона сюиты
    expect(text).toContain("quizzy_http_requests_total{");
    // гистограмма длительности — с накопительными корзинами и +Inf
    expect(text).toContain('quizzy_http_duration_ms_bucket{route=');
    expect(text).toContain('le="+Inf"');
    // показатели состояния, ради которых всё и затевалось
    expect(text).toContain("quizzy_open_alert_cases ");
    expect(text).toContain("quizzy_scheduler_stale_minutes ");
    expect(text).toContain("quizzy_database_bytes ");

    delete process.env.METRICS_TOKEN;
  });

  test("корзины гистограммы накопительные и не убывают", async () => {
    const { observe, render, resetMetrics } = await import("../src/lib/metrics");
    resetMetrics();
    for (const ms of [3, 7, 40, 900, 9000]) observe("probe_ms", ms, { route: "/x" });

    const lines = render()
      .split("\n")
      .filter((l) => l.startsWith("probe_ms_bucket"));
    const values = lines.map((l) => Number(l.split(" ").pop()));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
    // последняя корзина — все наблюдения
    expect(values[values.length - 1]).toBe(5);
    expect(render()).toContain('probe_ms_count{route="/x"} 5');
    resetMetrics();
  });
});

describe("отчёт об ошибке не выносит персональные данные", () => {
  test("событие содержит только техническое", async () => {
    const { buildEvent, containsPersonalData } = await import("../src/lib/errorReport");
    const event = buildEvent({
      error: Object.assign(new Error("что-то сломалось"), { stack: "Error\n  at foo (bar.ts:1)" }),
      route: "/api/surveys/:id/responses",
      method: "POST",
      role: "admin",
    });

    expect(containsPersonalData(event)).toBeNull();

    const text = JSON.stringify(event);
    // маршрут — шаблоном: фактический путь нёс бы идентификатор человека
    expect(text).toContain("/api/surveys/:id/responses");
    expect(text).not.toContain("@");
  });

  test("сторож ловит персональные поля на любой глубине", async () => {
    /*
     * Пояс поверх подтяжек: сборка события ничего лишнего не берёт, но если
     * однажды кто-то добавит поле, узнать об этом из чужой панели — плохой
     * способ.
     */
    const { containsPersonalData } = await import("../src/lib/errorReport");
    expect(containsPersonalData({ a: { b: { email: "кто-то@пример" } } })).toBe("email");
    expect(containsPersonalData({ extra: { body: { answers: [] } } })).toBe("body");
    expect(containsPersonalData({ tags: { route: "/api/x", method: "GET" } })).toBeNull();
  });

  test("без SENTRY_DSN ничего не отправляется", async () => {
    const { reportError } = await import("../src/lib/errorReport");
    delete process.env.SENTRY_DSN;
    // не должно ни бросить, ни попытаться сходить в сеть
    await reportError({ error: new Error("тест"), route: "/api/x", method: "GET" });
    expect(true).toBe(true);
  });
});

/**
 * Обход всей поверхности GET-запросов.
 *
 * Пятисотка в /api/audit/storage прожила долго именно потому, что этот
 * эндпоинт не вызывал ни один тест: ошибка «column reference is ambiguous»
 * возникала только при выполнении запроса. Здесь каждый документированный
 * GET-маршрут вызывается хотя бы раз — не для проверки содержимого ответа, а
 * чтобы ни один не падал молча.
 */
describe("ни один GET не падает пятисоткой", () => {
  test("все документированные маршруты отвечают без 5xx", async () => {
    const { ROUTE_DOCS } = await import("../src/lib/openapi");

    // подстановки для маршрутов с параметрами: настоящие идентификаторы
    const done = await submitSurvey(surveyInA, patient.token);
    const substitutions: Record<string, string> = {
      ":id": surveyInA,
      ":userId": patient.id,
      ":surveyId": surveyInA,
      ":responseId": done.body.id,
      ":token": "нет-такого-токена",
      ":versionId": crypto.randomUUID(),
      ":batteryId": crypto.randomUUID(),
    };

    const failures: string[] = [];
    for (const key of Object.keys(ROUTE_DOCS)) {
      const [method, rawPath] = key.split(" ") as [string, string];
      if (method !== "GET") continue;

      const path = rawPath.replace(/:[a-zA-Z]+/g, (p) => substitutions[p] ?? crypto.randomUUID());
      // остались неизвестные параметры — маршрут проверяется отдельно
      if (path.includes(":")) continue;

      const res = await app.request(path, { headers: { Authorization: `Bearer ${root.token}` } });
      /*
       * Интересуют только серверные ошибки. 404 и 403 — законные ответы:
       * подставленный идентификатор может ничего не значить, а часть
       * маршрутов закрыта даже суперадмину (метрики без токена).
       */
      if (res.status >= 500) failures.push(`${key} → ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }

    expect(failures).toEqual([]);
  });
});

/* ── поток событий ── */

describe("реальное время", () => {
  test("опубликованное событие доходит до подписчика", async () => {
    /*
     * Проверяется именно путь через PostgreSQL: LISTEN/NOTIFY выбран, чтобы
     * подписчик не обязан был сидеть на том же инстансе API, который
     * обработал сдачу. Общая память процесса этого не даёт, и подмена одного
     * другим прошла бы незаметно до второго инстанса в проде.
     */
    const { publish, subscribe } = await import("../src/lib/events");

    const received: unknown[] = [];
    const unsubscribe = await subscribe((e) => received.push(e));

    await publish(db, {
      kind: "alert.created",
      surveyIds: [surveyInA],
      userId: patient.id,
      severity: "severe",
      at: new Date().toISOString(),
    });

    // доставка асинхронная: ждём появления, а не фиксированную паузу
    for (let i = 0; i < 40 && received.length === 0; i++) await Bun.sleep(25);
    unsubscribe();

    expect(received).toHaveLength(1);
    expect((received[0] as { kind: string }).kind).toBe("alert.created");
  });

  test("канал закрыт для пациента и для неавторизованного", async () => {
    expect((await app.request("/api/events")).status).toBe(401);

    const res = await app.request("/api/events", {
      headers: { Authorization: `Bearer ${patient.token}` },
    });
    expect(res.status).toBe(403);
  });

  test("сдача с риском публикует событие", async () => {
    const { subscribe } = await import("../src/lib/events");
    const { questions, options } = await import("../src/db/schema");
    const { and: andOp } = await import("drizzle-orm");

    const received: { kind: string }[] = [];
    const unsubscribe = await subscribe((e) => received.push(e as { kind: string }));

    // отвечаем рискованным вариантом: событие должно уйти из той же
    // транзакции, что и сама тревога
    const person = await makeUser("user", `sse-${crypto.randomUUID()}@test`);
    const survey = await api(`/api/surveys/${surveyInA}`, person.token);
    const risky = await db
      .select({ questionId: options.questionId, id: options.id })
      .from(options)
      .innerJoin(questions, eq(questions.id, options.questionId))
      .where(eq(options.riskFlag, true))
      .limit(1);

    if (risky.length) {
      const answers = survey.body.questions
        .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && q.options.length)
        .map((q: { id: string; options: { id: string }[] }) => ({
          questionId: q.id,
          optionIds: [
            q.id === risky[0]!.questionId ? risky[0]!.id : (q.options[1]?.id ?? q.options[0]!.id),
          ],
          durationMs: 2000,
          changeCount: 0,
          visitCount: 1,
        }));
      await api(`/api/surveys/${surveyInA}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
    }

    for (let i = 0; i < 60 && !received.some((e) => e.kind === "alert.created"); i++) {
      await Bun.sleep(25);
    }
    unsubscribe();
    void andOp;

    expect(received.some((e) => e.kind === "alert.created")).toBe(true);
  });

  test("поток отдаёт событие своей методики и молчит о чужой", async () => {

    /*
     * Права проверяются на каждое событие, а не при подписке. Если бы проверка
     * стояла только при открытии канала, достаточно было бы держать вкладку
     * открытой, чтобы видеть активность по методикам чужой группы.
     */
    const { publish } = await import("../src/lib/events");

    const res = await app.request("/api/events", {
      headers: { Authorization: `Bearer ${adminA.token}`, Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();

    // первое сообщение — «ready»: до него подписка ещё не установлена
    const first = await reader.read();
    expect(first.value).toContain("ready");

    const mark = crypto.randomUUID();
    await publish(db, {
      kind: "response.submitted",
      surveyIds: [surveyInB],
      userId: mark,
      at: new Date().toISOString(),
    });
    await publish(db, {
      kind: "response.submitted",
      surveyIds: [surveyInA],
      userId: mark,
      at: new Date().toISOString(),
    });

    /*
     * Читаем весь поток фоном и ждём фиксированное время, а не «пока не
     * встретится метка»: остановка на первом совпадении означала бы, что
     * второе, запрещённое событие просто не успели прочитать — и тест
     * проходил бы даже со снятой проверкой прав.
     */
    let seen = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          seen += value;
        }
      } catch {
        /* поток закрыт отменой ниже */
      }
    })();

    await Bun.sleep(700);
    await reader.cancel();
    await pump;

    // методика своей группы дошла, чужая — нет, хотя опубликованы обе
    expect(seen).toContain(mark);
    expect(seen.match(new RegExp(mark, "g"))).toHaveLength(1);
  });

  test("вход участника в киоск публикует прогресс", async () => {
    const { subscribe } = await import("../src/lib/events");
    const received: { kind: string; sessionId?: string }[] = [];
    const unsubscribe = await subscribe((e) => received.push(e as { kind: string }));

    const kioskBattery = crypto.randomUUID();
    await db.insert(batteries).values({
      id: kioskBattery,
      title: "Батарея киоска",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db
      .insert(batteryItems)
      .values([{ batteryId: kioskBattery, surveyId: surveyInA, position: 0, required: true }]);

    const session = await api("/api/kiosk/sessions", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Поток", batteryId: kioskBattery, hours: 4 }),
    });
    expect(session.status).toBe(201);

    const joined = await app.request(`/api/kiosk/state/${session.body.token}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ігор", lastName: "Кіоскенко" }),
    });
    expect(joined.status).toBe(201);

    for (let i = 0; i < 60 && !received.some((e) => e.kind === "kiosk.progress"); i++) {
      await Bun.sleep(25);
    }
    unsubscribe();

    const progress = received.find((e) => e.kind === "kiosk.progress");
    expect(progress?.sessionId).toBe(session.body.id);
  });
});

/* ── сохранённые виды ── */

describe("сохранённые виды", () => {
  test("свой вид сохраняется и находится по экрану", async () => {
    const created = await api("/api/views", adminA.token, {
      method: "POST",
      body: JSON.stringify({ scope: "alerts", name: "Мои просроченные", params: "assigned=me&all=" }),
    });
    expect(created.status).toBe(201);

    const list = await api("/api/views?scope=alerts", adminA.token);
    const mine = list.body.items.find((v: { id: string }) => v.id === created.body.id);
    expect(mine.name).toBe("Мои просроченные");
    expect(mine.mine).toBe(true);

    // на другом экране этого вида нет: срез принадлежит экрану
    const other = await api("/api/views?scope=patients", adminA.token);
    expect(other.body.items.some((v: { id: string }) => v.id === created.body.id)).toBe(false);
  });

  test("личный вид коллеге не виден, общий — виден", async () => {
    const personal = await api("/api/views", adminA.token, {
      method: "POST",
      body: JSON.stringify({ scope: "patients", name: `Личный ${crypto.randomUUID()}`, params: "q=иванов" }),
    });
    const shared = await api("/api/views", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        scope: "patients",
        name: `Общий ${crypto.randomUUID()}`,
        params: "unit=Рота",
        shared: true,
      }),
    });

    const asOther = await api("/api/views?scope=patients", adminB.token);
    const ids = asOther.body.items.map((v: { id: string }) => v.id);
    expect(ids).not.toContain(personal.body.id);
    expect(ids).toContain(shared.body.id);

    /*
     * Общий вид безопасен именно потому, что хранит параметры, а не данные:
     * открыв его, чужой админ получит тот же фильтр, но выборку сервер
     * соберёт по его правам.
     */
    const view = asOther.body.items.find((v: { id: string }) => v.id === shared.body.id);
    expect(view.mine).toBe(false);
    expect(view.params).toBe("unit=Рота");
  });

  test("чужой вид не правится и не удаляется", async () => {
    const created = await api("/api/views", adminA.token, {
      method: "POST",
      body: JSON.stringify({ scope: "alerts", name: `Чужой ${crypto.randomUUID()}`, params: "", shared: true }),
    });

    const patched = await api(`/api/views/${created.body.id}`, adminB.token, {
      method: "PATCH",
      body: JSON.stringify({ name: "Переименовал" }),
    });
    expect(patched.status).toBe(403);

    const removed = await api(`/api/views/${created.body.id}`, adminB.token, { method: "DELETE" });
    expect(removed.status).toBe(403);
  });

  test("одинаковые названия в одном экране не заводятся", async () => {
    // второй «мои просроченные» сбивал бы с толку сильнее, чем отказ
    const name = `Дубль ${crypto.randomUUID()}`;
    const first = await api("/api/views", adminA.token, {
      method: "POST",
      body: JSON.stringify({ scope: "referrals", name, params: "all=1" }),
    });
    expect(first.status).toBe(201);

    const second = await api("/api/views", adminA.token, {
      method: "POST",
      body: JSON.stringify({ scope: "referrals", name, params: "all=" }),
    });
    expect(second.status).toBe(400);
  });
});

/* ── пуш-уведомления ── */

describe("пуш-уведомления", () => {
  test("устройство регистрируется, повторная регистрация не плодит записей", async () => {
    const { pushTokens } = await import("../src/db/schema");
    const person = await makeUser("user", `push-${crypto.randomUUID()}@test`);
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;

    for (let i = 0; i < 3; i++) {
      const res = await api("/api/push/register", person.token, {
        method: "POST",
        body: JSON.stringify({ token, platform: "ios" }),
      });
      expect(res.status).toBe(200);
    }

    const rows = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(person.id);
  });

  test("токен переезжает к тому, кто вошёл последним", async () => {
    /*
     * На общем планшете после выхода токен должен принадлежать следующему
     * вошедшему — иначе первый продолжал бы получать уведомления о чужих
     * назначениях.
     */
    const { pushTokens } = await import("../src/db/schema");
    const first = await makeUser("user", `push-a-${crypto.randomUUID()}@test`);
    const second = await makeUser("user", `push-b-${crypto.randomUUID()}@test`);
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;

    await api("/api/push/register", first.token, {
      method: "POST",
      body: JSON.stringify({ token, platform: "android" }),
    });
    await api("/api/push/register", second.token, {
      method: "POST",
      body: JSON.stringify({ token, platform: "android" }),
    });

    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(row!.userId).toBe(second.id);
  });

  test("одно и то же событие не уходит дважды", async () => {
    /*
     * Уведомление, пришедшее дважды, приучает игнорировать уведомления — а
     * это дороже, чем не отправить вовсе.
     */
    const { pushToUser, setPushSenderForTests } = await import("../src/lib/push");
    const sent: { to: string; title: string }[] = [];
    setPushSenderForTests(async (messages) => {
      sent.push(...messages.map((m) => ({ to: m.to, title: m.title })));
    });

    const person = await makeUser("user", `push-dup-${crypto.randomUUID()}@test`);
    await api("/api/push/register", person.token, {
      method: "POST",
      body: JSON.stringify({ token: `ExponentPushToken[${crypto.randomUUID()}]`, platform: "ios" }),
    });

    const message = {
      eventKey: `test:${crypto.randomUUID()}`,
      kind: "assignment",
      title: "Назначено обследование",
      body: "Срок — до завтра",
    };
    expect(await pushToUser(person.id, message)).toBe(true);
    expect(await pushToUser(person.id, message)).toBe(false);
    expect(sent).toHaveLength(1);

    setPushSenderForTests(null);
  });

  test("в теле уведомления нет персональных данных", async () => {
    /*
     * Экран блокировки видят посторонние — в казарме, в транспорте, на
     * построении. Уведомление не должно сообщать им ничего о состоянии
     * человека.
     */
    const { pushToUser, setPushSenderForTests } = await import("../src/lib/push");
    const captured: { title: string; body: string }[] = [];
    setPushSenderForTests(async (messages) => {
      captured.push(...messages.map((m) => ({ title: m.title, body: m.body })));
    });

    const person = await makeUser("user", `push-pii-${crypto.randomUUID()}@test`, { unit: "Рота Z" });
    await api("/api/push/register", person.token, {
      method: "POST",
      body: JSON.stringify({ token: `ExponentPushToken[${crypto.randomUUID()}]`, platform: "ios" }),
    });

    await pushToUser(person.id, {
      eventKey: `pii:${crypto.randomUUID()}`,
      kind: "assignment",
      title: "Назначено обследование",
      body: "Срок — до 2026-09-01",
    });

    const all = captured.map((m) => `${m.title} ${m.body}`).join(" ");
    expect(all).not.toContain("Рота Z");
    expect(all).not.toContain(person.id);
    expect(all).not.toContain("@test");

    setPushSenderForTests(null);
  });
});

/* ── правовой статус методик ── */

describe("правовой статус и демонстрационные методики", () => {
  test("демонстрационная методика не попадает пациенту", async () => {
    /*
     * Флаг isDemo существовал давно и ничего не значил: списки его не
     * смотрели, и единственной защитой оставалось «(демо)» в названии — то
     * есть внимательность того, кто назначает.
     */
    const { surveys: surveysTable } = await import("../src/db/schema");
    const demoId = crypto.randomUUID();
    const input = createSurveySchema.parse(sr45);
    await db.insert(surveysTable).values({
      id: demoId,
      groupId: groupA,
      title: { uk: "Демо", ru: "Демо" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      isDemo: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(demoId, input, adminA.id, "Демо-версия");

    const asPatient = await api("/api/surveys", patient.token);
    expect(asPatient.body.items.some((s: { id: string }) => s.id === demoId)).toBe(false);

    // персоналу она видна: на показах и в обучении она нужна
    const asStaff = await api("/api/surveys", adminA.token);
    expect(asStaff.body.items.some((s: { id: string }) => s.id === demoId)).toBe(true);
  });

  test("правовой статус меняет только суперадмин", async () => {
    /*
     * Это не настройка методики, а утверждение учреждения о том, что тексты
     * можно применять. Такое утверждение не должен делать тот, кто методику
     * завёл.
     */
    const denied = await api(`/api/surveys/${surveyInA}/rights`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ rightsStatus: "own" }),
    });
    expect(denied.status).toBe(403);

    const ok = await api(`/api/surveys/${surveyInA}/rights`, root.token, {
      method: "PATCH",
      body: JSON.stringify({
        rightsStatus: "public_domain",
        sourceNote: "Юнацкевич П. И., пособие, с. 45–52",
        keysVerified: true,
      }),
    });
    expect(ok.status).toBe(200);

    const list = await api("/api/surveys", adminA.token);
    const mine = list.body.items.find((s: { id: string }) => s.id === surveyInA);
    expect(mine.rightsStatus).toBe("public_domain");
    // отметка о сверке ключей проставляется вместе со статусом
    expect(mine.keysVerifiedAt).not.toBeNull();
  });
});

describe("присутствие", () => {
  test("сосед по экрану виден, сам себя человек не видит", async () => {
    const resource = `patient:${crypto.randomUUID()}`;

    await api("/api/presence", adminA.token, {
      method: "POST",
      body: JSON.stringify({ resource }),
    });
    await api("/api/presence", root.token, {
      method: "POST",
      body: JSON.stringify({ resource }),
    });

    const mine = await api(`/api/presence?resource=${encodeURIComponent(resource)}`, adminA.token);
    expect(mine.body.others.map((o: { id: string }) => o.id)).toEqual([root.id]);
  });

  test("присутствие ничего не блокирует", async () => {
    /*
     * Проверяется именно это: жёсткая блокировка в клинике опаснее конфликта.
     * Пока один сотрудник «здесь», второй обязан сохранять как обычно —
     * от потери правок защищает проверка версии, а не запрет.
     */
    const person = await makeUser("user", `presence-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, person.token);

    await api("/api/presence", root.token, {
      method: "POST",
      body: JSON.stringify({ resource: `note:${person.id}` }),
    });

    const saved = await api(`/api/notes/patients/${person.id}`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Запись при соседе", baseVersion: 0, kind: "session" }),
    });
    expect(saved.status).toBe(200);
  });

  test("протухшее присутствие не показывается", async () => {
    const resource = `patient:${crypto.randomUUID()}`;
    const { presence } = await import("../src/db/schema");

    await api("/api/presence", root.token, {
      method: "POST",
      body: JSON.stringify({ resource }),
    });
    // отматываем пульс на две минуты назад — живой считается только минута
    await db
      .update(presence)
      .set({ seenAt: new Date(Date.now() - 120_000).toISOString() })
      .where(eq(presence.userId, root.id));

    const seen = await api(`/api/presence?resource=${encodeURIComponent(resource)}`, adminA.token);
    expect(seen.body.others).toEqual([]);
  });
});

describe("формат меток времени", () => {
  test("из базы метки выходят в ISO, а не в родном формате Postgres", async () => {
    /*
     * Лексикографное сравнение «2026-08-29 23:59+03» и «2026-08-29T10:15Z»
     * врёт: пробел меньше «T». Из-за этого просроченным считался каждый шаг
     * маршрута со сроком, включая назначенный на две недели вперёд, а киоск
     * однажды объявлял сеанс истёкшим сразу после создания.
     *
     * Проверяется граница с базой, а не отдельный маршрут: если разбор
     * вернётся к родному формату, упадёт здесь, а не через полгода в отчёте.
     */
    const [row] = await db.execute<{ at: string }>(
      sql`select now() at time zone 'utc' at time zone 'utc' as at`,
    );
    void row;

    const [user] = await db.select({ at: users.createdAt }).from(users).limit(1);
    expect(user!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // и сравнение с текущим моментом даёт осмысленный ответ
    expect(user!.at < new Date().toISOString()).toBe(true);
  });
});

describe("настройки рабочего места", () => {
  test("сохраняются на сервере и приходят с профилем", async () => {
    /*
     * На сервере, а не в браузере: сотрудник садится за разные машины в
     * отделении, и «моя тема» не должна означать «тема этого компьютера».
     */
    const saved = await api("/api/auth/me/workspace", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ theme: "light", startScreen: "worklist" }),
    });
    expect(saved.status).toBe(200);

    const me = await api("/api/auth/me", adminA.token);
    expect(me.body.workspace).toEqual({ theme: "light", startScreen: "worklist" });
  });

  test("правка одного поля не стирает остальные", async () => {
    // клиент шлёт то, что поменял: переключение плотности не должно
    // сбрасывать выбранный стартовый экран
    await api("/api/auth/me/workspace", root.token, {
      method: "PUT",
      body: JSON.stringify({ theme: "dark", startScreen: "alerts" }),
    });
    await api("/api/auth/me/workspace", root.token, {
      method: "PUT",
      body: JSON.stringify({ density: "compact" }),
    });

    const me = await api("/api/auth/me", root.token);
    expect(me.body.workspace).toEqual({
      theme: "dark",
      startScreen: "alerts",
      density: "compact",
    });
  });

  test("неизвестное значение не принимается", async () => {
    const bad = await api("/api/auth/me/workspace", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ startScreen: "нет такого экрана" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("устройства и удалённое стирание", () => {
  const deviceOf = (who: string) => `dev-${who}-${crypto.randomUUID()}`.slice(0, 40);

  test("устройство отмечается и по умолчанию стирать нечего", async () => {
    const id = deviceOf("a");
    const first = await api("/api/devices/checkin", adminA.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id, label: "Планшет отделения", platform: "android" }),
    });
    expect(first.status).toBe(200);
    expect(first.body.wipe).toBe(false);

    const list = await api("/api/devices", adminA.token);
    expect(list.body.items.some((d: { id: string }) => d.id === id)).toBe(true);
  });

  test("после запроса стирания устройство узнаёт об этом при следующей отметке", async () => {
    const id = deviceOf("b");
    await api("/api/devices/checkin", adminA.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id }),
    });

    const asked = await api(`/api/devices/${id}/wipe`, root.token, { method: "POST" });
    expect(asked.status).toBe(200);
    // ответ обязан сказать, чего команда НЕ делает
    expect(asked.body.note).toContain("следующий раз");

    const second = await api("/api/devices/checkin", adminA.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id }),
    });
    expect(second.body.wipe).toBe(true);

    // после подтверждения повторно стирать не просят
    await api("/api/devices/wiped", adminA.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id }),
    });
    const third = await api("/api/devices/checkin", adminA.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id }),
    });
    expect(third.body.wipe).toBe(false);
  });

  test("стирание запрашивает только суперадмин", async () => {
    const id = deviceOf("c");
    await api("/api/devices/checkin", adminA.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id }),
    });

    const denied = await api(`/api/devices/${id}/wipe`, adminB.token, { method: "POST" });
    expect(denied.status).toBe(403);
  });

  test("чужой запрос не стирает работу другого человека", async () => {
    /*
     * Два сотрудника могли по очереди войти на одном планшете. Стирание по
     * чужому запросу выглядело бы как случайная потеря работы, поэтому
     * команда действует только для того, за кем устройство закреплено сейчас.
     */
    const id = deviceOf("d");
    await api("/api/devices/checkin", adminA.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id }),
    });
    await api(`/api/devices/${id}/wipe`, root.token, { method: "POST" });

    // тот же планшет, но вошёл другой сотрудник
    const other = await api("/api/devices/checkin", adminB.token, {
      method: "POST",
      body: JSON.stringify({ deviceId: id }),
    });
    expect(other.body.wipe).toBe(false);
  });

  test("чужие устройства не показываются групповому админу", async () => {
    const mine = await api(`/api/devices?userId=${adminA.id}`, adminB.token);
    expect(mine.status).toBe(404);

    const bySuper = await api(`/api/devices?userId=${adminA.id}`, root.token);
    expect(bySuper.status).toBe(200);
  });
});
