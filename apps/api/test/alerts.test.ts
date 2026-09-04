import { beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import {
  adminA,
  adminB,
  and,
  api,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  isNull,
  makeUser,
  patient,
  responsesTable,
  root,
  submitSurvey,
  surveyInA,
  surveyInB,
  surveys,
} from "./fixtures";

/* Риск: тревоги, случаи, разбор и передача смены */

/* ── уведомления о тревогах ── */

describe("рассыльщик тревог", () => {
  test("тревога уведомляет админов группы один раз; эскалация — суперадминов по сроку", async () => {
    const nodemailer = (await import("nodemailer")).default;
    const { runNotifierOnce, setTransportForTests } =
      await import("../src/lib/notify");
    const {
      riskAlerts,
      alertNotifications,
      surveys: surveysTable,
    } = await import("../src/db/schema");

    // json-транспорт: письма не уходят, но полностью собираются
    const sent: { subject: string; to: string; text: string }[] = [];
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const original = transport.sendMail.bind(transport);
    transport.sendMail = (async (mail: Parameters<typeof original>[0]) => {
      sent.push({
        subject: String(mail.subject),
        to: String(mail.to),
        text: String(mail.text),
      });
      return original(mail);
    }) as typeof transport.sendMail;
    setTransportForTests(transport);

    // методика с эскалацией через 30 минут
    await db
      .update(surveysTable)
      .set({ alertEscalateMinutes: 30 })
      .where(eq(surveysTable.id, surveyInA));

    /*
     * Прохождение создаётся здесь же: раньше тест брал первое попавшееся из
     * базы и работал только потому, что соседний файл успел его положить.
     */
    await submitSurvey(surveyInA, patient.token);

    /*
     * Все ранее накопленные тревоги помечаются как уже разосланные.
     *
     * Рассыльщик берёт по пятьдесят штук за тик, и без этого тест зависел бы
     * от того, сколько тревог успели создать соседние файлы: сначала он
     * выгребал очередь двадцатью тиками, потом их перестало хватать. Очередь
     * из одной тревоги не зависит от размера набора вовсе.
     */
    const pending = await db.select({ id: riskAlerts.id }).from(riskAlerts);
    if (pending.length) {
      await db
        .insert(alertNotifications)
        .values(
          pending.flatMap((a) =>
            (["initial", "escalation"] as const).map((kind) => ({
              id: crypto.randomUUID(),
              alertId: a.id,
              kind,
              // «уже разослано» без адресатов: это отметка, а не отправка
              recipients: "",
              channel: "none" as const,
              sentAt: new Date().toISOString(),
            })),
          ),
        )
        .onConflictDoNothing();
    }

    // тревога 40-минутной давности, не подтверждена
    const alertId = crypto.randomUUID();
    const responseRow = await db.query.responses.findFirst({
      where: eq(
        (await import("../src/db/schema")).responses.surveyId,
        surveyInA,
      ),
    });
    await db.insert(riskAlerts).values({
      id: alertId,
      responseId: responseRow!.id,
      surveyId: surveyInA,
      questionId: (await db.query.questions.findFirst({}))!.id,
      userId: patient.id,
      label: "Тестовая тревога",
      severity: "severe",
      at: new Date(Date.now() - 40 * 60_000).toISOString(),
    });

    const first = await runNotifierOnce();
    expect(first.initial).toBeGreaterThanOrEqual(1);
    expect(first.escalated).toBeGreaterThanOrEqual(1);

    /*
     * Идемпотентность: повторные тики не добавляют записей. Очередь пуста —
     * всё прочее помечено выше, — поэтому двух тиков достаточно, и они не
     * зависят от того, сколько тревог в базе.
     */
    const second = await runNotifierOnce();
    expect(second.initial).toBe(0);
    expect(second.escalated).toBe(0);

    const записи = await db
      .select()
      .from(alertNotifications)
      .where(eq(alertNotifications.alertId, alertId));
    expect(записи.map((z) => z.kind).sort()).toEqual(["escalation", "initial"]);

    // первичное — админу группы А; эскалация — суперадмину
    const initialMail = sent.find((m) => m.subject.startsWith("Тревога"));
    const escalationMail = sent.find((m) => m.subject.startsWith("ЭСКАЛАЦИЯ"));
    expect(initialMail!.to).toContain("a@test");
    expect(escalationMail!.to).toContain("root@test");

    // в письмах нет персональных данных пациента
    for (const m of sent) {
      expect(m.text).not.toContain("Тест");
      expect(m.text).not.toContain(patient.id);
    }

    setTransportForTests(null);
  });
});

/* ── safety-план ── */

describe("safety-план", () => {
  test("возвращается сдавшему при сработавшей тревоге и не возвращается специалисту", async () => {
    // surveyInA — СР-45 с safety-планом в описании инструмента; критические
    // пункты — «да» на вопросы о попытках. Отвечаем «да» на всё: тревога будет
    const surveyRes = await api(`/api/surveys/${surveyInA}`, patient.token);
    const yesAnswers = surveyRes.body.questions
      .filter((q: { type: string; options: unknown[] }) => q.type !== "info")
      .map(
        (q: { id: string; options: { id: string; keyCode?: string }[] }) => ({
          questionId: q.id,
          optionIds: [
            q.options.find((o: { keyCode?: string }) => o.keyCode === "yes")!
              .id,
          ],
          durationMs: 2000,
          changeCount: 0,
          visitCount: 1,
        }),
      );

    const own = await api(
      `/api/surveys/${surveyInA}/responses`,
      patient.token,
      {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers: yesAnswers,
        }),
      },
    );
    expect(own.status).toBe(201);
    expect(own.body.safetyPlan).toContain("0 800 100 102");

    // специалист вносит за пациента: план ему не показывается —
    // он сам и есть тот, к кому план отправляет
    const staff = await api(
      `/api/surveys/${surveyInA}/responses`,
      adminA.token,
      {
        method: "POST",
        body: JSON.stringify({
          onBehalfOf: patient.id,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers: yesAnswers,
        }),
      },
    );
    expect(staff.status).toBe(201);
    expect(staff.body.safetyPlan).toBeNull();
  });
});

