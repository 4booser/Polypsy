import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { api } from "../api/client";

/*
 * Счётчики на вкладках сотрудника: сколько людей ждут разбора сигнала и
 * сколько писем пациентов не прочитано.
 *
 * Сигнал на вкладке — то, ради чего специалист вообще открывает телефон,
 * поэтому счётчик обновляется при каждом возвращении приложения, раз в
 * минуту и сразу после разбора (refreshStaffBadges), а не только когда
 * человек догадается зайти на вкладку.
 */

const listeners = new Set<() => void>();

/** Перечитать счётчики сейчас: разбор сохранён, письмо прочитано */
export function refreshStaffBadges(): void {
  for (const l of listeners) l();
}

export function useStaffBadges(enabled: boolean): { alerts: number; inbox: number } {
  const [alerts, setAlerts] = useState(0);
  const [inbox, setInbox] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => {
      // счётчик открытой очереди — людей, а не сигналов: очередь сгруппирована по человеку
      api
        .alertCases({ limit: "1" })
        .then((p) => live && setAlerts(p.total ?? p.items.length))
        .catch(() => {});
      api
        .threads()
        .then((t) => live && setInbox(t.items.reduce((s, x) => s + (x.unread ?? 0), 0)))
        .catch(() => {});
    };
    load();
    listeners.add(load);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") load();
    });
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      listeners.delete(load);
      sub.remove();
      clearInterval(timer);
    };
  }, [enabled]);

  return { alerts, inbox };
}
