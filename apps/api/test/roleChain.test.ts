import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ROLE_LADDER, roleRank } from "@quizzy/shared";
import { db } from "../src/db";
import { rolePermissions, roles, staffRoles } from "../src/db/schema";
import { adminA, api, makeUser, root, type Person } from "./fixtures";

/**
 * Цепочка назначения.
 *
 * Технический суперадмин назначает главного врача, главный врач —
 * заведующего отделением, заведующий — специалиста. Правило одно: назначить
 * можно только ступень ниже своей.
 *
 * Проверяется здесь именно сервер, а не экран. Спрятанная кнопка — подсказка,
 * а не ограничение: тот же PUT отправляется из консоли браузера за десять
 * секунд, и лестница держится ровно до первого человека, которому пришло в
 * голову попробовать. Поэтому каждая проверка ниже ходит запросом, а не
 * зовёт функцию: функцию можно вызвать правильно и мимо маршрута.
 *
 * Отказ проверяется вместе с виновником — кодом роли в тексте. Без этого
 * тест устраивал бы любой чужой 403: от проверки персонала, от учётки только
 * на чтение, — и снятая защита выглядела бы как работающая.
 */

const ladderIds = new Map<string, string>();

/** Человек на ступени лестницы: администратор, у которого ровно одна роль */
async function person(code: string): Promise<Person> {
  const who = await makeUser("admin", `chain-${code}-${crypto.randomUUID()}@test`);
  /*
   * Встроенная роль снимается: она даётся каждому администратору при
   * создании и в лестницу не входит. Оставив её, мы проверяли бы человека с
   * двумя ролями сразу — а ступень считается по старшей, и «психолог» тут
   * ничего не значит, но выяснять это следовало бы в другом тесте.
   */
  await db.delete(staffRoles).where(eq(staffRoles.userId, who.id));
  await db.insert(staffRoles).values({ userId: who.id, roleId: ladderIds.get(code)!, grantedBy: root.id });
  return who;
}

/**
 * Только что заведённый сотрудник без должности.
 *
 * Встроенная роль снимается: она не входит в лестницу, и в тестах на
 * назначение мешала бы — половина проверок говорила бы о ней, а не о
 * ступенях. Тому, что цепочка умеет заменять её на должность, посвящена
 * отдельная проверка ниже.
 */
async function blank(): Promise<Person> {
  const who = await makeUser("admin", `chain-new-${crypto.randomUUID()}@test`);
  await db.delete(staffRoles).where(eq(staffRoles.userId, who.id));
  return who;
}

/** Роли человека сейчас — по кодам, потому что именно ими написана лестница */
async function rolesOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ code: roles.code })
    .from(staffRoles)
    .innerJoin(roles, eq(roles.id, staffRoles.roleId))
    .where(eq(staffRoles.userId, userId));
  return rows.map((r) => r.code).sort();
}

async function setRoles(actor: Person, targetId: string, roleIds: string[]) {
  return api(`/api/permissions/users/${targetId}/roles`, actor.token, {
    method: "PUT",
    body: JSON.stringify({ roleIds }),
  });
}

beforeAll(async () => {
  for (const code of ROLE_LADDER) {
    const [row] = await db.select().from(roles).where(eq(roles.code, code));
    ladderIds.set(code, row!.id);
  }
});

describe("лестница заведена так, как её понимает код", () => {
  test("все три ступени есть в базе и различаются по старшинству", () => {
    /*
     * Роли заводит миграция, а старшинство задаёт справочник в коде. Если
     * код роли там переименуют, ступень станет нулевой — и назначать её
     * сможет только суперадмин, молча и по всей системе сразу.
     */
    expect([...ladderIds.keys()]).toEqual([...ROLE_LADDER]);
    expect(ROLE_LADDER.map(roleRank)).toEqual([1, 2, 3]);
  });
});

