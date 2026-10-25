import { isSurveyDomain, NO_DOMAIN, SURVEY_DOMAINS, type SurveyDomain, type SurveyFolder, type SurveyListItem } from "@quizzy/shared";
import type { SurveyPageQuery } from "../../api";
import { DEFAULT_PER, pageOffset } from "../../ui/paging";

/**
 * Чистая часть каталога тестов: адрес ↔ состояние, запрос к серверу, дерево
 * папок, арифметика страниц.
 *
 * Вынесено из экрана не ради «чистоты», а ради проверки: у страниц и крошек
 * есть граничные случаи (последняя страница после удаления, папка, у которой
 * родитель указывает на неё же), которые на живом экране воспроизводятся
 * только руками и только случайно. Здесь они проверяются за миллисекунду
 * без React и без сервера — см. apps/web/test/catalogue.test.ts.
 */

/* ─────────── вкладки ─────────── */

export type CatalogueTab = "published" | "drafts" | "retired";

/**
 * Вкладка — сегмент адреса, а не параметр запроса.
 *
 * Причина в том, как Tabs (primitives.tsx) отмечает текущую: через NavLink,
 * а тот сравнивает только путь и параметры запроса не видит. Вкладка в
 * `?tab=` подсвечивала бы обе вкладки сразу. Папка, поиск и страница,
 * наоборот, остаются параметрами: они уточняют вкладку, а не заменяют её.
 */
export const TAB_PATH: Record<CatalogueTab, string> = {
  published: "/surveys",
  drafts: "/surveys/drafts",
  retired: "/surveys/retired",
};

export function tabFromPath(pathname: string): CatalogueTab {
  if (pathname.startsWith(TAB_PATH.drafts)) return "drafts";
  if (pathname.startsWith(TAB_PATH.retired)) return "retired";
  return "published";
}

/* ─────────── страницы ─────────── */

/*
 * Ступени селекта и разбор адреса переехали в ui/paging.ts: тот же блок
 * страниц стоит теперь над группами пациентов и над списком пациентов.
 * Имена отдаются отсюда по-прежнему — проверки каталога и его экран зовут
 * их как звали, а второго места, где живёт «10 — значение с макета», нет.
 */
export { DEFAULT_PER, offsetPageCount, pageCount, pageFrom, perFrom } from "../../ui/paging";

/* ─────────── запрос ─────────── */

export interface CatalogueView {
  tab: CatalogueTab;
  /** Текущая папка; null — корень «Мої тести» */
  folder: string | null;
  q: string;
  page: number;
  per: number;
  /** Чип «Напрям»: направление или `none` — без направления; null — все */
  domain?: DomainFilter | null;
}

/**
 * Что спросить у сервера для этого вида экрана.
 *
 * Три решения, которые здесь приняты:
 *
 * 1. В корне без поиска показываются методики вне папок (`folder=root`), как в
 *    проводнике; в корне С поиском — весь каталог. «Мої тести» и есть весь
 *    каталог, и человек, набравший название в корне, ждёт найти тест, где бы
 *    тот ни лежал, — а не пустую страницу, потому что тест в «лютому 2023».
 *    Внутри папки поиск ограничен ею: сервер умеет «в папке» и «в корне», а
 *    «в поддереве» — нет, и обещать больше, чем он делает, нельзя.
 *
 * 2. «Опубліковані» — ровно status=published. Состояние `closed` в перечне
 *    сервера есть, но ни один экран консоли его не выставляет; когда
 *    появится, ему понадобится своя вкладка, а не тихое подмешивание сюда.
 *
 * 3. Снятые с использования сервер не умеет отдавать ОТДЕЛЬНО — `archived=1`
 *    добавляет их к остальным. Поэтому вкладка «Зняті» просит весь список без
 *    страниц, а отбор и страницы делает сама (см. retiredPage): снятых —
 *    единицы, и второй механизм страниц на сервере ради них не стоит.
 *
 * Смещение — не дальше предела сервера (pageOffset, #205): страница из
 * закладки за пределом приходит пустой с общим числом, и экран возвращает
 * на последнюю, а не показывает отказ на весь каталог.
 *
 * 4. Направление (чип «Напрям») ведёт себя как поиск: в корне — по всему
 *    каталогу, а не по методикам вне папок, в папке — по её поддереву (это
 *    делает сервер). Чип «Травма 3» обещает три методики, где бы они ни
 *    лежали, а методики общего каталога и вовсе стоят вне папок.
 */
