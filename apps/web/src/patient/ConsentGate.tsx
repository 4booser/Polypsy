import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
import { ShellIcon } from "../shell/icons";
import { Callout, Ic } from "../ui";
import { IconTile } from "../ui/layout";
import { Button, TouchArea } from "../ui/primitives";
import { Glyph } from "./icons";
import { Body, Hero, HelpLink, PtPanel } from "./parts";

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
 *
 * Статус спрашивается при открытии кабинета — и заново, когда сервер сказал
 * «нужно согласие» на досылке из очереди (#201, useRecheckConsent): новую
 * редакцию опубликовали, пока вкладка была открыта. Прежде экран открытой
 * вкладки об этом не узнавал, и повтор очереди падал до перезагрузки.
 */
export function ConsentGate({
  children,
  frame = (screen) => screen,
}: {
  children: ReactNode;
  /** Рамка вокруг экрана согласия — кабинет без вкладок (PatientApp, PatientFrame focus) */
  frame?: (screen: ReactNode) => ReactNode;
}) {
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

  /*
   * Перепроверка: решение, принятое на этом экране прежде («pass» поверх
   * статуса), больше не в силе — решает свежий статус. Снимается оно, когда
   * свежий ответ пришёл, а не сразу: иначе до ответа встал бы прежний
   * статус с прежним текстом.
   */
  const reload = res.reload;
  const rechecking = useRef(false);
  const recheck = useCallback(() => {
    rechecking.current = true;
    reload();
  }, [reload]);
  useEffect(() => {
    if (!rechecking.current) return;
    rechecking.current = false;
    setError(null);
    setOverride(null);
  }, [res.updatedAt]);

  const loaded = res.data;
  const status = loaded && "status" in loaded ? loaded.status : null;
  /** Текст держится и после отказа: «повернутися до тексту» возвращает его, а не грузит заново */
  const text = status?.text?.trim() || null;
  /** Редакция на экране: принимается именно она — сервер сверит с действующей */
  const textId = status?.textId ?? null;
  const view: ConsentView | null =
    override ?? (loaded === null ? null : status ? consentViewOf(status) : consentViewOfLoadError("code" in loaded ? loaded.code : undefined));

  if (view === null) return null;
  if (view.kind === "pass") return <RecheckConsent.Provider value={recheck}>{children}</RecheckConsent.Provider>;

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

  return frame(
    <ConsentScreen
      view={view}
      busy={busy}
      error={error}
      version={status?.version ?? null}
      onAction={(a) => void run[a]()}
      aside={<ConsentAside />}
      /* выйти можно и не решая: у текста в модели только «да» и «нет» */
      after={
        view.kind === "read" ? (
          <Button variant="ghost" size="md" icon={<ShellIcon name="log-out" size={18} />} disabled={busy} onClick={() => void run.signOut()}>
            {ut("consent.signOut")}
          </Button>
        ) : null
      }
    />,
  );
}

const RecheckConsent = createContext<() => void>(() => {});

/**
 * Перепроверить согласие из-под ворот: очередь кабинета упёрлась в 403
 * «нужно согласие» (#201). Ворота перечитывают статус и, если редакция
 * новая, встают экраном согласия; после принятия кабинет монтируется снова
 * и досылает очередь — те же ответы (PatientApp.tsx, useOutbox).
 */
export function useRecheckConsent(): () => void {
  return useContext(RecheckConsent);
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

/** Подпись и вид кнопки каждого выхода: «согласиться» и «повторить» — главные, остальное — тонированные */
const BUTTON: Record<ConsentAction, { key: UiKey; variant: "primary" | "secondary"; icon?: ReactNode }> = {
  accept: { key: "consent.accept", variant: "primary", icon: <Ic.check size={18} /> },
  decline: { key: "consent.decline", variant: "secondary" },
  retry: { key: "common.retry", variant: "primary", icon: <Ic.refresh size={18} /> },
  signOut: { key: "consent.signOut", variant: "secondary", icon: <ShellIcon name="log-out" size={18} /> },
  reconsider: { key: "consent.reconsider", variant: "primary", icon: <Ic.undo size={18} /> },
};

/**
 * Абзацы текста согласия. Текст редакции — простой текст, который пишет
 * администратор (Admin, «Текст згоди»): абзацы разделены пустой строкой.
 * Короткая первая строка абзаца без точки в конце — его заголовок, как в
 * печатном бланке; без такой строки абзац просто текст.
 */
export function consentSections(text: string): { title: string | null; body: string }[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [first = "", ...rest] = block.split("\n");
      const heading = rest.length > 0 && first.length <= 60 && !/[.,;:!?…]$/.test(first.trim());
      return heading ? { title: first.trim(), body: rest.join("\n").trim() } : { title: null, body: block };
    });
}

