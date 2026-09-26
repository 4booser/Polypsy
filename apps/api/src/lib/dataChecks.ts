import { sql, type SQL } from "drizzle-orm";
import { t, type DataCheck, type DataCheckKey, type Lang } from "@quizzy/shared";
import { db } from "../db";

/**
 * Проверки целостности данных — раздел «Якість даних» техпанели.
 *
 * ═══ Чем это отличается от того, что уже есть ═══
 *
 * `routes/dataQuality.ts` отвечает психологу на вопросы о МЕТОДИКЕ: кто не
 * доходит до конца, поплыла ли выборка, повторяемо ли измерение. `contentCheck.ts`
 * перед выкаткой проверяет СОДЕРЖИМОЕ опубликованных методик валидатором из
 * shared. Ни то ни другое не смотрит, согласованы ли между собой сами ЗАПИСИ:
 * прохождение, у которого пропала версия; балл, лежащий на шкале чужой
 * версии; методика с включённым подсчётом, у которой нечем назвать степень
 * выраженности. Такие вещи не роняют приложение — они молча дают неверную
 * динамику, неполную аналитику и «норму» там, где её не считали. Это и
 * проверяется здесь, по всей базе сразу, а не по одной методике.
 *
 * ═══ Как устроено ═══
 *
 * Каждая проверка — один SQL-запрос, выбирающий строки срабатывания
 * (id, survey_id, at): прохождения или методики, по одной строке на
 * объект. Общий обвязчик превращает их в число, пять свежих примеров и
 * разбивку по методикам. Дополнительные числа (корзины давности, сколько
 * пунктов, сколько баллов) — вторым запросом у тех проверок, где они есть.
 *
 * Только чтение. Ни одна проверка ничего не чинит: клиническая запись не
 * исправляется молча, даже если «очевидно, как надо» (docs/ARCHITECTURE.md,
 * «Клинические данные не удаляются»). Проверка называет, чинит человек.
 *
 * Наружу — голые идентификаторы прохождений и методик. Ни имён, ни ответов,
 * ни баллов: техпанель открыта по ops.read, и клинических записей она не
 * открывает. По ссылке из примера человек попадает на обычный экран
 * консоли, где его права проверяются заново.
 *
 * `surveyIds` сужает проверки до перечня методик. Экрану это не нужно — он
 * смотрит на всю базу; нужно тестам: в общей тестовой базе чужие файлы
 * оставляют свои несостыковки, и «наш пример среди пяти свежих» было бы
 * лотереей.
 */

export interface CheckScope {
  surveyIds?: readonly string[] | null;
}

/** Сколько примеров на проверку: хватает, чтобы открыть и понять, не превращая панель в выгрузку */
const EXAMPLES = 5;
/** Сколько методик в разбивке */
const BY_SURVEY = 8;

/**
 * Условие «в перечне методик» по заданной колонке.
 * Колонка — константа из этого файла, не ввод; значения идут параметрами.
 */
