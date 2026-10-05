import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { isLang, type Lang } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { asSystem, systemContext } from "../db/context";
import { pushDeliveries, pushOutcomes, pushTokens } from "../db/schema";
import { log } from "./log";

/**
 * Пуш-уведомления через Expo Push API.
 *
 * В сообщении нет персональных данных и клинических подробностей: «назначено
 * обследование», «тревога в вашей группе». Экран блокировки видят посторонние
 * — в казарме, в транспорте, на построении, — и уведомление не должно
 * сообщать им ничего о состоянии человека.
 *
 * Отправка идемпотентна по ключу события: уведомление, ушедшее дважды,
 * приучает игнорировать уведомления, а это дороже, чем не отправить вовсе.
 */

/**
 * Текст уведомления: готовой строкой или по языку.
 *
 * Функцией — когда текст зависит от языка: он собирается отдельно для
 * каждого устройства, на языке его приложения (push_tokens.lang). У одного
 * человека телефон может быть на английском, а планшет в кабинете — на
 * украинском, и каждый получит своё. Строкой — когда язык выбирать не из
 * чего (тесты, служебные сообщения).
 */
export type PushText = string | ((lang: Lang) => string);

export interface PushMessage {
  /** Ключ события: `assignment:<id>`; по нему же дедупликация */
  eventKey: string;
  kind: string;
  title: PushText;
  body: PushText;
  /** Куда открыть приложение */
  path?: string;
}

const render = (text: PushText, lang: Lang) => (typeof text === "string" ? text : text(lang));

/**
 * Ответ Expo по одному сообщению — «билет». Порядок билетов совпадает с
 * порядком сообщений в запросе; `ok` значит «принято в очередь Expo», а не
 * «доставлено»: что стало дальше, говорит квитанция (checkPushReceipts).
 */
export interface PushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Отправщик возвращает билеты — или ничего, если их не у кого спросить:
 * «ничего» (undefined) — это ТОЛЬКО подменённый в тестах отправщик без
 * билетов, и читается оно как «принято без билета»: квитанцию по такому не
 * спросить, и в разбивке он честно числится без неё. Настоящий отправщик
 * ничего не возвращает никогда: ответ Expo без билетов — ошибка протокола,
 * и он её бросает (см. expoSender).
 */
type Sender = (
  messages: { to: string; title: string; body: string; data?: unknown }[],
) => Promise<PushTicket[] | void>;

/**
 * Настоящий отправщик — Expo Push API: у приложения нет своего сервера
 * доставки, а заводить его ради двух типов сообщений значило бы взять на
 * себя всю возню с сертификатами Apple и ключами Google.
 *
 * Экспортирован ради тестов, которые подменяют не его, а сеть (fetch): так
 * проверяется разбор настоящего ответа, а не стаб.
 */
