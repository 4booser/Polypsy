import { eq } from "drizzle-orm";
import { db } from "../db";
import { asSystem } from "../db/context";
import { googleCalendarTokens } from "../db/schema";
import { env } from "../env";
import { decryptField, encryptField } from "./crypto";
import { log } from "./log";

/**
 * Ссылка на встречу для дистанционного приёма.
 *
 * Ссылку Google Meet нельзя придумать: код вида `abc-defg-hij` выдаёт сам
 * Google, когда создаётся событие календаря с запросом конференции. Любая
 * самодельная ссылка ведёт в никуда, и это худший исход из возможных —
 * человек в назначенное время стучится в закрытую дверь и решает, что его
 * не приняли. Поэтому: либо настоящая ссылка от Google, либо никакой, а
 * специалист вписывает свою.
 *
 * Разрешение спрашивается у специалиста отдельно от входа через Google:
 * вход просит почту и имя, а здесь нужно право писать в его календарь.
 * Просить это у всех и сразу ради возможности, нужной немногим, неверно.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1";

/*
 * Сколько ждать Google при записи на приём. Встреча создаётся внутри
 * транзакции записи, пока слот удержан блокировкой (routes/clinic.ts,
 * takeSlot): зависший Google держал бы и запрос человека, и всех, кто в эту
 * минуту записывается в тот же слот. Не уложился — запись идёт без ссылки,
 * как при любом другом отказе Google.
 */
const GOOGLE_TIMEOUT_MS = 8_000;

export function meetConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret && env.googleRedirectUri);
}

/** Куда отправить специалиста, чтобы он разрешил создавать события */
export function calendarAuthorizeUrl(state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", env.googleClientId!);
  url.searchParams.set("redirect_uri", env.googleRedirectUri!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `openid email ${CALENDAR_SCOPE}`);
  url.searchParams.set("state", state);
  /*
   * offline + consent — единственный способ получить refresh-токен.
   *
   * Без `access_type=offline` Google отдаёт только часовой токен доступа, и
   * встречу нельзя было бы создать ни для одного приёма, назначенного
   * позже. Без `prompt=consent` refresh-токен приходит ТОЛЬКО в первый раз:
   * специалист, однажды подключивший календарь и отключивший его, при
   * повторном подключении не получил бы токена и не понял бы почему.
   */
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

/** Обменять код возврата на долгоживущее разрешение и сохранить его */
export async function storeCalendarGrant(userId: string, code: string): Promise<string | null> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId!,
      client_secret: env.googleClientSecret!,
      redirect_uri: env.googleRedirectUri!,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`google token endpoint: ${res.status}`);
  const body = (await res.json()) as { refresh_token?: string; id_token?: string };
  if (!body.refresh_token) throw new Error("google: разрешение выдано без refresh-токена");

  let email: string | null = null;
  const parts = body.id_token?.split(".");
  if (parts?.length === 3) {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    email = typeof claims.email === "string" ? claims.email : null;
  }

  await db
    .insert(googleCalendarTokens)
    .values({ userId, refreshTokenEnc: encryptField(body.refresh_token)!, googleEmail: email })
    .onConflictDoUpdate({
      target: googleCalendarTokens.userId,
      set: { refreshTokenEnc: encryptField(body.refresh_token)!, googleEmail: email },
    });
  return email;
}

export async function calendarConnection(userId: string): Promise<{ email: string | null } | null> {
  const [row] = await db
    .select()
    .from(googleCalendarTokens)
    .where(eq(googleCalendarTokens.userId, userId));
  return row ? { email: row.googleEmail } : null;
}

export async function disconnectCalendar(userId: string): Promise<void> {
  await db.delete(googleCalendarTokens).where(eq(googleCalendarTokens.userId, userId));
}

/**
 * Разрешение специалиста на календарь — для записи на приём к нему.
 *
 * Системной ролью, узко: одна строка, этого специалиста, и только
 * расшифрованный refresh-токен наружу, который тут же уходит в Google и
 * дальше этого модуля не идёт. Под ролью того, кто записывается, строка не
 * видна (google_calendar_tokens — своя строка или система, 0070): пациент,
 * записавшийся сам, ссылки не получал никогда, а специалист получал её
 * только на приёмы, которые записал сам (внешний разбор, волна 15, п. 10).
 *
 * Звать можно только после проверки права записи на выбранный слот —
 * createMeetLink зовётся из записи на приём после takeSlot, и специалист
 * берётся из занятого слота, а не из запроса.
 */
async function calendarGrant(specialistId: string): Promise<string | null> {
  const [row] = await asSystem(() =>
    db
      .select({ refreshTokenEnc: googleCalendarTokens.refreshTokenEnc })
      .from(googleCalendarTokens)
      .where(eq(googleCalendarTokens.userId, specialistId)),
  );
  return row ? decryptField(row.refreshTokenEnc) : null;
}

type TokenResult = { token: string } | { outcome: "not_connected" | "revoked" | "failed" };

/**
 * Свежий токен доступа по сохранённому разрешению.
 *
 * Отказ сети здесь — обычный исход, а не исключение: обмен стоял до
 * try/catch, и обрыв связи с Google выходил из записи на приём пятисоткой —
 * приём не назначался вовсе (внешний разбор, волна 15, п. 11).
 */
