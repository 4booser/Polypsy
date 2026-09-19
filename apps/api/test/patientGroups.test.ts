import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  adminA,
  adminB,
  api,
  db,
  makeUser,
  root,
  surveyInA,
  surveyInB,
  type Person,
} from "./fixtures";
import { patientGroupMembers, patientGroups, surveyAccess } from "../src/db/schema";

/**
 * Группы ПАЦИЕНТОВ.
 *
 * Новая сущность, и проверяется здесь не «работает ли кнопка», а три вещи,
 * которые ломаются молча: кто какие группы видит, кто попадает в состав и во
 * что превращается назначение методики на группу.
 *
 * Каждая проверка ниже проверена мутацией — защита снималась, и тест обязан
 * был упасть, назвав виновника поимённо. Сторож, который молчит или врёт,
 * хуже отсутствующего, и убедиться в этом можно только одним способом.
 */

/** Пациент, попавший в зону видимости adminA штатным путём — назначением методики группы А */
async function patientInZoneOfA(tag: string): Promise<Person> {
  const person = await makeUser("user", `pg-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(surveyAccess).values({
    surveyId: surveyInA,
    userId: person.id,
    grantedBy: adminA.id,
  });
  return person;
}

async function makeGroup(owner: Person, title: string): Promise<string> {
  const res = await api("/api/patient-groups", owner.token, {
    method: "POST",
    body: JSON.stringify({ title, description: "Що питаємо у цієї групи" }),
  });
  expect(res.status, `заведение группы «${title}»`).toBe(201);
  return res.body.id as string;
}

describe("группа пациентов заводится и живёт у владельца", () => {
  test("заводится с названием и собственным описанием", async () => {
    const id = await makeGroup(adminA, "Вечірня група");
    const card = await api(`/api/patient-groups/${id}`, adminA.token);
    expect(card.status).toBe(200);
    expect(card.body.title).toBe("Вечірня група");
    // описание группы — отдельное поле, а не приписка к названию
    expect(card.body.description).toBe("Що питаємо у цієї групи");
    expect(card.body.members).toEqual([]);
    expect(card.body.surveys).toEqual([]);
  });

  test("правится название и описание", async () => {
    const id = await makeGroup(adminA, "Чернетка");
    const res = await api(`/api/patient-groups/${id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Група ризику", description: "Хто саме у ризику" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Група ризику");
    expect(res.body.description).toBe("Хто саме у ризику");
  });

  /**
   * Главная проверка области видимости.
   *
   * Чужая группа не показывается в списке, не открывается карточкой и не
   * правится — и отвечает «не найдено», а не «нельзя»: 403 подтвердил бы,
   * что коллега такую группу завёл.
   *
   * Мутация: убрать условие по владельцу из запроса списка
   * (`eq(patientGroups.ownerId, user.id)`) и снять `assertPatientGroupAccess`
   * с карточки и правки — падают все три проверки ниже, каждая называет свой
   * маршрут.
   */
  test("чужая группа не видна, не открывается и не правится", async () => {
    const id = await makeGroup(adminA, "Моя група");

    const list = await api("/api/patient-groups", adminB.token);
    expect(
      (list.body.items as { id: string; title: string }[]).map((g) => g.title),
      "GET /api/patient-groups отдал чужому специалисту группу adminA",
    ).not.toContain("Моя група");

    const card = await api(`/api/patient-groups/${id}`, adminB.token);
    expect(card.status, `GET /api/patient-groups/:id открыл чужую группу ${id}`).toBe(404);

    const patched = await api(`/api/patient-groups/${id}`, adminB.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Захоплено" }),
    });
    expect(patched.status, `PATCH /api/patient-groups/:id правит чужую группу ${id}`).toBe(404);

    const added = await api(`/api/patient-groups/${id}/members`, adminB.token, {
      method: "POST",
      body: JSON.stringify({ userId: (await patientInZoneOfA("foreign")).id }),
    });
    expect(added.status, `POST /api/patient-groups/:id/members дописал в чужую группу ${id}`).toBe(
      404,
    );
  });

  test("суперадмин видит группы сотрудников", async () => {
    const title = `Під наглядом ${crypto.randomUUID().slice(0, 8)}`;
    await makeGroup(adminA, title);
    const list = await api("/api/patient-groups", root.token);
    expect((list.body.items as { title: string }[]).map((g) => g.title)).toContain(title);
  });
});

