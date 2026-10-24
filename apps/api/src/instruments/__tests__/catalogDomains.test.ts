import { describe, expect, test } from "bun:test";
import { SURVEY_DOMAINS } from "@quizzy/shared";
import { CATALOG } from "../catalog";
import { BUILTIN_KEYS, CATALOG_DOMAINS, catalogDomain } from "../catalogDomains";

/**
 * Карта направлений каталога (catalogDomains.ts).
 *
 * Без строки в карте методика ставится без направления и молча выпадает из
 * всех чипов «Напрям» каталога, кроме «Без напряму». Добавляют методики
 * параллельно, а карту дописывают при слиянии — поэтому проверка называет
 * ключ, которого не хватает, и место, куда его вписать.
 *
 * Прогон без базы, как у остальных проверок методик.
 */
describe("направления каталога", () => {
  test("у каждой записи CATALOG есть направление", () => {
    const missing = CATALOG.map((e) => e.key).filter((key) => catalogDomain(key) === null);
    expect(missing, "впишите ключи в блок своего направления в apps/api/src/instruments/catalogDomains.ts").toEqual([]);
  });

  test("в карте нет ключей, которых нет ни в каталоге, ни среди встроенных", () => {
    /*
     * Лишний ключ ничего не ломает, но почти всегда означает опечатку: ключ
     * каталога переименовали, а карта осталась на старом — и у методики нет
     * направления, хотя строка «для неё» в карте стоит.
     */
    const known = new Set<string>([...CATALOG.map((e) => e.key), ...BUILTIN_KEYS]);
    expect(Object.keys(CATALOG_DOMAINS).filter((k) => !known.has(k))).toEqual([]);
  });

  test("направление — из перечня, который держит база (surveys_domain_check)", () => {
    const allowed = new Set<string>(SURVEY_DOMAINS);
    const wrong = Object.entries(CATALOG_DOMAINS).filter(([, d]) => !allowed.has(d));
    expect(wrong).toEqual([]);
  });

  test("черновики каталога направления не несут: его источник — карта", () => {
    /*
     * Направление в черновике меняло бы отпечаток редакции (catalogInstall,
     * fingerprint) — новая версия у методики с теми же пунктами, — и спорило
     * бы с картой: у установщика было бы два ответа на один вопрос.
     */
    const carrying = CATALOG.filter((e) => "domain" in (e.draft as Record<string, unknown>)).map((e) => e.key);
    expect(carrying).toEqual([]);
  });

  test("унаследованное от Object имя — не направление", () => {
    expect(catalogDomain("constructor")).toBeNull();
    expect(catalogDomain("toString")).toBeNull();
    expect(catalogDomain("phq9")).toBe("distress");
  });
});
