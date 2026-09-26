import type { Severity } from "@quizzy/shared";

/**
 * Арифметика лестницы полос — общая для линейки, профиля и динамики.
 *
 * Все три формы отвечают на один вопрос: «где этот балл относительно
 * ступеней интерпретации». Если каждая считает положение сама, они
 * разъезжаются на первой же лестнице с разрывами (0–4, 5–9, …) или с
 * дробными границами Т-баллов (44,9 / 45): линейка ставит маркер на границе,
 * а динамика — на ступень ниже. Поэтому счёт вынесен сюда, и формы только
 * рисуют то, что он вернул.
 *
 * Чистые функции без React: сценарии «балл за пределами лестницы», «одна
 * ступень», «пустая лестница» проверяются двумя строками в тесте
 * (apps/web/test/ladder.test.ts), а не правкой методики на живой базе.
 */

export interface Rung {
  min: number;
  max: number;
  label: string;
  severity: Severity;
}

export interface Domain {
  lo: number;
  hi: number;
}

/**
 * Ступени по возрастанию. Сервер отдаёт их уже упорядоченными, но форма не
 * должна зависеть от того, что кто-то однажды перестанет сортировать.
 */
export function sortRungs<T extends Rung>(rungs: readonly T[]): T[] {
  return [...rungs].sort((a, b) => a.min - b.min || a.max - b.max);
}

/**
 * Граница между соседними ступенями — посередине разрыва, а не на начале
 * следующей.
 *
 * У PHQ-9 «0–4» и «5–9»: балл 4 лежит в первой, 5 — во второй. Граница на
 * пятёрке поставила бы четвёрку у самого края первой ступени, а пятёрку —
 * РОВНО на границе, то есть визуально между ступенями. Граница на 4,5 кладёт
 * каждое целое в середину своей клетки. Для Т-баллов (44,9 / 45) и долей
 * (0,23 / 0,24) правило то же и даёт ту же честность, только мельче.
 *
 * Перекрытие ступеней (max одной больше min следующей) — ошибка ввода
 * методики; тогда границей берётся начало следующей, чтобы отрезки не
 * налезали друг на друга хотя бы на рисунке.
 */
export function boundaries(rungs: readonly Rung[]): number[] {
  const sorted = sortRungs(rungs);
  const out: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    out.push(b.min > a.max ? (a.max + b.min) / 2 : b.min);
  }
  return out;
}

/**
 * Область, в которой рисуется лестница.
 *
 * Края — края самой лестницы, а не данные: у линейки назначение ровно в том,
 * чтобы показать, какая часть лестницы осталась выше и ниже. Значения за
 * пределами лестницы (сырой балл без нормы, Т-балл за 120) растягивают
 * область до себя — маркер за краем полосы был бы враньём о том, куда он
 * попал.
 *
 * Без лестницы область — от нуля до известного максимума, а без максимума —
 * до самого большого значения: это уже не линейка, а шкала-метр, и ноль у
 * неё обязан быть на месте.
 */
export function ladderDomain(
  rungs: readonly Rung[],
  values: readonly (number | null | undefined)[] = [],
  max?: number | null,
): Domain {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (rungs.length) {
    const sorted = sortRungs(rungs);
    const lo = Math.min(sorted[0]!.min, ...known);
    const hi = Math.max(sorted.at(-1)!.max, ...known);
    return hi > lo ? { lo, hi } : { lo, hi: lo + 1 };
  }
  const top = Math.max(max ?? 0, ...known, 0);
  return { lo: 0, hi: top > 0 ? top : 1 };
}

/** Доля от 0 до 1 внутри области; за краями прижимается к краю */
export function share(value: number, d: Domain): number {
  const span = d.hi - d.lo;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (value - d.lo) / span));
}

export interface Segment<T extends Rung = Rung> {
  rung: T;
  /** Начало и ширина отрезка в долях области */
  start: number;
  width: number;
}

