import { UI, type Administration, type SurveyFull, type SurveyGroupWithCounts, type UiKey } from "@quizzy/shared";

/*
 * Вид теста по макету: «Конкретний тест» и «Комплексний тест».
 *
 * В модели данных такого поля нет, и заводить его на сервере не нужно: обе
 * вкладки макета — два способа ЗАПОЛНИТЬ одну и ту же методику.
 *
 *   specific — один набор ответов на все вопросы («1 Так · 2 Ні · 3 Нінаю»)
 *              и шкалы с таблицей баллов «ответ → номера вопросов → балл».
 *              Это ключ scale_items { matchKey, weight }: так устроены
 *              СР-45, МЛО, Мини-мульт.
 *   complex  — у каждого вопроса свои ответы с баллом, результат — сумма.
 *              Это балл варианта (options.score) и одна итоговая шкала с
 *              ключом на все пункты без matchKey; «Результати» — её полосы.
 *
 * Поле живёт только в редакторе и на сервер не уходит (см. toPayload):
 * сервер различает те же два случая по составу ключа, и второй, спорящий с
 * ним признак был бы источником расхождений.
 */
export type Mode = "specific" | "complex";

/** Черновик методики в том же виде, какой принимает API */
export interface Draft {
  title: Record<string, string>;
  description?: Record<string, string> | null;
  instructions?: Record<string, string> | null;
  groupId?: string | null;
  administration: Administration;
  visibility: "public" | "restricted";
  scoringEnabled: boolean;
  allowRetake: boolean;
  showProgress: boolean;
  allowBack: boolean;
  anonymous: boolean;
  randomizeQuestions: boolean;
  timeLimitSec?: number | null;
  tooFastMs?: number | null;
  alertEscalateMinutes?: number | null;
  safetyPlan?: Record<string, string> | null;
  showResultsToPatient?: boolean;
  sections: unknown[];
  questions: DraftQuestion[];
  scales: DraftScale[];

  /* ── поля редактора: на сервер не уходят ── */

  /** Вкладка макета; см. Mode. Отсутствует у черновиков, сохранённых раньше. */
  mode?: Mode;
  /**
   * Общий набор ответов теста («Відповіді» в макете).
   *
   * В базе варианты принадлежат вопросу (options.question_id), и общего
   * набора у методики нет. Здесь он хранится, чтобы его можно было собрать
   * ДО первого вопроса, как на кадре, а при каждом изменении он копируется
   * во все вопросы (applyAnswers). Хранить его отдельно — значит держать
   * две правды; цена принята, потому что вторая правда (варианты в вопросах)
   * восстанавливается из первой одной функцией, а не наоборот.
   */
  answers?: DraftOption[];
  /**
   * Папка каталога, из которой пришли по «+ → Новий тест». Сервер принимает
   * её только при заведении (createSurveySchema.folderId); в правке она не
   * участвует и из черновика вырезается вместе с остальными полями редактора.
   */
  folderId?: string | null;
}

export interface DraftOption {
  text: Record<string, string>;
  score?: number;
  keyCode?: string | null;
  riskFlag?: boolean;
  riskLabel?: Record<string, string> | null;
  riskSeverity?: "moderate" | "severe" | null;
}

export interface DraftQuestion {
  /**
   * Идентификатор строки списка на время правки.
   *
   * Ключом React был порядковый номер, и при удалении пункта его место
   * занимал следующий: поле ввода оставалось тем же узлом DOM, курсор — в
   * нём, а текст в нём — уже от другого вопроса. На сервер не уходит.
   */
  uid: string;
  type: string;
  title: Record<string, string>;
  help?: Record<string, string> | null;
  required: boolean;
  options: DraftOption[];
}

export interface DraftScale {
  /** См. DraftQuestion.uid — то же для списка шкал */
  uid: string;
  code: string;
  title: Record<string, string>;
  description?: Record<string, string> | null;
  kind: "clinical" | "validity";
  normalization: "raw" | "ratio" | "tscore" | "sten";
  aggregation?: "sum" | "average" | "count";
  ratioDenominator?: number | null;
  validityThreshold?: number | null;
  validityDirection?: "above" | "below" | null;
  validityMessage?: Record<string, string> | null;
  key: { item: number; matchKey?: string | null; weight?: number }[];
  corrections: { from: string; coefficient: number }[];
  norms: { sex?: "male" | "female" | null; mean: number; sd: number }[];
  stenTable: { rawMin: number; rawMax: number; sten: number }[];
  bands: DraftBand[];
}

