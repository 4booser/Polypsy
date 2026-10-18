import type {
  ResponseAttempt,
  ResponseContext,
  ResponseContextSignal,
  ResponseDetail,
  ResponseDetailAnswer,
  ResponseDetailScore,
} from "@quizzy/shared";

/*
 * Модель обстановки вокруг протокола (Polypsy 2.0): что рисует шапка
 * пациента, строка открытого и переключатель попыток над протоколом,
 * графиками и заключением. Данные — из GET /api/response-context/:id и
 * самого прохождения; здесь только чистые функции, их проверяют юнит-тесты.
 */

/**
 * Главная шкала прохождения — та, чьё число стоит в переключателе попыток.
 *
 * Первая содержательная: шкала достоверности (L у СР-45) говорит о бланке, а
 * не о человеке, и «2 → 2 → 2» лжи в переключателе ничего не сообщает.
 */
export function mainScore<T extends Pick<ResponseDetailScore, "kind">>(scores: readonly T[]): T | null {
  return scores.find((s) => s.kind === "clinical") ?? scores[0] ?? null;
}

export interface AttemptChip {
  id: string;
  at: string;
  /** Балл главной шкалы; null — у попытки его нет (подсчёт выключен, другая версия без этой шкалы) */
  value: number | null;
  current: boolean;
}

export interface AttemptNav {
  /** Видимые попытки — не больше `max`, текущая всегда среди них */
  chips: AttemptChip[];
  /** Сколько всего завершённых попыток */
  total: number;
  prev: string | null;
  next: string | null;
}

/**
 * Переключатель попыток: «19 24.08 · 16 11.09 · 14 08.10».
 *
 * Окно — последние `max` попыток, но так, чтобы текущая в него попала: из
 * старого протокола переключатель не должен показывать только свежие.
 * Незавершённое прохождение в ряду завершённых не стоит — переключатель
 * тогда ведёт к ним, а текущей пометки нет.
 */
export function attemptNav(attempts: readonly ResponseAttempt[], currentId: string, code: string | null, max = 4): AttemptNav {
  const all = attempts.map((a) => ({
    id: a.id,
    at: a.submittedAt,
    value: code === null ? null : (a.scores.find((s) => s.code === code)?.value ?? null),
    current: a.id === currentId,
  }));
  const at = all.findIndex((a) => a.current);
  let from = Math.max(0, all.length - max);
  // старый протокол: окно сдвигается к нему — текущая предпоследней, следующая за ней видна
  if (at >= 0 && at < from) from = Math.max(0, at - (max - 2));
  return {
    chips: all.slice(from, from + max),
    total: all.length,
    prev: at > 0 ? all[at - 1]!.id : null,
    next: at >= 0 && at < all.length - 1 ? all[at + 1]!.id : null,
  };
}

/**
 * Попытка, с которой сравниваются ответы по пунктам: предыдущая завершённая
 * той же версии. Другая версия — другие пункты и варианты (у них другие
 * идентификаторы), и сравнивать «пункт 9 с пунктом 9» было бы догадкой.
 */
export function previousComparable(attempts: readonly ResponseAttempt[], currentId: string): ResponseAttempt | null {
  const at = attempts.findIndex((a) => a.id === currentId);
  if (at <= 0) return null;
  const mine = attempts[at]!;
  const prev = attempts[at - 1]!;
  return prev.versionNumber !== null && prev.versionNumber === mine.versionNumber ? prev : null;
}

/** Ответ прежней попытки на тот же пункт: выбранные варианты и балл */
export interface PrevAnswer {
  optionIds: string[];
  score: number | null;
  answered: boolean;
}

export function prevAnswers(prev: ResponseDetail | null): Map<string, PrevAnswer> {
  const out = new Map<string, PrevAnswer>();
  if (!prev) return out;
  for (const a of prev.answers) {
    out.set(a.questionId, { optionIds: a.optionIds ?? [], score: a.score, answered: a.answered });
  }
  return out;
}

/* ─────────── сигналы ─────────── */

