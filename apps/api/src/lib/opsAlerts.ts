/**
 * Оповещения о работе системы: Telegram и почта.
 *
 * Решение заказчика 2026-09-26: всплеск 5xx, молчащий планировщик, рост
 * p95, кончающееся место на диске, провал проверки цепочки журнала — должны
 * догонять человека сами, а не ждать, пока он откроет техпанель. Бэкап — в
 * том же списке у заказчика, но сервер о нём не знает: бэкап снимает cron
 * на хосте (scripts/backup.sh) в каталог, которого нет в контейнере
 * приложения, и проверяет его scripts/verify-backup.sh там же. Выдумывать
 * здесь «бэкап в порядке» было бы хуже, чем честно сказать «недоступно из
 * приложения» (экран так и говорит, и называет, где смотреть).
 *
 * Устройство:
 *
 *   — правила в базе (ops_alert_rules, миграция 0095): порог, окно, как
 *     часто повторять, куда слать — и состояние инцидента в той же строке;
 *   — проверка — фоновая задача «ops.alerts» реестра opsJobs, раз в минуту
 *     на экземпляре с планировщиком; её же можно запустить руками;
 *   — одно оповещение на инцидент, повтор по незакрытому — не чаще
 *     `repeat_min`, «відновлено» — когда сигнал ушёл; всё это — в историю
 *     (ops_alert_events) с итогом по каждому каналу.
 *
 * Секреты — только из окружения и только «задано / нет» наружу. Запрос в
 * Telegram — единственный исходящий запрос этого участка, с таймаутом; текст
 * его отказа проходит через вычистку токена, прежде чем лечь в историю или
 * лог: fetch любит класть в сообщение адрес целиком, а в адресе Telegram
 * токен бота стоит прямо в пути.
 */
