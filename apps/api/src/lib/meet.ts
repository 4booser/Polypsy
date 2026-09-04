import { eq } from "drizzle-orm";
import { db } from "../db";
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

/** Свежий токен доступа по сохранённому разрешению */
async function accessToken(userId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(googleCalendarTokens)
    .where(eq(googleCalendarTokens.userId, userId));
  if (!row) return null;
  const refresh = decryptField(row.refreshTokenEnc);
  if (!refresh) return null;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: env.googleClientId!,
      client_secret: env.googleClientSecret!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    /*
     * Разрешение отозвано или просрочено. Убираем запись: связь, которая
     * молча не работает, хуже отсутствующей — специалист будет считать
     * календарь подключённым и удивляться пустым ссылкам.
     */
    if (res.status === 400 || res.status === 401) {
      await disconnectCalendar(userId);
      log.warn("meet.grant_revoked", { userId });
    }
    return null;
  }
  const body = (await res.json()) as { access_token?: string };
  return body.access_token ?? null;
}

export interface MeetRequest {
  specialistId: string;
  startsAt: string;
  endsAt: string;
  /** Что увидит специалист в своём календаре; имени пациента здесь нет */
  title: string;
}

/**
 * Создать встречу и вернуть ссылку.
 *
 * `null` — не настроено или не подключено; вызывающий оставляет ссылку
 * пустой, а специалист вписывает свою. Отказ Google тоже даёт `null`:
 * запись на приём не должна срываться из-за чужого сервиса.
 *
 * В заголовок события НЕ идёт имя пациента. Событие попадает в личный
 * календарь специалиста, который синхронизируется с его телефоном и виден
 * на экране блокировки; «Приём — Петров Дмитрий» на чужом экране это
 * разглашение того самого факта, ради сокрытия которого в системе есть коды
 * вместо имён.
 */
export async function createMeetLink(req: MeetRequest): Promise<string | null> {
  if (!meetConfigured()) return null;
  const token = await accessToken(req.specialistId);
  if (!token) return null;

  try {
    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
      },
    );
    if (!res.ok) {
      log.warn("meet.create_failed", { status: res.status });
      return null;
    }
    const body = (await res.json()) as { hangoutLink?: string };
    return body.hangoutLink ?? null;
  } catch (error) {
    log.warn("meet.create_error", { error: String(error) });
    return null;
  }
}
