import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import {
  api,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupAdmins,
  isNull,
  makeUser,
  root,
  sql,
  surveyGroups,
  surveys,
  and,
} from "./fixtures";
import { alertCases, riskAlerts, surveyAccess } from "../src/db/schema";
import { attachToCase } from "../src/lib/alertCases";
import { underAppRole } from "./appRole";

/**
 * Случай риска: чья это зона и что будет, если два запроса придут разом.
 *
 * Два дефекта из внешнего разбора (P1), оба — про то, что сигнал может
 * остаться без разбирающего.
 *
 * 1. Случай собирался по человеку поверх зон видимости: тревога методики
 *    группы Б дописывалась в случай, начатый методикой группы А. Политика
 *    строк (0029) и выборка очереди держат случай за его ПЕРВОЙ методикой —
 *    и сотрудник группы Б своего сигнала не видел вовсе, а сотрудник группы А
 *    закрывал его разбором, не видя. Теперь случай живёт в одной зоне (см.
 *    caseZone в lib/alertCases.ts), а смешанные случаи прошлого делит
 *    миграция 0098.
 *
 * 2. Поиск открытого случая и вставка были двумя шагами без блокировки: два
 *    автосохранения одного человека заводили два случая, а сигнал, пришедший
 *    в момент разбора, дописывался в уже разобранный случай и пропадал из
 *    очереди.
 *
 * Данные — свои: группы, методики и люди с уникальными адресами. Всё, что
 * остаётся открытым, закрывается в afterAll: суперадмин видит любые случаи,
 * и чужая проверка «первый открытый случай» не должна наткнуться на наш.
 */

const tag = crypto.randomUUID().slice(0, 8);
const groupA = crypto.randomUUID();
const groupB = crypto.randomUUID();
await db.insert(surveyGroups).values([
  { id: groupA, title: `Зона А ${tag}`, createdBy: root.id },
  { id: groupB, title: `Зона Б ${tag}`, createdBy: root.id },
]);

const staffAEmail = `zone-a-${crypto.randomUUID()}@test.dev`;
const staffBEmail = `zone-b-${crypto.randomUUID()}@test.dev`;
const staffA = await makeUser("admin", staffAEmail);
const staffB = await makeUser("admin", staffBEmail);
/* второй сотрудник зоны А — для гонки «взять на себя» */
const staffA2 = await makeUser("admin", `zone-a2-${crypto.randomUUID()}@test.dev`);
await db.insert(groupAdmins).values([
  { groupId: groupA, userId: staffA.id, addedBy: root.id },
  { groupId: groupA, userId: staffA2.id, addedBy: root.id },
  { groupId: groupB, userId: staffB.id, addedBy: root.id },
]);

/** Методика с критическим первым вариантом — закрытая, выдаётся адресно */
async function riskySurvey(groupId: string, title: string): Promise<string> {
  const id = crypto.randomUUID();
  const draft = createSurveySchema.parse({
    title: { uk: title, ru: title },
    administration: "self",
    scoringEnabled: false,
    questions: [
      {
        type: "single",
        title: { uk: "Чи були думки, що краще не жити?", ru: "Были ли мысли, что лучше не жить?" },
        required: true,
        options: [
          {
            text: { uk: "Часто", ru: "Часто" },
            score: 3,
            riskFlag: true,
            riskLabel: { uk: "Думки про небажання жити", ru: "Мысли о нежелании жить" },
            riskSeverity: "severe",
          },
          { text: { uk: "Ні", ru: "Нет" }, score: 0 },
        ],
      },
    ],
    scales: [],
  });
  await db.insert(surveys).values({
    id,
    groupId,
    title: draft.title,
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "private",
    scoringEnabled: false,
    allowRetake: true,
    createdBy: root.id,
  } as never);
  await createVersion(id, draft, root.id, "v1");
  return id;
}

const surveyA = await riskySurvey(groupA, `Скринінг зони А ${tag}`);
const surveyA2 = await riskySurvey(groupA, `Другий скринінг зони А ${tag}`);
const surveyB = await riskySurvey(groupB, `Скринінг зони Б ${tag}`);

const people: string[] = [];

/** Человек с выданными методиками — своя почта на каждый тест */
async function person(label: string) {
  const p = await makeUser("user", `zone-${label}-${crypto.randomUUID()}@test.dev`);
  people.push(p.id);
  await db.insert(surveyAccess).values(
    [surveyA, surveyA2, surveyB].map((surveyId) => ({ surveyId, userId: p.id, grantedBy: root.id })),
  );
  return p;
}