import { statfs, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { desc, eq, lt } from "drizzle-orm";
import {
  OPS_REPEAT_LIMITS,
  OPS_RULE_LIMITS,
  renderPush,
  type OpsAlertChannel,
  type OpsAlertChannels,
  type OpsAlertDelivery,
  type OpsAlertEvent,
  type OpsAlertEventKind,
  type OpsAlertRule,
  type OpsAlertRuleInput,
  type OpsAlertRuleKey,
  type OpsAlertState,
  type OpsWindowStats,
} from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { opsAlertEvents, opsAlertRules, opsClientErrors, opsVitals } from "../db/schema";
import { env } from "../env";
import { withJobLock } from "./jobLock";
import { log } from "./log";
import { mailTransportReady, sendSystemMail, superadminEmails } from "./notify";
import { scrubText, startedAt, windowStats } from "./opsBuffer";
import { intervalOf, isRunning, lastStartOf, registerJob, skipJob, trackJob } from "./opsJobs";

export const ALERT_JOB = "ops.alerts";
export const ALERT_RULE_KEYS: readonly OpsAlertRuleKey[] = ["errors5xx", "schedulerSilent", "p95", "diskFree", "auditChain"];
const CHANNELS: readonly OpsAlertChannel[] = ["telegram", "email"];

/**
 * Меньше запросов в окне — доля и перцентиль не сигнал, а шум: одна
 * пятисотка из трёх запросов ночью — это «33 %», и будить из-за неё никого
 * не надо. Тихое окно считается спокойным (и закрывает инцидент).
 */
export const MIN_REQUESTS = 20;

/** История и группы ошибок клиента живут 90 дней, скорость экранов — 100 (график — 30) */
export const HISTORY_DAYS = 90;
const VITALS_KEEP_DAYS = 100;

/* ─────────── сигналы ─────────── */

/**
 * Проверка цепочки журнала — подключаемый источник.
 *
 * Участок sec (волна 10) заводит периодическую проверку цепочки и хранит
 * признак последней; здесь его ещё нет, и выдумывать свою полную проверку
 * каждую минуту нельзя — это проход по всему журналу. Поэтому правило
 * заведено, а источник подключается одной строкой:
 *
 *   setAuditChainSource(async () => ({ ok, checkedAt }))
 *
 * Пока источника нет, правило честно «недоступно: джерело не підключено», а
 * не «гаразд».
 */
export interface AuditChainStatus {
  ok: boolean;
  checkedAt: string;
}
let auditChainSource: (() => Promise<AuditChainStatus | null>) | null = null;

export function setAuditChainSource(fn: (() => Promise<AuditChainStatus | null>) | null): void {
  auditChainSource = fn;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  freePct: number;
}

/**
 * Ближайший существующий каталог: на свежей установке каталога записей ещё
 * нет (он создаётся первой записью), а место меряется на том же томе.
 */
async function nearestExisting(path: string): Promise<string> {
  let p = resolve(path);
  for (;;) {
    try {
      await stat(p);
      return p;
    } catch {
      const up = dirname(p);
      if (up === p) return p;
      p = up;
    }
  }
}

/**
 * Место на томе каталога данных приложения — statfs каталога записей.
 *
 * Это диск контейнера или тома (в docker-compose — том `recordings`), а не
 * всей машины: база лежит в своём томе, и её место отсюда не видно. Экран
 * говорит это рядом с правилом.
 */
export async function diskUsage(path = env.recordingsDir): Promise<DiskUsage | null> {
  try {
    const s = await statfs(await nearestExisting(path));
    const total = Number(s.blocks) * Number(s.bsize);
    /* bavail, а не bfree: место, зарезервированное под root, приложению не достанется */
    const free = Number(s.bavail) * Number(s.bsize);
    if (!total) return null;
    return { totalBytes: total, freeBytes: free, freePct: (free / total) * 100 };
  } catch (error) {
    log.warn("ops.alerts.statfs_failed", { error: String(error) });
    return null;
  }
}

export interface SignalInputs {
  now: number;
  stats: (windowMin: number) => OpsWindowStats;
  scheduler: { enabled: boolean; lastTickAt: number | null; startedAt: number };
  disk: DiskUsage | null;
  /** undefined — источник не подключён; null — подключён, но проверки ещё не было */
  auditChain: AuditChainStatus | null | undefined;
}

export interface Observation {
  /** true — сигнал есть; false — нет; null — измерить нельзя */
  firing: boolean | null;
  value: number | null;
  /** Код причины недоступности */
  unavailable?: string;
}

interface RuleShape {
  key: string;
  threshold: number | null;
  windowMin: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Что показывает сигнал правила сейчас. Чистая функция: входы собирает
 * gatherSignals, тест подставляет свои.
 */
export function observe(rule: RuleShape, s: SignalInputs): Observation {
  const t = rule.threshold;
  switch (rule.key as OpsAlertRuleKey) {
    case "errors5xx": {
      if (t === null) return { firing: null, value: null, unavailable: "noThreshold" };
      const w = s.stats(rule.windowMin ?? 10);
      const value = w.share5xx === null ? null : round1(w.share5xx * 100);
      if (w.requests < MIN_REQUESTS) return { firing: false, value };
      return { firing: (value ?? 0) > t, value };
    }
    case "p95": {
      if (t === null) return { firing: null, value: null, unavailable: "noThreshold" };
      const w = s.stats(rule.windowMin ?? 15);
      if (w.requests < MIN_REQUESTS) return { firing: false, value: w.p95 };
      return { firing: (w.p95 ?? 0) > t, value: w.p95 };
    }
    case "schedulerSilent": {
      if (t === null) return { firing: null, value: null, unavailable: "noThreshold" };
      /* выключенный на этом экземпляре планировщик не «молчит» — он идёт на другом */
      if (!s.scheduler.enabled) return { firing: null, value: null, unavailable: "schedulerOff" };
      const from = s.scheduler.lastTickAt ?? s.scheduler.startedAt;
      const minutes = Math.floor((s.now - from) / 60_000);
      return { firing: minutes > t, value: minutes };
    }
    case "diskFree": {
      if (t === null) return { firing: null, value: null, unavailable: "noThreshold" };
      if (!s.disk) return { firing: null, value: null, unavailable: "diskUnknown" };
      const value = round1(s.disk.freePct);
      return { firing: value < t, value };
    }
    case "auditChain": {
      if (s.auditChain === undefined) return { firing: null, value: null, unavailable: "noSource" };
      if (s.auditChain === null) return { firing: null, value: null, unavailable: "neverChecked" };
      return { firing: !s.auditChain.ok, value: s.auditChain.ok ? 1 : 0 };
    }
    default:
      return { firing: null, value: null, unavailable: "unknownRule" };
  }
}

/* ─────────── инцидент ─────────── */

export interface IncidentState {
  firingSince: string | null;
  lastSentAt: string | null;
}

export interface Decision {
  kind: Exclude<OpsAlertEventKind, "test"> | null;
  next: IncidentState;
}

/**
 * Что делать с инцидентом правила. Чистая функция — ради тестов «сработало,
 * затихло, повторило, восстановилось» без часов и сети.
 *
 *   — сигнал появился → «збій» и начало инцидента;
 *   — сигнал держится → молчим, пока не прошло `repeatMin` с последнего
 *     оповещения, потом «досі триває»;
 *   — сигнал ушёл → «відновлено» и конец инцидента;
 *   — сигнал не измерить → ничего не меняем: пропавший источник не значит
 *     ни «починилось», ни «сломалось».
 */
export function decide(state: IncidentState, obs: Observation, repeatMin: number, now: number): Decision {
  const at = new Date(now).toISOString();
  if (obs.firing === null) return { kind: null, next: state };
  if (obs.firing) {
    if (!state.firingSince) return { kind: "fired", next: { firingSince: at, lastSentAt: at } };
    const last = state.lastSentAt ? Date.parse(state.lastSentAt) : 0;
    if (now - last >= repeatMin * 60_000) return { kind: "repeat", next: { firingSince: state.firingSince, lastSentAt: at } };
    return { kind: null, next: state };
  }
  if (state.firingSince) return { kind: "resolved", next: { firingSince: null, lastSentAt: null } };
  return { kind: null, next: state };
}

/* ─────────── каналы ─────────── */

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const realFetch: FetchLike = (url, init) => fetch(url, init);
let fetchImpl: FetchLike = realFetch;

/** Подмена сети в тестах: Telegram из тестов не зовётся никогда */
export function setAlertFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? realFetch;
}

const TELEGRAM_TIMEOUT_MS = 5000;

function telegramEnv(): { token: string | null; chat: string | null } {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN?.trim() || null,
    chat: process.env.TELEGRAM_CHAT_ID?.trim() || null,
  };
}

