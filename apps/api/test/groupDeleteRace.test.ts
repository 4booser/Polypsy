import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { appApi, batteries, db, root, surveyGroups, surveys } from "./fixtures";
import { untilWaiting } from "./lockQueue";
import { AUDIT_CHAIN_LOCK } from "../src/lib/audit";

/**
 * Удаление «пустой» группы наперегонки с переносом в неё содержимого (#149).
 *
 * Маршрут считал методики, наборы и правила группы, а удалял её отдельным
 * оператором, не держа строку группы. Перенос, не зафиксированный к моменту
 * подсчёта, подсчёт не видел; удаление вставало в очередь за его замком
 * внешнего ключа и, дождавшись фиксации, удаляло группу — с 204. Методика
 * уходила с group_id = null (личная методика автора, вне зоны группы),
 * набор — каскадом вместе с составом.
 *
 * Перенос — отдельным соединением владельца, как «незакоммиченная
 * транзакция» из разбора; удаление — запросом под ролью приложения.
 */

const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const mover = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

const groupIds: string[] = [];
const surveyIds: string[] = [];
const batteryIds: string[] = [];

afterAll(async () => {
  if (batteryIds.length) await db.delete(batteries).where(inArray(batteries.id, batteryIds));
  if (surveyIds.length) await db.delete(surveys).where(inArray(surveys.id, surveyIds));
  if (groupIds.length) await db.delete(surveyGroups).where(inArray(surveyGroups.id, groupIds));
  await holder.end();
  await mover.end();
}, 15_000);

/** Пустая группа, которую удаляют, и соседняя — с методикой и набором, которые в неё переносят */
async function world(tag: string) {
  const target = crypto.randomUUID();
  const home = crypto.randomUUID();
  await db.insert(surveyGroups).values([
    { id: target, title: `Удаляемая ${tag} ${target.slice(0, 6)}`, createdBy: root.id },
    { id: home, title: `Исходная ${tag} ${home.slice(0, 6)}`, createdBy: root.id },
  ]);
  groupIds.push(target, home);

  const surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    groupId: home,
    title: { uk: `Перенос ${tag}`, ru: `Перенос ${tag}` },
    administration: "self",
    status: "draft",
    createdBy: root.id,
  } as never);
  surveyIds.push(surveyId);

  const batteryId = crypto.randomUUID();
  await db.insert(batteries).values({ id: batteryId, title: `Набор ${tag}`, groupId: home, createdBy: root.id });
  batteryIds.push(batteryId);

  return { target, home, surveyId, batteryId };
}

async function placeOf(w: Awaited<ReturnType<typeof world>>) {
  const [survey] = await db.select({ groupId: surveys.groupId }).from(surveys).where(eq(surveys.id, w.surveyId));
  const [battery] = await db
    .select({ groupId: batteries.groupId })
    .from(batteries)
    .where(eq(batteries.id, w.batteryId));
  const [group] = await db.select({ id: surveyGroups.id }).from(surveyGroups).where(eq(surveyGroups.id, w.target));
  return { survey: survey?.groupId ?? null, battery: battery?.groupId ?? null, groupExists: Boolean(group) };
}

const remove = (groupId: string) => appApi(`/api/groups/${groupId}?lang=ru`, root.token, { method: "DELETE" });

describe("удаление группы наперегонки с переносом в неё содержимого", () => {
  test("перенос первым: удаление дожидается его и отвечает «не пуста», методика и набор остаются в группе", async () => {
    const w = await world("перенос-первым");

    let deleted!: Promise<Awaited<ReturnType<typeof remove>>>;
    await holder.begin(async (tx) => {
      await tx`update surveys set group_id = ${w.target} where id = ${w.surveyId}`;
      await tx`update batteries set group_id = ${w.target} where id = ${w.batteryId}`;
      deleted = remove(w.target);
      deleted.catch(() => {});
      // до правки в очереди стоит сам DELETE, после — захват строки группы
      await untilWaiting(1, ["survey_groups"]);
    });
    const res = await deleted;

    expect(res.status, `удаление прошло мимо переноса: ${JSON.stringify(res.body)}`).toBe(400);
    expect(String(res.body.error)).toContain("Группа не пуста (методик: 1, батарей: 1)");
    expect(await placeOf(w)).toEqual({ survey: w.target, battery: w.target, groupExists: true });
  }, 30_000);

  test("удаление первым: перенос ждёт его и падает на внешнем ключе, содержимое остаётся на месте", async () => {
    /*
     * Положительный контроль обратного порядка. Удаление останавливается на
     * строке журнала (замок цепочки держит отдельное соединение) — уже
     * удалив группу, но не зафиксировав; перенос встаёт за ним в очередь.
     * После фиксации удаления переносить некуда — и перенос не проходит, а
     * не уводит методику «в никуда».
     */
    const w = await world("удаление-первым");

    let deleted!: Promise<Awaited<ReturnType<typeof remove>>>;
    let moved!: Promise<unknown>;
    await holder.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
      deleted = remove(w.target);
      deleted.catch(() => {});
      await untilWaiting(1, ["pg_advisory_xact_lock"]);
      moved = mover.begin(async (mtx) => {
        await mtx`update surveys set group_id = ${w.target} where id = ${w.surveyId}`;
        await mtx`update batteries set group_id = ${w.target} where id = ${w.batteryId}`;
      });
      moved.catch(() => {});
      await untilWaiting(2, ["pg_advisory_xact_lock", "update surveys"]);
    });
    const res = await deleted;
    const moveError = await moved.then(
      () => null,
      (e: { code?: string }) => e,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(moveError?.code, "перенос в удалённую группу прошёл").toBe("23503");
    expect(await placeOf(w)).toEqual({ survey: w.home, battery: w.home, groupExists: false });
  }, 30_000);
});
