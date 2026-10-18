import type {
  QuestionType,
  SampleFilters,
  Severity,
  StatCell,
  StatModel,
  StatModelColumn,
  StatModelColumnInput,
  StatRunColumn,
  SurveyFull,
  UiKey,
} from "@quizzy/shared";
import { pageOffset } from "../../ui/paging";

/**
 * Чистая часть раздела «Статистика»: адреса, строки-критерии выборки,
 * черновик структуры модели ↔ колонки на сервере, строки отчёта и печать
 * ячеек.
 *
 * Вынесено из экранов ради проверки без React и сервера
 * (apps/web/test/statistics.test.ts, statisticsFilters.test.ts). Главное,
 * что здесь сторожится, — печать ячейки: скрытая сервером ячейка обязана
 * доехать до экрана прочерком, а не числом, и разность колонок не имеет
 * права «досчитать» скрытое вычитанием (см. cellText, diffText).
 *
 * ── Как модель легла на экраны «Виразної» ──
 *
 * Модель на сервере — колонки-выборки, у каждой свои фильтры (или пресет),
 * методика с версией и показатели (packages/shared/src/types.ts,
 * StatModelColumn). На экранах это разнесено так:
 *
 *   редактор модели   — ЧТО считаем: тест и версия, смуги результату,
 *                       питання з відповідями і позначкою «ВШР»;
 *   модель            — ПО КОМУ считаем: выборки рядом, фильтры каждой — в
 *                       ящике, «Порівняти» и таблица долей;
 *   графік            — те же доли полосами, критерии выборок снимаются на
 *                       один запуск, пресет — к выбранным выборкам;
 *   фільтри вибірки   — пресеты фильтров.
 *
 * Отсюда правило: показатели у колонок одной модели одинаковые (их задаёт
 * редактор один раз), различаются колонки только выборкой. Сервер позволяет
 * и разные показатели в разных колонках — такую модель экран читает
 * построчно по объединению (reportRows), а редактор при сохранении приводит
 * все колонки к структуре первой (columnsFromDraft).
 */

/* ─────────── адреса ─────────── */

/*
 * Адреса — литералами, а не склейкой от общей базы: сторож дверей
 * (apps/web/test/routeDoors.test.ts) ищет форму каждого маршрута среди
 * строк клиента, и склейка от константы для него — одни звёздочки, то
 * есть ни одной двери.
 */
export const STATS_LIST = "/statistics";
/** Редактор новой модели */
export const STATS_NEW = "/statistics/new";
/** Графік: те же доли полосами */
export const STATS_CHART = "/statistics/chart";
/** Пресеты фильтров: перечень и новый пресет */
export const STATS_FILTERS = "/statistics/filters";

/** Модель: выборки рядом и «Порівняти» */
export function statHref(id: string): string {
  return `/statistics/${id}`;
}

/** Редактор сохранённой модели: название, описание, структура, удаление */
export function statEditHref(id: string): string {
  return `/statistics/${id}/edit`;
}

/** Пресет фильтров */
export function presetHref(id: string): string {
  return `/statistics/filters/${id}`;
}

/** Графік, открытый на модели */
export function chartHref(id: string): string {
  return `/statistics/chart?model=${encodeURIComponent(id)}`;
}

/* ─────────── адрес перечня ─────────── */

/*
 * Пределы перечня моделей у сервера (statModelListQuery): поиск ≤ 200,
 * смещение ≤ LIST_OFFSET_MAX (5 000 с #205). «?page=999999» из руки или
 * закладки давал смещение за пределом, и перечень открывался отказом
 * «Невірний запит» — вместо того чтобы вернуть человека на последнюю
 * страницу (это экран делает сам, как только узнает число моделей).
 */
const LIST_SEARCH_MAX = 200;

/** Параметры GET /api/stat-models для перечня моделей */
export function statListQuery(q: string, page: number, per: number): { q: string; limit: number; offset: number } {
  return {
    q: q.trim().slice(0, LIST_SEARCH_MAX),
    limit: per,
    offset: pageOffset(page, per),
  };
}

