/**
 * Бэкфилл снэпшотов стратификации (волна 1 расширения): respondent_sex и
 * respondent_age_band для уже собранных прохождений. Возраст — на момент
 * сдачи (submittedAt), не текущий. lang остаётся null — язык предъявления
 * прошлого честно неизвестен.
 */
import { eq, isNull, and, isNotNull } from "drizzle-orm";
import { ageAt, ageBandOf } from "@quizzy/shared";
import { client, db } from "./db";
import { responses, users } from "./db/schema";
import { decryptField } from "./lib/crypto";

const rows = await db
  .select({ response: responses, user: users })
  .from(responses)
  .innerJoin(users, eq(users.id, responses.userId))
  .where(and(isNull(responses.respondentAgeBand), isNotNull(responses.userId)));

let done = 0;
for (const { response, user } of rows) {
  const age = ageAt(decryptField(user.birthDate), response.submittedAt ?? response.startedAt);
  await db
    .update(responses)
    .set({
      respondentSex: user.sex,
      respondentAgeBand: ageBandOf(age),
    })
    .where(eq(responses.id, response.id));
  done++;
}
console.log(`снэпшоты заполнены: ${done} прохождений`);
await client.end();