export const expoSender: Sender = async (messages) => {
  if (!messages.length) return [];
  /*
   * С таймаутом: без него зависший (не отказавший) сервис уведомлений
   * держит соединение из пула базы столько, сколько ему угодно, а тик
   * рассылки идёт каждую минуту. Десять таких — и пул кончился, вместе с
   * ним и обслуживание запросов.
   */
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`expo push ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  /*
   * Ответ без массива билетов — не «принято», а ошибка протокола.
   *
   * Прежде такой ответ возвращался как undefined и дальше читался как
   * «принято без билета»: пустое тело, ошибка в JSON, ответ другой формы —
   * всё становилось доставкой, заявка оставалась, и уведомление, о судьбе
   * которого ничего не известно, не повторялось никогда (внешний разбор
   * 2026-09-27, #19). Бросаем — и оно идёт тем же путём, что сетевой сбой:
   * исход failed с кодом protocol, заявка снята, следующий проход повторит.
   */
  if (!Array.isArray(body?.data)) throw new Error("expo push malformed: no tickets");
  return body.data as PushTicket[];
};

/** Отправщик подменяется в тестах; по умолчанию — настоящий */
let sender: Sender = expoSender;

/**
 * Билеты той формы и длины, что обещает Expo: по одному на сообщение, в том
 * же порядке, у каждого status ok|error, у принятого — id (без него квитанцию
 * не спросить, и «принято» ничем не подтверждается). Пустой или короткий
 * массив, билет без статуса, принятый без id — ошибка протокола: исход
 * неизвестен, и его нельзя записывать ни успехом, ни отказом.
 */
function wellFormedTickets(tickets: unknown, count: number): tickets is PushTicket[] {
  if (!Array.isArray(tickets) || tickets.length !== count) return false;
  return tickets.every((t: unknown) => {
    if (!t || typeof t !== "object") return false;
    const ticket = t as Partial<PushTicket>;
    if (ticket.status === "ok") return typeof ticket.id === "string" && ticket.id.length > 0;
    return ticket.status === "error";
  });
}

export function setPushSenderForTests(next: Sender | null): void {
  sender =
    next ??
    (async () => {
      /* по умолчанию — ничего: тест, забывший подменить, не пойдёт наружу */
    });
}

/** Зарегистрировать устройство: повторная регистрация обновляет отметку */
export async function registerDevice(
  userId: string,
  token: string,
  platform: "ios" | "android" | "web",
  /** Язык приложения на устройстве — из заголовка регистрации */
  lang: Lang | null = null,
): Promise<void> {
  /*
   * Системной ролью, и это не послабление. Токен переезжает к тому, кто
   * вошёл на устройстве последним, — а строка токена до этой минуты
   * принадлежит предыдущему. Политика push_tokens (своя строка) не пускала
   * ON CONFLICT DO UPDATE к чужой строке: под ролью приложения регистрация
   * падала пятисоткой, новый человек уведомлений не получал, а прежний
   * продолжал получать свои на телефон, которым теперь пользуется другой
   * (волна 13, прогон platform.test.ts под ролью приложения). Сам токен —
   * доказательство владения устройством: его выдаёт устройство, а не
   * сервер. Привязать токен можно только к себе — userId здесь всегда
   * вошедший, его подставляет маршрут.
   */
  await asSystem(() =>
    db
      .insert(pushTokens)
      .values({ id: crypto.randomUUID(), userId, token, platform, lang })
      .onConflictDoUpdate({
        target: pushTokens.token,
        /*
         * Язык обновляется при каждой регистрации: человек переключил язык
         * в приложении — приложение перерегистрирует устройство, и следующее
         * уведомление придёт уже на новом.
         */
        set: { userId, platform, lang, lastSeenAt: new Date().toISOString() },
      }),
  );
}

export async function forgetDevice(token: string): Promise<void> {
  await db.delete(pushTokens).where(eq(pushTokens.token, token));
}

/**
 * Отправить уведомление человеку на все его устройства.
 *
 * Возвращает `false`, если сообщение уже уходило: вызывающий код может не
 * проверять это сам — идемпотентность живёт здесь, а не рассыпана по местам
 * отправки.
 */
export async function pushToUser(
  userId: string,
  message: PushMessage,
  /**
   * Язык для устройств, которые своего не прислали (зарегистрированы до
   * миграции 0087). Вызывающий знает о человеке больше, чем эта функция, —
   * например, язык его последнего прохождения, — и решает сам.
   */
  fallbackLang: Lang = "uk",
): Promise<boolean> {
  /*
   * Устройства проверяются ДО заявки на отправку.
   *
   * Раньше заявка вставлялась первой, и человек без зарегистрированного
   * устройства получал строку с признаком «успешно». Зарегистрировал
   * телефон через десять минут — напоминание за сутки ему уже не придёт
   * никогда: ключ (человек, событие) занят доставкой, которой не было.
   */
  const devices = await db.select().from(pushTokens).where(eq(pushTokens.userId, userId));
  if (!devices.length) return false;

  /*
   * Заявка: новая строка — или своя же, возвращённая квитанцией на повтор.
   *
   * Квитанция Expo приходит через четверть часа после отправки и может
   * сказать «не передано, лимит частоты» (checkPushReceipts). Такая заявка
   * остаётся на месте — с ok = false и сроком retry_after, — и взять её
   * снова можно только когда срок вышел. Так повтор идёт с задержкой, а не
   * каждую минуту, и той же строкой: исходы по устройствам (push_outcomes)
   * продолжают указывать на неё, и счётчик попыток растёт.
   */
  const [claimed] = await db
    .insert(pushDeliveries)
    .values({
      id: crypto.randomUUID(),
      userId,
      eventKey: message.eventKey,
      kind: message.kind,
    })
    .onConflictDoUpdate({
      target: [pushDeliveries.userId, pushDeliveries.eventKey],
      set: {
        sentAt: sql`now()`,
        ok: true,
        error: null,
        retryAfter: null,
        attempts: sql`${pushDeliveries.attempts} + 1`,
      },
      setWhere: sql`${pushDeliveries.retryAfter} is not null and ${pushDeliveries.retryAfter} <= now()`,
    })
    .returning({ id: pushDeliveries.id, attempts: pushDeliveries.attempts });

  // уже отправляли (или срок повтора ещё не вышел) — второй раз не тревожим
  if (!claimed) return false;

  let tickets: PushTicket[] | void;
  try {
    tickets = await sender(
      devices.map((d) => {
        const lang = isLang(d.lang) ? d.lang : fallbackLang;
        return {
          to: d.token,
          title: render(message.title, lang),
          body: render(message.body, lang),
          data: message.path ? { path: message.path } : undefined,
        };
      }),
    );
    /*
     * Билеты не той формы — исход неизвестен, и он не записывается успехом.
     *
     * Прежде отсутствующий билет читался как принятый (`!ticket`), а пустой
     * массив — как «все приняты»: заявка оставалась, ok = true, повтора не
     * было (внешний разбор 2026-09-27, #19). Ошибка протокола идёт тем же
     * путём, что сетевой сбой ниже: исход failed с кодом protocol — его
     * видно в разбивке техпанели, — заявка снята, следующий проход повторит.
     * «Хотя бы один раз» здесь — как у сетевого сбоя: запрос мог дойти до
     * Expo, но подтверждения нет, а пропущенное уведомление дороже лишнего.
     */
    const returned: unknown = tickets;
    if (returned !== undefined && !wellFormedTickets(returned, devices.length)) {
      const shape = Array.isArray(returned) ? `${returned.length} tickets for ${devices.length} devices` : "not an array";
      throw new Error(`expo push malformed: ${shape}`);
    }
  } catch (error) {
    // исход пишется и здесь: «до Expo не дошли» — ровно то, что потом ищут
    await recordOutcomes(devices, message.kind, null, failureCode(error), claimed.id);
    /*
     * Заявка снимается, чтобы следующий проход попробовал снова.
     *
     * Прежде она оставалась с пометкой «не вышло», а уникальный ключ
     * (человек, событие) навсегда закрывал повтор: сеть моргнула на две
     * секунды в момент рассылки — и напоминание о завтрашнем приёме не
     * придёт уже никогда. Push здесь единственный канал, второго нет.
     *
     * Отказ остаётся в журнале приложения; в таблице доставок ему делать
     * нечего — она отвечает на вопрос «отправляли ли», а не «пытались ли».
     */
    await db.delete(pushDeliveries).where(eq(pushDeliveries.id, claimed.id));
    log.warn("push.failed", { userId, kind: message.kind, error: String(error) });
    return false;
  }

  await recordOutcomes(devices, message.kind, tickets ?? null, null, claimed.id);
  await forgetDeadTokens(
    devices.filter((_, i) => (tickets ?? [])[i]?.details?.error === "DeviceNotRegistered").map((d) => d.token),
  );

  /*
   * Билет с ошибкой — отказ, а не доставка.
   *
   * Expo отвечает 200 на весь запрос, а отказ по каждому устройству лежит
   * внутри его билета. Прежде любой ответ без исключения читался как успех:
   * заявка оставалась, и уведомление, которое Expo отверг (сработал лимит
   * частоты — MessageRateExceeded), числилось отправленным и не повторялось
   * никогда.
   *
   * Теперь: приняло хотя бы одно устройство — доставлено (человек его
   * увидит). Не приняло ни одно — смотрим, почему. Отказ, который повтор не
   * исправит (MessageTooBig: тот же текст короче не станет), заявку
   * оставляет с пометкой ok = false — второй раз не шлём, но и доставкой не
   * числим. Остальное — временное или починимое (лимит частоты, ключи
   * провайдера, удалённое приложение — токен выше уже забыт, и новое
   * устройство должно получить своё), и заявка снимается, как при сетевом
   * сбое: следующий проход попробует снова.
   */
  const verdict = ticketVerdict(tickets, devices.length);
  if (verdict.accepted) return true;
  if (verdict.permanent) {
    await db
      .update(pushDeliveries)
      .set({ ok: false, error: verdict.code })
      .where(eq(pushDeliveries.id, claimed.id));
    log.warn("push.rejected", { userId, kind: message.kind, error: verdict.code });
    return false;
  }
  await db.delete(pushDeliveries).where(eq(pushDeliveries.id, claimed.id));
  log.warn("push.rejected_retry", { userId, kind: message.kind, error: verdict.code });
  return false;
}

/** Отказы Expo, которые повтор того же сообщения не исправит */
const PERMANENT_TICKET_ERRORS = new Set(["MessageTooBig"]);

/**
 * Что сказали билеты: принято ли хоть одним устройством, а если нет —
 * постоянный ли отказ. Билетов нет вовсе (тестовый отправитель ничего не
 * вернул) — «принято без билета», как и в разбивке исходов выше. Форма и
 * длина массива проверены до этого (wellFormedTickets): недостающий билет
 * сюда не доходит и принятым не считается.
 */
function ticketVerdict(
  tickets: PushTicket[] | void,
  devices: number,
): { accepted: true } | { accepted: false; permanent: boolean; code: string } {
  if (!tickets) return { accepted: true };
  const codes: string[] = [];
  for (let i = 0; i < devices; i++) {
    const ticket = tickets[i]!;
    if (ticket.status !== "error") return { accepted: true };
    codes.push(ticket.details?.error ?? "unknown");
  }
  return {
    accepted: false,
    permanent: codes.every((c) => PERMANENT_TICKET_ERRORS.has(c)),
    code: codes[0] ?? "unknown",
  };
}

/** Уведомить нескольких: используется для дежурных по группе */
export async function pushToUsers(
  userIds: string[],
  message: PushMessage,
  fallbackLang: Lang = "uk",
): Promise<number> {
  let sent = 0;
  for (const id of userIds) if (await pushToUser(id, message, fallbackLang)) sent++;
  return sent;
}

/* ─────────── исходы и квитанции (миграция 0091) ─────────── */

/**
 * Отпечаток токена: первые 16 знаков SHA-256.
 *
 * Токен — адрес устройства человека: с ним уведомление уходит в обход
 * системы. Для «сколько ошибок на скольких устройствах» отпечатка хватает, а
 * техпанель не получает ни одного адреса. 64 бита — столкновений на
 * отделение не будет; по отпечатку же находится токен для удаления: SQL
 * считает тот же SHA-256 (TOKEN_FINGERPRINT ниже).
 */
export function tokenFingerprint(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex").slice(0, 16);
}

const TOKEN_FINGERPRINT = sql`left(encode(sha256(convert_to(${pushTokens.token}, 'UTF8')), 'hex'), 16)`;

/** Код сбоя отправки — без текста исключения: в нём бывают адреса и токены */
function failureCode(error: unknown): string {
  const text = String(error);
  const http = /expo push (\d{3})/.exec(text);
  if (http) return `http_${http[1]}`;
  // ответ пришёл, но не той формы: без билетов, короче списка устройств, билет без статуса или id
  if (/malformed/i.test(text)) return "protocol";
  if (/timeout|abort/i.test(text)) return "timeout";
  return "network";
}

/**
 * Записать исход по каждому устройству.
 *
 * Своей транзакцией (systemContext), а не текущей. Причин две. Отправка
 * бывает изнутри запроса — рассылка идёт в транзакции сотрудника, — и
 * отказ записи исхода там откатил бы саму рассылку: PostgreSQL обрывает всю
 * транзакцию на первой ошибке, как её ни лови. И по смыслу: уведомление уже
 * ушло с сервера, и если запрос потом откатится, факт отправки от этого не
 * исчезнет. Сбой записи исхода глотается — учёт не должен мешать доставке.
 */
async function recordOutcomes(
  devices: { token: string; platform: string }[],
  kind: string,
  tickets: PushTicket[] | null,
  failure: string | null,
  /** Заявка, по которой шла отправка: по ней квитанция возвращает событие в очередь */
  deliveryId: string,
): Promise<void> {
  if (!devices.length) return;
  try {
    await systemContext(baseDb, () =>
      db.insert(pushOutcomes).values(
        devices.map((d, i) => {
          const ticket = tickets?.[i];
          const rejected = ticket?.status === "error";
          return {
            id: crypto.randomUUID(),
            kind,
            platform: d.platform,
            tokenHash: tokenFingerprint(d.token),
            status: failure ? ("failed" as const) : rejected ? ("rejected" as const) : ("accepted" as const),
            error: failure ?? (rejected ? (ticket?.details?.error ?? "unknown") : null),
            ticketId: !failure && ticket?.status === "ok" ? (ticket.id ?? null) : null,
            deliveryId,
          };
        }),
      ),
    );
  } catch (error) {
    log.warn("push.outcome_write_failed", { kind, error: String(error) });
  }
}

/**
 * Токены, про которые Expo сказал DeviceNotRegistered, забываются.
 *
 * Так советует сам Expo: приложение удалено или переустановлено, и адреса
 * больше нет. Слать на него дальше — копить ошибки и тратить лимит частоты
 * на устройство, которого нет. Откроет человек приложение снова — оно
 * зарегистрируется заново (apps/mobile/src/push.ts).
 */
async function forgetDeadTokens(tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  try {
    await systemContext(baseDb, () => db.delete(pushTokens).where(inArray(pushTokens.token, tokens)));
  } catch (error) {
    log.warn("push.forget_dead_failed", { error: String(error) });
  }
}

/** Квитанция Expo по билету */
export interface PushReceipt {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}
type ReceiptFetcher = (ids: string[]) => Promise<Record<string, PushReceipt>>;

let receiptFetcher: ReceiptFetcher = async (ids) => {
  const res = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`expo receipts ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: Record<string, PushReceipt> } | null;
  return body?.data ?? {};
};