/**
 * Текст отказа без секретов: токен бота, номер чата и адрес SMTP заменяются,
 * почта и телефоны маскируются (scrubText техпанели). Отказ ложится в
 * историю, которую видит любой с ops.read, — а токен бота это ключ от бота.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  const { token, chat } = telegramEnv();
  for (const [secret, mask] of [
    [token, "[token]"],
    [chat, "[chat]"],
    [env.smtpUrl || null, "[smtp]"],
  ] as const) {
    if (secret && secret.length >= 4) out = out.split(secret).join(mask);
  }
  out = out.replace(/bot\d+:[\w-]+/g, "bot[token]").replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[auth]@");
  return scrubText(out, 300);
}

const failed = (channel: OpsAlertChannel, error: unknown): OpsAlertDelivery => ({
  channel,
  outcome: "failed",
  error: scrubSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
});

async function sendTelegram(text: string): Promise<OpsAlertDelivery> {
  const { token, chat } = telegramEnv();
  if (!token || !chat) return { channel: "telegram", outcome: "unset", error: null };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { description?: string } | null;
      return failed("telegram", `HTTP ${res.status}${body?.description ? `: ${body.description}` : ""}`);
    }
    return { channel: "telegram", outcome: "sent", error: null };
  } catch (error) {
    return failed("telegram", error);
  }
}

/**
 * Кому письмо: OPS_ALERT_EMAIL (через запятую), иначе суперадмины — тот же
 * круг, что получает эскалации тревог. Адреса наружу не уходят — только
 * откуда список и сколько в нём.
 */
