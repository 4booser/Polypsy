import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  ageAt,
  type Lang,
  type SampleFilters,
  type StatCell,
  type StatModelBandIndicator,
  type StatModelColumn,
  type StatModelColumnInput,
  type StatRunColumn,
  type StatRunQuestion,
  type StatRunScale,
  type StatSuppressReason,
  type SurveyFull,
  type User,
} from "@quizzy/shared";
import { db } from "../db";
import { answers, responseScores, responses, surveyVersions, surveys, users } from "../db/schema";
import { decryptField } from "./crypto";
import { badRequest, notFound } from "./http";
import { canBreakDown, suppress } from "./privacy";
import {
  assertFilterPresetAccess,
  assertPatientAccess,
  assertPatientGroupAccess,
  assertSurveyAccess,
} from "./scope";
import { getSurvey } from "./surveys";

/**
 * Статистические модели: проверка колонок при сохранении и расчёт.
 *
 * Здесь, а не в маршруте, потому что одно и то же делают три входа —
 * «Створити», «Порівняти» без сохранения и «Оновити» по сохранённой
 * модели, — и правило «показатель обязан существовать в версии методики»,
 * написанное трижды, разошлось бы на третьем.
 *
 * ═══ Два обязательства ═══
 *
 * 1. Выборка не выходит за зону ответственности. Фильтры её только сужают:
 *    методика — через assertSurveyAccess, группа пациентов и конкретный
 *    человек — через те же проверки, что у карты пациента. Иначе колонка
 *    «пацієнт: <идентификатор>» была бы способом узнать распределение
 *    ответов человека, которого сотруднику видеть не положено.
 *
 * 2. Ни одной ячейки ниже порога малых чисел — и ни одной, которую можно
 *    восстановить из соседних (lib/privacy.ts). Конструктор фильтров по
 *    полу, возрасту и населённому пункту — машина для нарезки выборки до
 *    одного человека, и без второй половины правила первая ничего не
 *    защищает: «показано 7 и 5 из 14» называет скрытые две так же точно,
 *    как если бы их напечатали.
 *
 * ═══ Три уровня подавления ═══
 *
 * Ячейки отчёта — не отдельные числа, а система уравнений, и защита стоит
 * на каждом её этаже:
 *
 * — группа (groupCells): полосы шкалы с остатком, варианты вопроса с
 *   остатком. Под порогом хоть одна ячейка — скрыта вся группа, иначе
 *   единственное неизвестное системы называется вычитанием;
 * — колонка (riskCell): «ВШР» стоит поверх групп, объединяя помеченные
 *   множества, и прячется, если скрыта группа с помеченной ячейкой или
 *   если помеченные множества пересекаются горсткой людей;
 * — модель (closedByOverlap): две колонки, различающиеся горсткой людей,
 *   описывают эту горстку разностью своих чисел — колонка с малой
 *   разностью закрывается целиком.
 *
 * Каждый этаж разбирался на живом расчёте POST /api/stat-models/run, и
 * каждый закрывает найденную там утечку, а не предполагаемую.
 */

/**
 * Типы вопросов, по которым считается доля ответов: у них есть варианты,
 * и ответ читается как выбор. Матрица — выбор в каждой строке, ранжирование —
 * порядок, число — не вариант вовсе: у макета под них нет строки
 * «Текст відповіді — Відсоток відповідей».
 */
const QUESTION_TYPES = new Set(["single", "yesno", "multiple"]);

/**
 * Ссылки внутри фильтров — своя группа, свой пациент.
 *
 * Отвечают «не найдено», как и сами проверки: 404 на чужую группу не
 * подтверждает, что коллега такую завёл. Вызывается и при сохранении
 * пресета, и при сохранении модели, и при расчёте: зона меняется, и
 * сохранённый год назад фильтр по группе не должен пережить её передачу.
 */
export async function assertFilterRefs(user: User, filters: SampleFilters): Promise<void> {
  if (filters.patientGroupId) await assertPatientGroupAccess(user, filters.patientGroupId);
  if (filters.patientId) await assertPatientAccess(user, filters.patientId);
}

/**
 * Версия колонки: заданная — только своей методики, иначе действующая.
 *
 * Версия записывается в модель при сохранении и дальше не плавает:
 * идентификаторы полос и вариантов принадлежат версии, и модель, следящая
 * за «текущей», после первой правки методики ссылалась бы в пустоту.
 */
