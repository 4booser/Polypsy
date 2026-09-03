import { describe, expect, test } from "bun:test";
import { adminA, and, api, app, createSurveySchema, createVersion, db, eq, groupA, makeUser, patient, responsesTable, root, sr45, submitSurvey, surveyInA, surveys } from "./fixtures";

/* Аналитика: нормы, DIF, калибровка, витрина, отчёты */

/* ── локальные нормы ── */

describe("локальные нормы", () => {
  test("кандидаты считаются по скорректированному баллу; публикация требует N≥30", async () => {
    // surveyInA — СР-45: шкалы ratio, T-баллов нет → кандидатов нет
    const none = await api(`/api/norms/surveys/${surveyInA}/candidates`, adminA.token);
    expect(none.body.scales.length).toBe(0);

    // публикация по несуществующей шкале — отказ
    const bad = await api(`/api/norms/surveys/${surveyInA}/apply`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ scaleCodes: ["Sr"] }),
    });
    expect(bad.status).toBe(400);
  });

  test("на tscore-методике: кандидат появляется, публикация создаёт версию с источником", async () => {
    // мини-методика с tscore-шкалой и 35 прохождениями мужчин
    const { minimult } = await import("../src/instruments/minimult");
    const input = createSurveySchema.parse(minimult);
    const sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "Міні-мульт норм-тест", ru: "Мини-мульт норм-тест" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, input, adminA.id, "v1");

    // 35 прохождений: берём готовый конвейер сдачи от 35 свежих пациентов
    for (let i = 0; i < 35; i++) {
      const person = await makeUser("user", `norm${i}@test.dev`, {
        sex: "male",
        birthDate: "1990-01-01",
        unit: "Норм-рота",
      });
      // ответы различаются между людьми: норма с нулевым разбросом не норма
      const surveyRes = await api(`/api/surveys/${sid}`, person.token);
      const answers = surveyRes.body.questions
        .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
        .map((q: { id: string; options: { id: string }[] }, qi: number) => ({
          questionId: q.id,
          optionIds: [q.options[(i + qi) % q.options.length]!.id],
          durationMs: 1500,
          changeCount: 0,
          visitCount: 1,
        }));
      const res = await api(`/api/surveys/${sid}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
      expect(res.status).toBe(201);
    }

    const cand = await api(`/api/norms/surveys/${sid}/candidates`, adminA.token);
    const hs = cand.body.scales.find((s: { code: string }) => s.code === "Hs");
    expect(hs).toBeDefined();
    const male = hs.candidate.find((g: { sex: string | null }) => g.sex === "male");
    expect(male.n).toBe(35);
    expect(male.publishable).toBe(true);
    expect(male.sd).toBeGreaterThan(0);

    // публикуем локальные нормы для Hs
    const applied = await api(`/api/norms/surveys/${sid}/apply`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ scaleCodes: ["Hs"] }),
    });
    expect(applied.status).toBe(201);

    // новая версия действует: нормы Hs — локальные, остальных шкал — из пособия
    const after = await api(`/api/surveys/${sid}`, adminA.token);
    expect(after.body.versionNumber).toBe(2);
    const hsScale = after.body.scales.find((s: { code: string }) => s.code === "Hs");
    expect(hsScale.norms.some((n: { source: string | null }) => n.source?.includes("локальная выборка, N=35"))).toBe(true);
    const dScale = after.body.scales.find((s: { code: string }) => s.code === "D");
    expect(dScale.norms.every((n: { source: string | null }) => n.source?.includes("Пособие"))).toBe(true);
  }, 60_000); // 35 регистраций с argon2 не укладываются в дефолтные 5 секунд
});

/* ── исследовательский экспорт ── */

describe("профили деидентификации", () => {
  test("deidentified: без имён/подразделений, код субъекта стабилен и необратим", async () => {
    /*
     * Прохождение создаётся здесь же. Выгрузка без единой строки прошла бы
     * все проверки на отсутствие персональных данных — в пустом файле их
     * действительно нет, — и тест выглядел бы зелёным, ничего не проверяя.
     */
    await submitSurvey(surveyInA, patient.token);

    const res = await app.request(
      `/api/spss/surveys/${surveyInA}/data.csv?profile=deidentified`,
      { headers: { Authorization: `Bearer ${adminA.token}` } },
    );
    const csv = await res.text();
    const head = csv.split("\r\n")[0]!;

    expect(head).toContain("subject");
    expect(head).toContain("age_band");
    expect(head).not.toContain("unit");
    expect(head).not.toContain("mil_rank");
    // никаких uuid пациентов и точных дат в теле
    expect(csv).not.toContain(patient.id);
    expect(csv).toMatch(/R[0-9A-F]{10}/);

    // стабильность кода между выгрузками — лонгитюд склеивается
    const res2 = await app.request(
      `/api/spss/surveys/${surveyInA}/data.csv?profile=deidentified`,
      { headers: { Authorization: `Bearer ${adminA.token}` } },
    );
    const code1 = csv.match(/R[0-9A-F]{10}/)![0];
    expect(await res2.text()).toContain(code1);
  });

  test("anonymous: субъекта нет вовсе", async () => {
    const res = await app.request(`/api/spss/surveys/${surveyInA}/data.csv?profile=anonymous`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const head = (await res.text()).split("\r\n")[0]!;
    expect(head).not.toContain("subject");
    expect(head).toContain("age_band");
  });

  test("опечатка в профиле — отказ, а не полная выгрузка", async () => {
    /*
     * Раньше неизвестный профиль молча становился «full». Человек, набравший
     * `deidentifed`, уносил файл с фамилиями, будучи уверен, что забрал
     * обезличенный. Это не пятисотка, это утечка по невнимательности.
     */
    const res = await app.request(`/api/spss/surveys/${surveyInA}/data.csv?profile=deidentifed`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("deidentified"); // отказ называет допустимые значения
  });

  test("неизвестный фасет не подменяется другим разрезом", async () => {
    // молчаливый откат к «пол» нарисовал бы график, подписанный не тем
    const res = await app.request(`/api/facets/surveys/${surveyInA}?facet=подразделение`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    expect(res.status).toBe(400);
  });

  test("codebook перечисляет переменные и происхождение норм", async () => {
    const res = await app.request(`/api/spss/surveys/${surveyInA}/codebook.csv`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const text = await res.text();
    expect(text).toContain("variable;type;label;values");
    expect(text).toContain("scale;normalization;norm_source");
    expect(text).toContain("Sr;ratio");
  });

  test("выгрузка фиксируется в журнале с хэшем датасета", async () => {
    const { auditLog } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "analytics.export"))
      .orderBy(descOp(auditLog.at))
      .limit(1);
    const details = entry!.details as { datasetSha256?: string; profile?: string };
    // последняя data.csv-выгрузка несёт хэш
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "analytics.export"))
      .orderBy(descOp(auditLog.at));
    const withHash = rows.find((r) => (r.details as { datasetSha256?: string }).datasetSha256);
    expect(withHash).toBeDefined();
    expect((withHash!.details as { datasetSha256: string }).datasetSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ── волна 1 расширения: снэпшоты, язык, исход тревоги ── */

describe("снэпшоты стратификации и язык предъявления", () => {
  test("сдача пишет пол, возрастную полосу на момент сдачи и язык", async () => {
    const res = await api(`/api/surveys/${surveyInA}/responses`, patient.token, {
      method: "POST",
      headers: { "Accept-Language": "ru" },
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: (await api(`/api/surveys/${surveyInA}`, patient.token)).body.questions
          .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
          .map((q: { id: string; options: { id: string }[] }) => ({
            questionId: q.id,
            optionIds: [q.options[1]?.id ?? q.options[0]!.id],
            durationMs: 2000,
            changeCount: 0,
            visitCount: 1,
          })),
      }),
    });
    expect(res.status).toBe(201);

    const row = await db.query.responses.findFirst({ where: eq(responsesTable.id, res.body.id) });
    // пациент из фикстур: муж, 1990 г.р. → полоса 35-44 на 2026 год
    expect(row!.respondentSex).toBe("male");
    expect(row!.respondentAgeBand).toBe("35-44");
    expect(row!.lang).toBe("ru");
  });
});

/* ── волна 4: DIF, инвариантность, возрастные кривые ── */

describe("DIF по полу", () => {
  test("подсаженное различие в пункте обнаруживается; остальные пункты — класс A", async () => {
    const { sr45 } = await import("../src/instruments/sr45");
    const input = createSurveySchema.parse(sr45);
    const sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "DIF-тест", ru: "DIF-тест" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, input, adminA.id, "v1");

    const survey = (await api(`/api/surveys/${sid}`, adminA.token)).body;
    const asked = survey.questions.filter(
      (q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length,
    );
    // пункт с подсаженным DIF: женщины отвечают «да» ГОРАЗДО чаще при том же
    // общем уровне — ровно то, что метод обязан заметить
    const difIndex = 5;

    for (let i = 0; i < 120; i++) {
      const sex = i % 2 === 0 ? "male" : "female";
      const person = await makeUser("user", `dif${i}@test.dev`, {
        sex,
        birthDate: sex === "male" ? "1985-01-01" : "1995-01-01",
      });
      // общий уровень черты одинаково распределён между полами
      const level = (i % 10) / 10;
      const answers = asked.map((q: { id: string; options: { id: string; keyCode?: string }[] }, qi: number) => {
        const yes = q.options.find((o) => o.keyCode === "yes") ?? q.options[0]!;
        const no = q.options.find((o) => o.keyCode === "no") ?? q.options[1] ?? q.options[0]!;
        const base = ((qi * 7 + i * 13) % 100) / 100 < level;
        const pick = qi === difIndex ? (sex === "female" ? level > 0.05 : level > 0.85) : base;
        return {
          questionId: q.id,
          optionIds: [pick ? yes.id : no.id],
          durationMs: 1500,
          changeCount: 0,
          visitCount: 1,
        };
      });
      const res = await api(`/api/surveys/${sid}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
      expect(res.status).toBe(201);
    }

    const dif = await api(`/api/dif/surveys/${sid}`, adminA.token);
    expect(dif.status).toBe(200);
    expect(dif.body.sample).toBeGreaterThanOrEqual(120);

    const sexEntries = dif.body.scales.flatMap((s: { items: { position: number; entries: { factor: string; result: { etsClass: string; deltaMH: number } | null }[] }[] }) =>
      s.items.flatMap((i) =>
        i.entries.filter((e) => e.factor === "sex" && e.result).map((e) => ({ position: i.position, ...e })),
      ),
    );
    expect(sexEntries.length).toBeGreaterThan(0);

    // подсаженный пункт (позиция difIndex+1 среди asked) должен быть не-A
    const flagged = sexEntries.filter((e: { result: { etsClass: string } }) => e.result.etsClass !== "A");
    expect(flagged.length).toBeGreaterThan(0);
    const positions = flagged.map((e: { position: number }) => e.position);
    expect(positions).toContain(asked[difIndex]!.position + 1);

    // надёжность посчиталась по обеим половым группам
    const rel = dif.body.reliability.find((r: { code: string }) => r.code === "Sr");
    expect(rel.groups.length).toBe(2);
    expect(rel.groups.every((g: { alpha: number | null }) => g.alpha !== null)).toBe(true);

    // возрастные кривые: два пола по 60 — окно наберётся
    const curves = await api(`/api/norms/surveys/${sid}/age-curves`, adminA.token);
    expect(curves.body.scales.length).toBeGreaterThan(0);
    const withCurve = curves.body.scales[0].bySex.find((b: { enough: boolean }) => b.enough);
    expect(withCurve.points[0].percentiles.length).toBe(5);
    expect(withCurve.points[0].n).toBeGreaterThanOrEqual(30);
  }, 180_000);
});

