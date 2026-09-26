import { beforeAll, describe, expect, test } from "bun:test";
import { percentileOf } from "../src/lib/norms";
import { durationBins, weekOf, weeklyMeans } from "../src/lib/stats";
import { adminA, adminB, and, api, app, createSurveySchema, createVersion, db, eq, groupA, makeUser, patient, responsesTable, root, sql, sr45, submitSurvey, surveyInA, surveys } from "./fixtures";

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

/* ── волна 6: ROC-калибровка и PPV ── */

/* ── этап 8: витрина, фасеты, кэш, long-format ── */

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

describe("однородность величин", () => {
  test("перцентиль считается по тому же, из чего набрана выборка", () => {
    /*
     * Выборка набирается из нормированных значений (стены, T-баллы, доли),
     * а перцентиль запрашивался для сырого балла. Для МЛО это сырой 0–57
     * против стенов 1–10: пациент со стеном 1 — «крайне низкий уровень»,
     * группа риска — имел сырой балл выше любого стена в выборке и получал
     * перцентиль около ста. Худший результат показывался как лучший.
     *
     * Проверяется на числах, а не через маршрут: беда здесь чисто
     * арифметическая, и показать её нагляднее всего арифметикой.
     */
    // выборка не меньше порога, иначе перцентиль честно не считается вовсе
    const stens = [3, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9];
    const rawOfWorstPatient = 57; // сырой балл, соответствующий стену 1
    const stenOfWorstPatient = 1;

    expect(percentileOf(rawOfWorstPatient, stens), "сырой балл против стенов").toBe(100);
    expect(percentileOf(stenOfWorstPatient, stens), "стен против стенов").toBe(0);
  });
});

/* ── степени выраженности по неделям ── */

describe("ряд выраженности по неделям", () => {
  /*
   * Ряд отвечает на вопрос, на который не отвечает кольцо сводки: не
   * «сколько тяжёлых всего», а «становится ли их больше». Проверяется здесь
   * ровно то, из-за чего ответ может оказаться неверным, — способ счёта, а не
   * форма ответа.
   */

  test("прохождение считается один раз, а не по разу на каждую свою шкалу", async () => {
    await submitSurvey(surveyInA, patient.token);
    const res = await api("/api/analytics/severity-trend", root.token);
    expect(res.status).toBe(200);

    const weeks = res.body.weeks as { none: number; mild: number; moderate: number; severe: number }[];
    const counted =
      weeks.reduce((s, w) => s + w.none + w.mild + w.moderate + w.severe, 0) + (res.body.unbanded as number);

    /*
     * Столько же, сколько завершённых прохождений за период, — и меньше, чем
     * строк баллов с интерпретацией. Вторая половина и есть суть проверки: у
     * СР-45 две шкалы, у мини-мульта одиннадцать, и счёт по шкалам вместо
     * прохождений дал бы методике с одиннадцатью субшкалами вес одиннадцати
     * коротких скринингов.
     */
    const [totals] = [
      ...(await db.execute<{ responses: number; scored: number } & Record<string, unknown>>(sql`
        select
          count(distinct r.id)::int as responses,
          count(rs.id) filter (where rs.severity is not null and sc.kind = 'clinical')::int as scored
        from responses r
        left join response_scores rs on rs.response_id = r.id
        left join scales sc on sc.id = rs.scale_id
        where r.status = 'completed'
          and r.submitted_at is not null
          and r.submitted_at >= date_trunc('week', now()) - interval '25 weeks'
      `)),
    ];

    expect(counted).toBe(Number(totals!.responses));
    expect(Number(totals!.scored)).toBeGreaterThan(counted);
  });

  test("недели идут подряд, без пропусков посередине", async () => {
    /*
     * Пропущенная неделя в области рисуется прямой от соседа к соседу, то
     * есть показывает поток обследований там, где его не было. Ноль должен
     * приходить нулём, а не отсутствием точки.
     */
    const res = await api("/api/analytics/severity-trend", adminA.token);
    const weeks = res.body.weeks as { week: string }[];
    for (let i = 1; i < weeks.length; i++) {
      const previous = new Date(`${weeks[i - 1]!.week}T00:00:00Z`).getTime();
      const current = new Date(`${weeks[i]!.week}T00:00:00Z`).getTime();
      expect(current - previous).toBe(7 * 86_400_000);
    }
  });

  test("пациент к ряду не допущен", async () => {
    // счётчики обезличены, но это всё равно сводка по чужим обследованиям
    const res = await api("/api/analytics/severity-trend", patient.token);
    expect(res.status).toBe(403);
  });
});

