import type { DynamicsPoint, ScaleNormalization } from "./types";

/**
 * Точка динамики на экране пациента: доля для профиля, верх шкалы и подпись
 * значения. Одна запись на консоль (pages/Patients.tsx) и мобилку
 * (analytics/patients/[userId].tsx), чтобы экраны не разошлись снова (#199).
 *
 * `rawScore` точки — вопреки имени значение в единицах нормировки
 * (routes/dynamics.ts кладёт туда score.value: T-балл, стен, доля), а
 * `maxScore` — максимум СЫРОГО балла. Оба экрана делили одно на другое:
 * T-балл 70 при максимуме 16 — 437 %, и радар упирал ось в край; стен 7 при
 * максимуме 57 — 12 %, профиль проседал. Подпись «70 из 16» читалась так же.
 */

type PointUnits = Pick<DynamicsPoint, "rawScore" | "maxScore" | "normalized" | "normalization">;

/** В каких единицах значение точки: ненормированное (нормы для пола нет) — сырой балл */
function unitsOf(p: PointUnits): ScaleNormalization {
  // поля нет у ответа старого сервера и в кэше мобилки — показываем как прежде, сырым
  if (p.normalized === false) return "raw";
  return p.normalization ?? "raw";
}

const num = (v: number) => String(Math.round(v * 100) / 100);

/**
 * Доля от максимума для профиля: сырой балл после поправок против максимума
 * шкалы — это `percent` точки (scoring.ts: correctedScore / maxScore).
 *
 * Именно сырая доля, а не T-балл или стен против своего диапазона: у
 * T-балла верха нет, шкалы одной методики нормируются по-разному (доля,
 * стены, сырые), а ненормированная точка той же шкалы — в сырых баллах.
 * Профиль рисуется на одной оси 0–1, и единица на ней одна для всех осей.
 */
export function pointShare(p: Pick<DynamicsPoint, "percent">): number {
  const share = p.percent / 100;
  return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
}

/**
 * Верх шкалы в единицах значения точки — для оси и подписи «полная шкала».
 * Сырой балл — максимум шкалы, доля — 1, стен — 10. У T-балла верха нет:
 * null, и ось строится по данным.
 */
export function pointValueTop(p: PointUnits): number | null {
  const units = unitsOf(p);
  if (units === "raw") return p.maxScore > 0 ? p.maxScore : null;
  if (units === "ratio") return 1;
  if (units === "sten") return 10;
  return null;
}

export interface PointValueLabels {
  /** «з» в «12 з 27» */
  of: string;
  /** Подписи единиц: norm.raw, norm.tscore, … */
  norm: Record<ScaleNormalization, string>;
}

/**
 * Подпись значения: «12 з 27» у сырого балла, «T-бал 64», «стен 7» у
 * нормированных — так же, как на экране прохождения (response/model.ts).
 * У T-балла и стена «из скольких» нет: «70 з 16» — две единицы в одной строке.
 */
export function pointValueText(p: PointUnits, labels: PointValueLabels): string {
  const units = unitsOf(p);
  if (units === "raw") {
    return p.maxScore > 0 ? `${num(p.rawScore)} ${labels.of} ${num(p.maxScore)}` : num(p.rawScore);
  }
  return `${labels.norm[units]} ${num(p.rawScore)}`;
}
