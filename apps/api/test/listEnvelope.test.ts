import { describe, expect, test } from "bun:test";
import { app, groupA, patient, root, submitSurvey, surveyInA } from "./fixtures";

/**
 * Ни один маршрут чтения не отдаёт голый массив.
 *
 * Внешний разбор: «19 эндпоинтов возвращали голые массивы, затрудняя
 * добавление курсора и признака неполной выдачи». Их перевели на объект
 * `{ items, … }` разом (см. apps/web/src/api.ts, Items); сейчас таких нет. Но
 * новый маршрут со списком пишется быстрее всего именно как
 * `c.json(rows)` — и через месяц к нему понадобятся курсор и «показано не
 * всё», а добавить их, не сломав всех, кто читает массив, уже нельзя.
 *
 * Поэтому проверка обходит ВСЕ маршруты чтения приложения — из той же
 * таблицы маршрутов Hono, по которой собирается описание API, — и
 * спрашивает каждый от суперадмина и от пациента. Параметры пути
 * подставляются из общей обвязки: методика, группа, пациент; остальные —
 * случайным идентификатором (такой маршрут ответит «не найдено» объектом, и
 * это тоже проверено: ошибка — тоже не массив).
 */

const { dedupe, ROUTE_DOCS } = await import("../src/lib/openapi");

function fill(path: string): string {
  return path.replace(/:(\w+)(\{[^}]*\})?/g, (_m, name: string) => {
    if (/user|patient|person/i.test(name)) return patient.id;
    if (/survey/i.test(name)) return surveyInA;
    if (/group/i.test(name)) return groupA;
    if (name === "id") {
      if (path.includes("/surveys/:id")) return surveyInA;
      if (path.startsWith("/api/groups/")) return groupA;
      if (path.startsWith("/api/users/") || path.startsWith("/api/patients/")) return patient.id;
    }
    return crypto.randomUUID();
  });
}

describe("форма списков", () => {
  test(
    "маршруты чтения отвечают объектом, а не голым массивом",
    async () => {
      // одно прохождение — чтобы списки прохождений и баллов были не пустыми
      await submitSurvey(surveyInA, patient.token);

      const routes = dedupe(app.routes).filter(
        // поток событий не заканчивается — его форму здесь не проверить
        (r) => r.method === "GET" && !ROUTE_DOCS[`GET ${r.path}`]?.streaming,
      );
      expect(routes.length).toBeGreaterThan(100);

      const arrays: string[] = [];
      let answered = 0;
      for (const r of routes) {
        for (const who of [root, patient]) {
          const res = await app.request(fill(r.path), { headers: { Authorization: `Bearer ${who.token}` } });
          if (!(res.headers.get("content-type") ?? "").includes("json")) {
            await res.body?.cancel();
            continue;
          }
          const body = await res.json().catch(() => undefined);
          if (res.status < 300) answered += 1;
          if (Array.isArray(body)) arrays.push(`${who === root ? "суперадмин" : "пациент"}: GET ${r.path} (${res.status})`);
        }
      }

      // обход обязан до чего-то дотянуться: сто отказов подряд доказали бы только отказы
      expect(answered).toBeGreaterThan(50);
      expect(arrays, "голый массив вместо { items, … }").toEqual([]);
    },
    120_000,
  );
});