/*
 * Срезы: скрытое не восстанавливается вычитанием.
 *
 * Проверка ходит через маршрут, а не через функцию подавления: у функции
 * свои проверки (privacy.test.ts), а здесь важна проводка. Она уже была
 * снята однажды — фильтром «n >= порога» прямо в маршруте, — и ни один тест
 * этого не заметил.
 */
describe("срезы не называют человека остатком", () => {
  let facetSurvey: string;

  beforeAll(async () => {
    const { surveys: surveysTable } = await import("../src/db/schema");
    facetSurvey = crypto.randomUUID();
    await db.insert(surveysTable).values({
      id: facetSurvey,
      groupId: groupA,
      title: { uk: "Методика для зрізів", ru: "Методика для срезов" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(facetSurvey, createSurveySchema.parse(sr45), adminA.id, "Версия срезов");

    /*
     * Шесть мужчин, шесть женщин и ОДНА женщина без указанного возраста —
     * то есть страта из одного человека. Ровно тот случай, ради которого
     * порог и заводился: показать её нельзя, а скрыть одну — значит назвать
     * её размер вычитанием.
     */
    const sexes = [
      ...Array(6).fill("male"),
      ...Array(6).fill("female"),
      null,
    ] as (string | null)[];
    for (const [i, sex] of sexes.entries()) {
      const person = await makeUser("user", `facet${i}-${crypto.randomUUID().slice(0, 8)}@test.dev`, { sex });
      await submitSurvey(facetSurvey, person.token);
    }
  });

  test("единственная малая страта не вычисляется из показанных", async () => {
    const res = await api(`/api/facets/surveys/${facetSurvey}?facet=sex`, adminA.token);
    expect(res.status).toBe(200);

    const scale = res.body.scales[0];
    expect(scale, "срезы пусты — проверять нечего").toBeTruthy();

    /*
     * Считаем по ОПУБЛИКОВАННЫМ стратам, а не по полю suppressedStrata.
     *
     * Первая редакция проверяла именно поле — и оказалась пустой: снятое
     * подавление меняет список страт, а счётчик остаётся прежним. Тест
     * сторожил подпись под данными вместо самих данных и не заметил, как
     * фильтр вернули к «n >= порога».
     */
    const shown: number[] = scale.strata.map((s: { n: number }) => s.n);
    const SEEDED_STRATA = 3; // мужчины, женщины и один без указанного пола
    expect(
      SEEDED_STRATA - scale.strata.length,
      `опубликовано ${scale.strata.length} страты из ${SEEDED_STRATA}: скрыта одна, и её размер — это остаток`,
    ).toBeGreaterThan(1);

    // и сам остаток не называет никого: он делится минимум между двумя
    const rest = 13 - shown.reduce((sum, n) => sum + n, 0);
    expect(rest, "остаток пуст — скрытых страт нет вовсе, посев не сработал").toBeGreaterThan(0);
  });
});

/*
 * Вкладка «Тести» раздела «Аналітика»: срез по человеку и по группе, недели
 * общего состояния, корзины длительности, матрица ответов одного человека.
 *
 * Проверяется то, из-за чего экран может соврать молча: чужой срез,
 * малая неделя, выданная за состояние, последний пункт, выданный за место
 * обрыва, и чтение одного человека без следа в журнале.
 */
describe("аналитика тестов: срезы и новые ряды", () => {
  let sid: string;
  let alone: Awaited<ReturnType<typeof makeUser>>;
  let others: Awaited<ReturnType<typeof makeUser>>[];

  beforeAll(async () => {
    sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "Методика для вкладки тестів", ru: "Методика для вкладки тестов" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, createSurveySchema.parse(sr45), adminA.id, "Версия вкладки тестов");

    /* один человек — трижды, пятеро — по разу: срез по человеку обязан дать три, а не восемь */
    alone = await makeUser("user", `tests-alone-${crypto.randomUUID().slice(0, 8)}@test.dev`);
    for (let i = 0; i < 3; i++) expect((await submitSurvey(sid, alone.token)).status).toBe(201);
    others = [];
    for (let i = 0; i < 5; i++) {
      const person = await makeUser("user", `tests-other${i}-${crypto.randomUUID().slice(0, 8)}@test.dev`);
      others.push(person);
      expect((await submitSurvey(sid, person.token)).status).toBe(201);
    }
  });

  test("неделя — с понедельника и по поясу учреждения, а не по Гринвичу", () => {
    // 27.09.2026 — воскресенье; 20:30 UTC — это 23:30 по Киеву, ещё воскресенье
    expect(weekOf("2026-09-27T20:30:00Z")).toBe("2026-09-21");
    // 21:30 UTC — уже 00:30 понедельника по Киеву: новая неделя
    expect(weekOf("2026-09-27T21:30:00Z")).toBe("2026-09-28");
    expect(weekOf(null)).toBeNull();
  });

  test("малая неделя отдаёт «мало данных», а не ноль и не среднее четырёх", () => {
    const at = (d: string) => `${d}T10:00:00Z`;
    const weeks = weeklyMeans(
      [
        ...[1, 2, 3, 4].map((v) => ({ at: at("2026-09-02"), value: v })),
        ...[10, 10, 10, 10, 20].map((v) => ({ at: at("2026-09-09"), value: v })),
      ],
      5,
    );
    expect(weeks).toEqual([
      { week: "2026-08-31", n: 4, mean: null },
      { week: "2026-09-07", n: 5, mean: 12 },
    ]);
  });

  test("корзины длительности: хвост в открытой корзине, малые — скрыты", () => {
    const hide = (n: number) => (n === 0 ? 0 : n >= 5 ? n : null);
    const bins = durationBins([...Array(20).fill(60_000), 8 * 3_600_000], hide);
    // 95-й перцентиль — минута, и она лежит в закрытой корзине, а не открывает «і довше»
    const minute = bins.find((b) => b.fromMs <= 60_000 && b.toMs !== null && 60_000 < b.toMs)!;
    expect(minute.count).toBe(20);
    // восьмичасовой протокол — в открытой корзине и один: его не видно
    const open = bins.at(-1)!;
    expect(open.toMs).toBeNull();
    expect(open.count).toBeNull();
    // и ни одна корзина не рисует шкалу до восьми часов
    expect(bins.length).toBeLessThanOrEqual(12);
    expect(durationBins([], hide)).toEqual([]);
  });

  test("срез по человеку: только его прохождения, матрица ответов и след в журнале", async () => {
    const res = await api(`/api/analytics/surveys/${sid}?userId=${alone.id}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(3);
    expect(res.body.respondentCount).toBe(1);

    const matrix = res.body.answerMatrix;
    expect(matrix, "матрица ответов пуста при срезе по человеку").toBeTruthy();
    expect(matrix.responses.length).toBe(3);
    const answered = matrix.rows.find((r: { cells: unknown[] }) => r.cells.some((c) => c !== null));
    expect(answered.cells.length).toBe(3);
    expect(typeof answered.cells[0].label).toBe("string");

    const [logged] = [
      ...(await db.execute<{ n: number } & Record<string, unknown>>(sql`
        select count(*)::int as n from audit_log
        where action = 'analytics.survey' and resource_id = ${sid} and subject_user_id = ${alone.id}
      `)),
    ];
    expect(Number(logged!.n), "чтение одного человека не записано в журнал с его идентификатором").toBeGreaterThan(0);
  });

  test("без среза по человеку матрицы нет, а ряды и границы полос — есть", async () => {
    const res = await api(`/api/analytics/surveys/${sid}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(8);
    expect(res.body.respondentCount).toBe(6);
    expect(res.body.answerMatrix).toBeNull();

    const scale = res.body.scales.find((s: { bands: unknown[] }) => s.bands.length > 0);
    expect(scale, "у СР-45 нет шкалы с полосами — посев не тот").toBeTruthy();
    expect(typeof scale.bands[0].min).toBe("number");
    expect(typeof scale.bands[0].max).toBe("number");
    expect(scale.kind).toBeTruthy();

    const line = res.body.scaleTimeline.find((t: { scaleId: string }) => t.scaleId === scale.scaleId);
    expect(line.weeks.reduce((s: number, w: { n: number }) => s + w.n, 0)).toBeGreaterThan(0);

    const withOptions = res.body.questions.find((q: { options?: unknown[] }) => q.options?.length);
    expect("score" in withOptions.options[0]).toBe(true);
    expect(res.body.durationBins.length).toBeGreaterThan(0);
  });

  test("сданное прохождение не считается обрывом на последнем пункте", async () => {
    const res = await api(`/api/analytics/surveys/${sid}`, adminA.token);
    const ended = (res.body.dropOff as { endedHere: number | null }[]).map((d) => d.endedHere);
    expect(ended.every((n) => n === 0), `обрывы при одних сданных: ${ended.join(",")}`).toBe(true);
  });

  test("чужой пациент и чужая группа — «не найдено», а не пустой срез", async () => {
    const stranger = await makeUser("user", `tests-stranger-${crypto.randomUUID().slice(0, 8)}@test.dev`);
    const person = await api(`/api/analytics/surveys/${sid}?userId=${stranger.id}`, adminA.token);
    expect(person.status).toBe(404);

    const group = await api(`/api/analytics/surveys/${sid}?patientGroup=${crypto.randomUUID()}`, adminA.token);
    expect(group.status).toBe(404);

    const list = await api(`/api/surveys/${sid}/responses?userId=${stranger.id}`, adminA.token);
    expect(list.status).toBe(404);
  });

  test("срез по своей группе пациентов: только её люди, и в аналитике, и в списке", async () => {
    const made = await api("/api/patient-groups", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: `Зріз ${crypto.randomUUID().slice(0, 6)}`, description: "для вкладки тестів" }),
    });
    expect(made.status).toBe(201);
    const gid = made.body.id as string;
    for (const person of [alone, others[0]!]) {
      const added = await api(`/api/patient-groups/${gid}/members`, adminA.token, {
        method: "POST",
        body: JSON.stringify({ userId: person.id }),
      });
      expect(added.status).toBe(201);
    }

    // трое прохождений одного и одно — второго: четыре, а не восемь
    const res = await api(`/api/analytics/surveys/${sid}?patientGroup=${gid}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(4);
    expect(res.body.respondentCount).toBe(2);

    const list = await api(`/api/surveys/${sid}/responses?patientGroup=${gid}`, adminA.token);
    expect(list.status).toBe(200);
    expect(list.body.rows.length).toBe(4);

    // чужая группа — «не найдено»: личный список коллеги срезом не становится
    const foreign = await api(`/api/analytics/surveys/${sid}?patientGroup=${gid}`, adminB.token);
    expect([403, 404]).toContain(foreign.status);
  });

  test("список прохождений держит те же срезы: человек и период", async () => {
    const mine = await api(`/api/surveys/${sid}/responses?userId=${alone.id}`, adminA.token);
    expect(mine.status).toBe(200);
    expect(mine.body.rows.length).toBe(3);
    expect(mine.body.rows.every((r: { userId: string }) => r.userId === alone.id)).toBe(true);
    // имя полное, а не одна фамилия
    expect(mine.body.rows[0].userName).toContain("Тест");

    const future = await api(`/api/surveys/${sid}/responses?from=2099-01-01`, adminA.token);
    expect(future.status).toBe(200);
    expect(future.body.rows.length).toBe(0);
  });
});

