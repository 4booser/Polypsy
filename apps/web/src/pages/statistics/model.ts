import type {
  SampleFilters,
  StatCell,
  StatModel,
  StatModelColumn,
  StatModelColumnInput,
  StatRunColumn,
  UiKey,
} from "@quizzy/shared";

/**
 * Чистая часть раздела «Статистика»: адреса, строки-критерии выборки,
 * черновик структуры модели ↔ колонки на сервере, печать ячеек отчёта.
 *
 * Вынесено из экранов ради проверки без React и сервера
 * (apps/web/test/statistics.test.ts). Главное, что здесь сторожится, — печать
 * ячейки: скрытая сервером ячейка обязана доехать до экрана прочерком, а не
 * числом, и разность колонок не имеет права «досчитать» скрытое вычитанием
 * (см. cellText, diffText).
 *
 * ── Как модель легла на кадры ──
 *
 * Модель на сервере — колонки-выборки, у каждой свои фильтры (или пресет),
 * методика и показатели (packages/shared/src/types.ts, StatModelColumn). На
 * кадрах это разнесено по экранам так:
 *
 *   f17 «Створити»          — ЧТО считаем: тест, варианты результата, вопросы
 *                             с ответами и пометкой «ВШР». Фильтров на кадре
 *                             нет — выборку задают на экране модели;
 *   f09/f18 модель          — ПО КОМУ считаем: карточка «Фільтри» одной
 *                             выборки и «Порівняти»;
 *   f29 две выборки рядом   — та же модель с двумя колонками: «+» в строке
 *                             заголовка добавляет выборку;
 *   f24 «Статистика»        — пресеты по колонкам, «Оновити», диаграмма;
 *   f23 «Створення фільтра» — пресеты фильтров.
 *
 * Отсюда правило: показатели у колонок одной модели одинаковые (их задаёт
 * f17 один раз), различаются колонки только выборкой. Сервер позволяет и
 * разные показатели в разных колонках — такую модель экран читает
 * поколоночно (каждая колонка печатает свои строки), а форма f17 при
 * сохранении приводит все колонки к структуре первой (columnsFromDraft).
 */

/* ─────────── адреса ─────────── */

/*
 * Адреса — литералами, а не склейкой от общей базы: сторож дверей
 * (apps/web/test/routeDoors.test.ts) ищет форму каждого маршрута среди
 * строк клиента, и склейка от константы для него — одни звёздочки, то
 * есть ни одной двери.
 */
export const STATS_LIST = "/statistics";
/** f17: форма новой модели — «+» перечня f08 */
export const STATS_NEW = "/statistics/new";
/** f24: вид «діаграма» — первая иконка строки заголовка f08 */
export const STATS_CHART = "/statistics/chart";
/** f23: «Створення фільтра» и «Пресети фільтрів» — пункт «Керувати фільтрами» шестерёнки f24 */
export const STATS_FILTERS = "/statistics/filters";

/** Модель: f09/f18/f29 */
export function statHref(id: string): string {
  return `/statistics/${id}`;
}

/** Та же форма f17 над сохранённой моделью: название, описание, структура, удаление */
export function statEditHref(id: string): string {
  return `/statistics/${id}/edit`;
}

/** Пресет в форме f23 */
export function presetHref(id: string): string {
  return `/statistics/filters/${id}`;
}

/* ─────────── строки-критерии ─────────── */

/**
 * Строка формы фильтра. Пять — с кадров (f09, f23, f29) и в их порядке;
 * шестая, «Група пацієнтів», кадром не нарисована, но сервер её умеет, и
 * живёт она за «+» формы пресета (f23) — см. Filters.tsx.
 *
 * «age» — одна строка «Вік від — Вік до», а не две: на кадре это один ряд с
 * одним «−», и убрать одну границу без второй «−» не умеет.
 */
export type Criterion = "date" | "patient" | "age" | "sex" | "locality" | "group";

export const FRAME_CRITERIA: readonly Criterion[] = ["date", "patient", "age", "sex", "locality"];
export const ALL_CRITERIA: readonly Criterion[] = [...FRAME_CRITERIA, "group"];

/**
 * Подпись критерия в чипе f24 и в меню «+» f23. «Віковий діапазон» — слово
 * чипа f24; в форме та же строка подписана двумя полями «Вік від / Вік до».
 */
export const CRITERION_LABEL: Record<Criterion, UiKey> = {
  date: "st.date",
  patient: "st.patient",
  age: "st.chipAge",
  sex: "person.sex",
  locality: "st.locality",
  group: "st.group",
};

