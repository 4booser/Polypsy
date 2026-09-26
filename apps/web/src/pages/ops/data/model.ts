import type {
  DataCheck,
  DataCheckExample,
  DataCheckKey,
  MobileReport,
  PushReport,
  UiKey,
  UsageReport,
} from "@quizzy/shared";
import type { Column } from "../../../charts/clinical";

/**
 * Чистая логика разделов техпанели «Дані й продукт»: куда ведёт пример
 * проверки, как называется проверка и чем она опасна, сводка по уровням,
 * ступени воронки с конверсией, опоздание в человеческих единицах.
 *
 * Без React и без словаря в рантайме — только ключи словаря (UiKey): экран
 * переводит их сам, а тесты (apps/web/test/opsDataModel.test.ts) проверяют
 * правила, не рисуя экран. Ключи — литералами в картах, а не шаблоном
 * `opsd.check.${key}`: так компилятор знает каждый ключ поимённо, и
 * пропавшая строка словаря ломает сборку, а не экран в ту минуту, когда
 * проверка впервые сработала.
 */

/* ─────────── окно ─────────── */

export type Window = 7 | 30 | 90;
export const WINDOWS: readonly Window[] = [7, 30, 90];
export const WINDOW_LABEL: Record<Window, UiKey> = {
  7: "opsd.range7",
  30: "dash.range30d",
  90: "opsd.range90",
};

/* ─────────── проверки качества ─────────── */

/**
 * О чём проверка: о прохождениях или о методиках. Нужен экрану ещё до того,
 * как пришёл хоть один пример (подпись единицы у числа), поэтому хранится
 * здесь, а не выводится из examples[0].
 */
export const CHECK_KIND: Record<DataCheckKey, "response" | "survey"> = {
  "orphans.responseNoVersion": "response",
  "orphans.responseForeignVersion": "response",
  "orphans.answerForeignQuestion": "response",
  "orphans.scoreForeignScale": "response",
  "orphans.surveyDanglingVersion": "survey",
  "orphans.keyAcrossVersions": "survey",
  "scoring.noScores": "response",
  "scoring.noBands": "survey",
  "scores.unnormalized": "response",
  "answers.missing": "response",
  "responses.duplicates": "response",
  "responses.stale": "response",
};

/** Название проверки и «чем опасно» — смысл взят из обоснований в apps/api/src/lib/dataChecks.ts */
export const CHECK_TEXT: Record<DataCheckKey, { title: UiKey; danger: UiKey }> = {
  "orphans.responseNoVersion": { title: "opsd.chk.noVersion", danger: "opsd.chk.noVersionWhy" },
  "orphans.responseForeignVersion": { title: "opsd.chk.foreignVersion", danger: "opsd.chk.foreignVersionWhy" },
  "orphans.answerForeignQuestion": { title: "opsd.chk.foreignAnswer", danger: "opsd.chk.foreignAnswerWhy" },
  "orphans.scoreForeignScale": { title: "opsd.chk.foreignScore", danger: "opsd.chk.foreignScoreWhy" },
  "orphans.surveyDanglingVersion": { title: "opsd.chk.dangling", danger: "opsd.chk.danglingWhy" },
  "orphans.keyAcrossVersions": { title: "opsd.chk.keyAcross", danger: "opsd.chk.keyAcrossWhy" },
  "scoring.noScores": { title: "opsd.chk.noScores", danger: "opsd.chk.noScoresWhy" },
  "scoring.noBands": { title: "opsd.chk.noBands", danger: "opsd.chk.noBandsWhy" },
  "scores.unnormalized": { title: "opsd.chk.unnormalized", danger: "opsd.chk.unnormalizedWhy" },
  "answers.missing": { title: "opsd.chk.missing", danger: "opsd.chk.missingWhy" },
  "responses.duplicates": { title: "opsd.chk.duplicates", danger: "opsd.chk.duplicatesWhy" },
  "responses.stale": { title: "opsd.chk.stale", danger: "opsd.chk.staleWhy" },
};

export const LEVEL_LABEL: Record<DataCheck["level"], UiKey> = {
  error: "opsd.level.error",
  warning: "opsd.level.warning",
  info: "opsd.level.info",
};

export const KIND_UNIT: Record<"response" | "survey", UiKey> = {
  response: "opsd.q.unitResponses",
  survey: "opsd.q.unitSurveys",
};

