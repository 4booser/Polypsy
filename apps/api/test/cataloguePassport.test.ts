import { beforeAll, describe, expect, test } from "bun:test";
import type { Battery, SurveyListItem, SurveyListPage } from "@quizzy/shared";
import {
  adminA,
  api,
  batteries,
  batteryAssignments,
  batteryItems,
  db,
  eq,
  groupA,
  makeUser,
  patient,
  responsesTable,
} from "./fixtures";

/**
 * Паспорт строки каталога и просрочка набора (UI 3, «Методики»).
 *
 * Каталог показывает в строке номер действующей версии, шкалы и смуги,
 * проходження за 30 днів и знак критического пункта; список наборов —
 * сколько назначений просрочено. Всё это считает сервер: у клиента в
 * строке каталога нет ни версий, ни ключа.
 *
 * Данные уникальны (своё название методики и набора), и проверки не
 * зависят от того, что насыпали соседние файлы.
 */

const YES_NO = [
  { text: { uk: "Так" }, keyCode: "yes", score: 1 },
  { text: { uk: "Ні" }, keyCode: "no", score: 0 },
];

describe("каталог: паспорт строки для сотрудника", () => {
  const title = `Паспорт каталогу ${crypto.randomUUID().slice(0, 8)}`;
  let id: string;

  beforeAll(async () => {
    const res = await api("/api/surveys", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        title: { uk: title },
        groupId: groupA,
        administration: "self",
        scoringEnabled: true,
        questions: [
          { type: "single", title: { uk: "Пункт 1" }, options: YES_NO },
          {
            type: "single",
            title: { uk: "Пункт 2" },
            options: [
              { text: { uk: "Так" }, keyCode: "yes", score: 1, riskFlag: true, riskSeverity: "severe" },
              { text: { uk: "Ні" }, keyCode: "no", score: 0 },
            ],
          },
        ],
        scales: [
          {
            code: "A",
            title: { uk: "Шкала А" },
            key: [{ item: 1, matchKey: "yes" }],
            bands: [
              { minScore: 0, maxScore: 0, label: { uk: "норма" }, severity: "none" },
              { minScore: 1, maxScore: 1, label: { uk: "увага" }, severity: "moderate" },
            ],
          },
          {
            code: "B",
            title: { uk: "Шкала Б" },
            key: [{ item: 2, matchKey: "yes" }],
            bands: [
              { minScore: 0, maxScore: 0, label: { uk: "норма" }, severity: "none" },
              { minScore: 1, maxScore: 1, label: { uk: "ризик" }, severity: "severe" },
              { minScore: 2, maxScore: 9, label: { uk: "поза шкалою" }, severity: "severe" },
            ],
          },
        ],
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    id = res.body.id;

    /* два свежих прохождения, одно старое (40 днів) и одно брошенное — в счёт идут только первые два */
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
    await db.insert(responsesTable).values([
      { id: crypto.randomUUID(), surveyId: id, userId: patient.id, status: "completed", startedAt: at(1), submittedAt: at(1) },
      { id: crypto.randomUUID(), surveyId: id, userId: patient.id, status: "completed", startedAt: at(12), submittedAt: at(12) },
      { id: crypto.randomUUID(), surveyId: id, userId: patient.id, status: "completed", startedAt: at(40), submittedAt: at(40) },
      { id: crypto.randomUUID(), surveyId: id, userId: patient.id, status: "abandoned", startedAt: at(2) },
    ] as never);
  });

  const row = async (token: string) => {
    const res = await api<SurveyListPage>(`/api/surveys?status=draft,published&q=${encodeURIComponent(title)}`, token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.items.find((s) => s.id === id) as SurveyListItem | undefined;
  };

  /**
   * Мутации: убрать фильтр по версии у шкал — счёт шкал не изменится, но
   * смуг станет больше после второй версии (здесь одна версия, поэтому
   * проверяется само наличие и число); убрать `status = 'completed'` или
   * окно 30 днів — recentResponseCount станет 3 или 4.
   */
  test("версия, шкалы, смуги, проходження за 30 днів, критичний пункт", async () => {
    const s = await row(adminA.token);
    expect(s, "методика не пришла в каталог").toBeDefined();
    expect(s!.versionNumber, "номер действующей версии").toBe(1);
    expect(s!.scaleCount, "шкал в действующей версии").toBe(2);
    expect(s!.bandCount, "смуг во всех шкалах").toBe(5);
    expect(s!.recentResponseCount, "только завершённые за 30 днів").toBe(2);
    expect(s!.responseCount, "всего завершённых — прежний счёт").toBe(3);
    expect(s!.hasCriticalItem, "вариант с riskFlag не замечен").toBe(true);
  });

  /** Мутация: отдать паспорт всем — у обследуемого появится hasCriticalItem (ключ, #141) */
  test("обследуемому паспорт не отдаётся", async () => {
    const res = await api<SurveyListPage>("/api/surveys", patient.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const s of res.body.items) {
      expect("hasCriticalItem" in s, `критический пункт «${s.title}» ушёл обследуемому`).toBe(false);
      expect("recentResponseCount" in s, `счёт по учреждению «${s.title}» ушёл обследуемому`).toBe(false);
    }
  });
});

describe("набори: просрочені призначення в списку", () => {
  test("просрочено — срок прошёл, не закрыто и не отменено", async () => {
    const batteryId = crypto.randomUUID();
    const surveys = await api<SurveyListPage>("/api/surveys", adminA.token);
    const surveyId = surveys.body.items[0]!.id;
    await db.insert(batteries).values({
      id: batteryId,
      title: `Набір просрочки ${batteryId.slice(0, 8)}`,
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    } as never);
    await db.insert(batteryItems).values({ batteryId, surveyId, position: 0, required: true } as never);
    const day = 86_400_000;
    const at = (d: number) => new Date(Date.now() + d * day).toISOString();
    /*
     * Активное назначение одно на человека (battery_assignments_active_idx),
     * поэтому люди разные: просрочено (p1), в срок (p2), без срока (p3);
     * у p1 ещё закрытое и отменённое просроченные — они в счёт не идут.
     */
    const tag = batteryId.slice(0, 8);
    const [p2, p3] = [await makeUser("user", `overdue2-${tag}@test`), await makeUser("user", `overdue3-${tag}@test`)];
    await db.insert(batteryAssignments).values([
      { id: crypto.randomUUID(), batteryId, userId: patient.id, assignedBy: adminA.id, assignedAt: at(-10), dueAt: at(-2) },
      { id: crypto.randomUUID(), batteryId, userId: p2.id, assignedBy: adminA.id, assignedAt: at(-1), dueAt: at(5) },
      { id: crypto.randomUUID(), batteryId, userId: patient.id, assignedBy: adminA.id, assignedAt: at(-10), dueAt: at(-2), completedAt: at(-3) },
      { id: crypto.randomUUID(), batteryId, userId: patient.id, assignedBy: adminA.id, assignedAt: at(-10), dueAt: at(-2), cancelledAt: at(-1) },
      { id: crypto.randomUUID(), batteryId, userId: p3.id, assignedBy: adminA.id, assignedAt: at(-1) },
    ] as never);

    const res = await api<{ items: Battery[] }>("/api/batteries", adminA.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body.items.find((x) => x.id === batteryId);
    expect(b, "набор не пришёл в список").toBeDefined();
    expect(b!.activeAssignments, "активные — не закрытые и не отменённые").toBe(3);
    expect(b!.overdueAssignments, "просрочено только одно из пяти").toBe(1);

    /* итог — закрыть хвосты: набор в архив, назначения отменить (общие очереди не должны их видеть) */
    await db
      .update(batteryAssignments)
      .set({ cancelledAt: new Date().toISOString() } as never)
      .where(eq(batteryAssignments.batteryId, batteryId));
    await db.update(batteries).set({ archived: true } as never).where(eq(batteries.id, batteryId));
  });
});