async function mailRecipients(): Promise<{ to: string[]; source: "env" | "superadmins" | "none" }> {
  const fromEnv = (process.env.OPS_ALERT_EMAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
  if (fromEnv.length) return { to: fromEnv, source: "env" };
  const supers = await superadminEmails();
  return supers.length ? { to: supers, source: "superadmins" } : { to: [], source: "none" };
}

async function sendEmail(subject: string, text: string): Promise<OpsAlertDelivery> {
  if (!mailTransportReady()) return { channel: "email", outcome: "unset", error: null };
  try {
    const { to } = await systemContext(baseDb, () => mailRecipients());
    if (!to.length) return { channel: "email", outcome: "unset", error: null };
    const sent = await sendSystemMail(to, subject, text);
    return { channel: "email", outcome: sent === "email" ? "sent" : "unset", error: null };
  } catch (error) {
    return failed("email", error);
  }
}

/** Разослать по каналам правила; каждый канал — свой итог, отказ одного не глушит другой */
export async function deliver(channels: readonly OpsAlertChannel[], subject: string, text: string): Promise<OpsAlertDelivery[]> {
  const out: OpsAlertDelivery[] = [];
  for (const ch of CHANNELS) {
    if (!channels.includes(ch)) continue;
    out.push(ch === "telegram" ? await sendTelegram(`${subject}\n${text}`) : await sendEmail(subject, text));
  }
  return out;
}

export async function channelsInfo(): Promise<OpsAlertChannels> {
  const { token, chat } = telegramEnv();
  const smtp = mailTransportReady();
  const { to, source } = await mailRecipients();
  return {
    telegram: { configured: Boolean(token && chat), token: Boolean(token), chat: Boolean(chat) },
    email: { configured: smtp && to.length > 0, smtp, recipients: source, count: to.length },
  };
}

/* ─────────── текст оповещения ─────────── */

/*
 * Текст — украинский, из словаря уведомлений (pushStrings.ts, push.ops.*):
 * его собирает сервер без запроса, как пуши, и читают его дежурные
 * разработчики и администратор учреждения — язык у отделения один.
 */
const u = (key: string, v: Record<string, string | number> = {}) => renderPush(key, "uk", v);
const num = (v: number | null) => (v === null ? "—" : new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 }).format(v));

const WHAT: Record<OpsAlertRuleKey, string> = {
  errors5xx: "push.ops.what.errors5xx",
  schedulerSilent: "push.ops.what.schedulerSilent",
  p95: "push.ops.what.p95",
  diskFree: "push.ops.what.diskFree",
  auditChain: "push.ops.what.auditChain",
};

function instanceLabel(): string {
  try {
    return new URL(env.consoleUrl).host;
  } catch {
    return "Polypsy";
  }
}

export function alertText(
  kind: Exclude<OpsAlertEventKind, "test">,
  rule: { key: OpsAlertRuleKey; threshold: number | null; windowMin: number | null },
  value: number | null,
  since: string | null,
  now: number,
): { subject: string; text: string } {
  const what = u(WHAT[rule.key], { value: num(value), threshold: num(rule.threshold), window: rule.windowMin ?? "—" });
  const head = kind === "fired" ? "push.ops.fired" : kind === "repeat" ? "push.ops.repeat" : "push.ops.resolved";
  const time = since
    ? new Date(since).toLocaleTimeString("uk-UA", { timeZone: env.institutionTz, hour: "2-digit", minute: "2-digit" })
    : "—";
  const minutes = since ? Math.max(0, Math.round((now - Date.parse(since)) / 60_000)) : 0;
  const subject = `[${instanceLabel()}] ${u(head, { what, since: time, minutes })}`;
  const text = u("push.ops.link", { url: `${env.consoleUrl.replace(/\/$/, "")}/ops/alerts` });
  return { subject, text };
}

/* ─────────── правила ─────────── */

type RuleRow = typeof opsAlertRules.$inferSelect;

