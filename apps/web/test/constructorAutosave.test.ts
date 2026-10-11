import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as model from "../src/pages/constructor/model";

/**
 * Автосохранение конструктора — своё у каждой учётки (#176).
 *
 * Ключ был `quizzy.constructor.<id методики>` — общий на весь браузер. Врач
 * A правил методику и не сохранил; врач B входил на том же компьютере,
 * открывал ту же методику и видел «Відновлено незбережену чернетку» с
 * правками A — и публиковал их от своего имени.
 *
 * Экран читает и пишет черновик только под ключом draftKey(учётка, id);
 * здесь — что ключи учёток различаются, а экран другого ключа не знает.
 * Файл грузится и на коде до правки (функции там нет — проверки падают по
 * существу).
 */

const draftKey = (owner: string | null | undefined, id: string | undefined): string | null | undefined =>
  (model as { draftKey?: typeof model.draftKey }).draftKey?.(owner, id);

/** Хранилище браузера: одно на всех, кто входит на этом компьютере */
const storage = new Map<string, string>();

describe("чужой черновик не восстанавливается", () => {
  test("A правил методику — B под той же методикой своего ключа не находит", () => {
    const a = draftKey("doctor-a", "survey-1");
    const b = draftKey("doctor-b", "survey-1");
    expect(a).toBeString();
    expect(b).toBeString();
    storage.set(a!, JSON.stringify({ title: { uk: "Правки лікаря A" } }));
    expect(storage.get(b!)).toBeUndefined();
  });

  test("положительный контроль: A после F5 свой черновик находит", () => {
    expect(storage.get(draftKey("doctor-a", "survey-1")!)).toContain("Правки лікаря A");
  });

  test("новая методика — тоже своя у каждого; разные методики одного врача не затирают друг друга", () => {
    expect(draftKey("doctor-a", undefined)).not.toBe(draftKey("doctor-b", undefined));
    expect(draftKey("doctor-a", "survey-1")).not.toBe(draftKey("doctor-a", "survey-2"));
  });

  test("без учётки автосохранения нет; прежний ключ без учётки не читается никем", () => {
    expect(draftKey(null, "survey-1")).toBeNull();
    expect(draftKey("doctor-b", "survey-1")).not.toBe("quizzy.constructor.survey-1");
  });

  test("экран берёт ключ с учёткой — и только его", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/constructor/index.tsx"), "utf8");
    expect(src).toContain("draftKey(user?.id, id)");
    expect(src).not.toContain("quizzy.constructor.${id");
    expect(src).not.toContain("draftKey(id)");
  });
});
