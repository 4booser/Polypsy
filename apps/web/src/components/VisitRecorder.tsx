import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { day } from "../format";
import { Modal, NotLoaded, useAction } from "../ui";
import { cx } from "../ui/cx";
import { Ic } from "../ui/icons";
import { IconTile, Panel } from "../ui/layout";
import { Button, ErrorText } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { V } from "./recorder/glyphs";
import {
  failureKey,
  pickMimeType,
  recorderButtons,
  RecorderRegistry,
  type RecorderDeps,
  type RecorderLike,
  type RecorderNotice,
} from "./recorder/model";

/**
 * Запись приёма.
 *
 * Самое чувствительное, что есть в системе: не результат методики, а разговор
 * человека о себе целиком. Поэтому здесь ничего не начинается само и ничего
 * не происходит незаметно — в том числе «Почати прийом» запись не включает:
 * её начинают отдельной кнопкой, когда человек согласился.
 *
 * Кнопка «Почати запис» не появляется, пока нет согласия на запись ИМЕННО
 * ЭТОГО приёма. Сервер проверяет то же самое — на спрятанную кнопку здесь
 * полагаться нельзя.
 *
 * Микрофон, рекордер и отправка — в recorder/model.ts: там каждая ветка
 * освобождает микрофон, а аудио живёт до подтверждения сервера (волна 12).
 * Состояние одно на экран (useVisitRecording): панель записи справа и
 * стенограмма под протоколом читают его, а не спрашивают сервер дважды.
 */

/**
 * Сессии записи живут дольше экрана: неотправленная запись не пропадает,
 * когда специалист уходит в карту пациента, а закрытие вкладки с ней
 * спрашивает подтверждения.
 */
const recorders = new RecorderRegistry(typeof window === "undefined" ? null : window);

/** Опрос состояния, пока здесь пишется: остановку или удаление второй стороной надо заметить за секунды */
const LIVE_POLL_MS = 4000;

