import { ageAt } from "@quizzy/shared";

/**
 * Чьи пол и возраст применять при подсчёте на устройстве.
 *
 * Нормы методик стратифицированы по полу и возрасту. В обычном режиме отвечает
 * сам человек, и берутся его данные. В режиме обхода заполняет специалист, а
 * профиль принадлежит пациенту: посчитать чужие баллы по своему полу значит
 * показать у койки неверный результат — и заметить это будет негде, потому что
 * число выглядит как обычный балл.
 *
 * Отсутствие паспортной части у пациента не повод подставить свою: честный
 * ответ здесь «нормы не применились», а не «применились чужие».
 */
export interface Respondent {
  sex: "male" | "female" | null;
  age: number | null;
}

export function respondentFor(
  subject: Respondent | null | undefined,
  me: { sex?: "male" | "female" | null; birthDate?: string | null } | null,
  now = new Date().toISOString(),
): Respondent {
  if (subject) return { sex: subject.sex, age: subject.age };
  return { sex: me?.sex ?? null, age: ageAt(me?.birthDate ?? null, now) };
}
