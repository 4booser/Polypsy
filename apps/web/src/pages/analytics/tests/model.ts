import type { QuestionAnalytics, SurveyAnalytics } from "@quizzy/shared";

/**
 * Чистая часть вкладки «Тести» раздела «Аналітика»: состояние экрана в
 * адресе, выбор методики по умолчанию, раскладка рядов для графиков.
 *
 * Вынесено из экрана ради проверки без React и сервера
 * (apps/web/test/analyticsTests.test.ts). Здесь живут ровно те решения,
 * которые меняют смысл картинки: какие дни достраиваются нулями, какие
 * варианты ответа считаются упорядоченными, какие пункты попадают в
 * «где теряют людей», — и ошибку в каждом из них глазом не отличить от
 * данных.
 */

/* ─────────── состояние в адресе ─────────── */

export type Scope = "all" | "patient";
export type View = "overview" | "scales" | "questions" | "time" | "quality" | "responses";
export type QuestionSort = "number" | "skips" | "changes" | "time";

export const VIEWS: readonly View[] = ["overview", "scales", "questions", "time", "quality", "responses"];
export const SORTS: readonly QuestionSort[] = ["number", "skips", "changes", "time"];

export interface TestsState {
  survey: string | null;
  scope: Scope;
  patient: string | null;
  from: string | null;
  to: string | null;
  version: string | null;
  group: string | null;
  view: View;
  sort: QuestionSort;
}

/** Параметры, которые экран понимает; остальные в адресе не трогаются */
export type Param = "survey" | "scope" | "patient" | "from" | "to" | "version" | "group" | "view" | "sort";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Состояние из адреса — с защитой от мусора.
 *
 * Адрес пересылают коллеге и кладут в закладку; через месяц в нём может
 * оказаться вид, которого больше нет, или дата, набранная руками. Такой
 * параметр читается как «не задан», а не роняет экран: пустой экран по
 * присланной ссылке выглядит поломкой, умолчание — нет.
 */
export function readState(params: URLSearchParams): TestsState {
  const view = params.get("view") as View | null;
  const sort = params.get("sort") as QuestionSort | null;
  const date = (key: string) => {
    const v = params.get(key);
    return v && DAY.test(v) ? v : null;
  };
  return {
    survey: params.get("survey") || null,
    scope: params.get("scope") === "patient" ? "patient" : "all",
    patient: params.get("patient") || null,
    from: date("from"),
    to: date("to"),
    version: params.get("version") || null,
    group: params.get("group") || null,
    view: view && VIEWS.includes(view) ? view : "overview",
    sort: sort && SORTS.includes(sort) ? sort : "number",
  };
}

/**
 * Правка адреса: пустое значение параметр убирает, а не пишет «?from=».
 *
 * Умолчания в адрес не пишутся вовсе (scope=all, view=overview, sort=number):
 * две ссылки на один и тот же экран должны совпадать строкой, иначе
 * закладка и история браузера считают их разными местами.
 */
export function patchParams(prev: URLSearchParams, patch: Partial<Record<Param, string | null>>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    const isDefault = (k === "scope" && v === "all") || (k === "view" && v === "overview") || (k === "sort" && v === "number");
    if (v === null || v === undefined || v === "" || isDefault) next.delete(k);
    else next.set(k, v);
  }
  return next;
}

/**
 * Смена методики сбрасывает версию: идентификатор версии принадлежит
 * методике, и версия прежней в адресе новой означала бы «версии нет» —
 * сервер молча выбрал бы свою, а поле показывало бы чужую.
 */
export function surveyPatch(id: string): Partial<Record<Param, string | null>> {
  return { survey: id, version: null };
}

/** Задан ли срез сверх самой методики — тогда у строки фильтров есть что сбрасывать */
export function isFiltered(s: TestsState): boolean {
  return s.scope !== "all" || !!s.patient || !!s.from || !!s.to || !!s.version || !!s.group;
}

