import { beforeAll, describe, expect, test } from "bun:test";
import { isQuestionVisible, type Answer, type Question, type ResponseDetail, type SurveyFull } from "@quizzy/shared";
import { adminA, appApi, db, makeUser, root, surveyInA, type Person } from "./fixtures";
import { surveyGroups } from "../src/db/schema";

/**
 * Ключ методики пациенту не отдаётся (#141).
 *
 * GET /api/surveys/:id отдавал обследуемому getSurvey целиком: у вариантов
 * score, keyCode, riskFlag, riskLabel, riskSeverity; у пунктов
 * riskThreshold, reverseScored, scaleId; scales со шкалой лжи и её порогом
 * validityThreshold, полосы. Человек видел, какие ответы поднимут тревогу и
 * как обойти шкалу лжи.
 *
 * Все запросы — под ролью приложения. Положительный контроль — сотрудник в
 * зоне получает ключ как прежде; и пациент по-прежнему проходит методику:
 * условие показа по баллу ответа на устройстве решается так же, как на
 * сервере, сдача и автосохранение работают.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const L = (uk: string) => ({ uk, ru: uk });
const group = crypto.randomUUID();

const OPTION_KEY = ["score", "keyCode", "riskFlag", "riskLabel", "riskSeverity"] as const;
const QUESTION_KEY = ["riskThreshold", "riskLabel", "riskSeverity", "reverseScored", "scaleId"] as const;

beforeAll(async () => {
  await db.insert(surveyGroups).values({ id: group, title: `Ключ ${tag()}`, createdBy: root.id });
});

async function patient(): Promise<Person> {
  return makeUser("user", `key-${tag()}@test`, { sex: "male", birthDate: "1990-01-01" });
}

/** Ни одного поля ключа — ни у вариантов, ни у пунктов; шкал нет; пометка стоит */
function expectNoKey(survey: SurveyFull, keep: Set<string> = new Set()) {
  expect(survey.scales, "шкалы (шкала лжи, полосы, пороги) ушли пациенту").toEqual([]);
  expect(survey.questions.length).toBeGreaterThan(0);
  for (const q of survey.questions) {
    expect(q.title, "пропал текст пункта").toBeTruthy();
    expect(q.type).toBeTruthy();
    for (const field of QUESTION_KEY) {
      if (field === "reverseScored" && keep.has(q.id)) continue;
      expect(Object.hasOwn(q, field), `пункт ${q.position}: ${field}`).toBe(false);
    }
    for (const o of q.options) {
      expect(o.text, "пропал текст варианта").toBeTruthy();
      for (const field of OPTION_KEY) {
        if (field === "score" && keep.has(q.id)) continue;
        expect(Object.hasOwn(o, field), `пункт ${q.position}, вариант ${o.position}: ${field}`).toBe(false);
      }
    }
  }
  const text = JSON.stringify(survey);
  for (const word of ["validityThreshold", "riskFlag", "keyCode", "bands", "riskThreshold"]) {
    expect(text.includes(`"${word}"`), `${word} в ответе пациенту`).toBe(false);
  }
  expect(survey.keyWithheld, "нет пометки «ключ не отдан»").toBe(true);
}

/** Методика своей группы — тем же путём, что в конструкторе */
async function publishedSurvey(content: Record<string, unknown>): Promise<SurveyFull> {
  const created = await appApi("/api/surveys", root.token, {
    method: "POST",
    body: JSON.stringify({
      title: L(`Ключ ${tag()}`),
      groupId: group,
      administration: "self",
      scoringEnabled: true,
      allowRetake: true,
      safetyPlan: L("Зателефонуйте 7333"),
      ...content,
    }),
  });
  expect(created.status).toBe(201);
  const published = await appApi(`/api/surveys/${created.body.id}`, root.token, {
    method: "PATCH",
    body: JSON.stringify({ status: "published" }),
  });
  expect(published.status).toBe(200);
  return published.body;
}

