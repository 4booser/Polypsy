import { beforeAll, describe, expect, test } from "bun:test";
import type { SurveyKeySheet } from "@quizzy/shared";
import { adminA, api, groupA } from "./fixtures";

/**
 * Печатный лист ключей.
 *
 * Лист сверяют с пособием, и его ценность — в полноте: код ответа, который
 * не попал ни в одну колонку, пропадает молча, и сверка «прошла». Раньше
 * колонки были две, «да» и «нет», и третий ответ («не знаю») выпадал из
 * печати. Здесь проверяется, что колонка есть на каждый код, который
 * встречается в вариантах, и что прежние поля никуда не делись.
 */

const THREE = [
  { text: { uk: "Так" }, keyCode: "yes", score: 1 },
  { text: { uk: "Ні" }, keyCode: "no", score: 0 },
  { text: { uk: "Нінаю" }, keyCode: "k3", score: 0 },
];

describe("ключевой лист — колонка на каждый код ответа", () => {
  let id: string;

  beforeAll(async () => {
    const res = await api("/api/surveys", adminA.token, {
      method: "POST",
      body: JSON.stringify({
        title: { uk: "Методика з трьома відповідями" },
        groupId: groupA,
        administration: "self",
        scoringEnabled: true,
        questions: [
          { type: "single", title: { uk: "Пункт 1" }, options: THREE },
          { type: "single", title: { uk: "Пункт 2" }, options: THREE },
          { type: "single", title: { uk: "Пункт 3" }, options: THREE },
          { type: "single", title: { uk: "Пункт 4" }, options: THREE },
          { type: "single", title: { uk: "Пункт 5" }, options: THREE },
        ],
        scales: [
          {
            code: "A",
            title: { uk: "Шкала А" },
            key: [
              { item: 1, matchKey: "yes" },
              { item: 2, matchKey: "k3" },
              { item: 3, matchKey: "no" },
              { item: 4, matchKey: "k3" },
              // пункт без кода — берётся балл выбранного варианта
              { item: 5, matchKey: null },
            ],
          },
          {
            code: "B",
            title: { uk: "Шкала Б" },
            // код, которого нет ни у одного варианта: ошибка ключа, и на печати её должно быть видно
            key: [{ item: 1, matchKey: "k9" }],
          },
        ],
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    id = res.body.id;
  });

  /**
   * Мутация: вернуть колонки «yes»/«no»/«scored» без `keys` — пункты 2 и 4
   * шкалы А не попадают никуда, проверка называет код k3. Мутация: собирать
   * коды только из вариантов — k9 шкалы Б исчезает, проверка называет его.
   */
  test("коды берутся из вариантов методики, а не из списка «да/нет»", async () => {
    const res = await api<SurveyKeySheet>(`/api/surveys/${id}/key`, adminA.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sheet = res.body;

    const codes = sheet.keyCodes.map((k) => k.code);
    expect(codes, "код k3 из вариантов выпал из ключевого листа").toContain("k3");
    expect(codes, "код k9, которого ждёт ключ шкалы Б, скрыт с печати").toContain("k9");
    // порядок — как ответы стоят в бланке; k9 — последним, его нет в вариантах
    expect(codes, "порядок колонок — не как ответы в бланке").toEqual(["yes", "no", "k3", "k9"]);
    expect(sheet.keyCodes.map((k) => k.label), "подпись колонки — не текст варианта").toEqual(["Так", "Ні", "Нінаю", "k9"]);

    const a = sheet.scales.find((s) => s.code === "A")!;
    expect(a.keys.map((k) => `${k.code}: ${k.items}`)).toEqual(["yes: 1", "no: 3", "k3: 2, 4", "k9: "]);
    expect(a.scored, "пункт без кода потерялся").toBe("5");
    expect(a.itemCount).toBe(5);

    const b = sheet.scales.find((s) => s.code === "B")!;
    expect(b.keys.find((k) => k.code === "k9")?.items, "ключ на несуществующий код скрыт с печати").toBe("1");

    // прежняя страница печати читает те же поля, что и раньше
    expect(a.yes).toBe("1");
    expect(a.no).toBe("3");
    expect(sheet.questionCount).toBe(5);
    expect(sheet.version).toBe(1);
  });
});
