import { eq } from "drizzle-orm";
import { db } from "../db";
import { asSystem } from "../db/context";
import { visitRecordings } from "../db/schema";
import { conflict } from "./http";

/**
 * Запись разговора при переносе приёма к другому специалисту (внешний
 * разбор, #101).
 *
 * Строка visit_recordings хранит specialist_id, и политика строк показывает
 * её пациенту и этому специалисту (0059). Перенос менял specialist_id у
 * приёма, а у записи — нет: новому врачу строка была не видна, второй не
 * завести (одна запись на приём), и recordingFor падал на `rec.id` у
 * undefined — 500 у нового врача на панели и на согласии. Открытой панели до
 * приёма для этого достаточно: строка заводится первым же обращением.
 *
 * Контракт — явный, без обхода политик и без автоматической передачи чужого
 * разговора:
 *
 *   — записи нет или она пустая (consent_pending, ready без материалов,
 *     discarded): принадлежность переходит к новому специалисту вместе с
 *     приёмом. След удаления (discarded_at/discarded_by) остаётся;
 *   — согласие при этом снимается: оно давалось на разговор с прежним
 *     специалистом, и на разговор с новым его спрашивают заново;
 *   — материалы есть (запись идёт, аудио загружено, расшифровывается или
 *     готова, упала с файлом) — это разговор с прежним специалистом, и
 *     приём к другому не отпускается: 409. Сначала удалить запись (до
 *     расшифровки это может любая сторона) либо оставить приём у того, с
 *     кем говорили.
 *
 * Зовётся из переноса после занятия слота и до записи приёма, в той же
 * транзакции; строка берётся под замок, чтобы старт записи, пришедший в ту
 * же секунду, выстроился за переносом и упёрся в снятое согласие. Системной
 * ролью: сотрудник с правом переноса чужих приёмов строку записи под своей
 * ролью не видит.
 */
export type RecordingTransfer = "none" | "moved" | "consent_reset";

/** Состояния, в которых у записи нет материалов разговора */
const EMPTY_STATES: readonly string[] = ["consent_pending", "ready", "discarded"];

export async function transferRecording(appointmentId: string, toSpecialistId: string): Promise<RecordingTransfer> {
  return asSystem(async () => {
    const [rec] = await db
      .select()
      .from(visitRecordings)
      .where(eq(visitRecordings.appointmentId, appointmentId))
      .for("update");
    if (!rec) return "none";
    if (rec.specialistId === toSpecialistId) return "none";

    /*
     * «Готово» с началом и концом — запись, остановленная второй стороной:
     * файл ещё на устройстве прежнего специалиста и будет дослан
     * (takesAudio в routes/recordings.ts). Это тоже материалы разговора.
     */
    const stoppedAwaitingAudio = rec.status === "ready" && !!rec.startedAt && !!rec.endedAt;
    if (!EMPTY_STATES.includes(rec.status) || rec.audioPath || rec.transcriptEnc || stoppedAwaitingAudio) {
      conflict("err.recordingHoldsAppointment");
    }

    const hadConsent = !!rec.consentAt;
    await db
      .update(visitRecordings)
      .set({
        specialistId: toSpecialistId,
        consentAt: null,
        consentBy: null,
        // «готово» держалось на согласии; без него — снова ждём согласия
        ...(rec.status === "ready" ? { status: "consent_pending" as const } : {}),
        startedAt: null,
        endedAt: null,
        durationMs: null,
        uploadId: null,
      })
      .where(eq(visitRecordings.id, rec.id));
    return hadConsent ? "consent_reset" : "moved";
  });
}