export interface DraftBand {
  minScore: number;
  maxScore: number;
  label: Record<string, string>;
  severity: "none" | "mild" | "moderate" | "severe";
  grade?: number | null;
  recommendation?: Record<string, string> | null;
  cascadeBatteryId?: string | null;
  cascadeDueDays?: number | null;
  followUpDays?: string | null;
}

/**
 * Набор ответов нового теста: «Так» / «Ні».
 *
 * Коды «yes»/«no», а не «1»/«2» с кадра: по ним ключ сравнивается с ответом
 * в scoring.ts, и во всех встроенных методиках они записаны именно так; ключ
 * на печать (GET /api/surveys/:id/key) тоже знает только их. Номер на чипе
 * макета — порядковый, он рисуется, а не хранится.
 */
export const defaultAnswers = (): DraftOption[] => [
  { text: { uk: UI["bp.yes"].uk, ru: UI["bp.yes"].ru }, keyCode: "yes" },
  { text: { uk: UI["bp.no"].uk, ru: UI["bp.no"].ru }, keyCode: "no" },
];

export const EMPTY: Draft = {
  title: { uk: "", ru: "" },
  administration: "self",
  visibility: "public",
  scoringEnabled: true,
  allowRetake: false,
  showProgress: true,
  allowBack: true,
  anonymous: false,
  randomizeQuestions: false,
  sections: [],
  questions: [],
  scales: [],
  mode: "specific",
  answers: defaultAnswers(),
};

/*
 * Виды вопросов: код и ключ подписи.
 *
 * Подпись была написана здесь по-русски и уезжала на экран как есть — в
 * конструкторе на украинском выпадающий список видов оставался русским.
 * Файл живёт вне разметки, поэтому первая редакция проверки строк его не
 * видела: она смотрела только .tsx.
 */
export const TYPES = [
  ["yesno", "qt.yesno"],
  ["single", "qt.single"],
  ["multiple", "qt.multiple"],
  ["scale", "qt.scale"],
  ["slider", "qt.slider"],
  ["matrix", "qt.matrix"],
  ["ranking", "qt.ranking"],
  ["number", "qt.number"],
  ["text", "qt.text"],
  ["longtext", "qt.longtext"],
  ["date", "qt.date"],
  ["info", "qt.info"],
] as const satisfies readonly (readonly [string, UiKey])[];

/** Приводит методику из API к черновику: строки уже могут быть объектами языков */
export function toDraft(s: SurveyFull, groups: SurveyGroupWithCounts[]): Draft {
  const loc = (v: unknown): Record<string, string> =>
    typeof v === "string" ? { ru: v } : ((v ?? {}) as Record<string, string>);
  const indexById = new Map(s.questions.map((q, i) => [q.id, i + 1]));

  const questions: DraftQuestion[] = s.questions.map((q) => ({
    uid: q.id,
    type: q.type,
    title: loc(q.title),
    help: q.help ? loc(q.help) : null,
    required: q.required,
    options: q.options.map((o) => ({
      text: loc(o.text),
      score: o.score,
      keyCode: o.keyCode,
      riskFlag: o.riskFlag,
      riskLabel: o.riskLabel ? loc(o.riskLabel) : null,
      riskSeverity: o.riskSeverity,
    })),
  }));

  const scales: DraftScale[] = s.scales.map((sc) => ({
    uid: sc.id,
    code: sc.code,
    title: loc(sc.title),
    description: sc.description ? loc(sc.description) : null,
    kind: sc.kind,
    normalization: sc.normalization,
    aggregation: sc.aggregation,
    ratioDenominator: sc.ratioDenominator,
    validityThreshold: sc.validityThreshold,
    validityDirection: sc.validityDirection,
    validityMessage: sc.validityMessage ? loc(sc.validityMessage) : null,
    key: sc.items.flatMap((i) => {
      const item = indexById.get(i.questionId);
      return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
    }),
    corrections: sc.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
    norms: sc.norms.map((n) => ({ sex: n.sex, mean: n.mean, sd: n.sd })),
    stenTable: sc.stenTable.map((r) => ({ rawMin: r.rawMin, rawMax: r.rawMax, sten: r.sten })),
    bands: sc.bands.map((b) => ({
      minScore: b.minScore,
      maxScore: b.maxScore,
      label: loc(b.label),
      severity: b.severity,
      grade: b.grade,
      recommendation: b.recommendation ? loc(b.recommendation) : null,
      cascadeBatteryId: b.cascadeBatteryId,
      cascadeDueDays: b.cascadeDueDays,
      followUpDays: b.followUpDays,
    })),
  }));

  return {
    title: loc(s.title),
    description: s.description ? loc(s.description) : null,
    instructions: s.instructions ? loc(s.instructions) : null,
    groupId: s.groupId ?? groups[0]?.id ?? null,
    administration: s.administration,
    visibility: s.visibility,
    scoringEnabled: s.scoringEnabled,
    allowRetake: s.allowRetake,
    showProgress: s.showProgress,
    allowBack: s.allowBack,
    anonymous: s.anonymous,
    randomizeQuestions: s.randomizeQuestions,
    timeLimitSec: s.timeLimitSec,
    tooFastMs: s.tooFastMs,
    alertEscalateMinutes: s.alertEscalateMinutes,
    sections: [],
    questions,
    scales,
    mode: deriveMode(scales),
    answers: deriveAnswers(questions),
  };
}

