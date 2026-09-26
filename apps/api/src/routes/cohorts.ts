import { Hono } from "hono";
import { desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  ageAt,
  type CohortCell,
  type CohortMember,
  type CohortMembers,
  type CohortOptions,
  type CohortPreview,
  type CohortSpec,
  type Severity,
} from "@quizzy/shared";
import { db } from "../db";
import { cohorts, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField } from "../lib/crypto";
import { badRequest, notFound, parseBody } from "../lib/http";
import { SMALL_CELL_FLOOR, birthYearOf, canBreakDown, suppress, suppressedKeys } from "../lib/privacy";
import { surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const cohortRoutes = new Hono<AppEnv>();
/*
 * Право проверяется рядом со старой проверкой персонала, а не вместо неё.
 *
 * Замена идёт по одному набору маршрутов, от читающих к клиническим: так на
 * каждом шаге видно, что сломалось, потому что сломаться может немногое.
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
cohortRoutes.use("*", requireAuth, requireStaff, requirePermission("cohorts.read"));

/**
 * Конструктор когорт: визуальный запрос без SQL.
 *
 * «Мужчины 20–30 из рот 1–3, прошедшие МЛО за последний квартал, с ЛАП ниже
 * четырёх, у которых есть повторный замер» — вопрос, который задают постоянно,
 * а отвечают на него выгрузкой в SPSS и обратно.
 *
 * Два обязательства, из-за которых этот маршрут написан именно так:
 *
 *  1. Когорта не выходит за зону ответственности. Правило отбора не даёт
 *     доступа: оно только сужает то, что человек и так вправе видеть.
 *  2. Малые ячейки подавляются, как и в отчётах. То, что выборку собрали
 *     конструктором, а не отчётом, не меняет, кого в ней узнают.
 */

const scaleCond = z.object({
  code: z.string().min(1).max(40),
  op: z.enum([">=", "<=", ">", "<"]),
  value: z.number(),
});

/*
 * Дата — день, а не момент: «по 30 вересня» означает весь день, и строка
 * вида «вчера» или «2026-9-1» в сравнение уйти не должна. Раньше период
 * принимался любой строкой и сравнивался с моментом сдачи как есть:
 * «по 2026-09-30» отсекало всё, что сдано 30-го после полуночи.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const specSchema = z
  .object({
    sex: z.enum(["male", "female"]).nullable().optional(),
    ageMin: z.number().int().min(0).max(120).nullable().optional(),
    ageMax: z.number().int().min(0).max(120).nullable().optional(),
    units: z.array(z.string().max(120)).max(50).optional(),
    localities: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
    surveyId: z.string().nullable().optional(),
    from: day.nullable().optional(),
    to: day.nullable().optional(),
    scales: z.array(scaleCond).max(10).optional(),
    minSeverity: z.enum(["mild", "moderate", "severe"]).nullable().optional(),
    repeatedOnly: z.boolean().optional(),
    riskOnly: z.boolean().optional(),
  })
  /*
   * Перевёрнутый диапазон — ошибка набора, а не пустая когорта: «від 45 до
   * 25» честным нулём читалось бы как «таких людей нет». Экран не даёт его
   * отправить; здесь — страховка для тех, кто зовёт маршрут мимо экрана.
   */
  .refine((v) => v.ageMin == null || v.ageMax == null || v.ageMin <= v.ageMax, { path: ["ageMax"] })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"] });

/** Ступени выраженности по возрастанию — порядок, в котором «не нижче» имеет смысл */
const SEVERITY_ORDER: Severity[] = ["none", "mild", "moderate", "severe"];

/** Ступень полосы в SQL: сравнивать перечисление строкой нельзя — «severe» < «mild» по алфавиту */
function severityRank(column: string): SQL {
  const col = sql.raw(column);
  return sql`case ${col} when 'none' then 0 when 'mild' then 1 when 'moderate' then 2 when 'severe' then 3 end`;
}

/**
 * Отбор: условие на людей и определение «прохождения выборки».
 *
 * Второе — не мелочь. Период, методика, «повторний замір», «тривога
 * ризику», условия по шкалам, выраженность и разбивки обязаны говорить об
 * ОДНИХ И ТЕХ ЖЕ прохождениях. Раньше каждое условие смотрело на своё:
 * период ограничивал только «есть ли прохождение», а тревога бралась за всю
 * историю человека, шкалы — без периода. «Тривога ризику за вересень»
 * находила людей с тревогой в марте, и экран об этом молчал.
 */
interface Selection {
  where: SQL;
  /** Прохождение под алиасом входит в выборку */
  taken: (alias: string) => SQL;
}

/**
 * Условие отбора одним SQL.
 *
 * Собирается фрагментами, а не строкой: значения уходят параметрами, и
 * подстановка чужого текста в запрос невозможна по устройству. Название
 * подразделения приходит от человека и вполне может содержать кавычку.
 * Алиасы (`r`, `r3` …) — константы этого файла, а не ввод, поэтому
 * подставляются как есть.
 */
async function cohortSelection(user: Parameters<typeof surveyScopeFilter>[0], spec: CohortSpec): Promise<Selection> {
  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const allowed = scoped.map((s) => s.id);
  if (!allowed.length) return { where: sql`false`, taken: () => sql`false` };

  if (spec.surveyId && !allowed.includes(spec.surveyId)) {
    /*
     * Методика вне зоны — не «пустая когорта», а отказ. Пустой ответ здесь
     * читался бы как «таких нет», хотя правильный ответ «вам не видно».
     */
    badRequest("err.surveyUnavailable");
  }

  const surveyIds = spec.surveyId ? [spec.surveyId] : allowed;
  /*
   * Границы периода — календарные дни включительно, в поясе базы: так же
   * считает статистика (lib/statModels.ts, sampleOf), и одна и та же дата
   * в двух разделах не должна означать разные сутки.
   */
  const taken = (alias: string): SQL => {
    const r = sql.raw(alias);
    return sql`${r}.status = 'completed'
      and ${r}.survey_id in ${surveyIds}
      ${spec.from ? sql`and ${r}.submitted_at >= ${spec.from}::date` : sql``}
      ${spec.to ? sql`and ${r}.submitted_at < (${spec.to}::date + 1)` : sql``}`;
  };

  const parts: SQL[] = [
    sql`u.role = 'user'`,
    sql`exists (select 1 from responses r where r.user_id = u.id and ${taken("r")})`,
  ];

  if (spec.sex) parts.push(sql`u.sex = ${spec.sex}`);
  if (spec.units?.length) parts.push(sql`u.unit in ${spec.units}`);

  /*
   * Населённый пункт — без учёта регистра, как в статистике: поле свободное,
   * и «київ» с «Київ» — один город. Каждое значение — своим параметром под
   * lower(), а не одной склейкой: кавычка в названии села не должна ничего
   * значить для запроса.
   */
  if (spec.localities?.length) {
    const wanted = sql.join(
      spec.localities.map((l) => sql`lower(${l})`),
      sql`, `,
    );
    parts.push(sql`lower(u.locality) in (${wanted})`);
  }

  if (spec.repeatedOnly) {
    parts.push(sql`(select count(*) from responses r3 where r3.user_id = u.id and ${taken("r3")}) >= 2`);
  }

  if (spec.riskOnly) {
    parts.push(sql`exists (
      select 1 from risk_alerts ra
      join responses r5 on r5.id = ra.response_id
      where r5.user_id = u.id and ${taken("r5")}
    )`);
  }

  for (const cond of spec.scales ?? []) {
    /*
     * Оператор подставляется из закрытого перечня, а не из строки запроса:
     * drizzle не параметризует оператор, и единственная защита здесь — то, что
     * значение вообще не приходит снаружи в свободном виде.
     */
    const op =
      cond.op === ">=" ? sql`>=` : cond.op === "<=" ? sql`<=` : cond.op === ">" ? sql`>` : sql`<`;
    parts.push(sql`exists (
      select 1 from response_scores rs
      join responses r4 on r4.id = rs.response_id
      join scales sc on sc.id = rs.scale_id
      where r4.user_id = u.id
        and ${taken("r4")}
        and sc.code = ${cond.code}
        and rs.value ${op} ${cond.value}
    )`);
  }

  if (spec.minSeverity) {
    const floor = SEVERITY_ORDER.indexOf(spec.minSeverity);
    parts.push(sql`exists (
      select 1 from response_scores rs6
      join responses r6 on r6.id = rs6.response_id
      where r6.user_id = u.id
        and ${taken("r6")}
        and ${severityRank("rs6.severity")} >= ${floor}
    )`);
  }

  let where = sql.join(parts, sql` and `);

  /*
   * Возраст — на момент прохождения, от даты рождения, а не по полосе-снимку.
   *
   * Прежде «Вік від 27 до 29» переводился в полосы снимка и отвечал всей
   * полосой «25–34»: экран спрашивал про три года, а считал десять, и
   * никакой подписи об этом не было. Дата рождения зашифрована, поэтому
   * возраст считается здесь, в приложении, по кандидатам остальных условий;
   * в SQL уходит уже список подошедших — одной строкой JSON, а не тысячей
   * параметров: у драйвера им есть потолок.
   *
   * Человек подходит, если хоть одно его прохождение выборки сдано в этом
   * возрасте. Без даты рождения под возрастное условие не попадает никто:
   * «від 25» про него неизвестно — так же решено в статистике.
   */
  if (spec.ageMin != null || spec.ageMax != null) {
    const rows = await db.execute<{ id: string; birth: string | null; at: string | null }>(sql`
      select u.id, u.birth_date as birth, r.submitted_at as at
      from users u
      join responses r on r.user_id = u.id and ${taken("r")}
      where ${where} and u.birth_date is not null
    `);
    const born = new Map<string, string | null>();
    const fits = new Set<string>();
    for (const row of rows) {
      if (fits.has(row.id) || !row.at) continue;
      if (!born.has(row.id)) born.set(row.id, decryptField(row.birth));
      const age = ageAt(born.get(row.id) ?? null, new Date(row.at).toISOString());
      if (age === null) continue;
      if (spec.ageMin != null && age < spec.ageMin) continue;
      if (spec.ageMax != null && age > spec.ageMax) continue;
      fits.add(row.id);
    }
    if (!fits.size) return { where: sql`false`, taken };
    where = sql`${where} and u.id in (select jsonb_array_elements_text(${JSON.stringify([...fits])}::jsonb))`;
  }

  return { where, taken };
}

/**
 * Разбивка с дополняющим подавлением.
 *
 * Число когорты печатается рядом, а значит одна скрытая ячейка
 * восстанавливалась вычитанием: «у вибірці 8, чоловіків 5» называло
 * женщин — троих — без всякого прочерка. Прежде ячейки прятались каждая
 * сама по себе (suppress), и разбивка по полу у когорты из восьми отдавала
 * скрытое арифметикой первого класса. Теперь правило то же, что в отчётах:
 * suppressedKeys прячет пару (или всё разбиение, где пара не спасает).
 *
 * Поэтому запрос отдаёт ВСЕ ячейки, без потолка строк: правило решает по
 * целому разбиению, а обрезанный хвост сделал бы сумму «неизвестной» только
 * на вид — хвост легко получить соседним запросом.
 *
 * Порядок: показанные — по убыванию, скрытые — после них по ключу.
 * Сортировка всех по числу выдавала бы место скрытой ячейки между
 * соседями, то есть её границы.
 */
async function breakdown(query: SQL): Promise<CohortCell[]> {
  const rows = [...(await db.execute<{ key: string | null; n: number }>(query))].map((r) => ({
    key: r.key ?? "—",
    n: Number(r.n),
  }));
  const hidden = suppressedKeys(rows);
  const shown = rows.filter((r) => !hidden.has(r.key)).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const closed = rows.filter((r) => hidden.has(r.key)).sort((a, b) => a.key.localeCompare(b.key));
  return [...shown.map((r) => ({ key: r.key, count: r.n })), ...closed.map((r) => ({ key: r.key, count: null }))];
}

cohortRoutes.post("/preview", async (c) => {
  const user = c.get("user");
  const spec = await parseBody(c.req.raw, specSchema);
  const { where, taken } = await cohortSelection(user, spec);

  const [{ n = 0 } = { n: 0 }] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from users u where ${where}`,
  );
  const size = Number(n);

  /*
   * Разбивки показываются только у достаточно большой когорты. У когорты из
   * трёх человек «мужчин: 1» указывает на конкретного — ровно так же, как в
   * отчёте по роте.
   */
  const allowed = canBreakDown(size);

  const byColumn = (column: SQL) =>
    allowed
      ? breakdown(sql`select ${column} as key, count(*)::int as n from users u where ${where} group by 1`)
      : Promise.resolve([]);

  /*
   * Возраст — полоса ПОСЛЕДНЕГО прохождения выборки: человек за два года
   * наблюдения мог перейти из «25–34» в «35–44», и считать его в обеих
   * значило бы, что доли не складываются в целое.
   */
  const byAge = allowed
    ? breakdown(sql`
        select b.band as key, count(*)::int as n from (
          select distinct on (u.id) u.id, r.respondent_age_band as band
          from users u
          join responses r on r.user_id = u.id and ${taken("r")}
          where ${where}
          order by u.id, r.submitted_at desc nulls last, r.id desc
        ) b group by 1
      `)
    : Promise.resolve([]);

  /*
   * Выраженность — самая тяжёлая полоса человека среди прохождений выборки.
   *
   * Прежде человек попадал в каждую ступень, где у него была хоть одна
   * шкала, и за всю историю, а не за выбранный период: строки разбивки не
   * складывались в когорту, и «помірна: 40» при когорте 60 нельзя было
   * прочесть как долю. Одна ступень на человека — это вопрос, который
   * задают на самом деле: «сколько из них хотя бы где-то в тяжёлой полосе».
   */
  const bySeverity = allowed
    ? breakdown(sql`
        select m.rank::text as key, count(*)::int as n from (
          select u.id, max(${severityRank("rs.severity")}) as rank
          from users u
          join responses r on r.user_id = u.id and ${taken("r")}
          left join response_scores rs on rs.response_id = r.id
          where ${where}
          group by u.id
        ) m group by 1
      `).then((cells) =>
        cells.map((cell) => ({ ...cell, key: SEVERITY_ORDER[Number(cell.key)] ?? "—" })),
      )
    : Promise.resolve([]);

  const [bySex, byUnit, byLocality, ages, severities] = await Promise.all([
    byColumn(sql`u.sex`),
    byColumn(sql`u.unit`),
    byColumn(sql`u.locality`),
    byAge,
    bySeverity,
  ]);

  await audit(c, { action: "cohort.preview", details: { size, spec } });

  return c.json({
    // размер тоже подавляется: «нашлось 2» — это уже сведение о двух людях
    size: suppress(size),
    breakdownAllowed: allowed,
    smallCellFloor: SMALL_CELL_FLOOR,
    bySex,
    byUnit,
    byLocality,
    byAge: ages,
    bySeverity: severities,
  } satisfies CohortPreview);
});

/**
 * Из чего выбирать: подразделения и населённые пункты людей в зоне.
 *
 * Прежде список подразделений копился на экране из разбивок предпросмотра:
 * справочника подразделений в системе нет. Это работало, пока разбивка
 * была одна; с фильтром по населённому пункту тот же приём дал бы список,
 * который зависит от того, что человек успел понажимать, — и пункт, в
 * который он ни разу не сузился, выбрать было бы нечем.
 *
 * Отдаются только названия, без чисел, и только в пределах зоны: те же
 * люди, что попадают в пустое правило отбора. Название подразделения — не
 * сведение о человеке; сколько там людей, скажет предпросмотр — со своим
 * порогом и своей записью в журнале.
 */
cohortRoutes.get("/options", async (c) => {
  const user = c.get("user");
  const { where } = await cohortSelection(user, {});
  const values = async (column: SQL) =>
    [
      ...(await db.execute<{ v: string }>(
        sql`select distinct ${column} as v from users u where ${where} and ${column} is not null and ${column} <> ''`,
      )),
    ]
      .map((r) => r.v)
      .sort((a, b) => a.localeCompare(b, "uk"));
  return c.json({ units: await values(sql`u.unit`), localities: await values(sql`u.locality`) } satisfies CohortOptions);
});

/** Потолок поимённого списка: дальше это уже выгрузка, а не список на экране */
const MEMBERS_CAP = 500;

/**
 * Список когорты поимённо.
 *
 * Отдельный маршрут, а не поле в предпросмотре: посмотреть распределение и
 * увидеть имена — разные действия с разными последствиями, и в журнале они
 * должны различаться.
 *
 * Порог малых ячеек действует и здесь — и это главное в этом маршруте.
 *
 * Раньше предпросмотр прятал размер когорты из трёх человек, а этот маршрут
 * с тем же самым правилом отбора отдавал этих троих поимённо. Подавление в
 * предпросмотре при этом не защищало ничего: тот, кому нужны были имена,
 * получал их следующим запросом, из того же экрана, одним нажатием. Хуже
 * того, оно создавало ложное впечатление, что порог действует, — и вопрос
 * «а не выдаём ли мы отдельных людей» считался закрытым.
 *
 * Из двух последовательных решений — снять подавление с предпросмотра или
 * распространить его на поимённый список — выбрано второе. Первое честнее
 * выглядит, но отдаёт больше: конструктор когорт существует ради
 * статистики, и выдача одного-двух человек по произвольному сочетанию
 * признаков («мужчины 30–35 из роты Б с высоким риском») — это не
 * статистика, а поиск конкретного человека по клиническим признакам.
 * Отвергнутый вариант объяснял бы это тем, что сотрудник и так вправе
 * видеть этих людей; но вправе он видеть их как своих пациентов — по
 * карте, по списку, по поиску, где это и называется своим именем и так же
 * попадает в журнал, — а не как «всех, у кого балл выше порога».
 *
 * Ответ поэтому не отказ, а честный пустой список с флагом: когорта
 * найдена, размер её ниже порога, имён не будет. Отказ (403) читался бы
 * как «вам сюда нельзя», хотя дело не в правах спрашивающего.
 *
 * Строка человека несёт то, что нужно, чтобы решить «что с ним делать» не
 * открывая карточку: почта и год — различить тёзок, подразделение и пункт —
 * узнать своих, последнее прохождение выборки и его самая тяжёлая полоса —
 * увидеть, кого смотреть первым. Телефона нет: см. CohortMember.
 */
cohortRoutes.post("/members", async (c) => {
  const user = c.get("user");
  const spec = await parseBody(c.req.raw, specSchema);
  const { where, taken } = await cohortSelection(user, spec);

  const rows = await db.execute<{ id: string }>(
    sql`select u.id from users u where ${where} order by u.id limit ${MEMBERS_CAP + 1}`,
  );
  const found = [...rows].map((r) => r.id);
  const truncated = found.length > MEMBERS_CAP;
  const ids = found.slice(0, MEMBERS_CAP);
  if (!ids.length) {
    return c.json({ items: [], suppressed: false, smallCellFloor: SMALL_CELL_FLOOR, truncated: false } satisfies CohortMembers);
  }

  if (!canBreakDown(ids.length)) {
    /*
     * В журнал попадает и отказанная попытка — с размером, но без имён:
     * подбор параметров, пока когорта не сожмётся до одного человека,
     * должен быть виден при разборе.
     */
    await audit(c, {
      action: "cohort.members",
      outcome: "denied",
      details: { size: ids.length, spec, reason: "small_cell" },
    });
    return c.json({ items: [], suppressed: true, smallCellFloor: SMALL_CELL_FLOOR, truncated: false } satisfies CohortMembers);
  }

  const people = await db.select().from(users).where(sql`${users.id} in ${ids}`);

  const last = new Map<string, CohortMember["last"]>();
  for (const r of await db.execute<{
    userId: string;
    responseId: string;
    surveyId: string;
    submittedAt: string | null;
    rank: number | null;
  }>(sql`
    select distinct on (r.user_id)
      r.user_id as "userId", r.id as "responseId", r.survey_id as "surveyId", r.submitted_at as "submittedAt",
      (select max(${severityRank("rs.severity")}) from response_scores rs where rs.response_id = r.id) as rank
    from responses r
    where r.user_id in ${ids} and ${taken("r")}
    order by r.user_id, r.submitted_at desc nulls last, r.id desc
  `)) {
    last.set(r.userId, {
      responseId: r.responseId,
      surveyId: r.surveyId,
      submittedAt: r.submittedAt ? new Date(r.submittedAt).toISOString() : null,
      severity: r.rank === null ? null : (SEVERITY_ORDER[Number(r.rank)] ?? null),
    });
  }

  await audit(c, { action: "cohort.members", details: { size: ids.length, spec } });

  const items: CohortMember[] = people
    .map((p) => ({
      userId: p.id,
      fullName: fullNameOf(p),
      email: p.email,
      unit: p.unit,
      locality: p.locality,
      sex: p.sex,
      birthYear: birthYearOf(decryptField(p.birthDate)),
      last: last.get(p.id) ?? null,
    }))
    // по фамилии: имена зашифрованы, и сортировать их может только приложение
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "uk"));

  return c.json({ items, suppressed: false, smallCellFloor: SMALL_CELL_FLOOR, truncated } satisfies CohortMembers);
});

/* ── сохранённые когорты ── */

const saveSchema = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().max(1000).nullable().optional(),
  spec: specSchema,
});

/*
 * Правка — название, заметка и само правило. Правило заменяется целиком,
 * а не сливается: снятое на экране условие, слитое со старым, вернулось бы
 * назад, и «оновити умови» сохраняло бы не то, что человек видит.
 */
const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  note: z.string().max(1000).nullable().optional(),
  spec: specSchema.optional(),
});

cohortRoutes.get("/", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select()
    .from(cohorts)
    .where(eq(cohorts.createdBy, user.id))
    .orderBy(desc(cohorts.createdAt));

  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      note: r.note,
      spec: r.spec as CohortSpec,
      createdAt: r.createdAt,
    })),
  });
});

cohortRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, saveSchema);

  const id = crypto.randomUUID();
  await db.insert(cohorts).values({
    id,
    title: input.title,
    note: input.note ?? null,
    spec: input.spec,
    createdBy: user.id,
  });

  await audit(c, { action: "cohort.save", resourceType: "cohort", resourceId: id });
  return c.json({ id }, 201);
});

/**
 * Переименовать или пересохранить свою когорту.
 *
 * Чужая — «не найдено», как у удаления: когорта личная, и отличать «нет
 * такой» от «есть, но не ваша» значило бы подтверждать существование чужой.
 */
cohortRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const input = await parseBody(c.req.raw, updateSchema);

  const changes = {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.note !== undefined && { note: input.note }),
    ...(input.spec !== undefined && { spec: input.spec }),
  };

  const [row] = Object.keys(changes).length
    ? await db
        .update(cohorts)
        .set(changes)
        .where(sql`${cohorts.id} = ${id} and ${cohorts.createdBy} = ${user.id}`)
        .returning()
    : await db
        .select()
        .from(cohorts)
        .where(sql`${cohorts.id} = ${id} and ${cohorts.createdBy} = ${user.id}`);
  if (!row) notFound("err.cohortNotFound");

  await audit(c, {
    action: "cohort.update",
    resourceType: "cohort",
    resourceId: id,
    details: { fields: Object.keys(changes) },
  });
  return c.json({ id: row.id, title: row.title, note: row.note, spec: row.spec as CohortSpec, createdAt: row.createdAt });
});

cohortRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const [row] = await db
    .delete(cohorts)
    .where(sql`${cohorts.id} = ${id} and ${cohorts.createdBy} = ${user.id}`)
    .returning();
  if (!row) notFound("err.cohortNotFound");

  await audit(c, { action: "cohort.delete", resourceType: "cohort", resourceId: id });
  return c.json({ ok: true });
});
