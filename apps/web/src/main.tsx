import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth";
import { LangProvider } from "./lang";
import { ToastProvider } from "./ui";
import { installTelemetry } from "./telemetry/client";
import { ErrorBoundary } from "./telemetry/ErrorBoundary";
import "./styles/app.css";

/*
 * Телеметрия — до первой отрисовки: падение при самом первом рендере — тоже
 * падение, и его тоже надо увидеть в техпанели (telemetry/client.ts).
 */
installTelemetry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <LangProvider>
      {/* корневая граница — последний рубеж; экраны консоли и кабинет держат свои (App.tsx) */}
      <ErrorBoundary>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
      </ErrorBoundary>
      </LangProvider>
    </BrowserRouter>
  </StrictMode>,
);