function inScope(scope: CheckScope, column: string): SQL {
  const ids = scope.surveyIds;
  if (!ids) return sql``;
  if (!ids.length) return sql` and false`;
  return sql` and ${sql.raw(column)} in (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

interface CheckSpec {
  key: DataCheckKey;
  level: DataCheck["level"];
  kind: "response" | "survey";
  /** Строки срабатывания: id, survey_id, at — по одной на объект */
  hits: (scope: CheckScope) => SQL;
  /** Одна строка целых чисел сверх основного счёта */
  extra?: (scope: CheckScope) => SQL;
}

/*
 * Порядок перечня — порядок на экране: сначала то, что уже врёт
 * (осиротевшие записи, прохождения без баллов), потом то, что начнёт
 * (методики без полос, ненормированные баллы, пропуски, дубли), в конце —
 * висящие черновики: они не искажают сданного, но про них стоит знать.
 */
const CHECKS: CheckSpec[] = [
  /*
   * Прохождение без версии. version_id обнуляется, когда версию удалили
   * (ON DELETE SET NULL): ответы остались, а какими вопросами и каким
   * ключом их читать — неизвестно. Баллы, посчитанные тогда, ещё лежат, но
   * пересчитать или проверить их уже нечем.
   */
  {
    key: "orphans.responseNoVersion",
    level: "error",
    kind: "response",
    hits: (s) => sql`
      select r.id, r.survey_id, coalesce(r.submitted_at, r.started_at) as at
        from responses r
       where r.version_id is null and r.status = 'completed'${inScope(s, "r.survey_id")}`,
  },
  /*
   * Прохождение на версии ДРУГОЙ методики. Внешний ключ проверяет, что
   * версия существует, но не то, что она своя: прохождение A, привязанное к
   * версии методики B, интерпретируется чужими вопросами и шкалами.
   */
  {
    key: "orphans.responseForeignVersion",
    level: "error",
    kind: "response",
    hits: (s) => sql`
      select r.id, r.survey_id, coalesce(r.submitted_at, r.started_at) as at
        from responses r
        join survey_versions v on v.id = r.version_id
       where v.survey_id <> r.survey_id${inScope(s, "r.survey_id")}`,
  },
  /*
   * Ответ на пункт чужой версии: прохождение шло по версии 3, а ответ
   * привязан к вопросу версии 2. Экран протокола рисует вопросы своей
   * версии — такой ответ на нём не виден вовсе, а в баллах он мог учесться.
   */
  {
    key: "orphans.answerForeignQuestion",
    level: "error",
    kind: "response",
    hits: (s) => sql`
      select r.id, r.survey_id, coalesce(r.submitted_at, r.started_at) as at
        from responses r
       where r.version_id is not null${inScope(s, "r.survey_id")}
         and exists (
           select 1 from answers a join questions q on q.id = a.question_id
            where a.response_id = r.id and q.version_id <> r.version_id)`,
    extra: (s) => sql`
      select count(*)::int as items
        from answers a
        join responses r on r.id = a.response_id
        join questions q on q.id = a.question_id
       where r.version_id is not null and q.version_id <> r.version_id${inScope(s, "r.survey_id")}`,
  },
  /*
   * Балл на шкале чужой версии. Динамика сопоставляет шкалы разных версий
   * по коду, а полосы берёт у шкалы — и полоса окажется от другой редакции
   * методики, с другими границами.
   */
  {
    key: "orphans.scoreForeignScale",
    level: "error",
    kind: "response",
    hits: (s) => sql`
      select r.id, r.survey_id, coalesce(r.submitted_at, r.started_at) as at
        from responses r
       where r.version_id is not null${inScope(s, "r.survey_id")}
         and exists (
           select 1 from response_scores rs join scales sc on sc.id = rs.scale_id
            where rs.response_id = r.id and sc.version_id <> r.version_id)`,
    extra: (s) => sql`
      select count(*)::int as scores
        from response_scores rs
        join responses r on r.id = rs.response_id
        join scales sc on sc.id = rs.scale_id
       where r.version_id is not null and sc.version_id <> r.version_id${inScope(s, "r.survey_id")}`,
  },
  /*
   * Методика ссылается на версию, которой нет или которая чужая.
   * current_version_id внешним ключом не держится (версия ссылается на
   * методику, и круговой ключ мешал бы её созданию), поэтому держать его
   * некому, кроме этой проверки. Опубликованная методика без версии не
   * открывается ни на прохождение, ни в конструкторе.
   */
  {
    key: "orphans.surveyDanglingVersion",
    level: "error",
    kind: "survey",
    hits: (s) => sql`
      select s.id, s.id as survey_id, s.updated_at as at
        from surveys s
       where ((s.current_version_id is null and s.status = 'published')
          or (s.current_version_id is not null and not exists (
                select 1 from survey_versions v where v.id = s.current_version_id and v.survey_id = s.id)))
         ${inScope(s, "s.id")}`,
  },
  /*
   * Ключ через границу версий: пункт ключа шкалы, вопрос с привязкой к
   * шкале или поправка одной шкалы на другую соединяют строки РАЗНЫХ
   * версий. Новая версия тогда считает балл по пункту старой — которого
   * человек не видел и на который не отвечал: сумма тихо занижена.
   */
  {
    key: "orphans.keyAcrossVersions",
    level: "error",
    kind: "survey",
    hits: (s) => sql`
      select s.id, s.id as survey_id, s.updated_at as at
        from surveys s
       where (exists (
                select 1 from scale_items si
                  join scales sc on sc.id = si.scale_id
                  join questions q on q.id = si.question_id
                 where sc.survey_id = s.id and sc.version_id <> q.version_id)
          or exists (
                select 1 from questions q join scales sc on sc.id = q.scale_id
                 where q.survey_id = s.id and sc.version_id <> q.version_id)
          or exists (
                select 1 from scale_corrections c
                  join scales a on a.id = c.target_scale_id
                  join scales b on b.id = c.source_scale_id
                 where a.survey_id = s.id and a.version_id <> b.version_id))
         ${inScope(s, "s.id")}`,
    extra: (s) => sql`
      select (
        (select count(*) from scale_items si
           join scales sc on sc.id = si.scale_id
           join questions q on q.id = si.question_id
          where sc.version_id <> q.version_id${inScope(s, "sc.survey_id")})
      + (select count(*) from questions q join scales sc on sc.id = q.scale_id
          where sc.version_id <> q.version_id${inScope(s, "q.survey_id")})
      + (select count(*) from scale_corrections c
           join scales a on a.id = c.target_scale_id
           join scales b on b.id = c.source_scale_id
          where a.version_id <> b.version_id${inScope(s, "a.survey_id")})
      )::int as links`,
  },
  /*
   * Сдано, подсчёт включён, шкалы у версии есть — а баллов нет ни одного.
   * Прохождение видно в списке, но в динамике, аналитике, когортах и
   * статистике его нет: они читают сохранённые баллы. Обычно это сдача,
   * сделанная до включения подсчёта, или подсчёт, упавший на сохранении.
   */
  {
    key: "scoring.noScores",
    level: "error",
    kind: "response",
    hits: (s) => sql`
      select r.id, r.survey_id, r.submitted_at as at
        from responses r
        join surveys sv on sv.id = r.survey_id
       where r.status = 'completed' and sv.scoring_enabled${inScope(s, "r.survey_id")}
         and exists (select 1 from scales sc where sc.version_id = r.version_id)
         and not exists (select 1 from response_scores rs where rs.response_id = r.id)`,
  },
  /*
   * Подсчёт включён, а назвать степень нечем: у содержательной шкалы
   * действующей версии нет ни одной полосы — или шкал нет вовсе. Балл
   * посчитается, но без полосы: ни «помірна», ни тревоги по полосе, ни
   * каскада углублённой диагностики. Шкалам достоверности полосы не нужны —
   * у них порог, — и они не считаются.
   */
  {
    key: "scoring.noBands",
    level: "warning",
    kind: "survey",
    hits: (s) => sql`
      select s.id, s.id as survey_id, s.updated_at as at
        from surveys s
       where s.scoring_enabled and s.archived_at is null${inScope(s, "s.id")}
         and (not exists (select 1 from scales sc where sc.version_id = s.current_version_id)
           or exists (
                select 1 from scales sc
                 where sc.version_id = s.current_version_id and sc.kind = 'clinical'
                   and not exists (select 1 from scale_bands b where b.scale_id = sc.id)))`,
    extra: (s) => sql`
      select
        (select count(*) from surveys s join scales sc on sc.version_id = s.current_version_id
          where s.scoring_enabled and s.archived_at is null and sc.kind = 'clinical'
            and not exists (select 1 from scale_bands b where b.scale_id = sc.id)${inScope(s, "s.id")})::int as scales,
        (select count(*) from surveys s
          where s.scoring_enabled and s.archived_at is null
            and not exists (select 1 from scales sc where sc.version_id = s.current_version_id)${inScope(s, "s.id")})::int as "noScales"`,
  },
  /*
   * Балл без нормировки: нормы для пола и возраста не нашлось, сырой балл
   * вне таблицы стенов, знаменатель доли не задан. В value тогда лежит
   * СЫРОЙ балл, а полоса пуста (shared/scoring.ts): рядом с T-баллами
   * соседей он выглядит числом той же шкалы и им не является.
   */
  {
    key: "scores.unnormalized",
    level: "warning",
    kind: "response",
    hits: (s) => sql`
      select r.id, r.survey_id, r.submitted_at as at
        from responses r
       where r.status = 'completed'${inScope(s, "r.survey_id")}
         and exists (select 1 from response_scores rs where rs.response_id = r.id and not rs.normalized)`,
    extra: (s) => sql`
      select count(*)::int as scores
        from response_scores rs join responses r on r.id = rs.response_id
       where not rs.normalized and r.status = 'completed'${inScope(s, "r.survey_id")}`,
  },
  /*
   * Пункт без ответа в сданном прохождении — из тех, что важны: входит в
   * ключ шкалы или обязателен. Свободный текст, который человек вправе не
   * заполнять, не в счёт. Пункты с условием показа — тоже: был ли пункт
   * показан, SQL не вычислит, а ложная тревога на каждом ветвлении сделала
   * бы проверку шумом.
   *
   * Чем опасно: сумма по шкале досчитана по неполному набору пунктов и
   * занижена, а по виду от честной не отличается.
   */
  {
    key: "answers.missing",
    level: "warning",
    kind: "response",
    hits: (s) => sql`
      select r.id, r.survey_id, r.submitted_at as at
        from responses r
       where r.status = 'completed' and r.version_id is not null${inScope(s, "r.survey_id")}
         and exists (
           select 1 from questions q
            where q.version_id = r.version_id and q.type <> 'info'
              and (q.required or q.scale_id is not null
                   or exists (select 1 from scale_items si where si.question_id = q.id))
              and not exists (select 1 from question_logic ql where ql.question_id = q.id)
              and not exists (
                    select 1 from answers a
                     where a.response_id = r.id and a.question_id = q.id and not a.skipped))`,
    extra: (s) => sql`
      select count(*)::int as items, count(*) filter (where q.required)::int as required
        from responses r
        join questions q on q.version_id = r.version_id
       where r.status = 'completed'${inScope(s, "r.survey_id")}
         and q.type <> 'info'
         and (q.required or q.scale_id is not null
              or exists (select 1 from scale_items si where si.question_id = q.id))
         and not exists (select 1 from question_logic ql where ql.question_id = q.id)
         and not exists (
               select 1 from answers a
                where a.response_id = r.id and a.question_id = q.id and not a.skipped)`,
  },
  /*
   * Дубль: та же методика тем же человеком дважды за минуту. Пройти
   * методику заново за минуту нельзя — это двойное нажатие или повтор
   * отправки без clientRequestId. Считается вторая сдача пары: она и лишняя.
   * Человек в выборке удвоен, в динамике — «изменение» за шестьдесят секунд.
   * Анонимные методики не проверяются: связать сдачи там не с кем.
   */
  {
    key: "responses.duplicates",
    level: "warning",
    kind: "response",
    hits: (s) => sql`
      select r2.id, r2.survey_id, r2.submitted_at as at
        from responses r2
       where r2.status = 'completed' and r2.user_id is not null${inScope(s, "r2.survey_id")}
         and exists (
           select 1 from responses r1
            where r1.user_id = r2.user_id and r1.survey_id = r2.survey_id
              and r1.id <> r2.id and r1.status = 'completed'
              and r1.submitted_at <= r2.submitted_at
              and r1.submitted_at > r2.submitted_at - interval '60 seconds'
              and (r1.submitted_at < r2.submitted_at or r1.id < r2.id))`,
  },
  /*
   * Брошенные и висящие прохождения: начаты и не сданы. Сданного они не
   * искажают, но копятся — держат открытыми назначения, занижают
   * доходимость методики, а висящий неделями черновик уже не сдадут.
   * Давность — от последнего автосохранения.
   */
  {
    key: "responses.stale",
    level: "info",
    kind: "response",
    hits: (s) => sql`
      select r.id, r.survey_id, coalesce(r.last_saved_at, r.started_at) as at
        from responses r
       where r.status in ('in_progress', 'abandoned')${inScope(s, "r.survey_id")}`,
    extra: (s) => sql`
      select
        count(*) filter (where r.status = 'in_progress')::int as "inProgress",
        count(*) filter (where r.status = 'abandoned')::int as abandoned,
        count(*) filter (where coalesce(r.last_saved_at, r.started_at) >= now() - interval '1 day')::int as "lt1d",
        count(*) filter (where coalesce(r.last_saved_at, r.started_at) < now() - interval '1 day'
                           and coalesce(r.last_saved_at, r.started_at) >= now() - interval '7 days')::int as "lt7d",
        count(*) filter (where coalesce(r.last_saved_at, r.started_at) < now() - interval '7 days'
                           and coalesce(r.last_saved_at, r.started_at) >= now() - interval '30 days')::int as "lt30d",
        count(*) filter (where coalesce(r.last_saved_at, r.started_at) < now() - interval '30 days')::int as "gte30d"
        from responses r
       where r.status in ('in_progress', 'abandoned')${inScope(s, "r.survey_id")}`,
  },
];

/** Перечень ключей в порядке экрана — для тестов и для экрана без данных */
export const DATA_CHECK_KEYS: readonly DataCheckKey[] = CHECKS.map((c) => c.key);

interface SummaryRow {
  n: number;
  examples: { id: string; surveyId: string }[] | string | null;
  by_survey: { surveyId: string; count: number }[] | string | null;
}

/** postgres-js отдаёт json то разобранным, то строкой — в зависимости от типа колонки */
function parsed<T>(value: T | string | null): T | null {
  if (value === null) return null;
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

async function runOne(spec: CheckSpec, scope: CheckScope): Promise<Omit<DataCheck, "bySurvey"> & { bySurvey: { surveyId: string; count: number }[] }> {
  const rows = await db.execute<SummaryRow & Record<string, unknown>>(sql`
    with hits as (${spec.hits(scope)})
    select
      (select count(*)::int from hits) as n,
      (select json_agg(json_build_object('id', h.id, 'surveyId', h.survey_id))
         from (select id, survey_id from hits order by at desc nulls last, id limit ${EXAMPLES}) h) as examples,
      (select json_agg(json_build_object('surveyId', g.survey_id, 'count', g.n))
         from (select survey_id, count(*)::int as n from hits
                group by survey_id order by count(*) desc, survey_id limit ${BY_SURVEY}) g) as by_survey
  `);
  const row = [...rows][0];
  let extra: Record<string, number> = {};
  if (spec.extra) {
    const extraRows = await db.execute<Record<string, unknown>>(spec.extra(scope));
    const first = [...extraRows][0] ?? {};
    extra = Object.fromEntries(Object.entries(first).map(([k, v]) => [k, Number(v ?? 0)]));
  }
  return {
    key: spec.key,
    level: spec.level,
    count: Number(row?.n ?? 0),
    examples: (parsed(row?.examples ?? null) ?? []).map((e) => ({ id: e.id, surveyId: e.surveyId, kind: spec.kind })),
    bySurvey: parsed(row?.by_survey ?? null) ?? [],
    extra,
  };
}

/**
 * Прогнать все проверки.
 *
 * Вызывающий отвечает за контекст базы: техпанель зовёт это под asSystem —
 * числа про всю систему, а не про зону ответственности того, кто смотрит
 * (см. routes/opsData.ts).
 */
export async function runDataChecks(lang: Lang, scope: CheckScope = {}): Promise<DataCheck[]> {
  const raw: Awaited<ReturnType<typeof runOne>>[] = [];
  // по очереди, а не разом: внутри одной транзакции запросы всё равно идут по одному
  for (const spec of CHECKS) raw.push(await runOne(spec, scope));

  const ids = [...new Set(raw.flatMap((c) => c.bySurvey.map((b) => b.surveyId)))];
  const titles = new Map<string, string>();
  if (ids.length) {
    const rows = await db.execute<{ id: string; title: unknown } & Record<string, unknown>>(sql`
      select id, title from surveys where id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    for (const r of rows) {
      const title = parsed(r.title as never);
      titles.set(String(r.id), t(title as never, lang));
    }
  }

  return raw.map((c) => ({
    ...c,
    bySurvey: c.bySurvey.map((b) => ({ ...b, title: titles.get(b.surveyId) ?? b.surveyId })),
  }));
}
