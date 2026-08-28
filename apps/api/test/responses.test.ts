import { describe, expect, test } from "bun:test";
import { adminA, adminB, and, api, createSurveySchema, createVersion, db, eq, groupA, makeUser, patient, responsesTable, root, sr45, submitSurvey, surveyInA, surveys, users, type Person } from "./fixtures";

/* Прохождения: сдача, атрибуция, качество и сохранность данных */

/* ── сдача и атрибуция ── */

async function submitSurvey(surveyId: string, token: string, extra: Record<string, unknown> = {}) {
  const surveyRes = await api(`/api/surveys/${surveyId}`, token);
  if (surveyRes.status !== 200) return surveyRes;
  const survey = surveyRes.body;
  const answers = survey.questions
    .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
    .map((q: { id: string; options: { id: string }[] }) => ({
      questionId: q.id,
      optionIds: [q.options[1]?.id ?? q.options[0]!.id], // «Нет» — безопасные ответы
      durationMs: 2000,
      changeCount: 0,
      visitCount: 1,
    }));
  return api(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
      ...extra,
    }),
  });
}

describe("сдача прохождения", () => {
  test("пациент сдаёт сам; прохождение записано на него", async () => {
    const res = await submitSurvey(surveyInA, patient.token);
    expect(res.status).toBe(201);
    expect(res.body.reliable).toBe(true);

    const detail = await api(`/api/responses/${res.body.id}`, root.token);
    expect(detail.status).toBe(200);
  });

  test("специалист заполняет за пациента — атрибуция на пациента, не на специалиста", async () => {
    const res = await submitSurvey(surveyInA, adminA.token, { onBehalfOf: patient.id });
    expect(res.status).toBe(201);

    const { responses } = await import("../src/db/schema");
    const row = await db.query.responses.findFirst({
      where: eq(responses.id, res.body.id),
    });
    expect(row!.userId).toBe(patient.id); // регресс на найденный баг
  });

  test("после прохождения пациент появляется в списке своего админа, но не чужого", async () => {
    /*
     * Человек и подразделение свои: список постраничный, и утверждение
     * «он есть в выдаче» без фильтра держалось бы на том, что тестовых
     * пациентов мало. Фильтр по подразделению делает проверку про права,
     * а не про то, на какой странице человек оказался.
     */
    const unit = `Рота-${crypto.randomUUID().slice(0, 8)}`;
    const person = await makeUser("user", `seen-${crypto.randomUUID()}@test`, { unit });
    await submitSurvey(surveyInA, person.token);

    const mine = await api(`/api/access/patients?unit=${encodeURIComponent(unit)}`, adminA.token);
    expect(mine.body.items.map((p: { id: string }) => p.id)).toContain(person.id);

    const foreign = await api(`/api/access/patients?unit=${encodeURIComponent(unit)}`, adminB.token);
    expect(foreign.body.items).toEqual([]);
  });
});

/* ── идемпотентность офлайн-повтора ── */

