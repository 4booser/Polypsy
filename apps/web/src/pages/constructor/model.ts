import { UI, type Administration, type Lang, type SurveyFull, type SurveyGroupWithCounts, type UiKey } from "@quizzy/shared";

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
  /**
   * Секции версии — переносятся как есть: своего редактора у них в
   * конструкторе нет, но вопросы ссылаются на них (DraftQuestion.sectionKey),
   * и пустой список раньше молча снимал разбиение методики на части.
   */
  sections: DraftSection[];
  questions: DraftQuestion[];
  scales: DraftScale[];

  /* ── поля редактора: на сервер не уходят ── */

  /**
   * Версия, от которой начата правка (versionId открытой методики).
   *
   * Уходит на сервер как baseVersionId: если между открытием и сохранением
   * методику сохранил кто-то другой, сервер отвечает 409, а не пишет поверх
   * чужой правки (волна 12). Хранится в черновике, а не в состоянии экрана:
   * восстановленный вчерашний автосейв обязан сверяться с той версией, от
   * которой его начали, а не с сегодняшней.
   */
  baseVersionId?: string | null;
  /**
   * Итоговый ключ комплексного теста собирает сам конструктор (withTotalKey).
   *
   * Для теста, заведённого здесь, — да: ключ итоговой шкалы — все пункты.
   * Для сохранённой методики — только если её ключ уже таков (toDraft):
   * иначе сохранение без единой правки переписывало ключ встроенной
   * методики на «все пункты» — и пункт, который пособие в итог не
   * включает, начинал считаться. Не задано — собирает (старые черновики).
   */
  totalKeyManaged?: boolean;

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
  /**
   * Идентификатор варианта на время правки — то же, что DraftQuestion.uid,
   * для строк ответов и их полей.
   *
   * Варианты шли по номеру, и удаление среднего ответа сдвигало список: поле
   * «текст ответа 2» оставалось тем же узлом DOM и получало текст третьего,
   * курсор и выделение — в нём же, а раскрытые «Налаштування варіантів»
   * переезжали к соседу. Необязательно по типу: черновик из JSON и старый
   * автосейв его не несут, и normalizeDraft (withUids) доставляет его сам.
   * На сервер не уходит (toPayload).
   */
  uid?: string;
  text: Record<string, string>;
  score?: number;
  keyCode?: string | null;
  riskFlag?: boolean;
  riskLabel?: Record<string, string> | null;
  riskSeverity?: "moderate" | "severe" | null;
  /** Вариант или строка матрицы; без него — вариант */
  kind?: "option" | "row";
}

/** Секция версии: ключ — её id, на него ссылаются вопросы */
export interface DraftSection {
  key: string;
  title: Record<string, string>;
  description?: Record<string, string> | null;
}

/**
 * Условие показа вопроса.
 *
 * Источник — по uid вопроса, а не по номеру, как у сервера (sourceIndex):
 * номер в редакторе меняется при каждом ↑/↓, удалении и копии, и условие
 * «показать, если на вопрос 4 ответили “так”» молча переезжало бы на
 * соседа. Номер вычисляется при отправке (toPayload); условие, чей
 * источник удалён, не уходит вовсе. Значение (id варианта прежней версии)
 * сервер сам переводит на вариант новой (remapOptionRefs).
 */
export interface DraftLogic {
  sourceUid: string;
  operator: string;
  value?: unknown;
  action: "show" | "hide";
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