export function listQuery(view: CatalogueView): SurveyPageQuery {
  const q = view.q.trim();
  const domain = view.domain ?? undefined;
  const folder = view.folder ?? (q || domain ? undefined : "root");
  const byDomain = domain ? { domain } : {};
  if (view.tab === "retired") return { folder, q, archived: true, ...byDomain };
  return {
    folder,
    q,
    status: view.tab === "drafts" ? "draft" : "published",
    limit: view.per,
    offset: pageOffset(view.page, view.per),
    ...byDomain,
  };
}

/* ─────────── направления ─────────── */

/** Значение чипа «Напрям»: направление или `none` — методики без направления */
export type DomainFilter = SurveyDomain | typeof NO_DOMAIN;

/** Чип из адреса: незнакомое слово (старая закладка, опечатка) — без фильтра, а не пустой каталог */
export function domainFrom(raw: string | null): DomainFilter | null {
  if (raw === NO_DOMAIN) return NO_DOMAIN;
  return isSurveyDomain(raw) ? raw : null;
}

/** Методика на вкладке — то же правило, что у чисел вкладок экрана */
function onTab(s: Pick<SurveyListItem, "status" | "archivedAt">, tab: CatalogueTab): boolean {
  if (tab === "retired") return !!s.archivedAt;
  return !s.archivedAt && s.status === (tab === "drafts" ? "draft" : "published");
}

/**
 * Числа чипов «Напрям»: сколько методик вкладки у каждого направления и без
 * него, и сколько всего.
 *
 * Основа — та же, что у чисел вкладок: весь видимый каталог (список экрана
 * целиком), отобранный по вкладке и группе. Папка и поиск сюда не входят —
 * числа вкладок их не учитывают тоже, и чип с одним числом в корне и другим в
 * папке читался бы как разный каталог. В корне без поиска число чипа и есть
 * то, что покажет таблица.
 *
 * Направления — в порядке перечня (SURVEY_DOMAINS), а не по убыванию чисел:
 * чип не должен переезжать с места, когда в каталог добавили методику.
 */
export function domainCounts(
  items: readonly Pick<SurveyListItem, "domain" | "status" | "archivedAt" | "groupId">[],
  tab: CatalogueTab,
  group: string | null,
): { all: number; none: number; domains: { domain: SurveyDomain; count: number }[] } {
  const counts = new Map<SurveyDomain, number>();
  let all = 0;
  let none = 0;
  for (const s of items) {
    if (!onTab(s, tab) || (group && s.groupId !== group)) continue;
    all += 1;
    if (s.domain) counts.set(s.domain, (counts.get(s.domain) ?? 0) + 1);
    else none += 1;
  }
  return { all, none, domains: SURVEY_DOMAINS.map((domain) => ({ domain, count: counts.get(domain) ?? 0 })) };
}

/** Страница снятых из полного списка: сервер отдаёт снятые вместе с остальными */
export function retiredPage(items: SurveyListItem[], page: number, per: number): { items: SurveyListItem[]; total: number } {
  const retired = items.filter((s) => !!s.archivedAt);
  const from = (page - 1) * per;
  return { items: retired.slice(from, from + per), total: retired.length };
}

/* ─────────── адрес ─────────── */

/**
 * Адрес экрана из его состояния. Умолчания в адрес не пишутся: «/surveys»
 * и «/surveys?page=1&per=10» — одна и та же страница, и закладок на неё
 * не должно быть двух.
 */
export function catalogueHref(
  tab: CatalogueTab,
  state: { folder?: string | null; q?: string; page?: number; per?: number; domain?: DomainFilter | null } = {},
): string {
  const qs = new URLSearchParams();
  if (state.folder) qs.set("folder", state.folder);
  if (state.q?.trim()) qs.set("q", state.q.trim());
  if (state.domain) qs.set("domain", state.domain);
  if (state.page && state.page > 1) qs.set("page", String(state.page));
  if (state.per && state.per !== DEFAULT_PER) qs.set("per", String(state.per));
  const tail = qs.toString();
  return `${TAB_PATH[tab]}${tail ? `?${tail}` : ""}`;
}

/* ─────────── папки ─────────── */

/** Папки этого уровня в порядке сервера; null — корни всех видимых групп */
export function folderChildren<F extends SurveyFolder>(folders: readonly F[], parentId: string | null): F[] {
  return folders.filter((f) => f.parentId === parentId);
}

