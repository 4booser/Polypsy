import type { Mailing, MailingInput, MailingUpdateInput } from "@quizzy/shared";

/**
 * Чистая часть «Листування» и «Розсилок»: черновик формы розсилки и его
 * запрос, виды и порядок списка разговоров, лента по дням, окна переноса.
 * Вынесено из экранов ради проверки без React и сервера
 * (apps/web/test/mailings.test.tsx, messages.test.ts): у пустых вариантов,
 * потолка на их число, порядка «спершу ті, що чекають» есть граничные
 * случаи, которые на живом экране воспроизводятся только руками.
 */

/** Потолок сервера (mailingInputSchema: options ≤ 10) — глиф «+» гаснет на нём */
export const MAX_OPTIONS = 10;

export interface MailingDraft {
  title: string;
  body: string;
  options: string[];
  /** Пустая строка — адресат не выбран: селект не умеет null */
  patientGroupId: string;
  /**
   * Редакция, с которой черновик открыт (Mailing.revision); null — повідомлення
   * ещё не заведено. Уходит в правку и отправку: сервер сверяет её с тем, что
   * лежит у него, и поверх чужой правки отвечает 409 (волна 15).
   */
  revision: number | null;
}

export const mailingHref = (id: string) => `/mailings/${id}`;

/**
 * Варианты ответа, какими они уйдут на сервер: без пробелов по краям, без
 * пустых, не больше потолка.
 *
 * Пустой вариант выбрасывается, а не отклоняется: у варианта есть
 * «прибрати», но стереть текст — тоже способ убрать, и ругаться на пустое
 * поле значило бы спорить с человеком о том, что он уже решил.
 */
export function cleanOptions(options: readonly string[]): string[] {
  return options
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .slice(0, MAX_OPTIONS);
}

export function draftFromMailing(m: Mailing): MailingDraft {
  return {
    title: m.title,
    body: m.body,
    options: [...m.options],
    patientGroupId: m.patientGroupId ?? "",
    revision: m.revision,
  };
}

/**
 * Тело запроса из черновика. Поимённый список адресатов (patientIds) не
 * посылается вовсе: на кадрах его нет, экран его не ведёт, а прислать пустой
 * массив значило бы стереть список, заведённый другим способом.
 */
export function draftToInput(d: MailingDraft): MailingInput {
  return {
    title: d.title.trim(),
    body: d.body.trim(),
    options: cleanOptions(d.options),
    patientGroupId: d.patientGroupId || null,
  };
}

/** Есть ли что сохранять: сервер требует непустые название и текст (min(1)) */
export const isFilled = (d: MailingDraft) => d.title.trim().length > 0 && d.body.trim().length > 0;

/**
 * Тело «Зберегти»: то, что на экране, и редакция, поверх которой правили.
 *
 * Без редакции две вкладки (или автор и суперадмин) молча затирали правки
 * друг друга: побеждал нажавший вторым. С ней сервер отвечает 409, и экран
 * предлагает перечитать.
 */
export function draftToUpdate(d: MailingDraft): MailingUpdateInput {
  return { ...draftToInput(d), ...(d.revision !== null && { baseRevision: d.revision }) };
}

export interface SendIo {
  /** «Зберегти» — ответ: сохранённая рассылка с новой редакцией */
  save: (input: MailingUpdateInput) => Promise<Mailing>;
  /** «Відправити» ровно эту редакцию */
  send: (revision: number) => Promise<unknown>;
  /** Положить сохранённое на экран */
  apply: (saved: Mailing) => void;
}

/**
 * «Відправити» с экрана: сохранить то, что видно, и отправить ровно
 * сохранённую редакцию.
 *
 * Сохранение нужно, потому что человек мог править и не нажать «Зберегти»:
 * уйти должно то, что он видит. Отправка называет редакцию, которую вернуло
 * сохранение, — если между двумя запросами черновик переписал кто-то
 * другой (внешний разбор 2026-09-28, п. 1: иначе уходил чужой текст, да ещё
 * прежним адресатам), сервер откажет 409, и не уйдёт ничего. Сохранённое
 * ложится на экран сразу, до отправки: не удалась отправка — повтор не
 * упрётся в конфликт с собственной правкой.
 */
