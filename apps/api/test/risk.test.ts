import { describe, expect, test } from "bun:test";
import { detectRisks } from "../src/lib/risk";

/**
 * Обнаружение критических ответов.
 *
 * Тревога решает, откроется ли случай и с какой тяжестью он попадёт в
 * очередь разбора. Занизить тяжесть здесь — значит поставить человека с
 * планом ухода из жизни ниже в списке.
 */
function question(options: { id: string; severity?: "moderate" | "severe" }[]) {
  return {
    id: "q1",
    type: "multiple" as const,
    title: "Что было за последнюю неделю?",
    required: false,
    riskThreshold: null,
    riskLabel: null,
    riskSeverity: null,
    options: options.map((o) => ({
      id: o.id,
      text: o.id,
      score: 1,
      riskFlag: true,
      riskLabel: o.id,
      riskSeverity: o.severity ?? null,
    })),
  };
}

describe("тяжесть тревоги", () => {
  test("берётся худший из отмеченных, а не первый по порядку", () => {
    /*
     * Цикл выходил на первом совпадении, то есть на варианте, который стоит
     * раньше. Вопрос с выбором нескольких — «мысли о смерти» (умеренная) и
     * «план ухода из жизни» (тяжёлая) — у человека, отметившего оба, давал
     * умеренную тревогу. Случай открывался умеренным и в очереди разбора
     * оказывался ниже тех, кому тяжелее не было.
     */
    const survey = {
      questions: [question([{ id: "мысли", severity: "moderate" }, { id: "план", severity: "severe" }])],
    } as never;
    const answers = [{ questionId: "q1", optionIds: ["мысли", "план"] }] as never;

    const risks = detectRisks(survey, answers);
    expect(risks.length).toBe(1);
    expect(risks[0]!.severity, "тяжёлый сигнал потерян за умеренным").toBe("severe");
  });

  test("порядок вариантов не меняет исход", () => {
    // тяжёлый стоит первым — результат обязан быть тем же
    const survey = {
      questions: [question([{ id: "план", severity: "severe" }, { id: "мысли", severity: "moderate" }])],
    } as never;
    const answers = [{ questionId: "q1", optionIds: ["мысли", "план"] }] as never;
    expect(detectRisks(survey, answers)[0]!.severity).toBe("severe");
  });

  test("один умеренный так и остаётся умеренным", () => {
    // повышать тяжесть на пустом месте тоже нельзя: случай пойдёт не тем путём
    const survey = { questions: [question([{ id: "мысли", severity: "moderate" }])] } as never;
    const answers = [{ questionId: "q1", optionIds: ["мысли"] }] as never;
    expect(detectRisks(survey, answers)[0]!.severity).toBe("moderate");
  });
});