async function accessToken(specialistId: string): Promise<TokenResult> {
  const refresh = await calendarGrant(specialistId);
  if (!refresh) return { outcome: "not_connected" };

  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refresh,
        client_id: env.googleClientId!,
        client_secret: env.googleClientSecret!,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn("meet.token_error", { error: String(error) });
    return { outcome: "failed" };
  }
  if (!res.ok) {
    /*
     * Разрешение отозвано или просрочено. Убираем запись: связь, которая
     * молча не работает, хуже отсутствующей — специалист будет считать
     * календарь подключённым и удивляться пустым ссылкам.
     *
     * Системной ролью, как и чтение: записывается обычно не сам специалист,
     * и в контексте пациента удаление чужой строки политика тихо пропускала.
     */
    if (res.status === 400 || res.status === 401) {
      await asSystem(() => disconnectCalendar(specialistId));
      log.warn("meet.grant_revoked", { userId: specialistId });
      return { outcome: "revoked" };
    }
    log.warn("meet.token_failed", { status: res.status });
    return { outcome: "failed" };
  }
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!body?.access_token) {
    log.warn("meet.token_failed", { status: res.status });
    return { outcome: "failed" };
  }
  return { token: body.access_token };
}

export interface MeetRequest {
  specialistId: string;
  startsAt: string;
  endsAt: string;
  /** Что увидит специалист в своём календаре; имени пациента здесь нет */
  title: string;
}

/**
 * Чем кончилась попытка создать встречу — для журнала записи на приём.
 *
 * not_configured — Google на сервере не настроен; not_connected —
 * специалист календарь не подключал; revoked — разрешение отозвано и
 * снято; failed — Google не ответил или ответил отказом. Во всех случаях,
 * кроме created, ссылки нет, и специалист вписывает свою.
 */
export type MeetOutcome = "created" | "not_configured" | "not_connected" | "revoked" | "failed";

/**
 * Создать встречу и вернуть ссылку.
 *
 * Ссылка `null` — не настроено, не подключено или Google отказал; вызывающий
 * оставляет ссылку пустой, а специалист вписывает свою. Исключений отсюда
 * не бывает: запись на приём не должна срываться из-за чужого сервиса, и
 * под обработкой вся внешняя операция — обмен refresh-токена тоже.
 *
 * Специалист, время и конец — из занятого слота (routes/clinic.ts), после
 * проверки права записи на него: разрешение на календарь читается
 * системной ролью (calendarGrant), и звать это с чем-то другим нельзя.
 *
 * В заголовок события НЕ идёт имя пациента. Событие попадает в личный
 * календарь специалиста, который синхронизируется с его телефоном и виден
 * на экране блокировки; «Приём — Петров Дмитрий» на чужом экране это
 * разглашение того самого факта, ради сокрытия которого в системе есть коды
 * вместо имён.
 */
export async function createMeetLink(
  req: MeetRequest,
): Promise<{ url: string | null; eventId: string | null; outcome: MeetOutcome }> {
  if (!meetConfigured()) return { url: null, eventId: null, outcome: "not_configured" };
  try {
    const access = await accessToken(req.specialistId);
    if (!("token" in access)) return { url: null, eventId: null, outcome: access.outcome };

    const res = await fetch(EVENTS_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: req.title,
        start: { dateTime: req.startsAt },
        end: { dateTime: req.endsAt },
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("meet.create_failed", { status: res.status });
      return { url: null, eventId: null, outcome: "failed" };
    }
    const body = (await res.json().catch(() => null)) as { hangoutLink?: string; id?: string } | null;
    /*
     * Вместе со ссылкой — идентификатор события: по нему перенос и отмена
     * приёма потом найдут событие в календаре (lib/meetSync.ts, #37). Прежде
     * сохранялась одна ссылка, и событие было некому трогать.
     */
    return body?.hangoutLink
      ? { url: body.hangoutLink, eventId: typeof body.id === "string" ? body.id : null, outcome: "created" }
      : { url: null, eventId: null, outcome: "failed" };
  } catch (error) {
    /* что угодно сверх ожидаемого — тоже не повод срывать запись: приём важнее ссылки */
    log.warn("meet.create_error", { error: String(error) });
    return { url: null, eventId: null, outcome: "failed" };
  }
}

/* ─── событие уже созданной встречи: перенос и удаление (#37) ─── */

const EVENT_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/**
 * Чем кончилась операция над существующим событием.
 *
 * done — сделано; gone — события в календаре уже нет (404/410): для переноса
 * это «переносить нечего», для удаления — «уже удалено», и обоим дальше
 * ничего не нужно; no_access — разрешения специалиста нет или оно отозвано
 * (трогать событие некому, повтор не поможет); failed — Google не ответил
 * или ответил отказом, стоит повторить.
 */
export type EventOutcome = "done" | "gone" | "no_access" | "failed";

async function eventRequest(
  organizerId: string,
  eventId: string,
  method: "PATCH" | "DELETE",
  body?: unknown,
): Promise<EventOutcome> {
  if (!meetConfigured()) return "no_access";
  try {
    const access = await accessToken(organizerId);
    if (!("token" in access)) return access.outcome === "failed" ? "failed" : "no_access";
    const res = await fetch(`${EVENT_ENDPOINT}/${encodeURIComponent(eventId)}`, {
      method,
      headers: {
        Authorization: `Bearer ${access.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (res.ok) return "done";
    if (res.status === 404 || res.status === 410) return "gone";
    log.warn("meet.event_failed", { method, status: res.status });
    return "failed";
  } catch (error) {
    log.warn("meet.event_error", { method, error: String(error) });
    return "failed";
  }
}

/** Перенести событие на новое время — в календаре того, кто его создал */
export function moveMeetEvent(organizerId: string, eventId: string, startsAt: string, endsAt: string): Promise<EventOutcome> {
  return eventRequest(organizerId, eventId, "PATCH", { start: { dateTime: startsAt }, end: { dateTime: endsAt } });
}

/** Удалить событие из календаря того, кто его создал */
export function deleteMeetEvent(organizerId: string, eventId: string): Promise<EventOutcome> {
  return eventRequest(organizerId, eventId, "DELETE");
}
