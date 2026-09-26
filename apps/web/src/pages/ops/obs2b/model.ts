import {
  OPS_REPEAT_LIMITS,
  OPS_RULE_LIMITS,
  VITAL_THRESHOLDS,
  type ClientErrorKind,
  type ClientPlatform,
  type OpsAlertChannel,
  type OpsAlertDelivery,
  type OpsAlertEventKind,
  type OpsAlertHistory,
  type OpsAlertRule,
  type OpsAlertRuleInput,
  type OpsAlertRuleKey,
  type OpsAlertState,
  type OpsClientErrorGroup,
  type OpsJob,
  type OpsRecordings,
  type OpsVitalCell,
  type OpsVitalRoute,
  type RecordingStatus,
  type UiKey,
  type VitalMetric,
  type VitalRating,
} from "@quizzy/shared";
import type { Tone } from "../parts";
import type { ColumnGroup, GapPoint } from "./charts";

/**
 * Чистая логика разделов техпанели участка obs2b: «Сповіщення», «Помилки
 * клієнта», «Швидкість екранів», «Записи прийомів» и кнопка «Запустити
 * зараз». Без React и без «сейчас» внутри (apps/web/test/opsObs2b.test.ts).
 */

/* ─────────── сповіщення ─────────── */

export const RULE_NAME: Record<OpsAlertRuleKey, UiKey> = {
  errors5xx: "o2b.rule.errors5xx",
  schedulerSilent: "o2b.rule.schedulerSilent",
  p95: "o2b.rule.p95",
  diskFree: "o2b.rule.diskFree",
  auditChain: "o2b.rule.auditChain",
};

/** Что меряет правило — одной фразой под названием */
export const RULE_HINT: Record<OpsAlertRuleKey, UiKey> = {
  errors5xx: "o2b.rule.errors5xx.hint",
  schedulerSilent: "o2b.rule.schedulerSilent.hint",
  p95: "o2b.rule.p95.hint",
  diskFree: "o2b.rule.diskFree.hint",
  auditChain: "o2b.rule.auditChain.hint",
};

export type RuleUnit = "pct" | "ms" | "min";

/** Единица порога и значения; у проверки журнала порога нет */
export const RULE_UNIT: Record<OpsAlertRuleKey, RuleUnit | null> = {
  errors5xx: "pct",
  schedulerSilent: "min",
  p95: "ms",
  diskFree: "pct",
  auditChain: null,
};

/** Сигнал — «больше порога» или «меньше порога»: место на диске тревожит, когда его мало */
export const RULE_BELOW: ReadonlySet<OpsAlertRuleKey> = new Set(["diskFree"]);

export const hasWindow = (key: OpsAlertRuleKey) => OPS_RULE_LIMITS[key].window !== null;
export const hasThreshold = (key: OpsAlertRuleKey) => OPS_RULE_LIMITS[key].threshold !== null;

export const STATE_TONE: Record<OpsAlertState, Tone> = {
  ok: "ok",
  firing: "fail",
  unavailable: "quiet",
  off: "quiet",
  unknown: "quiet",
};

export const STATE_KEY: Record<OpsAlertState, UiKey> = {
  ok: "o2b.state.ok",
  firing: "o2b.state.firing",
  unavailable: "o2b.state.unavailable",
  off: "o2b.state.off",
  unknown: "o2b.state.unknown",
};

/** Почему сигнал не измерить — код сервера в фразу; незнакомый код — без пояснения */
export function unavailableKey(code: string | null): UiKey | null {
  const table: Record<string, UiKey> = {
    schedulerOff: "o2b.unavail.schedulerOff",
    diskUnknown: "o2b.unavail.diskUnknown",
    noSource: "o2b.unavail.noSource",
    neverChecked: "o2b.unavail.neverChecked",
    noThreshold: "o2b.unavail.noThreshold",
  };
  return code ? (table[code] ?? null) : null;
}