async function resolveVersion(surveyId: string, versionId: string | null): Promise<string> {
  if (versionId) {
    const row = await db.query.surveyVersions.findFirst({
      where: and(eq(surveyVersions.id, versionId), eq(surveyVersions.surveyId, surveyId)),
    });
    if (!row) badRequest("err.statModelVersionNotFound");
    return row.id;
  }
  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, surveyId) });
  if (!survey?.currentVersionId) badRequest("err.statModelSurveyEmpty");
  return survey.currentVersionId;
}

/**
 * Показатели колонки обязаны существовать в её версии методики.
 *
 * Проверяется по содержимому версии, а не по одному факту «идентификатор
 * есть в базе»: полоса другой шкалы или вариант другого вопроса — тоже
 * существующие строки, и модель с ними сохранилась бы, а считала бы нули.
 */
function assertIndicators(survey: SurveyFull, column: StatModelColumnInput): void {
  const scaleById = new Map(survey.scales.map((s) => [s.id, s]));
  for (const b of column.bands ?? []) {
    const scale = scaleById.get(b.scaleId);
    const band = scale?.bands.find((x) => x.id === b.bandId);
    if (!scale || !band) {
      badRequest("err.statModelIndicatorUnknown", { what: scale ? `${scale.title} → ${b.bandId}` : b.scaleId });
    }
  }
  const questionById = new Map(survey.questions.map((q) => [q.id, q]));
  for (const q of column.questions ?? []) {
    const question = questionById.get(q.questionId);
    if (!question) badRequest("err.statModelIndicatorUnknown", { what: q.questionId });
    if (!QUESTION_TYPES.has(question.type)) badRequest("err.statModelQuestionType", { title: question.title });
    for (const o of q.options ?? []) {
      const option = question.options.find((x) => x.id === o.optionId && x.kind === "option");
      if (!option) badRequest("err.statModelIndicatorUnknown", { what: `${question.title} → ${o.optionId}` });
    }
  }
}

/**
 * Колонки с формы — в вид, который хранится: версия записана, показатели
 * проверены, пресет и собственные фильтры разведены (одно из двух, второе
 * — null, а не пустой объект: пустой объект читался бы как «фильтров нет»
 * и молча заслонял бы пресет).
 */
export async function resolveColumns(user: User, input: StatModelColumnInput[]): Promise<StatModelColumn[]> {
  const out: StatModelColumn[] = [];
  for (const col of input) {
    if (col.presetId) await assertFilterPresetAccess(user, col.presetId);
    const filters = col.presetId ? null : (col.filters ?? {});
    if (filters) await assertFilterRefs(user, filters);

    await assertSurveyAccess(user, col.surveyId);
    const versionId = await resolveVersion(col.surveyId, col.versionId ?? null);
    const survey = await getSurvey(col.surveyId, versionId, "uk");
    if (!survey) notFound("err.surveyNotFound");
    assertIndicators(survey, col);

    out.push({
      title: col.title ?? null,
      presetId: col.presetId ?? null,
      filters,
      surveyId: col.surveyId,
      versionId,
      bands: (col.bands ?? []).map((b) => ({ scaleId: b.scaleId, bandId: b.bandId, highRisk: b.highRisk ?? false })),
      questions: (col.questions ?? []).map((q) => ({
        questionId: q.questionId,
        options: (q.options ?? []).map((o) => ({ optionId: o.optionId, highRisk: o.highRisk ?? false })),
      })),
    });
  }
  return out;
}

/* ─────────── Расчёт ─────────── */

interface Respondent {
  responseId: string;
  userId: string;
}

/**
 * Выборка колонки: по одному прохождению на человека — последнему сданному
 * из тех, что попали под фильтры.
 *
 * Считаются прохождения ТОЙ ЖЕ версии, что записана в колонке: полосы и
 * варианты принадлежат версии, и прохождение прежней версии в её полосы
 * не ложится. Анонимные прохождения (user_id пуст) не считаются вовсе —
 * фильтры здесь про людей, а не про бланки.
 *
 * Возраст — от даты рождения на момент сдачи, а не от полосы-снимка в
 * прохождении: полоса «25–34» ответила бы на «від 27 до 29» всеми десятью
 * годами. Дата рождения зашифрована, поэтому возраст считается в
 * приложении после выборки, а не в SQL. Человек без даты рождения под
 * возрастной фильтр не попадает: «от 25» про него неизвестно.
 *
 * Границы периода — календарные дни включительно, в поясе базы: макет
 * просит «Дата», а не момент, и «по 30 вересня» означает весь день.
 */
