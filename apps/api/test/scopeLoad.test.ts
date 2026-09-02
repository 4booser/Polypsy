import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, db, makeUser } from "./fixtures";
import { alertCases, groupAdmins, surveyAccess, surveyGroups, surveys, users } from "../src/db/schema";
import { encryptPersonFields } from "../src/lib/crypto";
import { hashPassword } from "../src/lib/auth";
import {
  accessiblePatientIds,
  resetScopeCallsForTests,
  scopeCallsForTests,
} from "../src/lib/scope";

/**
 * Нагрузка на зону видимости.
 *
 * `accessiblePatientIds` отвечает на вопрос «кого этот сотрудник вправе
 * видеть» и зовётся почти отовсюду: очередь работы, список пациентов,
 * поиск, экран дня. Внутри — обход всех пациентов с тремя проверками
 * существования по трём таблицам.
 *
 * Проверяется не «быстро ли», а порядок величины и — главное — что зона
 * считается один раз на запрос. Именно это однажды и сломалось: очередь
 * работы считала её дважды, и смоук замедлился вдвое. На тридцати
 * пациентах такого не увидеть, на трёх тысячах — сразу.
 */

const POOL = 3000;

async function bigGroupWithPatients(): Promise<{
  staffId: string;
  token: string;
  surveyId: string;
  patientIds: string[];
}> {
  const groupId = crypto.randomUUID();
  const staff = await makeUser("admin", `scope-load-${crypto.randomUUID()}@test`);
  await db.insert(surveyGroups).values({ id: groupId, title: "Нагрузка", createdBy: staff.id });
  const surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    title: { uk: "Навантаження", ru: "Нагрузка" },
    description: { uk: "—", ru: "—" },
    groupId,
    createdBy: staff.id,
    status: "published",
  } as never);

  /*
   * Пациенты вставляются пачкой и с одним готовым хешем пароля.
   *
   * Через `makeUser` каждый стоил бы отдельного хеширования — три тысячи
   * bcrypt заняли бы минуты, и проверка мерила бы подготовку, а не то,
   * ради чего написана.
   */
  const hash = await hashPassword("secret12345");
  const rows = Array.from({ length: POOL }, () => {
    const id = crypto.randomUUID();
    return {
      id,
      email: `scope-load-p-${id}@test`,
      ...encryptPersonFields({ firstName: "Тест", lastName: "Нагрузкин", birthDate: null }),
      passwordHash: hash,
      role: "user" as const,
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(users).values(rows.slice(i, i + 500) as never);
  }
  await db.insert(surveyAccess).values(
    rows.map((r) => ({ surveyId, userId: r.id, grantedBy: staff.id })),
  );

  // сотрудник видит группу целиком
  await db.insert(groupAdmins).values({ groupId, userId: staff.id });

  return { staffId: staff.id, token: staff.token, surveyId, patientIds: rows.map((r) => r.id) };
}

describe("зона видимости под нагрузкой", () => {
  test(
    "считается за разумное время и находит всех своих",
    async () => {
      const { staffId } = await bigGroupWithPatients();
      const staff = await db.query.users.findFirst({ where: eq(users.id, staffId) });

      const t = Date.now();
      const seen = await accessiblePatientIds(staff as never);
      const ms = Date.now() - t;

      expect(seen).not.toBeNull();
      expect(seen!.size).toBeGreaterThanOrEqual(POOL);
      // грубый порог: ловим порядок величины, а не дрожание машины
      expect(ms).toBeLessThan(4000);
    },
    120_000,
  );

  test(
    "очередь работы считает зону ровно один раз",
    async () => {
      /*
       * Настоящая защита от повторения истории — и она намеренно не по
       * секундомеру.
       *
       * Первая редакция мерила время: пять случаев против пятидесяти, с
       * потолком «не вчетверо дольше». Проверка проходила и с нарочно
       * возвращённым пересчётом на каждую строку — зона считается быстро, и
       * полсотни лишних вычислений укладываются в любой разумный порог.
       * Зелёная проверка, не различающая сломанное и целое, хуже её
       * отсутствия.
       *
       * Спрашиваем прямо: сколько раз позвали. Ответ обязан быть «один» —
       * независимо от того, сколько строк в выдаче.
       */
      const { token, surveyId, patientIds } = await bigGroupWithPatients();

      await db.insert(alertCases).values(
        patientIds.slice(0, 50).map((userId) => ({
          id: crypto.randomUUID(),
          userId,
          surveyId,
          severity: "severe" as const,
        })),
      );

      resetScopeCallsForTests();
      const res = await api("/api/worklist", token);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(50);
      expect(
        scopeCallsForTests(),
        `строк в выдаче: ${res.body.items.length}`,
      ).toBe(1);
    },
    120_000,
  );
});
