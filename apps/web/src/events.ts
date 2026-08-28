import { useEffect, useRef } from "react";
import { tokenStore } from "./api";

/**
 * Подписка консоли на поток событий сервера.
 *
 * Через fetch, а не через EventSource: EventSource не умеет отправлять
 * заголовки, а токен у нас в Authorization. Класть токен в адрес нельзя —
 * он оседает в логах прокси и в истории браузера.
 *
 * Отказ канала не ломает экраны: они продолжают опрашивать сервер по
 * таймеру, как раньше. Реальное время здесь — ускорение, а не единственный
 * путь доставки.
 */

export type AppEventKind =
  | "alert.created"
  | "case.changed"
  | "response.submitted"
  | "kiosk.progress"
  | "schedule.run";

export interface AppEvent {
  kind: AppEventKind;
  surveyIds: string[] | null;
  userId: string | null;
  at: string;
  severity?: "moderate" | "severe";
  sessionId?: string;
}

type Listener = (event: AppEvent) => void;

const listeners = new Set<Listener>();
let started = false;
let stop: (() => void) | null = null;

export function onAppEvent(listener: Listener): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
      started = false;
    }
  };
}

function start(): void {
  if (started) return;
  started = true;
  void run();
}

async function run(): Promise<void> {
  let attempt = 0;

  while (started) {
    const controller = new AbortController();
    stop = () => controller.abort();
    try {
      const token = tokenStore.get();
      if (!token) return;

      const res = await fetch("/api/events", {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);

      attempt = 0;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";

      while (started) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;

        // сообщения разделены пустой строкой; неполный хвост остаётся в буфере
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          handle(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      /* обрыв — ниже пауза и повтор */
    }

    if (!started) return;
    /*
     * Пауза растёт до полуминуты: если сервер перезапускают, сотня открытых
     * вкладок не должна ломиться в него каждую секунду.
     */
    attempt = Math.min(attempt + 1, 6);
    await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 30_000)));
  }
}

function handle(chunk: string): void {
  const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
  const eventLine = chunk.split("\n").find((l) => l.startsWith("event:"));
  if (!dataLine || !eventLine) return;
  const kind = eventLine.slice(6).trim();
  if (kind === "ping" || kind === "ready") return;
  try {
    const event = JSON.parse(dataLine.slice(5).trim()) as AppEvent;
    for (const l of listeners) l(event);
  } catch {
    /* мусор в канале — не повод падать */
  }
}

/**
 * Перечитать данные экрана, когда сервер сообщил об изменении.
 *
 * Перезагрузка отложена на четверть секунды и склеивается: в киоске десять
 * человек сдают методику почти одновременно, и десять запросов подряд за одним
 * и тем же списком — это хуже, чем поллинг, который они заменяют.
 */
export function useLiveReload(kinds: AppEventKind[], reload: () => void): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const keys = kinds.join(",");

  useEffect(() => {
    const want = new Set(keys.split(","));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onAppEvent((event) => {
      if (!want.has(event.kind)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        reloadRef.current();
      }, 250);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [keys]);
}
