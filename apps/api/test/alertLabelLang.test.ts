import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import { adminA, api, db, makeUser, root, surveyInA, type Person } from "./fixtures";
import { appointments, departments, questions, riskAlerts, slots, specialistProfiles, surveyAccess } from "../src/db/schema";

/**
 * Подпись сигнала риска — на языке читателя, а не на языке прохождения.
 *
 * risk_alerts.label — снимок, собранный при срабатывании из методики на языке
 * прохождения (у посева — украинском): «СР-45, пункт 40: ствердна відповідь
 * про суїцидальні наміри або спроби». Маршруты отдавали его как есть, и
 * русская консоль показывала украинскую подпись в очереди случаев, «Дія
 * зараз», на зведенні, в баннере заключения, в ящике разбора и на экране
 * приёма (lib/alertLabels.ts).
 *
 * Сдача СР-45 сплошным «Так» по-украински (язык запроса по умолчанию)
 * поднимает и сигналы по пунктам (подпись риска варианта), и сигнал по полосе
 * шкалы («шкала: полоса»). Читает сотрудник с русской консолью — и с
 * украинской, у которой ничего не должно поменяться. Давняя строка, чья
 * подпись ни с чем в методике не совпадает, отдаётся как есть.
 *
 * Под ролью приложения (test:app-role): основание и сводка читаются под
 * политиками строк, как в бою.
 *
 * Мутация: вернуть в маршруте снимок (`label: s.a.label` и т. п.) — тест
 * падает и называет экран, на котором осталась украинская подпись.
 */

const UK_ITEM = "ствердна відповідь про суїцидальні наміри або спроби";
const RU_ITEM = "утвердительный ответ о суицидальных намерениях или попытках";
const RU_SCALE = "Склонность к суицидальным реакциям: ";
const LEGACY = "Давня подпись, якої в методиці вже немає";

let person: Person;
let responseId: string;
let caseId: string;
let visitId: string;
let legacyId: string;

/** Язык — заголовком Accept-Language, как его шлёт консоль (web/src/api.ts): у строгих отборов ?lang= нет */
const read = (path: string, token: string, lang: "uk" | "ru") => api(path, token, { headers: { "Accept-Language": lang } });

/** Сдача сплошным «Так»: первый вариант каждого пункта — как в alertBasis.test.ts */
async function submitAllYes(token: string) {
  const survey = await api(`/api/surveys/${surveyInA}`, token);
  const answers = survey.body.questions
    .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && q.options.length)
    .map((q: { id: string; options: { id: string }[] }) => ({
      questionId: q.id,
      optionIds: [q.options[0]!.id],
      durationMs: 2000,
      changeCount: 0,
      visitCount: 1,
    }));
  return api(`/api/surveys/${surveyInA}/responses`, token, {
    method: "POST",
    body: JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 60_000, events: [], answers }),
  });
}

/** Приём у сотрудника группы А: прошлый (до сдачи) — чтобы экрану приёма было с чем сравнивать */
async function visit(patientId: string, startMs: number, status: "done" | "booked"): Promise<string> {
  const departmentId = crypto.randomUUID();
  await db.insert(departments).values({ id: departmentId, title: { uk: "Відділення", ru: "Отделение" }, timezone: "Europe/Kyiv" });
  await db.insert(specialistProfiles).values({ userId: adminA.id, departmentId }).onConflictDoNothing();
  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    specialistId: adminA.id,
    departmentId,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + 1800_000).toISOString(),
    kind: "any",
  });
  const id = crypto.randomUUID();
  await db.insert(appointments).values({ id, slotId, patientId, specialistId: adminA.id, kind: "primary", status });
  return id;
}

beforeAll(async () => {
  person = await makeUser("user", `alert-lang-${crypto.randomUUID()}@test`, { sex: "male", birthDate: "1990-01-01" });
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
  /* прошлый приём — за двое суток до сдачи; нынешний — через час, чужой час у одного специалиста не пересекается */
  const minute = Math.floor(Math.random() * 600);
  await visit(person.id, Date.now() - 2 * 86_400_000 - minute * 60_000, "done");
  visitId = await visit(person.id, Date.now() + 3_600_000 + minute * 60_000, "booked");

  const res = await submitAllYes(person.token);
  expect(res.status).toBe(201);
  responseId = res.body.responseId ?? res.body.id;

  const list = await api(`/api/alert-cases?status=open&group=case&patient=${person.id}&limit=20`, adminA.token);
  expect(list.status).toBe(200);
  caseId = list.body.items[0]?.id;
  expect(caseId, "случай по свежим сигналам не найден").toBeTruthy();

  /*
   * Давняя строка: пункт той же версии, на который сигнала у прохождения ещё
   * нет (одна тревога на пункт), а подпись ни с чем в методике не совпадает.
   */
  const alerted = await db
    .select({ questionId: riskAlerts.questionId })
    .from(riskAlerts)
    .where(and(eq(riskAlerts.responseId, responseId), isNotNull(riskAlerts.questionId)));
  const [first] = await db.select({ versionId: questions.versionId }).from(questions).where(eq(questions.id, alerted[0]!.questionId!));
  const sameVersion = await db.select({ id: questions.id }).from(questions).where(eq(questions.versionId, first!.versionId));
  const taken = new Set(alerted.map((a) => a.questionId));
  const free = sameVersion.find((q) => !taken.has(q.id));
  expect(free, "у версии не нашлось пункта без сигнала").toBeTruthy();
  legacyId = crypto.randomUUID();
  await db.insert(riskAlerts).values({
    id: legacyId,
    responseId,
    surveyId: surveyInA,
    questionId: free!.id,
    userId: person.id,
    caseId,
    label: LEGACY,
    severity: "moderate",
  });
});

