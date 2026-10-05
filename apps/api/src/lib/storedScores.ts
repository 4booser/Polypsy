import { bandFor } from "@quizzy/shared";
import type { Scale, ScaleBand, ScoreResult, SurveyFull } from "@quizzy/shared";
import type { responseScores } from "../db/schema";

/**
 * Результат прохождения из сохранённых баллов — один сериализатор на все
 * места, где результат отдаётся не сразу после подсчёта: повтор сдачи по
 * clientRequestId и разбор прохождения (CR-105).
 *
 * Повтор отдавал строки response_scores как есть: без кода и названия
 * шкалы, без kind и correctedScore, с плоскими bandLabel/severity вместо
 * полосы. Экран результата читает scaleTitle и band.label/severity/
 * description — при повторе из офлайн-очереди исчезали имя шкалы и
 * интерпретация, хотя идемпотентность записи работала.
 *
 * Собирается по ВЕРСИИ, КОТОРУЮ ПРОХОДИЛИ (getSurveyForResponse), а не по
 * действующей: названия шкал и ступени полос могли перерисовать после
 * сдачи, и пересчитывать исторический балл по сегодняшней методике нельзя.
 * Сам балл не пересчитывается — числа идут из строки: пол, возраст и нормы
 * в момент подсчёта были такими, какими были.
 */

export type StoredScoreRow = typeof responseScores.$inferSelect;

/** Ступени полос шкалы в порядке «від — до» */
export function ladderOf(scale: Pick<Scale, "bands"> | undefined): ScaleBand[] {
  return [...(scale?.bands ?? [])].sort((a, b) => a.minScore - b.minScore || a.position - b.position);
}

/**
 * Попавшая полоса — тем же сравнением, что движок подсчёта
 * (packages/shared/src/scoring.ts), и только когда полоса при подсчёте
 * вообще нашлась: без неё балл не нормирован и не в тех единицах, в которых
 * заданы ступени. Запасной путь — по сохранённой подписи: она записана в
 * момент подсчёта и надёжнее, чем значение, округлённое иначе.
 */
export function hitBand(ladder: readonly ScaleBand[], row: StoredScoreRow): ScaleBand | undefined {
  if (!row.bandLabel) return undefined;
  return bandFor(ladder, row.value) ?? ladder.find((b) => b.label === row.bandLabel);
}

/**
 * Балл после поправок. У строк до 0118 его нет: при нормировке «raw» итог и
 * есть балл после поправок; иначе ближе всего сырой балл (поправки есть у
 * немногих шкал).
 */
function correctedOf(row: StoredScoreRow): number {
  if (row.correctedScore !== null) return row.correctedScore;
  return row.normalization === "raw" || !row.normalized ? row.value : row.rawScore;
}

export function storedScoreResult(row: StoredScoreRow, scale: Scale | undefined): ScoreResult {
  const ladder = ladderOf(scale);
  const hit = hitBand(ladder, row);
  /*
   * Полоса: подпись и тяжесть — сохранённые (они и были показаны при
   * сдаче); описание, оценка и рекомендация — у ступени той же версии, в
   * которую балл попал. id полосы — её же: ступень найдена в лестнице
   * версии, которую проходили, тем же сравнением, что при подсчёте.
   */
  const band: ScoreResult["band"] = row.bandLabel
    ? {
        id: hit?.id ?? null,
        label: row.bandLabel,
        severity: row.severity ?? hit?.severity ?? "none",
        description: hit?.description ?? null,
        grade: hit?.grade ?? null,
        recommendation: hit?.recommendation ?? null,
      }
    : null;
  /*
   * Нарушен ли порог шкалы достоверности — то же сравнение, что в движке
   * (scoring.ts, гейт достоверности), по сохранённому нормированному
   * значению и порогу версии. Поле есть только у шкал достоверности, как и
   * в первой сдаче.
   */
  const validity =
    scale?.kind === "validity" && scale.validityThreshold !== null && row.normalized
      ? {
          validityFailed:
            scale.validityDirection === "below"
              ? row.value < scale.validityThreshold
              : row.value > scale.validityThreshold,
        }
      : {};
  return {
    scaleId: row.scaleId,
    scaleCode: scale?.code ?? "",
    scaleTitle: scale?.title ?? "",
    kind: scale?.kind ?? "clinical",
    rawScore: row.rawScore,
    correctedScore: correctedOf(row),
    value: row.value,
    normalized: row.normalized,
    normalization: row.normalization,
    maxScore: row.maxScore,
    percent: row.percent,
    band,
    ...validity,
  };
}

/**
 * Все баллы прохождения — в порядке шкал той версии, как их отдаёт первая
 * сдача (движок идёт по survey.scales). У строк в базе порядка нет; шкала,
 * которой в версии не нашлось, — в конец, по id.
 */
export function storedScoreResults(rows: readonly StoredScoreRow[], survey: SurveyFull): ScoreResult[] {
  const byId = new Map(survey.scales.map((s) => [s.id, s]));
  const rank = (row: StoredScoreRow) => byId.get(row.scaleId)?.position ?? Number.MAX_SAFE_INTEGER;
  return [...rows]
    .sort((a, b) => rank(a) - rank(b) || a.scaleId.localeCompare(b.scaleId))
    .map((row) => storedScoreResult(row, byId.get(row.scaleId)));
}
