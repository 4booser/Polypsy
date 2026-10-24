import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { SurveyFull } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { recordset, systemInIndexOrder } from "../db/latest";
import { responseScores, responses, scales } from "../db/schema";
import { rawSignature, valueSignature } from "./comparable";
import { percentileOf } from "./norms";
import { patientRespondent } from "./population";
import { surveysAtVersions, versionKey } from "./surveys";

/**
 * Референтная выборка для перцентиля — в печатном листе (волна 15, внешний
 * разбор, п. 19), в динамике человека (там же, доработка координатора) и в
 * возрастных кривых норм (волна 18, CR-102: кривая действующей шкалы 0–10
 * показывала медиану 100 из прохождений старой версии 0–100).
 *
 * Перцентиль на листе читается как «этот человек выше стольких-то процентов
 * обследованных здесь», и ради этого одного числа выборка обязана описывать
 * людей, обследованных той же мерой. Прежде она была «все сырые баллы
 * методики с тем же кодом шкалы», и ломалась с четырёх сторон сразу:
 *
 *  1. Версии. Код шкалы переживает правку ключа, а сырой балл — нет: у
 *     ревьюера старая версия 0–100 и новая 0–10 шли одним рядом, и
 *     девяносто старых «100» сдвигали перцентиль нового «5» с 50-го на 5-й.
 *     Теперь в выборку идёт та же версия или версия, где сырой балл шкалы
 *     доказанно считается так же: тот же отпечаток ключа (lib/comparable.ts,
 *     rawSignature — то же правило, что у кандидатных норм) И тот же размах
 *     (max_score строки балла). Размах проверяется отдельно, хотя из ключа
 *     он и следует: строку балла пишет сдача, и если ключ когда-нибудь
 *     посчитают иначе, чем записали, — сравнивать с разным потолком всё
 *     равно нельзя.
 *  2. Достоверность. Протокол, проваленный шкалой лжи, — ровно то, что
 *     выборка описывать не должна: у ревьюера замена примеси на
 *     недостоверные протоколы той же версии перцентиль не меняла вовсе.
 *  3. Единица наблюдения. Человек, пересдавший сорок раз, был сорока
 *     наблюдениями — и перевешивал десяток других. Теперь человек — одно
 *     наблюдение: его ПОСЛЕДНЕЕ достоверное прохождение совместимой версии.
 *     Последнее, а не первое (как у кандидатных норм, lib/normCandidates.ts):
 *     норма описывает человека при первой встрече с методикой, а перцентиль
 *     листа отвечает «где он среди тех, кого здесь обследуют», и у каждого из
 *     них в ответ идёт нынешнее состояние, а не давнишнее. Порог
 *     MIN_NORM_SAMPLE (lib/norms.ts) считается поэтому в людях.
 *  4. Кто. Анонимные прохождения не идут — без человека не посчитать людей;
 *     сотрудник, заполнивший методику на себя, — не обследуемый
 *     (patientRespondent, lib/population.ts).
 *
 * Политика — чистой функцией ниже; база только поставляет наблюдения.
 */

/** Одно прохождение одной шкалы — как оно лежит в базе */
export interface Observation {
  responseId: string;
  userId: string | null;
  versionId: string | null;
  reliable: boolean;
  submittedAt: string | null;
  /**
   * Сравниваемая величина: сырой балл у листа (перцентиль стоит рядом с
   * ним), приведённое значение у динамики (её точка — T, стен или доля)
   */
  value: number;
  /** Размах сырого балла той версии */
  maxScore: number;
  /**
   * Единицы величины: "raw" у сырого балла, нормировка строки балла у
   * приведённого (tscore, sten, ratio, raw)
   */
  unit: string;
}

/**
 * С чем сравнивают: версии, где величина считается так же, её размах и
 * единицы.
 *
 * Единицы проверяются у каждой строки, а не только через версию, по той же
 * причине, что и размах: строку балла пишет сдача, и сравнивать T-балл с
 * долей нельзя, даже если версия по отпечатку совместима.
 */