export function setPushReceiptFetcherForTests(next: ReceiptFetcher | null): void {
  // по умолчанию — пусто: тест, забывший подменить, не пойдёт наружу
  receiptFetcher = next ?? (async () => ({}));
}

/** Сколько ждать квитанцию: раньше Expo её не отдаёт, позже — уже не хранит */
const RECEIPT_AFTER_MS = 15 * 60_000;
const RECEIPT_KEEP_MS = 24 * 3_600_000;
/** Исходы старше полугода не нужны: «почему не дошло» дольше не спрашивают */
const OUTCOME_KEEP_MS = 183 * 86_400_000;

/**
 * Забрать квитанции по билетам — тик планировщика.
 *
 * Билет говорит «Expo принял», квитанция — «передано Apple/Google» или код
 * отказа. Доставку до самого устройства не сообщает никто: ни Expo, ни
 * Apple, ни Google. Поэтому в техпанели это подписано честно — «передано
 * Apple/Google», а не «доставлено».
 *
 * Квитанции Expo хранит сутки и отдаёт не раньше, чем через несколько минут
 * после отправки: окно выборки — от 15 минут до суток. Тысяча за раз —
 * потолок одного запроса getReceipts. Заодно — срок хранения исходов.
 */
export async function checkPushReceipts(
  now = new Date(),
): Promise<{ checked: number; errors: number; purged: number; requeued: number }> {
  const rows = await db
    .select({
      id: pushOutcomes.id,
      ticketId: pushOutcomes.ticketId,
      tokenHash: pushOutcomes.tokenHash,
      deliveryId: pushOutcomes.deliveryId,
    })
    .from(pushOutcomes)
    .where(
      and(
        isNotNull(pushOutcomes.ticketId),
        isNull(pushOutcomes.receiptStatus),
        gte(pushOutcomes.at, new Date(now.getTime() - RECEIPT_KEEP_MS).toISOString()),
        lte(pushOutcomes.at, new Date(now.getTime() - RECEIPT_AFTER_MS).toISOString()),
      ),
    )
    .limit(1000);

  let checked = 0;
  let errors = 0;
  const dead = new Set<string>();
  /** Заявки, по которым квитанция сказала «не передано»: код отказа по заявке */
  const refused = new Map<string, string>();
  if (rows.length) {
    const receipts = await receiptFetcher(rows.map((r) => r.ticketId!));
    const at = now.toISOString();
    for (const row of rows) {
      const receipt = receipts[row.ticketId!];
      if (!receipt) continue; // ещё не готова — заберёт следующий тик
      checked++;
      const code = receipt.status === "error" ? (receipt.details?.error ?? "unknown") : null;
      if (code) errors++;
      if (code === "DeviceNotRegistered") dead.add(row.tokenHash);
      if (code && row.deliveryId) refused.set(row.deliveryId, code);
      await db
        .update(pushOutcomes)
        .set({ receiptStatus: receipt.status === "ok" ? "ok" : "error", receiptError: code, receiptAt: at })
        .where(eq(pushOutcomes.id, row.id));
    }
  }
  if (dead.size) await db.delete(pushTokens).where(inArray(TOKEN_FINGERPRINT, [...dead]));
  const requeued = refused.size ? await requeueRefused(refused, now) : 0;

  const purged = await db
    .delete(pushOutcomes)
    .where(lt(pushOutcomes.at, new Date(now.getTime() - OUTCOME_KEEP_MS).toISOString()))
    .returning({ id: pushOutcomes.id });

  return { checked, errors, purged: purged.length, requeued };
}