/**
 * Какая модель выбрана на графике.
 *
 * Перечень приходит целиком (без ?limit сервер отдаёт все модели, что
 * человеку видны), поэтому модель из адреса, которой в нём нет, — чужая,
 * удалённая или опечатка. Раньше экран всё равно просил её у сервера,
 * получал отказ и молчал о нём: ни строк выборок, ни подсвеченной модели,
 * погашенное «Оновити» — пустой экран без объяснения. Теперь такая ссылка
 * открывает первую модель, как и адрес без модели: то же правило, что у
 * списка пациентов с удалённой группой в адресе.
 *
 * Пока перечень не приехал, модель из адреса грузится сразу, не дожидаясь
 * его: у верной ссылки это экономит один круг до сервера.
 */
export function pickedModel(raw: string | null, list: readonly { id: string }[] | null): string | null {
  const wanted = raw?.trim() || null;
  if (!list) return wanted;
  if (wanted && list.some((m) => m.id === wanted)) return wanted;
  return list[0]?.id ?? null;
}

/* ─────────── строки-критерии ─────────── */

/**
 * Строка-критерий выборки. «age» — одна строка «Вік від — Вік до», «date» —
 * один период «від — до»: убрать одну границу без второй умеет само поле.
 */
export type Criterion = "date" | "patient" | "age" | "sex" | "locality" | "group";

export const ALL_CRITERIA: readonly Criterion[] = ["date", "patient", "age", "sex", "locality", "group"];

/** Подпись критерия в чипе выборки и в «Додати умову» пресета */
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

/** Какие строки-критерии заданы — в порядке формы */
export function criteriaOf(f: SampleFilters | null | undefined): Criterion[] {
  const clean = cleanFilters(f);
  return ALL_CRITERIA.filter((c) => CRITERION_FIELDS[c].some((k) => filled(clean[k])));
}

/** Фильтры без указанных строк — «прибрати умову» пресета и выключенный чип графика */
export function withoutCriteria(f: SampleFilters | null | undefined, off: readonly Criterion[]): SampleFilters {
  const out = { ...cleanFilters(f) };
  for (const c of off) for (const k of CRITERION_FIELDS[c]) delete out[k];
  return out;
}

/**
 * Что в фильтрах набрано наоборот — ключи словаря.
 *
 * Решение заказчика 2026-09-26: адекватные фильтры. «Вік від 45 — Вік до
 * 25» и период с концом раньше начала сервер отвергает (sampleFiltersSchema),
 * но отказ приходил после нажатия и строкой схемы, а не словами экрана.
 * Теперь поле краснеет сразу, а «Зберегти» и «Порівняти» называют причину
 * и не уходят на сервер. Ключи — те же, что у «Добору людей»: одна и та же
 * ошибка набора не должна звучать в двух разделах по-разному.
 */
export function filterErrors(f: SampleFilters | null | undefined): UiKey[] {
  const c = cleanFilters(f);
  const out: UiKey[] = [];
  if (c.ageMin != null && c.ageMax != null && c.ageMin > c.ageMax) out.push("coh.errAge");
  if (c.from && c.to && c.from > c.to) out.push("coh.errPeriod");
  return out;
}

/**
 * Почему пресет фильтра нельзя сохранить — ключ словаря или null.
 *
 * Сначала название: без него пресет не найти в списке, а сервер отказал
 * бы строкой схемы. Затем перевёрнутый диапазон — теми же словами, что
 * красное поле. Ответ — одна причина: сообщение говорит одну вещь, а
 * остальные видны у полей.
 */
export function presetProblem(title: string, f: SampleFilters | null | undefined): UiKey | null {
  if (!title.trim()) return "st.errFilterName";
  return filterErrors(f)[0] ?? null;
}

