import {
  TelemetryBuffer,
  clientErrorKey,
  maskText,
  routeTemplate,
  type ClientErrorInput,
} from "@quizzy/shared";

/**
 * Ошибки мобильного приложения — в «Помилки клієнта» техпанели.
 *
 * Решение заказчика 2026-09-26 (участок obs2b): глобальный обработчик
 * ошибок React Native — то, что до сих пор уходило только в красный экран
 * разработчика и в никуда у человека с телефоном. Здесь — перехват поверх
 * штатного обработчика (штатный вызывается всегда: приложение ведёт себя
 * при падении как прежде), склейка повторов, пачка и потолки.
 *
 * Без ПДн: экран — шаблоном маршрута (`/survey/:id`), сообщение и стек —
 * вычищены (maskText из общего пакета, на сервере — ещё раз), из
 * устройства — только «iOS» или «Android» и версия сборки. Отказы API
 * (ApiError с кодом) сюда не идут: на телефоне сеть пропадает в подвале и
 * в транспорте, и это не поломка приложения.
 *
 * Модуль без react-native и expo: всё платформенное приходит зависимостями
 * из app/_layout.tsx, поэтому логика проверяется тестом без устройства
 * (apps/mobile/test/telemetry.test.ts).
 */

export type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

/** То, что даёт глобальный `ErrorUtils` React Native */
export interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(handler: GlobalHandler): void;
}

export interface MobileTelemetryDeps {
  apiUrl: string;
  release?: string;
  /** «iOS» или «Android» — грубо, без версии системы */
  os?: string;
  getToken: () => Promise<string | null>;
  currentRoute: () => string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Ошибка → строка к отправке; null — не наша забота (отказ API) */
export function mobileErrorInput(error: unknown, ctx: { route: string; release?: string; os?: string }): ClientErrorInput | null {
  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") return null;
  let name = "Error";
  let message = "";
  let stack: string | undefined;
  if (error instanceof Error) {
    name = error.name || "Error";
    message = error.message;
    stack = error.stack;
  } else if (typeof error === "string") {
    message = error;
  }
  return {
    platform: "mobile",
    kind: "error",
    name: maskText(name, 80),
    message: maskText(message, 500),
    ...(stack ? { stack: maskText(stack, 4000) } : {}),
    route: routeTemplate(ctx.route),
    ...(ctx.release && /^[\w.+:-]{1,64}$/.test(ctx.release) ? { release: ctx.release } : {}),
    ...(ctx.os ? { os: ctx.os } : {}),
  };
}

export function createMobileTelemetry(deps: MobileTelemetryDeps) {
  const buffer = new TelemetryBuffer<ClientErrorInput>({
    maxBatch: 20,
    maxBuffered: 30,
    /* падающий в цикле экран не должен выжигать трафик человека: шестьдесят за запуск — и тишина */
    sessionCap: 60,
    keyOf: clientErrorKey,
    merge: (kept, next) => ({ ...kept, count: (kept.count ?? 1) + (next.count ?? 1) }),
  });
  /* отправка уже назначена — второй таймер не заводим */
  let scheduled = false;
  const schedule = (ms: number) => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => void flush(), ms);
  };
  const send = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  async function flush(): Promise<void> {
    scheduled = false;
    if (!buffer.size) return;
    const token = await deps.getToken().catch(() => null);
    /* без входа сервер берёт не больше пяти за раз */
    const batch = buffer.take(token ? 20 : 5);
    try {
      await send(`${deps.apiUrl}/api/ops/client-errors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ items: batch }),
      });
    } catch {
      /* нет сети — пачка потеряна; копить ошибки на телефоне без связи незачем */
    }
    if (buffer.size) schedule(10_000);
  }

  function report(error: unknown, isFatal: boolean): void {
    const item = mobileErrorInput(error, { route: deps.currentRoute(), release: deps.release, os: deps.os });
    if (!item || !buffer.add(item)) return;
    /* падение насмерть — отправляем сразу: через три секунды процесса уже не будет */
    if (isFatal) void flush();
    else schedule(3000);
  }

  /** Встать перед штатным обработчиком; вернуть снятие */
  function install(errorUtils: ErrorUtilsLike | undefined): () => void {
    if (!errorUtils) return () => {};
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      try {
        report(error, Boolean(isFatal));
      } catch {
        /* телеметрия не вправе помешать штатной обработке падения */
      }
      previous(error, isFatal);
    });
    return () => errorUtils.setGlobalHandler(previous);
  }

  return {
    report,
    flush,
    install,
    get pending() {
      return buffer.size;
    },
  };
}