/** Ключи фильтра, которые несёт каждая строка */
const CRITERION_FIELDS: Record<Criterion, (keyof SampleFilters)[]> = {
  date: ["from", "to"],
  patient: ["patientId"],
  age: ["ageMin", "ageMax"],
  sex: ["sex"],
  locality: ["locality"],
  group: ["patientGroupId"],
};

const filled = (v: unknown) => v !== null && v !== undefined && v !== "";

/**
 * Фильтры без пустых ключей.
 *
 * Пустая строка и null на сервере значат «критерия нет», но в сравнении и в
 * журнале они отличались бы от отсутствующего ключа: «те же фильтры» читались
 * бы как разные, и экран предлагал бы сохранить то, что не менялось.
 */
export function cleanFilters(f: SampleFilters | null | undefined): SampleFilters {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(f ?? {})) {
    const v = typeof raw === "string" ? raw.trim() : raw;
    if (filled(v)) out[key] = v;
  }
  return out as SampleFilters;
}

/** Какие строки-критерии заданы — в порядке кадра */
export function criteriaOf(f: SampleFilters | null | undefined): Criterion[] {
  const clean = cleanFilters(f);
  return ALL_CRITERIA.filter((c) => CRITERION_FIELDS[c].some((k) => filled(clean[k])));
}

/** Фильтры без указанных строк — «−» у строки формы и выключенный чип f24 */
export function withoutCriteria(f: SampleFilters | null | undefined, off: readonly Criterion[]): SampleFilters {
  const out = { ...cleanFilters(f) };
  for (const c of off) for (const k of CRITERION_FIELDS[c]) delete out[k];
  return out;
}

/** Одни и те же ли фильтры — по содержанию, а не по записи */
export function sameFilters(a: SampleFilters | null | undefined, b: SampleFilters | null | undefined): boolean {
  const x = cleanFilters(a);
  const y = cleanFilters(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]) as Set<keyof SampleFilters>;
  for (const k of keys) if (x[k] !== y[k]) return false;
  return true;
}

/* ─────────── колонки: рабочая копия экрана ↔ сервер ─────────── */

/** Колонка в том виде, в каком её принимает сервер: пресет либо свои фильтры */
export function columnInput(c: StatModelColumn): StatModelColumnInput {
  return {
    title: c.title,
    presetId: c.presetId,
    filters: c.presetId ? null : cleanFilters(c.filters),
    surveyId: c.surveyId,
    versionId: c.versionId,
    bands: c.bands,
    questions: c.questions,
  };
}

/** Изменилась ли рабочая копия против сохранённой — от этого зависит «Зберегти» и адрес расчёта */
export function columnsChanged(saved: readonly StatModelColumn[], work: readonly StatModelColumn[]): boolean {
  if (saved.length !== work.length) return true;
  return saved.some((s, i) => JSON.stringify(columnInput(s)) !== JSON.stringify(columnInput(work[i]!)));
}

/**
 * Новая выборка для сравнения — «+» строки заголовка модели (f09 → f29).
 *
 * Те же тест и показатели, что у последней колонки, а фильтры пустые: на
 * f29 вторая колонка повторяет строки первой один в один, а выборку человек
 * задаёт сам. Копировать фильтры значило бы получить две одинаковые колонки
 * — и первое, что с ними сделают, это сотрут скопированное.
 */
export function addSample(columns: readonly StatModelColumn[]): StatModelColumn[] {
  const last = columns[columns.length - 1];
  if (!last) return [...columns];
  return [...columns, { ...last, title: null, presetId: null, filters: {} }];
}

/** Потолок колонок — тот же, что у схемы сервера (statModelInputSchema, max 8) */
export const MAX_SAMPLES = 8;

/* ─────────── печать ячеек ─────────── */

/**
 * Прочерк скрытой ячейки — U+2014, из подмножества Onest (fonts.css,
 * U+2000–206F). Один знак на весь раздел: сервер прячет не только малые
 * числа, но и большие, если вместе с соседями они называют людей, — поэтому
 * «менше 5» здесь было бы неправдой, а прочерк не утверждает ничего.
 */
export const HIDDEN_MARK = "—";

/**
 * Ячейка отчёта строкой: «42%», прочерк за скрытой или пустота, пока расчёта
 * не было.
 *
 * Число берётся только из показанной ячейки. Скрытая приходит с сервера без
 * числа вовсе ({suppressed: true}), и здесь нет способа его «достать» — это
 * и есть граница, которую проверяет тест: даже если однажды сервер начнёт
 * присылать count рядом с suppressed, экран его не напечатает.
 */
