import { type SQL, sql } from "drizzle-orm";
import { itemContribution, type Question, type ScaleItem } from "@quizzy/shared";
import { db } from "../db";
import { decryptField } from "./crypto";
import { type QualityMarkers, markersFrom, straightLine } from "./psychometrics";

/**
 * Ответы и лента событий для аналитики методики — счётом в базе (#187).
 *
 * Прежде аналитика методики выбирала в память все ответы среза (select *)
 * и ВСЮ ленту событий ответов и раскладывала их в JS: PHQ-9 за год — 20–56 с
 * и +1,1–1,35 ГБ на запрос; лента — миллионы строк с jsonb значения ради двух
 * признаков на ответ. Теперь всё, что о пункте, считает база одним
 * запросом: счётчики, выборы вариантов, числа, обрывы, признаки качества по
 * прохождению; время на пункте приходит одним массивом чисел на пункт —
 * среднее, медиану и квартили считает lib/stats.ts, как и прежде. Лента
 * событий сворачивается в базе до двух признаков на ответ: время до первого
 * выбора (первое «set» по порядку событий) и «передумывал ли» (было ли
 * «change»).
 *
 * Лента — по выборке: последним прохождениям среза (eventSample), а не всем.
 * Это самая тяжёлая таблица учреждения (полтора-два события на ответ) и
 * единственное, что здесь читалось бы построчно ради двух средних — времени
 * до первого выбора и доли передумавших; на двух тысячах прохождений их
 * ошибка — миллисекунды и десятые доли процента, а чтение всей ленты среза
 * стоило секунды и росло с каждым прохождением. Пока прохождений меньше
 * выборки, ответ тот же, что прежде.
 *
 * В JS приходят только ответы, нужные целиком: пункты, где важен порядок
 * ответов внутри прохождения (прямая линия у матриц и числовых), ключевые
 * пункты person-fit, выборка альфы и ряд одного человека.
 *
 * Как читается. Срез — списком из приложения (он отобран там под
 * политиками смотрящего), строкой с разделителем: string_to_array от
 * параметра база сворачивает в постоянный массив и знает его длину. Ответы и
 * события — по прохождению, через lateral: короткое чтение по индексу на
 * прохождение. Политики строк сбивают оценки планировщика (условие с
 * подзапросом на каждой строке он считает дорогим, долю прошедших — почти
 * нулевой), и без lateral он выбирал то полный обход таблицы по индексу, то
 * сортировку миллиона строк на диске; такой план от его оценок не зависит.
 * offset 0 внутри lateral — чтобы планировщик не развернул его обратно в
 * соединение: развёрнутый, он читал ответы и ленту всей базы целиком, и
 * время росло с объёмом учреждения, а не среза.
 *
 * Контекст — вызывающего: аналитика зовёт это системной ролью по
 * прохождениям, отобранным под политиками смотрящего (routes/analytics.ts).
 */

/** Счёт по пункту — по ответам достоверных протоколов (shownAll — по всем) */
export interface QuestionStats {
  /** Ответов по всем прохождениям, с недостоверными — воронка */
  shownAll: number;
  given: number;
  real: number;
  /** Время у не пропущенных, больше нуля, — сами значения по возрастанию: квартили считает lib/stats.ts */
  times: number[];
  changeSum: number;
  /** Не пропущенных в выборке ленты событий */
  sampleReal: number;
  firstSum: number;
  firstN: number;
  /** Не пропущенных в выборке ленты, где передумывали (лента или счётчик) */
  changedReal: number;
  counts: Map<string, number>;
  rankSums: Map<string, number>;
  totalPicks: number;
  /** Числовые ответы: значение и сколько раз, по возрастанию */
  numbers: { value: number; count: number }[];
  texts: string[];
}

/** Ответ целиком — для выборки альфы и ряда человека */
export interface StoredAnswer {
  responseId: string;
  questionId: string;
  optionIds: string[] | null;
  number: number | null;
  matrix: Record<string, string> | null;
  skipped: boolean;
  score: number | null;
  durationMs: number;
  changeCount: number;
}

