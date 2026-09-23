import { describe, expect, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  adminA,
  adminB,
  api,
  db,
  makeUser,
  root,
  submitSurvey,
  surveyInA,
  surveyInB,
  type Person,
} from "./fixtures";
import { auditLog, patientGroupFavourites, patientGroupMembers, surveyAccess } from "../src/db/schema";
import { ROUTE_DOCS } from "../src/lib/openapi";

/**
 * Пациенты зоны видимости и карточка пациента (кадр f19) — то, чего экранам
 * волны 4 не хватало и что они обходили чужими маршрутами.
 *
 * Проверяется, что ломается молча: чужая зона отвечает «не найдено», список
 * отдаёт всех, кого положено, и никого сверх; карточка собирает результаты,
 * группы и заключения только из зоны читателя; закладка «обрана» — личная.
 *
 * Каждая защита проверена мутацией — снималась, и тест обязан был упасть,
 * назвав виновника. Тестовый пользователь базы обходит RLS, поэтому
 * политики проверяются текстом из pg_policies и прямым вызовом предикатов.
 */

/** Пациент в зоне adminA — штатным путём, назначением методики группы А */
async function patientOfA(tag: string, extra: Record<string, unknown> = {}): Promise<Person> {
  const person = await makeUser("user", `pc-${tag}-${crypto.randomUUID()}@test`, extra);
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
  return person;
}

async function makeGroup(owner: Person, title: string): Promise<string> {
  const res = await api("/api/patient-groups", owner.token, {
    method: "POST",
    body: JSON.stringify({ title, description: `Опис ${title}` }),
  });
  expect(res.status, `заведение группы «${title}»`).toBe(201);
  return res.body.id as string;
}

const idsOf = (body: { items: { id: string }[] }) => body.items.map((p) => p.id);

