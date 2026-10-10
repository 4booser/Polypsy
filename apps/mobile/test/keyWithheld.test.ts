import { beforeEach, describe, expect, test } from "bun:test";
import type { SurveyFull, User } from "@quizzy/shared";
import { resetStore } from "./store.mock";
import { json, loadClient, noNetwork, serve, signIn, useFakeServer } from "./client.harness";
import { cache } from "../src/offline/cache";
import { pending } from "../src/offline/queue";
import { riskCases } from "../../../packages/shared/test/riskCases";

/**
 * Сдача без сети по копии методики без ключа (#141).
 *
 * Пациент с #141 получает методику без критических вариантов, порогов и
 * шкал (keyWithheld): по такой копии риск на устройстве не решить. Карточка
 * безопасности без сети показывается тогда из предосторожности — иначе она
 * пропала бы ровно у того, кому нужна. Копия с ключом (сотрудник на обходе)
 * решает риск, как прежде.
 */

useFakeServer();

const PATIENT = "patient-k";
const PLAN = "Зателефонуйте 7333";

beforeEach(() => {
  resetStore();
});

function submitOffline(survey: SurveyFull, answers: unknown[]) {
  return loadClient().then((api) => {
    signIn(PATIENT);
    cache.saveSurvey(PATIENT, survey);
    serve(noNetwork);
    return api.submitResponse(survey.id, {
      answers,
      startedAt: "2026-10-11T07:00:00.000Z",
      durationMs: 1000,
      events: [],
      versionId: survey.versionId,
    } as never);
  });
}

describe("сдача без сети по копии без ключа (#141)", () => {
  test("риск не решить — карточка из предосторожности, баллов нет, сдача в очереди", async () => {
    const c = riskCases().find((x) => x.name === "флаг не выбран")!;
    const survey = { ...c.survey, safetyPlan: PLAN, keyWithheld: true } as SurveyFull;
    const result = await submitOffline(survey, c.answers);
    expect(result.queued).toBe(true);
    expect(result.safetyPlan).toBe(PLAN);
    expect(result.scores).toEqual([]);
    expect(pending(PATIENT)).toHaveLength(1);
  });

  test("контроль: копия с ключом решает риск — без критического ответа карточки нет", async () => {
    const c = riskCases().find((x) => x.name === "флаг не выбран")!;
    const result = await submitOffline({ ...c.survey, safetyPlan: PLAN } as SurveyFull, c.answers);
    expect(result.queued).toBe(true);
    expect(result.safetyPlan).toBeNull();
  });
});

describe("копия с ключом, легшая до #141, на устройстве пациента не остаётся", () => {
  async function listWith(role: User["role"]) {
    const api = await loadClient();
    signIn(PATIENT);
    cache.saveMe({ id: PATIENT, role } as User);
    const keyed = { ...riskCases()[0]!.survey, id: "s-key" } as SurveyFull;
    cache.saveSurvey(PATIENT, keyed);
    const asked: string[] = [];
    serve((path) => {
      asked.push(path);
      if (path === "/api/surveys") return json(200, { items: [{ id: keyed.id }], total: 1 });
      if (path === `/api/surveys/${keyed.id}`) return json(200, { ...keyed, scales: [], keyWithheld: true });
      return noNetwork();
    });
    await api.listSurveys();
    for (let i = 0; i < 50 && !asked.includes(`/api/surveys/${keyed.id}`); i++) await Bun.sleep(5);
    await Bun.sleep(5);
    return { asked, cached: () => cache.survey(PATIENT, keyed.id)! };
  }

  test("пациент: список методик перекачивает копию с ключом — на диске копия без ключа", async () => {
    const { cached } = await listWith("user");
    expect(cached().keyWithheld).toBe(true);
  });

  test("контроль: у сотрудника копия с ключом законна — не перекачивается", async () => {
    const { asked, cached } = await listWith("admin");
    expect(asked).toEqual(["/api/surveys"]);
    expect(cached().keyWithheld).toBeUndefined();
  });
});