/* ── волна 6: ROC-калибровка и PPV ── */

describe("калибровка порогов", () => {
  test("guard: мало исходов — кривая не строится, но характеристики порога видны", async () => {
    const res = await api(`/api/calibration/surveys/${surveyInA}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.minPerOutcome).toBe(30);
    // на этой методике исходов почти нет: enough=false, roc=null
    for (const scale of res.body.scales) {
      for (const s of scale.strata) {
        if (!s.enough) expect(s.roc).toBeNull();
      }
    }
  });

  test("при достаточной выборке строится ROC и предлагается порог по Юдену", async () => {
    const { sr45 } = await import("../src/instruments/sr45");
    const { riskAlerts: alertsTable, questions: questionsTable } = await import("../src/db/schema");

    const sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "ROC-тест", ru: "ROC-тест" },
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
    const [anyQuestion] = await db.select().from(questionsTable).limit(1);

    // 80 случаев: чем выше балл, тем чаще исход «подтверждён» —
    // калибровка обязана увидеть в этом сигнал
    for (let i = 0; i < 80; i++) {
      const person = await makeUser("user", `roc${i}@test.dev`, { sex: "male", birthDate: "1990-01-01" });
      const level = i / 80; // 0…1
      const answers = asked.map((q: { id: string; options: { id: string; keyCode?: string }[] }, qi: number) => {
        const yes = q.options.find((o) => o.keyCode === "yes") ?? q.options[0]!;
        const no = q.options.find((o) => o.keyCode === "no") ?? q.options[1] ?? q.options[0]!;
        return {
          questionId: q.id,
          optionIds: [((qi * 13 + i * 7) % 100) / 100 < level ? yes.id : no.id],
          durationMs: 1200,
          changeCount: 0,
          visitCount: 1,
        };
      });
      const res = await api(`/api/surveys/${sid}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
      expect(res.status).toBe(201);

      // исход: у верхней половины по уровню — подтверждён
      await db.insert(alertsTable).values({
        id: crypto.randomUUID(),
        responseId: res.body.id,
        surveyId: sid,
        questionId: anyQuestion!.id,
        userId: person.id,
        label: "калибровочная тревога",
        severity: "severe",
        at: new Date().toISOString(),
        acknowledgedBy: adminA.id,
        acknowledgedAt: new Date().toISOString(),
        outcome: level > 0.5 ? "confirmed" : "not_confirmed",
      });
    }

    const cal = await api(`/api/calibration/surveys/${sid}`, adminA.token);
    expect(cal.body.cases).toBeGreaterThanOrEqual(80);

    const sr = cal.body.scales.find((s: { code: string }) => s.code === "Sr");
    const all = sr.strata.find((s: { stratum: string }) => s.stratum === "вся выборка");
    expect(all.confirmed).toBeGreaterThanOrEqual(30);
    expect(all.notConfirmed).toBeGreaterThanOrEqual(30);
    expect(all.enough).toBe(true);
    // связь балла с исходом заложена — AUC обязан быть заметно выше случайного
    expect(all.roc.auc).toBeGreaterThan(0.75);
    expect(all.roc.bestThreshold).toBeGreaterThan(0);
    expect(all.currentSensitivity).not.toBeNull();

    // «требует наблюдения» не попадает ни в одну сторону
    const before = cal.body.cases;
    const extra = await makeUser("user", "followup@test.dev", { sex: "male", birthDate: "1990-01-01" });
    const extraRes = await submitSurvey(sid, extra.token);
    await db.insert(alertsTable).values({
      id: crypto.randomUUID(),
      responseId: extraRes.body.id,
      surveyId: sid,
      questionId: anyQuestion!.id,
      userId: extra.id,
      label: "отложенное решение",
      severity: "severe",
      at: new Date().toISOString(),
      acknowledgedBy: adminA.id,
      acknowledgedAt: new Date().toISOString(),
      outcome: "needs_followup",
    });
    const after = await api(`/api/calibration/surveys/${sid}`, adminA.token);
    expect(after.body.cases).toBe(before);

    // PPV: сводка видит подтверждённые и считает долю
    const ppv = await api("/api/calibration/ppv", adminA.token);
    expect(ppv.body.overall.n).toBeGreaterThanOrEqual(80);
    expect(ppv.body.overall.ppv).toBeGreaterThan(0);
    expect(ppv.body.withoutOutcome).toBeGreaterThanOrEqual(1); // тот самый needs_followup
    expect(ppv.body.byMonth.length).toBeGreaterThan(0);
  }, 120_000);
});