  /*
   * Поля версии, у которых в конструкторе нет своего редактора. Они не
   * «лишние»: по ним считается и поднимает тревогу методика — обратный
   * ключ, порог риска числового пункта, шкала пункта, условия показа,
   * границы шкалы. Черновик их переносит (toDraft → toPayload), и сохранение
   * без правки даёт ту же версию, а не урезанную (волна 12, находка
   * участка engine).
   */
  sectionKey?: string | null;
  scaleCode?: string | null;
  reverseScored?: boolean;
  minValue?: number | null;
  maxValue?: number | null;
  step?: number | null;
  minLabel?: Record<string, string> | null;
  maxLabel?: Record<string, string> | null;
  randomizeOptions?: boolean;
  timeLimitSec?: number | null;
  riskThreshold?: number | null;
  riskLabel?: Record<string, string> | null;
  riskSeverity?: "moderate" | "severe" | null;
  logic?: DraftLogic[];
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
  /** Доля отвеченных, ниже которой балл не вычисляется (движок, волна 12); null — умолчание движка */
  minAnsweredShare?: number | null;
  key: { item: number; matchKey?: string | null; weight?: number }[];
  corrections: { from: string; coefficient: number }[];
  /* возраст и источник нормы, пол и возраст строки стенов — страты, без них норма считается не по той группе */
  norms: {
    sex?: "male" | "female" | null;
    ageMin?: number | null;
    ageMax?: number | null;
    mean: number;
    sd: number;
    source?: string | null;
  }[];
  stenTable: {
    sex?: "male" | "female" | null;
    ageMin?: number | null;
    ageMax?: number | null;
    rawMin: number;
    rawMax: number;
    sten: number;
  }[];
  bands: DraftBand[];
}

export interface DraftBand {
  /** См. DraftOption.uid — то же для строк «від · до · текст» результатов */
  uid?: string;
  minScore: number;
  maxScore: number;
  label: Record<string, string>;
  severity: "none" | "mild" | "moderate" | "severe";
  /** Описание полосы — текст для специалиста под названием; редактора нет, переносится */
  description?: Record<string, string> | null;
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
  { uid: newUid(), text: { uk: UI["bp.yes"].uk, ru: UI["bp.yes"].ru }, keyCode: "yes" },
  { uid: newUid(), text: { uk: UI["bp.no"].uk, ru: UI["bp.no"].ru }, keyCode: "no" },
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
  /* необязательный текст: null остаётся null, а не пустым объектом — сервер различает «нет» и «пусто» */
  const locOrNull = (v: unknown): Record<string, string> | null => (v ? loc(v) : null);
  const indexById = new Map(s.questions.map((q, i) => [q.id, i + 1]));
  const scaleCodeById = new Map(s.scales.map((sc) => [sc.id, sc.code]));

  /*
   * Всё, что принимает запись версии (questionInputSchema и соседи), —
   * переносится, даже если своего поля в конструкторе нет. Образец —
   * versionContent на сервере (apps/api/src/lib/surveys.ts): круговой путь
   * «версия → черновик → payload» обязан давать то же содержимое, и это
   * проверяется для каждой встроенной методики и всего каталога
   * (apps/api/test/constructorRoundtrip.test.ts).
   */
  const questions: DraftQuestion[] = s.questions.map((q) => ({
    uid: q.id,
    type: q.type,
    title: loc(q.title),
    help: locOrNull(q.help),
    required: q.required,
    sectionKey: q.sectionId ?? null,
    scaleCode: q.scaleId ? (scaleCodeById.get(q.scaleId) ?? null) : null,
    reverseScored: q.reverseScored ?? false,
    minValue: q.minValue ?? null,
    maxValue: q.maxValue ?? null,
    step: q.step ?? null,
    minLabel: locOrNull(q.minLabel),
    maxLabel: locOrNull(q.maxLabel),
    randomizeOptions: q.randomizeOptions ?? false,
    timeLimitSec: q.timeLimitSec ?? null,
    riskThreshold: q.riskThreshold ?? null,
    riskLabel: locOrNull(q.riskLabel),
    riskSeverity: q.riskSeverity ?? null,
    options: q.options.map((o) => ({
      uid: o.id,
      text: loc(o.text),
      score: o.score,
      kind: o.kind ?? "option",
      keyCode: o.keyCode,
      riskFlag: o.riskFlag,
      riskLabel: locOrNull(o.riskLabel),
      riskSeverity: o.riskSeverity,
    })),
    /* источник — по uid вопроса (= его id в этой версии), см. DraftLogic */
    logic: (q.logic ?? []).map((rule) => ({
      sourceUid: rule.sourceQuestionId,
      operator: rule.operator,
      value: rule.value,
      action: rule.action,
    })),
  }));