export const EVENT_KEY: Record<OpsAlertEventKind, UiKey> = {
  fired: "o2b.event.fired",
  repeat: "o2b.event.repeat",
  resolved: "o2b.event.resolved",
  test: "o2b.event.test",
};

/* янтарь — у «збій» и «досі триває»: они требуют внимания; «відновлено» и тестовое — нет */
export const EVENT_TONE: Record<OpsAlertEventKind, Tone> = { fired: "fail", repeat: "warn", resolved: "ok", test: "quiet" };

export const CHANNEL_KEY: Record<OpsAlertChannel, UiKey> = { telegram: "o2b.channel.telegram", email: "o2b.channel.email" };

export const DELIVERY_KEY: Record<OpsAlertDelivery["outcome"], UiKey> = {
  sent: "o2b.delivery.sent",
  failed: "o2b.delivery.failed",
  unset: "o2b.delivery.unset",
};

/** Черновик правки правила — строки полей формы, как их набрал человек */
export interface RuleDraft {
  enabled: boolean;
  threshold: string;
  windowMin: string;
  repeatMin: string;
  channels: OpsAlertChannel[];
}

export function draftOf(r: OpsAlertRule): RuleDraft {
  return {
    enabled: r.enabled,
    threshold: r.threshold === null ? "" : String(r.threshold),
    windowMin: r.windowMin === null ? "" : String(r.windowMin),
    repeatMin: String(r.repeatMin),
    channels: r.channels.slice(),
  };
}

/** Число из поля: запятая — тоже десятичный знак, как её набирают по-украински */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type DraftError = "threshold" | "window" | "repeat";

/**
 * Черновик → правка для сервера, с теми же пределами, что проверяет сервер
 * (OPS_RULE_LIMITS из общего пакета): ошибка видна у поля до отправки, а не
 * тостом «400» после.
 */
export function ruleInputOf(key: OpsAlertRuleKey, d: RuleDraft): { input: OpsAlertRuleInput } | { error: DraftError } {
  const lim = OPS_RULE_LIMITS[key];
  const input: OpsAlertRuleInput = { enabled: d.enabled, channels: d.channels.slice() };
  const inRange = (v: number | null, r: [number, number]) => v !== null && v >= r[0] && v <= r[1];
  if (lim.threshold) {
    const v = parseNum(d.threshold);
    if (!inRange(v, lim.threshold)) return { error: "threshold" };
    input.threshold = v;
  }
  if (lim.window) {
    const v = parseNum(d.windowMin);
    if (v === null || !Number.isInteger(v) || !inRange(v, lim.window)) return { error: "window" };
    input.windowMin = v;
  }
  const rep = parseNum(d.repeatMin);
  if (rep === null || !Number.isInteger(rep) || !inRange(rep, OPS_REPEAT_LIMITS)) return { error: "repeat" };
  input.repeatMin = rep;
  return { input };
}

export function toggleChannel(list: readonly OpsAlertChannel[], ch: OpsAlertChannel): OpsAlertChannel[] {
  return list.includes(ch) ? list.filter((c) => c !== ch) : [...list, ch];
}

/** Значение правила в его единице: «7,2 %», «2 400 мс», «135 хв» */
export function fmtRuleValue(key: OpsAlertRuleKey, v: number | null, loc: string): string {
  /* у проверки журнала числа нет — есть «прошла / не прошла», и это говорит состояние правила */
  if (v === null || key === "auditChain") return "—";
  const unit = RULE_UNIT[key];
  const f = (n: number, style: Intl.NumberFormatOptions) => new Intl.NumberFormat(loc, style).format(n);
  if (unit === "pct") return f(v / 100, { style: "percent", maximumFractionDigits: 1 });
  if (unit === "ms") return f(v, { style: "unit", unit: "millisecond", unitDisplay: "short", maximumFractionDigits: 0 });
  if (unit === "min") return f(v, { style: "unit", unit: "minute", unitDisplay: "short", maximumFractionDigits: 0 });
  return f(v, { maximumFractionDigits: 1 });
}