describe("GET /api/patients — пациенты зоны видимости", () => {
  /**
   * Мутация: заменить `ids ? inArray(users.id, ids) : undefined` на
   * `undefined` в routes/patients.ts — проверка падает и называет человека
   * из зоны А, которого увидел adminB.
   */
  test("свой пациент виден своему специалисту и не виден чужому; суперадмину — все", async () => {
    const unit = `Рота-${crypto.randomUUID().slice(0, 8)}`;
    const person = await patientOfA("zone", { unit, sex: "female", birthDate: "1991-05-05" });

    const own = await api("/api/patients?limit=200", adminA.token);
    expect(own.status).toBe(200);
    expect(idsOf(own.body)).toContain(person.id);
    const row = own.body.items.find((p: { id: string }) => p.id === person.id);
    expect(row.name).toContain("pc-zone");
    expect(row.unit).toBe(unit);
    expect(row.sex).toBe("female");
    expect(row.birthYear).toBe(1991);
    expect(row.lastResponseAt).toBeNull();
    // телефона в строке нет — он открывается отдельным журналируемым действием
    expect(Object.keys(row)).not.toContain("phone");
    expect(Object.keys(row)).not.toContain("birthDate");

    /*
     * У adminB своя непустая зона — иначе проверка держалась бы на том, что
     * пустая зона отвечает пустым списком раньше запроса, и снятие условия
     * по зоне из самого запроса прошло бы незамеченным.
     */
    const theirs = await makeUser("user", `pc-zone-b-${crypto.randomUUID()}@test`);
    await db.insert(surveyAccess).values({ surveyId: surveyInB, userId: theirs.id, grantedBy: adminB.id });
    const foreign = await api("/api/patients?limit=200", adminB.token);
    const foreignIds = idsOf(foreign.body);
    expect(foreignIds).toContain(theirs.id);
    expect(foreignIds, `GET /api/patients отдал чужому специалисту ${person.id}`).not.toContain(person.id);

    const all = await api(`/api/patients?q=${encodeURIComponent("pc-zone")}`, root.token);
    expect(idsOf(all.body)).toContain(person.id);
  });

  test("ещё ничего не проходивший, но записанный на приём — в списке", async () => {
    /*
     * Ради этого маршрут и заведён: /api/dynamics/respondents отдаёт только
     * обследованных, а человек, записавшийся с телефона, в разделе
     * «Пацієнти» обязан быть.
     */
    const { appointments, slots, specialistProfiles, departments } = await import("../src/db/schema");
    const doctor = await makeUser("admin", `pc-doc-${crypto.randomUUID()}@test`);
    const person = await makeUser("user", `pc-booked-${crypto.randomUUID()}@test`);
    const departmentId = crypto.randomUUID();
    await db
      .insert(departments)
      .values({ id: departmentId, title: { uk: "Прийом" }, timezone: "Europe/Kyiv" });
    await db.insert(specialistProfiles).values({ userId: doctor.id, departmentId });
    const slotId = crypto.randomUUID();
    await db.insert(slots).values({
      id: slotId,
      departmentId,
      specialistId: doctor.id,
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 3000_000).toISOString(),
      kind: "primary",
    });
    await db.insert(appointments).values({
      id: crypto.randomUUID(),
      slotId,
      patientId: person.id,
      specialistId: doctor.id,
      kind: "primary",
      status: "booked",
      bookedBy: doctor.id,
    });

    const list = await api("/api/patients?limit=200", doctor.token);
    expect(idsOf(list.body)).toContain(person.id);
  });

  test("поиск, страницы и total; последняя сдача", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const staff = await makeUser("admin", `pc-pager-${crypto.randomUUID()}@test`);
    const { groupAdmins, surveyGroups, surveys } = await import("../src/db/schema");
    const { createVersion, createSurveySchema, sr45 } = await import("./fixtures");
    // своя группа методик — чтобы выдача не зависела от того, что насыпали соседние тесты
    const groupId = crypto.randomUUID();
    await db.insert(surveyGroups).values({ id: groupId, title: "Сторінки", createdBy: root.id });
    await db.insert(groupAdmins).values({ groupId, userId: staff.id, addedBy: root.id });
    const surveyId = crypto.randomUUID();
    await db.insert(surveys).values({
      id: surveyId,
      groupId,
      title: { uk: "Сторінки" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: staff.id,
    } as never);
    await createVersion(surveyId, createSurveySchema.parse(sr45), staff.id, "v");

    const people: Person[] = [];
    for (const name of ["Андрієнко", "Борисенко", "Вакуленко"]) {
      const p = await makeUser("user", `${name}-${tag}@test`);
      await db.insert(surveyAccess).values({ surveyId, userId: p.id, grantedBy: staff.id });
      people.push(p);
    }
    const done = await submitSurvey(surveyId, people[1]!.token);
    expect(done.status).toBe(201);

    const page1 = await api("/api/patients?limit=2&offset=0", staff.token);
    expect(page1.body.total).toBe(3);
    expect(page1.body.items).toHaveLength(2);
    // по фамилии: расшифровано и отсортировано в приложении
    expect(page1.body.items.map((p: { name: string }) => p.name.split(" ")[0])).toEqual([
      `Андрієнко-${tag}`,
      `Борисенко-${tag}`,
    ]);
    expect(page1.body.items[1].lastResponseAt).toBeTruthy();
    expect(page1.body.items[0].lastResponseAt).toBeNull();

    const page2 = await api("/api/patients?limit=2&offset=2", staff.token);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.total).toBe(3);

    const found = await api(`/api/patients?q=${encodeURIComponent("вакул")}`, staff.token);
    expect(idsOf(found.body)).toEqual([people[2]!.id]);
    expect(found.body.total).toBe(1);
  });

  /**
   * Мутация: снять `assertPatientGroupAccess` из GET / — вторая проверка
   * падает и называет чужую группу, которую вкладка открыла постороннему.
   */
  test("вкладка группы сужает список своими людьми; чужая группа — не найдено", async () => {
    const inside = await patientOfA("tab-in");
    const outside = await patientOfA("tab-out");
    const groupId = await makeGroup(adminA, "Вкладка");
    await api(`/api/patient-groups/${groupId}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userIds: [inside.id] }),
    });

    const filtered = await api(`/api/patients?patientGroup=${groupId}&limit=200`, adminA.token);
    expect(filtered.status).toBe(200);
    expect(idsOf(filtered.body)).toEqual([inside.id]);
    expect(idsOf(filtered.body), `вкладка показала того, кого в группе нет: ${outside.id}`).not.toContain(
      outside.id,
    );

    const foreign = await api(`/api/patients?patientGroup=${groupId}`, adminB.token);
    expect(foreign.status, `вкладка чужой группы ${groupId} открылась постороннему`).toBe(404);
  });

  test("пациенту список закрыт; чтение списка — в журнале", async () => {
    const person = await patientOfA("no-list");
    expect((await api("/api/patients", person.token)).status).toBe(403);

    await api("/api/patients?limit=1", adminA.token);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, adminA.id), eq(auditLog.action, "access.patient_list")))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(entry).toBeTruthy();
    expect((entry!.details as { returned: number }).returned).toBe(1);
  });
});

describe("GET /api/patients/:id/card — карточка пациента", () => {
  /**
   * Мутация: снять проверку `visible.has(patientId)` из карточки — первая
   * проверка падает и называет пациента, чью карточку открыл посторонний.
   */
  test("чужая зона — не найдено; своя — карточка без телефона", async () => {
    const person = await patientOfA("card", { unit: "Штаб", sex: "male", birthDate: "1988-02-02" });

    const foreign = await api(`/api/patients/${person.id}/card`, adminB.token);
    expect(foreign.status, `карточка ${person.id} открылась постороннему`).toBe(404);
    // и сотрудник — не пациент: его карточки нет даже у суперадмина
    expect((await api(`/api/patients/${adminB.id}/card`, root.token)).status).toBe(404);

    const own = await api(`/api/patients/${person.id}/card`, adminA.token);
    expect(own.status).toBe(200);
    expect(own.body.lastName).toContain("pc-card");
    expect(own.body.firstName).toBe("Тест");
    expect(own.body.sex).toBe("male");
    expect(own.body.birthDate).toBe("1988-02-02");
    expect(own.body.unit).toBe("Штаб");
    expect(own.body.email).toContain("pc-card");
    expect(Object.keys(own.body)).not.toContain("phone");
    expect(Object.keys(own.body)).not.toContain("phoneEnc");
    expect(own.body.responses).toEqual([]);
    expect(own.body.groups).toEqual([]);
    expect(own.body.conclusions).toEqual([]);
    expect(own.body.lead).toBeNull();

    // открытие карточки — в журнале, как открытие карты
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "patient.card_read"), eq(auditLog.subjectUserId, person.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(entry?.actorId).toBe(adminA.id);
  });

  test("«Тести» — прохождения с баллами и полосой; «Заключення» — подписанные и свои черновики", async () => {
    const person = await patientOfA("tests");
    const done = await submitSurvey(surveyInA, person.token);
    expect(done.status).toBe(201);
    const responseId = done.body.id as string;

    // чужой черновик — недописанная мысль коллеги, не документ: у суперадмина зона не ограничена
    const rootDraft = await api(`/api/conclusions/responses/${responseId}/conclusion`, root.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Чернетка суперадміна", baseVersion: 0 }),
    });
    expect(rootDraft.status, JSON.stringify(rootDraft.body)).toBe(200);

    const before = await api(`/api/patients/${person.id}/card`, adminA.token);
    expect(before.body.responses).toHaveLength(1);
    const r = before.body.responses[0];
    expect(r.responseId).toBe(responseId);
    expect(r.surveyId).toBe(surveyInA);
    expect(r.surveyTitle).toBeTruthy();
    expect(r.submittedAt).toBeTruthy();
    expect(typeof r.reliable).toBe("boolean");
    expect(r.scales.length).toBeGreaterThan(0);
    for (const s of r.scales) {
      expect(s.code).toBeTruthy();
      expect(typeof s.value).toBe("number");
      expect(typeof s.percent).toBe("number");
      expect(["raw", "ratio", "tscore", "sten"]).toContain(s.normalization);
    }
    expect(before.body.conclusions, "на карточке виден чужой черновик").toEqual([]);

    // подписанное — документ, виден любому в зоне; поверх — свой черновик
    const signedVersion = rootDraft.body.current.version as number;
    const signed = await api(`/api/conclusions/responses/${responseId}/conclusion/sign`, root.token, {
      method: "POST",
      body: JSON.stringify({ version: signedVersion }),
    });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const ownDraft = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Своя чернетка", baseVersion: signedVersion }),
    });
    expect(ownDraft.status, JSON.stringify(ownDraft.body)).toBe(200);

    const after = await api(`/api/patients/${person.id}/card`, adminA.token);
    const statuses = (after.body.conclusions as { status: string; text: string; authorName: string }[]).map(
      (c) => [c.status, c.text],
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        ["signed", "Чернетка суперадміна"],
        ["draft", "Своя чернетка"],
      ]),
    );
    expect(after.body.conclusions).toHaveLength(2);
    expect(after.body.conclusions.every((c: { surveyTitle: string }) => c.surveyTitle.length > 0)).toBe(true);
  });

  /**
   * Мутация: снять `eq(patientGroups.ownerId, user.id)` из выборки групп на
   * карточке — проверка падает и называет чужую группу, показанную adminA.
   */
  test("«Групи» — только группы читателя, со счётчиком по зоне", async () => {
    const person = await patientOfA("groups");
    const mine = await makeGroup(adminA, "Моя вкладка");
    await api(`/api/patient-groups/${mine}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userIds: [person.id, (await patientOfA("groups-2")).id] }),
    });
    // та же персона в группе суперадмина — adminA её видеть не должен
    const theirs = await makeGroup(root, "Чужа вкладка");
    await api(`/api/patient-groups/${theirs}/members`, root.token, {
      method: "POST",
      body: JSON.stringify({ userIds: [person.id] }),
    });

    const card = await api(`/api/patients/${person.id}/card`, adminA.token);
    const groups = card.body.groups as {
      id: string;
      title: string;
      description: string;
      memberCount: number;
    }[];
    expect(groups.map((g) => g.id)).toEqual([mine]);
    expect(groups.map((g) => g.id), `на карточке чужая группа ${theirs}`).not.toContain(theirs);
    expect(groups[0]!.description).toBe("Опис Моя вкладка");
    expect(groups[0]!.memberCount).toBe(2);

    // суперадмин видит обе
    const rootCard = await api(`/api/patients/${person.id}/card`, root.token);
    expect((rootCard.body.groups as { id: string }[]).map((g) => g.id).sort()).toEqual([mine, theirs].sort());
  });

  test("«Підписатись / Відписатись» — закрепление за собой тем же маршрутом, что на приёме", async () => {
    const person = await patientOfA("lead");
    const take = await api(`/api/clinic/patients/${person.id}/lead`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ take: true }),
    });
    expect(take.status).toBe(200);

    const mine = await api(`/api/patients/${person.id}/card`, adminA.token);
    expect(mine.body.lead.specialistId).toBe(adminA.id);
    expect(mine.body.lead.mine).toBe(true);
    expect(mine.body.lead.name).toBeTruthy();

    // у другого читателя тот же ведущий, но не «мой»
    const asRoot = await api(`/api/patients/${person.id}/card`, root.token);
    expect(asRoot.body.lead.specialistId).toBe(adminA.id);
    expect(asRoot.body.lead.mine).toBe(false);

    await api(`/api/clinic/patients/${person.id}/lead`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ take: false }),
    });
    expect((await api(`/api/patients/${person.id}/card`, adminA.token)).body.lead).toBeNull();
  });
});