  const scales: DraftScale[] = s.scales.map((sc) => ({
    uid: sc.id,
    code: sc.code,
    title: loc(sc.title),
    description: locOrNull(sc.description),
    kind: sc.kind,
    normalization: sc.normalization,
    aggregation: sc.aggregation,
    ratioDenominator: sc.ratioDenominator,
    validityThreshold: sc.validityThreshold,
    validityDirection: sc.validityDirection,
    validityMessage: locOrNull(sc.validityMessage),
    minAnsweredShare: sc.minAnsweredShare ?? null,
    key: sc.items.flatMap((i) => {
      const item = indexById.get(i.questionId);
      return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
    }),
    corrections: sc.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
    norms: sc.norms.map((n) => ({ sex: n.sex, ageMin: n.ageMin, ageMax: n.ageMax, mean: n.mean, sd: n.sd, source: n.source })),
    stenTable: sc.stenTable.map((r) => ({
      sex: r.sex,
      ageMin: r.ageMin,
      ageMax: r.ageMax,
      rawMin: r.rawMin,
      rawMax: r.rawMax,
      sten: r.sten,
    })),
    bands: sc.bands.map((b) => ({
      uid: b.id,
      minScore: b.minScore,
      maxScore: b.maxScore,
      label: loc(b.label),
      severity: b.severity,
      description: locOrNull(b.description),
      grade: b.grade,
      recommendation: locOrNull(b.recommendation),
      cascadeBatteryId: b.cascadeBatteryId,
      cascadeDueDays: b.cascadeDueDays,
      followUpDays: b.followUpDays,
    })),
  }));

  const mode = deriveMode(scales);
  return {
    title: loc(s.title),
    description: locOrNull(s.description),
    instructions: locOrNull(s.instructions),
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
    safetyPlan: locOrNull(s.safetyPlan),
    showResultsToPatient: s.showResultsToPatient,
    sections: (s.sections ?? []).map((sec) => ({ key: sec.id, title: loc(sec.title), description: locOrNull(sec.description) })),
    questions,
    scales,
    mode,
    answers: deriveAnswers(questions),
    baseVersionId: s.versionId ?? null,
    totalKeyManaged: mode === "complex" && coversAllItems(scales[0], questions),
  };
}

/**
 * Ключ шкалы — ровно «все пункты, кроме информационных, без ожидаемого
 * ответа»: такой ключ withTotalKey воспроизводит сам, и ему можно доверить
 * сборку итога после правки. Любой другой ключ — пособия, и трогать его
 * конструктор не вправе.
 */
function coversAllItems(scale: DraftScale | undefined, questions: DraftQuestion[]): boolean {
  if (!scale) return true;
  const all = questions.flatMap((q, i) => (q.type === "info" ? [] : [i + 1]));
  const keyed = new Set(scale.key.filter((k) => (k.matchKey ?? null) === null).map((k) => k.item));
  return scale.key.length === all.length && all.every((n) => keyed.has(n));
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
  // ключ сохранённой методики, собранный не конструктором, — ключ пособия (см. Draft.totalKeyManaged)
  if (draft.totalKeyManaged === false) return draft;
  const first = draft.scales[0];
  if (!first) return draft;
  const weights = new Map(first.key.map((k) => [k.item, k.weight ?? 1]));
  const key = draft.questions.flatMap((q, i) =>
    q.type === "info" ? [] : [{ item: i + 1, matchKey: null, weight: weights.get(i + 1) ?? 1 }],
  );
  /* тот же ключ другим порядком — не правка: порядок строк ключа для подсчёта ничего не значит */
  const same = (k: DraftScale["key"][number]) => `${k.item}\0${k.matchKey ?? ""}\0${k.weight ?? 1}`;
  if (key.length === first.key.length && new Set(first.key.map(same)).size === key.length && key.every((k) => first.key.some((x) => same(x) === same(k)))) {
    return draft;
  }
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
  /* переключение в комплексный — явное «итог — все пункты»: ключ дальше собирает конструктор */
  return { ...draft, mode, scales: [total], totalKeyManaged: true };
}