export interface ReferenceTarget {
  versions: ReadonlySet<string>;
  maxScore: number;
  unit: string;
}

/** Позже ли a, чем b: по времени сдачи, при равенстве — по id, а не порядком строк */
function later(a: Observation, b: Observation): boolean {
  const ta = a.submittedAt ? Date.parse(a.submittedAt) : Number.NEGATIVE_INFINITY;
  const tb = b.submittedAt ? Date.parse(b.submittedAt) : Number.NEGATIVE_INFINITY;
  if (ta !== tb) return ta > tb;
  return a.responseId > b.responseId;
}

/**
 * Выборка: по одному значению на человека.
 *
 * Сначала отбрасывается то, что в выборку не идёт вовсе (анонимное,
 * недостоверное, несовместимая версия, размах или единицы), и только потом у
 * человека берётся последнее из оставшегося. Порядок важен: у человека,
 * чей последний протокол провален шкалой лжи, в выборке остаётся его
 * прежний честный, а не пропадает он целиком — и не входит проваленный.
 */
export function referenceObservations<O extends Observation>(observations: readonly O[], target: ReferenceTarget): O[] {
  const lastOf = new Map<string, O>();
  for (const o of observations) {
    if (!o.userId || !o.reliable || !o.versionId) continue;
    if (!target.versions.has(o.versionId) || o.maxScore !== target.maxScore || o.unit !== target.unit) continue;
    const seen = lastOf.get(o.userId);
    if (!seen || later(o, seen)) lastOf.set(o.userId, o);
  }
  return [...lastOf.values()];
}

export function referenceSample(observations: readonly Observation[], target: ReferenceTarget): number[] {
  return referenceObservations(observations, target).map((o) => o.value);
}

/** Перцентиль по выборке людей; меньше MIN_NORM_SAMPLE человек — null */
export function referencePercentile(value: number, sample: readonly number[]): number | null {
  return percentileOf(value, [...sample]);
}

/** Что сравнивается: балл до нормировки, после поправок (печатный лист) или приведённое значение — T, стен, доля (динамика) */
export type Measure = "raw" | "value";

/** Точка, для которой нужна выборка: версия, шкала, размах сырого балла и единицы */
export interface SampleTarget {
  versionId: string;
  code: string;
  maxScore: number;
  /** "raw" для меры "raw"; для "value" — нормировка балла точки */
  unit: string;
}

/**
 * Выборки одной методики для набора точек — ответ: «выборка для точки».
 *
 * Одно чтение баллов на методику и одно чтение каждой встреченной версии,
 * сколько бы точек ни спросили: динамика человека спрашивает по точке на
 * каждое его прохождение и каждую шкалу.
 *
 * Мера решает, ЧТО сравнивается и какие версии для этого совместимы:
 *  - "raw" — сырой балл; совместимы версии с тем же отпечатком сырого балла
 *    (rawSignature). Так сравнивает печатный лист: перцентиль стоит рядом с
 *    сырым баллом.
 *  - "value" — приведённое значение; совместимы версии, где одинаковы и
 *    сырой балл, и его перевод (valueSignature: нормировка, нормы, стены), и
 *    в выборку идут только строки, где перевод состоялся (normalized):
 *    сырой балл, оставшийся сырым за отсутствием нормы, среди T-баллов — то
 *    же сравнение в двух единицах. Так сравнивает динамика: её точка — T,
 *    стен или доля.
 * Остальное — достоверность, человек как единица, анонимные и сотрудники,
 * размах и порог в людях — одно для обеих мер (referenceSample выше).
 *
 * Системной ролью: выборка — баллы всех обследованных, без людей и дат, и
 * наружу из неё уходит одно число на точку. Под ролью приложения пациент
 * видит только свои прохождения, и перцентиль в его листе пропадал (волна
 * 13); у сотрудника под «разбитым стеклом» выборка была бы ограничена чужой
 * для него методикой так же случайно.
 */
