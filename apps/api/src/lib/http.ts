import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ErrorKey, ErrorParams, Lang } from "@quizzy/shared";
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

/*
 * Отказы несут ключ и подстановки, а не готовую фразу.
 *
 * Фразу собирает единственное место — обработчик ошибок приложения, — и
 * собирает на языке того, кто спрашивал. Раньше текст писался прямо здесь,
 * по-русски, и украиноязычный пациент читал «Вы уже проходили эту методику»
 * на украинском экране: словарь клиента такие строки не видит, они приезжают
 * готовыми.
 *
 * Ключ типизирован, поэтому опечатка не доживает до боя. Для отказов, где
 * текст собирается на месте — разбор тела запроса, — оставлена строка: там
 * подробность важнее перевода, и читает её разработчик.
 */
export interface ErrorInfo {
  key: string;
  params?: ErrorParams;
}

function fail(status: 400 | 401 | 403 | 404 | 409, key: string, params?: ErrorParams): never {
  // ключ едет и сообщением, и причиной: сообщение видно в логе как есть,
  // причина — то, из чего собирается ответ
  throw new HTTPException(status, { message: key, cause: { key, params } satisfies ErrorInfo });
}

export function badRequest(key: ErrorKey, params?: ErrorParams): never {
  fail(400, key, params);
}

/**
 * Отказ с текстом, собранным на месте.
 *
 * Единственный законный случай — разбор тела запроса: там подробность
 * («scales.0.code: обязательное поле») ценнее перевода, и читает её тот, кто
 * пишет клиент. Отдельное имя нужно, чтобы обычный badRequest принимал
 * только ключ: тогда забытую фразу находит компилятор, а не смоук через
 * неделю.
 */
export function badRequestDetail(detail: string): never {
  throw new HTTPException(400, { message: detail });
}

export function unauthorized(key: ErrorKey = "err.auth", params?: ErrorParams): never {
  fail(401, key, params);
}

export function forbidden(key: ErrorKey = "err.forbidden", params?: ErrorParams): never {
  fail(403, key, params);
}

export function notFound(key: ErrorKey = "err.notFound", params?: ErrorParams): never {
  fail(404, key, params);
}

export function conflict(key: ErrorKey, params?: ErrorParams): never {
  fail(409, key, params);
}

/** Разбор тела запроса по zod-схеме с осмысленной 400-й ошибкой */
export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    badRequest("err.jsonExpected");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    badRequestDetail(detail);
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
    badRequestDetail(detail);
  }
  return result.data;
}