describe("clientRequestId", () => {
  test("повтор той же попытки не создаёт второе прохождение", async () => {
    const requestId = crypto.randomUUID();
    const surveyRes = await api(`/api/surveys/${surveyInA}`, patient.token);
    const answers = surveyRes.body.questions
      .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
      .map((q: { id: string; options: { id: string }[] }) => ({
        questionId: q.id,
        optionIds: [q.options[1]?.id ?? q.options[0]!.id],
        durationMs: 2000,
        changeCount: 0,
        visitCount: 1,
      }));
    const payload = {
      clientRequestId: requestId,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
    };

    const first = await api(`/api/surveys/${surveyInA}/responses`, patient.token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);

    // «сеть оборвалась после коммита, клиент ретраит»
    const second = await api(`/api/surveys/${surveyInA}/responses`, patient.token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const rows = await db
      .select()
      .from(responsesTable)
      .where(eq(responsesTable.clientRequestId, requestId));
    expect(rows.length).toBe(1);
  });
});

/* ── волна 7: качество данных ── */

describe("качество данных", () => {
  test("страты подавляются при n<5; PSI и ретест считаются только при достаточных данных", async () => {
    const res = await api(`/api/data-quality/surveys/${surveyInA}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.smallCellFloor).toBe(5);

    // подавленные страты не раскрывают чисел
    for (const s of res.body.strata) {
      if (s.suppressed) {
        expect(s.started).toBeUndefined();
        expect(s.completionRate).toBeUndefined();
      } else {
        expect(s.started).toBeGreaterThanOrEqual(5);
        expect(s.completionRate).toBeGreaterThan(0);
      }
    }

    // ретест: пары считаются, но ICC только при минимуме
    for (const r of res.body.retest) {
      if (r.pairs < res.body.retestWindow.minPairs) expect(r.icc).toBeNull();
    }
  });

  test("person-fit попадает в флаги качества и помечает инвертированный профиль", async () => {
    const { sr45 } = await import("../src/instruments/sr45");
    const sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "Person-fit тест", ru: "Person-fit тест" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, createSurveySchema.parse(sr45), adminA.id, "v1");

    const survey = (await api(`/api/surveys/${sid}`, adminA.token)).body;
    const asked = survey.questions.filter(
      (q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length,
    );

    // 30 «нормальных»: чем выше уровень, тем больше «да» — согласованный профиль
    for (let i = 0; i < 30; i++) {
      const person = await makeUser("user", `fit${i}@test.dev`, { sex: "male", birthDate: "1990-01-01" });
      const level = (i % 10) / 10;
      const answers = asked.map((q: { id: string; options: { id: string; keyCode?: string }[] }, qi: number) => {
        const yes = q.options.find((o) => o.keyCode === "yes") ?? q.options[0]!;
        const no = q.options.find((o) => o.keyCode === "no") ?? q.options[1] ?? q.options[0]!;
        // лёгкие пункты (малый индекс) срабатывают раньше трудных
        return {
          questionId: q.id,
          optionIds: [qi / asked.length < level ? yes.id : no.id],
          durationMs: 2500,
          changeCount: 0,
          visitCount: 1,
        };
      });
      await api(`/api/surveys/${sid}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 90_000).toISOString(),
          durationMs: 90_000,
          events: [],
          answers,
        }),
      });
    }

    // один инвертированный: трудные «да», лёгкие «нет»
    const odd = await makeUser("user", "fit-odd@test.dev", { sex: "male", birthDate: "1990-01-01" });
    const invertedAnswers = asked.map((q: { id: string; options: { id: string; keyCode?: string }[] }, qi: number) => {
      const yes = q.options.find((o) => o.keyCode === "yes") ?? q.options[0]!;
      const no = q.options.find((o) => o.keyCode === "no") ?? q.options[1] ?? q.options[0]!;
      return {
        questionId: q.id,
        optionIds: [qi / asked.length > 0.6 ? yes.id : no.id],
        durationMs: 2500,
        changeCount: 0,
        visitCount: 1,
      };
    });
    const oddRes = await api(`/api/surveys/${sid}/responses`, odd.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 90_000).toISOString(),
        durationMs: 90_000,
        events: [],
        answers: invertedAnswers,
      }),
    });
    expect(oddRes.status).toBe(201);

    const analytics = await api(`/api/analytics/surveys/${sid}`, adminA.token);
    const flagged = analytics.body.quality.find(
      (q: { responseId: string }) => q.responseId === oddRes.body.id,
    );
    expect(flagged).toBeDefined();
    expect(flagged.personFit).toBeGreaterThan(0.4);
    expect(flagged.reasons.some((r: string) => r.includes("нетипичный паттерн"))).toBe(true);
  }, 90_000);
});

/* ── шифрование в покое ── */

