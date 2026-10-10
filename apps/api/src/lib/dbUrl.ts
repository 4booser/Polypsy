/**
 * Адрес базы с паролем внутри — разбор без утечки пароля (#163).
 *
 * Пароль роли приложения подставляется в DATABASE_URL как есть
 * (docker-compose.yml: postgres://quizzy_app:${APP_DB_PASSWORD}@…), а
 * рецепт в подсказках давал обычный base64. Примерно в 40% случаев в пароль
 * попадала «/»: драйвер падал с «Invalid URL», а в поле input ошибки
 * печатал адрес целиком — с паролем — в журнал контейнера и оттуда в
 * журнал прогона Actions.
 *
 * Здесь — проверка, которую конфигурация процесса делает на старте
 * (env.ts), раньше драйвера: отказ называет причину, а адрес показывает
 * только с замазанным паролем. Модуль без импортов — его читает env.ts.
 */

/** Символы, которые в пароле внутри адреса ломают разбор: конец адреса, запрос, якорь, пробелы */
const BREAKS_URL = /[/?#\s]/;

/** Сгенерировать пароль, безопасный в адресе: base64url, как scripts/vps-setup.sh */
export const URL_SAFE_PASSWORD_RECIPE = "head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '\\n='";

/** Адрес с паролем, заменённым на ***; разбирается вручную — годится и для адреса, который URL не принимает */
export function maskDatabaseUrl(url: string): string {
  const scheme = url.indexOf("://");
  if (scheme < 0) return url.replace(/:[^:@/]*@/, ":***@");
  const rest = url.slice(scheme + 3);
  const at = rest.lastIndexOf("@");
  if (at < 0) return url;
  const userinfo = rest.slice(0, at);
  const colon = userinfo.indexOf(":");
  if (colon < 0) return url;
  return `${url.slice(0, scheme + 3)}${userinfo.slice(0, colon + 1)}***${rest.slice(at)}`;
}

/**
 * Годится ли пароль для подстановки в адрес как есть (APP_DB_PASSWORD,
 * POSTGRES_PASSWORD). Сверх ломающих разбор — «%» и «@»: подстановка
 * compose ничего не кодирует, и «%41» дошёл бы до базы буквой «A», а «@»
 * читают по-разному разные клиенты (драйвер, psql, pg_dump копий).
 */
export function passwordBreaksUrl(password: string): boolean {
  return BREAKS_URL.test(password) || /[%@]/.test(password);
}

/**
 * Почему драйвер не сможет разобрать адрес; null — сможет.
 *
 * Сообщение пароля не содержит: адрес в нём — только замазанный. Проверка
 * повторяет то, на чём падает postgres.js (parseUrl): разбор URL и
 * decodeURIComponent имени и пароля.
 */
export function databaseUrlProblem(url: string): string | null {
  const scheme = url.indexOf("://");
  const rest = scheme < 0 ? "" : url.slice(scheme + 3);
  const at = rest.lastIndexOf("@");
  const userinfo = at < 0 ? "" : rest.slice(0, at);
  const encode =
    `Сгенерируйте пароль без таких символов (${URL_SAFE_PASSWORD_RECIPE}) ` +
    "или закодируйте его в адресе (encodeURIComponent).";
  if (BREAKS_URL.test(userinfo) || /%(?![0-9a-f]{2})/i.test(userinfo)) {
    return `в имени или пароле адреса ${maskDatabaseUrl(url)} есть символы, которые обрывают адрес (/ ? # пробел) или «%» без кода. ${encode}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `адрес ${maskDatabaseUrl(url)} не разбирается. ${encode}`;
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    return `имя или пароль адреса ${maskDatabaseUrl(url)} не раскодируются. ${encode}`;
  }
  return null;
}