export interface StatsInput {
  questions: readonly Question[];
  /** Срез — в своём порядке */
  responses: readonly { id: string; status: string; durationMs: number; reliable: boolean }[];
  /** Прохождения, чья лента событий читается */
  eventSample: readonly string[];
  tooFastMs: number;
  /** Ключевые пункты шкалы person-fit; null — шкалы нет */
  fitItems: readonly ScaleItem[] | null;
}

export interface StatsResult {
  questions: Map<string, QuestionStats>;
  /** Сколько незавершённых прохождений кончается на пункте */
  lastAnsweredCount: Map<string, number>;
  /** Признаки качества завершённых прохождений, у которых может быть флаг; нет записи — флага нет */
  markers: Map<string, QualityMarkers>;
  /** Срабатывания ключевых пунктов (в порядке fitItems) у завершённых, где отвечены все */
  fitHits: Map<string, Uint8Array>;
  /** Сколько раз сработал каждый ключевой пункт и в скольких полных строках — трудность */
  fitDifficulty: { hits: number[]; rows: number };
}

/** postgres-js отдаёт json то разобранным, то строкой — в зависимости от типа колонки */
function parsed<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/**
 * Список id — постоянным массивом text[] из одного параметра (см. выше:
 * длину массива база знает, в отличие от jsonb). Разделитель — символ 31,
 * которого в идентификаторах не бывает.
 */
function idArray(ids: readonly string[]): SQL {
  return sql`string_to_array(${ids.join("\u001f")}::text, chr(31))`;
}

/**
 * С какого размера среза строки читаются по пунктам, а не по прохождениям.
 *
 * По прохождению — короткое чтение по индексу на каждое: на десятках тысяч
 * это десятки тысяч чтений вразброс (2 с на 50 тыс.). По пункту — одно
 * чтение на пункт версии по индексу пункта, страницы подряд, и отсев среза
 * по хэшу списка (0,3 с), но читаются ответы всей версии, а не только среза:
 * неделе из года это лишние 50 раз. Поэтому малый срез — по прохождениям,
 * большой — по пунктам.
 */
const SLICE_BY_RESPONSE = 2000;

/**
 * Откуда брать ответы среза (FROM): строки a (answers) и q (тип и место
 * пункта версии). Ответ на пункт чужой версии в счёт не идёт — как и в
 * разборе по пунктам прежде; такая несостыковка — проверка «Якості даних».
 *
 * У большого среза условие на прохождение записано выражением
 * (response_id || ''), а не колонкой — намеренно: по колонке планировщик
 * склеивал индекс пункта с индексом прохождения (BitmapAnd по пятидесяти
 * тысячам ключей на каждый пункт — секунды), а выражение он может только
 * проверить по уже прочитанной строке, по хэшу постоянного списка.
 */
function answersOfSlice(ids: readonly string[], shape: string): SQL {
  if (ids.length <= SLICE_BY_RESPONSE) {
    return sql`unnest(${idArray(ids)}) s(id)
      cross join lateral (select a.* from answers a where a.response_id = s.id offset 0) a
      join jsonb_to_recordset(${shape}::jsonb) as q(id text, type text, position int) on q.id = a.question_id`;
  }
  return sql`jsonb_to_recordset(${shape}::jsonb) as q(id text, type text, position int)
      cross join lateral (
        select a.* from answers a
         where a.question_id = q.id and (a.response_id || '') = any(${idArray(ids)})
        offset 0
      ) a`;
}

/** Баллы среза по шкалам версии — тем же путём, что ответы (answersOfSlice), одной строкой json */
export async function scoresOfSlice(
  ids: readonly string[],
  scaleIds: readonly string[],
): Promise<
  {
    responseId: string;
    scaleId: string;
    rawScore: number;
    /** балл после поправок (#133): maxScore записан для него; у строк до 0118 — null */
    correctedScore: number | null;
    value: number;
    normalized: boolean;
    maxScore: number;
    bandLabel: string | null;
  }[]