export async function saveThenSend(d: MailingDraft, io: SendIo): Promise<void> {
  const saved = await io.save(draftToUpdate(d));
  io.apply(saved);
  await io.send(saved.revision);
}

/* ═══════════ листування: список разговоров (консоль 2.0) ═══════════ */

/** Ближайший свой приём человека — его и переносят из переписки */
export interface NextVisit {
  id: string;
  startsAt: string;
  endsAt: string;
  room: string | null;
  mode: "onsite" | "remote";
  status: string;
}

/** Строка списка разговоров — то, что отдаёт GET /api/messages специалисту */
export interface ThreadRow {
  id: string;
  withName: string;
  patientId?: string;
  lastMessageAt: string;
  unread: number;
  preview?: string | null;
  lastMine?: boolean | null;
  lastReadAt?: string | null;
  next?: NextVisit | null;
}

/** Виды списка: все, с непрочитанным, ждущие ответа */
export type ThreadView = "all" | "unread" | "wait";
export const THREAD_VIEWS: readonly ThreadView[] = ["all", "unread", "wait"];

export const viewFrom = (raw: string | null): ThreadView =>
  THREAD_VIEWS.includes(raw as ThreadView) ? (raw as ThreadView) : "all";

/**
 * Ждёт ответа — последнее письмо разговора от пациента.
 *
 * Не «есть непрочитанное»: прочитанное, но оставленное без ответа письмо
 * ждёт ответа так же, а непрочитанное число гаснет при одном открытии
 * разговора. `lastMine` пуст — писем нет вовсе, ждать нечего.
 */
export const waitsForReply = (t: Pick<ThreadRow, "lastMine">): boolean => t.lastMine === false;

export function threadInView(t: ThreadRow, view: ThreadView): boolean {
  if (view === "unread") return t.unread > 0;
  if (view === "wait") return waitsForReply(t);
  return true;
}

/** Поиск по имени и началу последнего письма, без регистра */
export function threadMatches(t: ThreadRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return t.withName.toLowerCase().includes(needle) || (t.preview ?? "").toLowerCase().includes(needle);
}

export function threadViewCounts(items: readonly ThreadRow[]): Record<ThreadView, number> {
  return {
    all: items.length,
    unread: items.filter((t) => t.unread > 0).length,
    wait: items.filter(waitsForReply).length,
  };
}

/**
 * Порядок списка: сначала ждущие ответа, среди них — с открытым сигналом
 * риска, дальше свежие сверху. Остальные — свежие сверху.
 *
 * Человек с сигналом и неотвеченным письмом — первая строка, даже если
 * написал вчера: рядом с риском «кто написал последним» вторично.
 */
export function orderThreads(items: readonly ThreadRow[], risky: (patientId: string | undefined) => boolean): ThreadRow[] {
  const rank = (t: ThreadRow) => (waitsForReply(t) ? (risky(t.patientId) ? 0 : 1) : 2);
  const fresh = (a: ThreadRow, b: ThreadRow) => (a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b) || fresh(a, b));
}

/** Шаг J/K по списку: следующий или предыдущий разговор, по краям — стоп */
export function stepThread(order: readonly string[], current: string | undefined, delta: 1 | -1): string | null {
  if (!order.length) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return delta > 0 ? order[0]! : order[order.length - 1]!;
  const next = at + delta;
  return next < 0 || next >= order.length ? null : order[next]!;
}

/**
 * Календарных дней от сегодня до момента по местным часам: 0 — сегодня,
 * 1 — завтра, −1 — вчера. Полуночи, а не сутки от «сейчас»: приём завтра в
 * 09:00 — «завтра», даже если до него двенадцать часов.
 */
export function daysFrom(iso: string, now: number): number {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(new Date(iso)) - midnight(new Date(now))) / 86_400_000);
}

/** Письмо ленты — то, что отдаёт GET /api/messages/:id */
export interface FeedMessage {
  id: string;
  mine: boolean;
  text: string;
  sentAt: string;
  readAt: string | null;
}