/** «Скинути»: всё, кроме методики и открытого вида — их человек выбирал не как фильтр */
export const RESET_PATCH: Partial<Record<Param, null>> = {
  scope: null,
  patient: null,
  from: null,
  to: null,
  version: null,
  group: null,
};

/** Адрес экрана по методике — сюда перенаправляет прежний /surveys/:id */
export function testsHref(surveyId: string, extra: Partial<Record<Param, string>> = {}): string {
  const qs = patchParams(new URLSearchParams(), { survey: surveyId, ...extra });
  return `/analytics/tests?${qs.toString()}`;
}

/**
 * Протокол прохождения — маршрут /surveys/:id/responses/:rid (App.tsx);
 * форму ссылки сторожит apps/web/test/responseView.test.ts.
 */
export function protocolHref(surveyId: string, responseId: string): string {
  return `/surveys/${surveyId}/responses/${responseId}`;
}

/**
 * Графики прохождения — …/responses/:rid/charts.
 *
 * Экран делает параллельный сборщик участка response (волна 9), ссылка
 * ставится как есть: строка списка ведёт на картину прохождения, а не на
 * протокол ответов, — протокол остаётся в «⋯» строки. Собирается от адреса
 * протокола, а не второй строкой шаблона: форма общей части — одна.
 */
export function chartsHref(surveyId: string, responseId: string): string {
  return `${protocolHref(surveyId, responseId)}/charts`;
}

/* ─────────── выбор методики ─────────── */

export interface SurveyChoice {
  id: string;
  title: string;
  responseCount: number;
}

/**
 * Методика по умолчанию — с наибольшим числом прохождений.
 *
 * Экран, открытый без ?survey, должен сразу что-то показать: пустой экран с
 * просьбой «выберите тест» — лишнее нажатие на каждый вход. Самая
 * заполненная методика — та, про которую чаще всего и спрашивают; при
 * равенстве — по названию, чтобы выбор не прыгал между входами.
 */
export function defaultSurvey(list: readonly SurveyChoice[]): string | null {
  const best = [...list].sort((a, b) => b.responseCount - a.responseCount || a.title.localeCompare(b.title))[0];
  return best?.id ?? null;
}

/**
 * Поиск методики по названию: без регистра, по вхождению; найденные — по
 * числу прохождений, потому что в выпадающем списке сверху должна стоять
 * методика, у которой есть что анализировать.
 */
export function findSurveys<T extends SurveyChoice>(list: readonly T[], q: string, limit = 12): T[] {
  const needle = q.trim().toLowerCase();
  return list
    .filter((s) => !needle || s.title.toLowerCase().includes(needle))
    .sort((a, b) => b.responseCount - a.responseCount || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/* ─────────── малые выборки ─────────── */

/**
 * Порог малых ячеек — зеркало SMALL_CELL_FLOOR сервера (lib/privacy.ts).
 *
 * На этом экране он охраняет не опознание — сотрудник с доступом к методике
 * и так видит её прохождения поимённо, — а смысл: среднее, медиана и
 * квартили по трём людям — это три человека, а не «состояние отделения».
 * Ниже порога экран пишет «замало даних» словами, а не печатает числа,
 * которые выглядят как результат. Сами счётчики (сколько прошли, сколько в
 * полосе) показываются всегда: это объём, а не оценка.
 */
export const SMALL_CELL = 5;

/* ─────────── подстановка в строку словаря ─────────── */

/**
 * «{n} пунктів» → «12 пунктів». Словарь без движка подстановок (см.
 * uiStrings.ts), и строка с местом под число — единственный способ не
 * резать фразу на куски, порядок которых в украинском и русском разный.
 */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all));
}

/**
 * День периода строкой «26.09.2026». Разбором строки, а не через Date:
 * «2026-09-01» у Date — полночь по Гринвичу, и западнее её день съезжал бы
 * на вчера (см. parse в format.ts).
 */