export async function referenceSamples(
  surveyId: string,
  measure: Measure,
  targets: readonly SampleTarget[],
): Promise<(target: SampleTarget) => number[]> {
  return (await referenceSampleSets([{ surveyId, targets }], measure)).get(surveyId) ?? (() => []);
}

/** Методика и её точки — один вопрос к referenceSampleSets */
export interface SampleRequest {
  surveyId: string;
  targets: readonly SampleTarget[];
}

/**
 * referenceSamples для нескольких методик сразу — ответ: «методика → выборка
 * для точки». Политика выборки та же, что выше; разница только в чтении.
 *
 * Динамика человека спрашивает выборку на каждую его методику, и прежде это
 * было по семь обращений к базе на методику: последние прохождения, их
 * баллы, строка методики и роль на каждую версию. На карточке с семью
 * методиками — сорок девять обращений и семь проходов по баллам, и всё это
 * под той же транзакцией, что держит соединение пула (волна 27: 0,9 с на
 * прогретом стенде, 4–23 с на нагруженном). Теперь методики читаются одним
 * запросом (observationSets ниже), а их версии — одним заходом.
 */
export async function referenceSampleSets(
  requests: readonly SampleRequest[],
  measure: Measure,
): Promise<Map<string, (target: SampleTarget) => number[]>> {
  const sets = await observationSets(requests, measure, () => true, REFERENCE_LATEST);
  const out = new Map<string, (target: SampleTarget) => number[]>();
  for (const [surveyId, pick] of sets) out.set(surveyId, (target) => pick(target).map((o) => o.value));
  return out;
}

/**
 * Из скольких последних прохождений методики набирается выборка перцентиля
 * (#188).
 *
 * Прежде — из всех: перцентиль одной точки в динамике и на листе читал
 * баллы всех прохождений методики учреждения, и время росло с каждым чужим
 * прохождением. Пять тысяч прохождений — это люди, обследованные этой
 * методикой в последнее время (по последнему такому прохождению на
 * человека, как и прежде), а перцентиль и отвечает «где он среди тех, кого
 * здесь обследуют»; ошибка перцентиля на таком числе людей — доли пункта.
 * Пока прохождений меньше, выборка та же, что прежде. Возрастные кривые
 * норм (routes/norms.ts) зовут referenceObservationSets без предела: им
 * нужны все наблюдения.
 */
export const REFERENCE_LATEST = 5000;

/**
 * То же, что referenceSamples, но наблюдениями, а не числами: возрастным
 * кривым (routes/norms.ts) к значению нужны возраст и пол прохождения.
 *
 * `keep` — что из прочитанного вообще годится вызывающему (кривой — только
 * прохождения с известным возрастом и полом); отсев идёт ДО выбора
 * последнего прохождения человека, по той же причине, что и отсев
 * недостоверных: у человека, чьё последнее прохождение без возраста, в
 * выборке остаётся прежнее с возрастом, а не пропадает он целиком.
 */
export async function referenceObservationSets(
  surveyId: string,
  measure: Measure,
  targets: readonly SampleTarget[],
  keep: (o: Observation) => boolean = () => true,
  /** Только последние столько прохождений методики (REFERENCE_LATEST); не задано — все */
  latest?: number,
): Promise<(target: SampleTarget) => Observation[]> {
  return (await observationSets([{ surveyId, targets }], measure, keep, latest)).get(surveyId) ?? (() => []);
}

/** Наблюдение, как его отдаёт чтение: с кодом шкалы и методикой */
type CodedObservation = Observation & { surveyId: string; code: string };

/**
 * Выборки нескольких методик: «методика → наблюдения для точки». Методика
 * без кодов или без единого наблюдения отвечает пустой выборкой.
 */