/** «2026-09-01» → «01.09.2026»: дата выборки — день, без времени и пояса */
export function dayText(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

/**
 * Значение строки-критерия словами — для чипа выборки: «Стать: Чоловіки»,
 * «Віковий діапазон: 25–45».
 *
 * Решение заказчика 2026-09-26: адекватные фильтры. По имени критерия нельзя
 * было понять, кого именно отбирает выборка, не открывая пресет. Группа и
 * человек значением не печатаются: чип читают через плечо, а «кто в
 * выборке» видно в её фильтрах.
 */
export function criterionValue(c: Criterion, f: SampleFilters | null | undefined, t: (key: UiKey) => string): string {
  const x = cleanFilters(f);
  switch (c) {
    case "sex":
      return x.sex ? t(x.sex === "male" ? "nm.menCap" : "nm.womenCap") : "";
    case "age":
      if (x.ageMin != null && x.ageMax != null) return `${x.ageMin}–${x.ageMax}`;
      if (x.ageMin != null) return `${t("coh.fromWord")} ${x.ageMin}`;
      if (x.ageMax != null) return `${t("coh.ageTo")} ${x.ageMax}`;
      return "";
    case "locality":
      return x.locality ?? "";
    case "date":
      if (x.from && x.to) return `${dayText(x.from)} – ${dayText(x.to)}`;
      if (x.from) return `${t("coh.fromWord")} ${dayText(x.from)}`;
      if (x.to) return `${t("coh.ageTo")} ${dayText(x.to)}`;
      return "";
    case "group":
    case "patient":
      return "";
  }
}

/**
 * Возраст из числового поля: пусто и мусор — «границы нет», прочее — целые
 * годы в пределах схемы сервера (0…120).
 *
 * Разбор — числом, а не parseInt: числовое поле пропускает «1e2», и
 * parseInt читал его как 1 год, хотя в поле написано сто.
 */
export function ageFromInput(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(120, Math.trunc(n))) : null;
}

/**
 * Правка фильтров одной выборки модели.
 *
 * Выборка с пресетом, тронутая правкой, становится выборкой со своими
 * фильтрами — начиная с критериев пресета, а не с пустого места: колонка на
 * сервере берёт либо пресет, либо свои фильтры, и править сам пресет
 * отсюда значило бы молча поменять все модели, что на него ссылаются.
 * Пустое значение снимает критерий. Остальные выборки не трогаются.
 */
export function withColumnFilters(
  columns: readonly StatModelColumn[],
  index: number,
  patch: Partial<SampleFilters>,
  presetCriteria: (presetId: string) => SampleFilters | undefined,
): StatModelColumn[] {
  return columns.map((c, j) => {
    if (j !== index) return c;
    const base = c.presetId ? (presetCriteria(c.presetId) ?? {}) : (c.filters ?? {});
    return { ...c, presetId: null, filters: patchFilters(base, patch) };
  });
}

/** Правка ключей фильтра: пустое значение — «ключа нет», а не пустая строка на сервере */
export function patchFilters(f: SampleFilters, patch: Partial<SampleFilters>): SampleFilters {
  const next: Record<string, unknown> = { ...f, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === null || v === undefined || v === "") delete next[k];
  return next as SampleFilters;
}

/** Одни и те же ли фильтры — по содержанию, а не по записи */
export function sameFilters(a: SampleFilters | null | undefined, b: SampleFilters | null | undefined): boolean {
  const x = cleanFilters(a);
  const y = cleanFilters(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]) as Set<keyof SampleFilters>;
  for (const k of keys) if (x[k] !== y[k]) return false;
  return true;
}

/* ─────────── черновик выборки (ящик фильтров) ─────────── */

/**
 * Что правится в ящике выборки: подпись, пресет либо свои фильтры.
 *
 * Пока выбран пресет, поля показывают его критерии; правка любого поля
 * переводит выборку на свои фильтры — начиная с критериев пресета (см.
 * withColumnFilters). Сам пресет отсюда не правится.
 */
export interface SampleDraft {
  title: string;
  presetId: string | null;
  filters: SampleFilters;
}

export function sampleDraft(c: StatModelColumn, presetCriteria: (id: string) => SampleFilters | undefined): SampleDraft {
  return {
    title: c.title ?? "",
    presetId: c.presetId,
    filters: c.presetId ? cleanFilters(presetCriteria(c.presetId)) : cleanFilters(c.filters),
  };
}

/** Правка поля черновика: выборка с пресетом становится своей, с критериями пресета */
export function editSampleDraft(d: SampleDraft, patch: Partial<SampleFilters>): SampleDraft {
  return { ...d, presetId: null, filters: patchFilters(d.filters, patch) };
}

/** Колонка с черновиком ящика: показатели остаются, меняется только «кого» */
export function withSampleDraft(c: StatModelColumn, d: SampleDraft): StatModelColumn {
  const title = d.title.trim() || null;
  return d.presetId
    ? { ...c, title, presetId: d.presetId, filters: null }
    : { ...c, title, presetId: null, filters: cleanFilters(d.filters) };
}

