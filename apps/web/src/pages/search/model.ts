/**
 * Чистая часть «Пошуку по записах» (pages/Search.tsx): подсветка основ в
 * уривке, группировка находок, отбор по виду и автору, период, нещодавні
 * запити. Проверяется без браузера (apps/web/test/searchNotes.test.ts).
 */

export interface Hit {
  id: string;
  userId: string;
  userName: string;
  kind: string;
  version: number;
  status: string;
  createdAt: string;
  authorName: string;
  excerpt: string;
}

/**
 * Куски текста с пометкой «совпало».
 *
 * Сервер ищет по основам слов (`words`: «кошмар», «безсонн»), и подсвечивать
 * надо слово целиком, начиная с основы: «кошмари», «безсоння». Основа ищется
 * без учёта регистра и только с начала слова — «сон» не подсвечивается
 * внутри «безсоння», хотя как подстрока там есть.
 */
export function highlight(text: string, words: readonly string[]): { text: string; hit: boolean }[] {
  const stems = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (!stems.length || !text) return [{ text, hit: false }];
  const escaped = stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})[\\p{L}\\p{N}'’]*`, "giu");
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: m[0], hit: true });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

/** Находки группами: по пациенту (порядок групп — по самой свежей записи) или одной лентой по дате */
export function groupHits(hits: readonly Hit[], by: "patient" | "date"): { userId: string | null; userName: string; hits: Hit[] }[] {
  const fresh = [...hits].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (by === "date") return [{ userId: null, userName: "", hits: fresh }];
  const groups = new Map<string, { userId: string; userName: string; hits: Hit[] }>();
  for (const h of fresh) {
    const g = groups.get(h.userId) ?? { userId: h.userId, userName: h.userName, hits: [] };
    g.hits.push(h);
    groups.set(h.userId, g);
  }
  return [...groups.values()];
}

/** Сколько находок каждого значения поля — «Прийом 2», «Ірина Савчук 5» */
export function facetCounts(hits: readonly Hit[], key: "kind" | "authorName"): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h[key], (counts.get(h[key]) ?? 0) + 1);
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export type Period = "all" | "30" | "90" | "365";

/** Запись в периоде «останні N днів» от `now`; «all» — без границы */
export function inPeriod(iso: string, period: Period, now: number): boolean {
  if (period === "all") return true;
  return new Date(iso).getTime() >= now - Number(period) * 86_400_000;
}

/**
 * Отбор находок: снятые галочки вида и автора, период, один пациент.
 * Пустое множество снятых — всё видно.
 */
export function filterHits(
  hits: readonly Hit[],
  f: { hiddenKinds: ReadonlySet<string>; hiddenAuthors: ReadonlySet<string>; period: Period; patient: string; now: number },
): Hit[] {
  return hits.filter(
    (h) =>
      !f.hiddenKinds.has(h.kind) &&
      !f.hiddenAuthors.has(h.authorName) &&
      inPeriod(h.createdAt, f.period, f.now) &&
      (!f.patient || h.userId === f.patient),
  );
}

/*
 * Нещодавні запити — в хранилище вкладки (sessionStorage), а не браузера.
 *
 * Консоль открывают на общих ноутбуках отделения, а запрос — это слова из
 * клинических записей («самоушкодження», «план безпеки»). Держать их после
 * закрытия вкладки значило бы оставить следующему сотруднику список того,
 * что искали до него. Внутри смены вкладка живёт — и короткий список полезен.
 */
export const RECENT_KEY = "quizzy.search.recent";
export const RECENT_MAX = 6;

export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Новый запрос — первым; повтор поднимается наверх, а не дублируется */
export function pushRecent(list: readonly string[], q: string): string[] {
  const clean = q.trim().replace(/\s+/g, " ");
  if (!clean) return [...list];
  return [clean, ...list.filter((x) => x.toLowerCase() !== clean.toLowerCase())].slice(0, RECENT_MAX);
}