/**
 * Одно сохранение за раз.
 *
 * Кнопки «Створити» и «Опублікувати» гаснут на время сохранения, а Ctrl+S —
 * нет: клавиша не знает о состоянии кнопок, а удержанная клавиша повторяет
 * нажатие десяток раз в секунду. Каждое нажатие начинало своё сохранение, и
 * новая методика заводилась столько раз, сколько раз повторилась клавиша.
 * Признак живёт в объекте, а не в состоянии React: решение принимается в
 * момент нажатия, до перерисовки. Возвращает, пошло ли действие.
 */
export async function oneAtATime(gate: { busy: boolean }, run: () => Promise<void>): Promise<boolean> {
  if (gate.busy) return false;
  gate.busy = true;
  try {
    await run();
    return true;
  } finally {
    gate.busy = false;
  }
}

/*
 * Правка списка вопросов — удаление, перестановка, копия.
 *
 * Ключ шкалы ссылается на пункт НОМЕРОМ (DraftScale.key[].item — номер с
 * единицы), как у сервера: так его печатает пособие («Так → 3, 5, 7»), и
 * так его набирают в таблице баллов. Список вопросов при этом правился сам
 * по себе: удалили третий пункт — четвёртый стал третьим, а ключ остался
 * «3, 5, 7» и молча начал считать бывшие четвёртый, шестой и восьмой. На
 * экране это не видно ничем: таблица баллов показывает те же номера, что и
 * до удаления, и методика продолжает выдавать правдоподобные баллы — не за
 * те ответы. Условия показа от этого уже вылечены (DraftLogic ссылается на
 * uid); ключ шкалы остаётся номерным, поэтому номера в нём переписываются
 * вместе со списком — здесь, одной функцией на каждое действие.
 */

/** Переписать номера пунктов во всех ключах: `to(n)` — новый номер или null, если пункта больше нет */
function renumberKeys(scales: DraftScale[], to: (item: number) => number | null): DraftScale[] {
  return scales.map((sc) => {
    let changed = false;
    const key = sc.key.flatMap((k) => {
      const next = to(k.item);
      if (next === k.item) return [k];
      changed = true;
      return next === null ? [] : [{ ...k, item: next }];
    });
    return changed ? { ...sc, key } : sc;
  });
}

/** Удалить вопрос `i` (с нуля): его строки ключа уходят, номера после него сдвигаются вверх */
export function removeQuestion(draft: Draft, i: number): Draft {
  if (i < 0 || i >= draft.questions.length) return draft;
  const gone = i + 1;
  return {
    ...draft,
    questions: draft.questions.filter((_, k) => k !== i),
    scales: renumberKeys(draft.scales, (n) => (n === gone ? null : n > gone ? n - 1 : n)),
  };
}

/** Переставить вопрос `i` на `delta` мест: ключ идёт за вопросом, а не остаётся на месте */
export function moveQuestion(draft: Draft, i: number, delta: number): Draft {
  const j = i + delta;
  if (i < 0 || i >= draft.questions.length || j < 0 || j >= draft.questions.length || j === i) return draft;
  const next = [...draft.questions];
  [next[i], next[j]] = [next[j]!, next[i]!];
  const a = i + 1;
  const b = j + 1;
  return { ...draft, questions: next, scales: renumberKeys(draft.scales, (n) => (n === a ? b : n === b ? a : n)) };
}

/**
 * Копия вопроса `i` встаёт сразу за ним. Копия — новый пункт: в ключ она
 * не попадает (решать, считать ли её, — автору), а номера пунктов после неё
 * сдвигаются вниз.
 */
