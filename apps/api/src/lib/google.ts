import { env } from "../env";

/**
 * Вход через Google: обмен кода на личность.
 *
 * Дополнительный способ входа, а не замена паролю. В учреждении, где по
 * записи работают, потеря доступа из-за сбоя у внешнего поставщика — это
 * несостоявшийся приём; пароль обязан оставаться рабочим всегда.
 *
 * Проверка подписи id_token здесь не делается, и это не упущение. Токен
 * приходит не от браузера, а прямо из token-endpoint Google по TLS, в ответ
 * на запрос с нашим client_secret. Спецификация OIDC (3.1.3.7) прямо
 * разрешает в этом случае доверять телу без проверки подписи: подменить его
 * может только тот, кто уже вскрыл TLS до Google. Разбирать JWKS ради
 * повторения того, что уже дал TLS, — лишняя механика, которая ломается
 * молча при ротации ключей.
 *
 * Проверяются `aud` и `iss`: первый — что токен выписан нам, а не другому
 * приложению; второй — что выписал его Google.
 */
export interface GoogleIdentity {
  /** Стабильный идентификатор пользователя у Google */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** Настроен ли вход через Google. Пусто — способа нет, и кнопки тоже */
export function googleEnabled(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret && env.googleRedirectUri);
}

/**
 * Адрес, куда отправить человека.
 *
 * `state` защищает от подделки запроса: вернувшийся код принимается, только
 * если состояние совпало с тем, что мы сами выдали. `prompt=select_account`
 * — чтобы на общем компьютере не входили молча под учётной записью
 * предыдущего.
 */
export function authorizeUrl(state: string, codeChallenge: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", env.googleClientId!);
  url.searchParams.set("redirect_uri", env.googleRedirectUri!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** Обмен кода на личность. Бросает при любом несоответствии — молча не пускаем */
export async function exchangeCode(code: string, verifier: string): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId!,
      client_secret: env.googleClientSecret!,
      redirect_uri: env.googleRedirectUri!,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`google token endpoint: ${res.status}`);

  const body = (await res.json()) as { id_token?: string };
  const idToken = body.id_token;
  if (!idToken) throw new Error("google: ответ без id_token");

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("google: id_token не разобран");
  const claims = decodeSegment(parts[1]!);

  const aud = String(claims.aud ?? "");
  if (aud !== env.googleClientId) throw new Error("google: токен выписан не нам");
  if (!ISSUERS.has(String(claims.iss ?? ""))) throw new Error("google: чужой издатель");
  const exp = Number(claims.exp ?? 0);
  if (!exp || exp * 1000 < Date.now()) throw new Error("google: токен просрочен");

  const sub = String(claims.sub ?? "");
  const email = String(claims.email ?? "").toLowerCase();
  if (!sub || !email) throw new Error("google: в токене нет sub или email");

  return {
    sub,
    email,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
  };
}

/**
 * Разрешён ли домен почты.
 *
 * Пустой список — любые. Список — единственное, что отделяет «вошёл наш
 * сотрудник» от «вошёл кто угодно с почтой Google»: связывание и так
 * требует существующей учётной записи, но рубеж здесь дёшев.
 */
export function domainAllowed(email: string): boolean {
  if (!env.googleAllowedDomains.length) return true;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return env.googleAllowedDomains.includes(domain);
}
