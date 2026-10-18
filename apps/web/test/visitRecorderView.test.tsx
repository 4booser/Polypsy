import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, type UiKey } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { TranscriptBlock, VisitRecorder, type VisitRecording } from "../src/components/VisitRecorder";
import type { RecorderNotice, RecorderPhase } from "../src/components/recorder/model";

/**
 * Панель записи и стенограмма на экране приёма — разметкой, без браузера.
 *
 * Логика микрофона проверяется в visitRecorder.test.ts; здесь — что экран
 * показывает в каждом состоянии и какие кнопки на нём стоят. Главное
 * правило: без согласия на ЭТОТ приём кнопки «Почати запис» нет, а у
 * готовой стенограммы нет ни отзыва, ни удаления (сервер отвечает на них
 * отказом, #103).
 */

const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

const has = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en?: string };
  return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
};

/** Кнопка с этой подписью есть на экране */
const button = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en?: string };
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].some((m) =>
    [e.uk, e.ru, e.en].some((t) => !!t && m[1]!.replace(/<[^>]*>/g, "").trim() === t),
  );
};

type State = NonNullable<VisitRecording["state"]>;

const CONSENT = "2026-10-01T09:00:00.000Z";

function rec(
  state: Partial<State> | null,
  opts: { phase?: RecorderPhase; notice?: RecorderNotice | null; error?: string | null } = {},
): VisitRecording {
  const phase = opts.phase ?? "idle";
  const full: State | null = state
    ? {
        id: "r1",
        status: "ready",
        consentAt: CONSENT,
        consentBySelf: false,
        startedAt: null,
        durationMs: null,
        transcript: null,
        transcriptEngine: null,
        failure: null,
        transcriptionAvailable: true,
        queued: 0,
        ...state,
      }
    : null;
  const live = phase === "live";
  return {
    appointmentId: "a1",
    res: {
      data: full,
      loading: !full && !opts.error,
      refreshing: false,
      error: opts.error ?? null,
      offline: false,
      updatedAt: full ? 1 : null,
      reload: () => {},
      patch: () => {},
    },
    state: full,
    reload: () => {},
    session: {} as VisitRecording["session"],
    view: { phase, notice: opts.notice ?? null, startedAt: live ? CONSENT : null },
    here: phase,
    recordingHere: live,
    elsewhere: full?.status === "recording" && !live,
    elapsed: 75,
  };
}

describe("панель записи приёма", () => {
  test("без согласия на этот приём — вопрос и «з його слів», но не «Почати запис»", () => {
    const html = draw(<VisitRecorder rec={rec({ status: "consent_pending", consentAt: null })} />);
    expect(has(html, "rec.consentAsk")).toBe(true);
    expect(button(html, "rec.consentMark")).toBe(true);
    expect(button(html, "rec.start")).toBe(false);
    expect(button(html, "rec.discard")).toBe(false);
  });

  test("согласие есть — кто и когда его дал; «Почати запис», «Передумав», «Видалити запис»", () => {
    const html = draw(<VisitRecorder rec={rec({})} />);
    expect(has(html, "rec.consentByStaff")).toBe(true);
    expect(button(html, "rec.start")).toBe(true);
    expect(button(html, "rec.consentRevoke")).toBe(true);
    expect(button(html, "rec.discard")).toBe(true);
    expect(button(html, "rec.consentMark")).toBe(false);
  });

  test("пишется здесь — «Іде запис» со временем и «Зупинити»; начинать второй раз нечего", () => {
    const html = draw(<VisitRecorder rec={rec({ status: "recording", startedAt: CONSENT }, { phase: "live" })} />);
    expect(has(html, "rec.recording")).toBe(true);
    expect(html).toContain("1:15");
    expect(button(html, "rec.stop")).toBe(true);
    expect(button(html, "rec.start")).toBe(false);
    expect(button(html, "rec.consentRevoke")).toBe(false);
  });

  test("пишется в другой вкладке — сказано об этом, и остановить можно отсюда", () => {
    const html = draw(<VisitRecorder rec={rec({ status: "recording", startedAt: CONSENT })} />);
    expect(has(html, "rec.elsewhere")).toBe(true);
    expect(button(html, "rec.stop")).toBe(true);
  });

  test("не отправилось — причина словами и «Повторити відправлення»", () => {
    const html = draw(
      <VisitRecorder rec={rec({ status: "recording" }, { phase: "unsent", notice: { kind: "sendFailed", message: "Немає зв’язку" } })} />,
    );
    expect(button(html, "rec.resend")).toBe(true);
    expect(has(html, "rec.sendFailed")).toBe(true);
    expect(html).toContain("Немає зв’язку");
  });

  test("готовая стенограмма — ни отзыва, ни удаления: оба кончились бы отказом сервера", () => {
    const html = draw(<VisitRecorder rec={rec({ status: "done", transcript: "Скарги на сон" })} />);
    expect(button(html, "rec.consentRevoke")).toBe(false);
    expect(button(html, "rec.discard")).toBe(false);
  });

  test("расшифровывать нечем — сказано прямо; отказ расшифровки — с причиной", () => {
    expect(has(draw(<VisitRecorder rec={rec({ transcriptionAvailable: false })} />), "rec.noEngine")).toBe(true);
    const failed = draw(<VisitRecorder rec={rec({ status: "failed", failure: "audio-empty: тиша" })} />);
    expect(has(failed, "rec.failed")).toBe(true);
    expect(has(failed, "rec.fail.silent")).toBe(true);
  });

  test("пока состояния нет — скелет, а не «запису немає»", () => {
    const html = draw(<VisitRecorder rec={rec(null)} />);
    expect(html).toContain('aria-busy="true"');
    expect(has(html, "v2v.recNone")).toBe(false);
  });
});

describe("стенограмма под протоколом", () => {
  test("готова — текст и «Вставити в протокол»; сама она протоколом не становится", () => {
    const html = draw(<TranscriptBlock rec={rec({ status: "done", transcript: "Скарги на сон" })} onInsert={() => {}} />);
    expect(html).toContain("Скарги на сон");
    expect(button(html, "rec.toProtocol")).toBe(true);
    expect(has(html, "rec.transcriptIsNotProtocol")).toBe(true);
  });

  test("ещё нет — что с ней сейчас, по состоянию записи", () => {
    const cases: [Partial<State>, RecorderPhase, UiKey][] = [
      [{ status: "consent_pending", consentAt: null }, "idle", "v2v.trNoConsent"],
      [{}, "idle", "v2v.trNotStarted"],
      [{ status: "recording" }, "live", "v2v.trLive"],
      [{ status: "uploaded" }, "idle", "rec.uploaded"],
      [{ status: "transcribing" }, "idle", "rec.transcribing"],
      [{ status: "discarded" }, "idle", "rec.discarded"],
    ];
    for (const [state, phase, key] of cases) {
      const html = draw(<TranscriptBlock rec={rec(state, { phase })} onInsert={() => {}} />);
      expect(has(html, key), `${state.status ?? "ready"}/${phase}`).toBe(true);
      expect(button(html, "rec.toProtocol")).toBe(false);
    }
  });
});
