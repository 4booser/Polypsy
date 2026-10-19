import { useCallback, useEffect, useState } from "react";
import type { AlertCase, SurveyFull } from "@quizzy/shared";
import { isAborted } from "../api/abort";
import { api } from "../api/client";
import { activeOwner } from "../offline/owner";
import { type FillSubject, knownSubject, type PersonHead, heads, personHead } from "./people";

/*
 * Общие чтения экранов сотрудника.
 *
 * Норма разбора — настройка эскалации методики — приходит с самим случаем
 * (AlertCase.escalateMinutes, staff/model.ts normOf). Здесь стоял хук,
 * который ради неё грузил весь список методик на каждом экране сотрудника
 * и на каждой открытой карте. Полосы шкал («мінімальна 0–4…») — в
 * содержимом методики, которое кэшируется: карта у койки рисует тяжесть и
 * без сети.
 *
 * Чтения отменяются, когда экран размонтирован (api/abort.ts): карта,
 * которую закрыли, не держит соединений и не принимает ответов.
 */

/** Содержимое методик по списку id — ради полос шкал; не пришло — экран рисует без полос */
export function useSurveyContents(ids: readonly string[]): Map<string, SurveyFull> {
  const key = [...new Set(ids)].sort().join(",");
  const [map, setMap] = useState<Map<string, SurveyFull>>(new Map());
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    void Promise.all(
      key.split(",").map((id) =>
        api
          .getSurvey(id, { signal: ctrl.signal })
          .then((s) => (s ? ([id, s] as const) : null))
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (ctrl.signal.aborted) return;
      setMap(new Map(pairs.filter((p): p is readonly [string, SurveyFull] => p !== null)));
    });
    return () => ctrl.abort();
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
    const ctrl = new AbortController();
    api
      .alertCases({ patient: userId, limit: "1" }, { signal: ctrl.signal })
      .then((p) => setOpen(p.items[0] ?? null))
      .catch((e) => {
        if (!isAborted(e)) setOpen(null);
      });
    return () => ctrl.abort();
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

/**
 * Шапка человека, пока его карта грузится (staff/people.ts): имя из строки,
 * на которую нажали, из снимка обхода или карты у койки — сразу, без запроса.
 */
export function usePersonHead(userId: string | undefined): PersonHead | null {
  const [head] = useState(() => personHead(activeOwner(), userId));
  return head;
}

/**
 * За кого заполняют методику (режим обхода, survey/[id].tsx).
 *
 * Сначала — то, что уже на устройстве: карта, прочитанная в этой сессии,
 * или карта у койки (staff/people.ts, knownSubject). Тогда запроса нет
 * вовсе. Прежде экран перечитывал всю историю замеров человека ради имени,
 * пола и возраста — уже известных карте, с которой на него пришли.
 *
 * Нет — читается динамика, суженная до этой методики: в ответе та же шапка
 * человека, а сервер не считает остальные методики (routes/dynamics.ts,
 * ?survey=). Пока ответ идёт — «loading», и «Почати» ждёт: начать за
 * человека, которого не видно, — значит не заметить, если перепутали.
 */
export type FillState =
  | { kind: "known"; person: FillSubject }
  | { kind: "loading"; head: PersonHead | null }
  | { kind: "failed"; head: PersonHead | null; message: string | null };

export function useFillSubject(userId: string | undefined, surveyId: string | undefined): { state: FillState | null; retry: () => void } {
  const owner = activeOwner();
  const initial = (): FillState | null => {
    if (!userId) return null;
    const known = knownSubject(owner, userId);
    return known ? { kind: "known", person: known } : { kind: "loading", head: personHead(owner, userId) };
  };
  const [state, setState] = useState<FillState | null>(initial);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!userId) {
      setState(null);
      return;
    }
    const known = knownSubject(owner, userId);
    if (known) {
      setState({ kind: "known", person: known });
      return;
    }
    const head = personHead(owner, userId);
    setState({ kind: "loading", head });
    const ctrl = new AbortController();
    api
      .respondentDynamics(userId, { survey: surveyId, signal: ctrl.signal })
      .then((d) => {
        const person = { fullName: d.fullName, sex: d.sex, age: d.age };
        heads.noteCard(owner, userId, person);
        setState({ kind: "known", person });
      })
      .catch((e) => {
        if (isAborted(e)) return;
        setState({ kind: "failed", head, message: e instanceof Error ? e.message : null });
      });
    return () => ctrl.abort();
  }, [owner, userId, surveyId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
