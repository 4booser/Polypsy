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
  type SurveyFull,
  type User,
} from "@quizzy/shared";
import { db } from "../db";
import { answers, responseScores, responses, surveyVersions, surveys, users } from "../db/schema";
import { decryptField } from "./crypto";
import { badRequest, notFound } from "./http";
import { canBreakDown, suppress, suppressedKeys } from "./privacy";
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

/**
 * Ячейки разбиения, которое в сумме даёт основание: полосы одной шкалы и
 * остаток, варианты одного ответа и остаток. Остаток — честная ячейка, а
 * не то, что читатель вычислит сам: иначе порог его не защитил бы. Что
 * скрывать, решает suppressedKeys — единственная скрытая ячейка тянет за
 * собой соседнюю, и скрытое перестаёт восстанавливаться вычитанием.
 */
function partitionCells<K>(parts: { key: K; n: number }[], total: number): Map<K, StatCell> {
  const hidden = suppressedKeys(parts);
  return new Map(parts.map((p) => [p.key, hidden.has(p.key) ? HIDDEN : shown(p.n, total)]));
}

/**
 * Ячейка, у которой ровно одно дополнение — «все остальные». Прячется с
 * обоих краёв: «четверо из пяти» называет пятого так же точно, как «один
 * из пяти». Так считаются ответы с несколькими вариантами (каждый вариант
 * — своё «выбрал / не выбрал») и попадания в «ВШР».
 */
function twoSidedCell(n: number, total: number): StatCell {
  return suppress(n) === null || suppress(total - n) === null ? HIDDEN : shown(n, total);
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

async function computeColumn(
  column: StatModelColumn,
  filters: SampleFilters,
  survey: SurveyFull,
  presetTitle: string | null,
): Promise<{ column: StatRunColumn; size: number }> {
  const sample = await sampleOf(column, filters);
  const total = sample.length;
  const ids = sample.map((s) => s.responseId);
  /*
   * Колонка меньше порога подавляется целиком: и основание, и всё под ним.
   * Ноль показывается — «никого нет» не выдаёт никого, а спрятанный ноль
   * заставляет думать, что там кто-то есть.
   */
  const open = total === 0 || canBreakDown(total);

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
  /* хоть одна помеченная «ВШР» ячейка скрыта — «ВШР» скрывается вместе с ней, см. сборку колонки внизу */
  let riskHidden = false;

  const scales: StatRunScale[] = [];
  for (const [scaleId, indicators] of groupBands(column.bands)) {
    const scale = scaleById.get(scaleId);
    if (!scale) badRequest("err.statModelIndicatorUnknown", { what: scaleId });
    const parts = indicators.map((ind) => ({ key: ind.bandId, n: bandHits.get(ind.bandId)?.size ?? 0 }));
    const rest = total - parts.reduce((sum, p) => sum + p.n, 0);
    const cells = open ? partitionCells([...parts, { key: "__rest", n: rest }], total) : null;
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
          for (const id of bandHits.get(ind.bandId) ?? []) riskHits.add(id);
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
    let cellOf: (key: string, n: number) => StatCell;
    if (!open) cellOf = () => HIDDEN;
    else if (question.type === "multiple") cellOf = (_key, n) => twoSidedCell(n, total);
    else {
      const cells = partitionCells([...parts, { key: "__rest", n: rest }], total);
      cellOf = (key) => cells.get(key) ?? HIDDEN;
    }
    questionsOut.push({
      questionId: question.id,
      title: question.title,
      type: question.type,
      options: q.options.map((o) => {
        const option = question.options.find((x) => x.id === o.optionId);
        if (!option) badRequest("err.statModelIndicatorUnknown", { what: `${question.title} → ${o.optionId}` });
        const cell = cellOf(o.optionId, counts.get(o.optionId) ?? 0);
        if (o.highRisk) {
          riskMarked = true;
          if (cell.suppressed) riskHidden = true;
          for (const [id, picked] of byResponse) if (picked.includes(o.optionId)) riskHits.add(id);
        }
        return { optionId: option.id, text: option.text, highRisk: o.highRisk, cell };
      }),
      rest: cellOf("__rest", rest),
    });
  }

  return {
    size: total,
    column: {
      title: column.title,
      presetId: column.presetId,
      presetTitle,
      filters,
      surveyId: survey.id,
      surveyTitle: survey.title,
      versionId: column.versionId,
      versionNumber: survey.versionNumber,
      respondents: open ? shown(total, total) : HIDDEN,
      scales,
      questions: questionsOut,
      /*
       * «ВШР» — объединение помеченных ячеек, а полосы одной шкалы и варианты
       * одного выбора не пересекаются, так что внутри разбиения это их сумма.
       * Показанная сумма поверх скрытого слагаемого называет его: двенадцать
       * человек 5/2/5, помечены «Низький» и «Середній» — «Середній» спрятан
       * вместе с остатком, а «ВШР: 7» отдаёт его как 7 − 5. Дополняющее
       * подавление этого не видит: оно живёт внутри разбиения, а «ВШР» стоит
       * поверх всех разбиений колонки.
       *
       * Поэтому «ВШР» показывается, только когда показана КАЖДАЯ помеченная
       * ячейка: тогда все его слагаемые уже напечатаны, и он сообщает лишь,
       * насколько помеченные множества пересекаются, — ни одна скрытая ячейка,
       * помеченная или нет, остаток включая, в него не входит. То же для
       * ответов с несколькими вариантами: разбиения у них нет, но «ВШР» над
       * скрытым помеченным вариантом и показанным соседним отдаёт число
       * выбравших первый без второго. Сам факт «ВШР скрыт» ничего не выдаёт:
       * какие помеченные ячейки спрятаны, видно в той же колонке, а от
       * подавления с обоих краёв порога этот случай неотличим.
       *
       * Отвергнуто: подать «ВШР» в suppressedKeys вместе с ячейками разбиения.
       * Он не слагаемое разбиения, а сумма поверх него — при пометках в разных
       * шкалах и вопросах и вовсе объединение, — так что suppressedKeys,
       * получив «7» как ещё одну ячейку, спрятал бы, как и прежде, «Середній»
       * с остатком и оставил бы «7» на виду. Честная версия того же — прятать
       * ДОПОЛНИТЕЛЬНЫЕ ячейки таблицы ради сводного числа — жертвует главным
       * ради производного. Не спасает и случай «помечены все полосы шкалы,
       * «ВШР» равен основанию без остатка»: при скрытом остатке он его
       * восстанавливает, при показанном — читатель вычисляет его и без нас,
       * и спрятать его ничего не стоит.
       */
      highRisk: riskMarked ? (open && !riskHidden ? twoSidedCell(riskHits.size, total) : HIDDEN) : null,
    },
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
 */
export async function runColumns(
  user: User,
  columns: StatModelColumn[],
  lang: Lang,
): Promise<{ columns: StatRunColumn[]; sizes: number[] }> {
  const out: StatRunColumn[] = [];
  const sizes: number[] = [];
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

    const { column: result, size } = await computeColumn(column, filters, survey, presetTitle);
    out.push(result);
    sizes.push(size);
  }
  return { columns: out, sizes };
}