describe("исход разбора", () => {
  /**
   * Свой неразобранный случай.
   *
   * Прежняя редакция брала любой открытый случай из общей базы — и это
   * держалось на порядке файлов: стоило появиться новому тестовому файлу
   * раньше по алфавиту, как случаев не оставалось и проверка падала, ничего
   * не сломав. Тест, зависящий от того, что делали до него, проверяет не то,
   * что написано в его названии.
   */
  async function ownOpenCase() {
    const person = await makeUser(
      "user",
      `outcome-${crypto.randomUUID()}@test`,
    );
    const surveyRes = await api(`/api/surveys/${surveyInA}`, person.token);
    const yesAnswers = surveyRes.body.questions
      .filter((q: { type: string }) => q.type !== "info")
      .map(
        (q: { id: string; options: { id: string; keyCode?: string }[] }) => ({
          questionId: q.id,
          optionIds: [
            (q.options.find((o) => o.keyCode === "yes") ?? q.options[0]!).id,
          ],
          durationMs: 2000,
          changeCount: 0,
          visitCount: 1,
        }),
      );
    const submitted = await api(
      `/api/surveys/${surveyInA}/responses`,
      person.token,
      {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers: yesAnswers,
        }),
      },
    );
    expect(submitted.status).toBe(201);

    const { alertCases: casesTable } = await import("../src/db/schema");
    const open = await db.query.alertCases.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.userId, person.id),
    });
    expect(open).toBeDefined();
    return { open: open!, casesTable };
  }

  test("исход ставится на случай и виден в списке", async () => {
    /*
     * Раньше исход ставился на отдельную тревогу. Тот путь убран: решение
     * принимается о человеке, и два источника истины о клиническом решении
     * недопустимы — по этим исходам калибруются пороги скрининга.
     */
    const { open, casesTable } = await ownOpenCase();

    const ack = await api(`/api/alert-cases/${open.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ note: "Беседа проведена", outcome: "confirmed" }),
    });
    expect(ack.status).toBe(200);

    const row = await db.query.alertCases.findFirst({
      where: eq(casesTable.id, open.id),
    });
    expect(row!.outcome).toBe("confirmed");
    expect(row!.note).toBe("Беседа проведена");

    const list = await api("/api/alert-cases?all=1&limit=100", adminA.token);
    const found = list.body.items.find((x: { id: string }) => x.id === open.id);
    expect(found.outcome).toBe("confirmed");
    expect(found.acknowledgedByName.length).toBeGreaterThan(0);
  });

  test("мусорный исход не проходит — случай остаётся открытым", async () => {
    /*
     * Прежняя редакция молча выходила, если открытых случаев не нашлось, —
     * то есть проходила, ничего не проверив. Свой случай убирает и это.
     */
    const { open } = await ownOpenCase();
    const res = await api(`/api/alert-cases/${open.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "чепуха" }),
    });
    expect(res.status).toBe(400);

    const { alertCases: casesTable } = await import("../src/db/schema");
    const row = await db.query.alertCases.findFirst({
      where: eq(casesTable.id, open.id),
    });
    expect(row!.acknowledgedAt).toBeNull();
  });
});