export interface SignalStrip {
  /** Неразобранные сигналы этого прохождения — они закрывают подпись заключения */
  openHere: ResponseContextSignal[];
  /** Неразобранные сигналы человека по другим замерам */
  openElsewhere: ResponseContextSignal[];
  /** Разобранные сигналы этого прохождения */
  reviewedHere: ResponseContextSignal[];
  /** Самый старый неразобранный — его таймер и стоит в пилюле */
  oldest: ResponseContextSignal | null;
}

export function signalStrip(signals: readonly ResponseContextSignal[] | null): SignalStrip {
  const list = signals ?? [];
  const open = list.filter((s) => s.reviewedAt === null);
  const oldest = [...open].sort((a, b) => b.minutesOpen - a.minutesOpen)[0] ?? null;
  return {
    openHere: open.filter((s) => s.here),
    openElsewhere: open.filter((s) => !s.here),
    reviewedHere: list.filter((s) => s.here && s.reviewedAt !== null),
    oldest,
  };
}

/**
 * Подпись заключения закрыта, пока не разобран сигнал, поднятый этим самым
 * прохождением: вывод по протоколу с неразобранным риском — вывод без
 * главного. Сигналы других замеров подпись не держат: они ждут разбора в
 * своей очереди, а этот документ — о другом протоколе.
 *
 * Правило экрана, не сервера: сервер подпись по сигналу не закрывает (его
 * правила — завершённое прохождение, сохранённая редакция, сверка версии).
 * Без права разбирать сигналы (signals === null) экрану не из чего судить —
 * и подпись не закрывается.
 */
export function signLockedBySignal(signals: readonly ResponseContextSignal[] | null): boolean {
  return (signals ?? []).some((s) => s.here && s.reviewedAt === null);
}

export interface SignalTimer {
  elapsed: string;
  of: string;
  pct: number;
}

/** «2:48 з 4 год»: сколько висит неразобранным против нормы разбора методики */
export function signalTimer(s: Pick<ResponseContextSignal, "minutesOpen" | "escalateMinutes">, hoursWord: string): SignalTimer | null {
  if (s.escalateMinutes === null || s.escalateMinutes <= 0) return null;
  const h = Math.floor(s.minutesOpen / 60);
  const m = s.minutesOpen % 60;
  const limitH = s.escalateMinutes / 60;
  return {
    elapsed: `${h}:${String(m).padStart(2, "0")}`,
    of: `${Number.isInteger(limitH) ? limitH : limitH.toFixed(1)} ${hoursWord}`,
    pct: Math.min(100, Math.round((s.minutesOpen / s.escalateMinutes) * 100)),
  };
}

/** Адрес разбора: очередь случаев, отобранная по человеку */
export function reviewHref(patientId: string | null | undefined): string {
  return patientId ? `/alerts?patient=${encodeURIComponent(patientId)}` : "/alerts";
}

/* ─────────── история ответа на пункт ─────────── */

export interface FirstChange {
  /** Первый выбранный вариант */
  firstOptionId: string;
  /** Через сколько миллисекунд от первого выбора ответ сменили в последний раз */
  afterMs: number;
}

/**
 * «Спершу «Зовсім ні», змінено через 25 с» — по журналу ответа.
 *
 * Журнал пишет «set» и «change» со значением; первое непустое значение —
 * первый выбор. Если итоговый ответ тот же, что первый (передумал и вернулся),
 * строки нет: менять — не повод для пометки, повод — разница.
 */
export function firstChange(a: Pick<ResponseDetailAnswer, "events" | "optionIds">): FirstChange | null {
  const picks = a.events
    .filter((e) => e.kind === "set" || e.kind === "change")
    .map((e) => ({ id: optionOf(e.value as unknown), ms: e.elapsedMs }))
    .filter((e): e is { id: string; ms: number } => e.id !== null);
  if (picks.length < 2) return null;
  const first = picks[0]!;
  const last = picks[picks.length - 1]!;
  const final = a.optionIds ?? [];
  if (final.length !== 1 || final[0] === first.id) return null;
  return { firstOptionId: first.id, afterMs: Math.max(0, last.ms - first.ms) };
}

/**
 * Значение события — jsonb журнала: список id выбранных вариантов
 * (`["…"]`), у числового пункта — число. Вариантом считается только список
 * из одного id; строка с JSON внутри (старые клиенты) разбирается так же.
 */
function optionOf(raw: unknown): string | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string") return v[0];
  return null;
}

export type { ResponseContext };