export function cellText(cell: StatCell | null | undefined): string {
  if (!cell) return "";
  if (cell.suppressed) return HIDDEN_MARK;
  return `${cell.percent}%`;
}

/**
 * Разность долей двух колонок — плашка правой колонки f29.
 *
 * Печатается ТОЛЬКО когда обе ячейки показаны. Если скрыта хоть одна,
 * плашка пустая: разность показанной и скрытой — это скрытое, выписанное
 * через показанное, то есть ровно та утечка, ради которой сервер решает
 * систему (lib/privacy.ts). Разность двух показанных при этом ничего нового
 * не выдаёт — читатель посчитал бы её в уме.
 *
 * Минус — U+2212 (подмножество Onest), а не дефис: в столбце чисел дефис
 * короче плюса и сбивает выключку.
 */
export function diffText(a: StatCell | null | undefined, b: StatCell | null | undefined): string {
  if (!a || !b || a.suppressed || b.suppressed) return "";
  const d = b.percent - a.percent;
  if (d === 0) return "0";
  return d > 0 ? `+${d}` : `−${Math.abs(d)}`;
}

/* ─────────── строки отчёта колонки ─────────── */

/** Показатель колонки, опознанный в ответе расчёта по идентификатору */
export interface IndicatorCell {
  key: string;
  label: string;
  cell: StatCell;
}

/**
 * Показатели колонки в порядке экрана: полосы шкал, затем варианты ответов.
 *
 * Ключ — идентификатор полосы или варианта: по нему диаграмма f24 ставит
 * рядом столбики РАЗНЫХ колонок одного показателя. Сопоставление по месту в
 * списке разъехалось бы на первой модели, где у колонок разные показатели.
 */
export function indicatorsOf(col: StatRunColumn): IndicatorCell[] {
  return [
    ...col.scales.flatMap((s) => s.bands.map((b) => ({ key: `b:${b.bandId}`, label: b.label, cell: b.cell }))),
    ...col.questions.flatMap((q) => q.options.map((o) => ({ key: `o:${o.optionId}`, label: o.text, cell: o.cell }))),
  ];
}

/* ─────────── черновик структуры (f17) ─────────── */

let seq = 0;
const nextKey = (p: string) => `${p}${++seq}`;

export interface BandRow {
  key: string;
  /** «scaleId:bandId» — полоса однозначна только вместе со шкалой; "" — пустая строка */
  value: string;
  /** Пометка «ВШР» у полосы: на f17 её не рисуют, но сохранённая модель её несёт — не теряем */
  highRisk: boolean;
}

export interface OptionRow {
  key: string;
  optionId: string;
  highRisk: boolean;
}

export interface QuestionBlock {
  key: string;
  questionId: string;
  options: OptionRow[];
}

export interface StructureDraft {
  title: string;
  description: string;
  surveyId: string;
  bands: BandRow[];
  questions: QuestionBlock[];
}

export const newBandRow = (value = "", highRisk = false): BandRow => ({ key: nextKey("b"), value, highRisk });
export const newOptionRow = (optionId = "", highRisk = false): OptionRow => ({ key: nextKey("o"), optionId, highRisk });
export const newQuestionBlock = (questionId = "", options: OptionRow[] = []): QuestionBlock => ({
  key: nextKey("q"),
  questionId,
  options,
});

/**
 * Пустая форма — ровно кадр f17: блок теста с двумя строками «Варіант
 * результату» и один блок вопроса с двумя строками ответа.
 */
export function emptyStructure(): StructureDraft {
  return {
    title: "",
    description: "",
    surveyId: "",
    bands: [newBandRow(), newBandRow()],
    questions: [newQuestionBlock("", [newOptionRow(), newOptionRow()])],
  };
}

/**
 * Строк в группе на экране — выбранные плюс одна пустая, но не меньше двух.
 *
 * Пустая строка в конце — это и есть «добавить ещё»: выбрал в ней вариант —
 * появилась следующая. Кнопки «додати варіант» на кадре нет, а две строки
 * на кадре — это минимум, с которого форма начинается.
 */
export function withSpare<T>(rows: readonly T[], isEmpty: (r: T) => boolean, make: () => T, min = 2): T[] {
  const out = rows.filter((r) => !isEmpty(r));
  /* пустая строка берётся прежняя, а не новая: у неё тот же ключ, и фокус с неё не слетает */
  out.push([...rows].reverse().find(isEmpty) ?? make());
  while (out.length < min) out.push(make());
  return out;
}

