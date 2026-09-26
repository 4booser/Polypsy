import postgres from "postgres";
import type { OpsSqlRefusal, OpsSqlResult } from "@quizzy/shared";
import { env } from "../env";

/**
 * SQL-консоль техпанели: запрос только на чтение, для суперадмина.
 *
 * Решение заказчика 2026-09-26: консоль нужна — разбор инцидента часто
 * упирается в вопрос, на который нет экрана, — но она обязана быть
 * неспособной что-либо изменить, и каждый запрос с причиной должен лежать в
 * журнале. Поясов три, и каждый закрывает то, чего не закрывает другой.
 *
 * 1. Разбор на входе (screenQuery). Один оператор, начинается с чтения, без
 *    пишущих слов и функций с побочным эффектом. Он не доказательство —
 *    SQL слишком богат, чтобы разбор без парсера Postgres что-то доказывал, —
 *    а понятный отказ до базы и первый пояс против многооператорной строки.
 *
 * 2. Протокол и транзакция. Запрос уходит расширенным протоколом
 *    (Parse/Bind/Execute): такой протокол не принимает двух операторов в
 *    одной строке вовсе — «cannot insert multiple commands into a prepared
 *    statement». Это существенно: postgres.js на `sql.unsafe(текст)` без
 *    параметров идёт ПРОСТЫМ протоколом, и строка «COMMIT; DELETE …» там
 *    выполнилась бы целиком — сначала закрыв транзакцию только-на-чтение,
 *    потом удалив за её пределами. Выполняется всё в транзакции READ ONLY,
 *    и транзакция всегда ОТКАТЫВАЕТСЯ, а не фиксируется: SET без LOCAL,
 *    отложенный NOTIFY и прочее «разрешённое в чтении» не переживают отката.
 *    Первым в транзакции идёт SELECT — после него включить запись обратно
 *    («SET TRANSACTION READ WRITE», set_config('transaction_read_only'))
 *    Postgres не даёт: «must be set before any query».
 *
 * 3. Своё соединение на каждый запрос, закрываемое после. То, что живёт
 *    дольше транзакции — сессионная advisory-блокировка, LISTEN,
 *    подготовленные операторы, — умирает вместе с соединением и не
 *    достаётся пулу приложения. Иначе `select pg_advisory_lock(7154301)`
 *    (ключ цепочки журнала) повесил бы запись в журнал для всего
 *    приложения до перезапуска.
 *
 * Роль базы — та же, что у приложения (DATABASE_URL), и RLS-контекст —
 * суперадмина, от чьего имени запрос. Значит, видно ровно то, что
 * суперадмину видно в консоли: политики строк действуют (записи приёма —
 * только двум участникам, их строк не видно), а шифрованные поля
 * остаются шифртекстом — расшифровывает приложение, не база. Отдельной
 * «роли только для чтения» в базе нет, и заводить её ради консоли значило бы
 * ещё один шаг установки, который пропустят; READ ONLY-транзакция даёт то же
 * без него.
 */

export const SQL_MAX_ROWS = 500;
export const SQL_TIMEOUT_MS = 10_000;
/** Длиннее — не запрос для разбора инцидента, а выгрузка; для неё есть свои пути */
const MAX_LENGTH = 20_000;
/** Ячейка длиннее — обрезается с пометкой: экран не место для мегабайтных текстов */
const MAX_CELL = 2_000;

/** С чего может начинаться запрос на чтение */
const READ_STARTS = new Set(["select", "with", "values", "table", "explain", "show"]);

/*
 * Слова, которых в запросе на чтение не бывает. INTO — ради SELECT INTO
 * (создаёт таблицу); UPDATE и SHARE после FOR — блокировки строк, которые в
 * транзакции только-на-чтение запрещены, но отказ здесь понятнее ошибки
 * базы. ANALYZE не в списке: EXPLAIN ANALYZE — законное чтение, а голый
 * ANALYZE не пройдёт проверку первого слова.
 */
const WRITE_WORDS = [
  "insert", "update", "delete", "merge", "truncate", "copy", "create", "alter", "drop",
  "grant", "revoke", "comment", "security", "call", "do", "lock", "vacuum", "reindex",
  "cluster", "refresh", "listen", "unlisten", "notify", "prepare", "execute", "deallocate",
  "discard", "reset", "set", "begin", "start", "commit", "rollback", "abort", "savepoint",
  "release", "checkpoint", "load", "import", "into",
];

/*
 * Функции с побочным эффектом или с доступом за пределы базы. Часть из них
 * транзакция только-на-чтение остановит и так (nextval, setval), часть —
 * нет: advisory-блокировки, отмена и завершение чужих сеансов (роль
 * приложения вправе гасить сеансы своей же роли — то есть всё приложение),
 * перечитывание конфигурации, чтение файлов сервера, запросы строкой
 * (query_to_xml выполняет произвольный текст).
 */