describe("подпись сигнала на языке читателя", () => {
  test("снимок записан на языке прохождения — украинском", async () => {
    const rows = await db.select({ label: riskAlerts.label }).from(riskAlerts).where(eq(riskAlerts.userId, person.id));
    expect(rows.some((r) => r.label.includes(UK_ITEM))).toBe(true);
  });

  test("очередь случаев (риск, «Дія зараз», зведення): русской консоли — по-русски", async () => {
    const res = await read(`/api/alert-cases?status=open&group=case&patient=${person.id}&limit=20`, adminA.token, "ru");
    expect(res.status).toBe(200);
    const labels: string[] = res.body.items.flatMap((c: { signals: { label: string }[] }) => c.signals.map((s) => s.label));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((l) => l.includes(RU_ITEM)), "очередь, ru").toBe(true);
    expect(labels.filter((l) => l.includes(UK_ITEM)), "очередь, ru: осталась украинская подпись").toEqual([]);
    expect(labels.some((l) => l.startsWith(RU_SCALE)), "очередь, ru: сигнал по полосе").toBe(true);
  });

  test("украинской консоли — по-украински, как и было", async () => {
    const res = await read(`/api/alert-cases?status=open&group=case&patient=${person.id}&limit=20`, adminA.token, "uk");
    const labels: string[] = res.body.items.flatMap((c: { signals: { label: string }[] }) => c.signals.map((s) => s.label));
    expect(labels.some((l) => l.includes(UK_ITEM)), "очередь, uk").toBe(true);
    expect(labels.filter((l) => l.includes(RU_ITEM))).toEqual([]);
  });

  test("основание случая (ящик разбора): по-русски; давняя подпись — как есть", async () => {
    const res = await read(`/api/alert-cases/${caseId}/signals`, adminA.token, "ru");
    expect(res.status).toBe(200);
    const labels: string[] = res.body.items.map((s: { label: string }) => s.label);
    expect(labels.some((l) => l.includes(RU_ITEM)), "основание, ru").toBe(true);
    expect(labels.filter((l) => l.includes(UK_ITEM))).toEqual([]);
    expect(labels.some((l) => l.startsWith(RU_SCALE)), "основание, ru: сигнал по полосе").toBe(true);
    expect(res.body.items.find((s: { id: string }) => s.id === legacyId)?.label, "давняя строка").toBe(LEGACY);
  });

  test("контекст прохождения (баннер заключения): по-русски", async () => {
    const res = await read(`/api/response-context/${responseId}`, adminA.token, "ru");
    expect(res.status).toBe(200);
    const labels: string[] = res.body.signals.map((s: { label: string }) => s.label);
    expect(labels.some((l) => l.includes(RU_ITEM)), "контекст, ru").toBe(true);
    expect(labels.filter((l) => l.includes(UK_ITEM))).toEqual([]);
  });

  test("сводка человека (полоса случая, карточка): по-русски", async () => {
    const res = await read(`/api/referrals/summary/${person.id}`, adminA.token, "ru");
    expect(res.status).toBe(200);
    const labels: string[] = res.body.openAlerts.map((a: { label: string }) => a.label);
    expect(labels.some((l) => l.includes(RU_ITEM)), "сводка, ru").toBe(true);
    expect(labels.filter((l) => l.includes(UK_ITEM))).toEqual([]);
  });

  test("хронология человека: по-русски", async () => {
    const res = await read(`/api/timeline/${person.id}`, adminA.token, "ru");
    expect(res.status).toBe(200);
    const titles: string[] = res.body.items.filter((i: { kind: string }) => i.kind === "alert").map((i: { title: string }) => i.title);
    expect(titles.some((l) => l.includes(RU_ITEM)), "хронология, ru").toBe(true);
    expect(titles.filter((l) => l.includes(UK_ITEM))).toEqual([]);
  });

  test("экран приёма, «Що змінилося»: сигналы и названия методик — по-русски", async () => {
    const res = await read(`/api/clinic/appointments/${visitId}/context`, root.token, "ru");
    expect(res.status).toBe(200);
    const alerts: string[] = res.body.changes.filter((c: { kind: string }) => c.kind === "alert").map((c: { title: string }) => c.title);
    expect(alerts.some((l) => l.includes(RU_ITEM)), "приём, ru").toBe(true);
    expect(alerts.filter((l) => l.includes(UK_ITEM))).toEqual([]);
    const surveysDone: string[] = res.body.changes.filter((c: { kind: string }) => c.kind === "response").map((c: { title: string }) => c.title);
    expect(surveysDone).toContain("Опросник (СР-45)");
  });

  test("список тревог: по-русски", async () => {
    const res = await read(`/api/alerts?limit=500`, adminA.token, "ru");
    expect(res.status).toBe(200);
    const mine: string[] = res.body.items.filter((a: { userId: string }) => a.userId === person.id).map((a: { label: string }) => a.label);
    expect(mine.some((l) => l.includes(RU_ITEM)), "список, ru").toBe(true);
    expect(mine.filter((l) => l.includes(UK_ITEM))).toEqual([]);
  });
});
