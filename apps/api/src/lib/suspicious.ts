import type { SuspiciousRule, SuspiciousThresholds } from "@quizzy/shared";

/**
 * Подозрительная активность — правила над журналом доступа.
 *
 * Решение заказчика 2026-09-26: журнал, который никто не читает, пока не
 * случилось, должен сам показывать то, что стоит прочесть. Правила — чистые
 * функции над строками журнала: вход — строки, выход — срабатывания. Ни
 * базы, ни часов: так каждое правило проверяется на подставном журнале
 * (opsPeople.test.ts), а проверка раз в пять минут (lib/suspiciousWatch.ts)
 * только читает журнал и складывает срабатывания.
 *
 * Правило не обвиняет — оно показывает серию, которую стоит разобрать, и
 * объясняет, почему она попала в список. Пороги подобраны так, чтобы обычная
 * работа отделения их не задевала: «много» здесь всегда число с
 * обоснованием, а не ощущение.
 *
 * Срабатывание — это серия, а не строка: пять неудачных входов подряд — одно
 * срабатывание, а не пять. У серии есть отпечаток (fingerprint) — правило,
 * ключ и первая строка серии: следующий проход по тем же суткам узнаёт её и
 * обновляет (серия выросла), а не заводит новую.
 */

/** Строка журнала — ровно те поля, что читают правила */
export interface JournalEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  subjectUserId: string | null;
  outcome: string;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
}

export interface Finding {
  rule: SuspiciousRule;
  fingerprint: string;
  actorId: string | null;
  actorEmail: string | null;
  subjectId: string | null;
  ip: string | null;
  windowFrom: string;
  windowTo: string;
  hits: number;
  details: Record<string, unknown>;
}

/* ─────────── пороги ─────────── */

/**
 * Пороги правил.
 *
 * Неудачные входы по учётке — пять за пятнадцать минут: ровно порог
 * блокировки входа (lib/loginGuard.ts). Упёрся в блокировку — это уже
 * событие: либо человек забыл пароль и сейчас позвонит, либо пароль
 * подбирают.
 *
 * По адресу — десять неудач за те же пятнадцать минут и не меньше трёх
 * разных учёток. Одного числа мало: весь госпиталь выходит в сеть через
 * один NAT (см. lib/loginGuard.ts), и десять опечаток утренней смены — не
 * атака. Три разные учётки с одного адреса за четверть часа — это перебор
 * пароля по списку людей, а не забывчивость.
 *
 * Массовые чтения — двадцать пять разных пациентов за пятнадцать минут одним
 * сотрудником. Приём идёт по записи, слот — от двадцати минут, и за день
 * специалист открывает тридцать–сорок карт; двадцать пять за четверть часа —
 * не приём, а выборка. Разбор тревог дежурным тоже не дотягивает: случаев
 * риска за смену — единицы.
 *
 * Ночь — не меньше трёх чтений данных пациентов вне рабочих часов
 * учреждения. Одно чтение ночью — это дежурный, открывший тревогу, и ради
 * этого тревоги и существуют; серия — уже вопрос.
 */
export const THRESHOLDS = {
  failedPerAccount: 5,
  failedPerIp: 10,
  failedIpAccounts: 3,
  failedWindowMin: 15,
  massReadPatients: 25,
  massReadWindowMin: 15,
  nightMinReads: 3,
} as const;

/**
 * Рабочие часы по умолчанию — 07:00–21:00.
 *
 * Берутся, только если в расписаниях специалистов нет ни одного шаблона
 * (workingDayOf ниже): приём отделения — с восьми до шести, плюс час на
 * бумаги с каждой стороны и запас на вечерний приём. Всё, что читает карты
 * между девятью вечера и семью утра, — вне рабочего дня.
 */
export const DEFAULT_WORKING_DAY = { from: "07:00", to: "21:00" } as const;

export interface RuleConfig {
  failedPerAccount: number;
  failedPerIp: number;
  failedIpAccounts: number;
  failedWindowMin: number;
  massReadPatients: number;
  massReadWindowMin: number;
  nightMinReads: number;
  /** Рабочий день: «ЧЧ:ММ» — ночь всё, что вне его */
  workingDay: { from: string; to: string };
  timezone: string;
  hoursSource: "schedule" | "default";
}

