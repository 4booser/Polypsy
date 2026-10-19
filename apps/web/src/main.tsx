import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AuthProvider } from "./auth";
import { LangProvider, currentLang } from "./lang";
import { loadLanguage } from "./dictionary";
import { ToastProvider } from "./ui/toast";
import { installTelemetry } from "./telemetry/client";
import { ErrorBoundary } from "./telemetry/ErrorBoundary";
import { queryClient, wireConnection } from "./query";
import "./styles/app.css";

/*
 * Телеметрия — до первой отрисовки: падение при самом первом рендере — тоже
 * падение, и его тоже надо увидеть в техпанели (telemetry/client.ts).
 */
installTelemetry();

/*
 * Связь с сервером — до первой отрисовки: запрос, не дошедший уже при
 * старте (консоль открыли во время перезапуска сервера), должен попасть в
 * общее знание о связи, и по её возвращении всё перечитается само
 * (connection.ts, query.ts).
 */
wireConnection();

/*
 * Словарь выбранного языка — до первой отрисовки (волна 27, perf-bundle).
 *
 * Консоль больше не везёт трёхъязычный словарь в начальном куске: у языка
 * свой кусок, и его выбор известен уже сейчас (currentLang — сохранённый
 * или язык браузера). Сборка ставит этот кусок в предзагрузку прямо из
 * index.html (dictionaryPlugin.ts), так что здесь он обычно уже доехал.
 *
 * Один повтор — на обрыв при старте. Не доехал и со второго раза — консоль
 * всё равно рисуется: прежде такой отказ означал белый лист, а так видна
 * хотя бы полоса связи и кнопки (подписи — ключами), и человек может
 * обновить страницу.
 */
loadLanguage(currentLang)
  .catch(() => loadLanguage(currentLang))
  .catch((error: unknown) => console.error("словарь языка не загрузился", error))
  .finally(render);

function render(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <LangProvider>
        {/* корневая граница — последний рубеж; экраны консоли и кабинет держат свои (App.tsx) */}
        <ErrorBoundary>
        {/*
          Слой загрузки — один на вкладку, над входом: профиль при старте
          тоже грузится через него (auth.tsx). Кабинет пациента — ветка того
          же App, отдельный клиент ему не нужен и только разделил бы кэш.
        */}
        <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
        </QueryClientProvider>
        </ErrorBoundary>
        </LangProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
