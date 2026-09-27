import { questionScoreRange, type SurveyFull } from "@quizzy/shared";

/**
 * Одинаково ли две версии методики считают СЫРОЙ балл шкалы.
 *
 * Средние и нормы складывают значения разных прохождений, а прохождения
 * живут на разных версиях. T-балл и стен от версии не зависят: это уже
 * приведённая величина — норма для того и существует, чтобы у всех версий
 * было 50 ± 10. Сырой балл и доля — зависят: убрали пункт из ключа — и
 * «11» во второй версии значит не то, что «11» в первой. Складывать их —
 * та же ошибка, что складывать T-баллы с сырыми.
 *
 * Отпечаток собирает всё, от чего зависит сырой балл шкалы (движок,
 * packages/shared/src/scoring.ts): способ свёртки, знаменатель доли, ключ —
 * пункт, ожидаемый ответ, вес, — и у каждого пункта его тип, обратный ключ,
 * размах и баллы вариантов; поправки — вместе с отпечатком шкалы-источника
 * (K у Мини-мульта). Названия, описания, полосы и нормы в отпечаток не
 * входят: они меняют интерпретацию, а не сам сырой балл, — поэтому версия,
 * где поменяли только нормы (публикация локальных норм), с прежней
 * сравнима, и её прохождения в выборку норм идут.
 *
 * Пункт узнаётся по позиции в методике, а не по идентификатору: новая
 * версия создаёт вопросы заново (lib/surveys.ts, createVersion), и
 * идентификаторы у двух версий всегда разные. Перестановка пунктов поэтому
 * считается правкой ключа — осторожная ошибка: лучше развести сравнимое,
 * чем сложить несравнимое.
 *
 * null — шкалы с таким кодом в версии нет.
 */
export function rawSignature(survey: SurveyFull, code: string, seen: ReadonlySet<string> = new Set()): string | null {
  const scale = survey.scales.find((s) => s.code === code);
  if (!scale) return null;
  // поправка по кругу — не отпечаток, а ошибка методики; хватит того, что круг замкнут
  if (seen.has(code)) return `↻${code}`;
  const next = new Set([...seen, code]);

  const questionById = new Map(survey.questions.map((q) => [q.id, q]));
  const items = scale.items
    .map((item) => {
      const q = questionById.get(item.questionId);
      if (!q) return `?:${item.matchKey ?? "*"}:${item.weight}`;
      const range = questionScoreRange(q);
      const options = q.options.map((o) => `${o.kind}:${o.keyCode ?? "-"}=${o.score}`).join("|");
      return [q.position, item.matchKey ?? "*", item.weight, q.type, q.reverseScored, `${range.min}..${range.max}`, options].join(":");
    })
    .sort()
    .join(",");
  const corrections = scale.corrections
    .map((c) => `${c.sourceScaleCode}×${c.coefficient}=${rawSignature(survey, c.sourceScaleCode, next)}`)
    .sort()
    .join(",");
  return [scale.aggregation, scale.ratioDenominator ?? "", items, corrections].join("#");
}
