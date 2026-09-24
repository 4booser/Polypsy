import type { PatientCard, PatientCardConclusion, PatientCardGroup, PatientCardResponse } from "@quizzy/shared";

/**
 * Чистая часть карточки пациента (кадр f19): какие плашки и в каком порядке,
 * что печатается в колонках «Результат тесту», «Статистика», «Статистика
 * Групи», как зовётся заключение и какая из двух кнопок закрепления стоит в
 * шапке.
 *
 * Вынесено из экрана ради проверки без React и сервера
 * (apps/web/test/patientCard.test.ts): порядок плашек — это порядок кадра, а
 * подпись кнопки «Відписатись / Підписатись» — это право, и разъехаться с
 * ответом сервера они должны не молча.
 */

/** Плашка персональных данных: подпись видна, пока значения нет, — как на кадре, где все плашки пусты */
export interface FieldSpec {
  key: string;
  label: string;
  value: string | null;
}

export interface FieldLabels {
  firstName: string;
  lastName: string;
  middleName: string;
  sex: string;
  birthDate: string;
  phone: string;
  city: string;
  email: string;
  male: string;
  female: string;
}

/**
 * Восемь плашек в порядке кадра, построчно: ім’я · прізвище · по батькові /
 * стать · дата народження · телефон / населений пункт · email. Девятая
 * ячейка сетки на кадре пуста — так и остаётся.
 *
 * Телефон — как на кадре f13 (решение заказчика 2026-09-25: «как на
 * макете»); чтение карточки журналируется с пометкой, что номер в ней был.
 * Населённый пункт пуст: такого поля в учётной записи нет (см. api_gaps). Плашки при этом на месте — иначе
 * сетка карточки отличалась бы от кадра.
 *
 * Анонимному пациенту вместо имени ставится псевдоним: имя у него пустое,
 * а карточка без единого слова о том, кто это, — не карточка.
 */
export function personFields(
  /* locality объявлен у строки списка (PatientListItem), у карточки его пока нет — сюда он ляжет, когда появится */
  card: Pick<PatientCard, "firstName" | "lastName" | "middleName" | "anonymous" | "pseudonym" | "fullName" | "sex" | "birthDate" | "email" | "phone"> & {
    locality?: string | null;
  },
  t: FieldLabels,
  formatDay: (iso: string) => string,
): FieldSpec[] {
  const firstName = card.anonymous ? card.pseudonym || card.fullName || null : card.firstName || null;
  const sex = card.sex === "male" ? t.male : card.sex === "female" ? t.female : null;
  return [
    { key: "firstName", label: t.firstName, value: firstName },
    { key: "lastName", label: t.lastName, value: card.anonymous ? null : card.lastName || null },
    { key: "middleName", label: t.middleName, value: card.anonymous ? null : card.middleName || null },
    { key: "sex", label: t.sex, value: sex },
    { key: "birthDate", label: t.birthDate, value: card.birthDate ? formatDay(card.birthDate) : null },
    { key: "phone", label: t.phone, value: card.phone || null },
    { key: "city", label: t.city, value: card.locality || null },
    { key: "email", label: t.email, value: card.email || null },
  ];
}

/**
 * «Результат тесту»: по каждой содержательной шкале — название, балл и
 * полоса интерпретации: «Тривожність: 14 — підвищена; Депресія: 3 — норма».
 * Одной строкой, а не таблицей: на кадре колонка — абзац текста.
 */
export function resultText(scales: PatientCardResponse["scales"], t: { none: string }): string {
  if (!scales.length) return t.none;
  return scales.map((s) => `${s.title}: ${s.value}${s.bandLabel ? ` — ${s.bandLabel}` : ""}`).join("; ");
}

/**
 * «Статистика»: когда сдан и где балл стоит относительно максимума шкалы
 * (percent — доля от максимума, lib/submission.ts). Первым — дата: у одной
 * методики, сданной трижды, три одинаковых названия, и различить строки
 * иначе нечем. Недостоверный протокол называется словом, а не прячется:
 * его баллы в «Результаті» напечатаны, и читать их без оговорки нельзя.
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
  return parts.join(" · ");
}

/** «Статистика Групи»: «12 учасників · 3 тестів» — те же числа, что на вкладке группы */
export function groupStatsText(g: Pick<PatientCardGroup, "memberCount" | "surveyCount">, t: { members: string; tests: string }): string {
  return `${g.memberCount} ${t.members} · ${g.surveyCount} ${t.tests}`;
}

/**
 * Имя заключения — методика, по которой оно написано: своего названия у
 * заключения нет (conclusions привязаны к прохождению). Черновик помечен
 * словом: на карточке он стоит рядом с подписанными, и без пометки его
 * «Висновки» читались бы как документ.
 */
export function conclusionName(c: Pick<PatientCardConclusion, "surveyTitle" | "status">, t: { draft: string }): string {
  return c.status === "draft" ? `${c.surveyTitle} (${t.draft})` : c.surveyTitle;
}

/**
 * Какая кнопка стоит в шапке. «Відписатись» — только когда пациент закреплён
 * за читателем: закрепление другого специалиста отпустить нельзя (сервер
 * ответит отказом), а взять на себя — можно, и это «Підписатись».
 */
export function leadAction(card: Pick<PatientCard, "lead">): "subscribe" | "unsubscribe" {
  return card.lead?.mine ? "unsubscribe" : "subscribe";
}