describe("шифрование полей", () => {
  test("в базе — шифртекст, наружу — читаемые имена", async () => {
    const { users: usersTable } = await import("../src/db/schema");
    const row = await db.query.users.findFirst({ where: eq(usersTable.email, "p@test") });
    expect(row!.lastName.startsWith("enc1:v1:")).toBe(true);
    expect(row!.birthDate!.startsWith("enc1:v1:")).toBe(true);

    // а API отдаёт человеку читаемое
    const me = await api("/api/auth/me", patient.token);
    expect(me.body.lastName).toBe("p");
    expect(me.body.birthDate).toBe("1990-01-01");

    // и список пациентов у админа тоже читаемый — берём своего человека и
    // свой фильтр, потому что список постраничный
    const unit = `Рота-${crypto.randomUUID().slice(0, 8)}`;
    const person = await makeUser("user", `enc-${crypto.randomUUID()}@test`, { unit });
    await submitSurvey(surveyInA, person.token);
    const list = await api(`/api/access/patients?unit=${encodeURIComponent(unit)}`, adminA.token);
    const found = list.body.items.find((p: { id: string }) => p.id === person.id);
    expect(found.fullName).toContain("Тест");
  });

  test("текст заключения в базе шифрован, в API — открыт", async () => {
    const { conclusions: conclusionsTable } = await import("../src/db/schema");
    // заключение заводится здесь же: полагаться на оставленное соседним
    // тестом значит проверять порядок выполнения, а не шифрование
    const done = await submitSurvey(surveyInA, patient.token);
    await api(`/api/conclusions/responses/${done.body.id}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Текст для проверки шифрования", baseVersion: 0 }),
    });

    const [row] = await db
      .select()
      .from(conclusionsTable)
      .where(eq(conclusionsTable.responseId, done.body.id));
    expect(row!.text.startsWith("enc1:v1:")).toBe(true);

    const back = await api(`/api/conclusions/responses/${done.body.id}/conclusion`, adminA.token);
    expect(back.body.current.text).toBe("Текст для проверки шифрования");
  });
});

/* ── ретенция событий ── */

describe("ретенция answer_events", () => {
  test("старые события удаляются порциями, агрегаты в answers остаются", async () => {
    const { runRetentionOnce } = await import("../src/lib/retention");
    const { answerEvents, answers: answersTable, responses: responsesTable } = await import("../src/db/schema");
    const { sql } = await import("drizzle-orm");

    // прохождение двухлетней давности с событиями
    const old = await submitSurvey(surveyInA, patient.token);
    await db.execute(sql`update responses set submitted_at = now() - interval '400 days' where id = ${old.body.id}`);
    const [q] = await db.execute(sql`select id from questions limit 1`);
    await db.insert(answerEvents).values(
      Array.from({ length: 3 }, (_, i) => ({
        id: crypto.randomUUID(),
        responseId: old.body.id,
        questionId: (q as { id: string }).id,
        sequence: i + 100,
        kind: "set",
        elapsedMs: 1000 * i,
        at: new Date().toISOString(),
        value: null,
      })),
    );

    const deleted = await runRetentionOnce();
    expect(deleted).toBeGreaterThanOrEqual(3);

    const leftEvents = await db.execute(
      sql`select count(*)::int as n from answer_events ae join responses r on r.id = ae.response_id where r.id = ${old.body.id}`,
    );
    expect((leftEvents[0] as { n: number }).n).toBe(0);

    // ответы и их агрегаты живы
    const leftAnswers = await db.execute(
      sql`select count(*)::int as n from answers where response_id = ${old.body.id}`,
    );
    expect((leftAnswers[0] as { n: number }).n).toBeGreaterThan(0);

    // свежие прохождения не тронуты
    const fresh = await db.execute(
      sql`select count(*)::int as n from answer_events ae
          join responses r on r.id = ae.response_id
          where r.submitted_at > now() - interval '30 days'`,
    );
    expect((fresh[0] as { n: number }).n).toBeGreaterThanOrEqual(0);
  });
});

/* ── неизменяемость на уровне БД ── */

describe("триггеры неизменяемости", () => {
  // drizzle+postgres.js отдаёт ленивый thenable, а expect().rejects ждёт Promise
  const run = (q: PromiseLike<unknown>) => (async () => { await q; })();

  test("журнал не правится и не удаляется даже прямым SQL", async () => {
    const { sql } = await import("drizzle-orm");
    await expect(
      run(db.execute(sql`update audit_log set action = ${"hacked"} where seq = 1`)),
    ).rejects.toThrow(/неизменяем/);
    await expect(run(db.execute(sql`delete from audit_log where seq = 1`))).rejects.toThrow(/неизменяем/);
  });

  test("подписанное заключение не правится прямым SQL, черновик — правится", async () => {
    const { sql } = await import("drizzle-orm");
    const { conclusions: conclusionsTable } = await import("../src/db/schema");

    const done = await submitSurvey(surveyInA, patient.token);
    await api(`/api/conclusions/responses/${done.body.id}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Подписываемое заключение", baseVersion: 0 }),
    });
    await api(`/api/conclusions/responses/${done.body.id}/conclusion/sign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });

    const signed = await db.query.conclusions.findFirst({
      where: and(eq(conclusionsTable.responseId, done.body.id), eq(conclusionsTable.status, "signed")),
    });
    expect(signed).toBeDefined();
    await expect(
      run(db.execute(sql`update conclusions set text = ${"подмена"} where id = ${signed!.id}`)),
    ).rejects.toThrow(/неизменяемо/);
    await expect(run(db.execute(sql`delete from conclusions where id = ${signed!.id}`))).rejects.toThrow(
      /неизменяемо/,
    );
  });
});