export const DEFAULT_CONFIG: RuleConfig = {
  ...THRESHOLDS,
  workingDay: { ...DEFAULT_WORKING_DAY },
  timezone: "Europe/Kyiv",
  hoursSource: "default",
};

/** Пороги в том виде, в каком их объясняет экран */
export function thresholdsOf(cfg: RuleConfig): SuspiciousThresholds {
  return {
    failedPerAccount: cfg.failedPerAccount,
    failedPerIp: cfg.failedPerIp,
    failedIpAccounts: cfg.failedIpAccounts,
    failedWindowMin: cfg.failedWindowMin,
    massReadPatients: cfg.massReadPatients,
    massReadWindowMin: cfg.massReadWindowMin,
    /* ночь начинается там, где кончается рабочий день */
    nightFrom: cfg.workingDay.to,
    nightTo: cfg.workingDay.from,
    nightMinReads: cfg.nightMinReads,
    timezone: cfg.timezone,
    hoursSource: cfg.hoursSource,
  };
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const fromMinutes = (mins: number): string =>
  `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

/**
 * Рабочий день учреждения — из расписаний специалистов.
 *
 * Самое раннее начало приёма и самый поздний конец по всем шаблонам недели,
 * с часом запаса на бумаги по обе стороны. Не по дням недели: отделение, где
 * по субботам принимают до двух, не делает субботний вечер «ночью» для того,
 * кто дописывает заключения, — расписание одного врача не описывает рабочий
 * день остальных. Нет шаблонов — константа DEFAULT_WORKING_DAY.
 */
export function workingDayOf(
  earliestStart: string | null,
  latestEnd: string | null,
): { day: { from: string; to: string }; source: "schedule" | "default" } {
  if (!earliestStart || !latestEnd) return { day: { ...DEFAULT_WORKING_DAY }, source: "default" };
  const from = Math.max(0, toMinutes(earliestStart) - 60);
  const to = Math.min(24 * 60 - 1, toMinutes(latestEnd) + 60);
  if (to <= from) return { day: { ...DEFAULT_WORKING_DAY }, source: "default" };
  return { day: { from: fromMinutes(from), to: fromMinutes(to) }, source: "schedule" };
}

/* ─────────── какие строки что значат ─────────── */

/**
 * Чтения данных конкретного пациента — действия, у которых субъект и есть
 * тот, чьи данные открыли. Список, а не «всё с subject_user_id»: у выдачи
 * доступа или записи на приём субъект тоже пациент, но это не чтение его
 * карты, и массовая запись регистратора на завтра не должна выглядеть как
 * выборка карт.
 */
export const PATIENT_READ_ACTIONS: ReadonlySet<string> = new Set([
  "patient.card_read",
  "response.read",
  "report.patient_chart",
  "report.episode_extract",
  "report.visit_certificate",
  "report.render",
  "clinic.phone_view",
  "clinic.visit_open",
  "alert.signals",
]);

/** Выгрузка, увозящая идентификаторы людей за пределы системы */
export function isNamedExport(e: JournalEntry): boolean {
  if (e.action !== "analytics.export" || e.outcome !== "success") return false;
  const d = e.details ?? {};
  return d.includesUserIds === true || d.profile === "full";
}

function isStaffRead(e: JournalEntry): boolean {
  return (
    PATIENT_READ_ACTIONS.has(e.action) &&
    e.outcome === "success" &&
    e.actorId !== null &&
    e.actorRole !== "user" &&
    e.subjectUserId !== null &&
    e.subjectUserId !== e.actorId
  );
}

const ms = (iso: string) => new Date(iso).getTime();
const byTime = (a: JournalEntry, b: JournalEntry) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id);

function groupBy<T>(items: readonly T[], key: (x: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/**
 * Серии: участки, где за `windowMs` набралось достаточно, — склеенные, если
 * перекрываются.
 *
 * Скользящее окно двумя указателями: для каждой строки — сколько строк
 * укладывается в окно от неё. Окна, прошедшие порог, склеиваются в одну
 * серию, если перекрываются: десять неудач за двадцать минут — одна атака,
 * а не шесть пересекающихся. `enough` решает, прошло ли окно порог, — у
 * одних правил это число строк, у других число разных пациентов или учёток.
 */
function series(
  events: readonly JournalEntry[],
  windowMs: number,
  enough: (slice: readonly JournalEntry[]) => boolean,
): JournalEntry[][] {
  const sorted = [...events].sort(byTime);
  const spans: [number, number][] = [];
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (j < i) j = i;
    while (j + 1 < sorted.length && ms(sorted[j + 1]!.at) - ms(sorted[i]!.at) <= windowMs) j++;
    if (enough(sorted.slice(i, j + 1))) {
      const last = spans[spans.length - 1];
      if (last && i <= last[1]) last[1] = Math.max(last[1], j);
      else spans.push([i, j]);
    }
  }
  return spans.map(([a, b]) => sorted.slice(a, b + 1));
}

function distinct(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

/* ─────────── правила ─────────── */

const emailOf = (e: JournalEntry): string | null => {
  const raw = (e.details?.email as string | undefined) ?? e.actorEmail;
  return raw ? raw.toLowerCase() : null;
};

const isFailedLogin = (e: JournalEntry) => e.action === "auth.login_failed";

/** Много неудачных входов по одной учётке */
export function failedLoginsByAccount(entries: readonly JournalEntry[], cfg: RuleConfig = DEFAULT_CONFIG): Finding[] {
  const out: Finding[] = [];
  for (const [email, list] of groupBy(entries.filter(isFailedLogin), emailOf)) {
    for (const s of series(list, cfg.failedWindowMin * 60_000, (x) => x.length >= cfg.failedPerAccount)) {
      const first = s[0]!;
      const last = s[s.length - 1]!;
      const actorId = s.find((e) => e.actorId)?.actorId ?? null;
      out.push({
        rule: "failedLoginsAccount",
        fingerprint: `failedLoginsAccount:${email}:${first.id}`,
        actorId,
        actorEmail: email,
        subjectId: null,
        ip: distinct(s.map((e) => e.ip)).length === 1 ? first.ip : null,
        windowFrom: first.at,
        windowTo: last.at,
        hits: s.length,
        details: {
          reasons: distinct(s.map((e) => e.details?.reason as string | undefined)),
          ips: distinct(s.map((e) => e.ip)).slice(0, 10),
          lockedOut: s.some((e) => e.details?.reason === "locked_out"),
        },
      });
    }
  }
  return out;
}

/** Много неудачных входов с одного адреса — по разным учёткам */
export function failedLoginsByIp(entries: readonly JournalEntry[], cfg: RuleConfig = DEFAULT_CONFIG): Finding[] {
  const out: Finding[] = [];
  for (const [ip, list] of groupBy(entries.filter(isFailedLogin), (e) => e.ip)) {
    const enough = (x: readonly JournalEntry[]) =>
      x.length >= cfg.failedPerIp && distinct(x.map(emailOf)).length >= cfg.failedIpAccounts;
    for (const s of series(list, cfg.failedWindowMin * 60_000, enough)) {
      const first = s[0]!;
      const accounts = distinct(s.map(emailOf));
      out.push({
        rule: "failedLoginsIp",
        fingerprint: `failedLoginsIp:${ip}:${first.id}`,
        actorId: null,
        actorEmail: null,
        subjectId: null,
        ip,
        windowFrom: first.at,
        windowTo: s[s.length - 1]!.at,
        hits: s.length,
        details: { accounts: accounts.length, emails: accounts.slice(0, 20) },
      });
    }
  }
  return out;
}

/**
 * Семейство клиента из User-Agent: «браузер · система».
 *
 * Не строка целиком: браузер обновляется раз в месяц, и каждая новая версия
 * выглядела бы «новым устройством». Семейство меняется, когда человек сел за
 * другой компьютер или вошёл с телефона, — это и надо заметить. Устройства
 * точнее у нас нет: refresh-токен не хранит ни устройства, ни адреса (см.
 * вкладку «Сесії»), а таблица devices знает только мобильные установки с
 * пушами. Поэтому правило честно называется «новый клиент», а не «новое
 * устройство»: другой браузер на том же ноутбуке тоже сработает.
 */
export function clientFamily(ua: string | null): string {
  if (!ua) return "unknown";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua) && /Version\//.test(ua)
            ? "Safari"
            : /okhttp|Expo|Dalvik|CFNetwork|Darwin/.test(ua)
              ? "app"
              : (ua.split(/[\s/]/)[0] ?? "unknown");
  return os ? `${browser} · ${os}` : browser;
}

const isLogin = (e: JournalEntry) => e.action === "auth.login" && e.outcome === "success" && e.actorId !== null;

/**
 * Вход с нового клиента.
 *
 * `recent` — строки проверяемого окна, `history` — успешные входы тех же
 * людей за последние девяносто дней (может включать и сами recent). Вход
 * считается новым, если у человека до него были входы, и ни один — с тем же
 * семейством клиента. Самый первый вход в жизни учётки новым не считается:
 * иначе каждое заведение сотрудника давало бы срабатывание.
 */
export function newClients(
  recent: readonly JournalEntry[],
  history: readonly JournalEntry[],
): Finding[] {
  const out: Finding[] = [];
  const past = groupBy(history.filter(isLogin), (e) => e.actorId);
  for (const login of [...recent].filter(isLogin).sort(byTime)) {
    const before = (past.get(login.actorId!) ?? []).filter((e) => ms(e.at) < ms(login.at) && e.id !== login.id);
    if (!before.length) continue;
    const family = clientFamily(login.userAgent);
    const known = distinct(before.map((e) => clientFamily(e.userAgent)));
    if (known.includes(family)) continue;
    out.push({
      rule: "newDevice",
      fingerprint: `newDevice:${login.actorId}:${login.id}`,
      actorId: login.actorId,
      actorEmail: login.actorEmail,
      subjectId: null,
      ip: login.ip,
      windowFrom: login.at,
      windowTo: login.at,
      hits: 1,
      details: { client: family, known: known.slice(0, 10), via: (login.details?.via as string | undefined) ?? "password" },
    });
    /* тот же клиент в этом же окне — уже не новый: второй вход не должен давать второго срабатывания */
    past.set(login.actorId!, [...(past.get(login.actorId!) ?? []), login]);
  }
  return out;
}

/** Массовые чтения карт: N разных пациентов за M минут одним сотрудником */
export function massReads(entries: readonly JournalEntry[], cfg: RuleConfig = DEFAULT_CONFIG): Finding[] {
  const out: Finding[] = [];
  for (const [actorId, list] of groupBy(entries.filter(isStaffRead), (e) => e.actorId)) {
    const enough = (x: readonly JournalEntry[]) => distinct(x.map((e) => e.subjectUserId)).length >= cfg.massReadPatients;
    for (const s of series(list, cfg.massReadWindowMin * 60_000, enough)) {
      const first = s[0]!;
      out.push({
        rule: "massReads",
        fingerprint: `massReads:${actorId}:${first.id}`,
        actorId,
        actorEmail: first.actorEmail,
        subjectId: null,
        ip: first.ip,
        windowFrom: first.at,
        windowTo: s[s.length - 1]!.at,
        hits: distinct(s.map((e) => e.subjectUserId)).length,
        details: { reads: s.length, actions: distinct(s.map((e) => e.action)) },
      });
    }
  }
  return out;
}

/** Местные часы и минуты и дата «ночи» в часовом поясе учреждения */
export function localClock(iso: string, timezone: string): { minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { minutes: Number(get("hour")) * 60 + Number(get("minute")), date: `${get("year")}-${get("month")}-${get("day")}` };
}

/** Лежит ли момент вне рабочего дня */
export function isNight(iso: string, cfg: Pick<RuleConfig, "workingDay" | "timezone">): boolean {
  const { minutes } = localClock(iso, cfg.timezone);
  return minutes < toMinutes(cfg.workingDay.from) || minutes >= toMinutes(cfg.workingDay.to);
}

/**
 * Ночная активность: чтения карт и выгрузки с именами вне рабочих часов.
 *
 * Одна ночь — одно срабатывание на сотрудника. «Ночь» датируется вечером,
 * с которого началась: чтение в 02:00 четверга — это ночь среды, и серия,
 * перешедшая через полночь, не рвётся на две.
 */
export function nightActivity(entries: readonly JournalEntry[], cfg: RuleConfig = DEFAULT_CONFIG): Finding[] {
  const dayStart = toMinutes(cfg.workingDay.from);
  const nightOf = (e: JournalEntry): string => {
    const { minutes, date } = localClock(e.at, cfg.timezone);
    if (minutes >= dayStart) return date;
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const relevant = entries.filter(
    (e) => (isStaffRead(e) || (isNamedExport(e) && e.actorId !== null)) && isNight(e.at, cfg),
  );
  const out: Finding[] = [];
  for (const [key, list] of groupBy(relevant, (e) => `${e.actorId}|${nightOf(e)}`)) {
    if (list.length < cfg.nightMinReads) continue;
    const s = [...list].sort(byTime);
    const [actorId, night] = key.split("|") as [string, string];
    const subjects = distinct(s.map((e) => e.subjectUserId));
    out.push({
      rule: "nightActivity",
      fingerprint: `nightActivity:${actorId}:${night}`,
      actorId,
      actorEmail: s[0]!.actorEmail,
      subjectId: subjects.length === 1 ? subjects[0]! : null,
      ip: s[0]!.ip,
      windowFrom: s[0]!.at,
      windowTo: s[s.length - 1]!.at,
      hits: s.length,
      details: { night, patients: subjects.length, actions: distinct(s.map((e) => e.action)), exports: s.filter(isNamedExport).length },
    });
  }
  return out;
}

/** Каждая выгрузка с именами — отдельное срабатывание: их немного, и каждую стоит видеть */
export function namedExports(entries: readonly JournalEntry[]): Finding[] {
  return entries.filter(isNamedExport).map((e) => ({
    rule: "namedExport" as const,
    fingerprint: `namedExport:${e.id}`,
    actorId: e.actorId,
    actorEmail: e.actorEmail,
    subjectId: null,
    ip: e.ip,
    windowFrom: e.at,
    windowTo: e.at,
    hits: Number(e.details?.subjects ?? e.details?.rows ?? 1) || 1,
    details: {
      surveyId: e.resourceId,
      format: e.details?.format ?? null,
      rows: e.details?.rows ?? null,
      subjects: e.details?.subjects ?? null,
    },
  }));
}

/** Каждый вход «от имени» — срабатывание: даже законный, он должен быть на виду */
export function impersonations(entries: readonly JournalEntry[]): Finding[] {
  return entries
    .filter((e) => e.action === "impersonation.start" && e.outcome === "success")
    .map((e) => ({
      rule: "impersonation" as const,
      fingerprint: `impersonation:${e.id}`,
      actorId: e.actorId,
      actorEmail: e.actorEmail,
      subjectId: e.subjectUserId,
      ip: e.ip,
      windowFrom: e.at,
      windowTo: e.at,
      hits: 1,
      details: { reason: e.details?.reason ?? null, session: e.resourceId },
    }));
}

/** Все правила разом — то, что зовёт проверка по расписанию */
export function detectAll(
  entries: readonly JournalEntry[],
  loginHistory: readonly JournalEntry[],
  cfg: RuleConfig = DEFAULT_CONFIG,
): Finding[] {
  return [
    ...failedLoginsByAccount(entries, cfg),
    ...failedLoginsByIp(entries, cfg),
    ...newClients(entries, loginHistory),
    ...massReads(entries, cfg),
    ...nightActivity(entries, cfg),
    ...namedExports(entries),
    ...impersonations(entries),
  ];
}

/** Какие действия читает проверка — чтобы не тянуть весь журнал за сутки */
export const WATCHED_ACTIONS: readonly string[] = [
  "auth.login",
  "auth.login_failed",
  "analytics.export",
  "impersonation.start",
  ...PATIENT_READ_ACTIONS,
];
