import { beforeAll, describe, expect, test } from "bun:test";
import { SURVEY_DOMAINS, type CatalogPassport, type SurveyListItem } from "@quizzy/shared";
import { api, appApi, db, eq, patient, root, surveys } from "./fixtures";
import { CATALOG } from "../src/instruments/catalog";
import { CATALOG_PASSPORT } from "../src/instruments/catalogPassport";
import { CATALOG_GROUP_ID, installCatalog } from "../src/lib/catalogInstall";

/**
 * Каталог для специалиста: порядок ?sort=catalog и клинический паспорт в
 * строке списка и на странице методики (lib/catalogPassport.ts).
 *
 * Проверяется то, что видит врач: направления по порядку чипов, полные
 * методики первыми, короткие формы — сразу под своей полной (PHQ-9, под ней
 * PHQ-2, PHQ-4, PHQ-8), а не отдельными строками по алфавиту; у строки —
 * роль, время, что измеряет и куда ведёт положительный результат. Прежний
 * ?sort=title работает как работал. Обследуемому паспорт не отдаётся: пороги —
 * часть ключа (#141).
 */

const SLOW = 30_000;

type Row = SurveyListItem & { catalogKey: string | null };

let idOf: Map<string, string>;

beforeAll(async () => {
  await installCatalog();
  const rows = await db.select({ id: surveys.id, key: surveys.catalogKey }).from(surveys).where(eq(surveys.groupId, CATALOG_GROUP_ID));
  idOf = new Map(rows.flatMap((r) => (r.key ? [[r.key, r.id] as const] : [])));
}, SLOW);

async function catalogList(call: typeof api, query = ""): Promise<{ items: Row[]; total: number }> {
  const res = await call(`/api/surveys?groupId=${CATALOG_GROUP_ID}&status=published&sort=catalog${query}`, root.token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/*
 * Строки записей CATALOG: база общая на процесс, и соседние файлы кладут в
 * группу каталога свои методики (без ключа или с пробным ключом) — порядок и
 * паспорт проверяются на методиках самого каталога.
 */
const CATALOG_KEYS = new Set(CATALOG.map((e) => e.key));
const ofCatalog = (items: Row[]) => items.filter((s) => s.catalogKey && CATALOG_KEYS.has(s.catalogKey));

describe("каталог: порядок для специалиста (?sort=catalog)", () => {
  test(
    "направления — по порядку чипов, внутри — полные первыми, короткие формы под своей полной",
    async () => {
      const items = ofCatalog((await catalogList(api)).items);
      expect(items.length).toBe(CATALOG.length);
      const keys = items.map((s) => s.catalogKey!);

      // направления не перемешаны: каждое — одним куском, в порядке перечня
      const domainOrder = items.map((s) => SURVEY_DOMAINS.indexOf(s.domain!));
      expect([...domainOrder].sort((a, b) => a - b), "направления вперемешку").toEqual(domainOrder);

      // PHQ-9, сразу под ней PHQ-2, PHQ-4, PHQ-8 — от короткой к длинной
      const at = keys.indexOf("phq9");
      expect(keys.slice(at, at + 4)).toEqual(["phq9", "phq2", "phq4", "phq8"]);
      // GAD-7 — с GAD-2 под ней; PHQ-4 уже стоит под PHQ-9 (первая полная форма)
      const gad = keys.indexOf("gad7");
      expect(keys.slice(gad, gad + 2)).toEqual(["gad7", "gad2"]);
      for (const [full, short] of [
        ["pcl5", "pcptsd5"],
        ["audit", "auditc"],
        ["k10", "k6"],
        ["pss10", "pss4"],
        ["sci", "sci02"],
        ["bat", "bat12"],
        ["dass42", "dass21"],
        ["cssrs", "asq"],
      ] as const) {
        expect(keys.indexOf(short), `${short} не под ${full}`).toBe(keys.indexOf(full) + 1);
      }

      /*
       * Внутри направления — роль семьи по порядку: полные, затем короткие
       * формы без полной в каталоге, затем оценки фахівцем. Роль семьи — роль
       * её главы (короткая форма под полной идёт с ней).
       */
      const rank = { full: 0, short: 1, clinician: 2 } as const;
      const familyRole = (s: Row) => {
        const parent = s.catalog!.parent;
        const head = parent ? items.find((x) => x.catalogKey === parent) : null;
        return rank[(head ?? s).catalog!.role];
      };
      for (const domain of SURVEY_DOMAINS) {
        const roles = items.filter((s) => s.domain === domain).map(familyRole);
        expect([...roles].sort((a, b) => a - b), `${domain}: роли вперемешку`).toEqual(roles);
      }
    },
    SLOW,
  );

  test(
    "страницы режут тот же порядок: склеенные страницы — весь список, total — по отбору",
    async () => {
      const all = await catalogList(api);
      const first = await catalogList(api, "&limit=20&offset=0");
      const second = await catalogList(api, "&limit=20&offset=20");
      const rest = await catalogList(api, `&limit=500&offset=40`);
      expect(first.total).toBe(all.items.length);
      expect([...first.items, ...second.items, ...rest.items].map((s) => s.id)).toEqual(all.items.map((s) => s.id));
    },
    SLOW,
  );

  test(
    "прежний ?sort=title — по названию, как и был; незнакомый порядок — 400",
    async () => {
      const res = await api(`/api/surveys?groupId=${CATALOG_GROUP_ID}&status=published&sort=title`, root.token);
      expect(res.status).toBe(200);
      const titles = (res.body.items as Row[]).map((s) => s.title);
      expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, "uk")));
      expect((await api("/api/surveys?sort=domain", root.token)).status).toBe(400);
    },
    SLOW,
  );
});