/** Изменил ли черновик колонку — от этого зависит «Застосувати» и пометка черновика */
export function sampleDraftChanged(c: StatModelColumn, d: SampleDraft): boolean {
  /* пустая подпись и подпись из пробелов — то же, что её отсутствие */
  const now = { ...c, title: c.title?.trim() || null };
  return JSON.stringify(columnInput(now)) !== JSON.stringify(columnInput(withSampleDraft(c, d)));
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

/** Потолок колонок — тот же, что у схемы сервера (statModelInputSchema, max 8) */
export const MAX_SAMPLES = 8;

/**
 * Новая выборка для сравнения — «Додати вибірку».
 *
 * Те же тест и показатели, что у последней колонки, а фильтры пустые:
 * строки отчёта у выборок одной модели одинаковые, а выборку человек задаёт
 * сам. Копировать фильтры значило бы получить две одинаковые колонки — и
 * первое, что с ними сделают, это сотрут скопированное.
 */
export function addSample(columns: readonly StatModelColumn[]): StatModelColumn[] {
  const last = columns[columns.length - 1];
  if (!last || columns.length >= MAX_SAMPLES) return [...columns];
  return [...columns, { ...last, title: null, presetId: null, filters: {} }];
}

/**
 * «Дублювати вибірку»: та же выборка рядом, без подписи — чтобы её сузили.
 * Подпись не копируется: две колонки с одним именем читались бы как одна.
 */
export function duplicateSample(columns: readonly StatModelColumn[], index: number): StatModelColumn[] {
  const src = columns[index];
  if (!src || columns.length >= MAX_SAMPLES) return [...columns];
  const out = [...columns];
  out.splice(index + 1, 0, { ...src, title: null });
  return out;
}

/** «Прибрати вибірку»: последняя не убирается — модель без выборки ничего не считает */
export function removeSample(columns: readonly StatModelColumn[], index: number): StatModelColumn[] {
  if (columns.length <= 1) return [...columns];
  return columns.filter((_, i) => i !== index);
}

/**
 * Пресет к выбранным выборкам — окно графика «До яких вибірок застосувати
 * пресет». `extra` — ещё одна выборка с этим пресетом (та же структура,
 * что у последней), пока есть место до восьми.
 */
export function applyPreset(
  columns: readonly StatModelColumn[],
  presetId: string,
  targets: readonly number[],
  extra = false,
): StatModelColumn[] {
  const out = columns.map((c, i) => (targets.includes(i) ? { ...c, presetId, filters: null } : c));
  const last = columns[columns.length - 1];
  if (extra && last && out.length < MAX_SAMPLES) out.push({ ...last, title: null, presetId, filters: null });
  return out;
}

/* ─────────── печать ячеек ─────────── */

/**
 * Прочерк скрытой ячейки — U+2014, из подмножества Manrope (fonts.css,
 * U+2000–206F). Один знак на весь раздел: сервер прячет не только малые
 * числа, но и большие, если вместе с соседями они называют людей, — поэтому
 * прочерк не утверждает ничего, кроме «скрыто».
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
 * Доля для полосы графика: число или null за скрытой ячейкой. Та же
 * граница, что у cellText: число скрытой ячейки сюда не доезжает.
 */
export function cellShare(cell: StatCell | null | undefined): number | null {
  if (!cell || cell.suppressed) return null;
  return cell.percent;
}

/**
 * Разность долей ячейки и опорной выборки — «+11 в. п.» в таблице модели.
 *
 * Печатается ТОЛЬКО когда обе ячейки показаны. Если скрыта хоть одна,
 * разности нет: разность показанной и скрытой — это скрытое, выписанное
 * через показанное, то есть ровно та утечка, ради которой сервер решает
 * систему (lib/privacy.ts). Разность двух показанных при этом ничего нового
 * не выдаёт — читатель посчитал бы её в уме.
 *
 * Минус — U+2212 (подмножество Manrope), а не дефис: в столбце чисел дефис
 * короче плюса и сбивает выключку.
 */
export function diffText(a: StatCell | null | undefined, b: StatCell | null | undefined): string {
  if (!a || !b || a.suppressed || b.suppressed) return "";
  const d = b.percent - a.percent;
  if (d === 0) return "0";
  return d > 0 ? `+${d}` : `−${Math.abs(d)}`;
}

/* ─────────── строки отчёта ─────────── */

/**
 * Строка таблицы модели и группы полос графика.
 *
 * Ключ — идентификатор полосы, варианта, шкалы или вопроса: по нему ячейки
 * РАЗНЫХ колонок встают в одну строку. Сопоставление по месту в списке
 * разъехалось бы на первой модели, где у колонок разные показатели.
 */
export type ReportRow =
  | { kind: "scale"; key: string; scaleId: string; code: string; title: string }
  | {
      kind: "band";
      key: string;
      scaleId: string;
      bandId: string;
      label: string;
      severity: Severity | null;
      /** «10–14» — границы полосы в баллах, если версия методики известна */
      range: string | null;
      highRisk: boolean;
    }
  | {
      kind: "question";
      key: string;
      questionId: string;
      title: string;
      type: QuestionType | null;
      /** Номер пункта в версии методики (с единицы); null — версия неизвестна */
      number: number | null;
    }
  | { kind: "option"; key: string; questionId: string; optionId: string; text: string; highRisk: boolean }
  /** «Решта»: все, кто не попал ни в один показанный вариант; `others` — непоказанные варианты словами */
  | { kind: "rest"; key: string; of: "scale" | "question"; id: string; others: string }
  /** «Респонденти з ВШР» — когда в модели есть хоть одна пометка */
  | { kind: "risk"; key: string };

/**
 * Строки отчёта в порядке экрана: по шкале — заголовок, полосы, «Решта»;
 * по вопросу — заголовок, варианты, «Решта»; в конце — «ВШР».
 *
 * Подписи — из расчёта, когда он есть (он присылает их на языке запроса),
 * иначе из версии методики, записанной в колонке. Колонок может быть
 * несколько с разной структурой — строки идут объединением, в порядке
 * первой колонки.
 */
export function reportRows(
  columns: readonly StatModelColumn[],
  surveyOf: (c: StatModelColumn) => SurveyFull | null | undefined,
  result?: readonly (StatRunColumn | undefined)[],
): ReportRow[] {
  const out: ReportRow[] = [];
  const seen = new Set<string>();
  const push = (r: ReportRow) => {
    if (seen.has(r.key)) return;
    seen.add(r.key);
    out.push(r);
  };
  let risk = false;
  columns.forEach((col, ci) => {
    const survey = surveyOf(col) ?? null;
    const res = result?.[ci];
    /* полосы — группами по шкале, в порядке первой встречи, как их считает сервер */
    const scaleOrder: string[] = [];
    for (const b of col.bands) if (!scaleOrder.includes(b.scaleId)) scaleOrder.push(b.scaleId);
    for (const scaleId of scaleOrder) {
      const scale = survey?.scales.find((s) => s.id === scaleId);
      const gotScale = res?.scales.find((s) => s.scaleId === scaleId);
      push({
        kind: "scale",
        key: `s:${scaleId}`,
        scaleId,
        code: gotScale?.scaleCode ?? scale?.code ?? "",
        title: gotScale?.scaleTitle ?? scale?.title ?? "",
      });
      const picked = col.bands.filter((b) => b.scaleId === scaleId);
      for (const b of picked) {
        const band = scale?.bands.find((x) => x.id === b.bandId);
        const got = gotScale?.bands.find((x) => x.bandId === b.bandId);
        if (b.highRisk) risk = true;
        push({
          kind: "band",
          key: `b:${b.bandId}`,
          scaleId,
          bandId: b.bandId,
          label: got?.label ?? band?.label ?? "",
          severity: got?.severity ?? band?.severity ?? null,
          range: band ? `${band.minScore}–${band.maxScore}` : null,
          highRisk: b.highRisk,
        });
      }
      const ids = new Set(picked.map((b) => b.bandId));
      push({
        kind: "rest",
        key: `rs:${scaleId}`,
        of: "scale",
        id: scaleId,
        others: (scale?.bands ?? [])
          .filter((x) => !ids.has(x.id))
          .map((x) => x.label)
          .join(", "),
      });
    }
    for (const q of col.questions) {
      const question = survey?.questions.find((x) => x.id === q.questionId);
      const gotQ = res?.questions.find((x) => x.questionId === q.questionId);
      push({
        kind: "question",
        key: `q:${q.questionId}`,
        questionId: q.questionId,
        title: gotQ?.title ?? question?.title ?? "",
        type: gotQ?.type ?? question?.type ?? null,
        number: question ? survey!.questions.indexOf(question) + 1 : null,
      });
      for (const o of q.options) {
        const got = gotQ?.options.find((x) => x.optionId === o.optionId);
        if (o.highRisk) risk = true;
        push({
          kind: "option",
          key: `o:${q.questionId}:${o.optionId}`,
          questionId: q.questionId,
          optionId: o.optionId,
          text: got?.text ?? question?.options.find((x) => x.id === o.optionId)?.text ?? "",
          highRisk: o.highRisk,
        });
      }
      const ids = new Set(q.options.map((o) => o.optionId));
      push({
        kind: "rest",
        key: `rq:${q.questionId}`,
        of: "question",
        id: q.questionId,
        others: (question?.options ?? [])
          .filter((x) => x.kind === "option" && !ids.has(x.id))
          .map((x) => x.text)
          .join(", "),
      });
    }
  });
  if (risk) push({ kind: "risk", key: "risk" });
  return out;
}

/** Ячейка строки отчёта в расчёте колонки; null — у колонки такой строки нет или расчёта не было */
export function cellAt(row: ReportRow, col: StatRunColumn | undefined): StatCell | null {
  if (!col) return null;
  switch (row.kind) {
    case "band":
      return col.scales.find((s) => s.scaleId === row.scaleId)?.bands.find((b) => b.bandId === row.bandId)?.cell ?? null;
    case "option":
      return (
        col.questions.find((q) => q.questionId === row.questionId)?.options.find((o) => o.optionId === row.optionId)
          ?.cell ?? null
      );
    case "rest":
      return row.of === "scale"
        ? (col.scales.find((s) => s.scaleId === row.id)?.rest ?? null)
        : (col.questions.find((q) => q.questionId === row.id)?.rest ?? null);
    case "risk":
      return col.highRisk;
    default:
      return null;
  }
}

/** Строки с числами: всё, кроме заголовков шкал и вопросов */
export function isFigureRow(row: ReportRow): boolean {
  return row.kind !== "scale" && row.kind !== "question";
}

/**
 * Сколько чисел печатает одна колонка: основание, по шкале — полосы и
 * «Решта», по вопросу — варианты и «Решта», «ВШР», если что-то помечено.
 *
 * Тот же счёт, что у сервера (lib/statModels.ts, MAX_FIGURES_PER_COLUMN):
 * больше шестнадцати ненулевых чисел колонка не печатает, и редактор
 * показывает это до сохранения, а не прочерками после расчёта.
 */
export const MAX_FIGURES = 16;

export function figureCount(
  bands: readonly { scaleId: string; highRisk: boolean }[],
  questions: readonly { options: readonly { highRisk: boolean }[] }[],
): number {
  const scales = new Set(bands.map((b) => b.scaleId)).size;
  const risk = bands.some((b) => b.highRisk) || questions.some((q) => q.options.some((o) => o.highRisk));
  return 1 + bands.length + scales + questions.reduce((n, q) => n + q.options.length + 1, 0) + (risk ? 1 : 0);
}

/* ─────────── черновик структуры (редактор) ─────────── */

let seq = 0;
const nextKey = (p: string) => `${p}${++seq}`;

export interface BandRow {
  key: string;
  /** «scaleId:bandId» — полоса однозначна только вместе со шкалой */
  value: string;
  /** Пометка «ВШР» у полосы: переключателя у полосы нет, но сохранённая модель её несёт — не теряем */
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
  /**
   * Версия методики; null — действующая на момент сохранения (сервер
   * запишет её сам). Полосы и варианты принадлежат версии: смена версии,
   * как и теста, сбрасывает строки.
   */
  versionId: string | null;
  /** Выбранные полосы — в порядке шкал методики */
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

/** Пустой редактор: ни теста, ни строк — «Додати питання» добавляет вопрос, когда тест выбран */
export function emptyStructure(): StructureDraft {
  return { title: "", description: "", surveyId: "", versionId: null, bands: [], questions: [] };
}

/** Структура сохранённой модели — по первой колонке */
export function structureFromModel(model: StatModel): StructureDraft {
  const first = model.columns[0];
  if (!first) return { ...emptyStructure(), title: model.title, description: model.description ?? "" };
  return {
    title: model.title,
    description: model.description ?? "",
    surveyId: first.surveyId,
    versionId: first.versionId,
    bands: first.bands.map((b) => newBandRow(`${b.scaleId}:${b.bandId}`, b.highRisk)),
    questions: first.questions.map((q) =>
      newQuestionBlock(
        q.questionId,
        q.options.map((o) => newOptionRow(o.optionId, o.highRisk)),
      ),
    ),
  };
}

/**
 * Отметить или снять полосу. Отмеченные стоят в порядке шкал методики
 * (`order` — «scaleId:bandId» всех полос): номер «рядок звіту N» тогда
 * совпадает с местом строки в отчёте, а не с порядком нажатий.
 */
export function toggleBand(bands: readonly BandRow[], value: string, order: readonly string[]): BandRow[] {
  if (bands.some((b) => b.value === value)) return bands.filter((b) => b.value !== value);
  return sortBy([...bands, newBandRow(value)], (b) => b.value, order);
}

/** «Усі» / «Жодної» по шкале: полосы других шкал остаются, пометки отмеченных — тоже */
export function setScaleBands(
  bands: readonly BandRow[],
  scaleValues: readonly string[],
  on: boolean,
  order: readonly string[],
): BandRow[] {
  const rest = bands.filter((b) => !scaleValues.includes(b.value));
  if (!on) return rest;
  const kept = scaleValues.map((v) => bands.find((b) => b.value === v) ?? newBandRow(v));
  return sortBy([...rest, ...kept], (b) => b.value, order);
}

/** Отметить или снять вариант ответа — в порядке вариантов вопроса */
export function toggleOption(block: QuestionBlock, optionId: string, order: readonly string[]): QuestionBlock {
  if (block.options.some((o) => o.optionId === optionId)) {
    return { ...block, options: block.options.filter((o) => o.optionId !== optionId) };
  }
  return { ...block, options: sortBy([...block.options, newOptionRow(optionId)], (o) => o.optionId, order) };
}

/** Пометка «ВШР» у отмеченного варианта */
export function setOptionRisk(block: QuestionBlock, optionId: string, highRisk: boolean): QuestionBlock {
  return { ...block, options: block.options.map((o) => (o.optionId === optionId ? { ...o, highRisk } : o)) };
}

function sortBy<T>(rows: T[], keyOf: (r: T) => string, order: readonly string[]): T[] {
  const at = (r: T) => {
    const i = order.indexOf(keyOf(r));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return rows.sort((a, b) => at(a) - at(b));
}

/** Показатели черновика в виде сервера: пустые строки и пустые блоки не едут */
export function indicatorsFromDraft(draft: StructureDraft) {
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
 * Колонки для сервера из черновика редактора.
 *
 * Новая модель — одна колонка без фильтров: выборку задают на экране
 * модели. Правка — структура ложится на КАЖДУЮ колонку, а их выборки,
 * пресеты и подписи остаются: редактор правит «что считаем», а не «по
 * кому». Версия — выбранная в редакторе; не выбрана — у колонки того же
 * теста остаётся её версия (идентификаторы полос принадлежат ей), у нового
 * теста её берёт сервер (действующую) и записывает (resolveColumns).
 */
export function columnsFromDraft(
  draft: StructureDraft,
  existing: readonly StatModelColumn[] | null,
): StatModelColumnInput[] {
  const indicators = indicatorsFromDraft(draft);
  if (!existing?.length) {
    return [
      {
        title: null,
        presetId: null,
        filters: {},
        surveyId: draft.surveyId,
        ...(draft.versionId ? { versionId: draft.versionId } : {}),
        ...indicators,
      },
    ];
  }
  return existing.map((c) => ({
    title: c.title,
    presetId: c.presetId,
    filters: c.presetId ? null : cleanFilters(c.filters),
    surveyId: draft.surveyId,
    versionId: draft.versionId ?? (c.surveyId === draft.surveyId ? c.versionId : null),
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