describe("карточка группы: пол и год рождения участника, описание методики", () => {
  test("участник приходит с полом и годом, методика — с описанием", async () => {
    const person = await patientOfA("member", { sex: "female", birthDate: "1979-12-31" });
    const groupId = await makeGroup(adminA, "Склад із полем");
    await api(`/api/patient-groups/${groupId}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });
    // методика с описанием — прямо в базе, в группе А: карточке нужно только оно
    const { surveys, groupA } = await import("./fixtures");
    const described = crypto.randomUUID();
    await db.insert(surveys).values({
      id: described,
      groupId: groupA,
      title: { uk: "Описана", ru: "Описанная" },
      description: { uk: "Про що ця методика", ru: "О чём эта методика" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      createdBy: adminA.id,
    } as never);
    await api(`/api/patient-groups/${groupId}/surveys`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: described, attemptsAllowed: 1 }),
    });

    const card = await api(`/api/patient-groups/${groupId}`, adminA.token);
    const member = card.body.members[0];
    expect(member.sex).toBe("female");
    expect(member.birthYear).toBe(1979);
    expect(Object.keys(member)).not.toContain("birthDate");
    expect(card.body.surveys).toHaveLength(1);
    // описание — локализованный объект, как название: экран сам выберет язык
    expect(card.body.surveys[0].description).toEqual({ uk: "Про що ця методика", ru: "О чём эта методика" });
  });
});

describe("пакетные состав и «обрана»", () => {
  /**
   * Список проверяется целиком до первой записи. Мутация: перенести
   * проверку зоны внутрь цикла вставки (по одному) — проверка падает и
   * называет того, кто успел попасть в группу до отказа.
   */
  test("добавление списком — всё или ничего; удаление списком считает убранных", async () => {
    const groupId = await makeGroup(adminA, "Пакет");
    const one = await patientOfA("batch-1");
    const two = await patientOfA("batch-2");
    const stranger = await makeUser("user", `pc-stranger-${crypto.randomUUID()}@test`);

    const refused = await api(`/api/patient-groups/${groupId}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userIds: [one.id, stranger.id] }),
    });
    expect(refused.status, `в группу попал пациент вне зоны: ${stranger.id}`).toBe(404);
    expect(
      await db.select().from(patientGroupMembers).where(eq(patientGroupMembers.groupId, groupId)),
    ).toEqual([]);

    const added = await api(`/api/patient-groups/${groupId}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userIds: [one.id, two.id, one.id] }),
    });
    expect(added.status).toBe(201);
    expect((added.body.userIds as string[]).sort()).toEqual([one.id, two.id].sort());
    const card = await api(`/api/patient-groups/${groupId}`, adminA.token);
    const members = (card.body.members as { userId: string }[]).map((m) => m.userId);
    expect(members.sort()).toEqual([one.id, two.id].sort());

    // чужую группу списком не тронуть — пока состав на месте, иначе 404 пришёл бы и без проверки
    const foreign = await api(`/api/patient-groups/${groupId}/members`, adminB.token, {
      method: "DELETE",
      body: JSON.stringify({ userIds: [one.id] }),
    });
    expect(foreign.status, `посторонний убрал ${one.id} из чужой группы ${groupId}`).toBe(404);
    expect(
      await db.select().from(patientGroupMembers).where(eq(patientGroupMembers.groupId, groupId)),
    ).toHaveLength(2);

    const removed = await api(`/api/patient-groups/${groupId}/members`, adminA.token, {
      method: "DELETE",
      body: JSON.stringify({ userIds: [one.id, two.id, stranger.id] }),
    });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(2);
    expect((await api(`/api/patient-groups/${groupId}`, adminA.token)).body.members).toEqual([]);

    const nobody = await api(`/api/patient-groups/${groupId}/members`, adminA.token, {
      method: "DELETE",
      body: JSON.stringify({ userIds: [one.id] }),
    });
    expect(nobody.status).toBe(404);
  });

  /**
   * Закладка — личная: ставится читателем, видна читателю, чужую группу не
   * открывает. Мутация: заменить `f.user_id = ${user.id}` в подвыборке
   * списка на `true` — падает проверка «закладка суперадмина не видна
   * владельцу».
   */
  test("«обрана» ставится, встаёт первой, снимается; чужая группа — не найдено; личная", async () => {
    const owner = await makeUser("admin", `pc-fav-${crypto.randomUUID()}@test`);
    const favourite = (id: string, who: Person) =>
      api(`/api/patient-groups/${id}/favourite`, who.token, { method: "PUT", body: "{}" });
    const first = await makeGroup(owner, "Перша");
    const second = await makeGroup(owner, "Друга");
    await api(`/api/patient-groups/${second}`, owner.token, {
      method: "PATCH",
      body: JSON.stringify({ position: 1 }),
    });

    const put = await favourite(second, owner);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ groupId: second, favourite: true });
    // повторно — не ошибка и не вторая строка
    expect((await favourite(second, owner)).status).toBe(200);
    expect(
      await db.select().from(patientGroupFavourites).where(eq(patientGroupFavourites.groupId, second)),
    ).toHaveLength(1);

    const list = await api("/api/patient-groups", owner.token);
    const rows = list.body.items as { id: string; favourite: boolean }[];
    expect(rows.map((g) => g.id)).toEqual([second, first]);
    expect(rows[0]!.favourite).toBe(true);
    expect(rows[1]!.favourite).toBe(false);

    // закладка суперадмина на ту же группу владельцу не видна — и наоборот
    await favourite(first, root);
    const ownerAgain = await api("/api/patient-groups", owner.token);
    const ownerRows = ownerAgain.body.items as { id: string; favourite: boolean }[];
    const firstRow = ownerRows.find((g) => g.id === first);
    expect(firstRow?.favourite, "закладка суперадмина переставила вкладку у владельца").toBe(false);
    const rootList = await api("/api/patient-groups", root.token);
    const rootRows = rootList.body.items as { id: string; favourite: boolean }[];
    expect(rootRows.find((g) => g.id === first)?.favourite).toBe(true);
    expect(rootRows.find((g) => g.id === second)?.favourite).toBe(false);

    const foreign = await favourite(first, adminB);
    expect(foreign.status, `закладка поставлена на чужую группу ${first}`).toBe(404);

    const del = await api(`/api/patient-groups/${second}/favourite`, owner.token, { method: "DELETE" });
    expect(del.status).toBe(204);
    const after = await api("/api/patient-groups", owner.token);
    const afterRows = after.body.items as { id: string; favourite: boolean }[];
    expect(afterRows.map((g) => [g.id, g.favourite])).toEqual([
      [first, false],
      [second, false],
    ]);
  });
});

describe("страховочная сетка под закладками", () => {
  test("политика включена и спрашивает и про читателя, и про владение группой", async () => {
    /*
     * Два условия И, и ни одно не лишнее: без владения сотрудник ставил бы
     * закладку на чужую группу по идентификатору и узнавал по ответу
     * «обрана: так», что коллега её завёл; без читателя владелец правил бы
     * закладки суперадмина. Читается из текста политики. Мутация: убрать
     * `rls_owns_patient_group` из 0084_patient_card.sql — проверка называет
     * потерянное условие.
     */
    const rows = await db.execute<{ relrowsecurity: boolean; qual: string; with_check: string | null }>(sql`
      select c.relrowsecurity, p.qual, p.with_check
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        left join pg_policies p on p.tablename = c.relname and p.schemaname = 'public'
       where ns.nspname = 'public' and c.relname = 'patient_group_favourites'
    `);
    const all = [...rows];
    expect(all.length, "у patient_group_favourites нет политики").toBeGreaterThan(0);
    expect(all[0]!.relrowsecurity, "RLS выключен на patient_group_favourites").toBe(true);
    for (const half of ["qual", "with_check"] as const) {
      const text = all.map((r) => String(r[half] ?? "")).join(" ");
      const missing = ["rls_owns_patient_group", "user_id", "app_uid"].filter((s) => !text.includes(s));
      expect(missing, `${half} политики patient_group_favourites потерял условие`).toEqual([]);
    }
  });
});

describe("описание маршрутов", () => {
  test("новые маршруты людей объявлены под patients.read", () => {
    const expected = [
      "GET /api/patients",
      "GET /api/patients/:id/card",
      "DELETE /api/patient-groups/:id/members",
      "PUT /api/patient-groups/:id/favourite",
      "DELETE /api/patient-groups/:id/favourite",
    ];
    for (const key of expected) {
      expect(ROUTE_DOCS[key], `${key} не описан`).toBeTruthy();
      expect(ROUTE_DOCS[key]!.permission, key).toBe("patients.read");
    }
  });
});