describe("Пацієнти Групи — состав", () => {
  test("пациент добавляется и появляется в составе", async () => {
    const id = await makeGroup(adminA, "Склад");
    const person = await patientInZoneOfA("add");

    const added = await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });
    expect(added.status).toBe(201);

    const card = await api(`/api/patient-groups/${id}`, adminA.token);
    expect((card.body.members as { userId: string }[]).map((m) => m.userId)).toEqual([person.id]);

    const list = await api("/api/patient-groups", adminA.token);
    const row = (list.body.items as { id: string; memberCount: number }[]).find((g) => g.id === id);
    expect(row?.memberCount).toBe(1);
  });

  test("повторное добавление — не ошибка и не вторая строка", async () => {
    /*
     * Специалист жмёт «додати пацієнта» второй раз, потому что не помнит,
     * добавлял ли он этого человека на прошлой неделе. Отказ ответил бы ему
     * не на тот вопрос.
     */
    const id = await makeGroup(adminA, "Двічі");
    const person = await patientInZoneOfA("twice");
    for (const _ of [1, 2]) {
      const res = await api(`/api/patient-groups/${id}/members`, adminA.token, {
        method: "POST",
        body: JSON.stringify({ userId: person.id }),
      });
      expect(res.status).toBe(201);
    }
    const card = await api(`/api/patient-groups/${id}`, adminA.token);
    expect(card.body.members).toHaveLength(1);
  });

  /**
   * Мутация: убрать `assertPatientAccess` из POST /:id/members — проверка
   * падает, называя идентификатор чужого пациента, который попал в состав.
   */
  test("пациента вне зоны ответственности в группу не добавить", async () => {
    const id = await makeGroup(adminA, "Чужі");
    // человек, не соприкасавшийся ни с одной методикой группы А
    const stranger = await makeUser("user", `pg-stranger-${crypto.randomUUID()}@test`);

    const res = await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: stranger.id }),
    });
    expect(res.status, `в группу добавлен пациент вне зоны: ${stranger.id}`).toBe(404);

    const card = await api(`/api/patient-groups/${id}`, adminA.token);
    expect(
      (card.body.members as { userId: string }[]).map((m) => m.userId),
      "состав группы содержит пациента вне зоны ответственности",
    ).toEqual([]);
  });

  test("сотрудника в группу пациентов не положить", async () => {
    /*
     * Два отказа на один запрет, и оба нужны.
     *
     * Сотруднику группы коллега не виден зоной ответственности — она знает
     * только пациентов, — и он получает «не найдено» раньше, чем дело дойдёт
     * до роли. Это правильный порядок: проверка зоны стоит первой и ничего
     * не рассказывает о людях вне её.
     *
     * Но тогда сам запрет «только пациенты» остался бы непроверенным, и его
     * можно было бы удалить, не уронив ни одного теста. Поэтому второй
     * заход — суперадмином: у него зона не ограничена, и до проверки роли
     * запрос доходит.
     */
    const byAdmin = await api(`/api/patient-groups/${await makeGroup(adminA, "Не для персоналу")}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: adminB.id }),
    });
    expect(byAdmin.status, "зона ответственности пропустила сотрудника как пациента").toBe(404);

    const rootGroup = await makeGroup(root, "Суперадмінська");
    const byRoot = await api(`/api/patient-groups/${rootGroup}/members`, root.token, {
      method: "POST",
      body: JSON.stringify({ userId: adminB.id }),
    });
    expect(byRoot.status, `сотрудник ${adminB.id} добавлен в группу пациентов`).toBe(400);
  });

  /**
   * Состав сужается зоной видимости уже после добавления.
   *
   * Список собран в марте, а в сентябре человека перевели — и он обязан
   * исчезнуть из состава, иначе членство в группе становится обходным путём
   * к чужой карте.
   *
   * Мутация: снять фильтр `membersVisibleTo` в routes/patientGroups.ts —
   * падают обе проверки ниже, первая называет идентификатор человека,
   * который остался виден после выхода из зоны.
   */
  test("выбывший из зоны исчезает из состава и из счётчика", async () => {
    const id = await makeGroup(adminA, "Зона змінюється");
    const person = await patientInZoneOfA("leaves");
    await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    // единственное основание видеть этого человека исчезает
    await db
      .delete(surveyAccess)
      .where(and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, person.id)));

    const card = await api(`/api/patient-groups/${id}`, adminA.token);
    expect(
      (card.body.members as { userId: string }[]).map((m) => m.userId),
      `в составе остался человек вне зоны: ${person.id}`,
    ).toEqual([]);

    const list = await api("/api/patient-groups", adminA.token);
    const row = (list.body.items as { id: string; memberCount: number }[]).find((g) => g.id === id);
    expect(row?.memberCount, "счётчик участников считает того, кого не показывает").toBe(0);

    // строка членства при этом на месте: выбытие из зоны — не исключение из группы
    const rows = await db
      .select()
      .from(patientGroupMembers)
      .where(eq(patientGroupMembers.groupId, id));
    expect(rows).toHaveLength(1);
  });

  test("убрать из группы можно, но только того, кто в ней есть", async () => {
    const id = await makeGroup(adminA, "Виключення");
    const person = await patientInZoneOfA("remove");
    await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    const gone = await api(`/api/patient-groups/${id}/members/${person.id}`, adminA.token, {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);

    const again = await api(`/api/patient-groups/${id}/members/${person.id}`, adminA.token, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });
});

describe("Тести Групи — назначение методики на всю группу", () => {
  /**
   * Снятый запрет на массовое назначение проверяется не тем, что кнопка
   * работает, а тем, ради чего его вообще согласились снять: назначение
   * разворачивается в обычные поимённые выдачи, у каждой свой срок и число
   * попыток, и в карте каждого видно, что методика пришла через группу.
   */
  test("разворачивается в поимённые назначения с пометкой «через группу»", async () => {
    const id = await makeGroup(adminA, "Призначення");
    const one = await patientInZoneOfA("assign-1");
    const two = await patientInZoneOfA("assign-2");
    for (const p of [one, two]) {
      await api(`/api/patient-groups/${id}/members`, adminA.token, {
        method: "POST",
        body: JSON.stringify({ userId: p.id }),
      });
    }

    const due = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    const res = await api(`/api/patient-groups/${id}/surveys`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA, expiresAt: due, attemptsAllowed: 2 }),
    });
    expect(res.status).toBe(201);
    expect(res.body.recipients).toBe(2);

    for (const p of [one, two]) {
      const row = await db.query.surveyAccess.findFirst({
        where: and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, p.id)),
      });
      expect(row, `назначение не доехало до участника ${p.id}`).toBeTruthy();
      // у каждого своё: срок, число попыток и собственный счётчик израсходованных
      expect(row!.expiresAt, `у участника ${p.id} не тот срок назначения`).toBe(due);
      expect(row!.attemptsAllowed, `у участника ${p.id} не то число попыток`).toBe(2);
      expect(row!.attemptsUsed, `у участника ${p.id} не обнулён счётчик попыток`).toBe(0);
      expect(
        row!.viaPatientGroupId,
        `в карте участника ${p.id} не видно, что методика пришла через группу`,
      ).toBe(id);
    }

    // и сама группа помнит своё решение — «Тести Групи»
    const card = await api(`/api/patient-groups/${id}`, adminA.token);
    expect((card.body.surveys as { surveyId: string }[]).map((s) => s.surveyId)).toEqual([
      surveyInA,
    ]);
  });

  /**
   * Повторное назначение той же методики группе — новое разрешение пройти, а
   * не воспоминание о старом.
   *
   * Мутация: заменить `onConflictDoUpdate` в lib/grantAccess.ts на
   * `onConflictDoNothing` — проверка падает и называет участника, у которого
   * остался прошлый срок и израсходованные попытки.
   */
  test("повторное назначение сдвигает срок и возвращает попытки", async () => {
    const id = await makeGroup(adminA, "Повторний замір");
    const person = await patientInZoneOfA("regrant");
    await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    const first = new Date(Date.now() + 24 * 3600_000).toISOString();
    await api(`/api/patient-groups/${id}/surveys`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA, expiresAt: first, attemptsAllowed: 1 }),
    });
    // человек израсходовал свою попытку
    await db
      .update(surveyAccess)
      .set({ attemptsUsed: 1 })
      .where(and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, person.id)));

    const second = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
    const again = await api(`/api/patient-groups/${id}/surveys`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA, expiresAt: second, attemptsAllowed: 1 }),
    });
    expect(again.status).toBe(201);

    const row = await db.query.surveyAccess.findFirst({
      where: and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, person.id)),
    });
    expect(row!.expiresAt, `у участника ${person.id} остался прошлый срок назначения`).toBe(second);
    expect(
      row!.attemptsUsed,
      `у участника ${person.id} не сброшен счётчик израсходованных попыток`,
    ).toBe(0);
  });

  test("адресная выдача поверх групповой снимает пометку «через группу»", async () => {
    /*
     * Пометка обязана говорить, откуда методика взялась СЕЙЧАС, а не как она
     * появилась в первый раз: иначе разбирающий через полгода прочитает
     * личное решение специалиста как рассылку.
     */
    const id = await makeGroup(adminA, "Спочатку групою");
    const person = await patientInZoneOfA("overwrite");
    await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });
    await api(`/api/patient-groups/${id}/surveys`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA, attemptsAllowed: 1 }),
    });

    const personal = await api(`/api/access/surveys/${surveyInA}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, attemptsAllowed: 1 }),
    });
    expect(personal.status).toBe(201);

    const row = await db.query.surveyAccess.findFirst({
      where: and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, person.id)),
    });
    expect(row!.viaPatientGroupId).toBeNull();
  });

  /**
   * Мутация: снять `assertSurveyAccess` из POST /:id/surveys — проверка
   * падает и называет методику чужой группы, разошедшуюся по своим людям.
   */
  test("чужую методику через свою группу не раздать", async () => {
    const id = await makeGroup(adminA, "Обхідний шлях");
    const person = await patientInZoneOfA("foreign-survey");
    await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    const res = await api(`/api/patient-groups/${id}/surveys`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInB, attemptsAllowed: 1 }),
    });
    expect(res.status, `методика чужой группы ${surveyInB} назначена через свою группу`).toBe(403);

    const leaked = await db.query.surveyAccess.findFirst({
      where: and(eq(surveyAccess.surveyId, surveyInB), eq(surveyAccess.userId, person.id)),
    });
    expect(leaked, `методика ${surveyInB} доехала до ${person.id} в обход зоны`).toBeFalsy();
  });

  test("назначение на пустую группу — отказ, а не тихий успех", async () => {
    /*
     * «Назначено» при нуле адресатов специалист прочитает как сделанную
     * работу и вернётся через две недели с вопросом, почему никто не сдал.
     */
    const id = await makeGroup(adminA, "Порожня");
    const res = await api(`/api/patient-groups/${id}/surveys`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA, attemptsAllowed: 1 }),
    });
    expect(res.status).toBe(400);
  });

  test("выбывший из зоны назначения не получает", async () => {
    const id = await makeGroup(adminA, "Вибулий");
    const stays = await patientInZoneOfA("stays");
    const leaves = await patientInZoneOfA("left");
    for (const p of [stays, leaves]) {
      await api(`/api/patient-groups/${id}/members`, adminA.token, {
        method: "POST",
        body: JSON.stringify({ userId: p.id }),
      });
    }
    await db
      .delete(surveyAccess)
      .where(and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, leaves.id)));

    const res = await api(`/api/patient-groups/${id}/surveys`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA, attemptsAllowed: 1 }),
    });
    expect(res.status).toBe(201);
    expect(res.body.recipients, "назначение ушло тому, кто вне зоны видимости").toBe(1);

    const row = await db.query.surveyAccess.findFirst({
      where: and(eq(surveyAccess.surveyId, surveyInA), eq(surveyAccess.userId, leaves.id)),
    });
    expect(row, `назначение доехало до выбывшего из зоны: ${leaves.id}`).toBeFalsy();
  });
});