/** MediaRecorder под интерфейс модели */
function mediaRecorder(stream: MediaStream): RecorderLike {
  const mimeType = pickMimeType((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
  return {
    get mimeType() {
      return rec.mimeType || mimeType || "";
    },
    start(timesliceMs, onChunk) {
      rec.ondataavailable = (e) => onChunk(e.data);
      rec.start(timesliceMs);
    },
    stop() {
      return new Promise<void>((resolve) => {
        if (rec.state === "inactive") {
          resolve();
          return;
        }
        // «stop» приходит после последнего куска; страховка — если событие не придёт вовсе
        const timer = setTimeout(resolve, 3000);
        rec.onstop = () => {
          clearTimeout(timer);
          resolve();
        };
        rec.stop();
      });
    },
  };
}

function browserDeps(appointmentId: string): RecorderDeps<MediaStream> {
  return {
    getMic: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    makeRecorder: mediaRecorder,
    startOnServer: () => api.recordingStart(appointmentId),
    sendAudio: (audio, uploadId) => api.recordingStop(appointmentId, audio, uploadId),
    stopOnServer: () => api.recordingStop(appointmentId, null),
    newId: () => crypto.randomUUID(),
  };
}

/** Состояние записи приёма на экране: сервер, своя сессия микрофона и секундомер */
export function useVisitRecording(appointmentId: string) {
  const session = useMemo(
    () => recorders.session(appointmentId, () => browserDeps(appointmentId)),
    [appointmentId],
  );
  const view = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const here = view.phase;
  const recordingHere = here === "live";

  const res = useResource(() => api.recording(appointmentId), [appointmentId], {
    pollMs: recordingHere ? LIVE_POLL_MS : 0,
  });
  const reload = res.reload;
  const state = res.data;
  const [elapsed, setElapsed] = useState(0);

  /*
   * Уход с экрана: идущая запись останавливается и уходит на сервер, а
   * микрофон освобождается. Прежде рекордер и дорожки никто не
   * останавливал — индикатор исчезал вместе с экраном, а микрофон писал.
   */
  useEffect(() => {
    session.attach();
    return () => {
      void session.leave();
    };
  }, [session]);

  /* ответ опроса: вторая сторона остановила или удалила запись, пока здесь пишется */
  useEffect(() => {
    if (!state || !recordingHere) return;
    void session.remote(state.status, state.startedAt).then((acted) => {
      if (acted) reload();
    });
  }, [state, recordingHere, session, reload]);

  const serverLive = state?.status === "recording";
  const elsewhere = serverLive && !recordingHere;
  const from = recordingHere ? (view.startedAt ?? state?.startedAt) : elsewhere ? state?.startedAt : null;

  /* секундомер: человеку надо видеть, что запись идёт и сколько уже длится */
  useEffect(() => {
    if (!from) return;
    const t0 = new Date(from).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [from]);

  return { appointmentId, res, state, reload, session, view, here, recordingHere, elsewhere, elapsed };
}

export type VisitRecording = ReturnType<typeof useVisitRecording>;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Панель «Запис прийому»: что с записью сейчас, согласие и кнопки хода.
 *
 * Индикатор идущей записи — не украшение: человек напротив должен видеть,
 * что его пишут, не спрашивая. Точка пульсирует, время растёт. Цвет —
 * фиолетовый, а не красный: красный в консоли значит риск для человека.
 */
export function VisitRecorder({ rec }: { rec: VisitRecording }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [asking, setAsking] = useState(false);
  const { appointmentId, state, reload, session, view, here, recordingHere, elsewhere, elapsed } = rec;

  if (!state) {
    return (
      <Panel title={ut("rec.title")} icon={<V.mic />}>
        <NotLoaded res={rec.res} rows={2} />
      </Panel>
    );
  }

  const inFlight = here === "stopping" || here === "sending" || here === "acquiring";
  const buttons = recorderButtons(state, here);
  const live = recordingHere || elsewhere;

  /* заголовок состояния: одно слово о том, что с записью сейчас, и строка под ним */
  let title: string;
  let sub: ReactNode = null;
  if (live) {
    title = ut("rec.recording");
    sub = elsewhere ? ut("rec.elsewhere") : null;
  } else if (here === "acquiring") {
    title = ut("v2v.recAcquiring");
  } else if (here === "stopping" || here === "sending") {
    title = ut("rec.sending");
  } else if (here === "unsent") {
    title = ut("v2v.recUnsent");
  } else if (!state.consentAt) {
    title = ut("v2v.recNone");
    sub = ut("v2v.recNeedConsent");
  } else if (state.status === "discarded") {
    title = ut("rec.discarded");
  } else if (["uploaded", "transcribing", "done", "failed"].includes(state.status)) {
    title = ut("v2v.recRecorded");
    sub =
      state.status === "uploaded"
        ? ut("rec.uploaded")
        : state.status === "transcribing"
          ? ut("rec.transcribing")
          : state.status === "done"
            ? ut("v2v.recTranscribed")
            : ut("rec.failed");
  } else {
    title = ut("v2v.recIdle");
    sub = ut("v2v.recIdleSub");
  }

  return (
    <Panel title={ut("rec.title")} icon={<V.mic />}>
      <div className="flex items-center gap-2.5">
        <span className="relative">
          <IconTile icon={live ? <V.mic /> : <V.micOff />} tone={live ? "violet" : "neutral"} size={40} />
          {live ? (
            <i aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full border-2 border-panel bg-violet" />
          ) : null}
        </span>
        <div className="min-w-0">
          <b className={cx("block text-[14px] font-extrabold leading-[18px]", live ? "text-violet-ink" : "text-text")}>
            {title}
            {live ? <span className="ml-1.5 tabular-nums">{mmss(elapsed)}</span> : null}
          </b>
          {sub ? <small className="block text-caption text-muted">{sub}</small> : null}
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 text-small text-text-2">
        {/* ── согласие ── */}
        {state.consentAt ? (
          <span className="flex items-start gap-1.5">
            <Ic.circleCheck size={14} className="mt-0.5 text-good" />
            <span>
              {ut("v2v.recConsent")
                .replace("{who}", state.consentBySelf ? ut("rec.consentBySelf") : ut("rec.consentByStaff"))
                .replace("{date}", day(state.consentAt))}
            </span>
          </span>
        ) : (
          <span className="flex items-start gap-1.5">
            <Ic.info size={14} className="mt-0.5 text-muted" />
            <span>{ut("rec.consentAsk")}</span>
          </span>
        )}

        {/*
          Если расшифровывать нечем — сказано прямо. Молчание здесь означало
          бы запись, которая «обрабатывается» третью неделю.
        */}
        {!state.transcriptionAvailable && state.status !== "consent_pending" ? (
          <ErrorText tone="warn">{ut("rec.noEngine")}</ErrorText>
        ) : null}
        {state.status === "uploaded" || state.status === "transcribing" ? (
          state.queued > 1 ? (
            <span className="text-muted">
              {ut("rec.queued")} {state.queued}
            </span>
          ) : null
        ) : null}
        {state.status === "failed" ? (
          <ErrorText>
            {ut("rec.failed")}
            {/* код причины — человеческими словами; неизвестное — как есть, для разбора */}
            {state.failure ? `: ${failureKey(state.failure) ? ut(failureKey(state.failure)!) : state.failure}` : ""}
          </ErrorText>
        ) : null}
        {view.notice ? <Notice notice={view.notice} /> : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
        {!state.consentAt ? (
          /*
            Специалист отмечает согласие «с его слов» — это отдельная кнопка
            и отдельная запись в журнале. Пациент, у которого телефон при
            себе, соглашается сам со своего экрана, и тогда основание
            сильнее. Смешивать их в одну кнопку значило бы стереть разницу,
            которая при разборе существенна.
          */
          <Button size="xs" disabled={busy} onClick={() => run(() => api.recordingConsent(appointmentId).then(reload))}>
            {ut("rec.consentMark")}
          </Button>
        ) : null}
        {buttons.start ? (
          <Button size="xs" icon={<V.mic />} disabled={busy} onClick={() => void session.start().then(reload)}>
            {ut("rec.start")}
          </Button>
        ) : null}
        {/* отзыв у готовой стенограммы сервер отвергает (#103) — кнопки нет (recorderButtons) */}
        {buttons.revoke ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => run(() => api.recordingRevoke(appointmentId).then(reload))}
          >
            {ut("rec.consentRevoke")}
          </Button>
        ) : null}
        {recordingHere ? (
          <Button size="xs" icon={<V.square />} onClick={() => void session.stop().then(reload)}>
            {ut("rec.stop")}
          </Button>
        ) : elsewhere ? (
          /*
            Запись идёт не отсюда (другая вкладка, перезагруженная страница).
            Аудио здесь нет, но остановить её вправе и отсюда — сервер
            переведёт её в ожидание аудио от того, кто писал.
          */
          <Button
            size="xs"
            icon={<V.square />}
            disabled={busy}
            onClick={() => run(() => api.recordingStop(appointmentId, null).then(reload))}
          >
            {ut("rec.stop")}
          </Button>
        ) : null}
        {here === "unsent" ? (
          <Button size="xs" onClick={() => void session.send().then(reload)}>
            {ut("rec.resend")}
          </Button>
        ) : null}
        {buttons.discard ? (
          <Button size="xs" variant="ghost" icon={<V.trash />} disabled={busy || inFlight} onClick={() => setAsking(true)}>
            {ut("rec.discard")}
          </Button>
        ) : null}
      </div>

      {asking ? (
        <Modal
          title={ut("rec.discardSure")}
          icon={<V.trash />}
          tone="warn"
          width={460}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setAsking(false);
                  /*
                    Сначала — своё: микрофон и неотправленное аудио стираются в
                    этой вкладке, потом запись удаляется на сервере. Удалённое по
                    просьбе человека не должно дожить даже до повтора отправки.
                  */
                  void run(
                    () => session.abandon().then(() => api.recordingDiscard(appointmentId)).then(reload),
                    ut("rec.discarded"),
                  );
                }}
              >
                {ut("rec.discard")}
              </Button>
              <Button onClick={() => setAsking(false)}>{ut("visit.cancel")}</Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("v2v.recDiscardBody")}</p>
        </Modal>
      ) : null}
    </Panel>
  );
}