describe("назначение вниз по цепочке", () => {
  test("суперадмин назначает главного врача", async () => {
    const who = await blank();
    const res = await setRoles(root, who.id, [ladderIds.get("chief")!]);
    expect(res.status).toBe(200);
    expect(await rolesOf(who.id)).toEqual(["chief"]);
  });

  test("главный врач назначает заведующего отделением", async () => {
    const chief = await person("chief");
    const who = await blank();
    const res = await setRoles(chief, who.id, [ladderIds.get("head")!]);
    expect(res.status).toBe(200);
    expect(await rolesOf(who.id)).toEqual(["head"]);
  });

  test("заведующий назначает специалиста", async () => {
    const head = await person("head");
    const who = await blank();
    const res = await setRoles(head, who.id, [ladderIds.get("specialist")!]);
    expect(res.status).toBe(200);
    expect(await rolesOf(who.id)).toEqual(["specialist"]);
  });

  test("должность заменяет встроенную роль, а не добавляется к ней", async () => {
    /*
     * Только что заведённый администратор приходит со встроенной ролью
     * «психолог» — она вне лестницы. Назначить ему должность значит эту роль
     * снять, и симметричное правило «снимать можно только назначаемое»
     * сделало бы цепочку неработающей: главный врач не смог бы назначить
     * никого. Поэтому снятие ограничено иначе — не ниже своей ступени, — и
     * вот обычный случай, который этим держится.
     */
    const chief = await person("chief");
    const who = await makeUser("admin", `chain-hired-${crypto.randomUUID()}@test`);
    expect(await rolesOf(who.id)).toEqual(["psychologist"]);

    const res = await setRoles(chief, who.id, [ladderIds.get("head")!]);
    expect(res.status).toBe(200);
    expect(await rolesOf(who.id)).toEqual(["head"]);
  });

  test("главный врач может назначить и через ступень", async () => {
    /*
     * Не «строго на одну ниже», а «ниже». Заведующий, оставшийся без
     * отделения, не должен ждать, пока освободится тот, кто ровно на
     * ступень выше искомой: это правило про старшинство, а не про
     * бюрократию.
     */
    const chief = await person("chief");
    const who = await blank();
    expect((await setRoles(chief, who.id, [ladderIds.get("specialist")!])).status).toBe(200);
  });
});

describe("выше своей ступени назначить нельзя", () => {
  test("заведующий не назначает главного врача", async () => {
    const head = await person("head");
    const who = await blank();

    const res = await setRoles(head, who.id, [ladderIds.get("chief")!]);
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toContain("chief");
    /* отказ обязан быть и в базе, а не только в ответе */
    expect(await rolesOf(who.id)).not.toContain("chief");
  });

  test("специалист не назначает заведующего", async () => {
    const specialist = await person("specialist");
    const who = await blank();

    const res = await setRoles(specialist, who.id, [ladderIds.get("head")!]);
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toContain("head");
    expect(await rolesOf(who.id)).toEqual([]);
  });

  test("главный врач не назначает второго главного врача", async () => {
    /*
     * Равная ступень запрещена наравне с высшей. Главный врач, назначивший
     * себе подобного, получает того, кто вправе назначить третьего: лестница
     * перестаёт быть лестницей на втором шаге, и обратно её уже не собрать —
     * непонятно, кто из них настоящий.
     */
    const chief = await person("chief");
    const who = await blank();

    const res = await setRoles(chief, who.id, [ladderIds.get("chief")!]);
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toContain("chief");
  });

  test("никто не поднимает сам себя", async () => {
    /*
     * Самый дешёвый способ обойти лестницу: не просить повышения, а выдать
     * его себе. Проверяется отдельно, потому что «назначаю другому» и
     * «назначаю себе» — это один и тот же маршрут, и легко решить, что
     * своя учётная запись не считается чужой.
     */
    const head = await person("head");
    const res = await setRoles(head, head.id, [
      ladderIds.get("head")!,
      ladderIds.get("chief")!,
    ]);
    expect(res.status).toBe(403);
    expect(await rolesOf(head.id)).toEqual(["head"]);
  });

  test("снять чужую должность — то же нарушение, что и присвоить", async () => {
    /*
     * Маршрут заменяет набор целиком, поэтому проверять только назначаемое
     * недостаточно: пустым списком заведующий разжаловал бы главного врача,
     * формально не назначив никого.
     */
    const chief = await person("chief");
    const head = await person("head");

    const res = await setRoles(head, chief.id, []);
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toContain("chief");
    expect(await rolesOf(chief.id)).toEqual(["chief"]);
  });

  test("роль вне лестницы назначает только технический администратор", async () => {
    /*
     * Состав такой роли произволен: в неё можно положить что угодно, включая
     * учётные записи и журнал. Разрешив её раздавать, мы раздали бы вместе с
     * ней всё, что в неё положат завтра.
     */
    const chief = await person("chief");
    const who = await blank();
    const [builtin] = await db.select().from(roles).where(eq(roles.code, "psychologist"));

    const res = await setRoles(chief, who.id, [builtin!.id]);
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toContain("psychologist");
  });

  test("сотрудник вне лестницы не назначает вообще ничего", async () => {
    /*
     * Администратор группы со встроенной ролью стоит на нулевой ступени.
     * Ниже нуля ступеней нет — значит, назначать ему нечего, и это должно
     * быть отказом, а не пустым успехом.
     */
    const who = await blank();
    const res = await setRoles(adminA, who.id, [ladderIds.get("specialist")!]);
    expect(res.status).toBe(403);
  });

  test("к ролям суперадмина не подступиться снизу", async () => {
    const chief = await person("chief");
    const res = await setRoles(chief, root.id, []);
    expect(res.status).toBe(403);
  });
});