async function observationSets(
  requests: readonly SampleRequest[],
  measure: Measure,
  keep: (o: Observation) => boolean,
  latest: number | undefined,
): Promise<Map<string, (target: SampleTarget) => Observation[]>> {
  const codesOf = new Map<string, string[]>();
  for (const { surveyId, targets } of requests) {
    const codes = new Set([...(codesOf.get(surveyId) ?? []), ...targets.map((t) => t.code)]);
    codesOf.set(surveyId, [...codes]);
  }
  const asked = [...codesOf.entries()].filter(([, codes]) => codes.length);
  const out = new Map<string, (target: SampleTarget) => Observation[]>();
  if (!asked.length) return out;

  /*
   * Наблюдения и отпечатки — одним переключением роли: с пределом — вместе с
   * путём по индексу (systemInIndexOrder), без предела — как прежде, одной
   * ролью (asSystem).
   */
  const load = async () => {
    const rows = await readObservations(asked, measure, latest);
    const rowsOf = new Map<string, CodedObservation[]>();
    for (const r of rows) {
      const list = rowsOf.get(r.surveyId) ?? [];
      list.push(r);
      rowsOf.set(r.surveyId, list);
    }

    /*
     * Отпечатки — у каждой версии, встреченной в выборке или в точках; каждая
     * версия читается один раз, все методики — одним заходом
     * (surveysAtVersions). Версия точки совместима с собой без сравнения, даже
     * если отпечатка у неё нет. Методике без наблюдений отпечатки не нужны:
     * её выборка пуста при любой совместимости.
     */
    const versionsOf = new Map<string, Set<string>>();
    for (const [surveyId] of asked) {
      const own = rowsOf.get(surveyId);
      if (!own?.length) continue;
      versionsOf.set(
        surveyId,
        new Set([
          ...own.map((r) => r.versionId).filter((v): v is string => !!v),
          ...requests.filter((q) => q.surveyId === surveyId).flatMap((q) => q.targets.map((t) => t.versionId)),
        ]),
      );
    }
    const fulls = await surveysAtVersions(
      [...versionsOf.entries()].flatMap(([surveyId, versions]) =>
        [...versions].map((versionId) => ({ surveyId, versionId })),
      ),
      "uk",
    );
    return { rowsOf, versionsOf, fulls };
  };
  const { rowsOf, versionsOf, fulls } = await (latest === undefined ? asSystem(load) : systemInIndexOrder(load));

  const signatureOf = measure === "raw" ? rawSignature : valueSignature;
  for (const [surveyId, codes] of asked) {
    const versions = versionsOf.get(surveyId);
    if (!versions) {
      out.set(surveyId, () => []);
      continue;
    }
    const signatures = new Map<string, Map<string, string | null>>();
    for (const versionId of versions) {
      const full = fulls.get(versionKey(surveyId, versionId)) ?? null;
      signatures.set(versionId, new Map(codes.map((code) => [code, full ? signatureOf(full, code) : null])));
    }
    out.set(surveyId, pickerOf(rowsOf.get(surveyId) ?? [], signatures, keep));
  }
  return out;
}

/** Выборка для точки — по прочитанным наблюдениям одной методики и отпечаткам её версий */
function pickerOf(
  rows: readonly CodedObservation[],
  signatures: Map<string, Map<string, string | null>>,
  keep: (o: Observation) => boolean,
): (target: SampleTarget) => Observation[] {
  const byCode = new Map<string, Observation[]>();
  for (const r of rows) {
    if (!keep(r)) continue;
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }

  const memo = new Map<string, Observation[]>();
  return (target) => {
    const key = `${target.versionId}:${target.code}:${target.maxScore}:${target.unit}`;
    const known = memo.get(key);
    if (known) return known;
    const mine = signatures.get(target.versionId)?.get(target.code) ?? null;
    const versions = new Set([target.versionId]);
    if (mine !== null) {
      for (const [versionId, byVersion] of signatures) if (byVersion.get(target.code) === mine) versions.add(versionId);
    }
    const sample = referenceObservations(byCode.get(target.code) ?? [], {
      versions,
      maxScore: target.maxScore,
      unit: target.unit,
    });
    memo.set(key, sample);
    return sample;
  };
}