/**
 * Куда ведёт пример: туда, где несостыковку видно в консоли.
 *
 * Прохождение — на свой протокол (там видно, чего не хватает и что лишнее),
 * методика — в конструктор (там её версии, шкалы и полосы). Ссылка ведёт на
 * обычный экран, где права проверят заново: у разработчика с одним ops.read
 * протокол не откроется, и это правильно — техпанель не дверь в клинические
 * записи.
 */
export function exampleHref(e: DataCheckExample): string {
  return e.kind === "response" ? `/surveys/${e.surveyId}/responses/${e.id}` : `/constructor/${e.surveyId}`;
}

/**
 * Куда ведёт строка разбивки по методикам.
 *
 * Ненормированные баллы чинятся нормами, а не содержимым — значит, на экран
 * норм методики. Остальные проверки по прохождениям — на аналитику методики
 * (список её прохождений), проверки по методикам — в конструктор.
 */
export function bySurveyHref(key: DataCheckKey, surveyId: string): string {
  if (key === "scores.unnormalized") return `/surveys/${surveyId}/norms`;
  return CHECK_KIND[key] === "survey" ? `/constructor/${surveyId}` : `/surveys/${surveyId}`;
}

/** Сколько проверок сработало на каждом уровне и сколько чистых */
export function checkSummary(checks: readonly Pick<DataCheck, "level" | "count">[]): {
  error: number;
  warning: number;
  info: number;
  clean: number;
} {
  const out = { error: 0, warning: 0, info: 0, clean: 0 };
  for (const c of checks) {
    if (c.count > 0) out[c.level] += 1;
    else out.clean += 1;
  }
  return out;
}

/**
 * Дополнительные числа проверки с подписями — в постоянном порядке.
 *
 * Порядок задан здесь, а не взят из ответа: у корзин давности он смысловой
 * (от свежих к старым), а порядок полей JSON сервер не обещает. Неизвестные
 * серверу поля не печатаются — подписи у них нет, а число без подписи на
 * экране хуже, чем никакого.
 */
const EXTRA_ORDER: [string, UiKey][] = [
  ["inProgress", "opsd.x.inProgress"],
  ["abandoned", "opsd.x.abandoned"],
  ["lt1d", "opsd.x.lt1d"],
  ["lt7d", "opsd.b.1to7d"],
  ["lt30d", "opsd.x.lt30d"],
  ["gte30d", "opsd.x.gte30d"],
  ["items", "opsd.x.items"],
  ["required", "opsd.x.required"],
  ["scores", "opsd.x.scores"],
  ["scales", "opsd.x.scales"],
  ["noScales", "opsd.x.noScales"],
  ["links", "opsd.x.links"],
];

export function extraRows(extra: Readonly<Record<string, number>>): { key: string; label: UiKey; value: number }[] {
  return EXTRA_ORDER.filter(([k]) => typeof extra[k] === "number").map(([key, label]) => ({
    key,
    label,
    value: extra[key]!,
  }));
}

/* ─────────── использование ─────────── */

export const APP_LABEL: Record<UsageReport["screens"]["top"][number]["app"], UiKey> = {
  console: "opsd.app.console",
  patient: "opsd.app.patient",
  mobile: "opsd.app.mobile",
};

/**
 * Доля ступени от предыдущей — только когда обе напечатаны.
 *
 * Доля от скрытого числа — то же скрытое число, записанное иначе: 50% от
 * «—» при известной следующей ступени называет скрытую точно (см.
 * lib/privacy.ts, cell). Поэтому null, и экран печатает прочерк.
 */
export function conversion(prev: number | null, cur: number | null): number | null {
  if (prev === null || cur === null || prev <= 0) return null;
  return Math.round((cur / prev) * 100);
}

export interface FunnelStep {
  key: "invites" | "registered" | "firstResponse" | "repeatResponse";
  label: UiKey;
  value: number | null;
  /** Доля от последней ПОКАЗАННОЙ ступени выше; у первой ступени — null */
  conversion: number | null;
}

/**
 * Ступени воронки в порядке пути.
 *
 * Доля считается от последней показанной ступени, а не от соседней: если
 * «перше проходження» скрыто порогом, «повторне» соотносится с
 * зарегистрировавшимися — обе эти величины и так напечатаны рядом, и доля
 * от них ничего сверх них не открывает.
 */
export function funnelSteps(f: UsageReport["funnel"]): FunnelStep[] {
  const raw: [FunnelStep["key"], UiKey, number | null][] = [
    ["invites", "opsd.u.invites", f.invites],
    ["registered", "opsd.u.registered", f.registered],
    ["firstResponse", "opsd.u.first", f.firstResponse],
    ["repeatResponse", "opsd.u.repeat", f.repeatResponse],
  ];
  let last: number | null = null;
  return raw.map(([key, label, value], i) => {
    const step: FunnelStep = { key, label, value, conversion: i === 0 ? null : conversion(last, value) };
    if (value !== null) last = value;
    return step;
  });
}

