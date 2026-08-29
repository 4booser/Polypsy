import { isAnswered, type Answer, type Question } from "@quizzy/shared";

/**
 * Пропущенные обязательные пункты, оставшиеся позади.
 *
 * Правило кажется очевидным ровно до первой ошибки в нём, поэтому вынесено
 * отдельно и проверяется тестом. Три условия, и каждое значимо:
 *
 *  — только обязательные: необязательный пункт пропускают намеренно, и звать
 *    к нему обратно значит требовать того, чего методика не требует;
 *  — только позади: пункты впереди ещё не пропущены, и считать их пропусками
 *    значит пугать человека его собственным будущим;
 *  — без текущего: на нём стоят, а не прошли мимо.
 *
 * Информационные экраны не пункты и на них не отвечают.
 */
export function missedBefore(
  visible: Question[],
  answers: Map<string, Answer>,
  step: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < visible.length; i++) {
    if (i >= step) break;
    const q = visible[i]!;
    if (q.type === "info" || !q.required) continue;
    if (!isAnswered(q, answers.get(q.id))) out.push(i);
  }
  return out;
}
