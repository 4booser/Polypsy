import type { PatientCard, PatientCardConclusion, PatientCardResponse } from "@quizzy/shared";

/**
 * Чистая часть карточки пациента: что печатается в столбцах вкладки
 * «Заміри», как зовётся заключение и какое из двух действий закрепления
 * («Підписатись / Відписатись») стоит в меню шапки.
 *
 * Вынесено ради проверки без React и сервера (apps/web/test/patientCard.test.ts):
 * подпись закрепления — это право, и разъехаться с ответом сервера она не
 * должна молча. Клиника карточки (методики, пункты, приёмы) — в clinical.ts,
 * колонка «Мої пацієнти» — в listModel.ts.
 */

/**
 * «Результат»: по каждой содержательной шкале — название, балл и полоса
 * интерпретации: «Тривожність: 14 — підвищена; Депресія: 3 — норма».
 */
export function resultText(scales: PatientCardResponse["scales"], t: { none: string }): string {
  if (!scales.length) return t.none;
  return scales.map((s) => `${s.title}: ${s.value}${s.bandLabel ? ` — ${s.bandLabel}` : ""}`).join("; ");
}

/**
 * «Статистика»: когда сдан и где балл стоит относительно максимума шкалы
 * (percent — доля от максимума, lib/submission.ts). Первым — дата: у одной
 * методики, сданной трижды, три одинаковых названия. Недостоверный протокол
 * называется словом, а не прячется. Части — через запятую: точку-разделитель
 * между словами набор не пускает (KIT.md § 2).
 */
export function statsText(
  r: Pick<PatientCardResponse, "submittedAt" | "reliable" | "scales">,
  t: { unreliable: string },
  formatDay: (iso: string) => string,
): string {
  const parts: string[] = [];
  if (r.submittedAt) parts.push(formatDay(r.submittedAt));
  if (r.scales.length) parts.push(r.scales.map((s) => `${s.code} ${s.percent}%`).join(", "));
  if (!r.reliable) parts.push(t.unreliable);
  return parts.join(", ");
}

/**
 * Имя заключения — методика, по которой оно написано: своего названия у
 * заключения нет (conclusions привязаны к прохождению). Черновик помечен
 * словом: рядом с подписанными его «Висновки» читались бы как документ.
 */
export function conclusionName(c: Pick<PatientCardConclusion, "surveyTitle" | "status">, t: { draft: string }): string {
  return c.status === "draft" ? `${c.surveyTitle} (${t.draft})` : c.surveyTitle;
}

/**
 * Какое действие закрепления предложить. «Відписатись» — только когда
 * пациент закреплён за читателем: закрепление другого специалиста отпустить
 * нельзя (сервер ответит отказом), а взять на себя — можно, и это «Підписатись».
 */
export function leadAction(card: Pick<PatientCard, "lead">): "subscribe" | "unsubscribe" {
  return card.lead?.mine ? "unsubscribe" : "subscribe";
}