async function sampleOf(column: StatModelColumn, filters: SampleFilters): Promise<Respondent[]> {
  const rows = await db
    .select({
      id: responses.id,
      userId: responses.userId,
      submittedAt: responses.submittedAt,
      birthDate: users.birthDate,
    })
    .from(responses)
    .innerJoin(users, eq(users.id, responses.userId))
    .where(
      and(
        eq(responses.surveyId, column.surveyId),
        eq(responses.versionId, column.versionId),
        eq(responses.status, "completed"),
        isNotNull(responses.submittedAt),
        eq(users.role, "user"),
        filters.sex ? eq(users.sex, filters.sex) : undefined,
        // без учёта регистра: «київ» и «Київ» — один город, а поле свободное
        filters.locality ? sql`lower(${users.locality}) = lower(${filters.locality})` : undefined,
        filters.from ? sql`${responses.submittedAt} >= ${filters.from}::date` : undefined,
        filters.to ? sql`${responses.submittedAt} < (${filters.to}::date + 1)` : undefined,
        filters.patientId ? eq(users.id, filters.patientId) : undefined,
        filters.patientGroupId
          ? sql`exists (select 1 from patient_group_members m
              where m.group_id = ${filters.patientGroupId} and m.patient_id = ${users.id})`
          : undefined,
      ),
    )
    /*
     * Последнее прохождение — первое в порядке «человек, время ↓»;
     * идентификатор третьим ключом, чтобы два прохождения одной секунды
     * (офлайн-очередь сдаёт их пачкой) не менялись местами от запроса к
     * запросу.
     */
    .orderBy(asc(responses.userId), desc(responses.submittedAt), desc(responses.id));

  const byAge = filters.ageMin != null || filters.ageMax != null;
  const sample: Respondent[] = [];
  let lastUser: string | null = null;
  for (const r of rows) {
    if (!r.userId || r.userId === lastUser) continue;
    lastUser = r.userId;
    if (byAge) {
      const age = ageAt(decryptField(r.birthDate), r.submittedAt);
      if (age === null) continue;
      if (filters.ageMin != null && age < filters.ageMin) continue;
      if (filters.ageMax != null && age > filters.ageMax) continue;
    }
    sample.push({ responseId: r.id, userId: r.userId });
  }
  return sample;
}

const HIDDEN: StatCell = { suppressed: true };

/** Доля — от показанного основания; у пустой колонки доли нет, но и прятать нечего */
function shown(n: number, total: number): StatCell {
  return { suppressed: false, count: n, percent: total > 0 ? Math.round((n / total) * 100) : 0 };
}

/** Ключ остатка группы — не идентификатор полосы и не идентификатор варианта */
const REST = "__rest";

/**
 * Ячейка ниже порога.
 *
 * У разбиения (полосы шкалы, варианты одного выбора и их остаток) хватает
 * одного края: дополнение ячейки — это остальные ячейки той же группы, и
 * если их сумма меньше порога, то какая-то из них сама под ним, а если она
 * ноль, то ячейка равна основанию и никого по отдельности не называет.
 *
 * У множеств (варианты вопроса с несколькими ответами, «ВШР») дополнения
 * внутри группы нет: каждый вариант — своё «выбрал / не выбрал». Поэтому
 * оба края: «десять из двенадцати» называет двоих так же точно, как «двое
 * из двенадцати».
 */
function underFloor(n: number, total: number, sets: boolean): boolean {
  return suppress(n) === null || (sets && suppress(total - n) === null);
}