/* ── этап 8: витрина, фасеты, кэш, long-format ── */

describe("витрина фактов и фасеты", () => {
  test("фасет по полу режет метрики; страты меньше 5 подавлены", async () => {
    const res = await api(`/api/facets/surveys/${surveyInA}?facet=sex`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.smallCellFloor).toBe(5);
    for (const scale of res.body.scales) {
      for (const s of scale.strata) {
        expect(s.n).toBeGreaterThanOrEqual(5);
        /*
         * Доля риска — либо число, либо прочерк, и прочерк не оплошность.
         *
         * Порог раньше применялся к размеру страты, но не к числу людей в
         * риске внутри неё: страта из пяти с одним в риске отдавала
         * riskShare 20, и этот один вычислялся точно — n × share / 100.
         * Скрывается и обратный край: «четверо из пяти» так же однозначно
         * называет пятого.
         */
        if (s.riskShare !== null) {
          expect(s.riskShare).toBeGreaterThanOrEqual(0);
          const inRisk = Math.round((s.riskShare * s.n) / 100);
          expect(inRisk, "доля показана, а по ней восстанавливается один человек").toBeGreaterThanOrEqual(5);
          expect(s.n - inRisk, "доля показана, а по ней восстанавливается один человек").toBeGreaterThanOrEqual(5);
        }
      }
    }
  });

  test("витрина видит те же прохождения, что и живые таблицы", async () => {
    const { sql } = await import("drizzle-orm");
    const [viaFacts] = await db.execute(sql`
      select count(distinct response_id)::int n from response_facts
      where survey_id = ${surveyInA} and status = 'completed'`);
    const [viaTables] = await db.execute(sql`
      select count(distinct r.id)::int n from responses r
      join response_scores s on s.response_id = r.id
      where r.survey_id = ${surveyInA} and r.status = 'completed'`);
    expect((viaFacts as { n: number }).n).toBe((viaTables as { n: number }).n);
  });

  test("кэш отдаёт то же и инвалидируется новой сдачей", async () => {
    const { clearAnalyticsCache } = await import("../src/lib/analyticsCache");
    clearAnalyticsCache();

    const first = await api(`/api/dif/surveys/${surveyInA}`, adminA.token);
    const cachedRes = await api(`/api/dif/surveys/${surveyInA}`, adminA.token);
    expect(cachedRes.body.sample).toBe(first.body.sample);

    // новая сдача меняет отпечаток — выборка в ответе обязана вырасти
    await submitSurvey(surveyInA, patient.token);
    const afterSubmit = await api(`/api/dif/surveys/${surveyInA}`, adminA.token);
    expect(afterSubmit.body.sample).toBe(first.body.sample + 1);
  });
});

