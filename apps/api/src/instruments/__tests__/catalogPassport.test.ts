import { describe, expect, test } from "bun:test";
import { CATALOG_ROLES, type CutoffOp } from "@quizzy/shared";
import { catalogOrder, relatedKeys, rowPassport, surveyPassport } from "../../lib/catalogPassport";
import { CATALOG } from "../catalog";
import { CATALOG_PASSPORT, catalogRules, familyHead, passportSpec, shortFormsOf } from "../catalogPassport";

/**
 * Клинический паспорт каталога (catalogPassport.ts): роли, связи полной
 * методики с короткими формами, пороги и шаги ступенчатого скрининга.
 *
 * Проверяется то, что ломается тихо: короткая форма ссылается на ключ,
 * которого нет; связи замыкаются в кольцо и каталог не знает, что под чем
 * стоит; порог паспорта расходится с полосой методики — в каталоге «≥ 10», а
 * считает методика от 11; шаг без источника — порог, который нечем объяснить.
 *
 * Прогон без базы, как у остальных проверок методик.
 */

const byKey = new Map(CATALOG.map((e) => [e.key, e] as const));

type Band = { minScore: number; maxScore: number };
type Scale = { code: string; bands?: Band[]; title: { uk: string } | string };

function scalesOf(key: string): Scale[] {
  return (byKey.get(key)!.draft.scales as unknown as Scale[]).filter((s) => (s.bands ?? []).length > 0);
}

/**
 * Порог — граница полосы: «≥ v» начинает полосу (min = v), «≤ v» её
 * заканчивает (max = v), «< v» — следующая полоса начинается с v, «> v» —
 * полоса кончается на v.
 */
function isBoundary(bands: Band[], op: CutoffOp, value: number): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  return bands.some((b) =>
    op === ">=" || op === "<" ? near(b.minScore, value) : near(b.maxScore, value),
  );
}

describe("паспорт каталога: полнота", () => {
  test("у каждой записи CATALOG есть паспорт, и лишних ключей нет", () => {
    const missing = CATALOG.map((e) => e.key).filter((key) => !passportSpec(key));
    expect(missing, "впишите ключи в apps/api/src/instruments/catalogPassport.ts").toEqual([]);
    // лишний ключ — почти всегда опечатка: строка с настоящим ключом осталась бы без паспорта
    const extra = Object.keys(CATALOG_PASSPORT).filter((key) => !byKey.has(key));
    expect(extra).toEqual([]);
  });

  test("роль — из перечня, строка для специалиста — на обоих языках и не описание для обследуемого", () => {
    for (const [key, spec] of Object.entries(CATALOG_PASSPORT)) {
      expect(CATALOG_ROLES as readonly string[], key).toContain(spec.role);
      expect(spec.purpose.uk.trim().length, `${key}: purpose.uk`).toBeGreaterThan(10);
      expect(spec.purpose.ru.trim().length, `${key}: purpose.ru`).toBeGreaterThan(10);
      const description = byKey.get(key)!.draft.description as { uk: string } | undefined;
      expect(spec.purpose.uk, `${key}: строка паспорта повторяет описание для обследуемого`).not.toBe(description?.uk ?? "");
      // украинская строка без русских букв, русская — без украинских
      expect(/[ыъэё]/u.test(spec.purpose.uk), `${key}: русские буквы в украинской строке`).toBe(false);
      expect(/[іїєґ]/u.test(spec.purpose.ru), `${key}: украинские буквы в русской строке`).toBe(false);
    }
  });

  test("методику, которую заполняет специалист, паспорт не называет самоотчётом", () => {
    /*
     * Роль «оцінка фахівцем» — у шкал, которые заполняет специалист. Обратное
     * не обязательно: ASQ ставит специалист, но это короткая форма (скрининг
     * перед C-SSRS).
     */
    for (const [key, spec] of Object.entries(CATALOG_PASSPORT)) {
      if (spec.role !== "clinician") continue;
      expect(byKey.get(key)!.draft.administration, `${key}: роль «оцінка фахівцем» у самоотчёта`).toBe("clinician");
    }
  });

  test("код методики стоит в её названии", () => {
    for (const [key, spec] of Object.entries(CATALOG_PASSPORT)) {
      if (!spec.code) continue;
      const title = byKey.get(key)!.draft.title as { uk: string };
      expect(title.uk, `${key}: код «${spec.code}» не найден в названии`).toContain(spec.code);
    }
  });

  test("время из руководства — разумное число минут", () => {
    for (const [key, spec] of Object.entries(CATALOG_PASSPORT)) {
      if (spec.minutes === undefined) continue;
      expect(Number.isInteger(spec.minutes) && spec.minutes > 0 && spec.minutes <= 60, key).toBe(true);
    }
  });
});