/**
 * Группа ячеек одного показателя — полосы шкалы с остатком, варианты
 * вопроса с остатком — показывается целиком или прячется целиком.
 *
 * Почему целиком, а не по ячейке. Ячейки группы связаны уравнениями,
 * которые читатель видит рядом с ними: у разбиения сумма ячеек и остатка
 * равна основанию; у вопроса с несколькими ответами остаток — дополнение
 * объединения вариантов, а «ВШР» — объединение помеченных. Пока в группе
 * показана хоть одна ячейка и скрыта хоть одна, у системы остаётся ровно
 * одно неизвестное — и скрытая названа вычитанием. Так и вышло на разборе:
 * 21 респондент, «Шум» 10, «Біль» 5, «решта» 5 и «ВШР» 12 над «Шум ∪ Біль»
 * дают скрытые «Думки» = 21 − 5 − 12 = 4. Скрытая группа целиком оставляет
 * уравнениям столько же неизвестных, сколько ячеек: каждая скрытая ячейка
 * принимает любое значение от 0 до основания, и ни одна не определена.
 *
 * Отвергнуто: дополняющее подавление (suppressedKeys, lib/privacy.ts) —
 * прятать в пару к малой ячейке вторую, самую маленькую из показанных. Для
 * настоящего разбиения оно доказуемо и там остаётся, здесь — нет: у вопроса
 * с несколькими ответами уравнений больше, чем ячеек (остаток и «ВШР» стоят
 * поверх объединений), и пара скрытых читается из них, как в примере выше.
 * К тому же пара выбирается по опубликованному правилу, и читатель сужает
 * её тем же правилом; доказательство пары занимает не пять строк, а
 * страницу — значит, пары здесь нет.
 */
function groupCells(
  parts: { key: string; n: number }[],
  rest: number,
  total: number,
  sets: boolean,
): Map<string, StatCell> {
  const cells = [...parts, { key: REST, n: rest }];
  /*
   * Пересчёт: насколько сумма ячеек больше объединения. У разбиения он
   * тождественно ноль (ячейки не пересекаются), у множеств — в точности
   * число тех, кто выбрал больше одного варианта. Горстка здесь — тоже
   * названные люди: при ДВУХ показанных вариантах пересчёт и есть их
   * пересечение, «Шум» 10 и «Біль» 8 при объединении 16 отдают двоих.
   */
  const overcount = parts.reduce((sum, p) => sum + p.n, 0) - (total - rest);
  const open = suppress(overcount) !== null && cells.every((c) => !underFloor(c.n, total, sets));
  return new Map(cells.map((c) => [c.key, open ? shown(c.n, total) : HIDDEN]));
}

/**
 * «ВШР» колонки — объединение помеченных множеств из РАЗНЫХ групп, поэтому
 * и правила у него свои, поверх групповых.
 *
 * Прячется в трёх случаях. Первый: скрыта группа, где стоит помеченная
 * ячейка, — объединение поверх скрытого слагаемого называет его вычитанием
 * (двенадцать человек 5/2/5, помечены «Низький» и «Середній»: группа
 * скрыта, а «ВШР: 7» отдавал бы «Середній» как 7 − 5). Второй: сам под
 * порогом с обоих краёв — «пятеро из семи» называет двоих. Третий: все
 * помеченные ячейки показаны, но их сумма больше объединения — разность
 * `marked − hits` есть в точности число тех, кто попал больше чем в один
 * помеченный показатель, и если их горстка, отчёт описывает эту горстку.
 * Иначе разность равна нулю (помеченные множества не пересекаются вовсе)
 * или не меньше порога, и назвать по ней некого.
 *
 * Отвергнуто: подать «ВШР» в подавление вместе с ячейками группы. Он не
 * слагаемое группы, а объединение поверх нескольких групп; подавление,
 * получив его как ещё одну ячейку, спрятало бы ячейки таблицы ради
 * сводного числа — то есть пожертвовало бы главным ради производного.
 */
function riskCell(hits: number, marked: number, hiddenGroup: boolean, total: number): StatCell {
  if (hiddenGroup || suppress(marked - hits) === null) return HIDDEN;
  return underFloor(hits, total, true) ? HIDDEN : shown(hits, total);
}