describe("long-format экспорт", () => {
  test("строка на пару «прохождение × шкала», страты в файле, профиль соблюдается", async () => {
    const res = await app.request(`/api/spss/surveys/${surveyInA}/long.csv?profile=deidentified`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    const header = lines[0]!;

    expect(header).toContain("scale");
    expect(header).toContain("sex");
    expect(header).toContain("age_band");
    expect(header).not.toContain("unit"); // деидентифицированный профиль
    expect(csv).not.toContain(patient.id);
    expect(lines.length).toBeGreaterThan(1);

    // полный профиль отдаёт подразделение и точную дату
    const full = await app.request(`/api/spss/surveys/${surveyInA}/long.csv`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const fullHeader = (await full.text()).split("\r\n")[0]!;
    expect(fullHeader).toContain("unit");
    expect(fullHeader).toContain("submitted_at");
  });
});

describe("отчёт по подразделению", () => {
  test("считает охват и распределение", async () => {
    const res = await api(`/api/unit-report?unit=${encodeURIComponent("Рота А")}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.unit).toBe("Рота А");
    expect(typeof res.body.coverage).toBe("number");
    expect(Array.isArray(res.body.scales)).toBe(true);
  });

  test("малые ячейки подавляются, а не показываются нулём", async () => {
    /*
     * В роте на двенадцать человек строка «выраженная: 1» указывает на
     * конкретного, и по ней его узнают сослуживцы. Подавление — не
     * формальность: ноль читался бы как «таких нет», поэтому в подавленной
     * ячейке именно null.
     */
    const res = await api(`/api/unit-report?unit=${encodeURIComponent("Рота А")}`, adminA.token);
    expect(res.body.smallCellFloor).toBe(5);

    for (const scale of res.body.scales as { total: number; breakdown: { count: number | null }[] }[]) {
      // шкала попадает в отчёт только если наблюдений хватает
      expect(scale.total).toBeGreaterThanOrEqual(5);
      for (const cell of scale.breakdown) {
        // либо ноль, либо не меньше порога, либо скрыто
        expect(cell.count === null || cell.count === 0 || cell.count >= 5).toBe(true);
      }
    }
  });

  test("подразделение обязательно — отчёт «по всем» это не отчёт", async () => {
    expect((await api("/api/unit-report", adminA.token)).status).toBe(400);
  });

  test("чтение отчёта фиксируется в журнале", async () => {
    await api(`/api/unit-report?unit=${encodeURIComponent("Рота А")}`, adminA.token);
    const { auditLog } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, adminA.id))
      .orderBy(descOp(auditLog.at))
      .limit(1);
    expect(entry!.action).toBe("report.unit");
  });
});

describe("воспроизводимость выгрузки", () => {
  test("манифест перечисляет версии, нормы и профиль", async () => {
    /*
     * Хэш датасета отвечает на «та ли это выгрузка», но не на «как её
     * повторить». Через год, когда попросят пересчитать, восстанавливать
     * версии и нормы будет неоткуда.
     */
    const res = await api(
      `/api/spss/surveys/${surveyInA}/manifest.json?profile=deidentified&purpose=Диссертация`,
      adminA.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("deidentified");
    expect(res.body.purpose).toBe("Диссертация");
    expect(res.body.versions.length).toBeGreaterThan(0);
    expect(res.body.norms.length).toBeGreaterThan(0);
    // в манифесте нет ни одной строки данных
    expect(JSON.stringify(res.body)).not.toContain("respondent_id");
  });

  test("версии перечислены все, включая те, которыми никто не проходил", async () => {
    // «этой версией никто не проходил» — тоже факт, и его иначе не восстановить
    const res = await api(`/api/spss/surveys/${surveyInA}/manifest.json`, adminA.token);
    for (const v of res.body.versions) {
      expect(typeof v.responses).toBe("number");
    }
  });

  test("цель выгрузки попадает в журнал", async () => {
    /*
     * «Кто и когда» без «зачем» не отвечает ни на один вопрос разбора через
     * год.
     */
    await api(`/api/spss/surveys/${surveyInA}/data.csv?purpose=Проверка+журнала`, adminA.token);

    const log = await api("/api/audit?action=analytics.export&limit=20", root.token);
    const entry = log.body.entries.find(
      (e: { action: string; details?: { purpose?: string } }) =>
        e.action === "analytics.export" && e.details?.purpose === "Проверка журнала",
    );
    expect(entry).toBeTruthy();
  });

  test("скрипт загрузки объявляет категориальные переменные факторами", async () => {
    /*
     * Иначе порядковые коды вариантов попадут в модель как числа, и «вариант
     * 3» окажется втрое больше «варианта 1». Это тихая ошибка: анализ
     * посчитается и даст неверный результат.
     */
    // ответ текстовый, а не JSON: берём его напрямую
    const script = async (ext: string) => {
      const res = await app.request(`/api/spss/surveys/${surveyInA}/load/${ext}`, {
        headers: { Authorization: `Bearer ${adminA.token}` },
      });
      expect(res.status).toBe(200);
      return res.text();
    };

    const r = await script("r");
    expect(r).toContain("factor(");
    expect(r).toContain("UTF-8-BOM");

    const py = await script("py");
    expect(py).toContain('astype("category")');
    expect(py).toContain("utf-8-sig");
  });
});

describe("k-анонимность выгрузки", () => {
  test("обезличенная выгрузка не отдаёт одиночные сочетания пола и возраста", async () => {
    /*
     * Обезличивание убирает имя и подразделение, но пол и возрастная полоса
     * остаются. В выборке на сорок человек «женщина, 45 и старше» может
     * оказаться единственной — и тот, кто знает подразделение, узнает её по
     * одной строке. Стабильный код субъекта делает узнавание переносимым
     * между выгрузками.
     */
    const survey = crypto.randomUUID();
    await db.insert(surveys).values({
      id: survey,
      groupId: groupA,
      title: { uk: "К-анонімність", ru: "K-анонимность" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(survey, createSurveySchema.parse(sr45), adminA.id, "v1");

    // двенадцать мужчин до 25 и одна женщина 45+
    for (let i = 0; i < 12; i++) {
      const p = await makeUser("user", `kan-m-${crypto.randomUUID()}@test`, {
        sex: "male",
        birthDate: "2004-01-01",
      });
      await submitSurvey(survey, p.token);
    }
    const rare = await makeUser("user", `kan-f-${crypto.randomUUID()}@test`, {
      sex: "female",
      birthDate: "1970-01-01",
    });
    await submitSurvey(survey, rare.token);

    const res = await app.request(`/api/spss/surveys/${survey}/data.csv?profile=deidentified`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    const head = lines[0]!.split(",");
    const sexAt = head.indexOf("sex");
    const bandAt = head.indexOf("age_band");
    expect(sexAt).toBeGreaterThanOrEqual(0);

    /*
     * Ни одно сочетание не должно встречаться реже пяти раз — кроме
     * полностью стёртого: по «пол неизвестен, возраст неизвестен» не узнают
     * никого.
     */
    const counts = new Map<string, number>();
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      const key = `${cells[sexAt]}|${cells[bandAt]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, n] of counts) {
      if (key === "-99|-99") continue;
      expect(n).toBeGreaterThanOrEqual(5);
    }

    // и редкая строка из выгрузки не пропала: баллы ради них и выгружают
    expect(lines.length - 1).toBe(13);
  });

  test("манифест объясняет, что пропуски не случайны", async () => {
    /*
     * Иначе исследователь увидит пропуски в поле «пол» и обработает их как
     * случайные — а пропущено ровно то, что было редким.
     */
    const res = await api(
      `/api/spss/surveys/${surveyInA}/manifest.json?profile=deidentified`,
      adminA.token,
    );
    expect(res.body.kanon).toBeTruthy();
    expect(res.body.kanon.note).toContain("не случайны");
    expect(res.body.kanon.k).toBe(5);
  });

  test("полный профиль k-анонимность не трогает", async () => {
    // он и не притворяется обезличенным: там есть имя и подразделение
    const res = await api(`/api/spss/surveys/${surveyInA}/manifest.json`, adminA.token);
    expect(res.body.kanon).toBeNull();
  });
});