/** Развилка по баллу ответа, критический вариант, числовой порог, обратный ключ и шкала лжи */
const CONTENT = {
  questions: [
    {
      type: "single",
      title: L("Як часто за тиждень?"),
      required: true,
      scaleCode: "S",
      reverseScored: true,
      options: [
        { text: L("Ніколи"), score: 0 },
        { text: L("Іноді"), score: 1 },
        { text: L("Щодня"), score: 2 },
      ],
    },
    {
      type: "single",
      title: L("Чи думали ви про смерть?"),
      required: true,
      scaleCode: "S",
      // показ — по баллу ответа на первый пункт (с обратным ключом): устройство обязано посчитать его так же
      logic: [{ sourceIndex: 0, operator: "gte", value: 1, action: "show" }],
      options: [
        { text: L("Так"), score: 3, keyCode: "yes", riskFlag: true, riskLabel: L("Думки про смерть"), riskSeverity: "severe" },
        { text: L("Ні"), score: 0, keyCode: "no" },
      ],
    },
    {
      type: "number",
      title: L("Скільки ночей без сну?"),
      required: false,
      minValue: 0,
      maxValue: 7,
      riskThreshold: 5,
      riskLabel: L("Безсоння"),
      riskSeverity: "moderate",
    },
    {
      type: "yesno",
      title: L("Я завжди кажу правду"),
      required: true,
      scaleCode: "L",
      options: [
        { text: L("Так"), score: 1, keyCode: "yes" },
        { text: L("Ні"), score: 0, keyCode: "no" },
      ],
    },
  ],
  scales: [
    {
      code: "S",
      title: L("Сума"),
      kind: "clinical",
      normalization: "raw",
      bands: [
        { minScore: 0, maxScore: 2, label: L("Норма"), severity: "none" },
        { minScore: 3, maxScore: 10, label: L("Ризик"), severity: "severe" },
      ],
    },
    {
      code: "L",
      title: L("Шкала брехні"),
      kind: "validity",
      normalization: "raw",
      validityThreshold: 1,
      validityDirection: "above",
      validityMessage: L("Недостовірно"),
      bands: [],
    },
  ],
};