/**
 * Какой вкладке макета отвечает сохранённая методика.
 *
 * Признак — ключ, а не число шкал само по себе: методика с одной шкалой и
 * ключом «Так → 1, 3, 7» — конкретный тест, а с одной итоговой шкалой без
 * matchKey — комплексный. Несколько шкал без ключа (пять факторов с баллом
 * варианта) в плоскую форму «Результати» не укладываются, и им честнее
 * показать таблицу баллов с рядом «бал відповіді», чем спрятать четыре шкалы.
 */
export function deriveMode(scales: DraftScale[]): Mode {
  if (scales.length > 1) return "specific";
  if (scales.some((s) => s.key.some((k) => k.matchKey !== null && k.matchKey !== undefined))) return "specific";
  return "complex";
}

/** Общий набор ответов из уже заведённых вопросов: первый вопрос с вариантами */
export function deriveAnswers(questions: DraftQuestion[]): DraftOption[] {
  const first = questions.find((q) => q.options.length > 0);
  return first ? structuredClone(first.options) : defaultAnswers();
}

/**
 * Свободный код для нового ответа в общем наборе.
 *
 * Первые два — «yes» и «no» (см. defaultAnswers), остальные — k3, k4…: код
 * обязан быть уникальным и переживать удаление соседей, иначе ключ шкалы
 * начнёт считать чужой ответ.
 */
export function nextKeyCode(existing: (string | null | undefined)[]): string {
  const taken = new Set(existing.filter((c): c is string => !!c));
  if (!taken.has("yes")) return "yes";
  if (!taken.has("no")) return "no";
  for (let n = 3; ; n++) {
    const code = `k${n}`;
    if (!taken.has(code)) return code;
  }
}

/** Общий набор ответов — во все вопросы разом (см. Draft.answers) */
export function applyAnswers(draft: Draft, answers: DraftOption[]): Draft {
  return {
    ...draft,
    answers,
    questions: draft.questions.map((q) => (q.type === "info" ? q : { ...q, options: structuredClone(answers) })),
  };
}

/** Сколько вопросов держат свой набор ответов, отличный от общего */
export function questionsWithOwnAnswers(draft: Draft): number {
  const shared = draft.answers ?? [];
  const sig = (o: DraftOption) => `${o.keyCode ?? ""}\0${o.text.uk ?? ""}\0${o.text.ru ?? ""}`;
  const sharedSig = shared.map(sig).join("\n");
  return draft.questions.filter((q) => q.type !== "info" && q.options.map(sig).join("\n") !== sharedSig).length;
}

/**
 * Ряд таблицы баллов: ответ → номера вопросов → балл.
 *
 * В базе балл лежит на паре «шкала + вопрос» (scale_items.weight), а на
 * кадре — один на ряд. Ряд показывает вес первого своего пункта и при правке
 * проставляет его всем: это интерфейс к существующей модели, а не новая.
 * Ряд с matchKey null («бал відповіді») стоит, когда такие пункты уже есть —
 * и когда ответы теста не несут кодов вовсе: у методик с баллом варианта
 * (PHQ-9, «большая пятёрка») ключ шкалы только такой, и без этого ряда новой
 * шкале негде было бы набрать номера — «+» живёт внутри ряда, а рядов по
 * кодам нет. Ряд без кодов не выдуман, он единственный возможный; при кодах
 * же лишнего ряда нет, как и на кадре f24_2.
 */
