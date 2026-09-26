import {
  OPS_REPEAT_LIMITS,
  OPS_RULE_LIMITS,
  VITAL_THRESHOLDS,
  type ClientErrorKind,
  type ClientPlatform,
  type OpsAlertChannel,
  type OpsAlertDelivery,
  type OpsAlertEventKind,
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
import type { LinePoint } from "../../../charts";
import type { Tone } from "../parts";

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
 * Ход p75 по дням — точки только там, где замеры были: день без замеров не
 * «ноль миллисекунд», а отсутствие данных (то же правило, что у графика
 * нагрузки в «Огляді»).
 */
export function vitalSeries(cell: OpsVitalCell | undefined, days: readonly string[], label: (day: string) => string): LinePoint[] {
  if (!cell) return [];
  const out: LinePoint[] = [];
  cell.daily.forEach((v, i) => {
    if (v !== null && days[i]) out.push({ x: label(days[i]), y: v });
  });
  return out;
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