> {
  if (!ids.length || !scaleIds.length) return [];
  const source =
    ids.length <= SLICE_BY_RESPONSE
      ? sql`unnest(${idArray(ids)}) s(id)
          cross join lateral (select * from response_scores rs where rs.response_id = s.id offset 0) rs
          where rs.scale_id = any(${idArray(scaleIds)})`
      : sql`unnest(${idArray(scaleIds)}) sc(id)
          cross join lateral (
            select * from response_scores rs
             where rs.scale_id = sc.id and (rs.response_id || '') = any(${idArray(ids)})
            offset 0
          ) rs`;
  const [row] = (await db.execute(sql`
    select json_agg(json_build_array(rs.response_id, rs.scale_id, rs.raw_score, rs.value, rs.normalized,
                                     rs.max_score, rs.band_label, rs.corrected_score))::text as rows
      from ${source}
  `)) as unknown as { rows: string | null }[];
  return (parsed<[string, string, number, number, boolean, number, string | null, number | null][]>(row?.rows) ?? []).map(
    ([responseId, scaleId, rawScore, value, normalized, maxScore, bandLabel, correctedScore]) => ({
      responseId,
      scaleId,
      rawScore,
      correctedScore,
      value,
      normalized,
      maxScore,
      bandLabel,
    }),
  );
}

interface QuestionRow {
  question_id: string;
  shown_all: number;
  given: number;
  real: number;
  times: number[] | null;
  change_sum: number;
}

interface EventRow {
  question_id: string;
  sample_real: number;
  first_sum: number;
  first_n: number;
  changed_real: number;
}

