import { describe, expect, test } from "bun:test";
import { appRequest, root, surveyInA } from "./fixtures";

/**
 * Номер запроса — и у ответов, собранных готовым Response (#195).
 *
 * Промежуточный слой ставил x-request-id до маршрута, в заготовку заголовков
 * контекста hono. Маршрут, вернувший готовый Response (все CSV-выгрузки,
 * сценарий SPSS, скрипты загрузки), заменял ответ целиком, и заготовка с ним
 * терялась: обращение пользователя с выгрузкой было не связать с журналом
 * запроса. Заголовок CORS этого не замечал — его слой трогает ответ, только
 * когда у запроса есть Origin, а скачивание с того же адреса его не несёт.
 */

const TAG = `w22-rid-${crypto.randomUUID().slice(0, 8)}`;

/** Ответ маршрута под ролью приложения со своим номером запроса */
async function fetchWithId(path: string, id: string): Promise<Response> {
  return appRequest(path, { headers: { Authorization: `Bearer ${root.token}`, "x-request-id": id } });
}

const RAW_RESPONSES = [
  `/api/spss/surveys/${surveyInA}/data.csv?profile=full`,
  `/api/spss/surveys/${surveyInA}/codebook.csv?profile=full`,
  `/api/spss/surveys/${surveyInA}/long.csv?profile=full`,
  `/api/spss/surveys/${surveyInA}/syntax.sps?profile=full`,
  `/api/spss/surveys/${surveyInA}/load/r?profile=full`,
  `/api/analytics/surveys/${surveyInA}/export`,
  "/api/audit/export.csv",
];

describe("x-request-id у ответов, собранных готовым Response", () => {
  test("положительный контроль: JSON-ответ несёт номер запроса", async () => {
    const res = await fetchWithId("/api/auth/me", `${TAG}-me`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe(`${TAG}-me`);
  }, 15_000);

  test("CSV-выгрузки, сценарий SPSS и скрипт загрузки несут номер своего запроса", async () => {
    const seen: Record<string, [number, string | null]> = {};
    const expected: Record<string, [number, string | null]> = {};
    for (const [i, path] of RAW_RESPONSES.entries()) {
      const res = await fetchWithId(path, `${TAG}-${i}`);
      await res.arrayBuffer();
      seen[path] = [res.status, res.headers.get("x-request-id")];
      expected[path] = [200, `${TAG}-${i}`];
    }
    expect(seen).toEqual(expected);
  }, 30_000);
});