describe("ключ методики и пациент (#141)", () => {
  test(
    "СР-45: пациенту — без весов, ключей, критических пунктов, шкалы лжи и полос; сотруднику в зоне — всё",
    async () => {
      const person = await patient();
      const mine = await appApi<SurveyFull>(`/api/surveys/${surveyInA}`, person.token);
      expect(mine.status).toBe(200);
      expectNoKey(mine.body);

      // положительный контроль: сотрудник видит ключ как прежде
      const staff = await appApi<SurveyFull>(`/api/surveys/${surveyInA}`, adminA.token);
      expect(staff.status).toBe(200);
      expect(staff.body.keyWithheld).toBeUndefined();
      expect(staff.body.scales.some((s) => s.kind === "validity" && s.validityThreshold !== null)).toBe(true);
      expect(staff.body.scales.some((s) => s.bands.length > 0)).toBe(true);
      expect(staff.body.questions.some((q) => q.options.some((o) => o.riskFlag))).toBe(true);
      expect(staff.body.questions.some((q) => q.options.some((o) => o.keyCode !== null))).toBe(true);
      expect(staff.body.questions.every((q) => q.options.every((o) => typeof o.score === "number"))).toBe(true);
      // и пункты те же — пациенту срезали ключ, а не методику
      expect(mine.body.questions.map((q) => q.id)).toEqual(staff.body.questions.map((q) => q.id));
    },
    20_000,
  );

  test(
    "источник для персонала («Джерело») — не обследуемому: ни в методике, ни в списке; сотруднику — как есть",
    async () => {
      const survey = await publishedSurvey(CONTENT);
      const note = `Переклад відділення, пороги — за вибіркою ${tag()}`;
      const set = await appApi(`/api/surveys/${survey.id}/rights`, root.token, { method: "PATCH", body: JSON.stringify({ sourceNote: note }) });
      expect(set.status).toBe(200);
      const person = await patient();

      const mine = await appApi<SurveyFull>(`/api/surveys/${survey.id}`, person.token);
      expect(mine.status).toBe(200);
      expect(Object.hasOwn(mine.body, "sourceNote"), "источник в методике пациенту").toBe(false);
      const list = await appApi<{ items: Record<string, unknown>[] }>("/api/surveys", person.token);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body).includes(note), "источник в списке пациенту").toBe(false);

      // положительный контроль: сотрудник читает источник и в методике, и в списке
      const staff = await appApi<SurveyFull>(`/api/surveys/${survey.id}`, root.token);
      expect(staff.body.sourceNote).toBe(note);
      const staffList = await appApi<{ items: { id: string; sourceNote?: string | null }[] }>("/api/surveys", root.token);
      expect(staffList.body.items.find((x) => x.id === survey.id)?.sourceNote).toBe(note);
    },
    20_000,
  );

  test(
    "развилка по баллу: у пункта-источника вес остаётся, видимость на устройстве — как на сервере; ?version= — тоже без ключа",
    async () => {
      const survey = await publishedSurvey(CONTENT);
      const person = await patient();
      const mine = (await appApi<SurveyFull>(`/api/surveys/${survey.id}`, person.token)).body;
      const full = (await appApi<SurveyFull>(`/api/surveys/${survey.id}`, root.token)).body;
      const [gate, death, nights] = full.questions as [Question, Question, Question, Question];

      // у источника условия «gte» вес и обратный ключ нужны устройству — остальное срезано
      expectNoKey(mine, new Set([gate.id]));
      const mineGate = mine.questions.find((q) => q.id === gate.id)!;
      expect(mineGate.options.map((o) => o.score)).toEqual(gate.options.map((o) => o.score));
      expect(mineGate.reverseScored).toBe(true);

      // видимость второго пункта на копии пациента — та же, что по полной методике
      for (const option of gate.options) {
        const answers = new Map<string, Answer>([[gate.id, { questionId: gate.id, optionIds: [option.id] } as Answer]]);
        const onDevice = isQuestionVisible(mine.questions.find((q) => q.id === death.id)!, mine.questions, answers);
        const onServer = isQuestionVisible(death, full.questions, answers);
        expect(onDevice, `развилка разошлась на варианте ${option.position}`).toBe(onServer);
      }

      // прежняя версия по ?version= — тоже без ключа
      const edited = await appApi(`/api/surveys/${survey.id}`, root.token, {
        method: "PATCH",
        body: JSON.stringify({
          questions: CONTENT.questions.map((q, i) => (i === 2 ? { ...q, title: L("Скільки ночей ви не спали?") } : q)),
        }),
      });
      expect(edited.status).toBe(200);
      expect(edited.body.versionNumber).toBeGreaterThan(full.versionNumber);
      const old = await appApi<SurveyFull>(`/api/surveys/${survey.id}?version=${full.versionNumber}`, person.token);
      expect(old.status).toBe(200);
      expect(old.body.versionNumber).toBe(full.versionNumber);
      expectNoKey(old.body, new Set([gate.id]));
      // контроль: сотруднику прежняя версия — с ключом
      const oldFull = await appApi<SurveyFull>(`/api/surveys/${survey.id}?version=${full.versionNumber}`, root.token);
      expect(oldFull.body.questions.find((q) => q.id === nights.id)?.riskThreshold).toBe(5);
    },
    20_000,
  );

  test(
    "пациент проходит методику по своей копии: автосохранение и сдача работают",
    async () => {
      const survey = await publishedSurvey(CONTENT);
      const person = await patient();
      const mine = (await appApi<SurveyFull>(`/api/surveys/${survey.id}`, person.token)).body;
      const [gate, death, nights, lie] = mine.questions as [Question, Question, Question, Question];

      /*
       * Ответы собираются так, как их собирает кабинет: по копии без ключа,
       * только видимые пункты. «Ніколи» с обратным ключом даёт 2 — второй
       * пункт открыт и обязателен.
       */
      const chosen: Answer[] = [{ questionId: gate.id, optionIds: [gate.options[0]!.id] } as Answer];
      const byId = new Map(chosen.map((a) => [a.questionId, a]));
      expect(isQuestionVisible(death, mine.questions, byId), "кабинет скрыл пункт, который сервер ждёт").toBe(true);
      chosen.push({ questionId: death.id, optionIds: [death.options[1]!.id] } as Answer);
      chosen.push({ questionId: nights.id, number: 2 } as Answer);
      chosen.push({ questionId: lie.id, optionIds: [lie.options[1]!.id] } as Answer);
      const answers = chosen.map((a) => ({ ...a, durationMs: 2000, changeCount: 0, visitCount: 1 }));

      const draft = await appApi(`/api/surveys/${survey.id}/draft`, person.token, {
        method: "PUT",
        body: JSON.stringify({
          versionId: mine.versionId,
          answers: answers.slice(0, 2),
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 7000,
          events: [],
        }),
      });
      expect(draft.status, JSON.stringify(draft.body)).toBe(200);

      const submitted = await appApi(`/api/surveys/${survey.id}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          versionId: mine.versionId,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    },
    20_000,
  );
});

describe("своё прохождение пациента — тоже без ключа (#141, GET /api/responses/:id)", () => {
  test(
    "пациент не видит критических вариантов, весов и баллов за ответы; сотрудник видит",
    async () => {
      const survey = await publishedSurvey(CONTENT);
      const person = await patient();
      const full = (await appApi<SurveyFull>(`/api/surveys/${survey.id}`, root.token)).body;
      const [gate, death, nights, lie] = full.questions as [Question, Question, Question, Question];

      // ответы без тревоги: критический вариант в пункте есть, но не выбран — очередь дежурного не трогается
      const answers = [
        { questionId: gate.id, optionIds: [gate.options[0]!.id] },
        { questionId: death.id, optionIds: [death.options[1]!.id] },
        { questionId: nights.id, number: 2 },
        { questionId: lie.id, optionIds: [lie.options[1]!.id] },
      ].map((a) => ({ ...a, durationMs: 2000, changeCount: 0, visitCount: 1 }));
      const submitted = await appApi(`/api/surveys/${survey.id}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          versionId: full.versionId,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

      const mine = await appApi<ResponseDetail>(`/api/responses/${submitted.body.id}`, person.token);
      expect(mine.status).toBe(200);
      expect(mine.body.answers.length).toBeGreaterThan(0);
      expect(JSON.stringify(mine.body).includes('"riskFlag"'), "riskFlag в прохождении пациента").toBe(false);
      for (const a of mine.body.answers) {
        expect(a.score, `пункт ${a.position}: балл за ответ`).toBeNull();
        for (const o of a.options) {
          expect(o.text, "пропал текст варианта").toBeTruthy();
          for (const field of ["riskFlag", "riskSeverity", "keyCode", "riskLabel"]) {
            expect(Object.hasOwn(o, field), `пункт ${a.position}: ${field}`).toBe(false);
          }
          expect(o.score, `пункт ${a.position}: вес варианта`).toBeNull();
        }
      }
      // что человек ответил — видно, как прежде
      expect(mine.body.answers.find((a) => a.questionId === death.id)?.optionIds).toEqual([death.options[1]!.id]);

      // положительный контроль: сотрудник видит критический вариант, вес и балл за ответ
      const staff = await appApi<ResponseDetail>(`/api/responses/${submitted.body.id}`, root.token);
      expect(staff.status).toBe(200);
      const staffDeath = staff.body.answers.find((a) => a.questionId === death.id)!;
      expect(staffDeath.options[0]!.riskFlag).toBe(true);
      expect(staffDeath.options[0]!.riskSeverity).toBe("severe");
      expect(staffDeath.options[0]!.score).toBe(3);
      // «Ніколи» с обратным ключом даёт 2
      expect(staff.body.answers.find((a) => a.questionId === gate.id)!.score).toBe(2);
    },
    20_000,
  );
});