export interface KeyRow {
  matchKey: string | null;
  items: number[];
  weight: number;
}

export function keyRows(scale: DraftScale, answers: DraftOption[]): KeyRow[] {
  const codes = answers.map((a) => a.keyCode ?? null).filter((c): c is string => !!c);
  const extra = [...new Set(scale.key.map((k) => k.matchKey ?? null))].filter(
    (c): c is string => !!c && !codes.includes(c),
  );
  const rows: KeyRow[] = [...codes, ...extra].map((matchKey) => rowFor(scale, matchKey));
  const scored = scale.key.some((k) => k.matchKey === null || k.matchKey === undefined);
  if (scored || !codes.length) rows.push(rowFor(scale, null));
  return rows;
}

function rowFor(scale: DraftScale, matchKey: string | null): KeyRow {
  const own = scale.key.filter((k) => (k.matchKey ?? null) === matchKey);
  return {
    matchKey,
    items: own.map((k) => k.item).sort((a, b) => a - b),
    weight: own[0]?.weight ?? 1,
  };
}

export function addRowItem(scale: DraftScale, matchKey: string | null, item: number): DraftScale {
  if (!Number.isInteger(item) || item < 1) return scale;
  if (scale.key.some((k) => (k.matchKey ?? null) === matchKey && k.item === item)) return scale;
  const weight = rowFor(scale, matchKey).weight;
  return { ...scale, key: [...scale.key, { item, matchKey, weight }] };
}

export function removeRowItem(scale: DraftScale, matchKey: string | null, item: number): DraftScale {
  return { ...scale, key: scale.key.filter((k) => !((k.matchKey ?? null) === matchKey && k.item === item)) };
}

export function setRowWeight(scale: DraftScale, matchKey: string | null, weight: number): DraftScale {
  return {
    ...scale,
    key: scale.key.map((k) => ((k.matchKey ?? null) === matchKey ? { ...k, weight } : k)),
  };
}

/**
 * Новая шкала с кодом, которого ещё нет.
 *
 * Код обязателен на сервере (латиница) и служит именем шкалы между версиями —
 * по нему строится динамика пациента. На кадре его нет, поэтому он выдаётся
 * сам («s1», «s2»…) и правится в «Психометриці» тем, кому нужен «Hs».
 */
export function newScale(existing: DraftScale[]): DraftScale {
  const taken = new Set(existing.map((s) => s.code));
  let n = existing.length + 1;
  while (taken.has(`s${n}`)) n++;
  return {
    uid: newUid(),
    code: `s${n}`,
    title: { uk: "", ru: "" },
    description: null,
    kind: "clinical",
    normalization: "raw",
    key: [],
    corrections: [],
    norms: [],
    stenTable: [],
    bands: [],
  };
}

/** Итоговая шкала комплексного теста — единственная, её полосы и есть «Результати» */
export function totalScale(): DraftScale {
  return { ...newScale([]), code: "total", title: { uk: UI["cn.results"].uk, ru: UI["cn.results"].ru } };
}

/**
 * Комплексный тест считается суммой баллов вариантов: ключ итоговой шкалы —
 * все вопросы без matchKey. Проставляется при отправке, а не при каждой
 * правке списка: так его нельзя забыть при добавлении вопроса, а веса,
 * заданные через JSON, сохраняются.
 */
export function withTotalKey(draft: Draft): Draft {
  if ((draft.mode ?? "specific") !== "complex") return draft;
  const first = draft.scales[0];
  if (!first) return draft;
  const weights = new Map(first.key.map((k) => [k.item, k.weight ?? 1]));
  const key = draft.questions.flatMap((q, i) =>
    q.type === "info" ? [] : [{ item: i + 1, matchKey: null, weight: weights.get(i + 1) ?? 1 }],
  );
  return { ...draft, scales: [{ ...first, key }, ...draft.scales.slice(1)] };
}

