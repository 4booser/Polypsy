import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recordingRevocable, recordingTranscribed, type RecordingStatus } from "@quizzy/shared";
import { recorderButtons, type RecorderPhase, type RecordingFacts } from "../src/components/recorder/model";

/**
 * «Передумав» у готовой стенограммы не предлагается (#103, w19:ui).
 *
 * С волны 18 сервер отзыв согласия у готовой стенограммы отвергает (400
 * err.recordingTranscribed): это решение о записи в карте, а не о
 * разговоре. Экран же кнопку показывал — приложение пациента у любой записи
 * с согласием, — и нажатие всегда кончалось отказом. Проверяется общее
 * правило (packages/shared, recordingRevocable) и то, что им пользуются
 * оба экрана: консоль (recorderButtons) и приложение.
 */

/*
 * Список статусов собирается из Record, а не пишется массивом: новый статус
 * записи потребует здесь строки, и решать, что с ним делать, придётся явно.
 */
const ALL: Record<RecordingStatus, true> = {
  consent_pending: true,
  ready: true,
  recording: true,
  uploaded: true,
  transcribing: true,
  done: true,
  failed: true,
  discarded: true,
};
const STATUSES = Object.keys(ALL) as RecordingStatus[];

const CONSENT = "2026-10-01T09:00:00.000Z";
const rec = (status: RecordingStatus, over: Partial<RecordingFacts> = {}): RecordingFacts => ({
  status,
  consentAt: CONSENT,
  transcript: null,
  ...over,
});

describe("общее правило", () => {
  test("готова — «готово» или текст на руках", () => {
    expect(recordingTranscribed(rec("done"))).toBe(true);
    // специалисту текст приезжает только при «готово», но правило на это не полагается
    expect(recordingTranscribed(rec("failed", { transcript: "Скарги на сон" }))).toBe(true);
    for (const s of STATUSES.filter((x) => x !== "done")) {
      expect(recordingTranscribed(rec(s)), s).toBe(false);
    }
  });

  test("отозвать можно только данное согласие, вне записи и до стенограммы", () => {
    const revocable = STATUSES.filter((s) => recordingRevocable(rec(s)));
    expect(revocable).toEqual(["consent_pending", "ready", "uploaded", "transcribing", "failed", "discarded"]);
    // готовая — нет: ни по статусу, ни по тексту
    expect(recordingRevocable(rec("done"))).toBe(false);
    expect(recordingRevocable(rec("ready", { transcript: "Текст" }))).toBe(false);
    // без согласия отзывать нечего
    expect(recordingRevocable(rec("ready", { consentAt: null }))).toBe(false);
  });

  test("пациенту текст не отдаётся вовсе — готовую он узнаёт по одному статусу", () => {
    expect(recordingRevocable({ status: "done", consentAt: CONSENT, transcript: null })).toBe(false);
    expect(recordingRevocable({ status: "done", consentAt: CONSENT })).toBe(false);
  });
});

describe("консоль: кнопки блока записи", () => {
  const idle: RecorderPhase = "idle";

  test("до записи — «Почати запис» и «Передумав»", () => {
    expect(recorderButtons(rec("ready"), idle)).toEqual({ start: true, revoke: true, discard: true });
  });

  test("готовая стенограмма — ни отзыва, ни удаления: оба кончились бы отказом сервера", () => {
    for (const phase of ["idle", "unsent", "sending"] as const) {
      const b = recorderButtons(rec("done", { transcript: "Скарги на сон" }), phase);
      expect(b.revoke, phase).toBe(false);
      expect(b.discard, phase).toBe(false);
    }
    // текст на руках при ином статусе — то же самое
    const odd = recorderButtons(rec("ready", { transcript: "Скарги на сон" }), idle);
    expect(odd.revoke).toBe(false);
    expect(odd.discard).toBe(false);
  });

  test("пока здесь пишется или уходит — отзыва нет; удаление остаётся", () => {
    for (const phase of ["acquiring", "live", "stopping", "sending", "unsent"] as const) {
      const b = recorderButtons(rec("ready"), phase);
      expect(b.start || b.revoke, phase).toBe(false);
      expect(b.discard, phase).toBe(true);
    }
  });

  test("без согласия — ни одной из трёх; удалённую второй раз не удаляют", () => {
    expect(recorderButtons(rec("consent_pending", { consentAt: null }), idle)).toEqual({
      start: false,
      revoke: false,
      discard: false,
    });
    expect(recorderButtons(rec("discarded"), idle).discard).toBe(false);
  });
});

describe("приложение пациента", () => {
  test("«Передумав» стоит за общим правилом, а вместо неё у готовой — объяснение", () => {
    /*
     * Экран приложения в bun не рисуется (react-native не парсится), поэтому —
     * по исходнику: кнопка отзыва обязана стоять в ветке recordingRevocable,
     * а иначе — строка rec.revokeTooLate. Прежде ветка была «согласие есть».
     */
    const src = readFileSync(resolve(import.meta.dir, "../../mobile/app/(app)/home.tsx"), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const at = src.indexOf("recordingRevocable(state) ?");
    expect(at, "ветка recordingRevocable(state) не найдена — проверка смотрит не туда").toBeGreaterThan(-1);
    const branch = src.slice(at, src.indexOf("rec.consentAsk", at));
    const [yes, no] = branch.split(/\)\s*:\s*\(/);
    expect(yes).toContain('ut("rec.consentRevoke")');
    expect(yes).toContain("api.recordingRevoke(");
    expect(no).toContain('ut("rec.revokeTooLate")');
    // отзыв больше нигде в файле не вызывается
    expect(src.match(/api\.recordingRevoke\(/g)?.length).toBe(1);
  });
});