export function ruleView(r: RuleRow): OpsAlertRule {
  const state: OpsAlertState = !r.enabled
    ? "off"
    : (r.lastState as OpsAlertState | null) ?? "unknown";
  return {
    key: r.key as OpsAlertRuleKey,
    enabled: r.enabled,
    threshold: r.threshold,
    windowMin: r.windowMin,
    repeatMin: r.repeatMin,
    channels: (r.channels ?? []).filter((c): c is OpsAlertChannel => CHANNELS.includes(c)),
    state,
    unavailable: r.enabled && r.lastState === "unavailable" ? r.lastReason : null,
    firingSince: r.firingSince,
    lastValue: r.lastValue,
    lastCheckedAt: r.lastCheckedAt,
    lastSentAt: r.lastSentAt,
    updatedAt: r.updatedAt,
  };
}

export async function listRules(): Promise<OpsAlertRule[]> {
  const rows = await db.select().from(opsAlertRules);
  const order = new Map(ALERT_RULE_KEYS.map((k, i) => [k as string, i]));
  return rows
    .filter((r) => order.has(r.key))
    .sort((a, b) => order.get(a.key)! - order.get(b.key)!)
    .map(ruleView);
}

/* пределы порогов — общие с консолью (@quizzy/shared, OPS_RULE_LIMITS) */
const RULE_LIMITS = OPS_RULE_LIMITS;
const REPEAT_LIMITS = OPS_REPEAT_LIMITS;

/** Код отказа правки правила; null — правка допустима */
export function validateRuleInput(key: OpsAlertRuleKey, input: OpsAlertRuleInput): string | null {
  const lim = RULE_LIMITS[key];
  const inRange = (v: number, [lo, hi]: [number, number]) => Number.isFinite(v) && v >= lo && v <= hi;
  if (input.threshold !== undefined) {
    if (lim.threshold === null) {
      if (input.threshold !== null) return "threshold";
    } else if (input.threshold === null || !inRange(input.threshold, lim.threshold)) return "threshold";
  }
  if (input.windowMin !== undefined) {
    if (lim.window === null) {
      if (input.windowMin !== null) return "window";
    } else if (input.windowMin === null || !Number.isInteger(input.windowMin) || !inRange(input.windowMin, lim.window)) return "window";
  }
  if (input.repeatMin !== undefined && (!Number.isInteger(input.repeatMin) || !inRange(input.repeatMin, REPEAT_LIMITS))) return "repeat";
  if (input.channels !== undefined && input.channels.some((c) => !CHANNELS.includes(c))) return "channels";
  return null;
}

/**
 * Правка правила. Выключение закрывает инцидент без «відновлено»:
 * выключили — значит, об этом сигнале больше не говорим, и сообщение
 * «починилось» было бы неправдой.
 */
export async function updateRule(key: OpsAlertRuleKey, input: OpsAlertRuleInput, actorId: string): Promise<OpsAlertRule | null> {
  const patch: Partial<typeof opsAlertRules.$inferInsert> = { updatedAt: new Date().toISOString(), updatedBy: actorId };
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.threshold !== undefined) patch.threshold = input.threshold;
  if (input.windowMin !== undefined) patch.windowMin = input.windowMin;
  if (input.repeatMin !== undefined) patch.repeatMin = input.repeatMin;
  if (input.channels !== undefined) patch.channels = CHANNELS.filter((c) => input.channels!.includes(c));
  if (input.enabled === false) {
    patch.firingSince = null;
    patch.lastSentAt = null;
  }
  const [row] = await db.update(opsAlertRules).set(patch).where(eq(opsAlertRules.key, key)).returning();
  return row ? ruleView(row) : null;
}

/* ─────────── проверка ─────────── */

