import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  ageAt,
  renderError,
  type Lang,
  type SampleFilters,
  type StatCell,
  type StatModelBandIndicator,
  type StatModelColumn,
  type StatModelColumnInput,
  type StatRunBand,
  type StatRunColumn,
  type StatRunOption,
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
import { canBreakDown, pinnedAreas, suppress, type Published } from "./privacy";
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
 * ═══ Проверка вместо правил ═══
 *
 * Ячейки отчёта — не отдельные числа, а система уравнений, и три этажа
 * правил («прячь группу целиком», «прячь ВШР поверх скрытой группы»,
 * «закрывай колонку при малой разности составов») эту систему проигрывали:
 * каждое правило закрывало свой случай и открывало следующий. Разбор обеих
 * пробитых защит — в самой проверке (lib/privacy.ts, pinnedAreas).
 *
 * Теперь здесь не правила, а цикл: посчитать всё → решить систему всего
 * ответа → если хоть одна область людей восстановима, спрятать ещё одно
 * число → решить заново. В пределе печатаются одни основания; если и они
 * называют людей, колонка закрывается целиком с причиной, и причина едет
 * на экран готовой фразой, а не молчанием.
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
 * Сколько чисел колонка печатает самое большее — основание, ячейки и «ВШР»
 * вместе.
 *
 * Потолок не украшение: проверка восстановимости решает систему на каждый
 * расчёт, а её цена растёт с числом уравнений. Шестнадцать — это основание,
 * шкала из пяти полос с остатком, два вопроса по три варианта с остатком и
 * «ВШР»: колонка кадра f29 целиком. Что сверх — считается (без этого не
 * узнать, безопасно ли остальное), но не печатается, и колонка честно
 * говорит, сколько строк убрано.
 *
 * Отвергнуто: отказывать в расчёте при семнадцатом показателе. Модель
 * собирают мышью, и отказ на семнадцатом клике — это потерянная работа
 * там, где достаточно не напечатать лишнюю строку.
 */
const MAX_FIGURES_PER_COLUMN = 16;

/**
 * Сколько чисел цикл пробует спрятать на одном шаге.
 *
 * Шаг ищет лучшее сокрытие перебором: каждое «а если убрать вот это»
 * решает систему заново, и без потолка восемь колонок по шестнадцать чисел
 * дают сто двадцать восемь решений на шаг. Тридцать два — это все числа
 * двух колонок сразу, а больше двух колонок в одной названной области не
 * встречалось ни в одном разборе.
 *
 * Отвергнуто: перебирать только числа, накрывающие названную область. Они
 * бессильны там, где освобождает СОСЕДНЕЕ число: |Біль ∖ Шум| лежит внутри
 * «Біль», а отпускает его сокрытие «решти». Поэтому не сужение набора, а
 * порядок: накрывающие пробуются первыми, потолок отсекает хвост.
 */
const MAX_TRIALS_PER_STEP = 32;

/**
 * Печатаемое число отчёта: где стоит и КТО в него попал.
 *
 * Состав по людям, а не по прохождениям: колонки бывают на разных
 * методиках и версиях, а восстанавливает читатель людей. Состав нужен
 * целиком, потому что проверка строит области сама — по тому, какие числа
 * накрывают одного и того же человека (lib/privacy.ts, pinnedAreas).
 */
interface Figure {
  key: string;
  column: number;
  /** Основание колонки: его сокрытие закрывает колонку целиком */
  base: boolean;
  members: Set<string>;
}

/** Колонка, посчитанная до подавления: числа и способ собрать по ним отчёт */
interface Sheet {
  index: number;
  total: number;
  figures: Figure[];
  render(kept: ReadonlySet<string>, reason: StatSuppressReason | null, lang: Lang): StatRunColumn;
}