describe("паспорт каталога: связи форм", () => {
  test("короткая форма ссылается на существующую полную методику, а не на другую короткую", () => {
    for (const [key, spec] of Object.entries(CATALOG_PASSPORT)) {
      for (const full of spec.fullForms ?? []) {
        expect(byKey.has(full), `${key} → ${full}: такого ключа в каталоге нет`).toBe(true);
        expect(full, `${key} ссылается сам на себя`).not.toBe(key);
        expect(passportSpec(full)?.role, `${key} → ${full}: полная методика помечена короткой`).not.toBe("short");
      }
      if (spec.fullForms?.length) expect(spec.role, `${key}: у полной методики не бывает полной формы`).toBe("short");
    }
  });

  test("связи без колец: от любой методики до главы семьи — конечный путь", () => {
    for (const key of Object.keys(CATALOG_PASSPORT)) {
      const seen = new Set<string>();
      let cursor = key;
      while (passportSpec(cursor)?.fullForms?.length) {
        expect(seen.has(cursor), `кольцо через ${cursor}`).toBe(false);
        seen.add(cursor);
        cursor = passportSpec(cursor)!.fullForms![0]!;
      }
      expect(familyHead(key)).toBe(passportSpec(key)?.fullForms?.[0] ?? key);
    }
  });

  test("полная методика знает свои короткие формы — те, что назвали её", () => {
    expect(shortFormsOf("phq9").sort()).toEqual(["phq2", "phq4", "phq8"]);
    expect(shortFormsOf("gad7").sort()).toEqual(["gad2", "phq4"]);
    expect(shortFormsOf("pcl5")).toEqual(["pcptsd5"]);
    expect(shortFormsOf("audit")).toEqual(["auditc"]);
    expect(shortFormsOf("k10")).toEqual(["k6"]);
    expect(shortFormsOf("pss10")).toEqual(["pss4"]);
    expect(shortFormsOf("sci")).toEqual(["sci02"]);
    expect(shortFormsOf("bat")).toEqual(["bat12"]);
    expect(shortFormsOf("dass42")).toEqual(["dass21"]);
    expect(shortFormsOf("cssrs")).toEqual(["asq"]);
    // глава семьи — сама себе
    expect(familyHead("phq9")).toBe("phq9");
    expect(familyHead("phq4")).toBe("phq9");
    expect(familyHead("no-such")).toBe("no-such");
  });

  test("ключ, унаследованный от Object, — не паспорт", () => {
    expect(passportSpec("constructor")).toBeNull();
    expect(passportSpec("toString")).toBeNull();
    expect(passportSpec(null)).toBeNull();
  });
});