/* ─────────── помилки клієнта ─────────── */

export type PlatformFilter = "all" | ClientPlatform;
export type KindFilter = "all" | ClientErrorKind;

export const parsePlatform = (v: string | null): PlatformFilter => (v === "web" || v === "mobile" ? v : "all");
export const parseKind = (v: string | null): KindFilter =>
  v === "react" || v === "error" || v === "rejection" || v === "network" ? v : "all";

export const KIND_KEY: Record<ClientErrorKind, UiKey> = {
  react: "o2b.kind.react",
  error: "o2b.kind.error",
  rejection: "o2b.kind.rejection",
  network: "o2b.kind.network",
};

export const PLATFORM_KEY: Record<ClientPlatform, UiKey> = { web: "o2b.platform.web", mobile: "o2b.platform.mobile" };

export function filterClientErrors(
  items: readonly OpsClientErrorGroup[],
  f: { q: string; platform: PlatformFilter; kind: KindFilter },
): OpsClientErrorGroup[] {
  const needle = f.q.trim().toLowerCase();
  return items.filter(
    (g) =>
      (f.platform === "all" || g.platform === f.platform) &&
      (f.kind === "all" || g.kind === f.kind) &&
      (!needle ||
        [g.name, g.message, g.route, g.apiRoute ?? "", g.release ?? "", g.browser ?? "", g.os ?? ""].join(" ").toLowerCase().includes(needle)),
  );
}

/* ─────────── швидкість екранів ─────────── */

export const METRIC_KEY: Record<VitalMetric, UiKey> = {
  LCP: "o2b.metric.LCP",
  INP: "o2b.metric.INP",
  CLS: "o2b.metric.CLS",
  TTFB: "o2b.metric.TTFB",
  NAV: "o2b.metric.NAV",
};

/** Что мера меряет — одной фразой в таблице порогов */
export const METRIC_WHAT: Record<VitalMetric, UiKey> = {
  LCP: "o2b.metric.LCP.what",
  INP: "o2b.metric.INP.what",
  CLS: "o2b.metric.CLS.what",
  TTFB: "o2b.metric.TTFB.what",
  NAV: "o2b.metric.NAV.what",
};

export const parseMetric = (v: string | null): VitalMetric =>
  v === "INP" || v === "CLS" || v === "TTFB" || v === "NAV" ? v : "LCP";

/* оценка словом и формой точки: «добре» — порядок, «потребує уваги» — внимание, «погано» — сбой */
export const RATING_TONE: Record<VitalRating, Tone> = { good: "ok", needs: "warn", poor: "fail" };
export const RATING_KEY: Record<VitalRating, UiKey> = { good: "o2b.rating.good", needs: "o2b.rating.needs", poor: "o2b.rating.poor" };

/** Меньше стольких замеров p75 — ещё не мера, а случай; экран так и говорит */
export const LOW_SAMPLE = 20;

/** Значение меры: CLS — без единицы, три знака; остальное — мс или с */
export function fmtVital(metric: VitalMetric, v: number | null, loc: string): string {
  if (v === null) return "—";
  if (metric === "CLS") return new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(v);
  if (v >= 1000) {
    return new Intl.NumberFormat(loc, { style: "unit", unit: "second", unitDisplay: "short", maximumFractionDigits: 1 }).format(v / 1000);
  }
  return new Intl.NumberFormat(loc, { style: "unit", unit: "millisecond", unitDisplay: "short", maximumFractionDigits: 0 }).format(v);
}

/** Пороги меры в подписи: «добре ≤ 2,5 с · погано > 4 с» */
export function thresholdsOf(metric: VitalMetric, loc: string): { good: string; poor: string } {
  const t = VITAL_THRESHOLDS[metric];
  return { good: fmtVital(metric, t.good, loc), poor: fmtVital(metric, t.poor, loc) };
}

