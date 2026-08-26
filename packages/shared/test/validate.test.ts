import { describe, expect, test } from "bun:test";
import { createSurveySchema } from "../src/schemas";
import { validateSurvey, type Issue } from "../src/validate";

/**
 * По одному тесту на каждый класс проблем.
 *
 * Черновики здесь минимальны: валидатор работает по формату CreateSurveyInput
 * (ключ ссылается на НОМЕРА пунктов), и каждая конструкция — самый маленький
 * черновик, в котором проблема воспроизводится.
 */

const q = (over: Record<string, unknown> = {}) => ({
  type: "yesno",
  title: { uk: "Пункт", ru: "Пункт" },
  options: [
    { text: { uk: "Так", ru: "Да" }, keyCode: "yes" },
    { text: { uk: "Ні", ru: "Нет" }, keyCode: "no" },
  ],
  ...over,
});

const scale = (over: Record<string, unknown> = {}) => ({
  code: "S",
  title: { uk: "Шкала", ru: "Шкала" },
  kind: "clinical",
  key: [{ item: 1, matchKey: "yes" }],
  bands: [{ minScore: 0, maxScore: 1, label: { uk: "Норма", ru: "Норма" }, severity: "none" }],
  ...over,
});

/**
 * Черновик прогоняется через zod-схему, как это делает сервер: валидатор
 * работает по разобранному входу, где проставлены значения по умолчанию
 * (kind: "option" у вариантов и т.п.). Гонять его по сырому объекту значило бы
 * тестировать не тот путь, который выполняется в бою.
 */
function run(draft: Record<string, unknown>): Issue[] {
  const parsed = createSurveySchema.parse({
    title: { uk: "Тест", ru: "Тест" },
    ...draft,
  });
  return validateSurvey(parsed);
}

const errorAbout = (issues: Issue[], fragment: string) =>
  issues.some((i) => i.level === "error" && i.message.includes(fragment));
const warningAbout = (issues: Issue[], fragment: string) =>
  issues.some((i) => i.level === "warning" && i.message.includes(fragment));