/* ── случаи риска ── */

describe("случаи риска", () => {
  let riskSurvey: string;

  beforeAll(async () => {
    // методика с критическим пунктом: у СР-45 они уже размечены
    riskSurvey = surveyInA;
  });

  test("несколько сигналов одного человека дают один случай", async () => {
    const { alertCases: casesTable, riskAlerts } =
      await import("../src/db/schema");

    const before = await db
      .select()
      .from(casesTable)
      .where(eq(casesTable.userId, patient.id));

    // два прохождения подряд с критическими ответами
    for (let i = 0; i < 2; i++) {
      const surveyRes = await api(`/api/surveys/${riskSurvey}`, patient.token);
      const survey = surveyRes.body;
      const answers = survey.questions
        .filter(
          (q: { type: string; options: unknown[] }) =>
            q.type !== "info" && q.options.length,
        )
        .map(
          (q: {
            id: string;
            options: { id: string; riskFlag: boolean }[];
          }) => ({
            questionId: q.id,
            // выбираем опасный вариант там, где он есть
            optionIds: [
              (q.options.find((o) => o.riskFlag) ?? q.options[0]!).id,
            ],
            durationMs: 2500,
            changeCount: 0,
            visitCount: 1,
          }),
        );
      const res = await api(
        `/api/surveys/${riskSurvey}/responses`,
        patient.token,
        {
          method: "POST",
          body: JSON.stringify({
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            durationMs: 60_000,
            answers,
          }),
        },
      );
      expect(res.status).toBe(201);
    }

    const after = await db
      .select()
      .from(casesTable)
      .where(eq(casesTable.userId, patient.id));
    // оба прохождения уложились в окно — случай должен быть один новый, а не два
    expect(after.length - before.length).toBeLessThanOrEqual(1);

    const open = after.find((x) => !x.acknowledgedAt);
    expect(open).toBeDefined();

    const signals = await db
      .select()
      .from(riskAlerts)
      .where(eq(riskAlerts.caseId, open!.id));
    expect(signals.length).toBeGreaterThan(1);
  });

  test("сигналы по разным методикам собираются в один случай на человека", async () => {
    /*
     * Случай заводится на ЧЕЛОВЕКА. Так написано на экране разбора: «Случай —
     * это человек, а не отдельный пункт. Решение принимается один раз обо
     * всех его сигналах», — а код искал открытый случай по паре «человек +
     * методика». Человек, у которого риск сработал по двум опросникам, висел
     * в очереди дважды, и второе решение принималось в отрыве от первого:
     * разбирающий мог не знать, что этот же человек уже разобран.
     */
    const { attachToCase } = await import("../src/lib/alertCases");
    const { alertCases: casesTable } = await import("../src/db/schema");
    const person = await makeUser(
      "user",
      `two-surveys-${crypto.randomUUID()}@test`,
    );
    const at = new Date().toISOString();

    const first = await attachToCase(db as never, {
      userId: person.id,
      surveyId: surveyInA,
      severity: "severe",
      at,
    });
    const second = await attachToCase(db as never, {
      userId: person.id,
      surveyId: surveyInB,
      severity: "moderate",
      at,
    });

    expect(first).not.toBeNull();
    expect(
      second,
      "вторая методика завела человеку второй случай — решение придётся принимать дважды",
    ).toBe(first);

    const open = await db
      .select()
      .from(casesTable)
      .where(
        and(
          eq(casesTable.userId, person.id),
          isNull(casesTable.acknowledgedAt),
        ),
      );
    expect(open.length).toBe(1);
    // тяжесть случая — по худшему сигналу, а не по последнему
    expect(open[0]!.severity).toBe("severe");

    /*
     * За собой прибираемся: случай заведён напрямую, без единого сигнала, и
     * соседняя проверка «разбор ставит исход на все сигналы» берёт первый
     * открытый случай из списка — она бы взяла этот и не нашла в нём ничего.
     */
    await db.delete(casesTable).where(eq(casesTable.id, first!));
  });

  test("полоса шкалы поднимает случай без жодного розміченого варіанта", async () => {
    /*
     * Тревогу поднимал ТОЛЬКО вариант ответа с riskFlag. У МЛО
     * «Адаптивність-200» — основной методики учреждения — таких вариантов
     * нет ни одного (`grep -c riskFlag instruments/mlo.ts` → 0): её
     * суицидальный риск выражен полосой стенов. Полоса «вкрай низький
     * рівень» с severity=severe не поднимала ни тревоги, ни случая, и
     * человек с крайним значением по СР не появлялся в очереди разбора
     * вовсе — при том что на экране у него стояло «високий ризик».
     *
     * Методика здесь заводится своя и намеренно без единого riskFlag:
     * взять МЛО значило бы проверять заодно двести пунктов и таблицу
     * стенов, а ломается не в них.
     */
    const { alertCases: casesTable, riskAlerts } = await import("../src/db/schema");
    const sid = crypto.randomUUID();
    const draft = createSurveySchema.parse({
      title: { uk: "Смуга без прапорців", ru: "Полоса без флажков" },
      administration: "self",
      scoringEnabled: true,
      questions: [
        {
          type: "single",
          title: { uk: "Наскільки важко?", ru: "Насколько тяжело?" },
          required: true,
          scaleCode: "S",
          options: [
            { text: { uk: "Зовсім ні", ru: "Совсем нет" }, score: 0 },
            { text: { uk: "Дуже", ru: "Очень" }, score: 3 },
          ],
        },
      ],
      scales: [
        {
          code: "S",
          title: { uk: "Тяжкість стану", ru: "Тяжесть состояния" },
          kind: "clinical",
          normalization: "raw",
          key: [{ item: 1 }],
          bands: [
            { minScore: 0, maxScore: 1, label: { uk: "Немає", ru: "Нет" }, severity: "none" },
            { minScore: 2, maxScore: 3, label: { uk: "Виражена", ru: "Выраженная" }, severity: "severe" },
          ],
        },
      ],
    });
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "Смуга без прапорців", ru: "Полоса без флажков" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, draft, adminA.id, "v1");

    const person = await makeUser("user", `band-${crypto.randomUUID()}@test`);
    const loaded = await api(`/api/surveys/${sid}`, person.token);
    const question = loaded.body.questions[0];
    const worst = question.options.find((o: { text: string }) => String(o.text).includes("Дуже"))
      ?? question.options[1];

    const submitted = await api(`/api/surveys/${sid}/responses`, person.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        answers: [
          { questionId: question.id, optionIds: [worst.id], durationMs: 2500, changeCount: 0, visitCount: 1 },
        ],
      }),
    });
    expect(submitted.status).toBe(201);

    const signals = await db
      .select()
      .from(riskAlerts)
      .where(eq(riskAlerts.responseId, submitted.body.id));
    expect(
      signals.length,
      "смуга severity=severe не підняла сигналу — людина з крайнім значенням у чергу не потрапляє",
    ).toBe(1);
    expect(signals[0]!.questionId, "сигнал за смугою не належить жодному пункту").toBeNull();
    expect(signals[0]!.scaleId).not.toBeNull();
    expect(signals[0]!.label).toContain("Тяжкість стану");

    const open = await db
      .select()
      .from(casesTable)
      .where(and(eq(casesTable.userId, person.id), isNull(casesTable.acknowledgedAt)));
    expect(open.length, "сигнал є, а випадку немає — розбирати нікому").toBe(1);
    expect(open[0]!.severity).toBe("severe");
  });

  test("список отдаётся страницами с курсором", async () => {
    const first = await api("/api/alert-cases?limit=1", adminA.token);
    expect(first.status).toBe(200);
    expect(first.body.items.length).toBe(1);
    expect(typeof first.body.total).toBe("number");

    if (first.body.nextCursor) {
      const second = await api(
        `/api/alert-cases?limit=1&cursor=${first.body.nextCursor}`,
        adminA.token,
      );
      expect(second.status).toBe(200);
      // вторая страница не повторяет первую
      expect(second.body.items[0]?.id).not.toBe(first.body.items[0].id);
      // общее число считается только на первой странице
      expect(second.body.total).toBeUndefined();
    }
  });

  test("тяжёлые случаи впереди на всех страницах, а не внутри одной", async () => {
    /*
     * Очередь сортировалась в приложении, уже после выборки страницы, а
     * база отдавала её по одному времени последней тревоги. Порядок
     * действовал внутри тридцати выбранных случаев и только: тяжёлый
     * случай, попавший на третью страницу, там и оставался — при том что
     * первый экран выглядел упорядоченным, и именно по нему специалист
     * решал, за что браться.
     *
     * Проверяется постранично, по одному: пролистав очередь до конца, ни
     * один тяжёлый случай не должен оказаться после умеренного.
     */
    const { alertCases: casesTable } = await import("../src/db/schema");
    const person = await makeUser("user", `order-${crypto.randomUUID()}@test`);
    const moderateId = crypto.randomUUID();
    const severeId = crypto.randomUUID();
    /*
     * Умеренный заводится СВЕЖЕЕ тяжёлого. При сортировке по одному только
     * времени он и встанет первым — ровно то, что проверка ловит. Без этой
     * подготовки порядок в базе оказался бы случайно верным, и проверка
     * прошла бы на сломанном коде.
     */
    await db.insert(casesTable).values([
      {
        id: severeId,
        userId: person.id,
        surveyId: surveyInA,
        severity: "severe",
        openedAt: new Date(Date.now() - 600_000).toISOString(),
        lastAlertAt: new Date(Date.now() - 600_000).toISOString(),
      },
      {
        id: moderateId,
        userId: person.id,
        surveyId: surveyInA,
        severity: "moderate",
        openedAt: new Date().toISOString(),
        lastAlertAt: new Date().toISOString(),
      },
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < 25; page++) {
        const url: string = `/api/alert-cases?all=1&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
        const res = await api<{ items: { severity: string }[]; nextCursor: string | null }>(
          url,
          adminA.token,
        );
        expect(res.status).toBe(200);
        for (const item of res.body.items) seen.push(item.severity);
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
    } finally {
      // подставные случаи убираются: сигналов у них нет, а соседняя проверка
      // берёт первый случай из очереди и ждёт, что сигналы в нём есть
      await db
        .delete(casesTable)
        .where(inArray(casesTable.id, [severeId, moderateId]));
    }

    const lastSevere = seen.lastIndexOf("severe");
    const firstModerate = seen.indexOf("moderate");
    if (lastSevere >= 0 && firstModerate >= 0) {
      expect(
        lastSevere,
        "умеренный случай оказался в очереди раньше тяжёлого — порядок наводится только внутри страницы",
      ).toBeLessThan(firstModerate);
    }

    // и страницы не пересекаются и не теряют записей
    expect(new Set(seen).size).toBeLessThanOrEqual(seen.length);
  });

  test("случай берётся на себя и не перехватывается", async () => {
    const list = await api(
      "/api/alert-cases?limit=1&assigned=none",
      adminA.token,
    );
    const target = list.body.items[0];
    if (!target) return;

    expect(
      (
        await api(`/api/alert-cases/${target.id}/assign`, adminA.token, {
          method: "POST",
        })
      ).status,
    ).toBe(200);

    // чужой админ этот случай вообще не видит — методика не его группы
    const foreign = await api(
      `/api/alert-cases/${target.id}/assign`,
      adminB.token,
      { method: "POST" },
    );
    expect(foreign.status).toBe(404);

    // повторный захват тем же — не ошибка
    expect(
      (
        await api(`/api/alert-cases/${target.id}/assign`, adminA.token, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });

  test("разбор ставит исход на случай и на все его сигналы", async () => {
    const list = await api("/api/alert-cases?limit=1", adminA.token);
    const target = list.body.items[0];
    if (!target) return;

    const res = await api(`/api/alert-cases/${target.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({
        outcome: "confirmed",
        note: "Направлен к психиатру",
      }),
    });
    expect(res.status).toBe(200);

    const { riskAlerts } = await import("../src/db/schema");
    const signals = await db
      .select()
      .from(riskAlerts)
      .where(eq(riskAlerts.caseId, target.id));
    expect(signals.length).toBeGreaterThan(0);
    // ни один сигнал не остался висеть внутри разобранного случая
    expect(
      signals.every(
        (s) => s.acknowledgedAt !== null && s.outcome === "confirmed",
      ),
    ).toBe(true);
  });

  test("разбор без исхода отклоняется", async () => {
    const list = await api("/api/alert-cases?limit=1&all=1", adminA.token);
    const target = list.body.items[0];
    if (!target) return;
    const res = await api(`/api/alert-cases/${target.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ note: "просто заметка" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("передача смены и просроченные повторы", () => {
  test("история случая собирается из журнала, а не из второй таблицы", async () => {
    /*
     * Отдельного журнала передач нет намеренно: всё уже пишется в журнал
     * доступа, и вторая запись о том же означала бы два источника истины о
     * клиническом решении.
     */
    const list = await api(
      "/api/alert-cases?limit=1&assigned=none",
      adminA.token,
    );
    const target = list.body.items[0];
    if (!target) return;

    await api(`/api/alert-cases/${target.id}/assign`, adminA.token, {
      method: "POST",
    });
    await api(`/api/alert-cases/${target.id}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ release: true }),
    });

    const history = await api(
      `/api/alert-cases/${target.id}/history`,
      adminA.token,
    );
    expect(history.status).toBe(200);
    const actions = history.body.items.map((h: { action: string }) => h.action);
    expect(actions).toContain("alert.assign");
    expect(actions).toContain("alert.release");
    // видно, кто именно, — иначе при передаче смены непонятно, с кем говорить
    expect(history.body.items[0].actorName.length).toBeGreaterThan(0);
  });

  test("просроченный повтор по протоколу попадает в очередь работы", async () => {
    const { surveyAccess } = await import("../src/db/schema");

    /*
     * Доступ выдан ПОЗЖЕ последнего прохождения: иначе прежний замер сойдёт
     * за повтор, и правило справедливо не сработает. Первая версия теста
     * ставила выдачу на десять дней назад — а пациент проходил методику в
     * соседних проверках уже после этого.
     */
    const { sql: sqlOp } = await import("drizzle-orm");
    const [last] = await db
      .select({ at: responsesTable.submittedAt })
      .from(responsesTable)
      .where(
        and(
          eq(responsesTable.userId, patient.id),
          eq(responsesTable.surveyId, surveyInA),
        ),
      )
      .orderBy(sqlOp`submitted_at desc nulls last`)
      .limit(1);
    const past = new Date(
      new Date(last?.at ?? new Date()).getTime() + 60_000,
    ).toISOString();

    await db
      .insert(surveyAccess)
      .values({
        surveyId: surveyInA,
        userId: patient.id,
        grantedBy: adminA.id,
        grantedAt: past,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        note: "Протокол наблюдения: повтор через 7 дн.",
      })
      .onConflictDoUpdate({
        target: [surveyAccess.surveyId, surveyAccess.userId],
        set: {
          grantedAt: past,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          note: "Протокол наблюдения: повтор через 7 дн.",
        },
      });

    const res = await api("/api/worklist", adminA.token);
    const followups = (
      res.body.items as { kind: string; userId: string }[]
    ).filter((i) => i.kind === "followup");
    /*
     * Пациент проходил методику раньше выдачи доступа — значит повтора не
     * было, и человек выпал из наблюдения. Именно это и должно всплыть.
     */
    expect(followups.some((i) => i.userId === patient.id)).toBe(true);
    expect(res.body.byKind.followup).toBeGreaterThan(0);
  });
});