export function filterVitalRoutes(routes: readonly OpsVitalRoute[], q: string): OpsVitalRoute[] {
  const needle = q.trim().toLowerCase();
  return needle ? routes.filter((r) => r.route.toLowerCase().includes(needle)) : routes.slice();
}

/**
 * Ход p75 по дням — все дни периода, день без замеров — null: не «ноль
 * миллисекунд», а отсутствие данных. Прежде такие дни выбрасывались из ряда,
 * и LineChart, ставящий точки через равные шаги, сжимал время: неделя без
 * замеров выглядела соседними днями. Волна 11: ось — дни, пустой день —
 * разрыв линии (GapLine).
 */
export function vitalSeries(cell: OpsVitalCell | undefined, days: readonly string[], label: (day: string) => string): GapPoint[] {
  if (!cell || !cell.daily.some((v) => v !== null)) return [];
  return days.map((d, i) => ({ key: d, label: label(d), value: cell.daily[i] ?? null }));
}

/** Числа хода для строки таблицы (Sparkline): только дни с замерами */
export const sparkOf = (cell: OpsVitalCell | undefined): number[] =>
  cell ? cell.daily.filter((v): v is number => v !== null) : [];

/* ─────────── записи прийомів ─────────── */

export const REC_STATUS_KEY: Record<RecordingStatus, UiKey> = {
  consent_pending: "o2b.rec.status.consent_pending",
  ready: "o2b.rec.status.ready",
  recording: "o2b.rec.status.recording",
  uploaded: "o2b.rec.status.uploaded",
  transcribing: "o2b.rec.status.transcribing",
  done: "o2b.rec.status.done",
  failed: "o2b.rec.status.failed",
  discarded: "o2b.rec.status.discarded",
};

export const countOf = (r: OpsRecordings, status: RecordingStatus) => r.byStatus.find((s) => s.status === status)?.count ?? 0;

/**
 * Расхождение базы и диска: файлов на томе больше или меньше, чем строк с
 * путём. Больше — сироты (запись удалили, файл остался — ровно то, чего быть
 * не должно); меньше — строки без файлов (файл потерян или том не тот).
 * null — сравнивать нечего (диск не прочитался или файлов слишком много).
 */
export function diskMismatch(r: OpsRecordings): { orphans: number; missing: number } | null {
  if (!r.disk || r.disk.truncated) return null;
  const diff = r.disk.files - r.stored.count;
  return { orphans: Math.max(0, diff), missing: Math.max(0, -diff) };
}

/** Доля свободного места; null — не известно */
export function freeShare(r: OpsRecordings): number | null {
  const d = r.disk;
  return d && d.totalBytes && d.freeBytes !== null ? d.freeBytes / d.totalBytes : null;
}

/* ─────────── фонові задачі ─────────── */

/** Кнопка «Запустити зараз» активна: задача ручная и сейчас не идёт */
export const canRunNow = (j: OpsJob) => j.manual && j.lastResult !== "running";

/* ═══════════ графики сигналов (волна 11) ═══════════ */

/*
 * Ряды для графиков над таблицами — чистыми функциями, без «сейчас» внутри:
 * момент передаётся, и тест (apps/web/test/opsSignals.test.ts) проверяет
 * правило на краях — пустой день, пустой период, скрытое, «інші».
 */

/* ─────────── дни по часам экрана ─────────── */

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * День момента по часам экрана — «YYYY-MM-DD».
 *
 * Ряды, которые считает сервер, режутся по поясу учреждения (lib/day.ts);
 * ряды, собранные здесь из моментов (первое появление ошибки, выкатка,
 * сверка журнала), — по часам того, кто смотрит. Для техпанели это одно и
 * то же место, а у разработчика в другом поясе граница суток и так совпадает
 * с его собственными часами — с тем, что он помнит о своём дне.
 */
