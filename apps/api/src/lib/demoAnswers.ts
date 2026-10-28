import { answerScore, isQuestionVisible, type Answer, type Question, type SurveyFull } from "@quizzy/shared";
import { rng } from "./demoPeople";

/**
 * Ответы вымышленного человека на конкретную методику.
 *
 * Подбираются под балл, который задаёт история человека (lib/demoStories.ts),
 * а не выводятся из «уровня» случайным разбросом. Прежняя редакция брала у
 * каждого пункта вариант около общего уровня, и сумма получалась какая
 * выйдет: у «улучшающегося» PHQ-9 мог подскочить на пять баллов, девятый
 * пункт отмечался у каждого третьего, и тревога риска висела на восьмидесяти
 * четырёх людях из ста двадцати. История «PCL-5 с 56 до 24 за курс» так не
 * пишется — её надо попадать в баллы.
 *
 * Поэтому на входе — цель по шкале (сумма или среднее, в единицах шкалы), на
 * выходе — ответы, которые дают ровно её по тому же движку, что считает живых
 * (answerScore: обратный ключ, вес пункта). Варианты с пометкой риска
 * подбор не берёт никогда, если история не разрешила: критический ответ —
 * решение сюжета («у этого человека кризис»), а не побочный эффект суммы.
 *
 * Какие пункты набирают балл, решает устойчивый рисунок человека (веса):
 * у одного больше сон и раздражительность, у другого — уход в себя, и рисунок
 * один и тот же от замера к замеру. Без него все пункты росли и падали бы
 * разом, а согласованность пунктов (альфа в аналитике методики) вышла бы
 * неправдоподобно идеальной.
 *
 * Опознаётся методика по ключу каталога, а не по названию: название вправе
 * изменить специалист.
 */

export interface AnswerPlan {
  /**
   * Цель по шкале — по её коду, в единицах шкалы: сумма у суммы, среднее у
   * среднего. Шкалы без цели набирают то, что дадут их пункты.
   */
  targets: Record<string, number>;
  /**
   * Ответы на отдельные пункты по номеру с единицы: балл варианта по бланку
   * (до обратного ключа) или, у пункта с выбором нескольких, номера вариантов
   * с нуля. Так задаются ворота (PC-PTSD-5, MIOS, SIDAS), девятый пункт
   * PHQ-9 и ответы интервью C-SSRS.
   */
  fixed?: Record<number, number | number[]>;
  /** Может ли подбор брать варианты с пометкой риска; fixed берёт их всегда */
  allowRisk?: boolean;
  /** Зерно: от него рисунок пунктов и время на пункт */
  seed: number;
}

export interface DemoAnswer {
  questionId: string;
  optionIds?: string[];
  number?: number;
  durationMs: number;
  changeCount: number;
  visitCount: number;
}

/** Вариант ответа с его вкладом в шкалу — после обратного ключа и веса пункта */
interface Choice {
  optionId: string;
  value: number;
}

function choicesOf(q: Question, weight: number, allowRisk: boolean): Choice[] {
  const out: Choice[] = [];
  for (const o of q.options) {
    if (o.kind !== "option") continue;
    if (o.riskFlag && !allowRisk) continue;
    const contribution = answerScore(q, { questionId: q.id, optionIds: [o.id] });
    if (contribution === null) continue;
    out.push({ optionId: o.id, value: contribution * weight });
  }
  // от меньшего вклада к большему; равные — в порядке бланка
  return out.sort((a, b) => a.value - b.value);
}

/** Вариант бланка с заданным баллом — для fixed */
function optionWithScore(q: Question, score: number): string | null {
  return q.options.find((o) => o.kind === "option" && o.score === score)?.id ?? null;
}

/**
 * Разложить сумму по пунктам.
 *
 * Каждый пункт начинает с наименьшего вклада, затем по шагу растёт тот, у кого
 * вес выше, а заполненность меньше. Шаг, перескакивающий цель, берётся только
 * если меньшего нет ни у кого (у CES варианты идут через два). Итог — ровно
 * цель там, где шаг единичный, и ближайшее снизу или сверху — где нет.
 */
function distribute(items: { choices: Choice[]; weight: number }[], target: number, r: () => number): number[] {
  const at = items.map(() => 0);
  const value = (i: number) => items[i]!.choices[at[i]!]!.value;
  let sum = items.reduce((s, _, i) => s + value(i), 0);
  const jitter = items.map(() => 0.85 + r() * 0.3);

  for (let guard = 0; guard < 2000 && sum < target - 1e-9; guard++) {
    let best = -1;
    let bestScore = -Infinity;
    let fallback = -1;
    let fallbackStep = Infinity;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const next = at[i]! + 1;
      if (next >= it.choices.length) continue;
      const step = it.choices[next]!.value - value(i);
      const lo = it.choices[0]!.value;
      const hi = it.choices[it.choices.length - 1]!.value;
      const fill = hi > lo ? (value(i) - lo) / (hi - lo) : 1;
      const score = it.weight * jitter[i]! * (1 - fill) + it.weight * 0.05;
      if (step <= target - sum + 1e-9) {
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      } else if (step < fallbackStep) {
        fallbackStep = step;
        fallback = i;
      }
    }
    const chosen = best >= 0 ? best : fallback;
    if (chosen < 0) break;
    // перескок — только если он ближе к цели, чем остановка здесь
    if (best < 0 && sum + fallbackStep - target > target - sum) break;
    sum += items[chosen]!.choices[at[chosen]! + 1]!.value - value(chosen);
    at[chosen] = at[chosen]! + 1;
  }
  return at;
}

