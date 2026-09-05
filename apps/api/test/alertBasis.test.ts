import { describe, expect, test } from "bun:test";
import { adminA, api, patient, surveyInA } from "./fixtures";

/* Основание тревоги: на чём держится вывод о риске */

/**
 * Сдача СР-45 сплошным «Да».
 *
 * Такой протокол поднимает оба вида сигнала сразу: критические пункты
 * отмечены утвердительно, и суммарный балл шкалы Sr уходит в верхнюю
 * полосу. Иначе пришлось бы собирать два прохождения ради двух проверок, а
 * в бою они приходят одним.
 */
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
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
    }),
  });
}

/** Свежий случай этого пациента — тот, куда легли только что поднятые сигналы */
async function openCase() {
  const list = await api("/api/alert-cases?limit=100", adminA.token);
  return list.body.items.find((c: { userId: string }) => c.userId === patient.id);
}

describe("основание тревоги", () => {
  test("сигнал по отмеченному варианту называет пункт и то, что человек выбрал", async () => {
    /*
     * Раньше в очереди стояла готовая подпись и «заголовок» — который у
     * половины строк был названием шкалы, а не пункта. Разбирающий видел
     * «Суицидальные намерения» и не мог узнать главного: человек это
     * отметил или так посчиталось.
     */
    const submitted = await submitAllYes(patient.token);
    expect(submitted.status).toBe(201);

    const c = await openCase();
    expect(c, "случай по свежим тревогам не найден").toBeTruthy();

    const res = await api(`/api/alert-cases/${c.id}/signals`, adminA.token);
    expect(res.status).toBe(200);

    const byOption = res.body.items.find((s: { kind: string }) => s.kind === "option");
    expect(byOption, "сигнала по отмеченному варианту нет").toBeTruthy();
    expect(byOption.questionId).not.toBe(null);
    expect(byOption.questionNumber).toBeGreaterThan(0);
    expect(byOption.questionTitle?.length).toBeGreaterThan(0);
    // именно то, что человек отметил, а не подпись, записанная методикой
    expect(byOption.pickedOptions.length, "отмеченный вариант не прочитан").toBeGreaterThan(0);
  });

  test("сигнал по полосе шкалы называет шкалу, значение и границы полосы", async () => {
    /*
     * У сигнала по полосе пункта нет вовсе, и назвать какой-то один значило
     * бы назвать виновным случайный. Границы полосы обязательны: «2» — это
     * много или мало, зависит от того, из чего оно.
     */
    const c = await openCase();
    const res = await api(`/api/alert-cases/${c.id}/signals`, adminA.token);

    const byBand = res.body.items.find((s: { kind: string }) => s.kind === "band");
    expect(byBand, "сигнала по полосе шкалы нет").toBeTruthy();
    expect(byBand.questionId, "у сигнала по полосе оказался пункт").toBe(null);
    expect(byBand.scaleId).not.toBe(null);
    expect(byBand.scaleTitle?.length).toBeGreaterThan(0);
    expect(typeof byBand.scaleValue).toBe("number");
    expect(byBand.bandLabel?.length).toBeGreaterThan(0);
    expect(typeof byBand.bandMin).toBe("number");
    expect(typeof byBand.bandMax).toBe("number");
    expect(byBand.scaleValue).toBeGreaterThanOrEqual(byBand.bandMin);
    expect(byBand.scaleValue).toBeLessThanOrEqual(byBand.bandMax);
  });

  test("прохождение открывается целиком, и варианты приходят вместе с ответами", async () => {
    /*
     * Без вариантов наружу уходит набор идентификаторов, и «что человек
     * ответил» пришлось бы собирать из отдельно загруженной методики —
     * причём той версии, которую он реально проходил. Ровно на этом шаге и
     * ошибаются: берут действующую.
     */
    const c = await openCase();
    const signals = await api(`/api/alert-cases/${c.id}/signals`, adminA.token);
    const signal = signals.body.items.find((s: { kind: string }) => s.kind === "option");

    const res = await api(`/api/responses/${signal.responseId}`, adminA.token);
    expect(res.status).toBe(200);

    const answer = res.body.answers.find((a: { questionId: string }) => a.questionId === signal.questionId);
    expect(answer, "пункт, поднявший тревогу, в прохождении не найден").toBeTruthy();
    expect(answer.options.length, "варианты пункта не пришли").toBeGreaterThan(0);
    expect(answer.optionIds?.length).toBeGreaterThan(0);

    const picked = answer.options.filter((o: { id: string }) => answer.optionIds.includes(o.id));
    expect(picked.length).toBeGreaterThan(0);
    expect(
      picked.some((o: { riskFlag: boolean }) => o.riskFlag),
      "отмеченный вариант не помечен критическим — основание нечитаемо",
    ).toBe(true);
  });

  test("основание чужого случая недоступно", async () => {
    // область видимости у оснований та же, что у очереди: иначе основание
    // стало бы обходным путём к ответам, которых человек не видит нигде
    const { adminB } = await import("./fixtures");
    const c = await openCase();
    const res = await api(`/api/alert-cases/${c.id}/signals`, adminB.token);
    expect(res.status).toBe(404);
  });
});
