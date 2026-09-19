import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRule, ResponseDetailAnswer, RuleHit, Scale, ScoreResult } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { DocumentMenu, QuestionSheet, ResultLadder, SectionHead, applicableModels } from "../src/pages/Conclusion";

/**
 * Протокол заключения не различает выбранное одним цветом.
 *
 * На кадре выбранный вариант и попавшая полоса отличаются от остальных
 * заливкой — и больше ничем, что видно диктору. Экран добавляет к заливке два
 * признака: полужирное начертание и скрытую пометку. Оба легко потерять при
 * правке разметки — заливка останется, и глазом поломка не заметна: страница
 * выглядит ровно как макет. Поэтому проверяется разметка, а не картинка.
 */

const answer = (over: Partial<ResponseDetailAnswer> = {}): ResponseDetailAnswer => ({
  questionId: "q1",
  title: "Чи бували напади паніки?",
  type: "single",
  position: 1,
  answered: true,
  optionIds: ["o2"],
  options: [
    { id: "o1", text: "Ні", riskFlag: false, riskSeverity: null, score: null },
    { id: "o2", text: "Так", riskFlag: false, riskSeverity: null, score: null },
  ],
  text: null,
  number: null,
  date: null,
  matrix: null,
  ranking: null,
  score: 2,
  durationMs: 1000,
  changeCount: 0,
  visitCount: 1,
  events: [],
  ...over,
});

const render = (node: React.ReactElement) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

/** Строки протокола по признаку data-chosen / data-hit — так, как они доехали до разметки */
function rows(html: string, attr: "data-chosen" | "data-hit"): { on: boolean; html: string }[] {
  return [...html.matchAll(new RegExp(`<(?:li|div)[^>]*${attr}="(yes|no)"[^>]*>([\\s\\S]*?)<\\/(?:li|div)>`, "g"))].map(
    (m) => ({ on: m[1] === "yes", html: m[2]! }),
  );
}

describe("протокол заключения", () => {
  test("выбранный вариант помечен начертанием и скрытой подписью, а не одной заливкой", () => {
    const html = render(<QuestionSheet n={1} answer={answer()} scoreOf={(id) => (id === "o1" ? 0 : 2)} />);
    const lines = rows(html, "data-chosen");
    expect(lines.map((l) => l.on), "строк столько же, сколько вариантов, выбрана вторая").toEqual([false, true]);

    const chosen = lines[1]!;
    expect(chosen.html, "выбранный вариант не набран полужирным").toContain("font-bold");
    expect(chosen.html, "у выбранного нет скрытой пометки для диктора").toContain('class="sr-only"');
    expect(chosen.html).toContain("обрана відповідь");

    const other = lines[0]!;
    expect(other.html, "невыбранный вариант выглядит выбранным").not.toContain("font-bold");
    expect(other.html, "невыбранный вариант получил пометку выбранного").not.toContain("sr-only");
  });

  test("балл варианта берётся из методики, у неизвестного — прочерк, у выбранного — из ответа", () => {
    /*
     * Прохождение на старой версии методики: ни один вариант в действующей
     * версии не находится. Выбранный всё равно показывает балл — он записан в
     * самом ответе; остальные — прочерк, а не ноль: ноль был бы баллом.
     */
    const html = render(<QuestionSheet n={1} answer={answer()} scoreOf={() => null} />);
    const lines = rows(html, "data-chosen");
    expect(lines[0]!.html).toContain("—");
    expect(lines[0]!.html).not.toMatch(/>0</);
    expect(lines[1]!.html).toMatch(/>2</);
  });

  test("балл пункта не приписывается каждому из нескольких выбранных вариантов", () => {
    /*
     * У ответа один балл на весь пункт. На старой версии методики, где
     * баллов вариантов не найти, он подставляется выбранному варианту — но
     * только когда выбран один. Два выбранных с одной и той же суммой у
     * каждого выглядели бы как два балла по 5, которых не было.
     */
    const two = answer({ type: "multiple", optionIds: ["o1", "o2"], score: 5 });
    const both = rows(render(<QuestionSheet n={2} answer={two} scoreOf={() => null} />), "data-chosen");
    expect(both.map((l) => l.on)).toEqual([true, true]);
    for (const line of both) {
      expect(line.html).toContain("—");
      expect(line.html).not.toMatch(/>5</);
    }

    const one = answer({ type: "multiple", optionIds: ["o2"], score: 5 });
    const lines = rows(render(<QuestionSheet n={2} answer={one} scoreOf={() => null} />), "data-chosen");
    expect(lines[1]!.html).toMatch(/>5</);
    expect(lines[0]!.html).toContain("—");
  });

  test("вопрос без вариантов печатает ответ одной строкой, пропущенный — «без відповіді»", () => {
    const skipped = answer({ type: "number", answered: false, optionIds: null, options: [], score: null });
    const html = render(<QuestionSheet n={3} answer={skipped} scoreOf={() => null} />);
    const [line] = rows(html, "data-chosen");
    expect(line!.on).toBe(false);
    expect(line!.html).toContain("без відповіді");
  });
});

const scale = (bands: [number, number, string][]): Scale => ({
  id: "s1",
  surveyId: "sv",
  code: "A",
  title: "Тривога",
  description: null,
  aggregation: "sum",
  position: 1,
  kind: "clinical",
  normalization: "raw",
  ratioDenominator: null,
  validityThreshold: null,
  validityDirection: null,
  validityMessage: null,
  bands: bands.map(([minScore, maxScore, label], i) => ({
    id: `b${i}`,
    scaleId: "s1",
    minScore,
    maxScore,
    label,
    severity: "none",
    description: null,
    grade: null,
    recommendation: null,
    cascadeBatteryId: null,
    cascadeDueDays: null,
    followUpDays: null,
    position: i,
  })),
  items: [],
  corrections: [],
  norms: [],
  stenTable: [],
});

