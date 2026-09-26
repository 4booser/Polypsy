import { useEffect, useSyncExternalStore } from "react";
import type { FeatureFlagKey } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { flagsStale } from "./model";

/**
 * Флаги функций на клиенте: `useFlag("maint.bannerCountdown")`.
 *
 * Ключ типизирован (FeatureFlagKey из packages/shared/src/featureFlags.ts):
 * опечатка — ошибка компиляции, а не флаг, который молча «выключен»
 * навсегда.
 *
 * Кэш на сессию: флаги спрашиваются один раз на человека и перечитываются,
 * когда сменился вошедший (вход, выход, другой человек за тем же
 * компьютером), — и по refreshFlags() после правки в техпанели, чтобы
 * правящий сразу увидел результат у себя. Опроса нет: флаг решает, показать
 * ли новое, и мигать экраном посреди работы ему незачем — остальные увидят
 * изменение со следующего входа или перезагрузки.
 *
 * Не ответил сервер — все флаги выключены: это прежнее поведение, а флаг
 * по построению не открывает ничего, без чего нельзя работать.
 */

interface FlagsState {
  /** Для кого загружено; undefined — ещё ни для кого */
  userId: string | null | undefined;
  flags: ReadonlySet<string>;
}

let state: FlagsState = { userId: undefined, flags: new Set() };
const listeners = new Set<() => void>();
/** Кого ждём: ответ для прежнего человека, пришедший после входа нового, не применяется */
let wanted: string | null | undefined;

function emit(next: FlagsState) {
  state = next;
  for (const l of listeners) l();
}

function load(userId: string | null) {
  wanted = userId;
  if (!userId) {
    emit({ userId: null, flags: new Set() });
    return;
  }
  void api
    .myFlags()
    .then((r) => r.flags)
    .catch(() => [] as FeatureFlagKey[])
    .then((flags) => {
      if (wanted === userId) emit({ userId, flags: new Set(flags) });
    });
}

/** Перечитать флаги текущего человека — после правки в техпанели */
export function refreshFlags(): void {
  if (wanted !== undefined) load(wanted);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => state;

export function useFlag(key: FeatureFlagKey): boolean {
  const { user } = useAuth();
  const id = user?.id ?? null;
  const snap = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (flagsStale(snap.userId, id) && wanted !== id) load(id);
  }, [id, snap.userId]);
  return snap.userId === id && snap.flags.has(key);
}
