import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  adminA,
  adminB,
  api,
  db,
  groupA,
  groupAdmins,
  groupB,
  makeUser,
  patient,
  root,
  surveyGroups,
  surveyInA,
  surveys,
  type Person,
} from "./fixtures";
import { auditLog, surveyFolders } from "../src/db/schema";

/**
 * Папки МЕТОДИК и страницы каталога.
 *
 * Проверяется не «работает ли кнопка», а то, что ломается молча: кто какие
 * папки видит и правит, может ли методика оказаться на полке чужого
 * отделения, что происходит с полкой при переезде методики и при удалении
 * папки, и не теряет ли страница строки на стыках.
 *
 * Каждая защита ниже проверена мутацией — снималась, и тест обязан был
 * упасть, назвав виновника поимённо. Где мутация надёжно не ловится (второй
 * ключ сортировки), это сказано прямо, а не выдано за проверку.
 */

type Folder = { id: string; groupId: string; parentId: string | null; title: string; startsOn: string };

async function makeFolder(
  actor: Person,
  groupId: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<Folder> {
  const res = await api("/api/survey-folders", actor.token, {
    method: "POST",
    body: JSON.stringify({ groupId, title, ...extra }),
  });
  expect(res.status, `заведение папки «${title}»: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as Folder;
}

/**
 * Методика прямо в базе, как в fixtures: ради каталога полное тело
 * конструктора не нужно, а строки без версии список и перенос понимают.
 */
async function makeSurveyRow(
  groupId: string | null,
  title: { uk: string; ru?: string },
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId,
    title,
    administration: "self",
    status: "draft",
    visibility: "public",
    createdBy: groupId === groupB ? adminB.id : adminA.id,
    ...extra,
  } as never);
  return id;
}

async function listFolders(actor: Person, groupId?: string): Promise<Folder[]> {
  const res = await api(`/api/survey-folders${groupId ? `?groupId=${groupId}` : ""}`, actor.token);
  expect(res.status).toBe(200);
  return res.body.items as Folder[];
}

describe("папка заводится и живёт в группе методик", () => {
  test("заводится с датой с макета, вкладывается и считает содержимое", async () => {
    const year = await makeFolder(adminA, groupA, "Тести за 2023", { startsOn: "2023-01-01" });
    expect(year.startsOn, "дата папки — то, что ввели, а не сегодня").toBe("2023-01-01");
    expect(year.parentId).toBeNull();

    // без даты — умолчание базы, сегодня; формат тот же, без времени и пояса
    const month = await makeFolder(adminA, groupA, "Тести за лютий 2023", { parentId: year.id });
    expect(month.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(month.parentId).toBe(year.id);

    const items = await listFolders(adminA, groupA);
    const listedYear = items.find((f) => f.id === year.id) as (Folder & { childCount: number }) | undefined;
    expect(listedYear, "заведённая папка не попала в список своей группы").toBeTruthy();
    expect(listedYear!.childCount, "вложенная папка не посчитана у родителя").toBe(1);
    expect(items.map((f) => f.id)).toContain(month.id);
  });

  test("правится название, дата, место и родитель", async () => {
    const a = await makeFolder(adminA, groupA, "Чернетка");
    const b = await makeFolder(adminA, groupA, "Куди переносимо");
    const res = await api(`/api/survey-folders/${a.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Скринінг", startsOn: "2024-03-01", position: 5, parentId: b.id }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Скринінг");
    expect(res.body.startsOn).toBe("2024-03-01");
    expect(res.body.position).toBe(5);
    expect(res.body.parentId).toBe(b.id);

    // возврат в корень — parentId: null, а не «не передавать»
    const toRoot = await api(`/api/survey-folders/${a.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ parentId: null }),
    });
    expect(toRoot.status).toBe(200);
    expect(toRoot.body.parentId).toBeNull();

    // пустое тело — не ошибка: сервер отдаёт папку как есть
    const empty = await api(`/api/survey-folders/${a.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(200);
  });

  /**
   * Главная проверка области видимости. Папка живёт в группе методик, и
   * сотрудник чужой группы не заводит в ней папок, не видит их, не правит и
   * не удаляет — отказ «не управляете группой» (403), как у самих методик,
   * а не «не найдено»: папка не личная и о людях ничего не говорит.
   *
   * Мутация: снять `assertGroupAccess` из POST /api/survey-folders — падает
   * первая проверка и называет группу; снять `assertSurveyFolderAccess` из
   * PATCH и DELETE — падают третья и четвёртая, каждая называет папку;
   * убрать условие по видимости из запроса списка — падает вторая.
   */
  test("чужая группа: папку не завести, не увидеть, не править, не удалить", async () => {
    const foreign = await api("/api/survey-folders", adminB.token, {
      method: "POST",
      body: JSON.stringify({ groupId: groupA, title: "Чужа полиця" }),
    });
    expect(foreign.status, `adminB завёл папку в группе ${groupA}, которой не ведёт`).toBe(403);

    const mine = await makeFolder(adminA, groupA, "Полиця групи А");
    const seen = await listFolders(adminB);
    expect(
      seen.map((f) => f.id),
      `GET /api/survey-folders отдал adminB папку ${mine.id} группы А`,
    ).not.toContain(mine.id);
    // и явный ?groupId= чужой группы даёт пустоту, а не чужие папки
    expect((await listFolders(adminB, groupA)).map((f) => f.id)).not.toContain(mine.id);

    const patched = await api(`/api/survey-folders/${mine.id}`, adminB.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Захоплено" }),
    });
    expect(patched.status, `PATCH /api/survey-folders/:id правит чужую папку ${mine.id}`).toBe(403);

    const deleted = await api(`/api/survey-folders/${mine.id}`, adminB.token, { method: "DELETE" });
    expect(deleted.status, `DELETE /api/survey-folders/:id удаляет чужую папку ${mine.id}`).toBe(403);

    // чужую папку не взять и родителем для своей
    const nested = await api("/api/survey-folders", adminB.token, {
      method: "POST",
      body: JSON.stringify({ groupId: groupB, title: "Під чужою", parentId: mine.id }),
    });
    expect(nested.status, `папка группы Б вложена в чужую папку ${mine.id}`).toBe(403);

    // суперадмин видит всё: ему разбирать чужие полки
    expect((await listFolders(root)).map((f) => f.id)).toContain(mine.id);
  });

  /**
   * Родитель — только из той же группы. Суперадмин видит обе группы, и
   * до проверки родства запрос доходит; без этой проверки крошки над папкой
   * вели бы в папку, которую читателям группы не видно.
   *
   * Мутация: убрать сравнение `parent.groupId !== input.groupId` из POST —
   * проверка падает и называет обе папки.
   */
  test("родителем не станет папка другой группы", async () => {
    const inA = await makeFolder(root, groupA, "Батько з групи А");
    const res = await api("/api/survey-folders", root.token, {
      method: "POST",
      body: JSON.stringify({ groupId: groupB, title: "Дитина з групи Б", parentId: inA.id }),
    });
    expect(res.status, `папка группы Б получила родителя ${inA.id} из группы А`).toBe(400);

    const own = await makeFolder(root, groupB, "Своя в Б");
    const moved = await api(`/api/survey-folders/${own.id}`, root.token, {
      method: "PATCH",
      body: JSON.stringify({ parentId: inA.id }),
    });
    expect(moved.status, `PATCH переставил папку ${own.id} под родителя ${inA.id} из другой группы`).toBe(400);
  });

  /**
   * Мутация: убрать `isDescendant` из PATCH — падает вторая проверка
   * (кольцо через две ступени). Убрать проверку «сама в себя» — падает
   * первая: CHECK в базе отвергает строку, но пятисоткой, а не 400.
   */
  test("папку не вложить в саму себя и в собственную подпапку", async () => {
    const a = await makeFolder(adminA, groupA, "Кільце А");
    const b = await makeFolder(adminA, groupA, "Кільце Б", { parentId: a.id });
    const c = await makeFolder(adminA, groupA, "Кільце В", { parentId: b.id });

    const self = await api(`/api/survey-folders/${a.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ parentId: a.id }),
    });
    expect(self.status, `папка ${a.id} стала собственным родителем`).toBe(400);

    const ring = await api(`/api/survey-folders/${a.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ parentId: c.id }),
    });
    expect(ring.status, `папка ${a.id} вложена в свою подпапку ${c.id}: крошки закольцованы`).toBe(400);

    // а сама структура не пострадала
    const rows = await db.select().from(surveyFolders).where(eq(surveyFolders.id, a.id));
    expect(rows[0]?.parentId).toBeNull();
  });
});