/* ─────────── ряды по дням ─────────── */

/** Столбец, который может быть скрыт порогом: null — «не показываем», а не ноль */
export interface MaybeColumn {
  key: string;
  label: string;
  value: number | null;
}

/**
 * Ряд дня → столбцы. Сервер уже отдаёт сплошной ряд (пустой день — ноль),
 * поэтому здесь только подпись: заполнять дыры не нужно, а заполнить их
 * здесь нулями значило бы спорить с сервером о том, что такое пустой день.
 */
export function dayColumns<T extends { date: string }>(
  rows: readonly T[],
  value: (row: T) => number,
  label: (iso: string) => string,
): Column[] {
  return rows.map((r) => ({ key: r.date, label: label(r.date), value: value(r) }));
}

export function maybeDayColumns<T extends { date: string }>(
  rows: readonly T[],
  value: (row: T) => number | null,
  label: (iso: string) => string,
): MaybeColumn[] {
  return rows.map((r) => ({ key: r.date, label: label(r.date), value: value(r) }));
}

/* ─────────── мобильное приложение ─────────── */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Опоздание в человеческих единицах: минуты до часа, часы до двух суток,
 * дальше дни. Округление вверх до минуты — «0 хв» у досылки, пришедшей
 * через сорок секунд, читалось бы как «не опаздывала», а она опаздывала.
 * null — выборка пуста: медианы нет, и нуля тоже нет.
 */
export function lagParts(ms: number | null): { n: number; unit: UiKey } | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms < HOUR) return { n: Math.max(1, Math.ceil(ms / MIN)), unit: "opsd.lag.min" };
  if (ms < 2 * DAY) return { n: Math.round((ms / HOUR) * 10) / 10, unit: "opsd.lag.h" };
  return { n: Math.round((ms / DAY) * 10) / 10, unit: "opsd.lag.d" };
}

export const LATE_BUCKET_LABEL: Record<MobileReport["late"]["buckets"][number]["key"], UiKey> = {
  lt1h: "opsd.m.lt1h",
  lt1d: "opsd.m.lt1d",
  lt7d: "opsd.b.1to7d",
  gte7d: "opsd.m.gte7d",
};

/** Упорядоченная светлота для корзин опоздания: от «почти вовремя» к «неделя и больше» */
export function lateParts(
  buckets: MobileReport["late"]["buckets"],
): { key: string; label: UiKey; value: number; step: number }[] {
  return buckets.map((b, i) => ({
    key: b.key,
    label: LATE_BUCKET_LABEL[b.key],
    value: b.count,
    step: buckets.length > 1 ? i / (buckets.length - 1) : 1,
  }));
}

export const PLATFORM_LABEL: Record<string, UiKey> = {
  ios: "opsd.platform.ios",
  android: "opsd.platform.android",
  web: "opsd.platform.web",
};

/* ─────────── пуши ─────────── */

/** Ошибка — всё, что не «принято и не отвергнуто квитанцией» (как на сервере) */
export function pushErrors(t: PushReport["totals"]): number {
  return t.rejected + t.failed + t.receiptErrors;
}

/** Типы уведомлений, которые шлёт сервер (lib/notify, mailingPush, remind, scheduler) */
export const PUSH_KIND_LABEL: Record<string, UiKey> = {
  alert: "opsd.kind.alert",
  mailing: "opsd.kind.mailing",
  appointment: "opsd.kind.appointment",
  assignment: "opsd.kind.assignment",
};

/**
 * Пояснение к коду ошибки. Коды Expo — как их пишет Expo (документация
 * push-сервиса); свои — network, timeout и http_* из lib/push.ts (failureCode).
 * Неизвестный код остаётся без пояснения: придумать смысл чужому коду —
 * хуже, чем честно промолчать.
 */
export function pushCodeHint(code: string): UiKey | null {
  if (code.startsWith("http_")) return "opsd.code.http";
  const known: Record<string, UiKey> = {
    DeviceNotRegistered: "opsd.code.deviceNotRegistered",
    MessageTooBig: "opsd.code.tooBig",
    MessageRateExceeded: "opsd.code.rate",
    InvalidCredentials: "opsd.code.credentials",
    network: "opsd.code.network",
    timeout: "opsd.code.timeout",
  };
  return known[code] ?? null;
}