/**
 * Разность составов двух колонок: |A∖B| под порогом — колонки описывают
 * эту горстку людей вычитанием.
 *
 * Доказательство. Колонки печатают по каждому показателю X числа |A∩X| и
 * |B∩X|; их разность равна |(A∖B)∩X| − |(B∖A)∩X|. Когда вторая разность
 * пуста (B ⊆ A), вычитание колонок даёт распределение тех, кто есть в A и
 * нет в B, начисто и сразу по всем показателям: пол, возраст, город и
 * полосы результата горстки людей. Когда не пуста, начисто горстка не
 * называется, но каждый её показатель оказывается зажат между разностями —
 * и отделять одно от другого пришлось бы доказательством на каждую пару
 * колонок. Дешевле закрыть: колонка, чья разность под порогом, отдаёт
 * числа — без них вычитать нечего. Равные составы (обе разности пусты) —
 * не утечка, а дубль: разность по каждому показателю нулевая.
 *
 * Отвергнуто: закрывать вместо неё соседку. Вычитать после этого тоже
 * нечем, но горстку приносит в отчёт именно колонка с малой разностью —
 * это её люди, которых у соседки нет. Закрыв соседку, мы убрали бы ту, что
 * не принесла ни одного лишнего человека: «Усі» рядом с «Чоловіки 25–45»
 * закрываются сами, а срез, ради которого модель и собрали, остаётся.
 *
 * Чего правило не закрывает: разность между РАЗНЫМИ расчётами. Чтобы
 * закрыть и её, пришлось бы помнить каждый выданный сотруднику отчёт и
 * сверять с ним новые — хранилище прошлых выдач ради защиты, которую
 * сотрудник и так обходит карандашом. Здесь закрыто то, что модель ставит
 * рядом на одном экране; остальное видно в журнале: каждый расчёт пишется
 * с размерами выборок, и подбор фильтров до горстки в нём читается.
 */
function diffUnderFloor(a: Set<string>, b: Set<string>): boolean {
  let n = 0;
  for (const id of a) if (!b.has(id)) n += 1;
  return suppress(n) === null;
}

/** Колонки, закрытые разностью составов: обе, если под порогом обе разности */
function closedByOverlap(samples: Set<string>[]): boolean[] {
  const closed = samples.map(() => false);
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      if (diffUnderFloor(samples[i]!, samples[j]!)) closed[i] = true;
      if (diffUnderFloor(samples[j]!, samples[i]!)) closed[j] = true;
    }
  }
  return closed;
}

/** Показатели колонки по группам шкал — в порядке, в котором их расставили в модели */
function groupBands(bands: StatModelBandIndicator[]): Map<string, StatModelBandIndicator[]> {
  const byScale = new Map<string, StatModelBandIndicator[]>();
  for (const b of bands) {
    const list = byScale.get(b.scaleId) ?? [];
    list.push(b);
    byScale.set(b.scaleId, list);
  }
  return byScale;
}

/** Колонка с уже набранной выборкой: состав нужен до расчёта — по нему считаются разности */
interface Prepared {
  column: StatModelColumn;
  filters: SampleFilters;
  survey: SurveyFull;
  presetTitle: string | null;
  sample: Respondent[];
}

