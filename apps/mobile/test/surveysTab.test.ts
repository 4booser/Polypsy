import { describe, expect, test } from "bun:test";
import type { BatteryAssignment, SurveyListItem, SurveyResponse } from "@quizzy/shared";
import { codeOf, loadSurveysTab, patientTabs, type SurveysTabApi } from "../src/catalog/surveysTab";

/**
 * Вкладка «Опитування» у пациента (прод, волна 25).
 *
 * Вкладка брала группы методик из `/api/groups` — справочника консоли,
 * закрытого для пациента. Сервер отвечал 403 «Доступно лише
 * співробітникам», запросы шли одним Promise.all, и отказ групп ронял
 * загрузку целиком: пациент вместо списка видел строку ошибки. Здесь —
 * что пациенту справочник не запрашивается вовсе и что ни один
 * вспомогательный отказ список не роняет.
 */

const forbidden = () => Promise.reject(Object.assign(new Error("Доступно лише співробітникам"), { status: 403 }));

function survey(over: Partial<SurveyListItem> & { id: string }): SurveyListItem {
  return {
    groupId: "g1",
    folderId: null,
    title: `Методика ${over.id}`,
    description: null,
    instructions: null,
    administration: "self",
    tooFastMs: null,
    alertEscalateMinutes: null,
    safetyPlan: null,
    showResultsToPatient: true,
    isDemo: false,
    status: "published",
    timeLimitSec: null,
    randomizeQuestions: false,
    allowBack: true,
    showProgress: true,
    anonymous: false,
    visibility: "public",
    allowRetake: true,
    scoringEnabled: true,
    createdBy: "psy",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    publishedAt: "2026-09-01T10:00:00.000Z",
    questionCount: 9,
    responseCount: 0,
    completedByMe: false,
    ...over,
  } as SurveyListItem;
}

function response(surveyId: string, submittedAt: string): SurveyResponse {
  return {
    id: `r-${surveyId}-${submittedAt}`,
    surveyId,
    userId: "u1",
    userName: null,
    status: "completed",
    startedAt: submittedAt,
    submittedAt,
    durationMs: 120_000,
    scores: [],
  };
}

function battery(surveyIds: string[]): BatteryAssignment {
  return {
    id: "b1",
    batteryId: "bt",
    batteryTitle: "Перед сесією",
    userId: "u1",
    userName: "",
    assignedAt: "2026-10-01T10:00:00.000Z",
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    note: null,
    overdue: false,
    doneRequired: 0,
    totalRequired: surveyIds.length,
    steps: surveyIds.map((surveyId, i) => ({
      surveyId,
      title: surveyId,
      position: i,
      required: true,
      administration: "self",
      medianMinutes: null,
      state: i === 0 ? "current" : "locked",
      responseId: null,
      submittedAt: null,
    })) as BatteryAssignment["steps"],
  };
}

/** Клиент-заглушка: считает, кого спросили */
function fakeApi(over: Partial<SurveysTabApi> = {}) {
  const calls: string[] = [];
  const api: SurveysTabApi = {
    listSurveys: async () => (calls.push("surveys"), [survey({ id: "phq9" }), survey({ id: "gad7", assigned: true })]),
    myBatteries: async () => (calls.push("batteries"), []),
    // как прод: справочник групп пациенту закрыт
    listGroups: () => (calls.push("groups"), forbidden()),
    myResponses: async () => (calls.push("responses"), []),
    ...over,
  };
  return { api, calls };
}

