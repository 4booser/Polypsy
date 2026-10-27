import { beforeAll, describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import { NO_DOMAIN, type SurveyDomain } from "@quizzy/shared";
import {
  adminA,
  adminB,
  api,
  appApi,
  db,
  eq,
  groupAdmins,
  patient,
  root,
  surveyGroups,
  surveys,
  type Person,
} from "./fixtures";
import { surveyVersions } from "../src/db/schema";
import { CATALOG } from "../src/instruments/catalog";
import { CATALOG_DOMAINS, catalogDomain } from "../src/instruments/catalogDomains";
import { catalogStatus, installCatalog } from "../src/lib/catalogInstall";

/**
 * Направление методики (surveys.domain): установщик каталога, фильтр
 * ?domain= и поле списка, правка из конструктора.
 *
 * Установщик ведёт направление как настройку каталога: ставит из карты
 * instruments/catalogDomains.ts, правку учреждения сохраняет, смену карты
 * доводит до нетронутых — и всё это без новой версии: направление не
 * содержимое. Фильтр проверяется и владельцем базы, и ролью приложения
 * (appApi): каталог открывают и сотрудник, и обследуемый, а роль владельца
 * политики строк обходит.
 *
 * База общая на процесс: методики каталога, которые здесь трогаются, после
 * каждого теста возвращаются к редакции каталога, а свои строки — в своей
 * группе.
 */

const SLOW = 30_000;
const idsOf = (body: { items: { id: string }[] }) => body.items.map((s) => s.id);

async function catalogRow(key: string) {
  const [row] = await db.select().from(surveys).where(eq(surveys.catalogKey, key));
  if (!row) throw new Error(`методика каталога «${key}» не стоит`);
  return row;
}

async function versionCount(surveyId: string): Promise<number> {
  const rows = await db.select({ id: surveyVersions.id }).from(surveyVersions).where(eq(surveyVersions.surveyId, surveyId));
  return rows.length;
}

/** Строка «до 0133»: направления нет ни в строке, ни в снимке настроек */
async function asBeforeDomains(surveyId: string, opts: { noSnapshot?: boolean } = {}) {
  await db
    .update(surveys)
    .set({
      domain: null,
      // источник для персонала моложе направления: строка «до 0133» не знала и его
      sourceNote: null,
      catalogFields: opts.noSnapshot ? null : sql`${surveys.catalogFields} - 'domain' - 'sourceNote'`,
    } as never)
    .where(eq(surveys.id, surveyId));
}

describe("установщик: направление из карты", () => {
  beforeAll(async () => {
    await installCatalog();
  }, SLOW);

  test(
    "у каждой методики каталога — направление карты, и оно же в снимке настроек",
    async () => {
      const rows = await db.select().from(surveys).where(inArray(surveys.catalogKey, CATALOG.map((e) => e.key)));
      expect(rows.length).toBe(CATALOG.length);
      for (const row of rows) {
        const want = catalogDomain(row.catalogKey!);
        expect(want, `«${row.catalogKey}» без строки в catalogDomains.ts`).not.toBeNull();
        expect(row.domain, `«${row.catalogKey}»`).toBe(want);
        expect((row.catalogFields as { domain?: string } | null)?.domain, `снимок «${row.catalogKey}»`).toBe(want!);
      }
      // повторный прогон ничего не пишет: ни направления, ни новых методик
      const again = await installCatalog();
      expect(again.domainSet).toEqual([]);
      expect(again.installed).toEqual([]);
    },
    SLOW,
  );

  /**
   * Методика, поставленная до 0133: в строке пусто, в снимке поля нет.
   * Мутация: сравнивать пустое поле моложе снимка с картой, а не с умолчанием
   * (NEWER_THAN_SNAPSHOT) — пустое считается правкой учреждения, и первое же
   * ожидание падает: направление не проставлено.
   * Мутация: синхронизировать направление обычным обновлением — выйдет новая
   * версия, и падает сверка числа версий.
   */
  test(
    "стоявшая до направлений методика получает его без новой версии и без смены даты",
    async () => {
      const before = await catalogRow("phq9");
      await asBeforeDomains(before.id);
      const versions = await versionCount(before.id);

      const report = await installCatalog();
      expect(report.domainSet, "направление не проставлено стоявшей методике").toContain("phq9");
      expect(report.skipped, "методика той же редакции ушла не в «уже стояли»").toContain("phq9");
      const after = await catalogRow("phq9");
      expect(after.domain).toBe("distress");
      expect((after.catalogFields as { domain?: string }).domain).toBe("distress");
      expect(await versionCount(before.id), "направление выпустило версию").toBe(versions);
      expect(after.updatedAt, "каталог датировал бы методику сегодняшним днём").toBe(before.updatedAt);

      // и только один раз
      expect((await installCatalog()).domainSet).not.toContain("phq9");
    },
    SLOW,
  );

  /**
   * До 0118 снимка нет вовсе. Направление ложится в снимок одно — и прочие
   * поля такой строки сверяются с редакцией каталога, как и до 0118: правкой
   * учреждения не становится ничего.
   */
  test(
    "стоявшая до снимков методика: направление ложится, прочие поля не становятся «правкой учреждения»",
    async () => {
      const row = await catalogRow("gds15");
      await asBeforeDomains(row.id, { noSnapshot: true });
      expect((await catalogStatus()).find((r) => r.key === "gds15")!.localFields).toEqual([]);

      const report = await installCatalog();
      expect(report.domainSet).toContain("gds15");
      expect((await catalogRow("gds15")).domain).toBe("distress");
      expect((await catalogStatus()).find((r) => r.key === "gds15")!.localFields).toEqual([]);
      expect((await installCatalog()).domainSet).not.toContain("gds15");
    },
    SLOW,
  );

  /**
   * Мутация: в syncDomain брать направление карты без localFields — выбор
   * учреждения перетирается на первом же выкате, первое ожидание падает.
   */
  test(
    "направление, выбранное учреждением, выкат сохраняет; --force возвращает каталоговое",
    async () => {
      const row = await catalogRow("gad7");
      const patched = await api(`/api/surveys/${row.id}`, root.token, {
        method: "PATCH",
        body: JSON.stringify({ domain: "other" }),
      });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect((await catalogStatus()).find((r) => r.key === "gad7")!.localFields).toEqual(["domain"]);

      const report = await installCatalog();
      expect(report.domainSet).not.toContain("gad7");
      expect((await catalogRow("gad7")).domain, "выкат перетёр направление учреждения").toBe("other");

      const forced = await installCatalog({ force: ["gad7"] });
      expect(forced.updated).toContain("gad7");
      expect(forced.domainSet).toContain("gad7");
      expect((await catalogRow("gad7")).domain).toBe("distress");
      expect((await catalogStatus()).find((r) => r.key === "gad7")!.localFields).toEqual([]);
    },
    SLOW,
  );

  test(
    "смена карты доходит до нетронутой методики, правленная — остаётся своей",
    async () => {
      const map = CATALOG_DOMAINS as Record<string, SurveyDomain>;
      const own = await catalogRow("osss3");
      await api(`/api/surveys/${own.id}`, root.token, { method: "PATCH", body: JSON.stringify({ domain: "staff" }) });
      map.who5 = "other";
      map.osss3 = "other";
      try {
        const report = await installCatalog();
        expect(report.domainSet).toContain("who5");
        expect((await catalogRow("who5")).domain).toBe("other");
        expect((await catalogRow("osss3")).domain, "правка учреждения уступила карте").toBe("staff");
      } finally {
        map.who5 = "wellbeing";
        map.osss3 = "wellbeing";
      }
      const back = await installCatalog();
      expect(back.domainSet).toContain("who5");
      expect((await catalogRow("who5")).domain).toBe("wellbeing");
      // правленную возвращает к каталогу только явное решение
      expect((await catalogRow("osss3")).domain).toBe("staff");
      await installCatalog({ force: ["osss3"] });
      expect((await catalogRow("osss3")).domain).toBe("wellbeing");
    },
    SLOW,
  );

  /**
   * Мутация: в ветке keptLocal возвращаться, не сверив направление, — первое
   * ожидание падает: методика с правленным содержимым выпадает из чипов.
   */
  test(
    "методика с содержимым учреждения получает направление, а её версия остаётся её",
    async () => {
      const row = await catalogRow("ucla3");
      const [head] = await db
        .select()
        .from(surveyVersions)
        .where(eq(surveyVersions.surveyId, row.id))
        .orderBy(sql`${surveyVersions.version} desc`)
        .limit(1);
      await db.update(surveyVersions).set({ note: "Правка відділення" }).where(eq(surveyVersions.id, head!.id));
      await asBeforeDomains(row.id);
      const versions = await versionCount(row.id);

      const report = await installCatalog();
      expect(report.keptLocal).toContain("ucla3");
      expect(report.domainSet, "правленная в учреждении методика осталась без направления").toContain("ucla3");
      expect((await catalogRow("ucla3")).domain).toBe("wellbeing");
      expect(await versionCount(row.id)).toBe(versions);

      // вернуть редакцию каталога, как было: база общая на процесс
      await installCatalog({ force: ["ucla3"] });
      expect((await catalogStatus()).find((r) => r.key === "ucla3")!.state).toBe("current");
    },
    SLOW,
  );
});

describe("каталог: фильтр ?domain= и поле domain", () => {
  /** Своя группа: выдача не зависит от того, что насыпали соседние файлы */
  let shelf: string;
  let parent: { id: string };
  let child: { id: string };
  let sleepAtRoot: string;
  let sleepInChild: string;
  let unclassified: string;

  async function makeFolder(actor: Person, title: string, parentId?: string) {
    const res = await api("/api/survey-folders", actor.token, {
      method: "POST",
      body: JSON.stringify({ groupId: shelf, title, ...(parentId ? { parentId } : {}) }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  /** Методика конструктором — тем же путём, что у отделения: направление приходит телом */
  async function makeSurvey(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await api("/api/surveys", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: { uk: title, ru: title }, groupId: shelf, ...extra }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await db
      .update(surveys)
      .set({ status: "published", publishedAt: new Date().toISOString() })
      .where(eq(surveys.id, res.body.id));
    return res.body.id as string;
  }

  beforeAll(async () => {
    await installCatalog();
    shelf = crypto.randomUUID();
    await db.insert(surveyGroups).values({ id: shelf, title: "Полиця напрямів", createdBy: root.id });
    await db.insert(groupAdmins).values({ groupId: shelf, userId: adminA.id, addedBy: root.id });
    parent = await makeFolder(adminA, "Сон 2026");
    child = await makeFolder(adminA, "Жовтень", parent.id);
    sleepAtRoot = await makeSurvey("Щоденник сну (корінь)", { domain: "sleep" });
    sleepInChild = await makeSurvey("Щоденник сну (жовтень)", { domain: "sleep", folderId: child.id });
    unclassified = await makeSurvey("Без напряму");
  }, SLOW);

  test(
    "?domain= отбирает методики направления, а строка списка несёт domain",
    async () => {
      const trauma = await api("/api/surveys?domain=trauma", root.token);
      expect(trauma.status, JSON.stringify(trauma.body)).toBe(200);
      const keys = trauma.body.items.map((s: { catalogKey: string | null }) => s.catalogKey);
      expect(keys).toEqual(expect.arrayContaining(["pcl5", "pcptsd5", "ces"]));
      expect(trauma.body.items.every((s: { domain: string }) => s.domain === "trauma")).toBe(true);

      // поле — в каждой строке полного списка, как направление карты у методик каталога
      const all = await api("/api/surveys", root.token);
      const phq9 = all.body.items.find((s: { catalogKey: string | null }) => s.catalogKey === "phq9");
      expect(phq9?.domain).toBe("distress");
      expect(all.body.items.find((s: { id: string }) => s.id === unclassified)?.domain).toBeNull();

      // страница считает total по тому же условию
      const page = await api("/api/surveys?domain=distress&limit=3", root.token);
      expect(page.body.items.length).toBe(3);
      const distress = all.body.items.filter((s: { domain: string | null }) => s.domain === "distress").length;
      expect(page.body.total).toBe(distress);
    },
    SLOW,
  );

  test("?domain=none — методики без направления; мусор в параметре — четырёхсотка", async () => {
    const none = await api(`/api/surveys?groupId=${shelf}&domain=${NO_DOMAIN}`, adminA.token);
    expect(none.status).toBe(200);
    expect(idsOf(none.body)).toEqual([unclassified]);
    const catalogNone = await api(`/api/surveys?domain=${NO_DOMAIN}`, root.token);
    expect(catalogNone.body.items.filter((s: { catalogKey: string | null }) => s.catalogKey)).toEqual([]);

    expect((await api("/api/surveys?domain=depression", adminA.token)).status).toBe(400);
  });

  /**
   * Мутация: оставить поддерево только для ?q= — методика из вложенной папки
   * не находится по направлению из родительской, проверка называет её.
   */
  test("из папки ?domain= ищет по её поддереву, без него папка показывает свой уровень", async () => {
    const fromParent = await api(`/api/surveys?groupId=${shelf}&folder=${parent.id}&domain=sleep`, adminA.token);
    expect(idsOf(fromParent.body), "методика из вложенной папки не найдена по направлению").toEqual([sleepInChild]);
    expect(idsOf((await api(`/api/surveys?groupId=${shelf}&folder=${parent.id}`, adminA.token)).body)).toEqual([]);
    // корень с направлением — методики вне папок, как и с поиском
    expect(idsOf((await api(`/api/surveys?groupId=${shelf}&folder=root&domain=sleep`, adminA.token)).body)).toEqual([
      sleepAtRoot,
    ]);
    // весь каталог группы по направлению — без папки
    expect(idsOf((await api(`/api/surveys?groupId=${shelf}&domain=sleep`, adminA.token)).body).sort()).toEqual(
      [sleepAtRoot, sleepInChild].sort(),
    );
  });

  /**
   * Роль приложения: политики строк действуют. Фильтр — поверх зоны: чужой
   * сотрудник методики полки не видит ни с направлением, ни без; обследуемый
   * видит опубликованные общедоступные, и направление при нём.
   */
  test(
    "под ролью приложения: сотрудник — своя зона, чужой — пусто, обследуемый — опубликованные",
    async () => {
      const own = await appApi(`/api/surveys?domain=sleep`, adminA.token);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(idsOf(own.body)).toEqual(expect.arrayContaining([sleepAtRoot, sleepInChild]));
      expect(own.body.items.every((s: { domain: string }) => s.domain === "sleep")).toBe(true);

      const foreign = await appApi(`/api/surveys?domain=sleep`, adminB.token);
      expect(foreign.status).toBe(200);
      expect(idsOf(foreign.body).filter((id: string) => id === sleepAtRoot || id === sleepInChild)).toEqual([]);

      const superadmin = await appApi("/api/surveys?domain=trauma&limit=50", root.token);
      expect(superadmin.body.items.map((s: { catalogKey: string | null }) => s.catalogKey)).toEqual(
        expect.arrayContaining(["pcl5", "pcptsd5", "ces"]),
      );
      const owner = await api("/api/surveys?domain=trauma&limit=50", root.token);
      expect(idsOf(superadmin.body).sort(), "роль приложения и владелец разошлись").toEqual(idsOf(owner.body).sort());

      const mine = await appApi("/api/surveys?domain=wellbeing", patient.token);
      expect(mine.status, JSON.stringify(mine.body)).toBe(200);
      const who5 = mine.body.items.find((s: { catalogKey: string | null }) => s.catalogKey === "who5");
      expect(who5?.domain, "обследуемый не видит WHO-5 по направлению").toBe("wellbeing");
      expect(mine.body.items.every((s: { domain: string }) => s.domain === "wellbeing")).toBe(true);
    },
    SLOW,
  );
});

describe("направление методики учреждения", () => {
  test("заводится, правится и снимается конструктором; копия стоит на той же полке", async () => {
    const created = await api("/api/surveys", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: { uk: "Анкета відділення", ru: "Анкета отделения" }, domain: "staff" }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.domain).toBe("staff");
    const id = created.body.id as string;

    const moved = await api(`/api/surveys/${id}`, adminA.token, { method: "PATCH", body: JSON.stringify({ domain: "other" }) });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.domain).toBe("other");

    // настройка строки, не содержимое: версии правка направления не выпускает
    const versions = await versionCount(id);
    const copy = await api(`/api/surveys/${id}/duplicate`, adminA.token, { method: "POST" });
    expect(copy.status).toBe(201);
    expect(copy.body.domain).toBe("other");
    expect(copy.body.catalogKey ?? null, "копия унаследовала ключ каталога").toBeNull();

    const cleared = await api(`/api/surveys/${id}`, adminA.token, { method: "PATCH", body: JSON.stringify({ domain: null }) });
    expect(cleared.body.domain).toBeNull();
    expect(await versionCount(id)).toBe(versions);

    const wrong = await api(`/api/surveys/${id}`, adminA.token, { method: "PATCH", body: JSON.stringify({ domain: "mood" }) });
    expect(wrong.status).toBe(400);
  });
});