/**
 * Отрезки ступеней на области: каждый от своей левой границы до правой.
 *
 * Крайние отрезки упираются в края области, а не в min/max своей ступени:
 * иначе значение, вышедшее за лестницу, оказалось бы над пустым местом, и
 * глаз прочёл бы его как «вне всех ступеней», хотя сервер отнёс его к
 * крайней.
 */
export function segments<T extends Rung>(rungs: readonly T[], d: Domain): Segment<T>[] {
  const sorted = sortRungs(rungs);
  const cuts = boundaries(sorted);
  return sorted.map((rung, i) => {
    const from = i === 0 ? d.lo : cuts[i - 1]!;
    const to = i === sorted.length - 1 ? d.hi : cuts[i]!;
    const start = share(from, d);
    return { rung, start, width: Math.max(0, share(to, d) - start) };
  });
}

/**
 * В какую ступень попадает значение — тем же сравнением, что движок
 * подсчёта (value >= min && value <= max), а при попадании в разрыв —
 * по ближайшей границе. Нужна там, где сервер попавшую ступень не прислал:
 * у точек динамики есть подпись полосы, но нет её идентификатора.
 */
export function rungOf<T extends Rung>(rungs: readonly T[], value: number): T | null {
  const sorted = sortRungs(rungs);
  const exact = sorted.find((r) => value >= r.min && value <= r.max);
  if (exact) return exact;
  if (!sorted.length) return null;
  const cuts = boundaries(sorted);
  let i = 0;
  while (i < cuts.length && value > cuts[i]!) i++;
  return sorted[i] ?? null;
}

/**
 * Одинаковы ли лестницы у всех строк профиля.
 *
 * Только тогда маркеры строк можно соединить линией: соединённые точки
 * читаются как профиль в одной системе координат, а у шкал с разными
 * лестницами (сырой балл 0–27 рядом с долей 0–1) линия между ними соединяла
 * бы несоизмеримое.
 */
export function sameLadder(rows: readonly { rungs: readonly Rung[]; domain: Domain }[]): boolean {
  if (rows.length < 2) return false;
  const first = ladderKey(rows[0]!);
  return rows.every((r) => ladderKey(r) === first);
}

/** Отпечаток лестницы строки: одинаковый — значит, одна система координат */
export function ladderKey(r: { rungs: readonly Rung[]; domain: Domain }): string {
  return `${r.domain.lo}:${r.domain.hi}|${sortRungs(r.rungs)
    .map((x) => `${x.min}-${x.max}`)
    .join(",")}`;
}

/**
 * Отрезки линии профиля: подряд идущие строки с одной и той же лестницей.
 *
 * Правило «соединять, только если лестницы у всех одинаковые» выключало
 * линию целиком из-за одной шкалы: у Міні-мульта девятая шкала (Ma) норм
 * не имеет и рисуется сырым метром — и десять Т-шкал вокруг неё теряли
 * профиль. Здесь линия рвётся ровно на строке с другой лестницей (и на
 * строке без значения), а соседние строки одной системы координат
 * соединяются, как на бланке. Отрезок из одной строки — не линия.
 */
export function profileRuns(
  rows: readonly { rungs: readonly Rung[]; domain: Domain; value: number | null }[],
): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  let key: string | null = null;
  rows.forEach((r, i) => {
    const k = r.value === null || !r.rungs.length ? null : ladderKey(r);
    if (k !== null && k === key) {
      run.push(i);
    } else {
      if (run.length > 1) runs.push(run);
      run = k === null ? [] : [i];
    }
    key = k;
  });
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * Число для подписи: целое без хвоста, дробное — до двух знаков.
 *
 * Доли у СР-45 живут в сотых (0,23 / 0,24), Т-баллы — в десятых (44,9), и
 * одно правило «два знака, лишние нули прочь» подходит всем, не давая
 * 0.30000000000000004 из суммы.
 */
export function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}