describe("загрузка вкладки «Опитування»", () => {
  test("пациенту справочник групп не запрашивается, список методик открывается", async () => {
    const { api, calls } = fakeApi();
    const data = await loadSurveysTab(api, { staff: false });
    expect(calls).not.toContain("groups");
    expect(data.surveysFailed).toBe(false);
    expect(data.surveys.map((s) => s.id)).toEqual(["phq9", "gad7"]);
    expect(data.groups).toEqual([]);
  });

  test("отказ групп у сотрудника не роняет каталог", async () => {
    const { api, calls } = fakeApi();
    const data = await loadSurveysTab(api, { staff: true });
    expect(calls).toContain("groups");
    expect(data.surveysFailed).toBe(false);
    expect(data.surveys).toHaveLength(2);
    expect(data.groups).toEqual([]);
  });

  test("методики не пришли — ошибка, но батареи остаются на экране", async () => {
    const { api } = fakeApi({
      listSurveys: () => Promise.reject(new Error("offline")),
      myBatteries: async () => [battery(["isi", "dbas"])],
    });
    const data = await loadSurveysTab(api, { staff: false });
    expect(data.surveysFailed).toBe(true);
    expect(data.batteries).toHaveLength(1);
  });

  test("отказ батарей и своих прохождений — пустые, а не ошибка экрана", async () => {
    const { api } = fakeApi({ myBatteries: forbidden, myResponses: forbidden });
    const data = await loadSurveysTab(api, { staff: false });
    expect(data.surveysFailed).toBe(false);
    expect(data.batteries).toEqual([]);
    expect(data.responses).toEqual([]);
  });

  test("закрытая батарея на вкладку не попадает", async () => {
    const closed = { ...battery(["isi"]), doneRequired: 1, totalRequired: 1 };
    const { api } = fakeApi({ myBatteries: async () => [closed, battery(["phq9"])] });
    const data = await loadSurveysTab(api, { staff: false });
    expect(data.batteries).toHaveLength(1);
  });
});

describe("вкладки пациента", () => {
  const surveys = [
    survey({ id: "isi", assigned: true }),
    survey({ id: "gad7", assigned: true }),
    survey({ id: "phq9", completedByMe: true }),
    survey({ id: "pss" }),
  ];

  test("назначенное, пройденное и «самостійно» не пересекаются", () => {
    const tabs = patientTabs({ surveys, batteries: [], responses: [response("phq9", "2026-10-08T11:12:00.000Z")] });
    expect(tabs.assigned.map((s) => s.id)).toEqual(["isi", "gad7"]);
    expect(tabs.done.map((d) => d.survey.id)).toEqual(["phq9"]);
    expect(tabs.self.map((s) => s.id)).toEqual(["pss"]);
  });

  test("методика из батареи не дублируется в списке назначенного", () => {
    const tabs = patientTabs({ surveys, batteries: [battery(["isi"])], responses: [] });
    expect(tabs.assigned.map((s) => s.id)).toEqual(["gad7"]);
  });

  test("в «Пройдені» — последнее прохождение и предыдущее", () => {
    const tabs = patientTabs({
      surveys,
      batteries: [],
      responses: [response("phq9", "2026-09-11T10:00:00.000Z"), response("phq9", "2026-10-08T11:12:00.000Z")],
    });
    expect(tabs.done[0]!.last!.submittedAt).toBe("2026-10-08T11:12:00.000Z");
    expect(tabs.done[0]!.before!.submittedAt).toBe("2026-09-11T10:00:00.000Z");
  });
});

describe("код методики из названия", () => {
  test("код в скобках", () => {
    expect(codeOf("Тривога (GAD-7)")).toEqual({ name: "Тривога", code: "GAD-7" });
    expect(codeOf("Поширені психічні розлади (SRQ-20, ВООЗ)")).toEqual({ name: "Поширені психічні розлади", code: "SRQ-20" });
    expect(codeOf("Вигорання (Копенгагенський опитувальник, CBI)").code).toBe("CBI");
  });

  test("нет кода — нет выдуманной аббревиатуры", () => {
    expect(codeOf("Самооцінка (шкала Розенберга)")).toEqual({ name: "Самооцінка (шкала Розенберга)", code: null });
    expect(codeOf("БОО «Адаптивність-200»").code).toBeNull();
  });
});
