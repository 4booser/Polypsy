import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  consentActionsOf,
  consentViewOf,
  consentViewOfLoadError,
  type ConsentAction,
  type ConsentStatus,
  type ConsentView,
  type UiKey,
} from "@quizzy/shared";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { Button, TouchArea } from "../ui/primitives";

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
 * читал, — сервер отвечает 409, и здесь встаёт новый текст.
 *
 * Отказ — не выход. Прежде «Не погоджуюся» здесь просто выводило из учётной
 * записи: сервер об отказе не узнавал (отказавшийся и не дошедший до экрана
 * выглядели одинаково), а человек не узнавал, что из отказа следует, — ту же
 * ошибку приложение исправило в волне 12. Теперь состояния и выходы — общие
 * с приложением (packages/shared/src/consentFlow.ts): отказ записывается на
 * сервере (POST /api/consents/me/decline) и становится своим экраном — что
 * недоступно, как обсудить условия, и два выхода: выйти или вернуться к
 * тексту и передумать. Согласие, от которого нельзя отказаться, согласием не
 * является; отказ, после которого не объяснено, что дальше, — тоже тупик.
 *
 * Без связи (и на время работ сервера) статус не узнать — кабинет не
 * запирается: сдачу всё равно проверит сервер. Другой отказ сервера — «текст
 * не получен», и принимать тогда нечего.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const { ut } = useLang();
  const { logout } = useAuth();
  const [view, setView] = useState<ConsentView | null>(null);
  /** Текст держится и после отказа: «повернутися до тексту» возвращает его, а не грузит заново */
  const [text, setText] = useState<string | null>(null);
  /** Редакция на экране: принимается именно она — сервер сверит с действующей */
  const [textId, setTextId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((status: ConsentStatus) => {
    const next = consentViewOf(status);
    if (next.kind === "read") {
      setText(next.text);
      setTextId(status.textId ?? null);
    }
    setView(next);
  }, []);

  const load = useCallback(() => {
    let alive = true;
    setView(null);
    setError(null);
    api
      .consentStatus()
      .then((s) => alive && show(s))
      .catch((e: unknown) => alive && setView(consentViewOfLoadError(e instanceof ApiError ? e.status : undefined)));
    return () => {
      alive = false;
    };
  }, [show]);

  useEffect(load, [load]);

  if (view === null) return null;
  if (view.kind === "pass") return <>{children}</>;

  const run: Record<ConsentAction, () => void | Promise<void>> = {
    accept: async () => {
      setBusy(true);
      setError(null);
      try {
        await api.acceptConsent(textId);
        setView({ kind: "pass" });
      } catch (e) {
        setError(e instanceof Error ? e.message : ut("common.error"));
        // текст обновился, пока человек читал: встаёт новая редакция, принимать — её
        if (e instanceof ApiError && e.status === 409) {
          const fresh = await api.consentStatus().catch(() => null);
          if (fresh) show(fresh);
        }
      } finally {
        setBusy(false);
      }
    },
    /*
     * Отказ уходит на сервер и сразу показывает, что из него следует.
     * Ответа экран не ждёт, как и в приложении: не дошёл отказ — он всё
     * равно в силе (без принятия кабинет дальше не пустит), а решение
     * человека не должно висеть на медленной связи.
     */
    decline: () => {
      setError(null);
      void api.declineConsent().catch(() => {});
      setView({ kind: "declined" });
    },
    retry: () => {
      load();
    },
    signOut: () => {
      setBusy(true);
      logout();
    },
    reconsider: () => {
      setError(null);
      setView(text ? { kind: "read", text } : { kind: "failed" });
    },
  };

  return <ConsentScreen view={view} busy={busy} error={error} onAction={(a) => void run[a]()} />;
}

/** Подпись и вид кнопки каждого выхода: «согласиться» и «повторить» — главные, остальное тише */
const BUTTON: Record<ConsentAction, { key: UiKey; variant: "primary" | "quiet" }> = {
  accept: { key: "consent.accept", variant: "primary" },
  decline: { key: "consent.decline", variant: "quiet" },
  retry: { key: "common.retry", variant: "primary" },
  signOut: { key: "consent.signOut", variant: "quiet" },
  reconsider: { key: "consent.reconsider", variant: "quiet" },
};

/**
 * Экран согласия в одном из трёх состояний — без загрузки и без сети.
 *
 * Отдельно от ConsentGate, чтобы каждое состояние рисовалось в проверке
 * (apps/web/test/consentGate.test.tsx): кнопки берутся из общей модели
 * (consentActionsOf), и «согласиться» без текста здесь не нарисовать.
 *
 * Весь экран — зона пальца: он открывается в кабинете с телефона, до
 * оболочки кабинета, у которой зона своя (PatientApp.tsx).
 */
export function ConsentScreen({
  view,
  busy,
  error,
  onAction,
}: {
  view: Exclude<ConsentView, { kind: "pass" }>;
  busy: boolean;
  error: string | null;
  onAction: (action: ConsentAction) => void;
}) {
  const { ut } = useLang();
  return (
    <TouchArea className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4">
      {view.kind === "declined" ? (
        <>
          <h1 className="font-display text-section font-medium tracking-tight">{ut("consent.declinedTitle")}</h1>
          <p className="text-body text-text">{ut("consent.declinedWhatWeb")}</p>
          <p className="text-small text-muted">{ut("consent.declinedNext")}</p>
        </>
      ) : (
        <>
          <h1 className="font-display text-section font-medium tracking-tight">{ut("consent.title")}</h1>
          {view.kind === "read" ? (
            <>
              <p className="whitespace-pre-wrap rounded-[5px] border border-hairline p-4 text-body text-text">{view.text}</p>
              {/* последствие отказа — до выбора, а не после */}
              <p className="text-small text-muted">{ut("consent.hint")}</p>
            </>
          ) : (
            <p className="text-body text-muted">{ut("consent.loadFailed")}</p>
          )}
        </>
      )}
      {error ? (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      ) : null}
      {consentActionsOf(view).map((action) => (
        <Button key={action} variant={BUTTON[action].variant} disabled={busy} onClick={() => onAction(action)}>
          {ut(BUTTON[action].key)}
        </Button>
      ))}
    </TouchArea>
  );
}
