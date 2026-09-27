import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AuthProvider } from "./auth";
import { LangProvider } from "./lang";
import { ToastProvider } from "./ui";
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
