import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { choiceLabel, keepChosen, type Known } from "../src/ui/choices";

/**
 * Выбранное, которое выбрать заново нельзя (волна 12, разбор кода: «селект
 * методики скрывал выбранную снятую или недоступную методику»).
 *
 * Управляемый <select> без совпадающего пункта рисует первый — «будь-яка
 * методика», «без каскаду», — а значение остаётся прежним. Поэтому
 * проверяется главное: в пунктах есть выбранное, и браузер покажет именно
 * его, а не первый пункт.
 */

const words = { retired: "знято з використання", unavailable: "недоступна", unknown: "Недоступний тест" };
const live = [
  { id: "phq", title: "PHQ-9" },
  { id: "gad", title: "GAD-7" },
];
const catalogue: Record<string, Known> = {
  old: { title: "СР-45 (стара редакція)", retired: true },
  other: { title: "Методика чужої групи", retired: false },
};
const known = (id: string) => catalogue[id] ?? null;

/** Что покажет браузер: selected-пункт статической разметки */
const shown = (value: string, chosen: string | string[] = value) => {
  const html = renderToStaticMarkup(
    <select value={value} onChange={() => {}}>
      <option value="">Будь-яка методика</option>
      {keepChosen(live, chosen, known).map((c) => (
        <option key={c.id} value={c.id}>
          {choiceLabel(c, words)}
        </option>
      ))}
    </select>,
  );
  return /<option[^>]*selected=""[^>]*>([^<]*)</.exec(html)?.[1] ?? "(перший пункт)";
};

describe("выбранное снятое или недоступное не пропадает", () => {
  test("снятая методика показывается с пометкой, а не первым пунктом", () => {
    expect(shown("old")).toBe("СР-45 (стара редакція) (знято з використання)");
  });

  test("недоступная — с пометкой «недоступна», а без названия — общей фразой", () => {
    expect(shown("other")).toBe("Методика чужої групи (недоступна)");
    expect(shown("gone")).toBe("Недоступний тест");
  });

  test("доступная выбранная — как есть, без пометки и без второго пункта", () => {
    expect(shown("gad")).toBe("GAD-7");
    expect(keepChosen(live, "gad", known)).toHaveLength(2);
  });

  test("заново снятое не предлагается: пометка только у уже выбранного", () => {
    const choices = keepChosen(live, "", known);
    expect(choices.map((c) => c.id)).toEqual(["phq", "gad"]);
    expect(choices.every((c) => c.state === "live")).toBe(true);
  });

  test("несколько выбранных (состав батареи): каждое снятое — своим пунктом, впереди", () => {
    const choices = keepChosen(live, ["phq", "old", "gone", "old"], known);
    expect(choices.map((c) => [c.id, c.state])).toEqual([
      ["old", "retired"],
      ["gone", "unavailable"],
      ["phq", "live"],
      ["gad", "live"],
    ]);
  });
});