/** Лента по дням: разделитель дня ставится перед первым письмом этого дня */
export function feedByDay<M extends Pick<FeedMessage, "sentAt">>(
  items: readonly M[],
  keyOf: (iso: string) => string,
): { key: string; items: M[] }[] {
  const out: { key: string; items: M[] }[] = [];
  for (const m of items) {
    const key = keyOf(m.sentAt);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(m);
    else out.push({ key, items: [m] });
  }
  return out;
}

/**
 * Письмо, оставшееся без ответа, — последнее письмо ленты, если оно от
 * пациента. Его обводят янтарём и подписывают «без відповіді».
 */
export function unansweredId(items: readonly Pick<FeedMessage, "id" | "mine">[]): string | null {
  const last = items[items.length - 1];
  return last && !last.mine ? last.id : null;
}

/** Слот переноса: свободное окно специалиста */
export interface FreeSlot {
  id: string;
  startsAt: string;
  endsAt: string;
  room: string | null;
}

/**
 * Свободные окна по дням — для выбора дня и времени в ящике переноса.
 * Окна в прошлом и окно самого приёма не предлагаются: перенос «на то же
 * время» — не перенос.
 */
export function slotsByDay(
  slots: readonly FreeSlot[],
  keyOf: (iso: string) => string,
  now: number,
  skipStartsAt?: string,
): Map<string, FreeSlot[]> {
  const out = new Map<string, FreeSlot[]>();
  for (const s of [...slots].sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0))) {
    if (Date.parse(s.startsAt) <= now || s.startsAt === skipStartsAt) continue;
    const key = keyOf(s.startsAt);
    const day = out.get(key);
    if (day) day.push(s);
    else out.set(key, [s]);
  }
  return out;
}

/**
 * Форма числа для словаря: «1 людина», «3 людини», «5 людей». Правило — языка
 * (Intl.PluralRules): у украинского и русского три формы, у английского две
 * («other» сводится к «many», и у английской записи many = other).
 */
export type PluralForm = "one" | "few" | "many";
export function pluralForm(n: number, lang: string): PluralForm {
  const form = new Intl.PluralRules(lang).select(n);
  return form === "one" ? "one" : form === "few" ? "few" : "many";
}

/* ═══════════ розсилки: список ═══════════ */

/** Виды списка розсилок: все не скрытые, черновики, отправленные, скрытые */
export type MailingView = "all" | "draft" | "sent" | "hidden";
export const MAILING_VIEWS: readonly MailingView[] = ["all", "draft", "sent", "hidden"];
export const mailingViewFrom = (raw: string | null): MailingView =>
  MAILING_VIEWS.includes(raw as MailingView) ? (raw as MailingView) : "all";

/** Параметры запроса списка по виду: «скрытые» — свой список, состояние — фильтр */
export function mailingQuery(view: MailingView): { hidden?: boolean; status?: "draft" | "sent" } {
  if (view === "hidden") return { hidden: true };
  if (view === "draft" || view === "sent") return { status: view };
  return {};
}

/**
 * Полоса ответов строки: доли вариантов и «ще не відповіли». Ширина — от
 * числа получателей, а не от суммы ответов: полоса, где двое ответивших из
 * двадцати занимают всю длину, обманывала бы глаз.
 */
export function answerShares(answers: readonly number[], recipients: number): { option: number[]; silent: number } {
  const answered = answers.reduce((n, a) => n + a, 0);
  const total = Math.max(recipients, answered);
  if (total <= 0) return { option: answers.map(() => 0), silent: 0 };
  return { option: answers.map((a) => a / total), silent: (total - answered) / total };
}

/** Готовые наборы вариантов редактора: «Так / Ні», «Так / Ні / Ще не знаю», «Без відповіді» */
export function optionPreset(kind: "yesNo" | "yesNoMaybe" | "none", words: { yes: string; no: string; maybe: string }): string[] {
  if (kind === "none") return [];
  return kind === "yesNo" ? [words.yes, words.no] : [words.yes, words.no, words.maybe];
}

/** Убрать вариант по номеру; остальные сохраняют порядок */
export const withoutOption = (options: readonly string[], i: number): string[] => options.filter((_, k) => k !== i);