/*
 * «Не сотрудник» — подзапросом без отсылки к строке. patientRespondent
 * (lib/population.ts) пишет то же самое через NOT EXISTS, и внутри LATERAL
 * планировщик исполнял его пробой индекса людей на каждое прохождение:
 * 28 тыс. проб и 85 тыс. обращений к буферам на семь методик одного
 * человека, треть всего чтения. NOT IN по множеству сотрудников — один
 * проход по людям и хэш. Равносильно здесь, и только здесь: users.id —
 * первичный ключ (NULL в подзапросе нет), а user_id выборки уже отсечён
 * «is not null» (для NULL NOT IN дал бы «неизвестно», а NOT EXISTS — «да»).
 */
const notStaff = (alias: string) =>
  sql`${sql.raw(alias)}.user_id not in (select staff_u.id from users staff_u where staff_u.role <> 'user')`;

/**
 * Наблюдения — баллы шкал с нужными кодами у достоверных прохождений
 * обследуемых. Роль — системную — ставит вызывающий (observationSets,
 * см. referenceSamples), с пределом — и путь по индексу.
 *
 * С пределом (`latest`) — одним запросом на все методики: последние
 * прохождения каждой — LATERAL по индексу (survey_id, submitted_at) путём
 * по порядку (db/latest.ts), и баллы к ним — в том же запросе. Прежде это
 * были два запроса на методику: список id последних прохождений и затем
 * баллы «где id в списке» — пять тысяч id туда и обратно и второй проход по
 * тем же прохождениям ради условий, уже проверенных первым. Условия отбора
 * — те же, что прежде, и у списка, и у баллов.
 *
 * Без предела (возрастные кривые) — как прежде: все прохождения методики.
 */