async function computeColumn(prep: Prepared, overlapped: boolean): Promise<StatRunColumn> {
  const { column, filters, survey, presetTitle, sample } = prep;
  const total = sample.length;
  const ids = sample.map((s) => s.responseId);
  /*
   * Колонка меньше порога подавляется целиком: и основание, и всё под ним.
   * Ноль показывается — «никого нет» не выдаёт никого, а спрятанный ноль
   * заставляет думать, что там кто-то есть. Закрытая разностью составов
   * подавляется так же: показанное основание с нулями под ним отдало бы
   * ровно то, ради чего её закрыли.
   */
  const reason: StatSuppressReason | null =
    total > 0 && !canBreakDown(total) ? "small" : overlapped ? "overlap" : null;
  const open = reason === null;

  const scaleById = new Map(survey.scales.map((s) => [s.id, s]));
  const questionById = new Map(survey.questions.map((q) => [q.id, q]));

  /* полоса каждого прохождения по каждой шкале — по итоговому значению,
     как в scoring.ts: ненормированный результат ни в одну полосу не ложится */
  const bandHits = new Map<string, Set<string>>();
  if (open && ids.length && column.bands.length) {
    const scoreRows = await db
      .select({
        responseId: responseScores.responseId,
        scaleId: responseScores.scaleId,
        value: responseScores.value,
        normalized: responseScores.normalized,
      })
      .from(responseScores)
      .where(inArray(responseScores.responseId, ids));
    for (const s of scoreRows) {
      if (!s.normalized) continue;
      const scale = scaleById.get(s.scaleId);
      const band = scale?.bands.find((b) => s.value >= b.minScore && s.value <= b.maxScore);
      if (!band) continue;
      const hits = bandHits.get(band.id) ?? new Set<string>();
      hits.add(s.responseId);
      bandHits.set(band.id, hits);
    }
  }

  const chosen = new Map<string, Map<string, string[]>>();
  if (open && ids.length && column.questions.length) {
    const answerRows = await db
      .select({ responseId: answers.responseId, questionId: answers.questionId, optionIds: answers.optionIds })
      .from(answers)
      .where(
        and(
          inArray(answers.responseId, ids),
          inArray(
            answers.questionId,
            column.questions.map((q) => q.questionId),
          ),
        ),
      );
    for (const a of answerRows) {
      const byResponse = chosen.get(a.questionId) ?? new Map<string, string[]>();
      byResponse.set(a.responseId, a.optionIds ?? []);
      chosen.set(a.questionId, byResponse);
    }
  }

  const riskHits = new Set<string>();
  let riskMarked = false;
  /* скрыта группа с помеченной ячейкой — «ВШР» скрывается вместе с ней, см. riskCell */
  let riskHidden = false;
  /* сумма помеченных ячеек: больше объединения ровно на число попавших в несколько */
  let riskMarkedSum = 0;

  const scales: StatRunScale[] = [];
  for (const [scaleId, indicators] of groupBands(column.bands)) {
    const scale = scaleById.get(scaleId);
    if (!scale) badRequest("err.statModelIndicatorUnknown", { what: scaleId });
    const parts = indicators.map((ind) => ({ key: ind.bandId, n: bandHits.get(ind.bandId)?.size ?? 0 }));
    const rest = total - parts.reduce((sum, p) => sum + p.n, 0);
    /* полосы одной шкалы не пересекаются: они с остатком — разбиение, порог с одного края */
    const cells = open ? groupCells(parts, rest, total, false) : null;
    scales.push({
      scaleId,
      scaleCode: scale.code,
      scaleTitle: scale.title,
      bands: indicators.map((ind) => {
        const band = scale.bands.find((b) => b.id === ind.bandId);
        if (!band) badRequest("err.statModelIndicatorUnknown", { what: `${scale.title} → ${ind.bandId}` });
        const cell = cells?.get(ind.bandId) ?? HIDDEN;
        if (ind.highRisk) {
          riskMarked = true;
          if (cell.suppressed) riskHidden = true;
          const hits = bandHits.get(ind.bandId) ?? new Set<string>();
          riskMarkedSum += hits.size;
          for (const id of hits) riskHits.add(id);
        }
        return {
          scaleId,
          scaleCode: scale.code,
          scaleTitle: scale.title,
          bandId: band.id,
          label: band.label,
          severity: band.severity,
          highRisk: ind.highRisk,
          cell,
        };
      }),
      rest: cells?.get("__rest") ?? HIDDEN,
    });
  }

  const questionsOut: StatRunQuestion[] = [];
  for (const q of column.questions) {
    const question = questionById.get(q.questionId);
    if (!question) badRequest("err.statModelIndicatorUnknown", { what: q.questionId });
    const byResponse = chosen.get(q.questionId) ?? new Map<string, string[]>();
    const shownIds = new Set(q.options.map((o) => o.optionId));
    const counts = new Map<string, number>();
    let rest = 0;
    for (const id of ids) {
      const picked = byResponse.get(id) ?? [];
      /*
       * Один ответ — один выбор: у single/yesno берётся первый вариант, и
       * человек ложится ровно в одну ячейку разбиения. У multiple каждый
       * выбранный вариант считается отдельно, и разбиения нет — отсюда
       * разные правила подавления ниже.
       */
      const hits = question.type === "multiple" ? picked.filter((o) => shownIds.has(o)) : picked.slice(0, 1).filter((o) => shownIds.has(o));
      if (!hits.length) rest += 1;
      for (const o of hits) counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    const parts = q.options.map((o) => ({ key: o.optionId, n: counts.get(o.optionId) ?? 0 }));
    /*
     * У multiple варианты — множества, а остаток — дополнение их объединения:
     * порог с обоих краёв у каждой ячейки. У single/yesno это разбиение, и
     * края второй ячейке дают соседи по группе.
     */
    const sets = question.type === "multiple";
    const cells = open ? groupCells(parts, rest, total, sets) : null;
    const cellOf = (key: string) => cells?.get(key) ?? HIDDEN;
    questionsOut.push({
      questionId: question.id,
      title: question.title,
      type: question.type,
      options: q.options.map((o) => {
        const option = question.options.find((x) => x.id === o.optionId);
        if (!option) badRequest("err.statModelIndicatorUnknown", { what: `${question.title} → ${o.optionId}` });
        const cell = cellOf(o.optionId);
        if (o.highRisk) {
          riskMarked = true;
          if (cell.suppressed) riskHidden = true;
          riskMarkedSum += counts.get(o.optionId) ?? 0;
          for (const [id, picked] of byResponse) if (picked.includes(o.optionId)) riskHits.add(id);
        }
        return { optionId: option.id, text: option.text, highRisk: o.highRisk, cell };
      }),
      rest: cellOf(REST),
    });
  }

  return {
    title: column.title,
    presetId: column.presetId,
    presetTitle,
    filters,
    surveyId: survey.id,
    surveyTitle: survey.title,
    versionId: column.versionId,
    versionNumber: survey.versionNumber,
    respondents: open ? shown(total, total) : HIDDEN,
    suppressedReason: reason,
    scales,
    questions: questionsOut,
    /*
     * Сам факт «ВШР скрыт» ничего не выдаёт: какие помеченные ячейки и группы
     * спрятаны, видно в той же колонке, а от подавления с обоих краёв порога
     * этот случай неотличим. Правила — в riskCell.
     */
    highRisk: riskMarked ? (open ? riskCell(riskHits.size, riskMarkedSum, riskHidden, total) : HIDDEN) : null,
  };
}

/**
 * Расчёт по колонкам — сохранённым или только что собранным.
 *
 * Зона ответственности проверяется заново при каждом расчёте, а не
 * доверяется сохранённой модели: методику могли перевести в другую группу,
 * группу пациентов — передать, стекло — закрыть. Модель хранит вопрос, а
 * не право на ответ.
 *
 * Размеры выборок возвращаются отдельно и без подавления — для журнала:
 * подбор фильтров, пока выборка не сожмётся до одного, должен быть виден
 * при разборе, как у cohort.preview.
 *
 * Выборки набираются ВСЕ до расчёта хоть одной: подавление колонки зависит
 * не только от неё самой, но и от соседних — колонка, отличающаяся от
 * соседней горсткой людей, закрывается целиком (closedByOverlap). Считать
 * колонку сразу, как прежде, значило бы отдать её числа до того, как стало
 * известно, с чем их сравнят.
 */
export async function runColumns(
  user: User,
  columns: StatModelColumn[],
  lang: Lang,
): Promise<{ columns: StatRunColumn[]; sizes: number[] }> {
  const prepared: Prepared[] = [];
  for (const column of columns) {
    await assertSurveyAccess(user, column.surveyId);
    let filters: SampleFilters = column.filters ?? {};
    let presetTitle: string | null = null;
    if (column.presetId) {
      const preset = await assertFilterPresetAccess(user, column.presetId);
      filters = preset.criteria;
      presetTitle = preset.title;
    }
    await assertFilterRefs(user, filters);

    const survey = await getSurvey(column.surveyId, column.versionId, lang);
    if (!survey) notFound("err.surveyNotFound");

    prepared.push({ column, filters, survey, presetTitle, sample: await sampleOf(column, filters) });
  }

  /*
   * Состав — по людям, а не по прохождениям: колонки могут стоять на разных
   * методиках и версиях, а разностью читатель описывает людей.
   */
  const closed = closedByOverlap(prepared.map((p) => new Set(p.sample.map((s) => s.userId))));
  const out: StatRunColumn[] = [];
  for (const [i, prep] of prepared.entries()) out.push(await computeColumn(prep, closed[i] ?? false));
  return { columns: out, sizes: prepared.map((p) => p.sample.length) };
}