describe("методика на полке", () => {
  test("переносится в папку и обратно; каталог фильтруется по папке; перенос в журнале", async () => {
    const folder = await makeFolder(adminA, groupA, "Лютий 2023");
    const id = await makeSurveyRow(groupA, { uk: "На полиці", ru: "На полке" });

    const moved = await api(`/api/surveys/${id}/folder`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ folderId: folder.id }),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.folderId).toBe(folder.id);

    const card = await api(`/api/surveys/${id}`, adminA.token);
    expect(card.body.folderId, "карточка методики не знает своей папки").toBe(folder.id);

    const inFolder = await api(`/api/surveys?folder=${folder.id}`, adminA.token);
    expect((inFolder.body.items as { id: string }[]).map((s) => s.id)).toContain(id);
    const atRoot = await api("/api/surveys?folder=root", adminA.token);
    expect(
      (atRoot.body.items as { id: string }[]).map((s) => s.id),
      "методика из папки показана в корне каталога",
    ).not.toContain(id);

    // папка считает то, что в ней лежит
    const listed = (await listFolders(adminA, groupA)).find((f) => f.id === folder.id) as
      | (Folder & { surveyCount: number })
      | undefined;
    expect(listed?.surveyCount).toBe(1);

    // перенос — отдельное событие журнала, а не «правка методики»
    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "survey.move"), eq(auditLog.resourceId, id)));
    expect(trail.length, "перенос методики не попал в журнал как survey.move").toBeGreaterThan(0);

    const back = await api(`/api/surveys/${id}/folder`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ folderId: null }),
    });
    expect(back.status).toBe(200);
    expect(back.body.folderId).toBeNull();
  });

  /**
   * Методика лежит в папке СВОЕЙ группы — и только своей.
   *
   * Три уровня, и каждый нужен. Сотрудник до чужой папки не дотягивается
   * (403 по группе папки). Суперадмин дотягивается — и получает отказ по
   * самому правилу (400). А если правило обойти мимо маршрутов, строку не
   * примет база: составной ключ (folder_id, group_id) → survey_folders.
   *
   * Мутация: убрать сравнение групп из PUT /:id/folder — падает вторая
   * проверка и называет методику с папкой. Снять ограничение
   * surveys_folder_in_own_group_fk из миграции — падает третья: база приняла
   * методику группы А в папке группы Б.
   */
  test("в папку чужой группы не положить — ни маршрутом, ни мимо него", async () => {
    const shelfB = await makeFolder(adminB, groupB, "Полиця групи Б");

    const byAdmin = await api(`/api/surveys/${surveyInA}/folder`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ folderId: shelfB.id }),
    });
    expect(byAdmin.status, `adminA положил методику в папку ${shelfB.id} группы, которой не ведёт`).toBe(403);

    const id = await makeSurveyRow(groupA, { uk: "Методика групи А" });
    const byRoot = await api(`/api/surveys/${id}/folder`, root.token, {
      method: "PUT",
      body: JSON.stringify({ folderId: shelfB.id }),
    });
    expect(byRoot.status, `методика ${id} группы А положена в папку ${shelfB.id} группы Б`).toBe(400);

    let dbAccepted = true;
    try {
      await db.update(surveys).set({ folderId: shelfB.id }).where(eq(surveys.id, id));
    } catch {
      dbAccepted = false;
    }
    expect(dbAccepted, `база приняла методику ${id} группы А в папке ${shelfB.id} группы Б`).toBe(false);

    // у личного черновика без группы нет каталога, а значит, и полки
    const loose = await makeSurveyRow(null, { uk: "Особиста чернетка" });
    const shelfA = await makeFolder(adminA, groupA, "Полиця для чернетки");
    const looseMoved = await api(`/api/surveys/${loose}/folder`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ folderId: shelfA.id }),
    });
    expect(looseMoved.status, `методика без группы ${loose} положена в папку ${shelfA.id}`).toBe(400);
  });

  /**
   * Мутация: убрать `leavesGroup` (обнуление folderId) из PATCH
   * /api/surveys/:id — база отвергает строку составным ключом, маршрут
   * отвечает пятисоткой, проверка падает на статусе.
   */
  test("смена группы снимает методику с полки", async () => {
    const shelf = await makeFolder(adminA, groupA, "Полиця перед переїздом");
    const id = await makeSurveyRow(groupA, { uk: "Переїжджає" }, { folderId: shelf.id });

    const res = await api(`/api/surveys/${id}`, root.token, {
      method: "PATCH",
      body: JSON.stringify({ groupId: groupB }),
    });
    expect(res.status, `смена группы у методики ${id} на полке: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.groupId).toBe(groupB);
    expect(res.body.folderId, `методика ${id} уехала в группу Б вместе с полкой группы А`).toBeNull();

    // а смена чего угодно другого полку не трогает
    const back = await makeSurveyRow(groupA, { uk: "Залишається" }, { folderId: shelf.id });
    const renamed = await api(`/api/surveys/${back}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ title: { uk: "Перейменована" } }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.folderId, "правка названия сбросила папку").toBe(shelf.id);
  });

  test("копия ложится рядом с оригиналом", async () => {
    const shelf = await makeFolder(adminA, groupA, "Полиця з копією");
    const id = await makeSurveyRow(groupA, { uk: "Оригінал" }, { folderId: shelf.id });
    const copy = await api(`/api/surveys/${id}/duplicate`, adminA.token, { method: "POST" });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(copy.body.folderId, "копия методики выпала из папки оригинала в корень").toBe(shelf.id);
  });

  test("«+» на экране папки: методика заводится сразу в ней", async () => {
    const shelf = await makeFolder(adminA, groupA, "Полиця для нової");
    const created = await api("/api/surveys", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: { uk: "Нова в папці" }, groupId: groupA, folderId: shelf.id }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.folderId).toBe(shelf.id);

    // и здесь папка обязана быть из группы методики
    const shelfB = await makeFolder(adminB, groupB, "Не та група");
    const wrong = await api("/api/surveys", root.token, {
      method: "POST",
      body: JSON.stringify({ title: { uk: "Не туди" }, groupId: groupA, folderId: shelfB.id }),
    });
    expect(wrong.status, `методика группы А заведена в папке ${shelfB.id} группы Б`).toBe(400);
  });
});