async function readObservations(
  asked: readonly [surveyId: string, codes: string[]][],
  measure: Measure,
  latest: number | undefined,
): Promise<CodedObservation[]> {
  if (latest === undefined) {
    const all: CodedObservation[] = [];
    for (const [surveyId, codes] of asked) {
      const rows = await db
          .select({
            surveyId: responses.surveyId,
            responseId: responses.id,
            userId: responses.userId,
            versionId: responses.versionId,
            reliable: responses.reliable,
            submittedAt: responses.submittedAt,
            /*
             * «Сырой» у листа — балл до нормировки, но ПОСЛЕ поправок (#133): лист
             * печатает его «з максимуму», и максимум записан тоже после поправок.
             * Сырой балл без поправок у ЛАП МЛО — всегда 0, и выборка из одних
             * нулей давала 50-й перцентиль любому человеку. У строк до волны 18
             * балла после поправок нет (0118) — там он и есть сырой.
             */
            value:
              measure === "raw"
                ? sql<number>`coalesce(${responseScores.correctedScore}, ${responseScores.rawScore})`
                : responseScores.value,
            maxScore: responseScores.maxScore,
            unit: measure === "raw" ? sql<string>`'raw'` : responseScores.normalization,
            code: scales.code,
          })
          .from(responseScores)
          .innerJoin(responses, eq(responses.id, responseScores.responseId))
          .innerJoin(scales, eq(scales.id, responseScores.scaleId))
          .where(
            and(
              eq(responses.surveyId, surveyId),
              eq(responses.status, "completed"),
              /* то же, что отсечёт политика, — отсекается и здесь: меньше строк тащить */
              eq(responses.reliable, true),
              isNotNull(responses.userId),
              patientRespondent("responses"),
              inArray(scales.code, codes),
              measure === "value" ? eq(responseScores.normalized, true) : undefined,
            ),
          );
      all.push(...rows);
    }
    return all;
  }

  /*
   * Шкалы с нужными кодами — заранее, маленьким запросом, и в большой идут
   * их id: соединение со шкалами на каждую из 38 тыс. строк баллов было
   * четвертью времени чтения (лишняя проба индекса шкал на строку). Шкалы —
   * той же методики: баллы прохождения пишутся по шкалам его версии, а
   * версия — этой методики. Сортировка — ровно по колонкам индекса
   * (survey_id, submitted_at): иначе путь по индексу не поможет
   * (db/latest.ts). Значение «сырого» у листа — как в запросе без предела выше.
   */
  const targets = await db
    .select({ id: scales.id, code: scales.code, surveyId: scales.surveyId })
    .from(scales)
    .where(
      and(
        inArray(scales.surveyId, asked.map(([surveyId]) => surveyId)),
        inArray(scales.code, [...new Set(asked.flatMap(([, codes]) => codes))]),
      ),
    );
  const codeOf = new Map(targets.map((s) => [s.id, s.code]));
  const asks = asked
    .map(([surveyId, codes]) => ({
      survey_id: surveyId,
      scale_ids: targets.filter((s) => s.surveyId === surveyId && codes.includes(s.code)).map((s) => s.id),
    }))
    .filter((a) => a.scale_ids.length);
  if (!asks.length) return [];
  const rows = (await db.execute(sql`
    select r.survey_id as "surveyId", r.id as "responseId", r.user_id as "userId",
           r.version_id as "versionId", r.reliable, r.submitted_at as "submittedAt",
           ${measure === "raw" ? sql`coalesce(rs.corrected_score, rs.raw_score)` : sql`rs.value`} as value,
           rs.max_score as "maxScore",
           ${measure === "raw" ? sql`'raw'` : sql`rs.normalization`} as unit,
           rs.scale_id as "scaleId"
    from ${recordset(asks, "survey_id text, scale_ids text[]")} as p
    cross join lateral (
      select x.id, x.survey_id, x.user_id, x.version_id, x.reliable, x.submitted_at
      from responses x
      where x.survey_id = p.survey_id
        and x.status = 'completed'
        and x.reliable = true
        and x.user_id is not null
        and ${notStaff("x")}
      order by x.submitted_at desc
      limit ${latest}::int
    ) r
    join response_scores rs on rs.response_id = r.id and rs.scale_id = any(p.scale_ids)
      ${measure === "value" ? sql`and rs.normalized = true` : sql``}
  `)) as unknown as (Omit<CodedObservation, "code"> & { scaleId: string })[];
  return rows.map(({ scaleId, ...r }) => ({ ...r, code: codeOf.get(scaleId)! }));
}

/**
 * Выборки для всех шкал одного прохождения — ключ: id шкалы его версии.
 *
 * Печатный лист сравнивает сырой балл (мера "raw"). `survey` — методика той
 * версии, которую проходили (getSurveyForResponse): по ней шкала узнаётся по
 * коду. Прохождение без версии (версию удалили) сравнить не с чем —
 * перцентиля у него нет, а не «по всем».
 */
export async function reportReferenceSamples(
  response: { surveyId: string; versionId: string | null },
  survey: SurveyFull,
  scores: readonly { scaleId: string; maxScore: number }[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const own = response.versionId;
  if (!own) return out;
  const codeOf = new Map(survey.scales.map((s) => [s.id, s.code]));
  const targets = scores.flatMap((s) => {
    const code = codeOf.get(s.scaleId);
    return code ? [{ scaleId: s.scaleId, target: { versionId: own, code, maxScore: s.maxScore, unit: "raw" } }] : [];
  });
  const sampleFor = await referenceSamples(response.surveyId, "raw", targets.map((t) => t.target));
  for (const t of targets) out.set(t.scaleId, sampleFor(t.target));
  return out;
}
