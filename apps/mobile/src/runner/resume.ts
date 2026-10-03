import type { SurveyFull } from "@quizzy/shared";
import type { ResumableDraft } from "../offline/cache";

/**
 * В какой версии методики продолжать незавершённое прохождение (волна 16).
 *
 * Внешний разбор, P1: экран открывал методику в действующей версии, а
 * ответы брал из черновика, начатого на прежней. У каждой версии свои
 * пункты с новыми идентификаторами, поэтому такие ответы на экране не видны
 * ни одному вопросу, а автосохранение слало их вместе с новой версией —
 * сервер отвечал 200 и выбрасывал. Человек, вернувшийся к опроснику,
 * получал пустой черновик, а о потере не узнавал никто.
 *
 * Правило: ответы кладутся на экран только в той версии, пункты которой
 * они называют. Черновик на другой версии — открывается его версия (по
 * номеру с сервера или из копии на устройстве, offline/cache.ts). Открыть
 * не удалось (нет сети, версия недоступна) — ответы НЕ переносятся в
 * действующую: переносить нечем, а угадывать соответствие пунктов по
 * порядку или формулировке — значит приписать человеку ответы на вопросы,
 * которых он не видел. Вместо этого экран говорит, что прохождение начато в
 * другой версии, и даёт начать заново — это явное решение человека, и
 * только оно заменяет прежний черновик (replacesVersionId).
 *
 * Проверка идёт по самим пунктам, а не только по id версии: у черновиков до
 * этой правки версии нет, а сервер мог отдать не ту версию. В обоих случаях
 * решает одно: есть ли в показанной версии пункты, на которые даны ответы.
 */
export type Restored =
  /** Черновика нет или он пуст — обычное начало */
  | { kind: "fresh"; survey: SurveyFull }
  /**
   * Продолжаем: survey — версия ответов черновика. keptVersion — это не
   * действующая версия (методику обновили после начала), об этом стоит сказать.
   */
  | { kind: "resumed"; survey: SurveyFull; draft: ResumableDraft; keptVersion: boolean }
  /**
   * Черновик в версии, которую открыть не удалось. На экране — действующая
   * версия без ответов и объяснение; replacesVersionId — какую версию
   * черновика заменит новое начало (null — неизвестна).
   */
  | { kind: "otherVersion"; survey: SurveyFull; draft: ResumableDraft; replacesVersionId: string | null };

/** Все ли ответы — на пункты этой версии */
export function answersFit(survey: SurveyFull, answers: readonly unknown[]): boolean {
  const own = new Set(survey.questions.map((q) => q.id));
  return answers.every((a) => own.has((a as { questionId?: string }).questionId ?? ""));
}

/**
 * Решение о продолжении.
 *
 * shown — методика, как её открыл экран (действующая версия или кэш);
 * openVersion — содержимое версии черновика: по номеру с сервера, без сети —
 * из копии на устройстве. Отказ openVersion — не ошибка экрана, а случай
 * «открыть не удалось».
 */
export async function restoreDraft(
  shown: SurveyFull,
  draft: ResumableDraft | null,
  openVersion: (versionId: string, versionNumber: number | null) => Promise<SurveyFull | null>,
): Promise<Restored> {
  if (!draft || draft.answers.length === 0) return { kind: "fresh", survey: shown };
  const versionId = draft.versionId ?? null;

  if (versionId === null || versionId === shown.versionId) {
    if (answersFit(shown, draft.answers)) return { kind: "resumed", survey: shown, draft, keptVersion: false };
    return { kind: "otherVersion", survey: shown, draft, replacesVersionId: versionId };
  }

  const own = await openVersion(versionId, draft.versionNumber ?? null).catch(() => null);
  if (own && own.versionId === versionId && answersFit(own, draft.answers)) {
    return { kind: "resumed", survey: own, draft, keptVersion: true };
  }
  return { kind: "otherVersion", survey: shown, draft, replacesVersionId: versionId };
}
