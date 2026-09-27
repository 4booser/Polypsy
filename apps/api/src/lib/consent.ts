import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { consentTexts, consents } from "../db/schema";

/**
 * Информированное согласие как условие работы с данными пациента.
 *
 * Действующая редакция — последняя по номеру. Нет ни одной — согласие не
 * требуется (учреждение его не завело). Принятие привязано к редакции:
 * новая версия текста требует согласия заново, отказ (или отзыв) снимает
 * принятие действующей (routes/consents.ts).
 */
export async function currentConsentText() {
  const [row] = await db.select().from(consentTexts).orderBy(desc(consentTexts.version)).limit(1);
  return row ?? null;
}

/**
 * Принял ли человек действующую редакцию (или согласие не требуется).
 *
 * Раньше это проверял только экран приложения: сервер принимал ответы и
 * без согласия, и после его отзыва — прямой запрос, веб-кабинет без экрана
 * согласия и офлайн-очередь, досланная после отзыва, обходили его (волна 12).
 */
export async function hasCurrentConsent(userId: string): Promise<boolean> {
  const current = await currentConsentText();
  if (!current) return true;
  const [row] = await db
    .select({ userId: consents.userId })
    .from(consents)
    .where(and(eq(consents.userId, userId), eq(consents.consentTextId, current.id)))
    .limit(1);
  return Boolean(row);
}