/**
 * Переключение вкладки перестраивает черновик, а не только вид.
 *
 * Вопросы и полосы остаются; меняется то, чем считается балл. В конкретный
 * тест варианты всех вопросов заменяются общим набором, в комплексный —
 * остаются каждый при своём вопросе, а шкал остаётся одна, итоговая (полосы
 * первой шкалы переходят к ней). Случайное переключение отменяется Ctrl+Z.
 */
export function switchMode(draft: Draft, mode: Mode): Draft {
  if ((draft.mode ?? "specific") === mode) return draft;
  if (mode === "specific") {
    const answers = draft.answers?.length ? draft.answers : deriveAnswers(draft.questions);
    return applyAnswers({ ...draft, mode }, answers);
  }
  const first = draft.scales[0];
  const total = first
    ? { ...first, key: first.key.map((k) => ({ ...k, matchKey: null })), corrections: [] }
    : totalScale();
  return { ...draft, mode, scales: [total] };
}

/**
 * Куда заводится тест: параметры «+ → Новий тест» из каталога.
 *
 * Каталог ведёт на /constructor?folder=<id>&group=<groupId>; папка без группы
 * на сервере невозможна, поэтому group без folder принимается, а folder без
 * group — нет: сервер отверг бы такое сохранение (err.surveyFolderOtherGroup).
 */
export function createTarget(search: string): { folderId: string | null; groupId: string | null } {
  const params = new URLSearchParams(search);
  const clean = (v: string | null) => (v && v !== "null" && v !== "undefined" ? v : null);
  const groupId = clean(params.get("group"));
  const folderId = groupId ? clean(params.get("folder")) : null;
  return { folderId, groupId };
}