/**
 * Хлебные крошки: от корня до папки включительно. Пустой список — папки
 * нет среди видимых (удалена, чужая, опечатка в адресе): экран показывает
 * корень, а не ломается.
 *
 * Кольцо родителей (а → б → а) сервер запрещает, но защита от него стоит и
 * здесь: список пришёл по сети, и одна испорченная строка не должна
 * вешать вкладку бесконечным циклом.
 */
export function folderPath<F extends SurveyFolder>(folders: readonly F[], id: string): F[] {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const path: F[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const f = byId.get(cursor);
    if (!f) return [];
    path.unshift(f);
    cursor = f.parentId;
  }
  return path;
}

/**
 * Папки одной группы деревом в один список — для селекта «перемістити».
 * Глубина нужна отступу: «Тести за 2023» и «— лютий 2023» читаются как
 * вложенность, а плоский список одинаковых названий из разных годов — нет.
 */
export function folderOptions<F extends SurveyFolder>(
  folders: readonly F[],
  groupId: string,
): { id: string; title: string; depth: number }[] {
  const out: { id: string; title: string; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const f of folders) {
      if (f.groupId !== groupId || f.parentId !== parentId || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ id: f.id, title: f.title, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/* ─────────── отмеченные ─────────── */

/**
 * Значение, общее для всех отмеченных, — умолчание окна переноса: все в
 * одной группе — она и стоит в выборе. Разные или пусто — undefined.
 */
export function sameValue<V>(values: readonly V[]): V | undefined {
  const [first] = values;
  return values.length && values.every((v) => v === first) ? first : undefined;
}

/**
 * Что сделать с методикой, чтобы она оказалась в группе и папке.
 *
 * Смена группы — правка методики (PATCH, groupId), и сервер при ней сам
 * снимает методику с полки: папка живёт в группе. Поэтому после смены
 * группы методика в корне новой группы, и папку ставит уже второй шаг —
 * перенос (PUT /folder). Методику, которая и так там, не трогает ни один:
 * лишний перенос писал бы в журнал перемещение, которого не было.
 */
export function movePlan(
  s: Pick<SurveyListItem, "groupId" | "folderId">,
  groupId: string,
  folderId: string | null,
): { group: boolean; folder: boolean } {
  const group = (s.groupId ?? null) !== groupId;
  const folderNow = group ? null : (s.folderId ?? null);
  return { group, folder: folderNow !== folderId };
}

/**
 * Выдать отмеченные методики одному адресату, пропуская пары «адресат ×
 * методика», прошедшие в прошлой попытке той же операции.
 *
 * Повторная выдача не безобидна: grantAccess заново начинает выдачу и
 * обнуляет счёт попыток, и методика, которую человек успел пройти между
 * попытками, получила бы ещё одну. Отказ по одной методике не обрывает
 * остальные (как eachOf в ui/action.ts).
 *
 * `done` помнит прошедшие пары, только пока у адресата есть не прошедшие:
 * дошло всё — операция для него закончена, и его пары забываются. Иначе
 * следующее назначение тому же человеку (ещё одна попытка после
 * прохождения) молча пропускалось бы.
 */
export async function assignPending<S extends { id: string }>(
  surveys: readonly S[],
  target: string,
  done: Set<string>,
  act: (s: S) => Promise<unknown>,
): Promise<{ failed: { item: S; reason: string | null }[] }> {
  const failed: { item: S; reason: string | null }[] = [];
  for (const s of surveys) {
    const key = `${target}|${s.id}`;
    if (done.has(key)) continue;
    try {
      await act(s);
      done.add(key);
    } catch (e) {
      failed.push({ item: s, reason: e instanceof Error && e.message ? e.message : null });
    }
  }
  if (!failed.length) for (const s of surveys) done.delete(`${target}|${s.id}`);
  return { failed };
}

/* ─────────── даты ─────────── */

/**
 * «05.02.2023» — дата папки как на макете, одинаково на обоих языках.
 *
 * Не через toLocaleDateString: у той форма «5 лют. 2023», а макет даёт
 * числовую с ведущими нулями, и колонка дат в строке папок обязана быть
 * одной ширины. Берётся календарная часть строки, без разбора времени и
 * пояса: дата папки — день, а не момент.
 */
export function numericDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Сегодня по местному календарю в виде ГГГГ-ММ-ДД — умолчание даты новой папки */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
