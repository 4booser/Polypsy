import {
  DEFAULT_MIN_ANSWERED_SHARE,
  bandFor,
  countedAnswers,
  evaluateSubmission,
  isQuestionVisible,
  itemContribution,
  type Answer,
  type Option,
  type Question,
  type RespondentContext,
  type Scale,
  type ScaleBand,
  type ScaleItem,
  type ScoreResult,
  type Sex,
  type SubmissionEvaluation,
  type SurveyFull,
} from "@quizzy/shared";
import { loc, num, type Loc, type SheetLang } from "./format";

/**
 * Примеры «ответы → результат» для листа сверки.
 *
 * Лист без примеров описывает, как система ДОЛЖНА считать; пример говорит,
 * как она СЧИТАЕТ. Поэтому каждый результат здесь — вызов живого движка
 * (evaluateSubmission, тот же, что при сдаче на сервере и без сети на
 * устройстве), а не арифметика генератора. Генератор только подбирает
 * ответы: где стоит граница полосы, какой набор ответов даёт значение
 * вплотную к ней с каждой стороны, какой вариант поднимает тревогу.
 *
 * Подбор — перебором по достижимым суммам (как bandCoverage.test.ts), а не
 * решением уравнения: каждая достижимая сумма шкалы строится набором
 * ответов и прогоняется через движок, и граница ищется уже по тому, что
 * движок вернул. Отвергнуто: считать T-балл, стен и долю здесь второй раз и
 * выбирать пример по своему расчёту — тогда лист показывал бы границу, как
 * её понимает генератор, и расхождение с движком было бы невидимо ровно
 * там, где его ищет психолог.
 */

export type ExampleKind =
  | "allMin"
  | "allMax"
  | "scaleMin"
  | "scaleMax"
  | "below"
  | "above"
  | "validPass"
  | "validFail"
  | "risk"
  | "missingOk"
  | "missingFail"
  | "noSex"
  | "dossier";

export interface Example {
  kind: ExampleKind;
  title: Loc;
  /** Шкала, ради которой пример: у многошкальных методик показывается только она */
  focus: string | null;
  respondent: RespondentContext;
  /** Ответы, которые идут в подсчёт (скрытые условием уже отброшены) */
  answers: Answer[];
  /** Ожидание досье: код шкалы → значение */
  expect?: { code: string; value: number }[];
  result: Record<SheetLang, SubmissionEvaluation>;
}

/** Замечание генератора: что не удалось построить или что нашлось по дороге */
export type Finding = Loc;

export interface SurveyPair {
  uk: SurveyFull;
  ru: SurveyFull;
}

/* ─────────────────────────── общие кирпичи ─────────────────────────── */

const choices = (q: Question): Option[] => q.options.filter((o) => o.kind === "option");

/** Пункты, у которых есть выбор варианта, — только их движок считает по вариантам */
const isChoice = (q: Question) => q.type === "single" || q.type === "yesno";

const answerOf = (q: Question, o: Option): Answer => ({ questionId: q.id, optionIds: [o.id] });

/** Где пункт стоит в ключах: шкала и строка ключа */
function membership(survey: SurveyFull): Map<string, { scale: Scale; item: ScaleItem }[]> {
  const out = new Map<string, { scale: Scale; item: ScaleItem }[]>();
  for (const scale of survey.scales) {
    for (const item of scale.items) {
      out.set(item.questionId, [...(out.get(item.questionId) ?? []), { scale, item }]);
    }
  }
  return out;
}

/** Вклад варианта в шкалу — функцией движка, с обратным ключом и совпадением «Так/Ні» */
function contribution(q: Question, item: ScaleItem, o: Option): number {
  return itemContribution(q, item, answerOf(q, o)) ?? 0;
}

/** Методика «да/нет» с ключом по коду ответа: балл варианта не значит ничего */
export function isKeyedYesNo(survey: SurveyFull): boolean {
  const qs = survey.questions.filter(isChoice);
  if (!qs.length) return false;
  const scores = new Set(qs.flatMap((q) => choices(q).map((o) => o.score)));
  return qs.every((q) => q.type === "yesno") && scores.size === 1;
}