export function duplicateQuestion(draft: Draft, i: number): Draft {
  const source = draft.questions[i];
  if (!source) return draft;
  const copy = { ...structuredClone(source), uid: newUid() };
  const next = [...draft.questions];
  next.splice(i + 1, 0, copy);
  const at = i + 1;
  return { ...draft, questions: next, scales: renumberKeys(draft.scales, (n) => (n > at ? n + 1 : n)) };
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
 * Ключ строки варианта или полосы в разметке.
 *
 * uid у них необязателен по типу (см. DraftOption.uid), и запасной ключ
 * нужен только строке, пришедшей мимо normalizeDraft; помечен он так, чтобы
 * не совпасть ни с одним uid.
 */
export function optionKey(row: { uid?: string }, index: number): string {
  return row.uid ?? `@${index}`;
}

/**
 * Черновик в том виде, в каком его принимает API.
 *
 * uid, mode, answers, folderId и totalKeyManaged — поля редактора, на
 * сервере им делать нечего: идентификаторы там выдаются заново при каждой
 * новой версии, вид теста читается по ключу, общий набор ответов уже
 * скопирован в вопросы, а папку при заведении подставляет экран отдельным
 * полем. baseVersionId уходит — это сверка версий (см. Draft.baseVersionId).
 *
 * Всё остальное уходит полностью, в том числе поля без своего редактора
 * (DraftQuestion, «поля версии»): для нетронутого черновика результат
 * совпадает с тем, что сервер сам перенёс бы из действующей версии
 * (versionContent) — ключ, собранный по коду шкалы, уходит пустым, как там,
 * а условие показа — номером источника на момент отправки.
 */
export function toPayload(draft: Draft) {
  const {
    questions,
    scales,
    mode: _m,
    answers: _a,
    folderId: _f,
    totalKeyManaged: _t,
    sections,
    ...rest
  } = withTotalKey(draft);
  const indexByUid = new Map(questions.map((q, i) => [q.uid, i]));

  return {
    ...rest,
    sections: (sections ?? []).map((sec) => ({ key: sec.key, title: sec.title, description: sec.description ?? null })),
    questions: questions.map(({ uid: _q, options, logic, ...q }) => ({
      ...q,
      options: options.map(({ uid: _o, ...o }) => o),
      /* источник удалён — условия нет: ссылаться ему не на что */
      logic: (logic ?? []).flatMap((rule) => {
        const sourceIndex = indexByUid.get(rule.sourceUid);
        return sourceIndex === undefined
          ? []
          : [{ sourceIndex, operator: rule.operator, value: rule.value, action: rule.action }];
      }),
    })),
    scales: scales.map(({ uid: _s, bands, ...sc }) => ({
      ...sc,
      key: derivedKey(sc, questions) ? [] : sc.key,
      bands: bands.map(({ uid: _b, ...b }) => b),
    })),
  };
}

/**
 * Ключ шкалы собран по коду шкалы у вопросов — отправляется пустым.
 *
 * То же правило, что у сервера (versionContent): ключ из одних пунктов,
 * помеченных кодом шкалы, без ожидаемого ответа и с весом 1, в версии не
 * хранится списком номеров — сервер собирает его по коду сам. Отправить его
 * списком значило бы заморозить: пункт, добавленный потом с тем же кодом,
 * в шкалу уже не попал бы.
 */
function derivedKey(scale: Pick<DraftScale, "code" | "key">, questions: Pick<DraftQuestion, "scaleCode">[]): boolean {
  const linked = new Set(questions.flatMap((q, i) => (q.scaleCode === scale.code ? [i + 1] : [])));
  return (
    scale.key.length === linked.size &&
    scale.key.every((k) => (k.matchKey ?? null) === null && (k.weight ?? 1) === 1 && linked.has(k.item))
  );
}

/**
 * Восстановление черновика из localStorage: сохранённый до появления uid
 * (или руками правленный) их не имеет — проставляем, иначе список снова
 * поедет по индексам.
 */
export function withUids(draft: Draft): Draft {
  const keyed = <T extends { uid?: string }>(row: T): T & { uid: string } =>
    (row.uid ? row : { ...row, uid: newUid() }) as T & { uid: string };
  return {
    ...draft,
    questions: draft.questions.map((q) => ({ ...keyed(q), options: (q.options ?? []).map(keyed) })),
    scales: draft.scales.map((sc) => ({ ...keyed(sc), bands: (sc.bands ?? []).map(keyed) })),
    ...(draft.answers ? { answers: draft.answers.map(keyed) } : {}),
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
export function draftToSurvey(source: Draft, lang: Lang): SurveyFull {
  const draft = withTotalKey(source);
  const text = (value: Record<string, string> | null | undefined): string =>
    value?.[lang] || value?.uk || value?.ru || "";

  /*
   * Поля версии, у которых нет редактора (обратный ключ, шкала пункта,
   * границы, условия), в проверку ключа идут тоже: иначе предпросмотр
   * считал бы пункты с обратным ключом прямыми и показывал бы не тот балл,
   * что посчитает сервер. Условие показа ссылается на варианты id прежней
   * версии — они переводятся на синтетические id этой (по uid варианта).
   */
  const scaleIdByCode = new Map(draft.scales.map((sc, i) => [sc.code, `s${i + 1}`]));
  const questionIdByUid = new Map(draft.questions.map((q, i) => [q.uid, `q${i + 1}`]));
  const optionIdByUid = new Map(
    draft.questions.flatMap((q, i) => q.options.flatMap((o, k) => (o.uid ? [[o.uid, `q${i + 1}o${k + 1}`] as const] : []))),
  );
  const remap = (v: unknown): unknown =>
    typeof v === "string" ? (optionIdByUid.get(v) ?? v) : Array.isArray(v) ? v.map(remap) : v;

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
    scaleId: q.scaleCode ? (scaleIdByCode.get(q.scaleCode) ?? null) : null,
    reverseScored: q.reverseScored ?? false,
    randomizeOptions: q.randomizeOptions ?? false,
    minValue: q.minValue ?? null,
    maxValue: q.maxValue ?? null,
    step: q.step ?? null,
    minLabel: q.minLabel ? text(q.minLabel) : null,
    maxLabel: q.maxLabel ? text(q.maxLabel) : null,
    timeLimitSec: q.timeLimitSec ?? null,
    riskThreshold: q.riskThreshold ?? null,
    riskLabel: q.riskLabel ? text(q.riskLabel) : null,
    riskSeverity: q.riskSeverity ?? null,
    logic: (q.logic ?? []).flatMap((rule, r) => {
      const source = questionIdByUid.get(rule.sourceUid);
      return source
        ? [{ id: `q${i + 1}l${r + 1}`, questionId: `q${i + 1}`, sourceQuestionId: source, operator: rule.operator, value: remap(rule.value), action: rule.action }]
        : [];
    }),
    options: q.options.map((o, k) => ({
      id: `q${i + 1}o${k + 1}`,
      questionId: `q${i + 1}`,
      kind: o.kind ?? "option",
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
    minAnsweredShare: sc.minAnsweredShare ?? null,
    bands: sc.bands.map((b) => ({
      minScore: b.minScore,
      maxScore: b.maxScore,
      label: text(b.label),
      severity: b.severity as never,
      description: b.description ? text(b.description) : null,
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
      ageMin: n.ageMin ?? null,
      ageMax: n.ageMax ?? null,
      mean: n.mean,
      sd: n.sd,
      source: n.source ?? null,
    })),
    stenTable: sc.stenTable.map((r) => ({
      sex: r.sex ?? null,
      ageMin: r.ageMin ?? null,
      ageMax: r.ageMax ?? null,
      rawMin: r.rawMin,
      rawMax: r.rawMax,
      sten: r.sten,
    })),
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