describe("ниже по должности — значит и не больше по возможностям", () => {
  test("нельзя выдать право, которого нет у самого", async () => {
    /*
     * Зазор между «ступенью ниже» и «меньше по возможностям». Ступень задана
     * кодом роли, а набор прав роли правится на экране: достаточно добавить
     * заведующему право, которого у главного врача нет, — и назначение,
     * законное по лестнице, поднимет человека выше назначающего.
     *
     * Право берётся заведомо отсутствующее у клинических ролей: учётные
     * записи в них не входят по решению миграции 0071.
     */
    const chief = await person("chief");
    const who = await blank();
    const headId = ladderIds.get("head")!;

    await db.insert(rolePermissions).values({ roleId: headId, permission: "users.manage" });
    try {
      const res = await setRoles(chief, who.id, [headId]);
      expect(res.status).toBe(403);
      expect(String(res.body?.error ?? "")).toContain("users.manage");
    } finally {
      await db
        .delete(rolePermissions)
        .where(and(eq(rolePermissions.roleId, headId), eq(rolePermissions.permission, "users.manage")));
    }
  });
});

describe("экран прав открыт тому, кто по нему назначает", () => {
  /*
   * Цепочка назначения жила только в маршруте выдачи ролей, а всё, из чего
   * собран экран — справочник прав, список ролей, список людей, действующие
   * исключения, — оставалось закрыто суперадмином. Заведующий отделением, ради
   * которого лестница и написана, до экрана не доходил: первый же запрос
   * отвечал «доступно только суперадминистратору», и раздел оставался пустым.
   *
   * Проверяется каждый из четырёх запросов отдельно. Один общий на «экран
   * открылся» пропустил бы забытый: экран показал бы три панели из четырёх и
   * выглядел бы работающим.
   */
  const SCREEN = ["/api/permissions/catalogue", "/api/permissions/roles", "/api/permissions/staff", "/api/permissions/exceptions"];

  test("заведующий отделением собирает экран целиком", async () => {
    const head = await person("head");
    for (const path of SCREEN) {
      const res = await api(path, head.token);
      expect(res.status, path).toBe(200);
    }
  });

  test("специалисту экран закрыт: назначать ему некого", async () => {
    const specialist = await person("specialist");
    for (const path of SCREEN) {
      /* язык запроса задан явно: без него сервер отвечает по-украински, и
         сверка с русским словом ломалась бы не там, где сломано */
      const res = await api(path, specialist.token, { headers: { "Accept-Language": "ru" } });
      expect(res.status, path).toBe(403);
      /* отказ называет причину, а не просто «нельзя»: иначе сойдёт любой чужой 403 */
      expect(String(res.body?.error ?? ""), path).toContain("заведующий");
    }
  });

  test("список людей обрывается на своей ступени", async () => {
    const head = await person("head");
    const chief = await person("chief");
    const below = await person("specialist");

    const res = await api("/api/permissions/staff", head.token);
    const ids = (res.body.items as { id: string }[]).map((u) => u.id);

    expect(ids, "своих специалистов заведующий видит").toContain(below.id);
    expect(ids, "главного врача — нет: его назначает технический администратор").not.toContain(chief.id);
    expect(ids, "себя тоже нет: ступень не ниже собственной").not.toContain(head.id);
    expect(ids, "суперадмина не видно никогда").not.toContain(root.id);
  });

  test("роль не ниже своей приходит помеченной, а не спрятанной", async () => {
    const head = await person("head");
    const res = await api("/api/permissions/roles", head.token);
    const byCode = new Map((res.body.items as { code: string; assignable: boolean }[]).map((r) => [r.code, r.assignable]));

    expect(byCode.get("specialist"), "ступень ниже — назначает").toBe(true);
    expect(byCode.get("head"), "своя ступень — нет").toBe(false);
    expect(byCode.get("chief"), "ступень выше — нет").toBe(false);
    expect(byCode.has("chief"), "но видит, что она есть: иначе лестница обрывается на читателе").toBe(true);
  });

  test("суперадмину по-прежнему открыто всё", async () => {
    for (const path of SCREEN) {
      expect((await api(path, root.token)).status, path).toBe(200);
    }
    const res = await api("/api/permissions/roles", root.token);
    expect((res.body.items as { assignable: boolean }[]).every((r) => r.assignable)).toBe(true);
  });
});