export async function answerStats(input: StatsInput): Promise<StatsResult> {
  const byId = new Map(input.questions.map((q) => [q.id, q]));
  const ids = input.responses.map((r) => r.id);
  /* тип и место пункта — версии среза, как byId: ответ на чужой пункт в счёт не идёт */
  const shape = JSON.stringify(input.questions.map((q) => ({ id: q.id, type: q.type, position: q.position })));
  const lined = input.questions.filter((q) => q.type === "matrix" || ["scale", "slider", "number"].includes(q.type));
  const everyone = lined.length > 0 || (input.fitItems?.length ?? 0) > 0 ? sql`true` : sql`false`;
  const unreliable = input.responses.filter((r) => r.status === "completed" && !r.reliable).map((r) => r.id);
  const unfinished = input.responses.filter((r) => r.status !== "completed").map((r) => r.id);

  /*
   * Короткие ответы — кандидаты на флаг «прохождение короче своих ответов»:
   * отвечено не больше, чем пунктов в версии, так что длиннее
   * «пунктов × порог» прохождение коротким не бывает.
   */
  const short = input.responses
    .filter((r) => r.status === "completed" && r.durationMs > 0 && r.durationMs < input.questions.length * input.tooFastMs)
    .map((r) => r.id);
  const durationOf = new Map(input.responses.map((r) => [r.id, r.durationMs]));

  /*
   * Выборы вариантов (picks): у одиночного выбора — сам вариант (->> 0), без
   * разворота массива на каждом из сотен тысяч ответов; множественный,
   * матрица и ранжирование — разворотом, только у своих ответов.
   *
   * Признаки качества (marks) нужны только тем, у кого может быть флаг:
   * быстрых ответов около половины (с запасом на округление — точная
   * проверка в markersFrom) или прохождение короче, чем его ответы
   * быстрыми (short выше). Прямая линия и person-fit считаются по ответам —
   * тогда признаки нужны всем (everyone).
   */
  const [row] = (await db.execute(sql`
    with ans as materialized (
      select a.response_id,
             a.response_id = any(${idArray(unreliable)}) as unreliable,
             a.response_id = any(${idArray(unfinished)}) as unfinished,
             q.id as question_id, q.type, q.position, a.skipped, a.duration_ms, a.change_count,
             case when q.type in ('single', 'multiple', 'yesno') then a.option_ids end as option_ids,
             case when q.type = 'matrix' then a.matrix end as matrix,
             case when q.type = 'ranking' then a.ranking end as ranking,
             case when q.type in ('scale', 'slider', 'number') then a.number end as number,
             case when q.type in ('text', 'longtext') then a.text end as text
        from ${answersOfSlice(ids, shape)}
    ),
    marked as not materialized (
      select a.*, (not a.unreliable and not a.skipped) as real,
             (not a.unreliable and not a.skipped and a.duration_ms > 0) as timed
        from ans a
    ),
    per_question as (
      select question_id,
             count(*)::int as shown_all,
             count(*) filter (where not unreliable)::int as given,
             count(*) filter (where real)::int as real,
             array_agg(duration_ms) filter (where timed) as times,
             coalesce(sum(change_count) filter (where real), 0)::float8 as change_sum
        from marked
       group by question_id
    ),
    per_question_events as (
      select x.question_id,
             count(*) filter (where x.real)::int as sample_real,
             coalesce(sum(x.first_ms) filter (where x.real), 0)::float8 as first_sum,
             count(x.first_ms) filter (where x.real)::int as first_n,
             count(*) filter (where x.real and (x.changed or x.change_count > 0))::int as changed_real
        from unnest(${idArray(input.eventSample)}) s(id)
        cross join lateral (
          select a.question_id, (not a.skipped and not (s.id = any(${idArray(unreliable)}))) as real, a.change_count,
                 ev.first_ms, coalesce(ev.changed, false) as changed
            from answers a
            join jsonb_to_recordset(${shape}::jsonb) as q(id text) on q.id = a.question_id
            left join (
              select e.question_id,
                     (min(array[e.sequence, e.elapsed_ms]) filter (where e.kind = 'set'))[2] as first_ms,
                     bool_or(e.kind = 'change') as changed
                from answer_events e
               where e.response_id = s.id
               group by e.question_id
            ) ev on ev.question_id = a.question_id
           where a.response_id = s.id
          offset 0
        ) x
       group by x.question_id
    ),
    picks as (
      select question_id, id, count(*)::int as n, coalesce(sum(rank), 0)::float8 as rank_sum
        from (
          select question_id, option_ids ->> 0 as id, null::int as rank
            from marked
           where real and jsonb_typeof(option_ids) = 'array' and jsonb_array_length(option_ids) = 1
          union all
          select x.question_id, v, null
            from marked x, jsonb_array_elements_text(x.option_ids) v
           where x.real and jsonb_typeof(x.option_ids) = 'array' and jsonb_array_length(x.option_ids) > 1
          union all
          select x.question_id, v, null
            from marked x, jsonb_each_text(x.matrix) m(k, v)
           where x.real and jsonb_typeof(x.matrix) = 'object'
          union all
          select x.question_id, v, ord::int
            from marked x, jsonb_array_elements_text(x.ranking) with ordinality r(v, ord)
           where x.real and jsonb_typeof(x.ranking) = 'array'
        ) p
       group by question_id, id
    ),
    numbers as (
      select question_id, number as value, count(*)::int as n
        from marked
       where real and number is not null
       group by question_id, number
    ),
    ended as (
      select question_id, count(*)::int as n
        from (select distinct on (response_id) response_id, question_id
                from ans
               where unfinished and not skipped
               order by response_id, position desc) z
       group by question_id
    ),
    marks as (
      select response_id,
             count(*) filter (where not skipped)::int as answered,
             count(*) filter (where not skipped and duration_ms > 0)::int as timed,
             count(*) filter (where not skipped and duration_ms > 0 and duration_ms < ${input.tooFastMs})::int as fast
        from ans
       where not unfinished
       group by response_id
    )
    select (select json_agg(per_question) from per_question) as questions,
           (select json_agg(per_question_events) from per_question_events) as events,
           (select json_agg(json_build_array(question_id, id, n, rank_sum)) from picks) as picks,
           (select json_agg(json_build_array(question_id, value, n) order by question_id, value) from numbers) as numbers,
           (select json_agg(json_build_array(question_id, text)) from marked where real and text is not null) as texts,
           (select json_agg(json_build_array(question_id, n)) from ended) as ended,
           (select json_agg(json_build_array(response_id, answered, timed, fast))
              from marks
             where ${everyone}
                or (timed > 0 and fast * 2000 >= timed * 998)
                or response_id = any(${idArray(short)})) as marks
  `)) as unknown as Record<string, unknown>[];

  const result: StatsResult = {
    questions: new Map(),
    lastAnsweredCount: new Map(),
    markers: new Map(),
    fitHits: new Map(),
    fitDifficulty: { hits: new Array<number>(input.fitItems?.length ?? 0).fill(0), rows: 0 },
  };
  const statsOf = (questionId: string): QuestionStats => {
    let s = result.questions.get(questionId);
    if (!s) {
      s = {
        shownAll: 0, given: 0, real: 0, times: [], changeSum: 0, sampleReal: 0, firstSum: 0, firstN: 0,
        changedReal: 0, counts: new Map(), rankSums: new Map(), totalPicks: 0, numbers: [], texts: [],
      };
      result.questions.set(questionId, s);
    }
    return s;
  };

  for (const q of parsed<QuestionRow[]>(row?.questions) ?? []) {
    const s = statsOf(q.question_id);
    s.shownAll = q.shown_all;
    s.given = q.given;
    s.real = q.real;
    // по возрастанию — на месте, без копий: квантили считаются по отсортированному
    s.times = (q.times ?? []).sort((a, b) => a - b);
    s.changeSum = q.change_sum;
  }
  for (const q of parsed<EventRow[]>(row?.events) ?? []) {
    const s = statsOf(q.question_id);
    s.sampleReal = q.sample_real;
    s.firstSum = q.first_sum;
    s.firstN = q.first_n;
    s.changedReal = q.changed_real;
  }
  for (const [questionId, optionId, n, rankSum] of parsed<[string, string, number, number][]>(row?.picks) ?? []) {
    const s = statsOf(questionId);
    s.counts.set(optionId, n);
    if (byId.get(questionId)?.type === "ranking") s.rankSums.set(optionId, rankSum);
    s.totalPicks += n;
  }
  for (const [questionId, value, count] of parsed<[string, number, number][]>(row?.numbers) ?? []) {
    statsOf(questionId).numbers.push({ value, count });
  }
  /* тот же случай, что в formatAnswer: текст хранится шифрованным */
  for (const [questionId, text] of parsed<[string, string][]>(row?.texts) ?? []) {
    const plain = decryptField(text);
    if (plain) statsOf(questionId).texts.push(plain);
  }
  for (const [questionId, n] of parsed<[string, number][]>(row?.ended) ?? []) result.lastAnsweredCount.set(questionId, n);

  /*
   * Прямая линия — по самим ответам матриц и числовых пунктов, в порядке
   * строк внутри прохождения (как и прежде: в порядке, в котором их хранит
   * база). Остальные пункты на неё не влияют, и их ответы не читаются.
   */
  const completed = input.responses.filter((r) => r.status === "completed").map((r) => r.id);
  const lines = new Map<string, number>();
  if (lined.length && completed.length) {
    const rows = await answersIn(completed, lined.map((q) => q.id), true);
    for (const [responseId, list] of groupBy(rows)) {
      lines.set(responseId, straightLine(list.filter((a) => !a.skipped), byId));
    }
  }
  for (const [responseId, answered, timed, fast] of parsed<[string, number, number, number][]>(row?.marks) ?? []) {
    result.markers.set(
      responseId,
      markersFrom(
        { answered, timed, fast, longestStraightLine: lines.get(responseId) ?? 0 },
        durationOf.get(responseId) ?? 0,
        input.tooFastMs,
      ),
    );
  }
  /*
   * Без признаков остались те, у кого флага быть не может, и прохождения без
   * единого ответа — у них признаки по пустому списку, как и прежде, то есть
   * тоже без флага: StatsResult.markers говорит только о возможных флагах.
   */

  /*
   * Person-fit: срабатывание ключевых пунктов. Трудность пункта — по всем
   * прохождениям, где отвечены все ключевые пункты; вектор — только у
   * завершённых: признак качества строится по ним.
   */
  const items = input.fitItems;
  if (items?.length && ids.length) {
    const rows = await answersIn(ids, [...new Set(items.map((i) => i.questionId))], false);
    const status = new Map(input.responses.map((r) => [r.id, r.status]));
    for (const [responseId, list] of groupBy(rows)) {
      const byQuestion = new Map(list.map((a) => [a.questionId, a]));
      const hits = new Uint8Array(items.length);
      let full = true;
      for (const [index, item] of items.entries()) {
        const question = byId.get(item.questionId);
        const stored = byQuestion.get(item.questionId);
        const v =
          question && stored
            ? itemContribution(question, item, {
                questionId: item.questionId,
                optionIds: stored.optionIds ?? undefined,
                matrix: stored.matrix ?? undefined,
                skipped: stored.skipped,
              })
            : null;
        if (v === null) {
          full = false;
          break;
        }
        hits[index] = v > 0 ? 1 : 0;
      }
      if (!full) continue;
      result.fitDifficulty.rows++;
      for (let i = 0; i < hits.length; i++) result.fitDifficulty.hits[i]! += hits[i]!;
      if (status.get(responseId) === "completed") result.fitHits.set(responseId, hits);
    }
  }
  return result;
}