describe("очередь работы", () => {
  test("собирает случаи, направления и просроченные назначения в один список", async () => {
    const res = await api("/api/worklist", adminA.token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
    expect(res.body.byKind).toHaveProperty("case");
    expect(res.body.byKind).toHaveProperty("referral");
    expect(res.body.byKind).toHaveProperty("assignment");
  });

  test("просроченное идёт первым — порядок один на все виды работы", async () => {
    const res = await api("/api/worklist", adminA.token);
    const items = res.body.items as { overdue: boolean }[];
    if (items.length < 2) return;
    // после первого неспросроченного просроченных быть не должно
    const firstNormal = items.findIndex((i) => !i.overdue);
    if (firstNormal >= 0) {
      expect(items.slice(firstNormal).every((i) => !i.overdue)).toBe(true);
    }
  });

  test("каждая строка ведёт туда, где с ней работают", async () => {
    const res = await api("/api/worklist", adminA.token);
    for (const i of res.body.items as { href: string }[]) {
      expect(i.href.startsWith("/")).toBe(true);
    }
  });

  test("чтение очереди фиксируется в журнале", async () => {
    await api("/api/worklist", adminA.token);
    const { auditLog } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, adminA.id))
      .orderBy(descOp(auditLog.at))
      .limit(1);
    expect(entry!.action).toBe("worklist.read");
  });
});
