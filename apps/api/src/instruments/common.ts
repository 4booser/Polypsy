import type { CreateSurveyDraft, QuestionDraft } from "@quizzy/shared";

/**
 * Общие части общедоступных методик каталога.
 *
 * Восемь опросников каталога устроены почти одинаково: список утверждений,
 * одна и та же шкала ответов у всех пунктов, сумма баллов, полосы по сумме.
 * Различаются шаг шкалы, число пунктов и пороги. Собирать это восемь раз
 * руками значит восемь раз завести одну и ту же опечатку в вариантах
 * ответа — а вариант ответа с неверным баллом не виден ни на экране, ни в
 * отчёте: он проявится только смещением суммы у всех, кто методику прошёл.
 */

export type Loc = { uk: string; ru: string };

/** Пара «украинский, русский» — так пункты и лежат в исходниках методик */
export const L = (uk: string, ru: string): Loc => ({ uk, ru });

/**
 * Шкала ответов: подписи с баллами, одинаковые для всех пунктов методики.
 *
 * Балл лежит в самом варианте, а не в ключе шкалы. Ключ тогда состоит из
 * одних номеров пунктов, и обратный ключ (`reverseScored`) считается
 * движком как min+max−балл — то есть ровно один раз и в одном месте.
 */
export type Anchor = [Loc, number];

export interface RiskMark {
  /** С какого балла вариант поднимает тревогу */
  fromScore: number;
  severity: "moderate" | "severe";
  label: Loc;
}

/** Пункт со стандартной шкалой ответов методики */
export function item(
  title: Loc,
  scaleCode: string,
  anchors: Anchor[],
  opts: { reverse?: boolean; risk?: RiskMark; help?: Loc } = {},
): QuestionDraft {
  return {
    type: "single",
    title,
    ...(opts.help ? { help: opts.help } : {}),
    required: true,
    scaleCode,
    reverseScored: opts.reverse ?? false,
    options: anchors.map(([text, score]) => ({
      text,
      score,
      ...(opts.risk && score >= opts.risk.fromScore
        ? {
            riskFlag: true,
            riskSeverity: opts.risk.severity,
            riskLabel: opts.risk.label,
          }
        : {}),
    })),
  };
}

/** Ключ шкалы «сумма баллов пунктов с такими-то номерами» */
export const sumKey = (items: number[]) => items.map((n) => ({ item: n }));

/** Все пункты методики по порядку: 1..n */
export const allItems = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

export interface BandSpec {
  min: number;
  max: number;
  label: Loc;
  severity: "none" | "mild" | "moderate" | "severe";
  grade: number;
  recommendation?: Loc;
}

export const bands = (specs: BandSpec[]) =>
  specs.map((b) => ({
    minScore: b.min,
    maxScore: b.max,
    label: b.label,
    severity: b.severity,
    grade: b.grade,
    ...(b.recommendation ? { recommendation: b.recommendation } : {}),
  }));

/**
 * Оговорка о переводе, которая едет вместе с методикой.
 *
 * Проект уже принял это решение в другую сторону: английскую локализацию
 * отложили именно потому, что «свій англійський текст пунктів МЛО означав би
 * інструмент, який рахує людей за нормами, встановленими для іншого тексту».
 * Здесь то же самое зеркально: пороги GAD-7, PHQ-9, PCL-5 установлены для
 * англоязычного оригинала и его официальных переводов, а текст пунктов здесь
 * переведён при сборке каталога.
 *
 * Молчать об этом нельзя: методика считает человека и поднимает тревогу.
 * Поэтому оговорка стоит в описании — там, где специалист выбирает методику,
 * — а не в документации, которую при выборе не открывают.
 */
export const WORKING_TRANSLATION = L(
  "Робочий переклад. Пороги встановлені для оригіналу; перед клінічним використанням звірити з офіційним україномовним варіантом.",
  "Рабочий перевод. Пороги установлены для оригинала; перед клиническим использованием сверить с официальным украиноязычным вариантом.",
);

/** Описание методики с оговоркой о переводе одной строкой */
export const describe = (what: Loc): Loc =>
  L(`${what.uk} ${WORKING_TRANSLATION.uk}`, `${what.ru} ${WORKING_TRANSLATION.ru}`);

/**
 * Общие настройки общедоступной методики каталога.
 *
 * `visibility: "public"` — человек может пройти её сам, без назначения. Это
 * и просили: скрининги имеют смысл ровно тогда, когда до них можно
 * дотянуться в тот момент, когда плохо, а не через две недели на приёме.
 *
 * `allowRetake: true` — все восемь меряют состояние за последние недели, и
 * повторное прохождение через месяц это не «попытка переписать», а
 * следующий замер. Запрет здесь ломал бы динамику, ради которой методика и
 * нужна.
 */
export const PUBLIC_DEFAULTS: Partial<CreateSurveyDraft> = {
  administration: "self",
  visibility: "public",
  scoringEnabled: true,
  allowRetake: true,
  allowBack: true,
  showProgress: true,
};
