import type { OpsKeysReport, OpsReencryptJob, OpsSecretStatus, OpsSqlRefusal, UiKey } from "@quizzy/shared";

/**
 * Чистая логика разделов безопасности техпанели — отдельно от разметки,
 * чтобы проверяться без React: здесь решается, какой шаг ротации текущий и
 * можно ли убрать старый ключ. Ошибка в этом решении не ломает экран, а
 * советует удалить ключ, на котором ещё лежат данные.
 */

/** Подстановка {имя} в строку словаря — как fill у соседних экранов */
export function fill(template: string, values: Record<string, string | number | null>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in values ? String(values[name] ?? "—") : all,
  );
}

/* ═══════════ мастер ротации ═══════════ */

export type StepState = "done" | "current" | "todo" | "blocked";
export type StepKey = "add" | "restart" | "reencrypt" | "verify";

export interface RotationStep {
  key: StepKey;
  state: StepState;
}

/**
 * Состояние четырёх шагов RUNBOOK по описи ключей.
 *
 * Панель не знает, что задумал человек, — она видит только ключи в
 * окружении и данные. Отсюда правила:
 *   — загружено больше одного ключа — ротация идёт: новый ключ уже добавлен
 *     и процесс перезапущен с ним (иначе панель бы его не видела);
 *   — есть что перешифровать — текущий шаг «Перешифрувати», и он же
 *     текущий без всякой ротации, если в базе лежит открытый текст или
 *     файлы без заголовка;
 *   — данные на ключе, которого нет в окружении, — проверка заблокирована:
 *     убирать что-либо в таком состоянии нельзя, сначала вернуть ключ.
 */
export function rotationSteps(r: OpsKeysReport): RotationStep[] {
  const rotating = r.loadedKeys.length > 1;
  const stale = r.staleTotal > 0;
  const lost = r.lostTotal > 0;

  if (!r.encryption) {
    return [
      { key: "add", state: "current" },
      { key: "restart", state: "todo" },
      { key: "reencrypt", state: "todo" },
      { key: "verify", state: "todo" },
    ];
  }

  const reencrypt: StepState = stale ? "current" : rotating ? "done" : "todo";
  const verify: StepState = lost ? "blocked" : rotating && !stale ? "current" : "todo";
  return [
    { key: "add", state: rotating ? "done" : stale ? "todo" : "current" },
    { key: "restart", state: rotating ? "done" : "todo" },
    { key: "reencrypt", state: reencrypt },
    { key: "verify", state: verify },
  ];
}

/** Ключи, которые можно убрать из окружения: загружены, не основные, пусты */
export function removableKeys(r: OpsKeysReport): string[] {
  return r.keys.filter((k) => k.loaded && !k.active && k.values === 0 && k.files === 0).map((k) => k.id);
}

/** Не основные ключи, на которых ещё что-то лежит: убирать нельзя */
export function busyOldKeys(r: OpsKeysReport): string[] {
  return r.keys.filter((k) => k.loaded && !k.active && k.values + k.files > 0).map((k) => k.id);
}

/**
 * Имя следующей версии ключа: на единицу больше самой старшей «vN» из
 * известных — и загруженных, и найденных в данных. Взять имя, которое уже
 * встречается в данных, значило бы подложить новому ключу чужие значения.
 */
export function nextKeyId(r: OpsKeysReport): string {
  const numbers = r.keys.map((k) => /^v(\d+)$/.exec(k.id)?.[1]).filter(Boolean).map(Number);
  return `v${numbers.length ? Math.max(...numbers) + 1 : 1}`;
}

/**
 * Строка окружения — с именами версий и заглушками вместо ключей: самих
 * ключей панель не знает и знать не должна.
 */
export function envLine(ids: string[], placeholder: string): string {
  return `ENCRYPTION_KEY="${ids.map((id) => `${id}:<${placeholder}>`).join(",")}"`;
}

/** Доля пройденного перешифровкой, 0…1 */
export function jobShare(job: OpsReencryptJob): number {
  if (job.total <= 0) return job.status === "done" ? 1 : 0;
  return Math.min(1, Math.max(0, job.processed / job.total));
}

/* ═══════════ секреты ═══════════ */

export type SecretAge =
  | { kind: "changed"; days: number }
  | { kind: "tracked"; days: number }
  | { kind: "unknown" };

const DAY_MS = 86_400_000;

/**
 * Возраст секрета — честно: смену система видит, только если застала её.
 * Совпадение «видно с» и «следим с» значит, что при нас значение не
 * менялось, и возраст — «не меньше, чем» с начала слежения, а не точная
 * дата.
 */
export function secretAge(s: OpsSecretStatus, now = Date.now()): SecretAge {
  if (!s.seenSince || !s.trackedSince) return { kind: "unknown" };
  const days = (iso: string) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));
  if (new Date(s.seenSince).getTime() > new Date(s.trackedSince).getTime()) {
    return { kind: "changed", days: days(s.seenSince) };
  }
  return { kind: "tracked", days: days(s.trackedSince) };
}

/* ═══════════ SQL-консоль ═══════════ */

/**
 * CSV из показанного — те же правила, что у tableToCsv (ui/index.tsx):
 * точка с запятой и кавычки при нужде. Без BOM: это буфер обмена, а не
 * файл для Excel. Пустая ячейка (NULL) — пустая строка.
 */
export function toCsv(columns: string[], rows: (string | null)[][]): string {
  const cell = (v: string | null) => {
    const s = v ?? "";
    return /[";\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns.map(cell).join(";"), ...rows.map((r) => r.map(cell).join(";"))].join("\r\n");
}

export interface HistoryEntry {
  query: string;
  reason: string;
  at: string;
  /** Итог словами-признаками: сколько строк, отказ или ошибка */
  outcome: { kind: "ok"; rows: number; truncated: boolean } | { kind: "refused" } | { kind: "error" };
}

/**
 * История своих запросов за сессию: новые сверху, повтор того же текста с
 * той же причиной поднимается наверх, а не дублируется.
 */
export function pushHistory(list: HistoryEntry[], entry: HistoryEntry, max = 30): HistoryEntry[] {
  const rest = list.filter((e) => !(e.query === entry.query && e.reason === entry.reason));
  return [entry, ...rest].slice(0, max);
}

/** Строка словаря для отказа разбора */
export const REFUSAL_TEXT: Record<OpsSqlRefusal, UiKey> = {
  empty: "ops.sec.sql.refuse.empty",
  too_long: "ops.sec.sql.refuse.tooLong",
  multiple_statements: "ops.sec.sql.refuse.multiple",
  not_read: "ops.sec.sql.refuse.notRead",
  write_keyword: "ops.sec.sql.refuse.write",
  row_lock: "ops.sec.sql.refuse.rowLock",
  side_effect: "ops.sec.sql.refuse.sideEffect",
  placeholder: "ops.sec.sql.refuse.placeholder",
};

/**
 * Несколько операторов видно ещё до отправки — подсказка под полем, а не
 * отказ: решает сервер. Грубо (точка с запятой вне строк не ищется), и это
 * нарочно — подсказка, ошибившаяся в сторону «предупредить», дешевле.
 */
export function looksMultiple(query: string): boolean {
  return /;\s*\S/.test(query.replace(/'[^']*'/g, "''").replace(/--[^\n]*/g, ""));
}