/**
 * Экран согласия в одном из трёх состояний — без загрузки и без сети.
 *
 * Отдельно от ConsentGate, чтобы каждое состояние рисовалось в проверке
 * (apps/web/test/consentGate.test.tsx): кнопки берутся из общей модели
 * (consentActionsOf), и «согласиться» без текста здесь не нарисовать.
 *
 * Вид — pt-consent и pt-consent-declined «Виразної»: текст панелью с
 * заголовками абзацев, последствие отказа — строкой до кнопок, справа — к
 * кому с вопросами и «Допомога» (её отдаёт рамка, `aside`: номер помощи
 * доступен и без согласия). Отказ — отдельной карточкой по центру.
 *
 * Весь экран — зона пальца: он открывается в кабинете с телефона.
 */
export function ConsentScreen({
  view,
  busy,
  error,
  onAction,
  note,
  after,
  aside,
  version,
}: {
  view: Exclude<ConsentView, { kind: "pass" }>;
  busy: boolean;
  error: string | null;
  onAction: (action: ConsentAction) => void;
  /** Строка над экраном — зачем он встал (прохождение, #171: ответы держатся и уйдут после согласия) */
  note?: string;
  /** Выход сверх модели — у прохождения «повернутися до відповідей», у ворот — выход из учётной записи */
  after?: ReactNode;
  /** Колонка сбоку: к кому с вопросами, «Допомога» */
  aside?: ReactNode;
  /** Номер действующей редакции, если известен */
  version?: number | null;
}) {
  const { ut } = useLang();
  const actions = (
    <div data-consent-actions className="mt-6 flex flex-wrap items-center gap-2.5">
      {/* главное решение — первым: в модели порядок смысловой, на экране — по весу кнопки */}
      {[...consentActionsOf(view)]
        .sort((a, b) => Number(BUTTON[b].variant === "primary") - Number(BUTTON[a].variant === "primary"))
        .map((action) => (
        <Button
          key={action}
          size="lg"
          variant={BUTTON[action].variant}
          icon={BUTTON[action].icon}
          disabled={busy}
          onClick={() => onAction(action)}
        >
          {ut(BUTTON[action].key)}
        </Button>
      ))}
      {after ? <span className="ml-auto flex flex-wrap gap-2 max-[600px]:ml-0">{after}</span> : null}
    </div>
  );
  const alert = error ? (
    <div className="mt-4 flex items-start gap-2 text-[15px] font-semibold leading-[22px] text-risk-ink">
      <Ic.circleAlert size={18} className="mt-0.5 shrink-0" />
      <p role="alert" className="m-0">
        {error}
      </p>
    </div>
  ) : null;
  const notice = note ? (
    <Callout kind="info" role="status" icon={<ShellIcon name="file-signature" size={16} />} className="text-[15px] leading-[22px]">
      {note}
    </Callout>
  ) : null;

  if (view.kind === "declined") {
    return (
      <TouchArea className="contents">
        <Body className="max-w-[752px]">
          {notice ? <div className="mb-4">{notice}</div> : null}
          <section className="rounded-panel border border-border bg-panel px-10 pb-[34px] pt-9 shadow-panel max-[600px]:px-5 max-[600px]:pt-6">
            <span
              aria-hidden
              className="grid size-14 place-items-center rounded-[17px] bg-sunk text-text-2 supports-[corner-shape:squircle]:rounded-[22px] supports-[corner-shape:squircle]:[corner-shape:squircle]"
            >
              <Glyph name="file-x" size={26} />
            </span>
            <h1 className="m-0 mt-[18px] text-[32px] font-extrabold leading-[38px] tracking-[-0.03em] max-[600px]:text-[26px] max-[600px]:leading-8">
              {ut("consent.declinedTitle")}
            </h1>
            <p className="m-0 mt-3 text-[17px] leading-[27px] text-text">{ut("consent.declinedWhatWeb")}</p>
            <p className="m-0 mt-2.5 text-[16px] leading-[25px] text-text-2">{ut("consent.declinedNext")}</p>
            {alert}
            {actions}
          </section>
          {aside ? <div className="mt-4 flex flex-col gap-4">{aside}</div> : null}
        </Body>
      </TouchArea>
    );
  }

  if (view.kind === "failed") {
    return (
      <TouchArea className="contents">
        <Hero title={ut("consent.title")} notice={notice} />
        <Body className="max-w-[752px]">
          <section className="rounded-panel border border-border bg-panel px-8 py-7 shadow-panel max-[600px]:px-5">
            <div className="flex items-start gap-3">
              <IconTile icon={<Ic.circleAlert size={18} />} tone="warn" size={40} />
              <p className="m-0 text-[17px] leading-[27px] text-text">{ut("consent.loadFailed")}</p>
            </div>
            {alert}
            {actions}
          </section>
          {aside ? <div className="mt-4 flex flex-col gap-4">{aside}</div> : null}
        </Body>
      </TouchArea>
    );
  }

  const sections = consentSections(view.text);
  return (
    <TouchArea className="contents">
      <Hero title={ut("consent.title")} lead={ut("ptw.consentLead")} notice={notice} />
      <Body>
        <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-5 max-[1099px]:grid-cols-1">
          <div className="min-w-0">
            <PtPanel
              title={ut("ptw.consentText")}
              icon={<ShellIcon name="file-text" size={16} />}
              sub={version ? ut("ptw.consentEdition").replace("{n}", String(version)) : undefined}
            >
              {sections.map((s, i) => (
                <section key={i} className="border-t border-divider py-5 first:border-t-0 first:pt-1 last:pb-1">
                  {s.title ? (
                    <h3 className="m-0 mb-2 text-[18px] font-extrabold leading-6 tracking-[-0.01em] text-text">{s.title}</h3>
                  ) : null}
                  <p className="m-0 max-w-[68ch] whitespace-pre-wrap text-[16.5px] leading-[27px] text-text-2">{s.body}</p>
                </section>
              ))}
            </PtPanel>
            {/* последствие отказа — до выбора, а не после */}
            <p className="m-0 mt-4 flex items-start gap-2 text-[15px] leading-[22px] text-text-2">
              <Ic.info size={16} className="mt-[3px] shrink-0 text-muted" />
              {ut("consent.hint")}
            </p>
            {alert}
            {actions}
          </div>
          {aside ? <div className="flex min-w-0 flex-col gap-4 min-[1100px]:sticky min-[1100px]:top-4">{aside}</div> : null}
        </div>
      </Body>
    </TouchArea>
  );
}

/**
 * Колонка сбоку у экрана согласия: к кому с вопросами по тексту и номер
 * помощи — он доступен и без согласия.
 */
export function ConsentAside() {
  const { ut } = useLang();
  return (
    <>
      <PtPanel title={ut("ptw.consentAsk")} icon={<ShellIcon name="circle-help" size={16} />}>
        <p className="m-0 text-[15.5px] leading-[23px] text-text-2">{ut("ptw.consentAskText")}</p>
      </PtPanel>
      <HelpLink title={ut("ptw.helpHard")} sub={ut("ptw.helpNoConsent")} />
    </>
  );
}