export function localDay(at: string | number | Date): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Последние `n` дней по календарю, старые первыми, последний — день `now`.
 * Календарём, а не вычитанием суток в миллисекундах: в ночь перевода часов
 * сутки длятся 23 или 25 часов, и вычитание дало бы один день дважды.
 */
export function lastDays(now: number, n: number): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i)));
  return out;
}

/* ─────────── сповіщення ─────────── */

/**
 * Ряды графика истории: «збій» и «відновлено». Повтор («досі триває») —
 * не новое событие, а напоминание о прежнем: рядом со сбоем он рисовал бы
 * инцидент дважды, поэтому его число — в полосах по правилам, а не здесь.
 * Тон — как у метки события в списке ниже (EVENT_TONE).
 */
export const ALERT_SERIES: readonly { key: "fired" | "resolved"; label: UiKey; tone: Tone }[] = [
  { key: "fired", label: "o2b.event.fired", tone: EVENT_TONE.fired },
  { key: "resolved", label: "o2b.event.resolved", tone: EVENT_TONE.resolved },
];

export function alertGroups(daily: OpsAlertHistory["daily"], label: (day: string) => string): ColumnGroup[] {
  return daily.map((d) => ({ key: d.date, label: label(d.date), values: { fired: d.fired, resolved: d.resolved } }));
}

/** Было ли за период хоть одно событие — пустой месяц говорится словами, а не пустыми осями */
export const anyAlerts = (daily: OpsAlertHistory["daily"]) => daily.some((d) => d.fired + d.repeat + d.resolved > 0);

/* ─────────── помилки клієнта ─────────── */

/**
 * Новые группы по дню первого появления.
 *
 * Не «сколько раз падало в этот день»: группа хранит общий счётчик и два
 * момента (первый и последний раз), а не счёт по дням, — разложить его по
 * дням значило бы выдумать. Первое появление — настоящее событие: в этот
 * день у людей начала падать новая ошибка, и столбец после выкатки виден
 * сразу.
 */
export function newGroupsByDay(items: readonly Pick<OpsClientErrorGroup, "firstAt">[], days: readonly string[]): number[] {
  const at = new Map(days.map((d, i) => [d, i]));
  const out = days.map(() => 0);
  for (const g of items) {
    const i = at.get(localDay(g.firstAt));
    if (i !== undefined) out[i]! += 1;
  }
  return out;
}

/** Ключ строки «інші» — не может совпасть с маршрутом или браузером */
export const REST_KEY = "\u0000rest";

export interface Ranked {
  key: string;
  /** Случаев (сумма счётчиков групп) */
  value: number;
  /** Групп */
  groups: number;
}

/**
 * Рейтинг по признаку группы: сумма случаев, первые `limit` и остаток одной
 * строкой. Остаток — одной строкой, а не хвостом из двадцати: полос в
 * рейтинге не больше, чем глаз сравнивает разом. Признак не известен
 * (браузер мобилки, ОС без подписи) — ключ "", экран называет его словом.
 */
export function rankBy<T extends { count: number }>(
  items: readonly T[],
  keyOf: (item: T) => string | null,
  limit: number,
): { top: Ranked[]; rest: (Ranked & { keys: number }) | null } {
  const acc = new Map<string, Ranked>();
  for (const it of items) {
    const key = keyOf(it) ?? "";
    const r = acc.get(key) ?? { key, value: 0, groups: 0 };
    r.value += it.count;
    r.groups += 1;
    acc.set(key, r);
  }
  const all = [...acc.values()].sort((a, b) => b.value - a.value || b.groups - a.groups || a.key.localeCompare(b.key));
  const top = all.slice(0, limit);
  const tail = all.slice(limit);
  const rest = tail.length
    ? {
        key: REST_KEY,
        value: tail.reduce((s, r) => s + r.value, 0),
        groups: tail.reduce((s, r) => s + r.groups, 0),
        keys: tail.length,
      }
    : null;
  return { top, rest };
}

