import { inArray } from "drizzle-orm";
import { t, type Lang, type LocalizedText } from "@quizzy/shared";
import { db } from "../db";
import { options, questions, scaleBands, scales } from "../db/schema";

/**
 * Подпись сигнала риска — на языке читателя, а не на языке прохождения.
 *
 * risk_alerts.label — снимок, собранный в момент срабатывания из методики,
 * загруженной на языке прохождения (packages/shared/src/risk.ts): подпись
 * риска варианта («СР-45, пункт 40: ствердна відповідь…»), «пункт — вариант»,
 * подпись числового порога или «шкала: полоса». У посева и у большинства
 * пациентов это украинский, и русская консоль показывала украинскую подпись в
 * очереди случаев, в «Дія зараз», на зведенні, в баннере заключения и в ящике
 * разбора — при том что в методике подписи двуязычны.
 *
 * Снимок однозначно указывает на свой источник: тревога несёт пункт или шкалу
 * той версии, что человек видел (у версии свои строки questions/options/
 * scales), а сам снимок совпадает с одним из вариантов, собранных из их
 * двуязычных текстов по тем же правилам, что и при срабатывании. Отсюда и
 * перевод: найти совпадение и отдать тот же вариант на языке читателя. Не
 * нашлось (давние строки, методика с тех пор правилась, подпись собрана
 * иначе) — снимок как есть: чужой язык лучше пустой строки. Тот же приём,
 * что у слова полосы (lib/bandLabels.ts).
 *
 * Снимок не переписывается: это запись о том, что подняло тревогу. Отвергнуто:
 * хранить в label двуязычный объект — колонку читают маршруты, выгрузки,
 * уведомления и мобилка, и каждый сломался бы по-своему; новой колонке пришлось
 * бы заполнять задним числом те же строки тем же сопоставлением.
 */
export type AlertLabelOf = (alert: { questionId: string | null; scaleId: string | null; label: string }) => string;

/** Все тексты на всех языках: снимок мог быть записан на любом из них */
function variantsOf(text: unknown): string[] {
  if (typeof text === "string") return text ? [text] : [];
  if (!text || typeof text !== "object") return [];
  return [...new Set(Object.values(text as Record<string, unknown>).filter((v): v is string => typeof v === "string" && v !== ""))];
}

/** Запомнить вариант, не перетирая первый: при совпадении текстов выигрывает более раннее правило */
function remember(map: Map<string, string>, stored: string, shown: string) {
  if (stored && shown && !map.has(stored)) map.set(stored, shown);
}

/**
 * Переводчик подписей для набора тревог — четырьмя запросами на весь набор,
 * а не на тревогу. Зовётся там, где подписи отдаются читателю, с языком
 * читателя (langOf).
 */
export async function alertLabelsIn(
  lang: Lang,
  alerts: Iterable<{ questionId: string | null; scaleId: string | null }>,
): Promise<AlertLabelOf> {
  const list = [...alerts];
  const questionIds = [...new Set(list.map((a) => a.questionId).filter((x): x is string => !!x))];
  const scaleIds = [...new Set(list.map((a) => a.scaleId).filter((x): x is string => !!x))];
  if (!questionIds.length && !scaleIds.length) return (a) => a.label;

  const [questionRows, optionRows, scaleRows, bandRows] = await Promise.all([
    questionIds.length
      ? db
          .select({ id: questions.id, title: questions.title, riskLabel: questions.riskLabel })
          .from(questions)
          .where(inArray(questions.id, questionIds))
      : [],
    questionIds.length
      ? db
          .select({ questionId: options.questionId, text: options.text, riskLabel: options.riskLabel, riskFlag: options.riskFlag })
          .from(options)
          .where(inArray(options.questionId, questionIds))
      : [],
    scaleIds.length ? db.select({ id: scales.id, title: scales.title }).from(scales).where(inArray(scales.id, scaleIds)) : [],
    scaleIds.length
      ? db
          .select({ scaleId: scaleBands.scaleId, label: scaleBands.label, position: scaleBands.position })
          .from(scaleBands)
          .where(inArray(scaleBands.scaleId, scaleIds))
      : [],
  ]);

  /* по пункту: точные совпадения и заголовки — для подписи числового порога «пункт: 9» */
  const byQuestion = new Map<string, { exact: Map<string, string>; titles: { stored: string; shown: string }[] }>();
  for (const q of questionRows) {
    const exact = new Map<string, string>();
    const title = t(q.title as LocalizedText, lang);
    // подпись риска варианта — первой: её задаёт методика, и чаще всего срабатывает она
    for (const o of optionRows.filter((x) => x.questionId === q.id)) {
      if (o.riskLabel) for (const v of variantsOf(o.riskLabel)) remember(exact, v, t(o.riskLabel as LocalizedText, lang));
    }
    // «пункт — вариант» — когда подписи у варианта нет (тексты одного прохождения — на одном языке, но берём все пары)
    for (const o of optionRows.filter((x) => x.questionId === q.id && x.riskFlag)) {
      const text = t(o.text as LocalizedText, lang);
      for (const tv of variantsOf(q.title)) for (const ov of variantsOf(o.text)) remember(exact, `${tv} — ${ov}`, `${title} — ${text}`);
    }
    if (q.riskLabel) for (const v of variantsOf(q.riskLabel)) remember(exact, v, t(q.riskLabel as LocalizedText, lang));
    // посев пишет заголовок пункта как есть, когда подписи у варианта нет (seed.ts)
    for (const v of variantsOf(q.title)) remember(exact, v, title);
    byQuestion.set(q.id, { exact, titles: variantsOf(q.title).map((stored) => ({ stored, shown: title })) });
  }

  /* по шкале: «шкала: полоса» во всех сочетаниях языков */
  const byScale = new Map<string, Map<string, string>>();
  bandRows.sort((a, b) => a.position - b.position);
  for (const sc of scaleRows) {
    const exact = new Map<string, string>();
    const title = t(sc.title as LocalizedText, lang);
    for (const b of bandRows.filter((x) => x.scaleId === sc.id)) {
      const band = t(b.label as LocalizedText, lang);
      for (const tv of variantsOf(sc.title)) for (const bv of variantsOf(b.label)) remember(exact, `${tv}: ${bv}`.trim(), `${title}: ${band}`.trim());
    }
    byScale.set(sc.id, exact);
  }

  return (a) => {
    if (a.questionId) {
      const q = byQuestion.get(a.questionId);
      const hit = q?.exact.get(a.label);
      if (hit) return hit;
      // числовой порог без подписи: «Заголовок пункта: 9» — число переносится как есть
      const prefix = q?.titles.find((x) => a.label.startsWith(`${x.stored}: `));
      if (prefix) return `${prefix.shown}: ${a.label.slice(prefix.stored.length + 2)}`;
    }
    if (a.scaleId) {
      const hit = byScale.get(a.scaleId)?.get(a.label);
      if (hit) return hit;
    }
    return a.label;
  };
}