/** Первая задержка повтора по квитанции; дальше — удвоение, до потолка */
const RECEIPT_RETRY_BASE_MS = 15 * 60_000;
const RECEIPT_RETRY_MAX_MS = 4 * 3_600_000;

/**
 * Вернуть в очередь события, которых квитанция не подтвердила.
 *
 * Билет говорит лишь «Expo принял в очередь»; что устройство не получило,
 * выясняется из квитанции через четверть часа. Прежде такая квитанция
 * только отмечала исход в push_outcomes: заявка в push_deliveries оставалась
 * с ok = true, повтор pushToUser с тем же ключом события отсекался, и
 * напоминание, отвергнутое лимитом частоты (MessageRateExceeded — Expo
 * прямо велит повторить с задержкой), не доходило никогда (внешний разбор
 * 2026-09-27, #18).
 *
 * Правило — то же, что у билетов (pushToUser): дошло хоть до одного
 * устройства человека — доставлено, повтора нет (иначе второе устройство
 * получало бы уведомление дважды). Не дошло ни до одного: постоянный отказ
 * (MessageTooBig) закрывает заявку с ok = false навсегда; остальное —
 * временное, и заявка получает срок повтора: 15 минут после первой попытки,
 * дальше вдвое, до четырёх часов. До срока pushToUser её не берёт; после —
 * берёт ту же строку и шлёт снова. Квитанция о повторе придёт по новому
 * билету и попадёт сюда же — цикл с ростом задержки, а не каждую минуту.
 */