export async function gatherSignals(now: number, over: Partial<SignalInputs> = {}): Promise<SignalInputs> {
  const auditChain =
    "auditChain" in over
      ? over.auditChain
      : auditChainSource
        ? await auditChainSource().catch((error) => {
            log.warn("ops.alerts.audit_source_failed", { error: String(error) });
            return null;
          })
        : undefined;
  return {
    now,
    stats: over.stats ?? ((w) => windowStats(w, now)),
    scheduler: over.scheduler ?? {
      enabled: env.schedulerEnabled,
      lastTickAt: lastStartOf("schedules"),
      startedAt: Date.parse(startedAt),
    },
    disk: "disk" in over ? (over.disk ?? null) : await diskUsage(),
    auditChain,
  };
}

async function recordEvent(e: Omit<OpsAlertEvent, "id" | "at"> & { at?: string }): Promise<void> {
  await db.insert(opsAlertEvents).values({
    id: crypto.randomUUID(),
    at: e.at ?? new Date().toISOString(),
    ruleKey: e.rule,
    kind: e.kind,
    value: e.value,
    threshold: e.threshold,
    deliveries: e.deliveries,
  });
}

let lastPruneAt = 0;
const PRUNE_EVERY_MS = 6 * 3_600_000;

/**
 * Чистка по сроку: история оповещений и группы ошибок клиента, которых не
 * было 90 дней; скорость экранов старше 100 дней. Раз в шесть часов, в том
 * же проходе проверки: отдельной задачи ради трёх DELETE не заслуживает.
 */
export async function pruneOpsSignals(now: number): Promise<void> {
  const cutoff = new Date(now - HISTORY_DAYS * 86_400_000).toISOString();
  const vitalsCutoff = new Date(now - VITALS_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  await db.delete(opsAlertEvents).where(lt(opsAlertEvents.at, cutoff));
  await db.delete(opsClientErrors).where(lt(opsClientErrors.lastAt, cutoff));
  await db.delete(opsVitals).where(lt(opsVitals.day, vitalsCutoff));
}

export interface CheckReport {
  checked: number;
  fired: number;
  repeated: number;
  resolved: number;
}

/**
 * Один проход проверки правил.
 *
 * Три шага, и сеть — между ними, а не внутри транзакции: решение
 * принимается и записывается в одной транзакции, рассылка идёт вне её, итог
 * рассылки ложится второй. Запрос в Telegram держал бы соединение из пула
 * все свои пять секунд, почта — двадцать; у рассыльщика тревог это однажды
 * уже кончилось исчерпанием пула (notify.ts).
 *
 * Состояние инцидента пишется ДО рассылки: упади процесс посреди отправки —
 * следующий проход не пришлёт «збій» второй раз. Цена — оповещение,
 * которое не ушло из-за падения, не повторится раньше `repeat_min`; история
 * при этом покажет, что оно не ушло.
 */
export async function runAlertChecks(opts: { now?: number; signals?: Partial<SignalInputs> } = {}): Promise<CheckReport> {
  const now = opts.now ?? Date.now();
  const inputs = await gatherSignals(now, opts.signals);
  const at = new Date(now).toISOString();

  const pending = await systemContext(baseDb, async () => {
    const rows = await db.select().from(opsAlertRules);
    const out: { rule: RuleRow; kind: Exclude<OpsAlertEventKind, "test">; value: number | null; since: string | null }[] = [];
    for (const r of rows) {
      if (!ALERT_RULE_KEYS.includes(r.key as OpsAlertRuleKey)) continue;
      if (!r.enabled) {
        await db.update(opsAlertRules).set({ lastState: "off", lastCheckedAt: at }).where(eq(opsAlertRules.key, r.key));
        continue;
      }
      const obs = observe(r, inputs);
      const d = decide({ firingSince: r.firingSince, lastSentAt: r.lastSentAt }, obs, r.repeatMin, now);
      await db
        .update(opsAlertRules)
        .set({
          lastState: obs.firing === null ? "unavailable" : obs.firing ? "firing" : "ok",
          lastReason: obs.unavailable ?? null,
          lastValue: obs.value,
          lastCheckedAt: at,
          firingSince: d.next.firingSince,
          lastSentAt: d.next.lastSentAt,
        })
        .where(eq(opsAlertRules.key, r.key));
      /* «начало» для «відновлено» — прежнее, для «збій» — новое */
      if (d.kind) out.push({ rule: r, kind: d.kind, value: obs.value, since: d.kind === "resolved" ? r.firingSince : d.next.firingSince });
    }
    if (now - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = now;
      await pruneOpsSignals(now);
    }
    return { out, checked: rows.length };
  });

  const report: CheckReport = { checked: pending.checked, fired: 0, repeated: 0, resolved: 0 };
  for (const p of pending.out) {
    const rule = { key: p.rule.key as OpsAlertRuleKey, threshold: p.rule.threshold, windowMin: p.rule.windowMin };
    const { subject, text } = alertText(p.kind, rule, p.value, p.since, now);
    const deliveries = await deliver(p.rule.channels ?? [], subject, text);
    await systemContext(baseDb, () =>
      recordEvent({ at, rule: rule.key, kind: p.kind, value: p.value, threshold: p.rule.threshold, deliveries }),
    );
    if (deliveries.some((d) => d.outcome === "failed")) {
      log.warn("ops.alerts.delivery_failed", { rule: rule.key, kind: p.kind, failed: deliveries.filter((d) => d.outcome === "failed").map((d) => d.channel) });
    }
    if (p.kind === "fired") report.fired++;
    else if (p.kind === "repeat") report.repeated++;
    else report.resolved++;
  }
  return report;
}

/** Проход под замком задачи: две реплики не шлют один «збій» дважды */
export function runAlertChecksLocked(): Promise<CheckReport> {
  return withJobLock(ALERT_JOB, () => runAlertChecks());
}

/** Тестовое сообщение в канал: доходит ли — видно сразу, а не в день инцидента */
export async function sendTestAlert(channel: OpsAlertChannel): Promise<OpsAlertDelivery> {
  const subject = `[${instanceLabel()}] ${u("push.ops.test")}`;
  const text = u("push.ops.link", { url: `${env.consoleUrl.replace(/\/$/, "")}/ops/alerts` });
  const [delivery] = await deliver([channel], subject, text);
  const result = delivery ?? { channel, outcome: "unset" as const, error: null };
  await systemContext(baseDb, () => recordEvent({ rule: null, kind: "test", value: null, threshold: null, deliveries: [result] }));
  return result;
}

export async function alertHistory(limit = 100): Promise<OpsAlertEvent[]> {
  const rows = await db.select().from(opsAlertEvents).orderBy(desc(opsAlertEvents.at)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    rule: (r.ruleKey as OpsAlertRuleKey | null) ?? null,
    kind: r.kind,
    value: r.value,
    threshold: r.threshold,
    deliveries: r.deliveries ?? [],
  }));
}