/**
 * Ответы на все пункты методики по плану.
 *
 * Порядок: сначала заданные (fixed), по ним — видимость остальных; затем
 * шкалы с целью, от меньшей к большей (у PHQ-4 подшкалы тревоги и депрессии
 * раскладываются раньше общей суммы, которую они и составляют); пункт,
 * оставшийся без шкалы с целью, — наименьший некритический вариант.
 * Скрытый условием показа пункт не отвечается вовсе: такой ответ сервер
 * отбросил бы с пометкой в журнале, а живой человек его не видел.
 */
export function demoAnswers(survey: SurveyFull, plan: AnswerPlan): DemoAnswer[] {
  const r = rng(plan.seed);
  const index = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  const chosen = new Map<string, string[]>();
  const answers = new Map<string, Answer>();
  const put = (q: Question, optionIds: string[]) => {
    chosen.set(q.id, optionIds);
    answers.set(q.id, { questionId: q.id, optionIds });
  };

  // 1. заданные ответы — в порядке бланка: ворота стоят раньше зависимых пунктов
  for (const q of survey.questions) {
    const want = plan.fixed?.[index.get(q.id)!];
    if (want === undefined || q.type === "info") continue;
    if (Array.isArray(want)) {
      const options = q.options.filter((o) => o.kind === "option");
      put(q, want.map((k) => options[k]?.id).filter((id): id is string => !!id));
    } else {
      const id = optionWithScore(q, want);
      if (id) put(q, [id]);
    }
  }

  const visible = (q: Question) => isQuestionVisible(q, survey.questions, answers);
  // заданный ответ на пункт, который его же ворота скрыли, — убрать: его не задавали
  for (const q of survey.questions) if (chosen.has(q.id) && !visible(q)) chosen.delete(q.id);

  // 2. шкалы с целью — от меньшей к большей
  const scales = survey.scales
    .filter((s) => plan.targets[s.code] !== undefined)
    .sort((a, b) => a.items.length - b.items.length);
  const byId = new Map(survey.questions.map((q) => [q.id, q]));
  /* рисунок пунктов человека: вес пункта устойчив от замера к замеру при одном зерне истории */
  const profile = rng(Math.floor(plan.seed / 1000) * 1000 + 17);
  const weightOf = new Map(survey.questions.map((q) => [q.id, 0.35 + profile() * 0.65]));

  for (const scale of scales) {
    const members = scale.items
      .map((item) => ({ item, q: byId.get(item.questionId) }))
      .filter((m): m is { item: (typeof scale.items)[number]; q: Question } => !!m.q && visible(m.q));
    if (!members.length) continue;
    const goal = plan.targets[scale.code]!;
    // среднее — по отвеченным пунктам шкалы: цель в единицах шкалы, сумма — на их число
    const total = scale.aggregation === "average" ? goal * members.length : goal;

    let already = 0;
    const free: { q: Question; choices: Choice[]; weight: number }[] = [];
    for (const m of members) {
      const picked = chosen.get(m.q.id);
      if (picked) {
        already += (answerScore(m.q, { questionId: m.q.id, optionIds: picked }) ?? 0) * m.item.weight;
        continue;
      }
      const choices = choicesOf(m.q, m.item.weight, plan.allowRisk ?? false);
      if (choices.length) free.push({ q: m.q, choices, weight: weightOf.get(m.q.id)! });
    }
    const at = distribute(free, total - already, r);
    free.forEach((f, i) => put(f.q, [f.choices[at[i]!]!.optionId]));
  }

  // 3. остальные видимые пункты: наименьший некритический вариант
  for (const q of survey.questions) {
    if (q.type === "info" || chosen.has(q.id) || !visible(q)) continue;
    const options = q.options.filter((o) => o.kind === "option");
    if (!options.length) continue;
    const safe = choicesOf(q, 1, false);
    const id = safe[0]?.optionId ?? options.find((o) => !o.riskFlag)?.id;
    if (id) put(q, [id]);
  }

  const out: DemoAnswer[] = [];
  for (const q of survey.questions) {
    const optionIds = chosen.get(q.id);
    if (!optionIds || !visible(q)) continue;
    out.push({
      questionId: q.id,
      optionIds,
      /*
       * Время на пункт правдоподобное, а не нулевое: проверка достоверности
       * бракует протоколы, пройденные быстрее порога, и посев с нулями
       * оказался бы весь недостоверным.
       */
      durationMs: 2600 + Math.floor(r() * 6400),
      changeCount: r() < 0.08 ? 1 : 0,
      visitCount: 1,
    });
  }
  return out;
}