/** Структура сохранённой модели — по первой колонке */
export function structureFromModel(model: StatModel): StructureDraft {
  const first = model.columns[0];
  if (!first) return { ...emptyStructure(), title: model.title, description: model.description ?? "" };
  return {
    title: model.title,
    description: model.description ?? "",
    surveyId: first.surveyId,
    bands: first.bands.map((b) => newBandRow(`${b.scaleId}:${b.bandId}`, b.highRisk)),
    questions: first.questions.map((q) =>
      newQuestionBlock(
        q.questionId,
        q.options.map((o) => newOptionRow(o.optionId, o.highRisk)),
      ),
    ),
  };
}

/** Показатели черновика в виде сервера: пустые строки и пустые блоки не едут */
function indicatorsFromDraft(draft: StructureDraft) {
  const seen = new Set<string>();
  const bands = draft.bands
    .filter((b) => b.value && !seen.has(b.value) && seen.add(b.value))
    .map((b) => {
      const [scaleId, bandId] = b.value.split(":") as [string, string];
      return { scaleId, bandId, highRisk: b.highRisk };
    });
  const questions = draft.questions
    .filter((q) => q.questionId)
    .map((q) => {
      const picked = new Set<string>();
      return {
        questionId: q.questionId,
        options: q.options
          .filter((o) => o.optionId && !picked.has(o.optionId) && picked.add(o.optionId))
          .map((o) => ({ optionId: o.optionId, highRisk: o.highRisk })),
      };
    })
    .filter((q) => q.options.length);
  return { bands, questions };
}

/**
 * Колонки для сервера из черновика f17.
 *
 * Новая модель — одна колонка без фильтров: выборку задают на экране модели
 * (f09). Правка — структура ложится на КАЖДУЮ колонку, а их выборки,
 * пресеты и подписи остаются: форма правит «что считаем», а не «по кому».
 * Версия не передаётся, если сменился тест: сервер возьмёт действующую и
 * запишет её (resolveColumns); при том же тесте версия колонки сохраняется,
 * иначе идентификаторы полос разошлись бы с версией.
 */
export function columnsFromDraft(
  draft: StructureDraft,
  existing: readonly StatModelColumn[] | null,
): StatModelColumnInput[] {
  const indicators = indicatorsFromDraft(draft);
  if (!existing?.length) {
    return [{ title: null, presetId: null, filters: {}, surveyId: draft.surveyId, ...indicators }];
  }
  return existing.map((c) => ({
    title: c.title,
    presetId: c.presetId,
    filters: c.presetId ? null : cleanFilters(c.filters),
    surveyId: draft.surveyId,
    versionId: c.surveyId === draft.surveyId ? c.versionId : null,
    ...indicators,
  }));
}

/** Что мешает сохранить черновик — ключи словаря, переводятся при печати */
export function validateStructure(draft: StructureDraft): UiKey[] {
  const errs: UiKey[] = [];
  if (!draft.title.trim()) errs.push("st.errTitle");
  if (!draft.surveyId) errs.push("st.errSurvey");
  const { bands, questions } = indicatorsFromDraft(draft);
  if (draft.surveyId && !bands.length && !questions.length) errs.push("st.errIndicators");
  return errs;
}

/* ─────────── подпись выборки (легенда f24) ─────────── */

/**
 * Выборка словами — строка легенды f24 («Group 1: Males, age 25-30, 30
 * users»): пол, возраст, город, период, группа, человек — через запятую, в
 * порядке кадра. Имена группы и человека сюда не едут: легенду читают
 * через плечо, а «кто в выборке» и так видно в её фильтрах на экране модели.
 */
export function describeSample(f: SampleFilters | null | undefined, t: (key: UiKey) => string): string {
  const c = cleanFilters(f);
  const parts: string[] = [];
  if (c.sex) parts.push(t(c.sex === "male" ? "nm.menCap" : "nm.womenCap"));
  if (c.ageMin != null || c.ageMax != null) parts.push(`${t("st.ageWord")} ${c.ageMin ?? ""}–${c.ageMax ?? ""}`);
  if (c.locality) parts.push(c.locality);
  if (c.from || c.to) {
    const day = (iso: string) => iso.split("-").reverse().join(".");
    parts.push(`${c.from ? day(c.from) : ""} – ${c.to ? day(c.to) : ""}`.trim());
  }
  if (c.patientGroupId) parts.push(t("st.group"));
  if (c.patientId) parts.push(t("st.patient"));
  return parts.length ? parts.join(", ") : t("st.everyone");
}