/** Шаг проверки: минута — 5xx и p95 меряются окнами в десять-пятнадцать минут */
export const ALERT_INTERVAL_MS = 60_000;

export function alertCheckerInfo(): { enabled: boolean; intervalSec: number; lastRunAt: string | null } {
  const last = lastStartOf(ALERT_JOB);
  return {
    enabled: env.schedulerEnabled,
    intervalSec: Math.round((intervalOf(ALERT_JOB) ?? ALERT_INTERVAL_MS) / 1000),
    lastRunAt: last === null ? null : new Date(last).toISOString(),
  };
}

/**
 * Такт проверки — на экземпляре с планировщиком, рядом с ним (index.ts).
 * Такты не накладываются: пока идёт прошлый (или ручной), новый пропускается
 * и отмечается в реестре «пропущено».
 */
export function startOpsAlerts(intervalMs = ALERT_INTERVAL_MS): () => void {
  registerJob(ALERT_JOB, intervalMs);
  const tick = () => {
    if (isRunning(ALERT_JOB)) {
      skipJob(ALERT_JOB);
      return;
    }
    trackJob(ALERT_JOB, runAlertChecksLocked).catch((error) => log.error("ops.alerts.failed", { error: String(error) }));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

/** Только для тестов */
export function resetAlertPrune(): void {
  lastPruneAt = 0;
}