/**
 * Стенограма под протоколом: что с ней сейчас и «Вставити в протокол».
 *
 * Сама она в протокол не попадает: стенограмма — это то, что было сказано, а
 * протокол — то, что специалист из этого вынес. Вставка — по нажатию, в
 * конец набранного (visitModel.ts, append).
 */
export function TranscriptBlock({ rec, onInsert }: { rec: VisitRecording; onInsert: (text: string) => void }) {
  const { ut } = useLang();
  const { state, here, recordingHere, elsewhere } = rec;

  let wait: string | null = null;
  if (!state) wait = null;
  else if (state.transcript) wait = null;
  else if (!state.consentAt) wait = ut("v2v.trNoConsent");
  else if (recordingHere || elsewhere) wait = ut("v2v.trLive");
  else if (here === "stopping" || here === "sending" || here === "unsent") wait = ut("rec.sending");
  else if (state.status === "uploaded") wait = ut("rec.uploaded");
  else if (state.status === "transcribing") wait = ut("rec.transcribing");
  else if (state.status === "failed") wait = ut("rec.failed");
  else if (state.status === "discarded") wait = ut("rec.discarded");
  else if (!state.transcriptionAvailable) wait = ut("rec.noEngine");
  else wait = ut("v2v.trNotStarted");

  return (
    <section aria-labelledby="visit-transcript" className="mx-4 mb-4 rounded-panel bg-panel-2 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex min-h-[42px] items-center gap-2 border-b border-divider py-2 pl-3.5 pr-3">
        <V.audioLines size={15} className="text-text-2" />
        <h3 id="visit-transcript" className="m-0 text-small font-bold text-text">
          {ut("v2v.transcript")}
        </h3>
        {state?.transcript ? (
          <Button size="xs" variant="ghost" icon={<Ic.plus />} className="ml-auto" onClick={() => onInsert(state.transcript!)}>
            {ut("rec.toProtocol")}
          </Button>
        ) : null}
      </div>
      {state?.transcript ? (
        <div className="px-3.5 py-3">
          <p className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap text-small text-text">{state.transcript}</p>
          <p className="m-0 mt-2 text-caption text-muted">{ut("rec.transcriptIsNotProtocol")}</p>
        </div>
      ) : (
        <div className="flex items-center gap-3 p-3.5 text-small text-text-2">
          <IconTile icon={<V.hourglass />} tone="neutral" size={28} />
          <span>{wait ?? <span className="text-muted">{ut("common.loading")}</span>}</span>
        </div>
      )}
    </section>
  );
}

/** Сообщение о ходе записи: отказ — словами со значком, «требует действия» — предупреждением, справка — приглушённо */
function Notice({ notice }: { notice: RecorderNotice }) {
  const { ut } = useLang();
  switch (notice.kind) {
    case "micDenied":
      return <ErrorText>{ut("rec.micDenied")}</ErrorText>;
    case "failed":
      return <ErrorText>{notice.message}</ErrorText>;
    case "sendFailed":
      return (
        <ErrorText tone="warn">
          {ut("rec.sendFailed")}. {notice.message}
        </ErrorText>
      );
    case "sendRefused":
      return (
        <ErrorText>
          {ut("rec.sendRefused")}. {notice.message}
        </ErrorText>
      );
    case "stoppedRemotely":
      return <span className="text-muted">{ut("rec.stoppedRemotely")}</span>;
    case "withdrawn":
      return <span className="text-muted">{ut("rec.withdrawn")}</span>;
  }
}