const SIDE_EFFECT = new RegExp(
  "\\b(" +
    [
      "nextval", "setval", "set_config",
      "pg_(?:try_)?advisory\\w*",
      "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
      "pg_switch_wal", "pg_create_\\w+", "pg_drop_\\w+", "pg_promote", "pg_stat_reset\\w*",
      "pg_log_backend_memory_contexts", "pg_notify", "pg_sleep\\w*", "pg_read_\\w*file",
      "pg_ls_\\w+", "pg_stat_file", "pg_file_\\w+", "pg_logical_emit_message", "pg_replication_\\w+",
      "pg_import_system_collations", "txid_current", "pg_current_xact_id",
      "lo_\\w+", "dblink\\w*", "query_to_xml\\w*", "cursor_to_xml\\w*",
    ].join("|") +
    ")\\s*\\(",
  "i",
);

export type Screened = { ok: true; text: string; utility: boolean } | { ok: false; code: OpsSqlRefusal; detail: string | null };

/**
 * Текст без литералов и комментариев — то, по чему можно искать слова.
 *
 * Строки ('…', E'…' с обратной косой, $тег$…$тег$) и комментарии (-- и
 * вложенные /* *\/) заменяются пробелами: «delete» внутри строки поиска не
 * пишет ничего, и отказывать из-за него — ложная тревога. Идентификаторы в
 * двойных кавычках, наоборот, остаются словами без кавычек: "nextval"(…) —
 * это вызов nextval, и спрятать его кавычками не должно получаться.
 */
export function stripLiterals(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "-" && next === "-") {
      while (i < n && text[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 0;
      while (i < n) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      out += " ";
      continue;
    }
    if (ch === "'") {
      const escaped = /[eE]/.test(text[i - 1] ?? "") && !/[\w$]/.test(text[i - 2] ?? "");
      i++;
      while (i < n) {
        if (escaped && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      out += " '' ";
      continue;
    }
    if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag && !/[\w$]/.test(text[i - 1] ?? "")) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? n : end + tag[0].length;
        out += " '' ";
        continue;
      }
    }
    if (ch === '"') {
      i++;
      let name = "";
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            name += '"';
            i += 2;
            continue;
          }
          break;
        }
        name += text[i];
        i++;
      }
      i++;
      out += ` ${name} `;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Первый пояс: разбор текста до базы */
export function screenQuery(raw: string): Screened {
  const text = raw.trim();
  if (!text) return { ok: false, code: "empty", detail: null };
  if (text.length > MAX_LENGTH) return { ok: false, code: "too_long", detail: String(MAX_LENGTH) };

  const bare = stripLiterals(text).trim();
  /*
   * Точка с запятой допустима одна и только в самом конце — так запрос
   * обычно и копируют из psql. Любая другая означает второй оператор, и
   * отказ здесь дублирует протокол намеренно: два пояса вместо одного.
   */
  const body = bare.replace(/;\s*$/, "");
  if (body.includes(";")) return { ok: false, code: "multiple_statements", detail: null };

  const first = /^[\s(]*([A-Za-z]+)/.exec(body)?.[1]?.toLowerCase() ?? "";
  if (!READ_STARTS.has(first)) return { ok: false, code: "not_read", detail: first || null };

  const words = body.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? [];
  const write = words.find((w) => WRITE_WORDS.includes(w));
  if (write) return { ok: false, code: "write_keyword", detail: write.toUpperCase() };

  if (/\bfor\s+(?:no\s+key\s+)?(?:key\s+)?(?:update|share)\b/i.test(body)) {
    return { ok: false, code: "row_lock", detail: null };
  }

  const fn = SIDE_EFFECT.exec(body);
  if (fn) return { ok: false, code: "side_effect", detail: fn[1]!.toLowerCase() };

  // параметров консоль не передаёт: $1 в тексте — это всегда ошибка, скажем сразу
  if (/\$\d/.test(body)) return { ok: false, code: "placeholder", detail: null };

  // точку с запятой в конце не шлём: расширенный протокол её терпит, но незачем
  return { ok: true, text: text.replace(/;\s*$/, ""), utility: first === "explain" || first === "show" };
}

/** Выход из транзакции с результатом: транзакция консоли не фиксируется никогда */
class Rollback {
  constructor(public readonly result: OpsSqlResult) {}
}

/** Значение ячейки — строкой: экрану и CSV нужен текст, а не типы драйвера */
function cell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (value instanceof Date) text = Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  else if (Buffer.isBuffer(value) || value instanceof Uint8Array) text = `\\x${Buffer.from(value).toString("hex")}`;
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
}