export function parseItems(input: string): number[] {
  const out: number[] = [];
  for (const chunk of input.split(/[,\s]+/).filter(Boolean)) {
    const range = chunk.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(i);
    } else if (/^\d+$/.test(chunk)) {
      out.push(Number(chunk));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Свежий идентификатор строки конструктора */
export function newUid(): string {
  return crypto.randomUUID();
}

/**
 * Черновик в том виде, в каком его принимает API.
 *
 * uid, mode, answers и folderId — поля редактора, на сервере им делать
 * нечего: идентификаторы там выдаются заново при каждой новой версии, вид
 * теста читается по ключу, общий набор ответов уже скопирован в вопросы, а
 * папку при заведении подставляет экран отдельным полем.
 */
export function toPayload(draft: Draft): Omit<Draft, "questions" | "scales" | "mode" | "answers" | "folderId"> & {
  questions: Omit<DraftQuestion, "uid">[];
  scales: Omit<DraftScale, "uid">[];
} {
  const { questions, scales, mode: _m, answers: _a, folderId: _f, ...rest } = withTotalKey(draft);
  return {
    ...rest,
    questions: questions.map(({ uid: _q, ...q }) => q),
    scales: scales.map(({ uid: _s, ...sc }) => sc),
  };
}

/**
 * Восстановление черновика из localStorage: сохранённый до появления uid
 * (или руками правленный) их не имеет — проставляем, иначе список снова
 * поедет по индексам.
 */
export function withUids(draft: Draft): Draft {
  return {
    ...draft,
    questions: draft.questions.map((q) => (q.uid ? q : { ...q, uid: newUid() })),
    scales: draft.scales.map((sc) => (sc.uid ? sc : { ...sc, uid: newUid() })),
  };
}

/**
 * Черновик из чужих рук — JSON, старый автосейв — в вид, который умеет
 * показать эта форма: uid у строк, вид теста по ключу, общий набор ответов из
 * вопросов. Чего нет — выводится, что есть — не трогается.
 */
export function normalizeDraft(draft: Draft): Draft {
  const withIds = withUids(draft);
  return {
    ...withIds,
    mode: withIds.mode ?? deriveMode(withIds.scales),
    answers: withIds.answers?.length ? withIds.answers : deriveAnswers(withIds.questions),
  };
}

/**
 * Черновик как готовая методика — для проверки ключа прямо в редакторе.
 *
 * Перенос методики из пособия проверялся только после публикации: заполнить,
 * сдать, посмотреть баллы, вернуться в конструктор. Здесь тот же самый движок
 * подсчёта, что и на сервере (`computeProfile` из общего пакета), считает по
 * черновику — значит проверка отвечает на вопрос «верен ли ключ», а не «верна
 * ли ещё одна реализация ключа».
 *
 * Идентификаторы синтетические: у черновика их нет, а ключ ссылается на пункты
 * по номеру. Номер и становится идентификатором — ровно так же, как это делает
 * сервер при сохранении версии.
 */
export function draftToSurvey(source: Draft, lang: "uk" | "ru"): SurveyFull {
  const draft = withTotalKey(source);
  const text = (value: Record<string, string> | null | undefined): string =>
    value?.[lang] || value?.uk || value?.ru || "";

  const questions = draft.questions.map((q, i) => ({
    id: `q${i + 1}`,
    surveyId: "draft",
    versionId: "draft",
    type: q.type as never,
    title: text(q.title),
    help: q.help ? text(q.help) : null,
    required: q.required,
    position: i,
    sectionId: null,
    randomizeOptions: false,
    minValue: null,
    maxValue: null,
    step: null,
    logic: [],
    options: q.options.map((o, k) => ({
      id: `q${i + 1}o${k + 1}`,
      questionId: `q${i + 1}`,
      kind: "option" as const,
      text: text(o.text),
      score: o.score ?? 0,
      keyCode: o.keyCode ?? null,
      riskFlag: o.riskFlag ?? false,
      riskLabel: o.riskLabel ? text(o.riskLabel) : null,
      riskSeverity: o.riskSeverity ?? null,
      position: k,
    })),
  }));

  const scales = draft.scales.map((sc, i) => ({
    id: `s${i + 1}`,
    surveyId: "draft",
    code: sc.code,
    title: text(sc.title),
    description: sc.description ? text(sc.description) : null,
    aggregation: (sc.aggregation ?? "sum") as never,
    position: i,
    kind: sc.kind as never,
    normalization: sc.normalization as never,
    ratioDenominator: sc.ratioDenominator ?? null,
    validityThreshold: sc.validityThreshold ?? null,
    validityDirection: (sc.validityDirection ?? null) as never,
    validityMessage: sc.validityMessage ? text(sc.validityMessage) : null,
    bands: sc.bands.map((b) => ({
      minScore: b.minScore,
      maxScore: b.maxScore,
      label: text(b.label),
      severity: b.severity as never,
      grade: b.grade ?? null,
      recommendation: b.recommendation ? text(b.recommendation) : null,
      cascadeBatteryId: b.cascadeBatteryId ?? null,
      cascadeDueDays: b.cascadeDueDays ?? null,
      followUpDays: b.followUpDays ?? null,
    })),
    /*
     * Ключ ссылается на пункт по номеру. Ссылка за пределы списка — не повод
     * падать: в редакторе пункт могли только что удалить, и проверка обязана
     * это показать, а не сломаться.
     */
    items: sc.key
      .filter((k) => k.item >= 1 && k.item <= questions.length)
      .map((k) => ({
        questionId: `q${k.item}`,
        matchKey: k.matchKey ?? null,
        weight: k.weight ?? 1,
      })),
    corrections: sc.corrections.map((c) => ({
      sourceScaleCode: c.from,
      coefficient: c.coefficient,
    })),
    norms: sc.norms.map((n) => ({
      sex: n.sex ?? null,
      ageMin: null,
      ageMax: null,
      mean: n.mean,
      sd: n.sd,
      source: null,
    })),
    stenTable: sc.stenTable,
  }));

  return {
    id: "draft",
    groupId: draft.groupId ?? null,
    title: text(draft.title),
    description: draft.description ? text(draft.description) : null,
    instructions: draft.instructions ? text(draft.instructions) : null,
    safetyPlan: draft.safetyPlan ? text(draft.safetyPlan) : null,
    administration: draft.administration,
    status: "draft",
    visibility: draft.visibility,
    scoringEnabled: draft.scoringEnabled,
    allowRetake: draft.allowRetake,
    showProgress: draft.showProgress,
    allowBack: draft.allowBack,
    anonymous: draft.anonymous,
    randomizeQuestions: draft.randomizeQuestions,
    timeLimitSec: draft.timeLimitSec ?? null,
    tooFastMs: draft.tooFastMs ?? null,
    alertEscalateMinutes: draft.alertEscalateMinutes ?? null,
    showResultsToPatient: draft.showResultsToPatient ?? false,
    sections: [],
    questions,
    scales,
    versionId: null,
    versionNumber: 0,
  } as unknown as SurveyFull;
}