describe("паспорт каталога: пороги не выдуманы", () => {
  test("каждый порог паспорта — граница полосы своей шкалы", () => {
    const wrong: string[] = [];
    for (const [key, spec] of Object.entries(CATALOG_PASSPORT)) {
      const scales = scalesOf(key);
      for (const c of spec.cutoffs ?? []) {
        const pool = c.scale ? scales.filter((s) => s.code === c.scale) : scales;
        if (c.scale && !pool.length) wrong.push(`${key}: шкалы ${c.scale} с полосами нет`);
        // порог без шкалы — общий: граница у каждой шкалы с полосами
        else if (!pool.length || !pool.every((s) => isBoundary(s.bands!, c.op, c.value))) {
          wrong.push(`${key}: ${c.scale ?? "*"} ${c.op} ${c.value} — не граница полосы`);
        }
        if (!c.means.uk.trim() || !c.means.ru.trim()) wrong.push(`${key}: у порога ${c.value} нет слов`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("шаг скрининга: шкала короткой формы, граница её полосы, полная методика из fullForms и источник", () => {
    const wrong: string[] = [];
    let steps = 0;
    for (const [key, spec] of Object.entries(CATALOG_PASSPORT)) {
      for (const s of spec.steps ?? []) {
        steps += 1;
        const scale = scalesOf(key).find((sc) => sc.code === s.scale);
        if (!scale) wrong.push(`${key}: шкалы ${s.scale} с полосами нет`);
        else if (!isBoundary(scale.bands!, s.op, s.value)) wrong.push(`${key}: ${s.scale} ${s.op} ${s.value} — не граница полосы`);
        if (!spec.fullForms?.includes(s.next)) wrong.push(`${key}: шаг ведёт к ${s.next}, а среди полных форм его нет`);
        if (!byKey.has(s.next)) wrong.push(`${key}: шаг к несуществующему ${s.next}`);
        // источник: автор и год, а не пустая отписка
        if (!/\d{4}/.test(s.source) || s.source.trim().length < 20) wrong.push(`${key}: у шага нет источника порога`);
      }
      if (spec.steps?.length) expect(spec.role, `${key}: шаг скрининга — только у короткой формы`).toBe("short");
    }
    expect(wrong).toEqual([]);
    // шаги из брифа каталога: PHQ-2, GAD-2, PHQ-4 (два), AUDIT-C, PC-PTSD-5, K6, SCI-02, BAT-12, ASQ
    expect(steps).toBe(10);
  });

  test("короткая форма без порогов у разработчика шага не имеет", () => {
    // PSS-4: «позитивного» PSS-4 не бывает — порогов нет ни у неё, ни у PSS-10
    expect(passportSpec("pss4")?.steps ?? []).toEqual([]);
    expect(passportSpec("dass21")?.steps ?? []).toEqual([]);
    expect(passportSpec("phq8")?.steps ?? []).toEqual([]);
  });
});

describe("правила шагов", () => {
  const rules = catalogRules((key, scale) => (key === "phq4" ? `шкала ${scale}` : null));

  test("одно правило на шаг, ключ — пара «короткая — полная», ключи не повторяются", () => {
    expect(rules.map((r) => r.key).sort()).toEqual(
      ["asq-cssrs", "auditc-audit", "bat12-bat", "gad2-gad7", "k6-k10", "pcptsd5-pcl5", "phq2-phq9", "phq4-gad7", "phq4-phq9", "sci02-sci"],
    );
  });

  test("название — порог и полная методика кодами, пояснение — с источником", () => {
    const phq2 = rules.find((r) => r.key === "phq2-phq9")!;
    expect(phq2.title).toBe("PHQ-2 ≥ 3 → PHQ-9");
    expect(phq2.note).toContain("Kroenke");
    expect(rules.find((r) => r.key === "sci02-sci")!.title).toBe("SCI-02 ≤ 2 → SCI");
    // дробный порог — с запятой, как пишут по-украински
    expect(rules.find((r) => r.key === "bat12-bat")!.title).toBe("BAT-12 ≥ 2,54 → BAT-23");
    // у PHQ-4 два шага по разным подшкалам — шкала в названии
    expect(rules.find((r) => r.key === "phq4-gad7")!.title).toBe("PHQ-4 · шкала ANX ≥ 3 → GAD-7");
  });
});

/**
 * Методика каталога без записи в паспорте: сервер не падает и не выдумывает —
 * роль по тому, кто заполняет, время по числу пунктов, без связей и порогов.
 * Так стоят и методики учреждения (ключа каталога нет вовсе).
 */
describe("методика без записи паспорта", () => {
  test("роль по умолчанию, без связей, без порогов", () => {
    const row = rowPassport({ catalogKey: "no-such-key", administration: "clinician" }, 7, "uk", new Map());
    expect(row).toEqual({ role: "clinician", minutes: 3, purpose: null, cutoffs: [], parent: null, steps: [] });
    expect(rowPassport({ catalogKey: null, administration: "self" }, 9, "ru", new Map())).toMatchObject({ role: "full", minutes: 3 });
    const page = surveyPassport({ catalogKey: "no-such-key", administration: "self" }, 20, "uk", new Map());
    expect(page).toEqual({ role: "full", minutes: 5, purpose: null, cutoffs: [], fullForms: [], shortForms: [], steps: [] });
    expect(relatedKeys(["no-such-key", null, undefined])).toEqual([]);
  });

  test("в порядке каталога такая методика стоит среди полных своего направления, по названию", () => {
    const rows = [
      { id: "b", catalogKey: "no-such-key", domain: "distress" as const, administration: "self" as const, title: { uk: "Б-методика" } },
      { id: "a", catalogKey: "phq9", domain: "distress" as const, administration: "self" as const, title: { uk: "Депресія (PHQ-9)" } },
      { id: "c", catalogKey: "phq2", domain: "distress" as const, administration: "self" as const, title: { uk: "Депресія, коротко (PHQ-2)" } },
    ];
    expect(catalogOrder(rows, "uk").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});
