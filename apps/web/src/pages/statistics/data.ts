import { useEffect, useState } from "react";
import type { SurveyFull } from "@quizzy/shared";
import { api } from "../../api";

/**
 * Содержимое методики в той версии, что записана в колонке модели.
 *
 * Нужна до первого расчёта: подписи строк («Варіант результату» — это
 * полоса «Низький», «Текст питання» — «Як ви спите?») берутся из версии, а
 * расчёт присылает их сам, только когда его попросили. Версия — та, что в
 * колонке, а не действующая: идентификаторы полос и вариантов принадлежат
 * версии, и после правки методики действующая их просто не знает.
 *
 * Путь в три шага: действующая версия (частый случай — совпала, готово) →
 * список версий (номер по идентификатору) → содержимое по номеру. Сервер
 * отдаёт версию только по номеру (?version=N), а колонка хранит
 * идентификатор.
 *
 * undefined — ещё грузится, null — сервер отказал (методика вне зоны
 * сотрудника или версии больше нет): экран печатает подписи с кадра, а
 * расчёт скажет причину своим отказом.
 */
export function useSurveyAt(surveyId: string | null, versionId: string | null): SurveyFull | null | undefined {
  const key = surveyId ? `${surveyId}@${versionId ?? ""}` : "";
  const [state, setState] = useState<{ key: string; survey: SurveyFull | null } | null>(null);
  useEffect(() => {
    if (!surveyId) return;
    let live = true;
    const done = (survey: SurveyFull | null) => {
      if (live) setState({ key, survey });
    };
    void (async () => {
      try {
        const current = await api.survey(surveyId);
        if (!versionId || current.versionId === versionId) return done(current);
        const versions = await api.versions(surveyId);
        const at = versions.find((v) => v.id === versionId);
        done(at ? await api.surveyAtVersion(surveyId, at.version) : null);
      } catch {
        done(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [key, surveyId, versionId]);
  if (!surveyId) return null;
  return state?.key === key ? state.survey : undefined;
}

/**
 * Населённые пункты людей в зоне сотрудника — подсказки к полю «Населений
 * пункт».
 *
 * Решение заказчика 2026-09-26: адекватные фильтры. Поле свободное, а
 * сравнение — точное (без учёта регистра): «Київ» против «м. Київ» давало
 * пустую выборку, и экран не говорил почему. Подсказки — штатный datalist:
 * набирать по-прежнему можно что угодно, но записанные названия видны.
 *
 * Источник — список подбора людей (GET /api/cohorts/options): только
 * названия, без чисел. Закрыт он правом «Добору людей»; у кого его нет,
 * тот получает отказ — и поле без подсказок, как раньше, а не ошибку.
 */
export function useLocalityHints(): string[] {
  const [items, setItems] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void localityHints().then((list) => {
      if (live) setItems(list);
    });
    return () => {
      live = false;
    };
  }, []);
  return items;
}

/*
 * Один запрос на страницу, а не на поле: на экране двух выборок полей
 * «Населений пункт» два (и до восьми), а список у них один. Отказ
 * запоминается пустым списком — повторять его на каждой колонке незачем.
 */
let hints: Promise<string[]> | null = null;
function localityHints(): Promise<string[]> {
  hints ??= api
    .cohortOptions()
    .then((o) => o.localities)
    .catch(() => []);
  return hints;
}
