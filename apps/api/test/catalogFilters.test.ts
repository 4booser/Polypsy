import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, adminB, api, db, groupAdmins, patient, root, surveyGroups, surveys, type Person } from "./fixtures";

/**
 * Фильтры каталога, которых не хватило экрану волны 3: вкладка «Зняті»
 * (только снятые), несколько вкладок одним запросом, поиск из папки по её
 * поддереву.
 *
 * Каждая защита проверена мутацией — снималась, и тест обязан был упасть,
 * назвав виновника. Тестовый пользователь базы обходит RLS, поэтому
 * разграничение проверяется через API от лица разных людей, а не прямыми
 * запросами к таблицам.
 */

type Folder = { id: string; parentId: string | null };

async function makeFolder(actor: Person, groupId: string, title: string, parentId?: string): Promise<Folder> {
  const res = await api("/api/survey-folders", actor.token, {
    method: "POST",
    body: JSON.stringify({ groupId, title, ...(parentId ? { parentId } : {}) }),
  });
  expect(res.status, `заведение папки «${title}»: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as Folder;
}

/**
 * Методика прямо в базе: каталогу полное тело конструктора не нужно.
 * Опубликована и общедоступна по умолчанию — чтобы пациенту её прятало
 * только то, что проверяется, а не статус.
 */
async function makeSurveyRow(groupId: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId,
    title: { uk: title },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    createdBy: adminA.id,
    ...extra,
  } as never);
  return id;
}

const idsOf = (body: { items: { id: string }[] }) => body.items.map((s) => s.id);

describe("каталог: снятые, несколько вкладок, поиск по поддереву", () => {
  /** Своя группа — чтобы выдача не зависела от того, что насыпали соседние тесты */
  let catalog: string;
  let year: Folder;
  let month: Folder;
  let atRoot: string;
  let inYear: string;
  let inMonth: string;
  let retired: string;
  let closed: string;
  let draft: string;

  beforeAll(async () => {
    catalog = crypto.randomUUID();
    await db.insert(surveyGroups).values({ id: catalog, title: "Каталог фільтрів", createdBy: root.id });
    await db.insert(groupAdmins).values({ groupId: catalog, userId: adminA.id, addedBy: root.id });

    year = await makeFolder(adminA, catalog, "Тести за 2023");
    month = await makeFolder(adminA, catalog, "Лютий 2023", year.id);

    atRoot = await makeSurveyRow(catalog, "Шкала тривоги в корені");
    inYear = await makeSurveyRow(catalog, "Шкала тривоги за рік", { folderId: year.id });
    inMonth = await makeSurveyRow(catalog, "Шкала тривоги за лютий", { folderId: month.id });
    /*
     * Снятая методика опубликована и общедоступна намеренно: единственное,
     * что прячет её от пациента, — снятие. Иначе проверка «пациенту
     * ?archived= снятых не открывает» держалась бы на статусе, а не на защите.
     */
    retired = await makeSurveyRow(catalog, "Знята методика", {
      archivedAt: new Date().toISOString(),
      archivedBy: adminA.id,
    });
    closed = await makeSurveyRow(catalog, "Закрита методика", { status: "closed" });
    draft = await makeSurveyRow(catalog, "Чернетка", { status: "draft" });
  });

  /**
   * Мутация: считать `only` как `1` (снятые вместе с остальными) — первая
   * проверка называет методики в работе, попавшие во вкладку «Зняті».
   * Мутация: убрать `isStaff(user)` перед чтением параметра — снятую
   * пациент всё равно не получит, её держит и patientVisibilityFilter; зато
   * `only` вместе с ним даёт противоречие, и список пациента пустеет —
   * это и называет последняя проверка.
   */
  test("?archived=only — только снятые; ?archived=1 — вместе; без параметра — ни одной", async () => {
    const only = await api(`/api/surveys?groupId=${catalog}&archived=only`, adminA.token);
    expect(only.status, JSON.stringify(only.body)).toBe(200);
    expect(idsOf(only.body), "во вкладке «Зняті» — методики в работе").toEqual([retired]);
    expect(only.body.total, "total вкладки считается по вкладке").toBe(1);

    const both = idsOf((await api(`/api/surveys?groupId=${catalog}&archived=1`, adminA.token)).body);
    expect(both, "?archived=1 перестал добавлять снятые к остальным").toContain(retired);
    expect(both).toContain(atRoot);

    const plain = idsOf((await api(`/api/surveys?groupId=${catalog}`, adminA.token)).body);
    expect(plain, "снятая методика показана без запроса").not.toContain(retired);

    // пациенту параметр не даёт ничего — и не отнимает: снятая не проходится, а свой список остаётся своим
    const asPatient = await api("/api/surveys?archived=only", patient.token);
    expect(asPatient.status).toBe(200);
    expect(idsOf(asPatient.body), `пациенту открыта снятая методика ${retired}`).not.toContain(retired);
    const patientPlain = await api("/api/surveys", patient.token);
    expect(idsOf(asPatient.body), "?archived=only опустошил список пациента").toEqual(idsOf(patientPlain.body));

    // мусор в параметре — честная четырёхсотка, а не молчаливо «в работе»
    expect((await api("/api/surveys?archived=yes", adminA.token)).status).toBe(400);
  });

  /**
   * Мутация: оставить `eq(surveys.status, …)` по первому элементу списка —
   * закрытая методика пропадает из «published,closed», проверка называет её.
   */
  test("?status= принимает несколько вкладок через запятую", async () => {
    const res = await api(`/api/surveys?groupId=${catalog}&status=published,closed`, adminA.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = idsOf(res.body);
    expect(ids, `закрытая методика ${closed} не попала в «published,closed»`).toContain(closed);
    expect(ids).toContain(atRoot);
    expect(ids, "черновик попал в «published,closed»").not.toContain(draft);
    expect(res.body.total).toBe(ids.length);

    // одиночное значение работает как прежде
    expect(idsOf((await api(`/api/surveys?groupId=${catalog}&status=closed`, adminA.token)).body)).toEqual([closed]);
    // неизвестная вкладка в списке — отказ целиком, а не молчаливо «остальные»
    expect((await api("/api/surveys?status=published,bogus", adminA.token)).status).toBe(400);
  });

  /**
   * Мутация: вернуть `eq(surveys.folderId, query.folder)` и при ?q= —
   * методика из вложенной папки не находится, проверка называет её.
   * Мутация: искать поддерево и без ?q= — годовая папка показывает
   * методику из месяца, проверка называет лишнюю.
   */
  test("?q= из папки ищет по её поддереву, без ?q= папка показывает свой уровень", async () => {
    const search = (folder: string, q: string, actor: Person = adminA) =>
      api(`/api/surveys?groupId=${catalog}&folder=${folder}&q=${encodeURIComponent(q)}`, actor.token);

    const fromYear = await search(year.id, "тривог");
    expect(fromYear.status, JSON.stringify(fromYear.body)).toBe(200);
    const found = idsOf(fromYear.body);
    expect(found, `методика ${inMonth} из вложенной папки не найдена поиском из родительской`).toContain(inMonth);
    expect(found).toContain(inYear);
    expect(found, "поиск из папки нашёл методику из корня").not.toContain(atRoot);
    expect(fromYear.body.total, "total поиска считается по поддереву").toBe(2);

    // поддерево идёт вниз, а не вверх: из месяца годовая не видна
    expect(idsOf((await search(month.id, "тривог")).body)).toEqual([inMonth]);

    // без ?q= — по-прежнему только свой уровень: вложенные папки экран рисует отдельно
    const level = idsOf((await api(`/api/surveys?groupId=${catalog}&folder=${year.id}`, adminA.token)).body);
    expect(level, "папка без поиска показала вложенное").toEqual([inYear]);

    // корень с ?q= — по-прежнему методики вне папок: корень не папка, у него нет поддерева
    expect(idsOf((await search("root", "тривог")).body)).toEqual([atRoot]);

    // чужая папка с поиском — пустая страница, а не чужие методики: зона видимости остаётся
    const foreign = await search(year.id, "тривог", adminB);
    expect(foreign.status).toBe(200);
    expect(idsOf(foreign.body), "поиск по поддереву открыл чужому сотруднику методики").toEqual([]);
  });
});