describe("валидатор структуры методики", () => {
  test("чистая методика проходит без ошибок", () => {
    const issues = run({ questions: [q()], scales: [scale()] });
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("дублированный код шкалы отбивает уже zod-схема", () => {
    // до валидатора такой черновик не доходит: защита стоит на входе
    const result = createSurveySchema.safeParse({
      title: { uk: "Т", ru: "Т" },
      questions: [q()],
      scales: [scale(), scale()],
    });
    expect(result.success).toBe(false);
  });

  test("номер пункта за пределами методики", () => {
    const issues = run({ questions: [q()], scales: [scale({ key: [{ item: 7, matchKey: "yes" }] })] });
    expect(errorAbout(issues, "в методике их 1")).toBe(true);
  });

  test("пункт в ключе дважды", () => {
    const issues = run({
      questions: [q()],
      scales: [scale({ key: [{ item: 1, matchKey: "yes" }, { item: 1, matchKey: "yes" }] })],
    });
    expect(errorAbout(issues, "дважды")).toBe(true);
  });

  test("противоречие: пункт требует и «да», и «нет»", () => {
    const issues = run({
      questions: [q()],
      scales: [scale({ key: [{ item: 1, matchKey: "yes" }, { item: 1, matchKey: "no" }] })],
    });
    expect(errorAbout(issues, "противоречие")).toBe(true);
  });

  test("ключ ждёт вариант, которого у пункта нет", () => {
    const issues = run({ questions: [q()], scales: [scale({ key: [{ item: 1, matchKey: "maybe" }] })] });
    expect(errorAbout(issues, "ключ ждёт вариант")).toBe(true);
  });

  test("поправка на несуществующую шкалу и на саму себя", () => {
    const missing = run({ questions: [q()], scales: [scale({ corrections: [{ from: "K", coefficient: 1 }] })] });
    expect(errorAbout(missing, "которой нет")).toBe(true);

    const self = run({ questions: [q()], scales: [scale({ corrections: [{ from: "S", coefficient: 1 }] })] });
    expect(errorAbout(self, "саму себя")).toBe(true);
  });

  test("взаимные поправки двух шкал", () => {
    const issues = run({
      questions: [q(), q()],
      scales: [
        scale({ code: "A", corrections: [{ from: "B", coefficient: 1 }] }),
        scale({ code: "B", key: [{ item: 2, matchKey: "yes" }], corrections: [{ from: "A", coefficient: 1 }] }),
      ],
    });
    expect(errorAbout(issues, "Взаимная поправка")).toBe(true);
  });

  test("tscore без норм — ошибка, sten без таблицы — ошибка", () => {
    const t = run({ questions: [q()], scales: [scale({ normalization: "tscore" })] });
    expect(errorAbout(t, "T-баллы без норм")).toBe(true);

    const s = run({ questions: [q()], scales: [scale({ normalization: "sten" })] });
    expect(errorAbout(s, "Стены без таблицы")).toBe(true);
  });

  test("норму с нулевым SD отбивает уже zod-схема", () => {
    const result = createSurveySchema.safeParse({
      title: { uk: "Т", ru: "Т" },
      questions: [q()],
      scales: [scale({ normalization: "tscore", norms: [{ sex: null, mean: 5, sd: 0 }] })],
    });
    expect(result.success).toBe(false);
  });

  test("пересекающиеся интерпретационные нормы", () => {
    const issues = run({
      questions: [q()],
      scales: [
        scale({
          bands: [
            { minScore: 0, maxScore: 5, label: { uk: "А", ru: "А" }, severity: "none" },
            { minScore: 4, maxScore: 10, label: { uk: "Б", ru: "Б" }, severity: "mild" },
          ],
        }),
      ],
    });
    expect(errorAbout(issues, "пересекаются")).toBe(true);
  });

  test("пересекающиеся строки стенов и дырка в нуле", () => {
    const overlap = run({
      questions: [q()],
      scales: [
        scale({
          normalization: "sten",
          stenTable: [
            { rawMin: 0, rawMax: 3, sten: 1 },
            { rawMin: 3, rawMax: 6, sten: 2 },
          ],
        }),
      ],
    });
    expect(errorAbout(overlap, "пересекаются по сырому баллу")).toBe(true);

    const gap = run({
      questions: [q()],
      scales: [scale({ normalization: "sten", stenTable: [{ rawMin: 1, rawMax: 5, sten: 1 }] })],
    });
    expect(warningAbout(gap, "нулевой балл никуда не попадёт")).toBe(true);
  });

  test("порог достоверности без направления", () => {
    const issues = run({
      questions: [q()],
      scales: [scale({ kind: "validity", validityThreshold: 0.6 })],
    });
    expect(errorAbout(issues, "с какой стороны")).toBe(true);
  });

  test("вопрос с выбором, но без вариантов", () => {
    const issues = run({ questions: [q({ options: [] })], scales: [] });
    expect(errorAbout(issues, "минимум двух вариантов")).toBe(true);
  });

  test("критический вариант без текста тревоги — предупреждение", () => {
    const issues = run({
      questions: [
        q({
          options: [
            { text: { uk: "Так", ru: "Да" }, keyCode: "yes", riskFlag: true },
            { text: { uk: "Ні", ru: "Нет" }, keyCode: "no" },
          ],
        }),
      ],
      scales: [],
    });
    expect(warningAbout(issues, "без текста тревоги")).toBe(true);
  });

  test("настоящие методики проекта проходят валидатор", async () => {
    // это живой регресс: если кто-то испортит ключ инструмента, тест упадёт
    const { sr45 } = await import("../../../apps/api/src/instruments/sr45");
    const { minimult } = await import("../../../apps/api/src/instruments/minimult");
    const { mlo } = await import("../../../apps/api/src/instruments/mlo");
    const { sadPersons } = await import("../../../apps/api/src/instruments/sadPersons");
    for (const inst of [sr45, minimult, mlo, sadPersons]) {
      // тот же путь, что при посеве: сначала схема, потом валидатор
      const errors = validateSurvey(createSurveySchema.parse(inst)).filter(
        (i) => i.level === "error",
      );
      expect(errors).toEqual([]);
    }
  });
});