const score = (value: number, band: ScoreResult["band"]): ScoreResult => ({
  scaleId: "s1",
  scaleCode: "A",
  scaleTitle: "Тривога",
  kind: "clinical",
  rawScore: value,
  correctedScore: value,
  value,
  normalized: true,
  normalization: "raw",
  maxScore: 30,
  percent: 50,
  band,
});

describe("лестница результатов", () => {
  const ladder = scale([
    [1, 10, "низький"],
    [11, 20, "помірний"],
    [21, 30, "високий"],
  ]);

  test("попавшая полоса выбирается по значению и помечена не только заливкой", () => {
    const html = render(
      <ResultLadder scores={[score(15, { label: "помірний", severity: "mild", description: null, grade: null, recommendation: null })]} scales={[ladder]} />,
    );
    const lines = rows(html, "data-hit");
    expect(lines.map((l) => l.on), "полос три, попала средняя").toEqual([false, true, false]);
    expect(lines[1]!.html).toContain("font-bold");
    expect(lines[1]!.html).toContain("результат пацієнта");
    expect(lines[0]!.html).not.toContain("font-bold");
  });

  test("ненормированный балл не попадает ни в одну полосу, даже если число в диапазоне", () => {
    /*
     * Движок подсчёта не назначает полосу, когда нормировать не удалось
     * (нет нормы для пола, балл вне таблицы стенов): значение не в тех
     * единицах. Лестница обязана повторять это, а не «подбирать» полосу по
     * числу — иначе на экране заключения стояла бы интерпретация, которой
     * движок не давал.
     */
    const html = render(<ResultLadder scores={[score(15, null)]} scales={[ladder]} />);
    expect(rows(html, "data-hit").map((l) => l.on)).toEqual([false, false, false]);
  });

  test("шкала без полос лестницы не рисует", () => {
    expect(render(<ResultLadder scores={[score(15, null)]} scales={[scale([])]} />)).toBe("");
  });
});

describe("заголовки и меню документа", () => {
  test("действие при заголовке раздела стоит рядом с h2, а не внутри него", () => {
    /*
     * Имя заголовка для диктора собирается из содержимого h2. Ссылка внутри
     * приклеила бы свою подпись к имени раздела — и секции, которая через
     * aria-labelledby на него ссылается. Глазом не видно: ряд тот же.
     */
    const html = render(
      <SectionHead id="cn-tests" action={<a href="/batteries" aria-label="Додати тест">+</a>}>
        Список тестів
      </SectionHead>,
    );
    const heading = /<h2 id="cn-tests"[^>]*>([\s\S]*?)<\/h2>/.exec(html);
    expect(heading?.[1]).toBe("Список тестів");
    expect(html, "ссылка пропала вместе с выносом из заголовка").toContain('aria-label="Додати тест"');
  });

  test("закрытое меню не ссылается на несуществующий элемент", () => {
    /* aria-controls обязан указывать на существующий id; закрытое меню в разметке отсутствует */
    const html = render(<DocumentMenu responseId="r1" />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain('id="conclusion-menu"');
  });
});

type Rule = DecisionRule & { note: string | null };
const rule = (id: string, title: string, over: Partial<Rule> = {}): Rule => ({
  id,
  title,
  version: 1,
  enabled: true,
  conditions: [{ kind: "risk", severity: "severe" }],
  actions: [{ kind: "notify_duty" }],
  note: null,
  ...over,
});

const hit = (responseId: string, ruleTitle: string): RuleHit => ({
  id: `h-${responseId}-${ruleTitle}`,
  ruleTitle,
  ruleVersion: 1,
  userId: "u1",
  userName: "—",
  surveyId: "sv",
  responseId,
  status: "suggested",
  explanation: { title: ruleTitle, because: [{ met: true, text: "тяжкий ризик" }], actions: [] },
  createdAt: "2026-09-19T00:00:00.000Z",
});

describe("аналитические модели заключения", () => {
  test("вердикт — по срабатыванию именно этого прохождения; чужие модели и выключенные не в списке", () => {
    const rules = [
      rule("r1", "Тяжкий ризик"),
      rule("r2", "Інша методика", {
        conditions: [{ kind: "scale", surveyId: "other", scaleCode: "B", metric: "raw", op: ">=", value: 1 }],
      }),
      rule("r3", "Вимкнене", { enabled: false }),
      rule("r4", "Своя шкала", {
        conditions: [{ kind: "scale", surveyId: "sv", scaleCode: "A", metric: "raw", op: ">=", value: 1 }],
        note: "пояснення до правила",
      }),
    ];
    const hits = [hit("resp-1", "Тяжкий ризик"), hit("resp-2", "Своя шкала")];

    const models = applicableModels(rules, hits, "resp-1", "sv");
    expect(models.map((m) => `${m.title}: ${m.matched ? "так" : "ні"}`)).toEqual(["Тяжкий ризик: так", "Своя шкала: ні"]);
    /* описание: пояснение правила, а без него — объяснение движка у сработавшего */
    expect(models[0]!.description).toBe("тяжкий ризик");
    expect(models[1]!.description).toBe("пояснення до правила");
  });
});
