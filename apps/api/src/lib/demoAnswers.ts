import type { SurveyFull } from "@quizzy/shared";
import type { Latent } from "./demoPeople";
import { rng } from "./demoPeople";

/**
 * Ответы вымышленного человека на конкретную методику.
 *
 * Выводятся из его скрытого состояния, а не берутся случайно. Это и есть
 * смысл всей затеи: случайные ответы дали бы нулевые корреляции между
 * шкалами, графики без формы и очередь разбора, наполненную равномерным
 * шумом. На таких данных нельзя ни проверить аналитику, ни показать её —
 * всё выглядит одинаково, потому что всё и есть одинаковое.
 *
 * Опознаётся методика по ключу каталога, а не по названию: название вправе
 * изменить специалист.
 */

/** Какой уровень скрытого состояния отвечает за эту методику */
function levelFor(key: string, l: Latent): number {
  switch (key) {
    case "gad7":
      return l.anxiety;
    case "phq9":
      return l.depression;
    case "pss10":
      return l.stress;
    case "pcl5":
      return l.ptsd;
    case "audit":
      return l.alcohol;
    case "pq16":
      return l.unusual;
    case "who5":
      return l.wellbeing;
    default:
      return 0.5;
  }
}

/**
 * Выбор варианта по уровню.
 *
 * Уровень 0 тянет к первому варианту, 1 — к последнему, шум разводит соседние
 * пункты. Без шума все пункты методики получили бы один и тот же ответ:
 * протокол из девяти одинаковых отметок выглядит как небрежность, и проверка
 * достоверности по времени и однообразию его бы и забраковала.
 */
function pickIndex(level: number, options: number, r: () => number): number {
  const spread = 0.22;
  const jitter = (r() + r() - 1) * spread;
  const pos = Math.max(0, Math.min(1, level + jitter));
  return Math.min(options - 1, Math.floor(pos * options));
}

export interface DemoAnswer {
  questionId: string;
  optionIds?: string[];
  number?: number;
  durationMs: number;
  changeCount: number;
  visitCount: number;
}

/**
 * Ответы на все пункты методики.
 *
 * Большая пятёрка — особый случай: у неё пять независимых шкал и обратные
 * пункты, и «уровень» у неё не один. Берётся черта, к которой пункт
 * относится, и обратный ключ учитывается — иначе профиль личности вышел бы
 * плоским у всех.
 */
export function demoAnswers(
  survey: SurveyFull,
  catalogKey: string,
  latent: Latent,
  seed: number,
): DemoAnswer[] {
  const r = rng(seed);
  const level = levelFor(catalogKey, latent);

  /* Пункт → буква шкалы и обратность: нужно только «большой пятёрке» */
  const traitOf = new Map<string, { trait: number; reverse: boolean }>();
  if (catalogKey === "big-five") {
    const codes = ["E", "A", "C", "N", "O"];
    for (const scale of survey.scales) {
      const idx = codes.indexOf(scale.code);
      if (idx < 0) continue;
      for (const item of scale.items) {
        const q = survey.questions.find((x) => x.id === item.questionId);
        traitOf.set(item.questionId, { trait: idx, reverse: q?.reverseScored ?? false });
      }
    }
  }

  const out: DemoAnswer[] = [];
  for (const q of survey.questions) {
    if (q.type === "info") continue;
    const options = q.options.filter((o) => o.kind === "option");
    if (!options.length) continue;

    let itemLevel = level;
    const trait = traitOf.get(q.id);
    if (trait) {
      const raw = latent.traits[trait.trait] ?? 0.5;
      // обратный пункт спрашивает о противоположном: высокая черта даёт низкий ответ
      itemLevel = trait.reverse ? 1 - raw : raw;
    }

    const idx = pickIndex(itemLevel, options.length, r);
    out.push({
      questionId: q.id,
      optionIds: [options[idx]!.id],
      /*
       * Время на пункт правдоподобное, а не нулевое: проверка достоверности
       * бракует протоколы, пройденные быстрее порога, и посев с нулями
       * оказался бы весь недостоверным.
       */
      durationMs: 2200 + Math.floor(r() * 5200),
      changeCount: r() < 0.12 ? 1 : 0,
      visitCount: 1,
    });
  }
  return out;
}
