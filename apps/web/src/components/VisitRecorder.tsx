import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAction } from "../ui";
import { Panel } from "../ui/layout";
import { Button, Num } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

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
 */
export function VisitRecorder({ appointmentId, onTranscript }: {
  appointmentId: string;
  onTranscript: (text: string) => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.recording(appointmentId), [appointmentId]);
  const reload = res.reload;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  const state = res.data;
  const live = state?.status === "recording";

  /* секундомер: человеку надо видеть, что запись идёт и сколько уже длится */
  useEffect(() => {
    if (!live || !state?.startedAt) return;
    const from = new Date(state.startedAt).getTime();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - from) / 1000)), 1000);
    return () => clearInterval(id);
  }, [live, state?.startedAt]);

  const start = useCallback(async () => {
    setMicError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicError(ut("rec.micDenied"));
      return;
    }
    await api.recordingStart(appointmentId);
    chunksRef.current = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.start(5000);
    recorderRef.current = rec;
    await reload();
  }, [appointmentId, reload, ut]);

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
      rec.stream.getTracks().forEach((t) => t.stop());
    }
    const blob = chunksRef.current.length ? new Blob(chunksRef.current, { type: "audio/webm" }) : null;
    recorderRef.current = null;
    chunksRef.current = [];
    await api.recordingStop(appointmentId, blob);
    await reload();
  }, [appointmentId, reload]);

  if (!state) return null;

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

        {micError ? <p className="text-caption text-bad">{micError}</p> : null}

        {/* ── ход записи ── */}
        {state.consentAt && !live && ["ready", "consent_pending"].includes(state.status) ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void start()}>
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

        {live ? (
          <div className="flex items-center gap-3">
            {/*
              Индикатор — не украшение: человек напротив должен видеть, что
              запись идёт, не спрашивая. Точка мигает, время растёт.
            */}
            <span className="inline-block size-2 animate-pulse rounded-full bg-bad" />
            <span className="text-caption">{ut("rec.recording")}</span>
            <Num className="text-caption text-muted">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </Num>
            <Button size="sm" className="ml-auto" disabled={busy} onClick={() => void stop()}>
              {ut("rec.stop")}
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
          <p className="text-caption text-bad">
            {ut("rec.failed")}
            {state.failure ? `: ${state.failure}` : ""}
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
            disabled={busy}
            onClick={() => {
              if (!window.confirm(ut("rec.discardSure"))) return;
              void run(() => api.recordingDiscard(appointmentId).then(reload), ut("rec.discarded"));
            }}
          >
            {ut("rec.discard")}
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}