/** Ответы в виде карты «вопрос → вариант» → массив ответов, только видимые */
function materialize(survey: SurveyFull, picks: Map<string, string>, skip: Set<string> = new Set()): Answer[] {
  let answers: Answer[] = [];
  for (const q of survey.questions) {
    const id = picks.get(q.id);
    if (!id || skip.has(q.id)) continue;
    answers.push({ questionId: q.id, optionIds: [id] });
  }
  /*
   * Видимость решает движок тем же правилом, что при сдаче. Отбор повторяется,
   * пока набор не устоится: ответ на скрытый пункт тоже мог открыть соседний.
   */
  for (let i = 0; i < 5; i++) {
    const next = countedAnswers(survey, answers).answers;
    if (next.length === answers.length) break;
    answers = next;
  }
  return answers;
}

/* ─────────────────────────── базовый набор ─────────────────────────── */

/**
 * Базовый ответ пункта — «самый тихий» вариант.
 *
 * Примеры строятся от него: всё, что не относится к шкале примера, отвечено
 * так, чтобы не шуметь. Сначала — без флага риска (иначе у каждого примера
 * полосы висела бы тревога по постороннему пункту), потом — наименьший вклад в
 * шкалы достоверности (иначе пример про депрессию Мини-мульта оказался бы
 * недостоверным протоколом из-за шкалы лжи), потом — наименьший вклад во все
 * шкалы вообще, потом — порядок на бланке.
 */
