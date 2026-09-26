import { useEffect } from "react";
import { AppState } from "react-native";
import { useSegments } from "expo-router";
import { ScreenBatch } from "@quizzy/shared";
import { api } from "../api/client";
import { cache } from "../offline/cache";
import { tokenStorage } from "../storage";
import { templateOfSegments } from "./template";

/**
 * Какие экраны приложения открывают — тем же счётчиком, что у консоли.
 *
 * Шаблон маршрута, а не адрес (template.ts); пачкой раз в минуту и при
 * уходе приложения в фон. Нет сети — пачка пропадает: это счётчик, а не
 * сдача, и копить его в офлайн-очереди рядом с клиническими ответами
 * незачем.
 */
const batch = new ScreenBatch();
const FLUSH_MS = 60_000;

async function flush(): Promise<void> {
  const packs = batch.take();
  if (!packs.length) return;
  // без входа отправлять некуда: сервер ответит отказом, а обмен сессии ради счётчика не нужен
  if (!(await tokenStorage.get().catch(() => null))) return;
  /*
   * Учётке «только просмотр» запись закрыта до маршрута, и каждый отказ
   * пишется в журнал (middleware/auth.ts): строка журнала в минуту от
   * демонстрационной учётки была бы шумом, а не сведением.
   */
  if (cache.me()?.readOnly) return;
  for (const pack of packs) await api.sendScreenViews(pack).catch(() => {});
}

export function useScreenTelemetry(): void {
  const segments = useSegments();
  const key = segments.join("/");

  useEffect(() => {
    const template = templateOfSegments(key ? key.split("/") : []);
    if (template) batch.add("mobile", template);
  }, [key]);

  useEffect(() => {
    const timer = setInterval(() => void flush(), FLUSH_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") void flush();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);
}