/*
 * Колонки, которые не показываются даже суперадмину: хэш пароля и хэш
 * refresh-токена. Прочесть их в консоли незачем при любом разборе, а
 * попасть они могут на экран, в скопированный CSV и в пересланное
 * сообщение. Опознаются по таблице и номеру колонки из описания
 * результата, а не по имени: `select password_hash as x` прячется так же.
 * Выражение над колонкой (substr(password_hash, …)) этой связи не несёт и
 * не прячется — это не замок, а защита от случайного показа; замок здесь —
 * журнал с текстом запроса.
 */
const MASKED = ["users.password_hash", "refresh_tokens.token_hash"];

export interface RunOptions {
  userId: string;
  maxRows?: number;
  timeoutMs?: number;
  /** Адрес базы; по умолчанию — приложения. Тесту нужно подменить роль */
  url?: string;
}

/**
 * Второй и третий пояса: своё соединение, READ ONLY, расширенный протокол,
 * лимиты, откат.
 *
 * Вызывающий обязан пропустить текст через screenQuery; здесь он не
 * повторяется намеренно — тест проверяет, что второй пояс держит и без
 * первого.
 */
export async function runReadOnly(text: string, opts: RunOptions): Promise<OpsSqlResult> {
  const maxRows = opts.maxRows ?? SQL_MAX_ROWS;
  const timeoutMs = opts.timeoutMs ?? SQL_TIMEOUT_MS;
  const utility = /^[\s(]*(explain|show)\b/i.test(stripLiterals(text));

  const sql = postgres(opts.url ?? env.databaseUrl, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
    prepare: false,
    onnotice: () => {},
    /*
     * Лимит времени — ещё и параметром соединения: он действует с первого
     * байта, в том числе если SET LOCAL ниже почему-то не выполнился.
     */
    connection: {
      application_name: "quizzy-sql-console",
      statement_timeout: timeoutMs,
      idle_in_transaction_session_timeout: timeoutMs * 3,
    },
  });

  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    await sql.begin("read only", async (tx) => {
      await tx`select set_config('statement_timeout', ${String(timeoutMs)}, true),
                      set_config('app.user_id', ${opts.userId}, true),
                      set_config('app.role', 'superadmin', true)`;

      const masked = await tx<{ table: number; number: number }[]>`
        select a.attrelid::int as table, a.attnum::int as number
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
         where c.relnamespace = 'public'::regnamespace
           and (c.relname::text || '.' || a.attname::text) = any(${MASKED})`;
      const hidden = new Set(masked.map((m) => `${m.table}:${m.number}`));

      const described = await tx.unsafe(text, [], { prepare: false }).describe();
      const cols = (described.columns ?? []) as { name: string; type: number; table: number; number: number }[];
      const typeNames = new Map<number, string>();
      if (cols.length) {
        const oids = [...new Set(cols.map((c) => c.type))];
        for (const t of await tx<{ oid: number; name: string }[]>`
          select oid::int as oid, typname::text as name from pg_type where oid = any(${oids})`) {
          typeNames.set(Number(t.oid), t.name);
        }
      }

      /*
       * Строки — курсором по порциям: забираем первую порцию в maxRows + 1 и
       * закрываем портал. Лишняя строка — признак «обрезано». Без курсора
       * `select * from answers` сначала целиком приехал бы в память
       * процесса, обслуживающего приём, и только потом был бы обрезан.
       *
       * EXPLAIN и SHOW — служебные операторы: порций они не отдают, и
       * курсор вернул бы пустоту. Их вывод и так короток.
       */
      let rows: unknown[][] = [];
      if (utility) {
        rows = [...(await tx.unsafe(text, [], { prepare: false }).values())] as unknown[][];
      } else {
        for await (const batch of tx.unsafe(text, [], { prepare: false }).values().cursor(maxRows + 1)) {
          rows = [...(batch as unknown as unknown[][])];
          break;
        }
      }
      const truncated = rows.length > maxRows;
      const shown = rows.slice(0, maxRows);
      const maskAt = cols.map((c) => hidden.has(`${c.table}:${c.number}`));

      throw new Rollback({
        status: "ok",
        columns: cols.map((c, i) => ({ name: c.name, type: typeNames.get(c.type) ?? String(c.type), masked: maskAt[i] || undefined })),
        rows: shown.map((r) => r.map((v, i) => (maskAt[i] ? (v === null ? null : "•••") : cell(v)))),
        rowCount: shown.length,
        truncated,
        ms: ms(),
      });
    });
    // сюда не доходим: транзакция выходит только откатом
    return { status: "error", code: null, message: "unexpected commit", ms: ms() };
  } catch (error) {
    if (error instanceof Rollback) return error.result;
    const e = error as { code?: string; message?: string };
    return { status: "error", code: e.code ?? null, message: String(e.message ?? error).slice(0, 1000), ms: ms() };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
