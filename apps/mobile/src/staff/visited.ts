import { cache } from "../offline/cache";
import { activeOwner } from "../offline/owner";
import { dayKey, toggleVisited, visitedOn } from "./model";

/*
 * «Відвідано» — отметки сегодняшнего обхода на этом устройстве.
 *
 * Это память обходящего, а не запись в карте пациента: сервер о них не
 * знает, другому специалисту на том же планшете они не видны (ключ под
 * владельцем, offline/cache.ts), на следующий день начинаются заново.
 */

export function visitedToday(now = new Date()): Set<string> {
  return visitedOn(cache.roundsVisited(activeOwner()), dayKey(now));
}

/** Отметить или снять; возвращает отметки после изменения */
export function flipVisited(userId: string, now = new Date()): Set<string> {
  const owner = activeOwner();
  const next = toggleVisited(cache.roundsVisited(owner), dayKey(now), userId);
  cache.saveRoundsVisited(owner, next);
  return new Set(next.ids);
}
