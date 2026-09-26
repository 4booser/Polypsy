import type { BandSpread, ConditionDomain, ConditionSummary, Severity } from "@quizzy/shared";
import { SMALL_CELL_FLOOR, suppress } from "./privacy";

/**
 * Состояние пациентов по клиническим направлениям — арифметика сводки.
 *
 * Заказчик просил на стартовом экране «средний уровень стресса, депрессии,
 * тревоги и подобное». Буквально это сделать нельзя: у PHQ-9 балл 0–27, у
 * CESD-R 0–60, у DASS-42 0–42 на подшкалу, у CBI — среднее 0–100, и «средняя
 * депрессия» из их смеси — число без единиц, которое меняется от того, какую
 * методику чаще назначали на этой неделе. Поэтому сводка устроена так:
 *
 * 1. Направление собирается из шкал, опознанных по ключу каталога и коду
 *    шкалы (`surveys.catalog_key` + `scales.code`), — не по названию:
 *    название специалист вправе переименовать у себя, и направление молча
 *    потеряло бы методику. Методики вне каталога сюда не попадают вовсе —
 *    про самодельную шкалу нельзя знать, что она меряет депрессию.
 * 2. Главное число — доля людей, чей последний замер лёг в клинические
 *    полосы («помірна» и «виражена») ПО ПОЛОСАМ САМОЙ МЕТОДИКИ. Полосы — это
 *    то, что у разных методик сопоставимо: каждая сама говорит, где у неё
 *    клинически значимое. Полярность здесь учтена методикой: у WHO-5 низкий
 *    балл лежит в «вираженій» полосе (instruments/who5.ts), и считать его
 *    наоборот не нужно.
 * 3. Средний балл — только по одной, основной методике направления (той, по
 *    которой за период замерено больше всего людей), в процентах от её
 *    максимума, и с её названием рядом. У благополучия больше — лучше, и
 *    флаг `higherIsWorse` едет к экрану, чтобы среднее не прочли наоборот.
 * 4. Всё — через порог малых ячеек (privacy.ts). Сводку открывают на
 *    мониторе дежурного, и «виражена: 1» в подразделении из двенадцати —
 *    это конкретный человек.
 *
 * Чистые функции без базы: сценарии «последний замер легче первого»,
 * «WHO-5 низкий — значит клинический», «одна тяжёлая в маленькой группе»
 * проверяются на массивах (apps/api/test/dashboardConditions.test.ts).
 *
 * Счёт — в базе (волна 12): маршрут прежде выбирал по строке на человека и
 * шкалу, а на каждого человека ещё и его худшую ступень, и складывал их
 * здесь — тысячи строк в память ради семи раскладок и среднего. Теперь база
 * отдаёт готовые счётчики (DomainAggregate), а здесь остаются порог малых
 * ячеек, выбор основной методики и полярность — то, что и есть смысл сводки.
 * Прежний подсчёт по строкам (aggregateDomain) оставлен как образец: на нём
 * проверка сверяет, что числа при переезде не сдвинулись.
 */

export interface DomainSource {
  /** Ключ каталога методики (instruments/catalog.ts) */
  catalogKey: string;
  /** Код шкалы внутри методики */
  code: string;
}

export interface DomainDef {
  key: ConditionDomain;
  higherIsWorse: boolean;
  /**
   * Порядок — приоритет при равенстве людей: основной становится методика с
   * наибольшим числом замеренных, а при равенстве — стоящая раньше. Первой
   * стоит та, что назначается как основной скрининг направления.
   */
  sources: DomainSource[];
}

const src = (catalogKey: string, code: string): DomainSource => ({ catalogKey, code });

/*
 * Состав направлений.
 *
 * PHQ-4 даёт две подшкалы — депрессивную (DEP, это PHQ-2) и тревожную (ANX,
 * это GAD-2); общий балл дистресса (PHQ4) не относится ни к одному
 * направлению и сюда не входит. DASS-42 так же делится на три: D, A, S.
 *
 * Вигорання — личная шкала CBI (PB): она задаётся всем, а рабочая (WB) и
 * клиентская (CB) — только тем, кто работает и работает с людьми, то есть
 * не всем пациентам.
 *
 * AUDIT-C стоит после AUDIT: полный AUDIT — основной инструмент, короткий —
 * скрининг. Полосы AUDIT-C не поднимаются выше «легкой» (положительный
 * скрининг у автора — это ещё не клиническая полоса), и долю в клинических
 * полосах он честно даёт нулевой.
 *
 * Сторож на опечатки и переименования — тест «каждый источник есть в
 * каталоге»: шкала, выпавшая из каталога, иначе выпала бы из сводки молча.
 */