/** «Chrome 128» → «Chrome»: доля по семейству, версии — в строке группы */
export function browserFamily(b: string | null): string | null {
  if (!b) return null;
  return b.replace(/\s+\d+$/, "") || null;
}

/** Самые частые группы: по счётчику, при равенстве — свежая выше */
export function topGroups(items: readonly OpsClientErrorGroup[], limit: number): OpsClientErrorGroup[] {
  return [...items].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
}

/* ─────────── швидкість екранів ─────────── */

/**
 * Самые медленные экраны по мере: p75 по убыванию. Экран без замеров этой
 * меры в рейтинг не входит — у него нет p75, и нулём в конце списка он
 * читался бы как самый быстрый.
 */
export function slowestRoutes(
  routes: readonly OpsVitalRoute[],
  metric: VitalMetric,
  limit: number,
): { rows: { route: string; p75: number; rating: VitalRating; n: number }[]; more: number } {
  const all = routes
    .map((r) => ({ route: r.route, cell: r.metrics[metric] }))
    .filter((r): r is { route: string; cell: OpsVitalCell & { p75: number; rating: VitalRating } } => r.cell?.p75 != null && r.cell.rating !== null)
    .map((r) => ({ route: r.route, p75: r.cell.p75, rating: r.cell.rating, n: r.cell.n }))
    .sort((a, b) => b.p75 - a.p75 || b.n - a.n || a.route.localeCompare(b.route));
  return { rows: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** Замеры меры по оценке — по всем экранам (или по одной клетке) */
export function ratingTotals(cells: readonly (OpsVitalCell | undefined)[]): Record<VitalRating, number> {
  const out: Record<VitalRating, number> = { good: 0, needs: 0, poor: 0 };
  for (const c of cells) {
    if (!c?.ratings) continue;
    out.good += c.ratings.good;
    out.needs += c.ratings.needs;
    out.poor += c.ratings.poor;
  }
  return out;
}

export const RATING_ORDER: readonly VitalRating[] = ["good", "needs", "poor"];

/* ─────────── записи прийомів ─────────── */

/**
 * Порядок и тон состояний в полосе: путь записи слева направо —
 * расшифрованные, затем то, что ещё в пути (светлее — дальше от конца),
 * затем сбой (янтарь — его надо разобрать) и удалённые (серым: их больше
 * нет, и внимания они не требуют).
 */
export const REC_ORDER: readonly { status: RecordingStatus; tone: Tone; step?: number }[] = [
  { status: "done", tone: "ok", step: 1 },
  { status: "transcribing", tone: "ok", step: 0.7 },
  { status: "uploaded", tone: "ok", step: 0.55 },
  { status: "recording", tone: "ok", step: 0.4 },
  { status: "ready", tone: "ok", step: 0.25 },
  { status: "consent_pending", tone: "ok", step: 0.1 },
  { status: "failed", tone: "fail" },
  { status: "discarded", tone: "quiet" },
];

export function statusParts(r: OpsRecordings): { status: RecordingStatus; value: number; tone: Tone; step?: number }[] {
  return REC_ORDER.map((o) => ({ ...o, value: countOf(r, o.status) })).filter((p) => p.value > 0);
}

/**
 * Том записей по частям: записи (по диску), всё остальное на томе, свободно.
 * null — сложить нечего: том не прочитан, размер или свободное место не
 * известны, или файлов больше, чем пересчитал один запрос (тогда «записи» —
 * нижняя граница, и полоса соврала бы о доле).
 */
export function diskParts(r: OpsRecordings): { records: number; other: number; free: number } | null {
  const d = r.disk;
  if (!d || d.truncated || !d.totalBytes || d.freeBytes === null) return null;
  const used = Math.max(0, d.totalBytes - d.freeBytes);
  return { records: Math.min(d.bytes, used), other: Math.max(0, used - d.bytes), free: d.freeBytes };
}