/**
 * Ответы прохождений на заданные пункты (null — на все) — по прохождению,
 * через lateral (см. выше), в порядке хранения внутри прохождения.
 */
async function answersIn(
  responseIds: readonly string[],
  questionIds: readonly string[] | null,
  inStoredOrder: boolean,
): Promise<StoredAnswer[]> {
  return (await db.execute(sql`
    select s.id as "responseId", a.question_id as "questionId", a.option_ids as "optionIds", a.number, a.matrix,
           a.skipped, a.score, a.duration_ms as "durationMs", a.change_count as "changeCount"
      from unnest(${idArray(responseIds)}) with ordinality s(id, n)
      cross join lateral (
        select * from answers a
         where a.response_id = s.id
           ${questionIds ? sql`and a.question_id = any(${idArray(questionIds)})` : sql``}
         ${inStoredOrder ? sql`order by a.ctid` : sql``}
      ) a
     order by s.n
  `)) as unknown as StoredAnswer[];
}

/**
 * Ответы прохождений целиком — для выборки альфы и ряда одного человека:
 * прохождение → пункт → ответ, прохождения — в порядке списка. changed —
 * пары «прохождение:пункт», где в ленте событий было «change».
 */
export async function answersOf(
  responseIds: readonly string[],
  withChanges = false,
): Promise<{ byResponse: Map<string, Map<string, StoredAnswer>>; changed: Set<string> }> {
  const byResponse = new Map<string, Map<string, StoredAnswer>>();
  const changed = new Set<string>();
  if (!responseIds.length) return { byResponse, changed };
  for (const [id, list] of groupBy(await answersIn(responseIds, null, false))) {
    byResponse.set(id, new Map(list.map((a) => [a.questionId, a])));
  }
  if (withChanges) {
    const events = (await db.execute(sql`
      select distinct s.id as "responseId", e.question_id as "questionId"
        from unnest(${idArray(responseIds)}) s(id)
        cross join lateral (select e.question_id from answer_events e where e.response_id = s.id and e.kind = 'change') e
    `)) as unknown as { responseId: string; questionId: string }[];
    for (const e of events) changed.add(`${e.responseId}:${e.questionId}`);
  }
  return { byResponse, changed };
}

function groupBy<T extends { responseId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.responseId);
    if (list) list.push(row);
    else out.set(row.responseId, [row]);
  }
  return out;
}