describe("группа как вкладка списка пациентов", () => {
  test("фильтрует список своими людьми, чужую группу не открывает", async () => {
    const id = await makeGroup(adminA, "Вкладка");
    const inside = await patientInZoneOfA("tab-in");
    const outside = await patientInZoneOfA("tab-out");
    await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: inside.id }),
    });

    const filtered = await api(`/api/access/patients?patientGroup=${id}`, adminA.token);
    expect(filtered.status).toBe(200);
    const ids = (filtered.body.items as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(inside.id);
    expect(ids, `вкладка группы показала того, кого в группе нет: ${outside.id}`).not.toContain(
      outside.id,
    );

    // чужая вкладка не открывается — иначе фильтр стал бы способом прочитать чужой состав
    const foreign = await api(`/api/access/patients?patientGroup=${id}`, adminB.token);
    expect(foreign.status, `вкладка чужой группы ${id} открылась постороннему`).toBe(404);
  });
});

describe("страховочная сетка под группами пациентов", () => {
  /**
   * Таблица без политики — дыра, которую видно только проверкой покрытия.
   *
   * Общая проверка в access.test.ts находит клинические таблицы по колонкам
   * со ссылкой на человека: из трёх новых под неё попадает только
   * patient_group_members. Две другие остались бы без сторожа, поэтому здесь
   * они названы поимённо.
   *
   * Мутация: удалить любой из трёх блоков CREATE POLICY из миграции
   * 0078_patient_groups.sql — проверка падает и называет таблицу, оставшуюся
   * без политики.
   */
  const NEW_TABLES = ["patient_groups", "patient_group_members", "patient_group_surveys"];

  let policyCount: Map<string, number>;

  beforeAll(async () => {
    const rows = await db.execute<{ tablename: string; n: number }>(sql`
      select tablename, count(*)::int as n
        from pg_policies
       where schemaname = 'public'
       group by tablename
    `);
    policyCount = new Map([...rows].map((r) => [String(r.tablename), Number(r.n)]));
  });

  test("у каждой новой таблицы есть политика строк", () => {
    const unprotected = NEW_TABLES.filter((t) => !(policyCount.get(t) ?? 0));
    expect(unprotected).toEqual([]);
  });

  test("политики строк вообще включены на новых таблицах", async () => {
    /*
     * Политика существует и не действует — отдельное состояние, и именно оно
     * получается, если написать CREATE POLICY и забыть ENABLE ROW LEVEL
     * SECURITY. Проверка покрытия такую таблицу считает защищённой.
     */
    const rows = await db.execute<{ relname: string; relrowsecurity: boolean }>(sql`
      select c.relname, c.relrowsecurity
        from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname in ('patient_groups', 'patient_group_members', 'patient_group_surveys')
    `);
    const off = [...rows].filter((r) => !r.relrowsecurity).map((r) => String(r.relname));
    expect(off).toEqual([]);
  });

  test("политика состава спрашивает и про группу, и про пациента", async () => {
    /*
     * Два условия, и ни одно не лишнее: владение группой без проверки
     * пациента превращает собственную группу в способ читать чужие имена, а
     * проверка пациента без владения позволяет дописывать людей в чужой
     * список. Условие читается из самой политики — иначе половину можно
     * потерять правкой, и покрытие этого не заметит.
     */
    const rows = await db.execute<{ qual: string }>(sql`
      select qual from pg_policies
       where schemaname = 'public' and tablename = 'patient_group_members'
    `);
    const qual = [...rows].map((r) => String(r.qual)).join(" ");
    const missing = ["rls_owns_patient_group", "rls_admin_sees_patient"].filter(
      (fn) => !qual.includes(fn),
    );
    expect(missing, "политика patient_group_members потеряла условие").toEqual([]);
  });

  test("политика назначений спрашивает и про группу, и про методику", async () => {
    const rows = await db.execute<{ qual: string }>(sql`
      select qual from pg_policies
       where schemaname = 'public' and tablename = 'patient_group_surveys'
    `);
    const qual = [...rows].map((r) => String(r.qual)).join(" ");
    const missing = ["rls_owns_patient_group", "rls_admin_sees_survey"].filter(
      (fn) => !qual.includes(fn),
    );
    expect(missing, "политика patient_group_surveys потеряла условие").toEqual([]);
  });

  test("политика групп спрашивает про владельца, а не про роль", async () => {
    const rows = await db.execute<{ qual: string; with_check: string | null }>(sql`
      select qual, with_check from pg_policies
       where schemaname = 'public' and tablename = 'patient_groups'
    `);
    const all = [...rows];
    const qual = all.map((r) => String(r.qual)).join(" ");
    /*
     * WITH CHECK проверяется отдельно от USING: без него сотрудник мог бы
     * завести (или перевести правкой) группу на имя коллеги и подложить ему
     * в работу список, которого тот не собирал. Потерять эту половину можно
     * одной правкой, и USING останется на месте — сторож не заметит.
     */
    const check = all.map((r) => String(r.with_check ?? "")).join(" ");
    expect(qual.includes("owner_id") && qual.includes("app_uid"), `USING: ${qual}`).toBe(true);
    expect(check.includes("owner_id") && check.includes("app_uid"), `WITH CHECK: ${check}`).toBe(
      true,
    );
  });

  /**
   * Предикат политики — спрошенный у базы напрямую.
   *
   * Проверить политику поведением здесь НЕЛЬЗЯ, и это надо сказать вслух:
   * тесты ходят в базу владельцем (в этой машине — вдобавок суперпользователем
   * с BYPASSRLS), а такой пользователь политики обходит даже под `force row
   * level security`. Проверка вида «чужой сотрудник не видит строку» была бы
   * зелёной и при полном отсутствии политик — ровно тот сторож, который
   * врёт; первая её редакция именно так и выглядела.
   *
   * Поэтому проверяются две половины по отдельности: что политика ССЫЛАЕТСЯ
   * на предикат (проверки текста политики выше) и что предикат ОТВЕЧАЕТ
   * правильно (здесь). Функция обычная, суперпользователь её не обходит.
   *
   * Мутация: расширить `rls_owns_patient_group` до «любой admin» — падает
   * вторая проверка и называет постороннего сотрудника.
   */
  test("предикат владения отвечает «да» владельцу и «нет» постороннему", async () => {
    const id = await makeGroup(adminA, "Під політикою");
    const person = await patientInZoneOfA("policy");
    await api(`/api/patient-groups/${id}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    const { baseDb } = await import("../src/db");
    const { withDbContext } = await import("../src/db/context");

    const askAs = (userId: string, role: "admin" | "user") =>
      withDbContext(baseDb, { userId, role }, async () => {
        const rows = await db.execute<{ owns: boolean; sees: boolean }>(sql`
          select rls_owns_patient_group(${id}) as owns,
                 rls_admin_sees_patient(${person.id}) as sees
        `);
        return [...rows][0]!;
      });

    const owner = await askAs(adminA.id, "admin");
    expect(owner.owns, "владелец не признан владельцем собственной группы").toBe(true);
    expect(owner.sees, "владелец не видит пациента, которого сам добавил").toBe(true);

    const stranger = await askAs(adminB.id, "admin");
    expect(
      stranger.owns,
      `предикат признал владельцем группы ${id} постороннего сотрудника ${adminB.id}`,
    ).toBe(false);
    expect(
      stranger.sees,
      `предикат отдал постороннему сотруднику пациента ${person.id}`,
    ).toBe(false);

    const patientAsks = await askAs(person.id, "user");
    expect(
      patientAsks.owns,
      `предикат признал владельцем группы ${id} самого пациента ${person.id}`,
    ).toBe(false);
  });
});

describe("имена не путаются с группами методик", () => {
  test("группа методик и группа пациентов — разные сущности под разными адресами", async () => {
    /*
     * Проверка от опечатки в маршрутизации, а не от непонимания: заведённая
     * группа пациентов не должна появиться в списке групп методик, и
     * наоборот. Обе сущности зовутся «группой», и склеить их можно одним
     * неверным импортом таблицы.
     */
    const title = `Розрізняємо ${crypto.randomUUID().slice(0, 8)}`;
    const id = await makeGroup(adminA, title);

    const surveyGroups = await api("/api/groups", root.token);
    expect(
      (surveyGroups.body.items as { id: string; title: string }[]).map((g) => g.title),
      "группа пациентов попала в список групп методик",
    ).not.toContain(title);

    const rows = await db.select().from(patientGroups).where(eq(patientGroups.id, id));
    expect(rows).toHaveLength(1);
  });
});