export function dayText(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

/** Число для подписи: целое без хвоста, дробное — до двух знаков, запятая по-украински */
export function numText(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const f = 10 ** digits;
  return String(Math.round(v * f) / f).replace(".", ",");
}

/* ─────────── ряд прохождений по времени ─────────── */

const DAY_MS = 86_400_000;

function utcOf(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Понедельник недели дня YYYY-MM-DD — так же, как weekOf на сервере */
export function mondayOf(date: string): string {
  const at = utcOf(date);
  const back = (new Date(at).getUTCDay() + 6) % 7;
  return isoOf(at - back * DAY_MS);
}

export interface TimeBucket {
  key: string;
  /** Первый день корзины, YYYY-MM-DD */
  date: string;
  value: number;
}

/**
 * Прохождения по дням или по неделям — с нулями там, где никого не было.
 *
 * Сервер отдаёт только дни с прохождениями. Нарисовать их подряд значит
 * сдвинуть пустые дни из истории: две недели тишины между сериями
 * обследований исчезли бы, и столбцы стояли бы плотно, будто поток был
 * ровным. Поэтому промежутки достраиваются нулями.
 *
 * Дольше двух месяцев — неделями: семьдесят столбцов шириной в пару
 * пикселей не читаются, а подписи под ними всё равно прорежены до одной на
 * неделю.
 */
export function timeBuckets(timeline: readonly { date: string; count: number }[]): {
  mode: "day" | "week";
  buckets: TimeBucket[];
} {
  const days = timeline.filter((d) => DAY.test(d.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return { mode: "day", buckets: [] };
  const first = utcOf(days[0]!.date);
  const last = utcOf(days.at(-1)!.date);
  const mode = (last - first) / DAY_MS > 60 ? "week" : "day";
  const counts = new Map<string, number>();
  for (const d of days) {
    const key = mode === "week" ? mondayOf(d.date) : d.date;
    counts.set(key, (counts.get(key) ?? 0) + d.count);
  }
  const step = mode === "week" ? 7 * DAY_MS : DAY_MS;
  const start = mode === "week" ? utcOf(mondayOf(days[0]!.date)) : first;
  const buckets: TimeBucket[] = [];
  for (let at = start; at <= last; at += step) {
    const date = isoOf(at);
    buckets.push({ key: date, date, value: counts.get(date) ?? 0 });
  }
  return { mode, buckets };
}

/* ─────────── где теряют людей ─────────── */

export interface LossRow {
  key: string;
  position: number;
  title: string;
  lost: number;
}

/**
 * Пункты, после которых люди бросают методику.
 *
 * Только пункты с потерями: полсотни строк «−0» ничего не сообщают и
 * отодвигают те три, ради которых график открыли. Если пунктов с потерями
 * больше предела — показываются самые большие потери, но в порядке пунктов
 * методики: «после 17-го» и «после 18-го» рядом читаются как одно место, а
 * отсортированные по величине — как два разных.
 */
export function lossRows(dropOff: SurveyAnalytics["dropOff"], limit = 12): { rows: LossRow[]; cut: boolean } {
  const losing = dropOff
    .filter((d) => d.lost > 0)
    .map((d) => ({ key: d.questionId, position: d.position, title: d.title, lost: d.lost }));
  if (losing.length <= limit) return { rows: losing, cut: false };
  const keep = new Set(
    [...losing]
      .sort((a, b) => b.lost - a.lost || a.position - b.position)
      .slice(0, limit)
      .map((r) => r.key),
  );
  return { rows: losing.filter((r) => keep.has(r.key)), cut: true };
}

/* ─────────── варианты ответа ─────────── */

type Option = NonNullable<QuestionAnalytics["options"]>[number];

/**
 * Упорядочены ли варианты — по весам, а не по тексту.
 *
 * «Ніколи → кілька днів → більше половини днів → майже щодня» — ряд, и
 * рисуется он ступенями одного тона: глаз читает порядок светлотой. У
 * «так / ні» с весами 1 и 0 порядок тоже есть. А вот варианты без весов или
 * с одинаковыми весами — набор равноправных ответов, и ступени между ними
 * выдумали бы шкалу, которой в методике нет.
 *
 * Упорядоченным ряд считается, когда веса различны и идут монотонно по
 * порядку вариантов (в любую сторону): перемешанные веса — признак
 * ключевой методики, где вес значит «совпало с ключом», а не «сильнее».
 */
export function isOrdered(options: readonly Pick<Option, "score">[]): boolean {
  if (options.length < 2) return false;
  const w = options.map((o) => o.score);
  if (w.some((s) => s === null || s === undefined || !Number.isFinite(s))) return false;
  const s = w as number[];
  if (new Set(s).size !== s.length) return false;
  const up = s.every((v, i) => i === 0 || v > s[i - 1]!);
  const down = s.every((v, i) => i === 0 || v < s[i - 1]!);
  return up || down;
}

export interface OptionPart {
  key: string;
  label: string;
  value: number;
  /** 0…1 — место в упорядоченном ряду по весу; нет — ряд неупорядочен */
  step?: number;
}

/**
 * Доли вариантов для полосы ShareBar.
 *
 * Ступень — по весу, а не по положению в списке: у ряда «майже щодня →
 * ніколи» (веса 3…0) самый тёмный отрезок обязан быть у «майже щодня»,
 * хоть он и стоит первым.
 */
export function optionParts(q: Pick<QuestionAnalytics, "options">): OptionPart[] {
  const options = q.options ?? [];
  const ordered = isOrdered(options);
  const weights = ordered ? options.map((o) => o.score as number) : [];
  const lo = ordered ? Math.min(...weights) : 0;
  const hi = ordered ? Math.max(...weights) : 0;
  return options.map((o) => ({
    key: o.optionId,
    label: o.text,
    value: o.count,
    ...(ordered ? { step: hi > lo ? ((o.score as number) - lo) / (hi - lo) : 1 } : {}),
  }));
}

/* ─────────── порядок пунктов ─────────── */

/**
 * Порядок списка пунктов. Кроме «за номером» — по убыванию: смотрят на
 * самые пропускаемые, самые сомнительные и самые долгие, а не на самые
 * благополучные. При равенстве — по номеру, чтобы порядок не прыгал между
 * перерисовками.
 */
export function sortQuestions<T extends Pick<QuestionAnalytics, "position" | "skipRate" | "changedShare" | "medianDurationMs">>(
  questions: readonly T[],
  sort: QuestionSort,
): T[] {
  const by: Record<QuestionSort, (q: T) => number> = {
    number: () => 0,
    skips: (q) => q.skipRate,
    changes: (q) => q.changedShare,
    time: (q) => q.medianDurationMs,
  };
  const key = by[sort];
  return [...questions].sort((a, b) => key(b) - key(a) || a.position - b.position);
}

/* ─────────── числовые пункты ─────────── */

export interface Bar {
  key: string;
  label: string;
  value: number;
}

/**
 * Распределение числового пункта.
 *
 * Шкала 0–10 — одиннадцать строк, и так и рисуется. Поле «число» (возраст,
 * часы сна) даёт десятки разных значений — тогда они собираются в корзины
 * равной ширины, иначе полосы по одному человеку превратили бы график в
 * перечень ответов.
 */
export function numericBars(distribution: readonly { value: number; count: number }[], max = 12): Bar[] {
  const rows = [...distribution].filter((d) => Number.isFinite(d.value)).sort((a, b) => a.value - b.value);
  if (rows.length <= max) {
    return rows.map((d) => ({ key: String(d.value), label: numText(d.value), value: d.count }));
  }
  const lo = rows[0]!.value;
  const hi = rows.at(-1)!.value;
  const width = (hi - lo) / max;
  const bins = Array.from({ length: max }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, n: 0 }));
  for (const d of rows) {
    const at = Math.min(max - 1, Math.floor((d.value - lo) / width));
    bins[at]!.n += d.count;
  }
  return bins.map((b, i) => ({
    key: String(i),
    label: `${numText(b.from, 1)}–${numText(b.to, 1)}`,
    value: b.n,
  }));
}

/* ─────────── шкалы ─────────── */

export type AlphaLevel = "high" | "ok" | "low";

/** Альфа словами: 0,8 и выше — высокая, от 0,7 — приемлемая (пороги Нанналли) */
export function alphaLevel(alpha: number): AlphaLevel {
  return alpha >= 0.8 ? "high" : alpha >= 0.7 ? "ok" : "low";
}

export interface WeekPoint {
  key: string;
  week: string;
  t: number;
  value: number;
  n: number;
}

/**
 * Точки хода среднего по неделям — только недели выше порога.
 *
 * Скрытые недели (mean: null) выпадают из линии, а не рисуются нулём: ноль
 * на лестнице тяжести — это «всем хорошо». Одна точка — это не ход, и
 * экрану сообщается, что рисовать нечего (enough: false).
 */
export function weekPoints(weeks: readonly { week: string; n: number; mean: number | null }[]): {
  points: WeekPoint[];
  enough: boolean;
} {
  const points = weeks
    .filter((w) => w.mean !== null && Number.isFinite(w.mean) && DAY.test(w.week))
    .map((w) => ({ key: w.week, week: w.week, t: utcOf(w.week), value: w.mean as number, n: w.n }));
  return { points, enough: points.length >= 2 };
}

/* ─────────── время ─────────── */

export interface MedianPoint {
  x: string;
  y: number;
  lo: number;
  hi: number;
}

/**
 * Медиана времени по пунктам с межквартильной полосой, в секундах.
 *
 * Пункты без ответов выпадают: у них медиана «0» — не быстрый пункт, а
 * отсутствие данных, и ноль посреди линии читался бы как «здесь не думали».
 */
export function medianPoints(
  questions: readonly Pick<QuestionAnalytics, "position" | "answered" | "medianDurationMs" | "p25DurationMs" | "p75DurationMs">[],
  prefix: string,
): MedianPoint[] {
  const s = (ms: number) => Math.round(ms / 100) / 10;
  return questions
    .filter((q) => q.answered > 0 && q.medianDurationMs > 0)
    .sort((a, b) => a.position - b.position)
    .map((q) => ({ x: `${prefix}${q.position + 1}`, y: s(q.medianDurationMs), lo: s(q.p25DurationMs), hi: s(q.p75DurationMs) }));
}

/** Пункты с «надто швидко», по убыванию доли; нулевые не показываются вовсе */
export function tooFastRows<T extends Pick<QuestionAnalytics, "questionId" | "position" | "title" | "tooFastShare">>(
  questions: readonly T[],
  limit = 15,
): T[] {
  return questions
    .filter((q) => q.tooFastShare > 0)
    .sort((a, b) => b.tooFastShare - a.tooFastShare || a.position - b.position)
    .slice(0, limit);
}

/* ─────────── матрица ответов одного человека ─────────── */

/**
 * Тон клетки — доля балла от максимума пункта, 0…1.
 *
 * null — тонировать не по чему: у пункта нет весов, балла нет (пропуск,
 * свободный текст) или максимум не положителен. Тон тогда не ставится
 * вовсе: светлая клетка при отсутствии балла читалась бы как «ноль баллов».
 */
export function cellTone(score: number | null | undefined, max: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  if (max === null || max === undefined || !(max > 0)) return null;
  return Math.min(1, Math.max(0, score / max));
}

/** Сколько ступеней тона у клетки матрицы */
export const TONE_STEPS = 5;

/**
 * Ступень тона клетки, 0…TONE_STEPS−1 — ступенями, а не сплошной шкалой.
 *
 * Пять ступеней вместо непрерывного тона: соседние клетки 0,62 и 0,64 на
 * глаз не различимы, а спорить о них будут. Нулевой балл — нулевая ступень,
 * у которой тон едва заметен, но есть: «ответил минимальным» и «не
 * отвечал» обязаны выглядеть по-разному.
 */
export function toneStep(tone: number): number {
  return Math.min(TONE_STEPS - 1, Math.max(0, Math.round(tone * (TONE_STEPS - 1))));
}