/**
 * Система одного расчёта: ВСЕ показанные числа ответа разом.
 *
 * Не по колонке. Утечка «Усі» = «Велике» ⊎ «Мале» собирается из ТРЁХ
 * колонок одного ответа: малая колонка показывает своё основание, прячет
 * ячейку — и та читается вычитанием двух показанных соседок. Проверка по
 * колонке не видит этого в принципе, сколько правил в неё ни добавляй.
 * Основания соседок и связывают составы выборок: пересечения колонок
 * становятся областями сами, без отдельного правила о разности составов.
 *
 * Не по показателю. «Високий: 6» и «Шум: 8» при «ВШР: 13» называют того
 * единственного, кто попал в оба, — а это разные разрезы одной колонки, и
 * порознь ни один из них ничего не называет.
 *
 * Отвергнуто: держать рядом с общей системой ещё и системы помельче — по
 * показателю и по «ВШР». В них области КРУПНЕЕ (числа не различают людей,
 * которых различают другие разрезы), и когда-то это ловило горстку,
 * размазанную по нескольким мелким областям. С тех пор перебор объединений
 * в pinnedAreas стал полным — глубже порога заходить незачем, — и мелкие
 * системы перестали находить хоть что-нибудь сверх общей: мутация «убрать
 * их» не роняла ни одной проверки. Лишний этаж защиты, который ничего не
 * защищает, — это лишний этаж, который однажды соврут.
 */
function systemOf(sheets: Sheet[], kept: ReadonlySet<string>): Published[] {
  return sheets
    .flatMap((s) => s.figures)
    .filter((f) => kept.has(f.key))
    .map((f) => ({ key: f.key, members: f.members }));
}

/**
 * Первый набросок: что колонка напечатала бы, будь она одна.
 *
 * Одно правило и один потолок, оба — про отдельное число, а не про систему:
 * число от единицы до порога называет людей прямо, без всякого вычитания, а
 * больше MAX_FIGURES_PER_COLUMN чисел колонка не печатает. Всё остальное
 * решает проверка ниже.
 *
 * Отвергнуто: держать здесь и второй край порога («10 з 12» называет двоих
 * не хуже, чем «2 з 12»). Он был нужен, пока проверка смотрела на ячейки; с
 * полным перебором объединений дополнение любого числа — либо область, либо
 * сумма меньше чем порог областей, и проверка находит его сама. Мутация
 * «снять второй край» не роняла ни одной проверки — значит, это была не
 * защита, а её повторение.
 */
function draft(sheets: Sheet[], closed: ReadonlyMap<number, StatSuppressReason>): Set<string> {
  const kept = new Set<string>();
  for (const sheet of sheets) {
    if (closed.has(sheet.index)) continue;
    let printed = 0;
    for (const f of sheet.figures) {
      if (f.members.size > 0 && suppress(f.members.size) === null) continue;
      if (printed >= MAX_FIGURES_PER_COLUMN) break;
      kept.add(f.key);
      printed += 1;
    }
  }
  return kept;
}

/**
 * Подавление как цикл: посчитал — проверил — спрятал ещё одно — проверил
 * заново.
 *
 * Что прячем первым: число, чьё сокрытие снимает больше всего названных
 * областей; при равенстве — наименьшее показанное. Наименьшее, потому что
 * теряется меньше всего: у маленькой ячейки и доверительный интервал шире,
 * и выводов по ней меньше. Важнее другое: выбор идёт по тому, сколько
 * однозначностей снимается, то есть по всей системе, а не по величине
 * числа, — поэтому читатель, знающий правило, не сужает им скрытое так, как
 * сужал бы пару из suppressedKeys (lib/privacy.ts). И «скрыто» больше не
 * значит «меньше порога»: цикл прячет и большие числа тоже.
 *
 * Когда прятать больше нечего, а области всё ещё называются, — закрывается
 * колонка целиком, и это единственное место, где колонка закрывается не
 * из-за собственного размера.
 *
 * Цикл сходится: каждый шаг либо убирает число, либо закрывает колонку, и
 * ни то ни другое не возвращается. В пределе печатаются одни основания, а
 * если и они восстанавливают людей — не печатается ничего.
 */