function baselinePicks(survey: SurveyFull): Map<string, string> {
  const member = membership(survey);
  const picks = new Map<string, string>();
  for (const q of survey.questions) {
    if (!isChoice(q)) continue;
    const opts = choices(q);
    if (!opts.length) continue;
    const safe = opts.filter((o) => !o.riskFlag);
    const pool = safe.length ? safe : opts;
    const cost = (o: Option): [number, number, number] => {
      let validity = 0;
      let total = 0;
      for (const { scale, item } of member.get(q.id) ?? []) {
        const c = contribution(q, item, o);
        if (scale.kind === "validity") validity += Math.abs(c);
        total += Math.abs(c);
      }
      return [validity, total, o.position];
    };
    const best = [...pool].sort((a, b) => {
      const [x, y] = [cost(a), cost(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    })[0]!;
    picks.set(q.id, best.id);
  }
  return picks;
}

/* ─────────────────────────── условия показа ─────────────────────────── */

/** Проходит ли одно правило показа при таком ответе на источник */
function ruleHolds(survey: SurveyFull, q: Question, ruleIndex: number, picks: Map<string, string>): boolean {
  const answers = new Map<string, Answer>();
  for (const [qid, oid] of picks) answers.set(qid, { questionId: qid, optionIds: [oid] });
  return isQuestionVisible({ ...q, logic: [q.logic[ruleIndex]!] }, survey.questions, answers);
}

/**
 * Открыть пункты: ответить на их источники условий так, чтобы пункты были
 * заданы (PC-PTSD-5 — «Так» на отсеивающем вопросе, ASSIST — «Так» на
 * первом вопросе по веществу). Источники внутри `fixed` не трогаются — их
 * варианты ограничивает перебор (allowedOptions).
 */
function enable(survey: SurveyFull, targets: Iterable<string>, picks: Map<string, string>, fixed: Set<string>): void {
  const byId = new Map(survey.questions.map((q) => [q.id, q]));
  const queue = [...targets];
  const seen = new Set<string>();
  while (queue.length) {
    const qid = queue.shift()!;
    if (seen.has(qid)) continue;
    seen.add(qid);
    const q = byId.get(qid);
    if (!q?.logic?.length) continue;
    q.logic.forEach((rule, i) => {
      const src = byId.get(rule.sourceQuestionId);
      if (!src || fixed.has(src.id) || !isChoice(src)) return;
      if (ruleHolds(survey, q, i, picks)) return;
      const ok = choices(src).find((o) => ruleHolds(survey, q, i, new Map([...picks, [src.id, o.id]])));
      if (ok) picks.set(src.id, ok.id);
      queue.push(src.id);
    });
  }
}

/**
 * Варианты источника внутри перебора, при которых зависимые пункты перебора
 * остаются заданными. ASSIST: частота за три месяца «Ніколи» закрывает
 * вопросы 3–5 — и сумма, построенная с ней и с ненулевым вопросом 3, была бы
 * суммой, которой человек набрать не может.
 */
function allowedOptions(survey: SurveyFull, U: Question[]): Map<string, Set<string>> {
  const inU = new Set(U.map((q) => q.id));
  const allowed = new Map<string, Set<string>>();
  for (const q of U) {
    q.logic?.forEach((rule, i) => {
      if (!inU.has(rule.sourceQuestionId)) return;
      const src = U.find((x) => x.id === rule.sourceQuestionId)!;
      const ok = new Set(
        choices(src)
          .filter((o) => ruleHolds(survey, q, i, new Map([[src.id, o.id]])))
          .map((o) => o.id),
      );
      const prev = allowed.get(src.id);
      allowed.set(src.id, prev ? new Set([...prev].filter((id) => ok.has(id))) : ok);
    });
  }
  return allowed;
}

/* ─────────────────────────── перебор сумм шкалы ─────────────────────────── */

interface State {
  sum: number;
  penalty: number;
  prev: State | null;
  qid: string | null;
  oid: string | null;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Все достижимые суммы шкалы (с поправками — как линейная сумма вкладов) и
 * для каждой — самый «тихий» набор ответов на её пункты.
 *
 * Поправка Мини-мульта (Hs + 0,5·K) и композит МЛО (ЛАП = ПР + КП + МН)
 * линейны по сырым баллам, а сырой балл — сумма вкладов пунктов; значит,
 * итог шкалы — сумма «эффективных» вкладов каждого варианта по всем
 * участвующим шкалам. Пункт, стоящий в двух ключах сразу (51-й Мини-мульта:
 * K «Невірно», Pt «Вірно»), так и учитывается — одним ответом на обе.
 *
 * Штраф выбирает среди равных сумм набор без критических вариантов и с
 * наименьшим вкладом в посторонние шкалы достоверности.
 */
function reachableSums(
  survey: SurveyFull,
  scale: Scale,
): { sums: Map<number, State>; U: Question[]; unsupported: boolean } {
  const byCode = new Map(survey.scales.map((s) => [s.code, s]));
  // шкала и её источники поправок с коэффициентами
  const parts: { scale: Scale; coef: number }[] = [{ scale, coef: 1 }];
  for (const c of scale.corrections) {
    const src = byCode.get(c.sourceScaleCode);
    if (src) parts.push({ scale: src, coef: c.coefficient });
  }
  const involved = new Set(parts.map((p) => p.scale.code));
  const qids = new Set(parts.flatMap((p) => p.scale.items.map((i) => i.questionId)));
  const U = survey.questions.filter((q) => qids.has(q.id));
  const unsupported = U.some((q) => !isChoice(q)) || (scale.aggregation !== "sum" && scale.corrections.length > 0);
  const member = membership(survey);
  const allowed = allowedOptions(survey, U);

  let layer = new Map<number, State>([[0, { sum: 0, penalty: 0, prev: null, qid: null, oid: null }]]);
  for (const q of U) {
    if (!isChoice(q)) continue;
    const next = new Map<number, State>();
    const opts = choices(q).filter((o) => !allowed.has(q.id) || allowed.get(q.id)!.has(o.id));
    for (const o of opts) {
      let eff = 0;
      let penalty = o.riskFlag ? 1000 : 0;
      for (const { scale: s, item } of member.get(q.id) ?? []) {
        const c = contribution(q, item, o);
        for (const p of parts) {
          if (p.scale.code !== s.code) continue;
          if (scale.aggregation === "count" && p.scale.code === scale.code) eff += c > 0 ? 1 : 0;
          else eff += c * p.coef;
        }
        if (!involved.has(s.code) && s.kind === "validity") penalty += Math.abs(c);
      }
      for (const st of layer.values()) {
        const sum = round6(st.sum + eff);
        const pen = st.penalty + penalty;
        const have = next.get(sum);
        if (!have || pen < have.penalty) next.set(sum, { sum, penalty: pen, prev: st, qid: q.id, oid: o.id });
      }
    }
    layer = next;
  }
  return { sums: layer, U, unsupported };
}

function pathOf(state: State): Map<string, string> {
  const out = new Map<string, string>();
  for (let s: State | null = state; s; s = s.prev) if (s.qid && s.oid) out.set(s.qid, s.oid);
  return out;
}

/* ─────────────────────────── страты норм ─────────────────────────── */

export interface Stratum {
  respondent: RespondentContext;
  label: Loc | null;
}

const SEX_LABEL: Record<Sex, Loc> = {
  male: loc("стать: чоловіча", "пол: мужской"),
  female: loc("стать: жіноча", "пол: женский"),
};

function stratumLabel(sex: Sex | null, ageMin: number | null, ageMax: number | null): Loc | null {
  const parts: Loc[] = [];
  if (sex) parts.push(SEX_LABEL[sex]);
  if (ageMin !== null || ageMax !== null) {
    const span = `${ageMin ?? ""}–${ageMax ?? ""}`;
    parts.push(loc(`вік: ${span}`, `возраст: ${span}`));
  }
  if (!parts.length) return null;
  return loc(parts.map((p) => p.uk).join(", "), parts.map((p) => p.ru).join(", "));
}

/** Страты, по которым у шкалы разная норма: пол и возраст из норм или таблицы стенов */
export function strataOf(scale: Scale): Stratum[] {
  const rows =
    scale.normalization === "tscore"
      ? scale.norms.map((n) => [n.sex, n.ageMin, n.ageMax] as const)
      : scale.normalization === "sten"
        ? scale.stenTable.map((r) => [r.sex, r.ageMin, r.ageMax] as const)
        : [];
  const seen = new Map<string, Stratum>();
  for (const [sex, ageMin, ageMax] of rows) {
    const key = `${sex}|${ageMin}|${ageMax}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      respondent: { sex: sex ?? null, age: ageMin ?? ageMax ?? null },
      label: stratumLabel(sex ?? null, ageMin ?? null, ageMax ?? null),
    });
  }
  return seen.size ? [...seen.values()] : [{ respondent: { sex: null, age: null }, label: null }];
}

/** Нужен ли пол, чтобы нормировать хоть одну шкалу методики */
export function needsSex(survey: SurveyFull): boolean {
  return survey.scales.some((s) => {
    const rows = s.normalization === "tscore" ? s.norms : s.normalization === "sten" ? s.stenTable : [];
    return rows.length > 0 && rows.every((r) => r.sex !== null);
  });
}

/** Респондент примеров уровня методики: первая страта первой шкалы с нормами по полу */
function defaultStratum(survey: SurveyFull): Stratum {
  for (const s of survey.scales) {
    const strata = strataOf(s);
    if (strata[0]?.respondent.sex) return strata[0];
  }
  return { respondent: { sex: null, age: null }, label: null };
}

/* ─────────────────────────── сборка примеров ─────────────────────────── */

export interface DossierPick {
  score?: number;
  pos?: number;
  key?: "yes" | "no";
}

export interface DossierExampleSpec {
  title: Loc;
  /** Ответ по номеру пункта (с единицы); не названные — по `rest`, иначе базовый */
  answers: Record<number, DossierPick>;
  rest?: DossierPick;
  expect: Record<string, number>;
}

function pickOption(q: Question, p: DossierPick): Option | undefined {
  const opts = choices(q);
  if (p.key) return opts.find((o) => o.keyCode === p.key);
  if (p.pos !== undefined) return opts[p.pos];
  if (p.score !== undefined) return opts.find((o) => o.score === p.score);
  return undefined;
}

const scoreOf = (e: SubmissionEvaluation, code: string): ScoreResult | undefined =>
  e.profile.scores.find((s) => s.scaleCode === code);

interface Candidate {
  answers: Answer[];
  uk: SubmissionEvaluation;
  score: ScoreResult;
  band: ScaleBand | null;
}

function sortedBands(scale: Scale): ScaleBand[] {
  return [...scale.bands].sort((a, b) => a.minScore - b.minScore);
}

export interface ExampleSet {
  examples: Example[];
  findings: Finding[];
  /** Смуги, которые ни одна достижимая комбинация ответов не даёт: шкала → подписи */
  unreachable: { code: string; band: Loc; stratum: Loc | null }[];
  /** Значения без полосы при нормированном балле */
  gaps: { code: string; value: number; stratum: Loc | null }[];
}

export function buildExamples(pair: SurveyPair, dossier: DossierExampleSpec[] = []): ExampleSet {
  const survey = pair.uk;
  const byId = new Map(survey.questions.map((q) => [q.id, q]));
  const byIdRu = new Map(pair.ru.questions.map((q) => [q.id, q]));
  const scaleRu = new Map(pair.ru.scales.map((s) => [s.code, s]));
  const findings: Finding[] = [];
  const unreachable: ExampleSet["unreachable"] = [];
  const gaps: ExampleSet["gaps"] = [];
  const examples: Example[] = [];
  const base = baselinePicks(survey);
  const keyed = isKeyedYesNo(survey);
  const deflt = defaultStratum(survey);

  const evaluate = (answers: Answer[], respondent: RespondentContext) => ({
    uk: evaluateSubmission(pair.uk, answers, respondent),
    ru: evaluateSubmission(pair.ru, answers, respondent),
  });
  const withStratum = (title: Loc, st: Stratum | null): Loc =>
    st?.label ? loc(`${title.uk} · ${st.label.uk}`, `${title.ru} · ${st.label.ru}`) : title;
  const push = (
    kind: ExampleKind,
    title: Loc,
    focus: string | null,
    st: Stratum,
    answers: Answer[],
    extra: Partial<Example> = {},
  ) => {
    examples.push({
      kind,
      title: withStratum(title, st),
      focus,
      respondent: st.respondent,
      answers,
      result: evaluate(answers, st.respondent),
      ...extra,
    });
  };

  /* 1. Весь бланк одним вариантом: крайние ответы, проверка ключа и обратных пунктов */
  const firstYesNo = survey.questions.find((q) => q.type === "yesno");
  const yesText = (lang: SheetLang) => {
    const q = (lang === "uk" ? byId : byIdRu).get(firstYesNo?.id ?? "");
    return q ? (choices(q).find((o) => o.keyCode === "yes")?.text ?? "") : "";
  };
  const noText = (lang: SheetLang) => {
    const q = (lang === "uk" ? byId : byIdRu).get(firstYesNo?.id ?? "");
    return q ? (choices(q).find((o) => o.keyCode === "no")?.text ?? "") : "";
  };
  const extremes = (which: "min" | "max"): Map<string, string> => {
    const picks = new Map<string, string>();
    for (const q of survey.questions) {
      if (!isChoice(q)) continue;
      const opts = choices(q);
      if (!opts.length) continue;
      let o: Option | undefined;
      if (keyed) o = opts.find((x) => x.keyCode === (which === "min" ? "no" : "yes")) ?? opts[0];
      else {
        const target = which === "min" ? Math.min(...opts.map((x) => x.score)) : Math.max(...opts.map((x) => x.score));
        o = opts.find((x) => x.score === target);
      }
      if (o) picks.set(q.id, o.id);
    }
    return picks;
  };
  push(
    "allMin",
    keyed
      ? loc(`Усі відповіді — «${noText("uk")}»`, `Все ответы — «${noText("ru")}»`)
      : loc(
          "Усі відповіді — варіант із найменшим балом на бланку",
          "Все ответы — вариант с наименьшим баллом на бланке",
        ),
    null,
    deflt,
    materialize(survey, extremes("min")),
  );
  push(
    "allMax",
    keyed
      ? loc(`Усі відповіді — «${yesText("uk")}»`, `Все ответы — «${yesText("ru")}»`)
      : loc(
          "Усі відповіді — варіант із найбільшим балом на бланку (обернені пункти при цьому дають найменший внесок)",
          "Все ответы — вариант с наибольшим баллом на бланке (обратные пункты при этом дают наименьший вклад)",
        ),
    null,
    deflt,
    materialize(survey, extremes("max")),
  );

  /* 2. Каждая шкала: края, границы каждой полосы с обеих сторон, порог достоверности */
  for (const scale of survey.scales) {
    const ru = scaleRu.get(scale.code)!;
    const labelOf = (band: ScaleBand): Loc => {
      const i = scale.bands.indexOf(band);
      return loc(band.label, ru.bands[i]?.label ?? band.label);
    };
    const { sums, U, unsupported } = reachableSums(survey, scale);
    if (unsupported) {
      findings.push(
        loc(
          `Шкала ${scale.code}: генератор не вміє перебрати її пункти (не лише вибір варіанта або поправки при не-сумі) — межі не показано прикладами`,
          `Шкала ${scale.code}: генератор не умеет перебрать её пункты (не только выбор варианта или поправки при не-сумме) — границы не показаны примерами`,
        ),
      );
      continue;
    }
    // источники вне перебора — открыть пункты шкалы
    const fixed = new Set(U.map((q) => q.id));
    const opened = new Map(base);
    enable(survey, fixed, opened, fixed);

    for (const st of strataOf(scale)) {
      const cands: Candidate[] = [];
      for (const state of sums.values()) {
        const picks = new Map(opened);
        for (const [q, o] of pathOf(state)) picks.set(q, o);
        const answers = materialize(survey, picks);
        const uk = evaluateSubmission(pair.uk, answers, st.respondent);
        const score = scoreOf(uk, scale.code);
        if (!score) continue;
        const band = score.normalized ? bandFor(scale.bands, score.value) : null;
        if (score.normalized && scale.bands.length && !band) {
          gaps.push({ code: scale.code, value: score.value, stratum: st.label });
        }
        cands.push({ answers, uk, score, band });
      }
      if (!cands.length) continue;
      if (!cands.some((c) => c.score.normalized)) {
        // норма к этой страте не применяется — граница не существует, пример «без пола» ниже
        continue;
      }
      const usable = cands.filter((c) => c.score.normalized);
      /*
       * Порядок кандидатов: по значению, а при равном значении — по сырому
       * баллу в ту сторону, куда растёт шкала. Стены МЛО обратные: сырой
       * балл 45 и 46 — это стены 3 и 2, и пример у границы должен стоять
       * на них, а не на 35 и 56 с теми же стенами.
       */
      const lo = usable.reduce((a, b) => (b.score.correctedScore < a.score.correctedScore ? b : a));
      const hi = usable.reduce((a, b) => (b.score.correctedScore > a.score.correctedScore ? b : a));
      const increasing = hi.score.value >= lo.score.value;
      usable.sort(
        (a, b) =>
          a.score.value - b.score.value ||
          (increasing ? 1 : -1) * (a.score.correctedScore - b.score.correctedScore),
      );

      const title = loc;
      const first = usable[0]!;
      const last = usable[usable.length - 1]!;
      /*
       * Край шкалы уже показан, если пример уровня методики (все ответы
       * одним вариантом) дошёл до него или дальше: у ASSIST «Ні» на первом
       * вопросе даёт 0, а перебор, держащий пункты заданными, — не меньше 2,
       * и пример «наименьшее значение» с двойкой был бы неправдой.
       */
      const reached = (c: Candidate, side: "min" | "max") =>
        examples.some((e) => {
          if (e.respondent.sex !== st.respondent.sex || e.respondent.age !== st.respondent.age) return false;
          const v = scoreOf(e.result.uk, scale.code);
          if (!v || !v.normalized) return false;
          return side === "min" ? v.value <= c.score.value : v.value >= c.score.value;
        });
      if (!reached(first, "min")) {
        push(
          "scaleMin",
          title(`${scale.code}: найменше можливе значення шкали`, `${scale.code}: наименьшее возможное значение шкалы`),
          scale.code,
          st,
          first.answers,
        );
      }

      const bands = sortedBands(scale);
      for (let i = 0; i + 1 < bands.length; i++) {
        const [a, b] = [bands[i]!, bands[i + 1]!];
        const below = [...usable].reverse().find((c) => c.band === a);
        const above = usable.find((c) => c.band === b);
        const [la, lb] = [labelOf(a), labelOf(b)];
        if (below) {
          push(
            "below",
            title(
              `${scale.code}: межа «${la.uk}» → «${lb.uk}», нижній бік — останнє досяжне значення смуги «${la.uk}»`,
              `${scale.code}: граница «${la.ru}» → «${lb.ru}», нижняя сторона — последнее достижимое значение полосы «${la.ru}»`,
            ),
            scale.code,
            st,
            below.answers,
          );
        }
        if (above) {
          push(
            "above",
            title(
              `${scale.code}: межа «${la.uk}» → «${lb.uk}», верхній бік — перше досяжне значення смуги «${lb.uk}»`,
              `${scale.code}: граница «${la.ru}» → «${lb.ru}», верхняя сторона — первое достижимое значение полосы «${lb.ru}»`,
            ),
            scale.code,
            st,
            above.answers,
          );
        }
      }
      for (const band of bands) {
        if (!usable.some((c) => c.band === band)) {
          unreachable.push({ code: scale.code, band: labelOf(band), stratum: st.label });
        }
      }

      if (scale.kind === "validity" && scale.validityThreshold !== null) {
        const failed = (c: Candidate) => c.score.validityFailed === true;
        const above = scale.validityDirection !== "below";
        const pass = above ? [...usable].reverse().find((c) => !failed(c)) : usable.find((c) => !failed(c));
        const fail = above ? usable.find(failed) : [...usable].reverse().find(failed);
        const thr = num(scale.validityThreshold);
        if (pass) {
          push(
            "validPass",
            title(
              `${scale.code}: поріг достовірності (${above ? ">" : "<"} ${thr} — недостовірно), найближче значення, за якого протокол ще достовірний`,
              `${scale.code}: порог достоверности (${above ? ">" : "<"} ${thr} — недостоверно), ближайшее значение, при котором протокол ещё достоверен`,
            ),
            scale.code,
            st,
            pass.answers,
          );
        }
        if (fail) {
          push(
            "validFail",
            title(
              `${scale.code}: поріг достовірності, перше значення, за якого протокол недостовірний`,
              `${scale.code}: порог достоверности, первое значение, при котором протокол недостоверен`,
            ),
            scale.code,
            st,
            fail.answers,
          );
        }
      }

      if (!reached(last, "max")) {
        push(
          "scaleMax",
          title(`${scale.code}: найбільше можливе значення шкали`, `${scale.code}: наибольшее возможное значение шкалы`),
          scale.code,
          st,
          last.answers,
        );
      }
    }
  }

  /* 3. Критические варианты: каждый пункт и каждая тяжесть — отдельным примером */
  const qNumber = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  for (const q of survey.questions) {
    if (!isChoice(q)) continue;
    const flagged = choices(q).filter((o) => o.riskFlag);
    const bySeverity = new Map<string, Option>();
    for (const o of flagged) {
      const sev = o.riskSeverity ?? "severe";
      if (!bySeverity.has(sev)) bySeverity.set(sev, o);
    }
    for (const [sev, o] of bySeverity) {
      const picks = new Map(base);
      enable(survey, [q.id], picks, new Set());
      picks.set(q.id, o.id);
      const ru = byIdRu.get(q.id);
      const oRu = ru ? choices(ru).find((x) => x.id === o.id) : undefined;
      const n = qNumber.get(q.id)!;
      const sevLoc = sev === "moderate" ? loc("помірна", "умеренная") : loc("тяжка", "тяжёлая");
      push(
        "risk",
        loc(
          `Критичний пункт ${n}: відповідь «${o.text}» (тривога — ${sevLoc.uk}), решта відповідей — найтихіші`,
          `Критический пункт ${n}: ответ «${oRu?.text ?? o.text}» (тревога — ${sevLoc.ru}), остальные ответы — самые тихие`,
        ),
        null,
        deflt,
        materialize(survey, picks),
      );
    }
    // числовой порог риска (у методик каталога его нет, но движок умеет)
    if (q.riskThreshold !== null && q.riskThreshold !== undefined) {
      findings.push(
        loc(
          `Пункт ${qNumber.get(q.id)}: числовий поріг ризику ${num(q.riskThreshold)} — прикладом не показано`,
          `Пункт ${qNumber.get(q.id)}: числовой порог риска ${num(q.riskThreshold)} — примером не показан`,
        ),
      );
    }
  }

  /* 4. Пропуски: минимальная доля ответов с обеих сторон */
  const target = survey.scales.find((s) => s.kind === "clinical" && s.items.length >= 2) ?? survey.scales.find((s) => s.items.length);
  if (target) {
    const picks = new Map(base);
    const itemIds = target.items.map((i) => i.questionId);
    enable(survey, itemIds, picks, new Set());
    const full = materialize(survey, picks);
    const asked = itemIds.filter((id) => full.some((a) => a.questionId === id));
    const minShare = target.minAnsweredShare ?? DEFAULT_MIN_ANSWERED_SHARE;
    /*
     * Пропускаем с конца ключа, минуя источники условий показа (пропуск
     * закрыл бы соседние пункты) и откладывая критические пункты на потом:
     * пример про долю ответов не должен заодно прятать пункт риска.
     */
    const sources = new Set(survey.questions.flatMap((q) => (q.logic ?? []).map((r) => r.sourceQuestionId)));
    const risky = (id: string) => byId.get(id)?.options.some((o) => o.riskFlag) ?? false;
    const skippable = asked
      .filter((id) => !sources.has(id))
      .reverse()
      .sort((a, b) => Number(risky(a)) - Number(risky(b)));
    let failK = 0;
    for (let k = 1; k <= skippable.length; k++) {
      if ((asked.length - k) / asked.length < minShare - 1e-9) {
        failK = k;
        break;
      }
    }
    const numbers = (ids: string[]) =>
      ids
        .map((id) => qNumber.get(id)!)
        .sort((a, b) => a - b)
        .join(", ");
    if (failK > 1) {
      const skip = skippable.slice(0, failK - 1);
      const a = asked.length - skip.length;
      push(
        "missingOk",
        loc(
          `Пропуски у шкалі ${target.code}: без відповіді пункти ${numbers(skip)} — відповідей ${a} з ${asked.length}, не нижче мінімальної частки ${num(minShare)}; бал рахується за наявними відповідями без перерахунку`,
          `Пропуски в шкале ${target.code}: без ответа пункты ${numbers(skip)} — ответов ${a} из ${asked.length}, не ниже минимальной доли ${num(minShare)}; балл считается по имеющимся ответам без пересчёта`,
        ),
        null,
        deflt,
        materialize(survey, picks, new Set(skip)),
      );
    }
    if (failK > 0) {
      const skip = skippable.slice(0, failK);
      const a = asked.length - skip.length;
      push(
        "missingFail",
        loc(
          `Пропуски у шкалі ${target.code}: без відповіді пункти ${numbers(skip)} — відповідей ${a} з ${asked.length}, нижче мінімальної частки ${num(minShare)}; шкалу не обчислено`,
          `Пропуски в шкале ${target.code}: без ответа пункты ${numbers(skip)} — ответов ${a} из ${asked.length}, ниже минимальной доли ${num(minShare)}; шкала не вычислена`,
        ),
        null,
        deflt,
        materialize(survey, picks, new Set(skip)),
      );
    }
  }

  /* 5. Пол не указан — нормы по полу не применяются */
  if (needsSex(survey)) {
    push(
      "noSex",
      loc(
        "Стать обстежуваного не вказано (відповіді — найтихіші): норми за статтю застосувати не можна",
        "Пол обследуемого не указан (ответы — самые тихие): нормы по полу применить нельзя",
      ),
      null,
      { respondent: { sex: null, age: null }, label: null },
      materialize(survey, base),
    );
  }

  /* 6. Проверочные примеры досье: ответы → ожидаемое значение из первоисточника */
  for (const spec of dossier) {
    const picks = new Map(base);
    survey.questions.forEach((q, i) => {
      if (!isChoice(q)) return;
      const p = spec.answers[i + 1] ?? spec.rest;
      if (!p) return;
      const o = pickOption(q, p);
      if (o) picks.set(q.id, o.id);
      else {
        findings.push(
          loc(
            `Приклад досьє «${spec.title.uk}»: для пункту ${i + 1} не знайдено варіант ${JSON.stringify(p)}`,
            `Пример досье «${spec.title.ru}»: для пункта ${i + 1} не найден вариант ${JSON.stringify(p)}`,
          ),
        );
      }
    });
    push("dossier", spec.title, null, deflt, materialize(survey, picks), {
      expect: Object.entries(spec.expect).map(([code, value]) => ({ code, value })),
    });
  }

  return { examples, findings, unreachable, gaps };
}
