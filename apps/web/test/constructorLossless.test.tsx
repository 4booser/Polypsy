import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, makeUiT, type SurveyFull } from "@quizzy/shared";
import { ApiError } from "../src/api";
import { LangProvider } from "../src/lang";
import { VersionConflict, saveFailure } from "../src/pages/constructor/Conflict";
import { newUid, switchMode, toDraft, toPayload, type Draft } from "../src/pages/constructor/model";

/**
 * Конструктор без потерь и с конфликтом версий (волна 12, находка участка
 * engine). Круговой путь по всем встроенным методикам и каталогу проверяет
 * apps/api/test/constructorRoundtrip.test.ts на настоящей базе; здесь —
 * правка черновика, которой там нет (перестановка, новый пункт), и экран
 * отказа 409.
 */

const L = (s: string) => ({ uk: s, ru: s });
const q = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "single",
  title: L(id),
  help: null,
  required: true,
  sectionId: null,
  scaleId: "sc-total",
  reverseScored: false,
  minValue: null,
  maxValue: null,
  step: null,
  minLabel: null,
  maxLabel: null,
  randomizeOptions: false,
  timeLimitSec: null,
  riskThreshold: null,
  riskLabel: null,
  riskSeverity: null,
  logic: [],
  options: [
    { id: `${id}-a`, kind: "option", text: L("так"), score: 1, keyCode: null, riskFlag: false, riskLabel: null, riskSeverity: null },
    { id: `${id}-b`, kind: "option", text: L("ні"), score: 0, keyCode: null, riskFlag: false, riskLabel: null, riskSeverity: null },
  ],
  ...extra,
});

/** Итоговая шкала с ключом по коду (как у каталога) и условие «q3 — если на q1 ответили “так”» */
const survey = {
  id: "sv",
  versionId: "ver-1",
  title: L("Тест"),
  description: null,
  instructions: null,
  safetyPlan: null,
  showResultsToPatient: true,
  groupId: null,
  administration: "self",
  visibility: "public",
  scoringEnabled: true,
  allowRetake: false,
  showProgress: true,
  allowBack: true,
  anonymous: false,
  randomizeQuestions: false,
  timeLimitSec: null,
  tooFastMs: null,
  alertEscalateMinutes: null,
  sections: [],
  questions: [
    q("q1", { reverseScored: true }),
    q("q2"),
    q("q3", { logic: [{ id: "l1", questionId: "q3", sourceQuestionId: "q1", operator: "eq", value: "q1-a", action: "show" }] }),
  ],
  scales: [
    {
      id: "sc-total",
      code: "total",
      title: L("Разом"),
      description: null,
      aggregation: "sum",
      kind: "clinical",
      normalization: "raw",
      ratioDenominator: null,
      validityThreshold: null,
      validityDirection: null,
      validityMessage: null,
      minAnsweredShare: 0.8,
      items: ["q1", "q2", "q3"].map((questionId) => ({ questionId, matchKey: null, weight: 1 })),
      corrections: [],
      norms: [],
      stenTable: [],
      bands: [],
    },
  ],
} as unknown as SurveyFull;

describe("правка черновика не теряет и не сдвигает", () => {
  test("перестановка пунктов не переносит условие показа на соседа", () => {
    /*
     * Условие хранилось бы номером источника — после «↑» у q2 номер 0
     * указывал бы уже на q2. Источник держится по uid, номер считается при
     * отправке.
     */
    const d = toDraft(survey, []);
    const moved: Draft = { ...d, questions: [d.questions[1]!, d.questions[0]!, d.questions[2]!] };
    const logic = toPayload(moved).questions[2]!.logic;
    expect(logic).toEqual([{ sourceIndex: 1, operator: "eq", value: "q1-a", action: "show" }]);
  });

  test("удалённый источник — условия нет, а не условие на чужой пункт", () => {
    const d = toDraft(survey, []);
    const without: Draft = { ...d, questions: d.questions.filter((x) => x.uid !== "q1") };
    expect(toPayload(without).questions[1]!.logic).toEqual([]);
  });

  test("ключ по коду шкалы уходит пустым, пока его не тронули; новый пункт в комплексном — в итог", () => {
    const d = toDraft(survey, []);
    expect(d.mode).toBe("complex");
    expect(d.totalKeyManaged).toBe(true);
    expect(toPayload(d).scales[0]!.key).toEqual([]);
    const added: Draft = {
      ...d,
      questions: [...d.questions, { uid: newUid(), type: "single", title: L("q4"), required: true, options: [] }],
    };
    expect(toPayload(added).scales[0]!.key.map((k) => k.item)).toEqual([1, 2, 3, 4]);
  });

  test("ключ пособия (не все пункты) конструктор не переписывает", () => {
    const partial = {
      ...survey,
      scales: [{ ...survey.scales[0]!, items: survey.scales[0]!.items.slice(0, 2) }],
    } as SurveyFull;
    const d = toDraft(partial, []);
    expect(d.totalKeyManaged).toBe(false);
    expect(toPayload(d).scales[0]!.key.map((k) => k.item)).toEqual([1, 2]);
    // явное переключение в комплексный — просьба собрать итог самому
    expect(switchMode({ ...d, mode: "specific" }, "complex").totalKeyManaged).toBe(true);
  });

  test("поля без редактора и сверка версии доезжают до payload", () => {
    const p = toPayload(toDraft(survey, []));
    expect(p.baseVersionId).toBe("ver-1");
    expect(p.showResultsToPatient).toBe(true);
    expect(p.questions[0]!.reverseScored).toBe(true);
    expect(p.questions[0]!.scaleCode).toBe("total");
    expect(p.scales[0]!.minAnsweredShare).toBe(0.8);
    expect("totalKeyManaged" in p).toBe(false);
  });
});

describe("экран отказа 409", () => {
  const serverText = "Методику щойно змінили в іншому вікні або інша людина. Відкрийте її заново й повторіть зміни";

  test("409 — это конфликт версий, прочие отказы — обычная ошибка", () => {
    expect(saveFailure(new ApiError(serverText, 409), "x")).toEqual({ conflict: true, message: serverText });
    expect(saveFailure(new ApiError("Немає прав", 403), "x")).toEqual({ conflict: false, message: "Немає прав" });
    expect(saveFailure("щось", "запасний текст")).toEqual({ conflict: false, message: "запасний текст" });
  });

  test("экран объясняет и предлагает перечитать", () => {
    const html = renderToStaticMarkup(
      <LangProvider>
        <VersionConflict message={serverText} onReload={() => {}} onShowMine={() => {}} />
      </LangProvider>,
    );
    const t = makeUiT("uk");
    expect(html).toContain('role="alert"');
    expect(html).toContain(serverText);
    // язык консоли в проверке — украинский по умолчанию или русский; ищем тексты обоих
    const has = (k: "co.conflictReload" | "co.conflictShowMine" | "co.conflictTitle") =>
      html.includes(UI[k].uk) || html.includes(UI[k].ru) || html.includes(t(k));
    expect(has("co.conflictTitle")).toBe(true);
    expect(has("co.conflictReload")).toBe(true);
    expect(has("co.conflictShowMine")).toBe(true);
  });
});
