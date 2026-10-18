import { useCallback, useEffect, useMemo, useState } from "react";
import type { AlertCase, SurveyFull, SurveyListItem } from "@quizzy/shared";
import { api } from "../api/client";

/*
 * Общие чтения экранов сотрудника.
 *
 * Норма разбора — настройка эскалации методики (alertEscalateMinutes): в
 * очереди случаев её нет, а в списке методик есть, и список этот лежит в
 * кэше устройства. Полосы шкал («мінімальна 0–4…») — в содержимом методики,
 * которое тоже кэшируется: карта у койки рисует тяжесть и без сети.
 */

export function useSurveyIndex(): { surveys: Map<string, SurveyListItem>; norm: (surveyId: string) => number | null } {
  const [list, setList] = useState<SurveyListItem[]>([]);
  useEffect(() => {
    let live = true;
    api
      .listSurveys()
      .then((rows) => live && setList(rows ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const surveys = useMemo(() => new Map(list.map((s) => [s.id, s])), [list]);
  const norm = useCallback((id: string) => surveys.get(id)?.alertEscalateMinutes ?? null, [surveys]);
  return { surveys, norm };
}

/** Содержимое методик по списку id — ради полос шкал; не пришло — экран рисует без полос */
export function useSurveyContents(ids: readonly string[]): Map<string, SurveyFull> {
  const key = [...new Set(ids)].sort().join(",");
  const [map, setMap] = useState<Map<string, SurveyFull>>(new Map());
  useEffect(() => {
    if (!key) return;
    let live = true;
    void Promise.all(
      key.split(",").map((id) =>
        api
          .getSurvey(id)
          .then((s) => (s ? ([id, s] as const) : null))
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (!live) return;
      setMap(new Map(pairs.filter((p): p is readonly [string, SurveyFull] => p !== null)));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return map;
}

/**
 * Открытый случай риска человека — для блока «сигнал ризику» на карте.
 * Без сети его не узнать: блока нет, и это честнее старого.
 */
export function useOpenCase(userId: string | undefined): { open: AlertCase | null; reload: () => void } {
  const [open, setOpen] = useState<AlertCase | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    api
      .alertCases({ patient: userId, limit: "1" })
      .then((p) => live && setOpen(p.items[0] ?? null))
      .catch(() => live && setOpen(null));
    return () => {
      live = false;
    };
  }, [userId, tick]);
  return { open, reload: () => setTick((t) => t + 1) };
}

/** «Сейчас», которое идёт: часы разбора на экране не замирают */
export function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}
