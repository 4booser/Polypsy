import { describe, expect, test } from "bun:test";
import { adminA, api, patient, root, submitSurvey, surveyInA } from "./fixtures";
import { subscribe, type AppEvent } from "../src/lib/events";

/**
 * Поток событий.
 *
 * Проверяется не транспорт (LISTEN/NOTIFY проверять нечего), а связь потока
 * с журналом: событие выпускается из `audit()`, чтобы полнота потока не
 * зависела от того, вспомнил ли автор нового маршрута его выпустить.
 * Отсутствие события ничего не ломает и ни на что не жалуется — значит
 * сторожить его надо здесь.
 */

/** Дождаться события, удовлетворяющего условию, или сдаться по сроку */
async function waitFor(
  match: (e: AppEvent) => boolean,
  ms = 4000,
): Promise<AppEvent | null> {
  const off: (() => void)[] = [];
  try {
    return await new Promise<AppEvent | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      void subscribe((event) => {
        if (!match(event)) return;
        clearTimeout(timer);
        resolve(event);
      }).then((unsubscribe) => off.push(unsubscribe));
    });
  } finally {
    for (const unsubscribe of off) unsubscribe();
  }
}

describe("события изменяющих действий", () => {
  test("действие, попавшее в журнал, попадает и в поток", async () => {
    /*
     * Берётся обычное действие, а не специально заведённое для проверки:
     * смысл в том, что событие выпускается само, без строчки в маршруте.
     */
    const seen = waitFor((e) => e.kind === "action" && e.action === "response.submit");

    const res = await submitSurvey(surveyInA, patient.token);
    expect(res.status).toBe(201);

    const event = await seen;
    expect(event, "изменяющее действие не выпустило события — поток неполон").not.toBeNull();
    expect(event!.resourceType).toBe("response");
    expect(event!.actorId).toBe(patient.id);
  });

  test("содержимое действия в поток не уходит", async () => {
    /*
     * Событие рассылается всем подписанным сотрудникам сразу, а журнал
     * лежит под политиками строк и отдельным правом. Свободный текст из
     * details не должен пересекать эту границу: событие говорит
     * «перечитай», а не пересказывает запись.
     */
    const secret = `таємниця-${crypto.randomUUID()}`;
    const seen = waitFor((e) => e.kind === "action" && e.action === "group.create");

    const res = await api("/api/groups", root.token, {
      method: "POST",
      body: JSON.stringify({ title: `Група ${secret}` }),
    });
    if (res.status !== 201) return;

    const event = await seen;
    expect(event, "изменяющее действие не выпустило события").not.toBeNull();
    expect(
      JSON.stringify(event),
      "название из подробностей журнала уехало в поток, который видят все сотрудники",
    ).not.toContain(secret);
  });

  test("просмотр списка события не выпускает", async () => {
    /*
     * Просмотры тоже пишутся в журнал — и правильно. Но событие на каждый
     * просмотр утопило бы поток, заведённый ради срочного: открытая консоль
     * читает списки постоянно. Разделяются они методом запроса, а не
     * списком действий: список пришлось бы вести руками и однажды разойтись
     * с кодом.
     */
    const seen = waitFor((e) => e.kind === "action" && e.action === "alert.list", 1500);
    const res = await api("/api/alert-cases?limit=1", adminA.token);
    expect(res.status).toBe(200);
    expect(await seen, "просмотр списка выпустил событие — поток забьётся чтением").toBeNull();
  });
});
