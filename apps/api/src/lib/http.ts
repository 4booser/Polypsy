import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Lang } from "@quizzy/shared";
import type { z, ZodTypeAny } from "zod";

/**
 * Язык выдачи: параметр ?lang, иначе заголовок Accept-Language, иначе украинский.
 * Отсутствующий перевод подменяется другим языком уже в t(), поэтому пустых
 * экранов не бывает.
 */
export function langOf(c: Context): Lang {
  const q = c.req.query("lang");
  if (q === "ru" || q === "uk") return q;
  const header = c.req.header("Accept-Language") ?? "";
  return header.toLowerCase().startsWith("ru") ? "ru" : "uk";
}

export function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

export function unauthorized(message = "Требуется авторизация"): never {
  throw new HTTPException(401, { message });
}

export function forbidden(message = "Недостаточно прав"): never {
  throw new HTTPException(403, { message });
}

export function notFound(message = "Не найдено"): never {
  throw new HTTPException(404, { message });
}

export function conflict(message: string): never {
  throw new HTTPException(409, { message });
}

/** Разбор тела запроса по zod-схеме с осмысленной 400-й ошибкой */
export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    badRequest("Ожидается JSON-тело запроса");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    badRequest(detail);
  }
  return result.data;
}

/**
 * Разбор query-параметров по zod-схеме.
 *
 * Без него `Number(c.req.query("limit"))` на `limit=abc` даёт NaN, который
 * молча уезжает в `.limit()` и роняет запрос пятисоткой вместо честной
 * четырёхсотки. То же с датами: `from=вчера` уходило в сравнение как есть.
 */
export function parseQuery<S extends ZodTypeAny>(c: Context, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "query"}: ${i.message}`)
      .join("; ");
    badRequest(detail);
  }
  return result.data;
}
