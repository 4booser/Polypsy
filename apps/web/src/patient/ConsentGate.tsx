import { useState, type ReactNode } from "react";
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
import { useResource } from "../useResource";
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
  /*
   * Статус — через общий слой загрузки (useResource, w13:data): устаревший
   * ответ не встанет, при возврате связи перечитается сам. Отказ сервера не
   * бросается, а превращается в код ответа: «нет связи» и «обслуживание»
   * пропускают экран (consentViewOfLoadError), и отличить их от настоящего
   * отказа можно только по коду.
   */
  const res = useResource<{ status: ConsentStatus } | { code: number | undefined }>(
    () =>
      api
        .consentStatus()
        .then((status) => ({ status }))
        .catch((e: unknown) => ({ code: e instanceof ApiError ? e.status : undefined })),
    [],
  );
  /** Решение на этом экране — принято, отказ — поверх загруженного статуса */
  const [override, setOverride] = useState<ConsentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loaded = res.data;
  const status = loaded && "status" in loaded ? loaded.status : null;
  /** Текст держится и после отказа: «повернутися до тексту» возвращает его, а не грузит заново */
  const text = status?.text?.trim() || null;
  /** Редакция на экране: принимается именно она — сервер сверит с действующей */
  const textId = status?.textId ?? null;
  const view: ConsentView | null =
    override ?? (loaded === null ? null : status ? consentViewOf(status) : consentViewOfLoadError("code" in loaded ? loaded.code : undefined));

  if (view === null) return null;
  if (view.kind === "pass") return <>{children}</>;

  const run: Record<ConsentAction, () => void | Promise<void>> = {
    accept: async () => {
      setBusy(true);
      setError(null);
      try {
        await api.acceptConsent(textId);
        setOverride({ kind: "pass" });
      } catch (e) {
        const failure = acceptFailure(e, ut("common.error"));
        setError(failure.error);
        // текст обновился, пока человек читал: встаёт новая редакция, принимать — её
        if (failure.reread) {
          setOverride(null);
          res.reload();
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
      setOverride({ kind: "declined" });
    },
    retry: () => {
      setError(null);
      setOverride(null);
      res.reload();
    },
    signOut: () => {
      setBusy(true);
      logout();
    },
    reconsider: () => {
      setError(null);
      setOverride(text ? { kind: "read", text } : { kind: "failed" });
    },
  };

  return <ConsentScreen view={view} busy={busy} error={error} onAction={(a) => void run[a]()} />;
}

/**
 * Отказ на «Погоджуюся»: что сказать и перечитывать ли текст.
 *
 * 409 — действующая редакция сменилась, пока человек читал: принимать
 * показанную нельзя, встаёт новая, и сообщение сервера объясняет, почему
 * текст на экране поменялся. Прочие отказы (нет связи, пятисотка) текст не
 * меняют: он остаётся, и «Погоджуюся» можно нажать ещё раз — строка ошибки
 * при этом снимается с началом повтора. Вынесено из обработчика, чтобы
 * переход проверялся без браузера (test/consentGate.test.tsx).
 */
export function acceptFailure(error: unknown, fallback: string): { error: string; reread: boolean } {
  return {
    error: error instanceof Error && error.message ? error.message : fallback,
    reread: error instanceof ApiError && error.status === 409,
  };
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