/** Сдача первым (критическим) вариантом — тем же путём, что в бою */
async function submitRisky(surveyId: string, token: string): Promise<string> {
  const loaded = await api(`/api/surveys/${surveyId}`, token);
  expect(loaded.status).toBe(200);
  const answers = loaded.body.questions.map((q: { id: string; options: { id: string }[] }) => ({
    questionId: q.id,
    optionIds: [q.options[0]!.id],
    durationMs: 1500,
    changeCount: 0,
    visitCount: 1,
  }));
  const res = await api(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const casesOf = (userId: string) => db.select().from(alertCases).where(eq(alertCases.userId, userId));
const signalsOf = (caseId: string) => db.select().from(riskAlerts).where(eq(riskAlerts.caseId, caseId));

afterAll(async () => {
  if (!people.length) return;
  const at = new Date().toISOString();
  /* закрываем, а не удаляем: так же, как закрыл бы разбирающий */
  await db
    .update(alertCases)
    .set({ acknowledgedAt: at, acknowledgedBy: root.id, outcome: "not_confirmed", note: "очистка теста" })
    .where(and(inArray(alertCases.userId, people), isNull(alertCases.acknowledgedAt)));
  await db
    .update(riskAlerts)
    .set({ acknowledgedAt: at, acknowledgedBy: root.id, outcome: "not_confirmed" })
    .where(and(inArray(riskAlerts.userId, people), isNull(riskAlerts.acknowledgedAt)));
});

describe("зона видимости случая", () => {
  test("тревоги двух групп — два случая, и каждый держит только сигналы своей зоны", async () => {
    const p = await person("split");
    await submitRisky(surveyA, p.token);
    await submitRisky(surveyB, p.token);

    const cases = await casesOf(p.id);
    expect(
      cases.length,
      "сигнал группы Б дописан в случай, начатый методикой группы А, — сотрудник Б его не увидит",
    ).toBe(2);
    for (const c of cases) {
      const signals = await signalsOf(c.id);
      expect(signals.length).toBeGreaterThan(0);
      // все сигналы случая — из той же группы, что и методика, с которой он начался
      expect(new Set(signals.map((s) => s.surveyId))).toEqual(new Set([c.surveyId]));
    }
  });

  test("две методики одной группы по-прежнему дают один случай на человека", async () => {
    const p = await person("same-zone");
    await submitRisky(surveyA, p.token);
    await submitRisky(surveyA2, p.token);

    const cases = await casesOf(p.id);
    expect(cases.length, "случай на человека внутри зоны распался по методикам").toBe(1);
    const signals = await signalsOf(cases[0]!.id);
    expect(new Set(signals.map((s) => s.surveyId))).toEqual(new Set([surveyA, surveyA2]));
  });

  test("под боевой ролью сотрудник Б видит случай со своим сигналом и не видит чужих", async () => {
    const p = await person("rls");
    await submitRisky(surveyA, p.token);
    await submitRisky(surveyB, p.token);
    const cases = await casesOf(p.id);
    const caseA = cases.find((c) => c.surveyId === surveyA)?.id ?? cases[0]!.id;

    const out = await underAppRole<{
      login: number;
      list: number;
      mine: { id: string; surveyId: string; signals: { id: string }[]; signalCount: number }[];
      foreignSignals: number;
      ownSignals: number;
      ownSurveys: string[];
    }>(`
      const login = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ${JSON.stringify(staffBEmail)}, password: "secret12345" }),
      });
      out.login = login.status;
      const auth = { Authorization: "Bearer " + (await login.json()).token };
      const list = await app.request("/api/alert-cases?status=all&group=case&limit=100&patient=${p.id}", { headers: auth });
      out.list = list.status;
      const body = await list.json();
      out.mine = (body.items ?? []).map((c) => ({ id: c.id, surveyId: c.surveyId, signals: c.signals, signalCount: c.signalCount }));
      out.foreignSignals = (await app.request("/api/alert-cases/${caseA}/signals", { headers: auth })).status;
      const own = out.mine[0];
      if (own) {
        const res = await app.request("/api/alert-cases/" + own.id + "/signals", { headers: auth });
        const items = (await res.json()).items ?? [];
        out.ownSignals = items.length;
        out.ownSurveys = [...new Set(items.map((s) => s.surveyId))];
      }
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive, "роль обходит политики — проверка ничего не доказывает").toBe(true);
    expect(out.login).toBe(200);
    expect(out.list).toBe(200);
    expect(out.mine?.length, "сотрудник группы Б не видит случая со своим сигналом").toBe(1);
    expect(out.mine![0]!.surveyId).toBe(surveyB);
    expect(out.mine![0]!.signalCount).toBeGreaterThan(0);
    // основание случая — только методика своей зоны
    expect(out.ownSignals).toBeGreaterThan(0);
    expect(out.ownSurveys).toEqual([surveyB]);
    // случай зоны А для него не существует
    expect(out.foreignSignals).toBe(404);
  }, 60_000);

  test("смешанный случай прошлого делится по зонам, решение переносится честно", async () => {
    const p = await person("legacy");
    await submitRisky(surveyA, p.token);
    await submitRisky(surveyB, p.token);
    /*
     * Собираем то, что оставила прежняя редакция: сигнал зоны Б внутри
     * случая, начатого методикой зоны А.
     */
    const before = await casesOf(p.id);
    const caseA = before.find((c) => c.surveyId === surveyA)!;
    const caseB = before.find((c) => c.surveyId === surveyB)!;
    await db.update(riskAlerts).set({ caseId: caseA.id }).where(eq(riskAlerts.caseId, caseB.id));
    await db.delete(alertCases).where(eq(alertCases.id, caseB.id));

    await db.execute(sql`select alert_cases_split_by_zone()`);

    const after = await casesOf(p.id);
    expect(after.length).toBe(2);
    const split = after.find((c) => c.id !== caseA.id)!;
    expect(split.surveyId).toBe(surveyB);
    expect(split.severity).toBe("severe");
    expect(new Set((await signalsOf(split.id)).map((s) => s.surveyId))).toEqual(new Set([surveyB]));
    expect(new Set((await signalsOf(caseA.id)).map((s) => s.surveyId))).toEqual(new Set([surveyA]));
    // открытый остаётся открытым: решения о нём ещё не было
    expect(split.acknowledgedAt).toBeNull();

    // повторный вызов ничего не трогает
    await db.execute(sql`select alert_cases_split_by_zone()`);
    expect((await casesOf(p.id)).length).toBe(2);
  });
});

describe("гонки открытия и дополнения случая", () => {
  test("параллельные сигналы одного человека дают один случай, а не несколько", async () => {
    const p = await person("race");
    const at = new Date().toISOString();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.transaction((tx) => attachToCase(tx as never, { userId: p.id, surveyId: surveyA, severity: "moderate", at })),
      ),
    );
    const open = (await casesOf(p.id)).filter((c) => !c.acknowledgedAt);
    expect(open.length, "между поиском и вставкой другой запрос завёл второй случай").toBe(1);
    expect(new Set(ids).size).toBe(1);
  }, 30_000);

  test("сигнал в момент разбора не дописывается в уже разобранный случай", async () => {
    const p = await person("resolve-race");
    const caseId = await attachToCase(db as never, {
      userId: p.id,
      surveyId: surveyA,
      severity: "severe",
      at: new Date().toISOString(),
    });

    /*
     * Разбор держит строку случая, пока не зафиксирован. Сигнал в это время
     * уже нашёл случай открытым и ждёт на строке — после фиксации разбора он
     * обязан завести новый случай, а не лечь в закрытый: закрытый в очереди
     * не показывается, и сигнала не увидел бы никто.
     */
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const holding = new Promise<void>((r) => {
      locked = r;
    });
    const resolving = db.transaction(async (tx) => {
      await tx
        .update(alertCases)
        .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: staffA.id, outcome: "confirmed" })
        .where(eq(alertCases.id, caseId!));
      locked();
      await gate;
    });
    await holding;
    const attaching = db.transaction((tx) =>
      attachToCase(tx as never, { userId: p.id, surveyId: surveyA, severity: "severe", at: new Date().toISOString() }),
    );
    await Bun.sleep(150);
    release();
    await resolving;
    const second = await attaching;

    expect(second, "новый сигнал лёг в разобранный случай и пропал из очереди").not.toBe(caseId);
    const reopened = await db.query.alertCases.findFirst({ where: eq(alertCases.id, second!) });
    expect(reopened?.acknowledgedAt ?? null).toBeNull();
  }, 30_000);

  test("разбор не закрывает сигнал, которого разбирающий ещё не видел", async () => {
    const p = await person("stale");
    await submitRisky(surveyA, p.token);
    const [c] = await casesOf(p.id);
    const seen = c!.lastAlertAt;
    await Bun.sleep(20);
    // пока разбирающий читал, пришёл новый сигнал
    await submitRisky(surveyA2, p.token);

    const stale = await api(`/api/alert-cases/${c!.id}`, staffA.token, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "not_confirmed", note: "", seenLastAlertAt: seen }),
    });
    expect(stale.status, "решение легло на сигнал, пришедший после того, как случай открыли").toBe(409);
    const still = await db.query.alertCases.findFirst({ where: eq(alertCases.id, c!.id) });
    expect(still?.acknowledgedAt ?? null).toBeNull();

    const fresh = await api(`/api/alert-cases/${c!.id}`, staffA.token, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "confirmed", note: "", seenLastAlertAt: still!.lastAlertAt }),
    });
    expect(fresh.status).toBe(200);

    // разобранный повторно не разбирается: второе решение затёрло бы первое
    const again = await api(`/api/alert-cases/${c!.id}`, staffA.token, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "not_confirmed", note: "" }),
    });
    expect(again.status).toBe(409);
  });

  test("автосохранение после разбора: тот же ответ случая не заводит, повышение — заводит и несёт сигнал", async () => {
    /*
     * Автосохранение пишет тревогу на каждом шаге. Прежде каждый шаг звал и
     * открытие случая: после разбора следующий же шаг с тем же ответом
     * заводил новый случай — пустой, без единого сигнала, — а повышение
     * умеренного ответа до тяжёлого переписывало тревогу внутри уже
     * разобранного случая. Тяжёлый ответ оставался в закрытой записи, и в
     * очереди его не видел никто.
     */
    const sid = crypto.randomUUID();
    const draft = createSurveySchema.parse({
      title: { uk: `Чернетка ${tag}`, ru: `Черновик ${tag}` },
      administration: "self",
      scoringEnabled: false,
      questions: [
        {
          type: "single",
          title: { uk: "Як часто?", ru: "Как часто?" },
          required: true,
          options: [
            { text: { uk: "Ні", ru: "Нет" }, score: 0 },
            {
              text: { uk: "Іноді", ru: "Иногда" },
              score: 1,
              riskFlag: true,
              riskLabel: { uk: "Іноді", ru: "Иногда" },
              riskSeverity: "moderate",
            },
            {
              text: { uk: "Щодня", ru: "Каждый день" },
              score: 3,
              riskFlag: true,
              riskLabel: { uk: "Щодня", ru: "Каждый день" },
              riskSeverity: "severe",
            },
          ],
        },
      ],
      scales: [],
    });
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: draft.title,
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "private",
      scoringEnabled: false,
      allowRetake: true,
      createdBy: root.id,
    } as never);
    await createVersion(sid, draft, root.id, "v1");
    const p = await person("draft");
    await db.insert(surveyAccess).values({ surveyId: sid, userId: p.id, grantedBy: root.id });

    const loaded = await api(`/api/surveys/${sid}`, p.token);
    const q = loaded.body.questions[0] as { id: string; options: { id: string }[] };
    const save = (option: number) =>
      api(`/api/surveys/${sid}/draft`, p.token, {
        method: "PUT",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 30_000,
          answers: [{ questionId: q.id, optionIds: [q.options[option]!.id], durationMs: 1000, changeCount: 0, visitCount: 1 }],
        }),
      });

    expect((await save(1)).status).toBe(200);
    const [first] = await casesOf(p.id);
    expect(first).toBeDefined();
    const resolved = await api(`/api/alert-cases/${first!.id}`, staffA.token, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "needs_followup", note: "", seenLastAlertAt: first!.lastAlertAt }),
    });
    expect(resolved.status).toBe(200);

    // тот же ответ — разобран, нового случая нет
    expect((await save(1)).status).toBe(200);
    expect((await casesOf(p.id)).length, "шаг черновика с тем же ответом завёл пустой случай").toBe(1);

    // повышение до тяжёлого — новый открытый случай, и сигнал в нём
    expect((await save(2)).status).toBe(200);
    const open = (await casesOf(p.id)).filter((c) => !c.acknowledgedAt);
    expect(open.length).toBe(1);
    const signals = await signalsOf(open[0]!.id);
    expect(signals.length, "тяжёлый ответ остался в разобранном случае — в очереди его не видно").toBe(1);
    expect(signals[0]!.severity).toBe("severe");
    expect(signals[0]!.acknowledgedAt).toBeNull();
    expect(open[0]!.severity).toBe("severe");
  }, 30_000);

  test("двое берут случай одновременно — достаётся одному", async () => {
    const p = await person("assign-race");
    await submitRisky(surveyA, p.token);
    const [c] = await casesOf(p.id);

    const results = await Promise.all(
      [staffA, staffA2].map((s) => api(`/api/alert-cases/${c!.id}/assign`, s.token, { method: "POST" })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await db.query.alertCases.findFirst({ where: eq(alertCases.id, c!.id) });
    const winner = results[0]!.status === 200 ? staffA.id : staffA2.id;
    expect(row?.assignedTo).toBe(winner);
  });
});
