import { useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { Button } from "../ui/primitives";
import { useResource } from "../useResource";

type Status = Awaited<ReturnType<typeof api.consentStatus>>;

/**
 * Информированное согласие в веб-кабинете.
 *
 * Экрана согласия у кабинета не было вовсе — он был только в приложении, и
 * человек, вошедший через браузер, проходил методики, ни разу не увидев
 * текста. С волны 12 сервер принимает ответы только при принятой
 * действующей редакции (routes/responses.ts, assertConsent), и без этого
 * экрана кабинет упирался бы в отказ на каждой сдаче. Поэтому кабинет
 * сначала показывает текст — теми же словами, что приложение (consent.*).
 *
 * Принимается редакция, которую показали: обновился текст, пока человек
 * читал, — сервер отвечает 409, и здесь встаёт новый текст. Отказ выводит из
 * учётной записи, как в приложении: согласие, от которого нельзя отказаться,
 * согласием не является.
 *
 * Без связи статус не узнать — кабинет не запирается: сдачу всё равно
 * проверит сервер.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const { ut } = useLang();
  const { logout } = useAuth();
  // отказ — «не знаю», а не ошибка: без связи кабинет не запирается (см. выше)
  const res = useResource<Status | "unknown">(() => api.consentStatus().catch(() => "unknown" as const), []);
  const status = res.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === null) return null;
  if (status === "unknown" || !status.required || status.accepted) return <>{children}</>;

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="font-display text-section font-medium tracking-tight">{ut("consent.title")}</h1>
      <p className="whitespace-pre-wrap rounded-[5px] border border-hairline p-4 text-body text-text">{status.text}</p>
      <p className="text-small text-muted">{ut("consent.hint")}</p>
      {error ? <p className="text-small text-danger">{error}</p> : null}
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.acceptConsent(status.textId ?? null);
            res.patch({ ...status, accepted: true });
          } catch (e) {
            setError(e instanceof Error ? e.message : ut("common.error"));
            // текст обновился, пока человек читал: встаёт новая редакция, принимать — её
            if (e instanceof ApiError && e.status === 409) res.reload();
          } finally {
            setBusy(false);
          }
        }}
      >
        {ut("consent.accept")}
      </Button>
      <Button variant="quiet" disabled={busy} onClick={logout}>
        {ut("consent.decline")}
      </Button>
    </div>
  );
}