export const CONDITION_DOMAINS: readonly DomainDef[] = [
  {
    key: "depression",
    higherIsWorse: true,
    sources: [
      src("phq9", "PHQ"),
      src("phq8", "PHQ8"),
      src("phq4", "DEP"),
      src("cesdr", "CESDR"),
      src("gds15", "GDS"),
      src("dass42", "D"),
    ],
  },
  { key: "anxiety", higherIsWorse: true, sources: [src("gad7", "GAD"), src("phq4", "ANX"), src("dass42", "A")] },
  { key: "stress", higherIsWorse: true, sources: [src("pss10", "PSS"), src("dass42", "S")] },
  { key: "ptsd", higherIsWorse: true, sources: [src("pcl5", "PCL"), src("pcptsd5", "PCPTSD5")] },
  /* полярность обратная: больше — лучше; полосы WHO-5 уже повёрнуты (низкий балл — «виражена») */
  { key: "wellbeing", higherIsWorse: false, sources: [src("who5", "WHO5")] },
  { key: "burnout", higherIsWorse: true, sources: [src("cbi", "PB")] },
  { key: "alcohol", higherIsWorse: true, sources: [src("audit", "AUDIT"), src("auditc", "AUDITC")] },
];

/** Все пары «ключ каталога — код шкалы» разом: для выборки одним запросом */
export function allSources(): DomainSource[] {
  const seen = new Set<string>();
  const out: DomainSource[] = [];
  for (const d of CONDITION_DOMAINS) {
    for (const s of d.sources) {
      const k = `${s.catalogKey}:${s.code}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(s);
      }
    }
  }
  return out;
}

/**
 * Последний замер человека по одной шкале одной методики за период.
 *
 * Маршрут отдаёт уже по одной строке на (человек, методика, шкала) —
 * `distinct on` в базе, — а здесь из них собирается направление.
 */
export interface Measurement {
  userId: string;
  surveyId: string;
  catalogKey: string | null;
  code: string;
  severity: Severity | null;
  /** Балл в процентах от максимума шкалы (response_scores.percent) */
  percent: number;
  /** Момент сдачи, ISO — чтобы выбрать последний среди методик направления */
  at: string;
}


/** Люди — число или null: ноль показывается, малое скрывается */
export function suppressPeople(n: number): number | null {
  return suppress(n);
}

/**
 * Раскладка по ступеням с подавлением — так, чтобы скрытое не вычислялось.
 *
 * Опубликовано будет три вещи сразу: число людей с полосой, доля клинических
 * и сами ступени. Если прятать каждую ячейку порознь, скрытая находится
 * вычитанием: «помірна 6, клинических 8» называет «виражену» — двоих.
 * Поэтому правило построено от главного числа вниз:
 *
 * 1. Людей с полосой меньше порога — не показывается ничего.
 * 2. Клинических (C) и остальных (n − C) — обе половины обязаны пройти
 *    порог (или быть нулём): n опубликовано, и одна скрытая половина
 *    восстанавливается из другой. Не прошла хоть одна — скрыты и доля, и
 *    ступени; остаётся только n.
 * 3. Внутри половины (норма/легка и помірна/виражена) ступени показываются
 *    парой или не показываются вовсе: сумма половины известна, и одна
 *    скрытая ступень — это сумма минус соседняя. Когда скрыты обе, их сумма
 *    ≥ порога, а каждая ≥ 1, — вариантов разбиения всегда больше одного.
 *
 * Отвергнуто: общий `suppressedKeys` по четырём ступеням. Он защищает
 * разбиение с опубликованным целым, но здесь опубликована ещё и сумма двух
 * верхних — лишнее уравнение, которого он не знает, — а дополнительной парой
 * он чаще всего выбивал бы именно клиническую долю, ради которой блок и
 * открывают.
 */
export function spreadOf(counts: Record<Severity, number>): BandSpread {
  const banded = counts.none + counts.mild + counts.moderate + counts.severe;
  const hiddenAll: BandSpread = {
    banded: null,
    clinical: { count: null, percent: null },
    bands: { none: null, mild: null, moderate: null, severe: null },
  };
  if (banded === 0) {
    /* полос нет вовсе: не «скрыто», а «не к чему относить» */
    return { banded: 0, clinical: { count: null, percent: null }, bands: { none: 0, mild: 0, moderate: 0, severe: 0 } };
  }
  if (suppress(banded) === null) return hiddenAll;

  const clinical = counts.moderate + counts.severe;
  const rest = banded - clinical;
  if (suppress(clinical) === null || suppress(rest) === null) {
    return { ...hiddenAll, banded };
  }

  const pair = (a: Severity, b: Severity) =>
    suppress(counts[a]) !== null && suppress(counts[b]) !== null
      ? { [a]: counts[a], [b]: counts[b] }
      : { [a]: null, [b]: null };

  return {
    banded,
    clinical: { count: clinical, percent: Math.round((clinical / banded) * 100) },
    bands: { ...pair("none", "mild"), ...pair("moderate", "severe") } as Record<Severity, number | null>,
  };
}

/** Самый поздний из замеров; при равенстве — первый встреченный */
function latest<T extends { at: string }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) if (!best || Date.parse(r.at) > Date.parse(best.at)) best = r;
  return best;
}

const sourceKey = (catalogKey: string | null, code: string) => `${catalogKey ?? ""}:${code}`;

export interface SummaryInput {
  rows: readonly Measurement[];
  /** Название методики на языке читающего */
  titleOf: (surveyId: string) => string;
  /** Ход среднего основной методики: неделя → число людей и среднее */
  weekly: (surveyId: string, code: string) => { week: string; n: number; mean: number | null }[];
}

/**
 * Одна шкала одной методики внутри направления — уже свёрнутая.
 *
 * `people` — сколько людей замерено ею за период (по последнему замеру
 * каждого), `mean` — несглаженное среднее их процентов: округление — дело
 * сводки, а не свёртки, иначе среднее двух путей расходилось бы на единицу.
 */
export interface SourceAggregate {
  surveyId: string;
  code: string;
  /** Место источника в списке направления: при равенстве людей выше — главнее */
  order: number;
  people: number;
  mean: number | null;
}

/**
 * Направление, свёрнутое до счётчиков: всё, что нужно сводке, и ничего
 * поимённого.
 *
 * Эту форму отдаёт база (routes/dashboard.ts), и её же строит
 * aggregateDomain из строк замеров. Два пути к одной форме — не
 * дублирование, а способ проверки: маршрут считает в SQL, чтобы не тянуть в
 * память по строке на человека и шкалу, а проверка сверяет его ответ с
 * прежним подсчётом по строкам на одних и тех же данных
 * (apps/api/test/dashboardConditions.test.ts).
 */
export interface DomainAggregate {
  /** Людей с хотя бы одним замером направления */
  people: number;
  /** Раскладка по последнему замеру С ПОЛОСОЙ каждого человека */
  counts: Record<Severity, number>;
  sources: SourceAggregate[];
}

/**
 * Свёртка направления из последних замеров — прежний подсчёт в приложении.
 *
 * Для раскладки по ступеням берётся последний замер человека С ПОЛОСОЙ среди
 * всех методик направления: если последним был DASS-42 без полос, а неделей
 * раньше — PHQ-9, состояние человека известно по PHQ-9, и выбросить его из
 * раскладки только потому, что потом ему дали методику без интерпретации,
 * значило бы занизить знаменатель без причины.
 *
 * Средний балл — по основной методике, по последнему замеру каждого
 * человека именно ею.
 */
export function aggregateDomain(def: DomainDef, rows: readonly Measurement[]): DomainAggregate {
  const wanted = new Map(def.sources.map((s, i) => [sourceKey(s.catalogKey, s.code), i]));
  const own = rows.filter((r) => wanted.has(sourceKey(r.catalogKey, r.code)));

  const byUser = new Map<string, Measurement[]>();
  for (const r of own) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);

  const counts: Record<Severity, number> = { none: 0, mild: 0, moderate: 0, severe: 0 };
  for (const list of byUser.values()) {
    const last = latest(list.filter((m) => m.severity !== null));
    if (last?.severity) counts[last.severity] += 1;
  }

  const bySource = new Map<string, { surveyId: string; code: string; order: number; sum: number; n: number }>();
  for (const r of own) {
    const k = `${r.surveyId}:${r.code}`;
    const entry = bySource.get(k) ?? {
      surveyId: r.surveyId,
      code: r.code,
      order: wanted.get(sourceKey(r.catalogKey, r.code)) ?? 99,
      sum: 0,
      n: 0,
    };
    entry.sum += r.percent;
    entry.n += 1;
    bySource.set(k, entry);
  }

  return {
    people: byUser.size,
    counts,
    sources: [...bySource.values()].map((s) => ({
      surveyId: s.surveyId,
      code: s.code,
      order: s.order,
      people: s.n,
      mean: s.n ? s.sum / s.n : null,
    })),
  };
}

/**
 * Сводка направления из свёртки: порог малых ячеек, основная методика, ход.
 *
 * Основная — та, которой замерено больше людей; при равенстве — стоящая
 * раньше в списке направления; при полном равенстве (одна и та же методика
 * каталога установлена дважды, в две группы, и замерила поровну) — по
 * идентификатору методики. Последнее правило введено вместе с переносом
 * счёта в базу: раньше такую ничью решал порядок строк выборки, то есть
 * случай, и один и тот же экран мог назвать основной то одну копию, то
 * другую.
 */
export function summarizeAggregate(
  def: DomainDef,
  agg: DomainAggregate,
  input: Pick<SummaryInput, "titleOf" | "weekly">,
): ConditionSummary {
  const people = agg.people;
  const ranked = [...agg.sources].sort(
    (a, b) =>
      b.people - a.people ||
      a.order - b.order ||
      (a.surveyId < b.surveyId ? -1 : a.surveyId > b.surveyId ? 1 : 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  const head = ranked[0] ?? null;

  const tooFew = people > 0 && suppress(people) === null;

  const primary = head
    ? {
        surveyId: head.surveyId,
        title: input.titleOf(head.surveyId),
        people: suppress(head.people),
        meanPercent: suppress(head.people) === null || head.mean === null ? null : Math.round(head.mean),
      }
    : null;

  const weeks = head
    ? input.weekly(head.surveyId, head.code).map((w) => ({
        week: w.week,
        meanPercent: w.mean === null || w.n < SMALL_CELL_FLOOR ? null : Math.round(w.mean),
      }))
    : [];

  return {
    domain: def.key,
    higherIsWorse: def.higherIsWorse,
    people: suppress(people),
    /*
     * Меньше порога людей — не показывается ничего, кроме слов «замало
     * даних». Раскладка из трёх человек называет каждого, а среднее из
     * трёх — почти каждого.
     */
    spread: tooFew
      ? { banded: null, clinical: { count: null, percent: null }, bands: { none: null, mild: null, moderate: null, severe: null } }
      : spreadOf(agg.counts),
    primary: tooFew && primary ? { ...primary, people: null, meanPercent: null } : primary,
    weeks: tooFew ? weeks.map((w) => ({ ...w, meanPercent: null })) : weeks,
    sources: ranked.map((s) => ({ surveyId: s.surveyId, title: input.titleOf(s.surveyId) })),
  };
}

/** Одно направление из последних замеров: свёртка в приложении и та же сводка */
export function summarizeDomain(def: DomainDef, input: SummaryInput): ConditionSummary {
  return summarizeAggregate(def, aggregateDomain(def, input.rows), input);
}

/**
 * Все методики разом: «кто где сейчас».
 *
 * Человек считается один раз — по самой тяжёлой из последних оценок каждой
 * его шкалы. Самой тяжёлой, а не средней, по той же причине, что в ряду по
 * неделям (routes/analytics.ts, severity-trend): «где-то тяжело» — это
 * срочный случай, а «в среднем спокойно» усреднило бы тревогу с
 * благополучием.
 */
export function overallSpread(worst: readonly (Severity | null)[]): { people: number | null; spread: BandSpread } {
  const counts: Record<Severity, number> = { none: 0, mild: 0, moderate: 0, severe: 0 };
  for (const s of worst) if (s) counts[s] += 1;
  return overallFromCounts(worst.length, counts);
}

/**
 * То же из готовых счётчиков — так их отдаёт база: людей всего (включая тех,
 * у кого ни одной полосы) и раскладка по самой тяжёлой ступени каждого.
 */
export function overallFromCounts(
  people: number,
  counts: Record<Severity, number>,
): { people: number | null; spread: BandSpread } {
  if (people > 0 && suppress(people) === null) {
    return {
      people: null,
      spread: { banded: null, clinical: { count: null, percent: null }, bands: { none: null, mild: null, moderate: null, severe: null } },
    };
  }
  return { people, spread: spreadOf(counts) };
}
