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

describe("прежние ключи без учётки убираются при входе (#200)", () => {
  type Keys = {
    dropLegacyDrafts?: (s: Pick<Storage, "length" | "key" | "removeItem">) => void;
  };
  /* модуля на коде до правки нет — проверки падают по существу, а не загрузкой файла */
  const load = (): Promise<Keys> => import("../src/pages/constructor/draftKey").catch(() => ({}));

  /** localStorage браузера в той части, которой пользуется чистка */
  function fakeStorage(keys: string[]) {
    const map = new Map(keys.map((k) => [k, "{}"]));
    return {
      map,
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
    };
  }

  test("ключи без учётки — прочь; свои черновики, тема и токены — на месте", async () => {
    const { dropLegacyDrafts } = await load();
    expect(dropLegacyDrafts).toBeFunction();
    const mine = draftKey("doctor-a", "survey-1")!;
    const mineNew = draftKey("doctor-a", undefined)!;
    const storage = fakeStorage([
      "quizzy.constructor.survey-1",
      "quizzy.constructor.new",
      mine,
      mineNew,
      "quizzy.theme.v2",
      "quizzy.token",
    ]);
    dropLegacyDrafts!(storage);
    expect([...storage.map.keys()].sort()).toEqual([mine, mineNew, "quizzy.theme.v2", "quizzy.token"].sort());
  });

  test("положительный контроль: без прежних ключей чистка ничего не трогает", async () => {
    const { dropLegacyDrafts } = await load();
    expect(dropLegacyDrafts).toBeFunction();
    const storage = fakeStorage([draftKey("doctor-b", "survey-2")!, "quizzy.lang"]);
    dropLegacyDrafts!(storage);
    expect(storage.map.size).toBe(2);
  });

  test("вход и восстановление сессии чистят прежние ключи", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/auth.tsx"), "utf8");
    expect(src).toContain('import { dropLegacyDrafts } from "./pages/constructor/draftKey";');
    // adopt — общий путь входа: пароль, второй фактор, регистрация
    expect(src).toMatch(/async function adopt\([\s\S]{0,700}?dropLegacyConstructorDrafts\(\);/);
    expect(src).toMatch(/if \(boot\.data\) \{[\s\S]{0,300}?dropLegacyConstructorDrafts\(\);/);
  });
});