describe("каталог: паспорт строки", () => {
  test(
    "у каждой строки — роль, время и что измеряет; у короткой формы — полная и шаг с переходом",
    async () => {
      const items = ofCatalog((await catalogList(api)).items);
      for (const s of items) {
        const spec = CATALOG_PASSPORT[s.catalogKey!]!;
        expect(s.catalog?.role, s.catalogKey!).toBe(spec.role);
        expect(s.catalog!.minutes, s.catalogKey!).toBeGreaterThan(0);
        expect(s.catalog!.purpose).toBe(spec.purpose.uk);
        // строка паспорта — не описание для обследуемого
        expect(s.catalog!.purpose).not.toBe(s.description);
      }

      const phq2 = items.find((s) => s.catalogKey === "phq2")!;
      expect(phq2.catalog!.parent).toBe("phq9");
      expect(phq2.catalog!.steps).toEqual([
        expect.objectContaining({
          scale: null,
          op: ">=",
          value: 3,
          next: { key: "phq9", surveyId: idOf.get("phq9")!, title: "Депресія (PHQ-9)" },
        }),
      ]);
      expect(phq2.catalog!.steps[0]!.citation).toContain("Kroenke");

      // PHQ-4: шаги по подшкалам — названием подшкалы, а не кодом
      const phq4 = items.find((s) => s.catalogKey === "phq4")!;
      expect(phq4.catalog!.steps.map((x) => [x.scale, x.next.key])).toEqual([
        ["Депресія (PHQ-2)", "phq9"],
        ["Тривога (GAD-2)", "gad7"],
      ]);

      // порог полной методики словами; время PHQ-9 — по числу пунктов, ASQ — из руководства
      const phq9 = items.find((s) => s.catalogKey === "phq9")!;
      expect(phq9.catalog!.cutoffs).toEqual([{ scale: null, op: ">=", value: 10, means: "клінічно значуща депресія" }]);
      expect(phq9.catalog!.minutes).toBe(3);
      expect(items.find((s) => s.catalogKey === "asq")!.catalog!.minutes).toBe(1);
    },
    SLOW,
  );

  test(
    "паспорт — на языке запроса",
    async () => {
      const res = await api(`/api/surveys?groupId=${CATALOG_GROUP_ID}&status=published&sort=catalog`, root.token, {
        headers: { "Accept-Language": "ru" },
      });
      const sci02 = (res.body.items as Row[]).find((s) => s.catalogKey === "sci02")!;
      expect(sci02.catalog!.purpose).toBe(CATALOG_PASSPORT.sci02!.purpose.ru);
      expect(sci02.catalog!.steps[0]!.next.title).toBe("Бессонница: скрининг (SCI)");
    },
    SLOW,
  );

  test(
    "под ролью приложения — тот же паспорт; обследуемому паспорта нет",
    async () => {
      const owner = await catalogList(api);
      const asApp = await catalogList(appApi);
      expect(asApp.items.map((s) => [s.id, s.catalog?.role, s.catalog?.parent])).toEqual(
        owner.items.map((s) => [s.id, s.catalog?.role, s.catalog?.parent]),
      );

      const mine = await api("/api/surveys?sort=catalog", patient.token);
      expect(mine.status).toBe(200);
      expect((mine.body.items as Row[]).filter((s) => "catalog" in s).map((s) => s.title)).toEqual([]);
    },
    SLOW,
  );

  test(
    "методика учреждения: роль по тому, кто заполняет, время по числу пунктов, «что измеряет» — пусто",
    async () => {
      const res = await api("/api/surveys?sort=catalog", root.token);
      const own = (res.body.items as Row[]).find((s) => !s.catalogKey && s.questionCount > 0)!;
      expect(own.catalog).toEqual(
        expect.objectContaining({ role: own.administration === "clinician" ? "clinician" : "full", purpose: null, parent: null }),
      );
      expect(own.catalog!.minutes).toBeGreaterThan(0);
    },
    SLOW,
  );
});

describe("каталог: паспорт на странице методики", () => {
  test(
    "полная методика знает короткие формы, короткая — полную, порог и что дальше",
    async () => {
      const phq9 = await api(`/api/surveys/${idOf.get("phq9")}`, root.token);
      expect(phq9.status).toBe(200);
      const p9 = phq9.body.catalog as CatalogPassport;
      expect(p9.role).toBe("full");
      expect(p9.shortForms.map((l) => [l.key, l.surveyId])).toEqual([
        ["phq2", idOf.get("phq2")!],
        ["phq4", idOf.get("phq4")!],
        ["phq8", idOf.get("phq8")!],
      ]);
      expect(p9.fullForms).toEqual([]);

      const phq2 = (await api(`/api/surveys/${idOf.get("phq2")}`, root.token)).body.catalog as CatalogPassport;
      expect(phq2.role).toBe("short");
      expect(phq2.fullForms.map((l) => l.surveyId)).toEqual([idOf.get("phq9")!]);
      expect(phq2.steps[0]).toEqual(expect.objectContaining({ op: ">=", value: 3, next: expect.objectContaining({ key: "phq9" }) }));
    },
    SLOW,
  );

  test(
    "обследуемому и сырой выдаче конструктора паспорта нет",
    async () => {
      const asPatient = await api(`/api/surveys/${idOf.get("phq2")}`, patient.token);
      expect(asPatient.status).toBe(200);
      expect(asPatient.body.catalog).toBeUndefined();
      const raw = await api(`/api/surveys/${idOf.get("phq2")}?raw=1`, root.token);
      expect(raw.body.catalog).toBeUndefined();
    },
    SLOW,
  );
});
