import {
  FLAG_BASE_ROLES,
  audienceIsEmpty,
  t,
  type FeatureFlagAudience,
  type FlagAudienceNames,
  type Lang,
  type ReleaseEntry,
  type UiKey,
} from "@quizzy/shared";

/*
 * Техпанель, эксплуатация: решения экранов «Обслуговування», «Прапорці»,
 * «Випуски» без разметки — чтобы их можно было проверить тестом, а не
 * глазами (apps/web/test/opsMaint.test.ts).
 */

/* ─────────── время ─────────── */

/**
 * Поле `datetime-local` → момент с поясом.
 *
 * Поле отдаёт стенное время без пояса («2026-09-26T21:30»), и понимается
 * оно по часам человека, который его набрал. Сервер хранит момент, поэтому
 * перевод — здесь, на машине набравшего: иначе «до 21:30» у разработчика в
 * Лиссабоне означало бы 23:30 в Киеве. Пустое и нечитаемое — null.
 */
export function localInputToIso(value: string): string | null {
  if (!value.trim()) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Сколько проработал выпуск: до смены следующим или до «сейчас» */
export function uptimeMs(entry: Pick<ReleaseEntry, "startedAt" | "endedAt">, now: number): number {
  const end = entry.endedAt ? Date.parse(entry.endedAt) : now;
  return Math.max(0, end - Date.parse(entry.startedAt));
}

/* ─────────── откат ─────────── */

export interface RollbackPlan {
  target: ReleaseEntry;
  /** Миграции, пришедшие после цели: переключением тега они не откатываются */
  left: string[];
  /** Хоть у одного выпуска после цели миграции неизвестны — список неполон */
  unknown: boolean;
}

/**
 * На что откатывать и что останется в базе.
 *
 * Цель — ближайший выпуск с другой версией, чем работающий: после отката
 * и повторной выкатки подряд в истории стоят строки одной версии, и
 * «откатить на то же самое» кнопке предлагать нечего.
 *
 * Остаются миграции всех выпусков новее цели — список свежие сверху, так
 * что это всё, что стоит в списке выше неё. Миграция, пришедшая дважды
 * (выкатили, откатили, выкатили снова), в предупреждении одна.
 */
export function rollbackPlan(items: ReleaseEntry[]): RollbackPlan | null {
  const current = items[0];
  if (!current) return null;
  const at = items.findIndex((r) => r.version !== current.version);
  if (at === -1) return null;
  const newer = items.slice(0, at);
  const left = [...new Set(newer.flatMap((r) => r.migrations ?? []))].sort();
  return { target: items[at]!, left, unknown: newer.some((r) => r.migrations === null) };
}

/* ─────────── частота выкладок (волна 11) ─────────── */

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Понедельник недели момента по часам экрана — «YYYY-MM-DD» (неделя по-украински начинается с понедельника) */
export function weekOf(at: string | number | Date): string {
  const d = new Date(at);
  const back = (d.getDay() + 6) % 7;
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

/**
 * Выкладки по неделям — от недели самой старой строки списка до текущей,
 * не длиннее `maxWeeks`.
 *
 * Неделя без выкладок — ноль и стоит в ряду: пауза в выпусках — такая же
 * часть ответа «как часто выкатываем», как и сами выпуски. Каждая строка —
 * выкладка, включая откат и повторную выкладку той же версии: сервер
 * поднимался, и для частоты это событие. Список сервера ограничен (полсотни
 * последних), поэтому ряд начинается не раньше недели самой старой строки —
 * раньше неё список ничего не знает, и нули там были бы выдумкой.
 */
export function weeklyDeploys(
  items: readonly Pick<ReleaseEntry, "startedAt">[],
  now: number,
  maxWeeks: number,
): { key: string; value: number }[] {
  if (!items.length) return [];
  const current = weekOf(now);
  const oldest = weekOf(Math.min(...items.map((r) => Date.parse(r.startedAt))));
  const weeks: string[] = [];
  /* от текущей недели назад — календарём (−7 дней к дате), не миллисекундами: переход часов не сдвинет понедельник */
  const [y, m, d] = current.split("-").map(Number) as [number, number, number];
  for (let i = 0; i < maxWeeks; i++) {
    const w = ymd(new Date(y, m - 1, d - 7 * i));
    weeks.unshift(w);
    if (w <= oldest) break;
  }
  const idx = new Map(weeks.map((w, i) => [w, i]));
  const out = weeks.map((key) => ({ key, value: 0 }));
  for (const r of items) {
    const i = idx.get(weekOf(r.startedAt));
    if (i !== undefined) out[i]!.value += 1;
  }
  return out;
}

/** Выкладок в неделю в среднем по ряду — одно число рядом с графиком; пусто — null */
export function perWeek(weeks: readonly { value: number }[]): number | null {
  if (!weeks.length) return null;
  return Math.round((weeks.reduce((s, w) => s + w.value, 0) / weeks.length) * 10) / 10;
}

/** Короткий коммит для строки: семь знаков, как пишет git */
export function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/* ─────────── флаги ─────────── */

export type ListField = "staffRoles" | "users" | "surveyGroups" | "departments";

/** Добавить или убрать значение из списка аудитории, не трогая остального */
export function toggleIn(a: FeatureFlagAudience, field: ListField, value: string): FeatureFlagAudience {
  const list = a[field];
  return { ...a, [field]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
}

export function toggleRole(a: FeatureFlagAudience, role: (typeof FLAG_BASE_ROLES)[number]): FeatureFlagAudience {
  return { ...a, roles: a.roles.includes(role) ? a.roles.filter((r) => r !== role) : [...a.roles, role] };
}

/**
 * «Кому включён» — словами для строки списка.
 *
 * Имена вместо идентификаторов: «Олена Іваненко», «МЛО», «Психологічне
 * відділення». Имени не нашлось (учётку закрыли, группу удалили) — остаётся
 * идентификатор: лучше некрасиво, чем молча потерять адресата из виду.
 */
export function audienceParts(
  a: FeatureFlagAudience,
  names: FlagAudienceNames,
  lang: Lang,
  ut: (key: UiKey) => string,
): string[] {
  if (a.all) return [ut("fl.everyone")];
  return [
    ...a.roles.map((r) => ut(`fl.role.${r}`)),
    ...a.staffRoles.map((c) => (names.staffRoles[c] ? t(names.staffRoles[c], lang) : c)),
    ...a.users.map((id) => names.users[id] ?? id),
    ...a.surveyGroups.map((id) => names.surveyGroups[id] ?? id),
    ...a.departments.map((id) => (names.departments[id] ? t(names.departments[id], lang) : id)),
  ];
}

/**
 * Включён, но никому: такое состояние выглядит рабочим, а не делает ничего.
 * Экран предупреждает о нём прямо в форме, до сохранения.
 */
export function enabledForNobody(enabled: boolean, a: FeatureFlagAudience): boolean {
  return enabled && audienceIsEmpty(a);
}
