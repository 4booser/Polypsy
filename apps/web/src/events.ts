import { useEffect, useRef } from "react";
import { api, tokenStore } from "./api";
import { connection } from "./connection";
import { useResource } from "./useResource";

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

/*
 * Договор события общий с сервером, см. packages/shared/src/types.ts.
 *
 * Здесь стояла своя копия, и она отстала: сервер завёл вид «action» на
 * каждое журналируемое изменение, а этот файл о нём не знал — центр событий
 * показывал человеку голое слово «action».
 */
export type { AppEvent, AppEventKind } from "@quizzy/shared";
import type { AppEvent, AppEventKind } from "@quizzy/shared";

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
     * вкладок не должна ломиться в него каждую секунду. Вернулась связь
     * (connection.ts дождался ответа сервера) — пауза обрывается: экраны
     * в этот момент перечитываются сами, и канал событий должен встать
     * вместе с ними, а не через полминуты после.
     */
    attempt = Math.min(attempt + 1, 6);
    await pause(Math.min(1000 * 2 ** attempt, 30_000));
  }
}

/** Пауза, которую обрывает возвращение связи */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const wasOnline = connection.isOnline();
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, ms);
    const off = connection.subscribe(() => {
      if (!wasOnline && connection.isOnline()) done();
    });
  });
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
export function useLiveReload(kinds: AppEventKind[], reload: () => void, enabled = true): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const keys = kinds.join(",");

  useEffect(() => {
    /*
     * Выключено — не подписываемся вовсе: подписка поднимает поток событий,
     * а без входа (или до настройки второго фактора) он получил бы отказ.
     */
    if (!enabled) return;
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
  }, [keys, enabled]);
}

/**
 * «Кто здесь ещё».
 *
 * Пульс раз в двадцать секунд плюс чужие пульсы по каналу. Намеренно мягко:
 * жёсткая блокировка в клинике опаснее конфликта — человек, взявший случай,
 * уходит со смены, и запись остаётся запертой. От потери правок защищает
 * проверка версии при сохранении, а это — только предупреждение.
 */
export function usePresence(resource: string | null): { id: string; name: string }[] {
  /*
   * Кто здесь — загрузкой (волна 13): раньше голый запрос с флагом alive, и
   * ответ о прежней карте, пришедший после перехода к следующей, ложился бы
   * на неё. Отказ — пустой список: присутствие — удобство, его отказ не
   * должен ничего ломать.
   */
  const others = useResource(() => api.presenceOthers(resource!).then((r) => r.others), [resource], {
    enabled: !!resource,
    // чужие на прежней карте — не чужие на этой: пока спрашиваем, никого не показываем
    keep: false,
  });
  const reload = others.reload;

  /*
   * Пульс — действие, а не загрузка: он сообщает серверу «я здесь» и
   * ответа не ждёт. Поэтому остаётся эффектом (белый список сторожа,
   * test/dataLayer.test.ts).
   */
  useEffect(() => {
    if (!resource) return;
    const beat = () => {
      void api.presenceHere(resource).catch(() => {});
    };
    beat();
    const timer = setInterval(beat, 20_000);
    const off = onAppEvent((event) => {
      if (event.kind === "presence.changed" && event.resource === resource) reload();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [resource, reload]);

  return resource ? (others.data ?? []) : [];
}
