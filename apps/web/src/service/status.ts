import { useSyncExternalStore } from "react";
import type { PublicServiceStatus } from "@quizzy/shared";
import { api, MAINTENANCE_EVENT } from "../api";
import { statusPollMs } from "./model";

/**
 * Состояние системы — одно на вкладку, сколько бы баннеров ни было.
 *
 * Баннер стоит в оболочке консоли, в кабинете пациента, на экране входа и
 * в прохождении методики, а страница статуса читает то же самое. Каждый
 * со своим опросом — это четыре запроса на один и тот же ответ; здесь опрос
 * один, пока есть хоть один читатель, и молчит, когда читателей нет.
 */

export interface ServiceSnapshot {
  status: PublicServiceStatus | null;
  /** Сервер не ответил вовсе — это знает клиент, а не сервер */
  unreachable: boolean;
}

let snapshot: ServiceSnapshot = { status: null, unreachable: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

function emit(next: ServiceSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = listeners.size ? setTimeout(() => void refreshServiceStatus(), statusPollMs(snapshot.status)) : null;
}

/** Перечитать сейчас: после действия в техпанели и по отказу 503 */
export function refreshServiceStatus(): Promise<void> {
  inflight ??= api
    .serviceStatus()
    .then((status) => emit({ status, unreachable: false }))
    // прежнее состояние не стираем: «сервер молчит» — не повод забыть, что шли работы
    .catch(() => emit({ status: snapshot.status, unreachable: true }))
    .finally(() => {
      inflight = null;
      schedule();
    });
  return inflight;
}

const onRefusal = () => void refreshServiceStatus();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener(MAINTENANCE_EVENT, onRefusal);
    void refreshServiceStatus();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener(MAINTENANCE_EVENT, onRefusal);
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

const read = () => snapshot;

export function useServiceStatus(): ServiceSnapshot {
  return useSyncExternalStore(subscribe, read, read);
}