describe("удаление папки", () => {
  /**
   * Мутация: считать в DELETE только методики в работе (`archived_at is
   * null`) — падает проверка со снятой методикой: папка удалена, методика
   * выпала в корень, и по списку этого не видно.
   */
  test("непустая не удаляется и называет содержимое; пустая удаляется", async () => {
    const shelf = await makeFolder(adminA, groupA, "Не порожня");
    const id = await makeSurveyRow(groupA, { uk: "Всередині" }, { folderId: shelf.id });

    const withSurvey = await api(`/api/survey-folders/${shelf.id}`, adminA.token, { method: "DELETE" });
    expect(withSurvey.status, `папка ${shelf.id} с методикой удалена`).toBe(400);
    expect(String(withSurvey.body.error)).toContain("методик: 1");

    // снятая с использования методика всё ещё лежит в папке и держит её
    await db.update(surveys).set({ archivedAt: new Date().toISOString() }).where(eq(surveys.id, id));
    const withArchived = await api(`/api/survey-folders/${shelf.id}`, adminA.token, { method: "DELETE" });
    expect(withArchived.status, `папка ${shelf.id} со снятой методикой ${id} удалена`).toBe(400);

    const parent = await makeFolder(adminA, groupA, "Із вкладеною");
    await makeFolder(adminA, groupA, "Вкладена", { parentId: parent.id });
    const withChild = await api(`/api/survey-folders/${parent.id}`, adminA.token, { method: "DELETE" });
    expect(withChild.status, `папка ${parent.id} с вложенной удалена`).toBe(400);
    expect(String(withChild.body.error)).toContain("папок: 1");

    const empty = await makeFolder(adminA, groupA, "Порожня");
    const gone = await api(`/api/survey-folders/${empty.id}`, adminA.token, { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect((await listFolders(adminA, groupA)).map((f) => f.id)).not.toContain(empty.id);

    const again = await api(`/api/survey-folders/${empty.id}`, adminA.token, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  /**
   * Полка исчезла мимо маршрута — методика осталась и потеряла только папку.
   *
   * Мутация: заменить в миграции `ON DELETE SET NULL (folder_id)` на обычный
   * `ON DELETE SET NULL` — обнулится и group_id, и проверка называет
   * методику, выведенную из отделения удалением полки. Убрать SET NULL
   * вовсе — удаление отвергнуто ключом, падает первая проверка.
   */
  test("удаление полки мимо маршрута не уносит методику и не выводит её из группы", async () => {
    const shelf = await makeFolder(adminA, groupA, "Зникає з бази");
    const id = await makeSurveyRow(groupA, { uk: "Переживе полицю" }, { folderId: shelf.id });

    let deleted = true;
    try {
      await db.delete(surveyFolders).where(eq(surveyFolders.id, shelf.id));
    } catch {
      deleted = false;
    }
    expect(deleted, `папку ${shelf.id} с методикой нельзя удалить даже из базы: методика заперла её`).toBe(true);

    const [row] = await db.select().from(surveys).where(eq(surveys.id, id));
    expect(row, `методика ${id} исчезла вместе с полкой`).toBeTruthy();
    expect(row!.folderId).toBeNull();
    expect(row!.groupId, `методика ${id} выведена из группы удалением полки`).toBe(groupA);
  });
});

describe("каталог: страницы, вкладки, поиск", () => {
  /** Своя группа — чтобы счёт не зависел от того, что насыпали соседние тесты */
  let catalog: string;
  let ids: string[];

  beforeAll(async () => {
    catalog = crypto.randomUUID();
    await db.insert(surveyGroups).values({ id: catalog, title: "Каталог", createdBy: root.id });
    await db.insert(groupAdmins).values({ groupId: catalog, userId: adminA.id, addedBy: root.id });
    ids = [];
    const titles: { uk: string; ru?: string; status?: string }[] = [
      { uk: "Шкала тривоги Бека", ru: "Шкала тревоги Бека", status: "published" },
      { uk: "Опитувальник 100% сну", status: "published" },
      { uk: "Опитувальник 100 питань", status: "published" },
      { uk: "Чернетка перша" },
      { uk: "Чернетка друга" },
    ];
    for (const t of titles) {
      ids.push(
        await makeSurveyRow(
          catalog,
          { uk: t.uk, ru: t.ru },
          { status: t.status ?? "draft", createdBy: adminA.id },
        ),
      );
    }
  });

  test("без параметров — весь список, как раньше, и total равен длине", async () => {
    const res = await api("/api/surveys", adminA.token);
    expect(res.status).toBe(200);
    const items = res.body.items as { id: string }[];
    expect(items.map((s) => s.id)).toContain(surveyInA);
    for (const id of ids) expect(items.map((s) => s.id)).toContain(id);
    expect(res.body.total, "total без страницы не равен длине списка").toBe(items.length);
  });

  /**
   * Страницы не пересекаются и вместе дают всё; total на каждой — по тем же
   * условиям, что и страница.
   *
   * Мутация: убрать `.offset(query.offset)` — страницы повторяют первую,
   * проверка называет повторившиеся идентификаторы. Убрать отдельный
   * подсчёт total — на странице из двух он равен двум, а не пяти.
   *
   * Что здесь НЕ проверяется, и это надо сказать вслух: второй ключ
   * сортировки (`desc(surveys.id)`). Пять строк с равным created_at Postgres
   * почти всегда отдаёт в одном порядке, и мутация на нём зелёная в девяти
   * запусках из десяти — сторож, который иногда молчит, хуже отсутствующего.
   */
  test("страницы не пересекаются, покрывают всё и несут общий total", async () => {
    const seen: string[] = [];
    const sizes: number[] = [];
    for (const offset of [0, 2, 4]) {
      const res = await api(`/api/surveys?groupId=${catalog}&limit=2&offset=${offset}`, adminA.token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.total, `total на странице offset=${offset}`).toBe(5);
      const page = (res.body.items as { id: string }[]).map((s) => s.id);
      sizes.push(page.length);
      seen.push(...page);
    }
    // сначала повторы — они называют виновника; размеры страниц лишь подтверждают
    const dup = seen.filter((id, i) => seen.indexOf(id) !== i);
    expect(dup, `методики попали на две страницы: ${dup.join(", ")}`).toEqual([]);
    expect(sizes).toEqual([2, 2, 1]);
    expect([...seen].sort()).toEqual([...ids].sort());

    // за последней страницей — пусто, но total на месте: «сторінка 4 з 3» быть не должно
    const beyond = await api(`/api/surveys?groupId=${catalog}&limit=2&offset=10`, adminA.token);
    expect(beyond.body.items).toEqual([]);
    expect(beyond.body.total).toBe(5);

    // мусор в параметрах — честная четырёхсотка, а не NaN в LIMIT
    expect((await api("/api/surveys?limit=abc", adminA.token)).status).toBe(400);
    expect((await api("/api/surveys?limit=0", adminA.token)).status).toBe(400);
  });

  test("вкладки «Опубліковані / Неопубліковані» — ?status=", async () => {
    const published = await api(`/api/surveys?groupId=${catalog}&status=published`, adminA.token);
    expect(published.body.total).toBe(3);
    expect((published.body.items as { status: string }[]).every((s) => s.status === "published")).toBe(true);

    const drafts = await api(`/api/surveys?groupId=${catalog}&status=draft&limit=1`, adminA.token);
    expect(drafts.body.total, "total по вкладке считается по вкладке, а не по всему каталогу").toBe(2);
    expect(drafts.body.items).toHaveLength(1);

    // неизвестная вкладка — отказ, а не молчаливо «все»
    expect((await api("/api/surveys?status=bogus", adminA.token)).status).toBe(400);
  });

  /**
   * Мутация: убрать экранирование подстановочных знаков в ?q= — «100%»
   * находит и «100 питань», проверка называет лишнюю методику.
   */
  test("поиск по названию: подстрока, без регистра, на любом языке, % и _ — буквально", async () => {
    const titlesOf = async (q: string) => {
      const res = await api(`/api/surveys?groupId=${catalog}&q=${encodeURIComponent(q)}`, adminA.token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body.items as { title: string }[]).map((s) => s.title);
    };

    expect(await titlesOf("тривог")).toEqual(["Шкала тривоги Бека"]);
    // по русскому названию тоже находится, а отдаётся на языке запроса
    expect(await titlesOf("ТРЕВОГ")).toEqual(["Шкала тривоги Бека"]);
    expect(await titlesOf("опитувальник")).toHaveLength(2);

    const percent = await titlesOf("100%");
    expect(percent, `«100%» прочитан как шаблон: лишнее — ${percent.join(", ")}`).toEqual([
      "Опитувальник 100% сну",
    ]);
    expect(await titlesOf("нічого такого немає")).toEqual([]);
  });

  test("пациент папок не видит, а фильтры каталога чужого ему не открывают", async () => {
    const folders = await api("/api/survey-folders", patient.token);
    expect(folders.status, "пациенту отдан список папок каталога").toBe(403);

    const shelf = await makeFolder(adminA, catalog, "Внутрішня розкладка");
    await db.update(surveys).set({ folderId: shelf.id }).where(eq(surveys.id, ids[3]!));
    // черновик в папке пациенту не виден, хотя папка названа прямо
    const res = await api(`/api/surveys?folder=${shelf.id}`, patient.token);
    expect(res.status).toBe(200);
    expect((res.body.items as { id: string }[]).map((s) => s.id)).not.toContain(ids[3]);
  });
});

describe("страховочная сетка под папками методик", () => {
  /**
   * Таблица без политики — дыра, которую видно только проверкой покрытия.
   *
   * Общая проверка в access.test.ts находит клинические таблицы по
   * колонкам со ссылкой на человека (user_id, patient_id …); у survey_folders
   * такой колонки нет — created_by, — и под неё таблица не попадает. Поэтому
   * здесь она названа поимённо.
   *
   * Мутация: удалить CREATE POLICY из миграции 0080 — падает первая
   * проверка; удалить ENABLE ROW LEVEL SECURITY — вторая.
   */
  test("у таблицы папок есть политика строк, и она включена", async () => {
    const policies = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_policies
       where schemaname = 'public' and tablename = 'survey_folders'
    `);
    expect(Number([...policies][0]?.n ?? 0), "survey_folders осталась без политики строк").toBeGreaterThan(0);

    const rls = await db.execute<{ relrowsecurity: boolean }>(sql`
      select c.relrowsecurity from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname = 'survey_folders'
    `);
    expect([...rls][0]?.relrowsecurity, "политика на survey_folders есть, но RLS не включён").toBe(true);
  });

  /**
   * WITH CHECK проверяется отдельно от USING: без него сотрудник мог бы
   * завести папку в группу, которой не ведёт. Потерять эту половину можно
   * одной правкой, и USING останется на месте — сторож по числу политик не
   * заметит.
   *
   * Мутация: убрать WITH CHECK из CREATE POLICY — падает вторая проверка.
   */
  test("политика спрашивает у группы — и на чтение, и на запись", async () => {
    const rows = await db.execute<{ qual: string; with_check: string | null }>(sql`
      select qual, with_check from pg_policies
       where schemaname = 'public' and tablename = 'survey_folders'
    `);
    const all = [...rows];
    const qual = all.map((r) => String(r.qual)).join(" ");
    const check = all.map((r) => String(r.with_check ?? "")).join(" ");
    expect(qual.includes("rls_admin_manages_group") && qual.includes("group_id"), `USING: ${qual}`).toBe(true);
    expect(
      check.includes("rls_admin_manages_group") && check.includes("group_id"),
      `WITH CHECK: ${check}`,
    ).toBe(true);
  });

  /**
   * Предикат политики — спрошенный у базы напрямую.
   *
   * Проверить политику поведением здесь НЕЛЬЗЯ: тесты ходят в базу
   * владельцем (на этой машине — суперпользователем с BYPASSRLS), а такой
   * пользователь политики обходит даже под `force row level security`.
   * Проверка вида «adminB не видит папку группы А» была бы зелёной и при
   * полном отсутствии политик. Поэтому проверяются две половины порознь:
   * что политика ССЫЛАЕТСЯ на предикат (выше) и что предикат ОТВЕЧАЕТ
   * правильно (здесь). Функция обычная, суперпользователь её не обходит.
   *
   * Мутация: расширить `rls_admin_manages_group` до «любой admin» — падает
   * проверка с adminB и называет его и группу.
   */
  test("предикат «веду группу» отвечает «да» администратору и «нет» остальным", async () => {
    const { baseDb } = await import("../src/db");
    const { withDbContext } = await import("../src/db/context");

    const askAs = (who: Person, role: "admin" | "user") =>
      withDbContext(baseDb, { userId: who.id, role }, async () => {
        const rows = await db.execute<{ a: boolean; b: boolean }>(sql`
          select rls_admin_manages_group(${groupA}) as a, rls_admin_manages_group(${groupB}) as b
        `);
        return [...rows][0]!;
      });

    const own = await askAs(adminA, "admin");
    expect(own.a, "администратор группы А не признан ведущим её").toBe(true);
    expect(own.b, `предикат признал adminA ведущим чужую группу ${groupB}`).toBe(false);

    const other = await askAs(adminB, "admin");
    expect(other.a, `предикат признал постороннего сотрудника ${adminB.id} ведущим группу ${groupA}`).toBe(false);

    const asPatient = await askAs(patient, "user");
    expect(asPatient.a, `предикат признал пациента ${patient.id} ведущим группу ${groupA}`).toBe(false);

    // без контекста — «нет», а не ошибка: забытый requireAuth упирается в пустоту
    const nobody = await withDbContext(baseDb, { userId: null, role: "system" }, async () => {
      const rows = await db.execute<{ a: boolean }>(sql`select rls_admin_manages_group(${groupA}) as a`);
      return [...rows][0]!;
    });
    expect(nobody.a).toBe(false);
  });
});

describe("имена не путаются", () => {
  test("папка методик не появляется ни среди групп методик, ни среди групп пациентов", async () => {
    /*
     * Три сущности зовутся похоже, и склеить их можно одним неверным
     * импортом таблицы. Проверка от опечатки в маршрутизации, а не от
     * непонимания.
     */
    const title = `Полиця ${crypto.randomUUID().slice(0, 8)}`;
    const shelf = await makeFolder(adminA, groupA, title);

    const groups = await api("/api/groups", root.token);
    expect((groups.body.items as { title: string }[]).map((g) => g.title)).not.toContain(title);
    const patientGroups = await api("/api/patient-groups", root.token);
    expect((patientGroups.body.items as { title: string }[]).map((g) => g.title)).not.toContain(title);

    const rows = await db.select().from(surveyFolders).where(eq(surveyFolders.id, shelf.id));
    expect(rows).toHaveLength(1);

    // и у сотрудника без права на методики папок нет вовсе, даже пустого списка
    const clerk = await makeUser("admin", `folders-clerk-${crypto.randomUUID()}@test`);
    const { staffRoles } = await import("../src/db/schema");
    await db.delete(staffRoles).where(eq(staffRoles.userId, clerk.id));
    const res = await api("/api/survey-folders", clerk.token);
    expect(res.status).toBe(403);
  });
});
