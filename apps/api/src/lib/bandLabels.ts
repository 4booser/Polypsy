import { inArray } from "drizzle-orm";
import { t, type Lang, type LocalizedText } from "@quizzy/shared";
import { db } from "../db";
import { scaleBands } from "../db/schema";

/**
 * Подпись полосы — на языке читателя, а не на языке подсчёта.
 *
 * response_scores.band_label — снимок подписи полосы в момент подсчёта: одна
 * строка на том языке, на котором методику загрузили для подсчёта, то есть на
 * языке прохождения (у посева и demo-fill — украинском). Читали снимок как
 * есть, и русская консоль показывала «Помірні порушення» рядом с русским
 * названием шкалы «Нарушения сна» — при том что сами полосы двуязычны
 * (scale_bands.label) и в определении методики языки не перепутаны.
 *
 * Снимок однозначно указывает на свою полосу: шкала принадлежит версии
 * (scale_id меняется с версией), а снимок совпадает с подписью полосы этой
 * шкалы на одном из языков. Отсюда и перевод: найти такую полосу и отдать её
 * подпись на языке читателя. Не нашлась — снимок как есть: чужой язык лучше
 * пустой ячейки, а пустой снимок (полосы нет) остаётся пустым.
 *
 * Сам снимок не переписывается: это запись о том, что показали при сдаче, и
 * язык прохождения хранится отдельно (responses.lang). Отвергнуто: писать в
 * снимок двуязычный объект — колонку читают полтора десятка маршрутов и
 * выгрузки, и каждый из них сломался бы иначе.
 */
export type BandLabelOf = (scaleId: string, stored: string | null) => string | null;

/** Все тексты подписи на всех языках: снимок мог быть записан на любом из них */
function variantsOf(label: unknown): string[] {
  if (typeof label === "string") return [label];
  if (!label || typeof label !== "object") return [];
  return Object.values(label as Record<string, unknown>).filter((v): v is string => typeof v === "string");
}

/**
 * Переводчик снимков для набора шкал — одним запросом к полосам этих шкал.
 *
 * Зовётся там, где баллы отдаются читателю, с языком читателя (langOf). Две
 * полосы одной шкалы с одинаковой подписью на разных языках — случай
 * вырожденный; берётся первая по порядку полос.
 */
export async function bandLabelsIn(lang: Lang, scaleIds: Iterable<string>): Promise<BandLabelOf> {
  const ids = [...new Set(scaleIds)].filter(Boolean);
  if (!ids.length) return (_scaleId, stored) => stored;
  const rows = await db
    .select({ scaleId: scaleBands.scaleId, label: scaleBands.label, position: scaleBands.position })
    .from(scaleBands)
    .where(inArray(scaleBands.scaleId, ids));
  rows.sort((a, b) => a.position - b.position);
  const byScale = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const shown = t(row.label as LocalizedText, lang);
    const known = byScale.get(row.scaleId) ?? new Map<string, string>();
    for (const text of variantsOf(row.label)) if (!known.has(text)) known.set(text, shown);
    byScale.set(row.scaleId, known);
  }
  return (scaleId, stored) => (stored === null ? null : (byScale.get(scaleId)?.get(stored) ?? stored));
}