async function requeueRefused(refused: Map<string, string>, now: Date): Promise<number> {
  const ids = [...refused.keys()];
  const rows = await db
    .select({ id: pushDeliveries.id, attempts: pushDeliveries.attempts })
    .from(pushDeliveries)
    .where(
      and(
        inArray(pushDeliveries.id, ids),
        // уже возвращённую или закрытую заявку второй раз не трогаем
        eq(pushDeliveries.ok, true),
        // хотя бы одно устройство квитанция подтвердила — доставлено, повтор был бы дублем
        sql`not exists (select 1 from push_outcomes o
          where o.delivery_id = ${pushDeliveries.id} and o.receipt_status = 'ok')`,
      ),
    );
  let requeued = 0;
  for (const row of rows) {
    const code = refused.get(row.id) ?? "unknown";
    const permanent = PERMANENT_TICKET_ERRORS.has(code);
    const delay = Math.min(RECEIPT_RETRY_BASE_MS * 2 ** Math.max(row.attempts - 1, 0), RECEIPT_RETRY_MAX_MS);
    await db
      .update(pushDeliveries)
      .set({
        ok: false,
        error: code,
        retryAfter: permanent ? null : new Date(now.getTime() + delay).toISOString(),
      })
      .where(and(eq(pushDeliveries.id, row.id), eq(pushDeliveries.ok, true)));
    if (!permanent) requeued++;
    log.warn(permanent ? "push.receipt_rejected" : "push.receipt_retry", {
      deliveryId: row.id,
      error: code,
      attempts: row.attempts,
      ...(permanent ? {} : { retryInMs: delay }),
    });
  }
  return requeued;
}
