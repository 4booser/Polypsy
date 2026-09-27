import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { useAction } from "../ui";
import { Panel } from "../ui/layout";
import { Button, Num } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import {
  failureKey,
  pickMimeType,
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
 * не происходит незаметно.
 *
 * Кнопка «Начать» не появляется, пока нет согласия на запись ИМЕННО ЭТОГО
 * приёма. Сервер проверяет то же самое — на спрятанную кнопку здесь
 * полагаться нельзя.
 *
 * Микрофон, рекордер и отправка — в recorder/model.ts: там каждая ветка
 * освобождает микрофон, а аудио живёт до подтверждения сервера (волна 12).
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

export function VisitRecorder({ appointmentId, onTranscript }: {
  appointmentId: string;
  onTranscript: (text: string) => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
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

  if (!state) return null;

  const idle = here === "idle";
  const inFlight = here === "stopping" || here === "sending" || here === "acquiring";

  return (
    <Panel title={ut("rec.title")}>
      <div className="flex flex-col gap-2 p-4">
        {/* ── согласие ── */}
        {!state.consentAt ? (
          <>
            <p className="text-caption text-muted">{ut("rec.consentAsk")}</p>
            {/*
              Специалист отмечает согласие «с его слов» — это отдельная кнопка
              и отдельная запись в журнале. Пациент, у которого телефон при
              себе, соглашается сам со своего экрана, и тогда основание
              сильнее. Смешивать их в одну кнопку значило бы стереть разницу,
              которая при разборе существенна.
            */}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => run(() => api.recordingConsent(appointmentId).then(reload))}
            >
              {ut("rec.consentMark")}
            </Button>
          </>
        ) : (
          <p className="text-caption text-muted">
            {state.consentBySelf ? ut("rec.consentBySelf") : ut("rec.consentByStaff")}
          </p>
        )}

        {view.notice ? <Notice notice={view.notice} /> : null}

        {/* ── ход записи ── */}
        {state.consentAt && idle && ["ready", "consent_pending"].includes(state.status) ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void session.start().then(reload)}>
              {ut("rec.start")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => run(() => api.recordingRevoke(appointmentId).then(reload))}
            >
              {ut("rec.consentRevoke")}
            </Button>
          </div>
        ) : null}

        {recordingHere || elsewhere ? (
          <div className="flex items-center gap-3">
            {/*
              Индикатор — не украшение: человек напротив должен видеть, что
              запись идёт, не спрашивая. Точка мигает, время растёт. Цвет —
              токеном danger: прежний bg-bad не существовал в теме, и точка
              была невидимой.
            */}
            <span className="inline-block size-2 animate-pulse rounded-full bg-danger" />
            <span className="text-caption">{ut("rec.recording")}</span>
            <Num className="text-caption text-muted">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </Num>
            {recordingHere ? (
              <Button size="sm" className="ml-auto" onClick={() => void session.stop().then(reload)}>
                {ut("rec.stop")}
              </Button>
            ) : (
              /*
                Запись идёт не отсюда (другая вкладка, перезагруженная
                страница). Аудио здесь нет, но остановить её вправе и
                отсюда — сервер переведёт её в ожидание аудио от того, кто
                писал.
              */
              <Button
                size="sm"
                className="ml-auto"
                disabled={busy}
                onClick={() => run(() => api.recordingStop(appointmentId, null).then(reload))}
              >
                {ut("rec.stop")}
              </Button>
            )}
          </div>
        ) : null}
        {elsewhere ? <p className="text-caption text-muted">{ut("rec.elsewhere")}</p> : null}

        {/* ── неотправленное ── */}
        {inFlight && here !== "acquiring" ? <p className="text-caption text-muted">{ut("rec.sending")}</p> : null}
        {here === "unsent" ? (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void session.send().then(reload)}>
              {ut("rec.resend")}
            </Button>
          </div>
        ) : null}

        {/* ── после записи ── */}
        {state.status === "uploaded" || state.status === "transcribing" ? (
          <p className="text-caption text-muted">
            {state.status === "uploaded" ? ut("rec.uploaded") : ut("rec.transcribing")}
            {state.queued > 1 ? ` · ${ut("rec.queued")} ${state.queued}` : ""}
          </p>
        ) : null}

        {/*
          Если расшифровывать нечем — сказано прямо. Молчание здесь означало
          бы запись, которая «обрабатывается» третью неделю.
        */}
        {!state.transcriptionAvailable && state.status !== "consent_pending" ? (
          <p className="text-caption text-accent">{ut("rec.noEngine")}</p>
        ) : null}

        {state.status === "failed" ? (
          <p className="text-caption text-danger">
            {ut("rec.failed")}
            {/* код причины — человеческими словами; неизвестное — как есть, для разбора */}
            {state.failure ? `: ${failureKey(state.failure) ? ut(failureKey(state.failure)!) : state.failure}` : ""}
          </p>
        ) : null}

        {state.transcript ? (
          <>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-hairline p-2 text-caption">
              {state.transcript}
            </p>
            <p className="text-caption text-muted">{ut("rec.transcriptIsNotProtocol")}</p>
            <Button size="sm" variant="ghost" onClick={() => onTranscript(state.transcript!)}>
              {ut("rec.toProtocol")}
            </Button>
          </>
        ) : null}

        {state.status !== "done" && state.status !== "discarded" && state.consentAt ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || inFlight}
            onClick={() => {
              if (!window.confirm(ut("rec.discardSure"))) return;
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
        ) : null}
      </div>
    </Panel>
  );
}

/** Сообщение о ходе записи: отказ — danger, «требует действия» — accent, справка — muted */
function Notice({ notice }: { notice: RecorderNotice }) {
  const { ut } = useLang();
  switch (notice.kind) {
    case "micDenied":
      return <p className="text-caption text-danger">{ut("rec.micDenied")}</p>;
    case "failed":
      return <p className="text-caption text-danger">{notice.message}</p>;
    case "sendFailed":
      return (
        <p className="text-caption text-accent">
          {ut("rec.sendFailed")} · {notice.message}
        </p>
      );
    case "sendRefused":
      return (
        <p className="text-caption text-danger">
          {ut("rec.sendRefused")} · {notice.message}
        </p>
      );
    case "stoppedRemotely":
      return <p className="text-caption text-muted">{ut("rec.stoppedRemotely")}</p>;
    case "withdrawn":
      return <p className="text-caption text-muted">{ut("rec.withdrawn")}</p>;
  }
}