function keepSafe(sheets: Sheet[], closed: Map<number, StatSuppressReason>): Set<string> {
  const byKey = new Map(sheets.flatMap((s) => s.figures).map((f) => [f.key, f] as const));
  /*
   * Потолок шагов. Шаг либо убирает число, либо закрывает колонку; после
   * закрытия набросок собирается заново, и прятать приходится сызнова —
   * отсюда произведение, а не сумма. До потолка цикл не доходит никогда, но
   * «никогда» в защите приватности пишется кодом, а не комментарием: за ним
   * закрываются все колонки, и печатать становится нечего.
   */
  const steps = sheets.reduce((n, s) => n + s.figures.length, 0) * (sheets.length + 1) + sheets.length;
  let kept = draft(sheets, closed);

  /* какие области называет отчёт, если печатать ровно эти числа */
  const solve = (set: ReadonlySet<string>) => pinnedAreas(systemOf(sheets, set));

  for (let step = 0; step <= steps; step += 1) {
    const found = solve(kept);
    if (!found.length) return kept;
    const covers = new Set(found.flatMap((a) => a.inside));

    /*
     * Прячется число, снимающее больше всего названных областей; при
     * равенстве — наименьшее показанное. Ноль в кандидаты не идёт: под ним
     * нет ни одного человека, и его сокрытие не уносит с собой ничего.
     *
     * Шаг, не снимающий НИ ОДНОЙ области, тоже делается — и это не
     * придирка. Колонка «Усі» рядом со своей группой из шести называет
     * четверых «що чують шум і не в групі», и снять это одним числом
     * нельзя: нужно убрать и «Шум», и остаток. Требуй мы улучшения на
     * каждом шаге — закрывалась бы вся колонка там, где хватает трёх
     * строк. Цикл всё равно конечен: кандидаты каждый раз убывают.
     */
    let best: Figure | null = null;
    let bestLeft = Number.POSITIVE_INFINITY;
    const candidates = [...kept]
      .map((key) => byKey.get(key))
      .filter((f): f is Figure => !!f && !f.base && f.members.size > 0)
      /* сперва накрывающие названную область, потом по возрастанию — на них потолок и тратится */
      .sort((a, b) => Number(covers.has(b.key)) - Number(covers.has(a.key)) || a.members.size - b.members.size)
      .slice(0, MAX_TRIALS_PER_STEP);
    for (const f of candidates) {
      const trial = new Set(kept);
      trial.delete(f.key);
      const left = solve(trial).length;
      if (!best || left < bestLeft || (left === bestLeft && f.members.size < best.members.size)) {
        best = f;
        bestLeft = left;
      }
    }
    if (best) {
      kept.delete(best.key);
      continue;
    }

    /*
     * Закрывается та колонка, после которой отчёт остаётся самым полным:
     * меньше всего названных областей, потом — больше всего напечатанных
     * чисел, потом — меньшая выборка. Отвергнуто закрывать ту, чьи люди
     * названы: в «Усі» рядом с «Велике» и «Мале» названы люди «Малої», но
     * закрыть по этому правилу пришлось бы и «Усі» — единственную колонку,
     * которая в одиночку безопасна и ради которой отчёт открывали.
     */
    let victim: Sheet | null = null;
    let score: number[] = [];
    for (const sheet of sheets) {
      if (closed.has(sheet.index)) continue;
      const trial = draft(sheets, new Map([...closed, [sheet.index, "recoverable" as const]]));
      /* чем меньше по порядку, тем лучше: названных областей, потом −числа строк, потом размер выборки */
      const mark = [solve(trial).length, -trial.size, sheet.total];
      const at = mark.findIndex((v, i) => v !== score[i]);
      if (victim && (at < 0 || mark[at]! > score[at]!)) continue;
      victim = sheet;
      score = mark;
    }
    if (!victim) break;
    closed.set(victim.index, "recoverable");
    kept = draft(sheets, closed);
  }

  for (const sheet of sheets) if (!closed.has(sheet.index)) closed.set(sheet.index, "recoverable");
  return new Set();
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

/** Колонка с уже набранной выборкой: состав нужен до расчёта — по нему считаются области */
interface Prepared {
  column: StatModelColumn;
  filters: SampleFilters;
  survey: SurveyFull;
  presetTitle: string | null;
  sample: Respondent[];
}

/**
 * Счёт колонки до всякого подавления.
 *
 * Считается ВСЁ и всегда, даже у колонки, которую закроют: подавление
 * зависит от соседок, и решить, что печатать, можно только когда посчитаны
 * все. Прежде расчёт пропускался при `open === false` — и это была не
 * экономия, а причина, по которой колонку нельзя было переоценить, узнав о
 * соседках.
 *
 * Состав каждой ячейки хранится людьми, а не числом: проверка строит
 * области по пересечениям составов, и «пятеро» в двух колонках — это либо
 * одни и те же пятеро, либо разные, и системы получаются разные.
 */
async function measureColumn(prep: Prepared, index: number): Promise<Sheet> {
  const { column, filters, survey, presetTitle, sample } = prep;
  const total = sample.length;
  const ids = sample.map((s) => s.responseId);
  const userOf = new Map(sample.map((s) => [s.responseId, s.userId]));
  const everyone = new Set(sample.map((s) => s.userId));

  const scaleById = new Map(survey.scales.map((s) => [s.id, s]));
  const questionById = new Map(survey.questions.map((q) => [q.id, q]));

  /* полоса каждого прохождения по каждой шкале — по итоговому значению,
     как в scoring.ts: ненормированный результат ни в одну полосу не ложится */
  const bandHits = new Map<string, Set<string>>();
  if (ids.length && column.bands.length) {
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
      const userId = userOf.get(s.responseId);
      if (!band || !userId) continue;
      const hits = bandHits.get(band.id) ?? new Set<string>();
      hits.add(userId);
      bandHits.set(band.id, hits);
    }
  }

  const chosen = new Map<string, Map<string, string[]>>();
  if (ids.length && column.questions.length) {
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
      const userId = userOf.get(a.responseId);
      if (!userId) continue;
      const byUser = chosen.get(a.questionId) ?? new Map<string, string[]>();
      byUser.set(userId, a.optionIds ?? []);
      chosen.set(a.questionId, byUser);
    }
  }

  const figures: Figure[] = [];
  const baseKey = `k${index}:base`;
  figures.push({ key: baseKey, column: index, base: true, members: everyone });

  const riskHits = new Set<string>();
  let riskMarked = false;
  let seq = 0;
  const addFigure = (members: Set<string>): string => {
    seq += 1;
    const key = `k${index}:n${seq}`;
    figures.push({ key, column: index, base: false, members });
    return key;
  };

  type ScalePart = {
    head: Omit<StatRunScale, "bands" | "rest">;
    bands: { head: Omit<StatRunBand, "cell">; key: string }[];
    restKey: string;
  };
  const scaleParts: ScalePart[] = [];
  for (const [scaleId, indicators] of groupBands(column.bands)) {
    const scale = scaleById.get(scaleId);
    if (!scale) badRequest("err.statModelIndicatorUnknown", { what: scaleId });
    const head = { scaleId, scaleCode: scale.code, scaleTitle: scale.title };
    const covered = new Set<string>();
    const bands = indicators.map((ind) => {
      const band = scale.bands.find((b) => b.id === ind.bandId);
      if (!band) badRequest("err.statModelIndicatorUnknown", { what: `${scale.title} → ${ind.bandId}` });
      const hits = bandHits.get(ind.bandId) ?? new Set<string>();
      for (const id of hits) covered.add(id);
      if (ind.highRisk) {
        riskMarked = true;
        for (const id of hits) riskHits.add(id);
      }
      return {
        head: { ...head, bandId: band.id, label: band.label, severity: band.severity, highRisk: ind.highRisk },
        key: addFigure(hits),
      };
    });
    const rest = new Set([...everyone].filter((id) => !covered.has(id)));
    scaleParts.push({ head, bands, restKey: addFigure(rest) });
  }

  type QuestionPart = {
    head: Omit<StatRunQuestion, "options" | "rest">;
    options: { head: Omit<StatRunOption, "cell">; key: string }[];
    restKey: string;
  };
  const questionParts: QuestionPart[] = [];
  for (const q of column.questions) {
    const question = questionById.get(q.questionId);
    if (!question) badRequest("err.statModelIndicatorUnknown", { what: q.questionId });
    const byUser = chosen.get(q.questionId) ?? new Map<string, string[]>();
    const shownIds = new Set(q.options.map((o) => o.optionId));
    const hitsOf = new Map<string, Set<string>>(q.options.map((o) => [o.optionId, new Set<string>()]));
    const covered = new Set<string>();
    for (const id of everyone) {
      const picked = byUser.get(id) ?? [];
      /*
       * Один ответ — один выбор: у single/yesno берётся первый вариант, и
       * человек ложится ровно в одну ячейку разбиения. У multiple каждый
       * выбранный вариант считается отдельно, и разбиения нет — отсюда и
       * области Венна в проверке, а не одно разбиение с остатком.
       */
      const hits =
        question.type === "multiple"
          ? picked.filter((o) => shownIds.has(o))
          : picked.slice(0, 1).filter((o) => shownIds.has(o));
      for (const o of hits) {
        hitsOf.get(o)!.add(id);
        covered.add(id);
      }
    }
    const options = q.options.map((o) => {
      const option = question.options.find((x) => x.id === o.optionId);
      if (!option) badRequest("err.statModelIndicatorUnknown", { what: `${question.title} → ${o.optionId}` });
      const hits = hitsOf.get(o.optionId)!;
      if (o.highRisk) {
        riskMarked = true;
        for (const id of hits) riskHits.add(id);
      }
      return {
        head: { optionId: option.id, text: option.text, highRisk: o.highRisk },
        key: addFigure(hits),
      };
    });
    const rest = new Set([...everyone].filter((id) => !covered.has(id)));
    questionParts.push({
      head: { questionId: question.id, title: question.title, type: question.type },
      options,
      restKey: addFigure(rest),
    });
  }

  const riskKey = `k${index}:risk`;
  if (riskMarked) figures.push({ key: riskKey, column: index, base: false, members: riskHits });

  const size = new Map(figures.map((f) => [f.key, f.members.size] as const));
  const render = (kept: ReadonlySet<string>, reason: StatSuppressReason | null, lang: Lang): StatRunColumn => {
    const cellOf = (key: string): StatCell => (kept.has(key) ? shown(size.get(key) ?? 0, total) : HIDDEN);
    const hiddenFigures = figures.filter((f) => !kept.has(f.key)).length;
    const note =
      reason === "small"
        ? renderError("err.statColumnSmall", lang)
        : reason === "recoverable"
          ? renderError("err.statColumnClosed", lang)
          : hiddenFigures
            ? renderError("err.statFiguresHidden", lang, { count: hiddenFigures })
            : null;
    return {
      title: column.title,
      presetId: column.presetId,
      presetTitle,
      filters,
      surveyId: survey.id,
      surveyTitle: survey.title,
      versionId: column.versionId,
      versionNumber: survey.versionNumber,
      respondents: cellOf(baseKey),
      suppressedReason: reason,
      note,
      hiddenFigures,
      scales: scaleParts.map((s) => ({
        ...s.head,
        bands: s.bands.map((b) => ({ ...b.head, cell: cellOf(b.key) })),
        rest: cellOf(s.restKey),
      })),
      questions: questionParts.map((q) => ({
        ...q.head,
        options: q.options.map((o) => ({ ...o.head, cell: cellOf(o.key) })),
        rest: cellOf(q.restKey),
      })),
      /*
       * Сам факт «ВШР скрыт» ничего не выдаёт: какие помеченные ячейки и
       * группы спрятаны, видно в той же колонке. Правило у «ВШР» теперь не
       * своё: он такое же число системы, как ячейки, и проверяется вместе
       * с ними — своей системой на колонку и системой из «ВШР» соседок.
       */
      highRisk: riskMarked ? cellOf(riskKey) : null,
    };
  };

  return { index, total, figures, render };
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
 * Считается сначала всё, печатается потом: что колонка может напечатать,
 * решает проверка по ВСЕМУ ответу разом (keepSafe). Считать и отдавать
 * колонку по одной, как было прежде, значило бы отдать её числа до того,
 * как стало известно, с чем их сложат.
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

  const sheets: Sheet[] = [];
  for (const [index, prep] of prepared.entries()) sheets.push(await measureColumn(prep, index));

  /*
   * Колонка меньше порога закрывается до всякой проверки: у неё нет ни
   * одного числа, которое можно напечатать, — и основание тоже. Ноль
   * показывается: «никого нет» не выдаёт никого, а спрятанный ноль
   * заставляет думать, что там кто-то есть.
   */
  const closed = new Map<number, StatSuppressReason>();
  for (const sheet of sheets) if (sheet.total > 0 && !canBreakDown(sheet.total)) closed.set(sheet.index, "small");

  const kept = keepSafe(sheets, closed);
  return {
    columns: sheets.map((sheet) => sheet.render(kept, closed.get(sheet.index) ?? null, lang)),
    sizes: prepared.map((p) => p.sample.length),
  };
}
