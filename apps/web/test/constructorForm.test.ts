import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI } from "@quizzy/shared";
import { ApiError } from "../src/api";
import { LangProvider } from "../src/lang";
import { Settings } from "../src/pages/constructor/Basics";
import { saveThenPublish } from "../src/pages/constructor/Conflict";
import { Bands } from "../src/pages/constructor/Scales";
import {
  EMPTY,
  duplicateQuestion,
  keyRows,
  moveQuestion,
  newScale,
  oneAtATime,
  removeQuestion,
  toPayload,
  type Draft,
  type DraftQuestion,
} from "../src/pages/constructor/model";

/**
 * Конструктор методики: правка списка вопросов и сохранение как состояния
 * формы (w13:uitests).
 *
 * Ключ шкалы ссылается на пункт номером — так его печатает пособие. Правка
 * списка (удалить, переставить, скопировать) меняет номера, и если ключ за
 * ними не следует, методика продолжает выдавать баллы — не за те ответы.
 * Экран этого не показывает: таблица баллов печатает те же номера, что и
 * до правки. Поэтому номера в ключе проверяются здесь, на черновике.
 */

const q = (title: string): DraftQuestion => ({
  uid: `uid-${title}`,
  type: "yesno",
  title: { uk: title, ru: title },
  required: true,
  options: [],
});

/** Пять пунктов и шкала «Так → 1, 3, 5», «Ні → 2»; вторая шкала — балл варианта по 4 и 5 */
function draft(): Draft {
  const sc = { ...newScale([]), key: [
    { item: 1, matchKey: "yes", weight: 1 },
    { item: 3, matchKey: "yes", weight: 1 },
    { item: 5, matchKey: "yes", weight: 1 },
    { item: 2, matchKey: "no", weight: 1 },
  ] };
  const other = { ...newScale([sc]), key: [
    { item: 4, matchKey: null, weight: 2 },
    { item: 5, matchKey: null, weight: 2 },
  ] };
  return { ...EMPTY, questions: ["A", "B", "C", "D", "E"].map(q), scales: [sc, other] };
}

/** Какие ВОПРОСЫ (по названию) стоят в ряду ключа — то, что на самом деле посчитается */
function keyed(d: Draft, scale: number, matchKey: string | null): string[] {
  const row = keyRows(d.scales[scale]!, [{ text: {}, keyCode: "yes" }, { text: {}, keyCode: "no" }]).find(
    (r) => r.matchKey === matchKey,
  );
  return (row?.items ?? []).map((n) => d.questions[n - 1]?.title.uk ?? `#${n}?`);
}

describe("удаление вопроса", () => {
  test("ключ продолжает считать те же вопросы, а строка удалённого уходит", () => {
    const before = draft();
    expect(keyed(before, 0, "yes")).toEqual(["A", "C", "E"]);

    const after = removeQuestion(before, 1); // «B» — единственный в ряду «Ні»
    expect(after.questions.map((x) => x.title.uk)).toEqual(["A", "C", "D", "E"]);
    expect(keyed(after, 0, "yes"), "ключ «Так» уехал на соседние пункты").toEqual(["A", "C", "E"]);
    expect(keyed(after, 0, "no"), "удалённый пункт остался в ключе чужим номером").toEqual([]);
    expect(keyed(after, 1, null)).toEqual(["D", "E"]);
  });

  test("вес строки ключа идёт вместе с пунктом", () => {
    const after = removeQuestion(draft(), 0);
    expect(after.scales[1]!.key).toEqual([
      { item: 3, matchKey: null, weight: 2 },
      { item: 4, matchKey: null, weight: 2 },
    ]);
  });

  test("до сервера доходят номера после удаления, а не прежние", () => {
    const p = toPayload(removeQuestion(draft(), 2)); // «C»
    const yes = p.scales[0]!.key.filter((k) => k.matchKey === "yes").map((k) => k.item).sort();
    expect(yes).toEqual([1, 4]); // A и E; «C» удалён, E стал четвёртым
    // ни одного номера за концом списка — сервер отверг бы такой ключ
    const max = Math.max(...p.scales.flatMap((s) => s.key.map((k) => k.item)));
    expect(max).toBeLessThanOrEqual(p.questions.length);
  });

  test("номер за пределами списка — не действие, черновик тот же", () => {
    const d = draft();
    expect(removeQuestion(d, 9)).toBe(d);
    expect(removeQuestion(d, -1)).toBe(d);
  });
});

describe("перестановка и копия", () => {
  test("↑/↓ — ключ идёт за вопросом", () => {
    const after = moveQuestion(draft(), 0, 1); // A ↔ B
    expect(after.questions.map((x) => x.title.uk)).toEqual(["B", "A", "C", "D", "E"]);
    expect(keyed(after, 0, "yes")).toEqual(["A", "C", "E"]);
    expect(keyed(after, 0, "no")).toEqual(["B"]);
  });

  test("за край списка не переставляется", () => {
    const d = draft();
    expect(moveQuestion(d, 0, -1)).toBe(d);
    expect(moveQuestion(d, 4, 1)).toBe(d);
  });

  test("копия встаёт следом, в ключ не попадает, и номера после неё сдвигаются", () => {
    const after = duplicateQuestion(draft(), 2); // копия «C»
    expect(after.questions.map((x) => x.title.uk)).toEqual(["A", "B", "C", "C", "D", "E"]);
    expect(after.questions[3]!.uid).not.toBe(after.questions[2]!.uid);
    expect(after.scales[0]!.key.filter((k) => k.matchKey === "yes").map((k) => k.item).sort()).toEqual([1, 3, 6]);
    expect(keyed(after, 1, null)).toEqual(["D", "E"]);
  });
});

describe("справочники формы, которые не пришли", () => {
  /*
   * Список наборов (каскад полосы) и список групп (настройки) грузятся
   * отдельно от методики. Экран подставлял на время загрузки и при отказе
   * пустой список — и пустой список говорил неправду о сохранённом: каскад
   * полосы назывался «Недоступна батарея (видалена)», а группа методики
   * показывалась как «Без групи». Ни то ни другое не так: список просто не
   * пришёл.
   */
  const words = (key: keyof typeof UI) => {
    const e = UI[key] as { uk: string; ru: string; en?: string };
    return [e.uk, e.ru, e.en].filter(Boolean) as string[];
  };
  /** Текст выбранного пункта селекта, в котором есть пункт с этим значением */
  const chosenText = (html: string, value: string): string | null =>
    new RegExp(`<option value="${value}" selected="">([^<]*)</option>`).exec(html)?.[1] ?? null;

  const band = { uid: "b", minScore: 0, maxScore: 10, label: { uk: "Норма" }, severity: "none" as const, cascadeBatteryId: "bat-1" };
  const drawBands = (batteries: { id: string; title: string; archived?: boolean }[] | null) =>
    renderToStaticMarkup(
      createElement(LangProvider, null, createElement(Bands, { bands: [band], details: true, batteries, onChange: () => {} })),
    );

  test("наборы ещё не пришли — каскад полосы не называется удалённым, селект ждёт", () => {
    const html = drawBands(null);
    const shown = chosenText(html, "bat-1");
    expect(shown, "выбранный каскад пропал из селекта").not.toBeNull();
    for (const gone of words("choice.batteryGone")) expect(shown).not.toBe(gone);
    expect(words("common.loading")).toContain(shown!);
    expect(html).toMatch(/<select[^>]*disabled=""[^>]*>(?:(?!<\/select>)[\s\S])*bat-1/);
  });

  test("наборы пришли, а этого нет — вот тогда «недоступна (видалена)»", () => {
    const shown = chosenText(drawBands([{ id: "bat-2", title: "Поглиблений" }]), "bat-1");
    expect(words("choice.batteryGone")).toContain(shown!);
    expect(chosenText(drawBands([{ id: "bat-1", title: "Поглиблений" }]), "bat-1")).toBe("Поглиблений");
  });

  const drawSettings = (groups: { id: string; title: string; archivedAt: string | null }[] | null) =>
    renderToStaticMarkup(
      createElement(
        LangProvider,
        null,
        createElement(Settings, {
          draft: { ...EMPTY, groupId: "g-1" },
          groups: groups as Parameters<typeof Settings>[0]["groups"],
          patch: () => {},
        }),
      ),
    );

  test("группы ещё не пришли — группа методики не показывается «без групи»", () => {
    const html = drawSettings(null);
    const shown = chosenText(html, "g-1");
    expect(shown, "выбранной группы нет в селекте — он покажет «Без групи»").not.toBeNull();
    expect(words("sel.noGroup")).not.toContain(shown!);
  });

  test("группы пришли — группа выбрана своим названием", () => {
    expect(chosenText(drawSettings([{ id: "g-1", title: "Скринінг", archivedAt: null }]), "g-1")).toBe("Скринінг");
  });
});

describe("сохранение и публикация", () => {
  test("сохранено, но не опубликовано — это «сохранено», с причиной отдельно", async () => {
    /*
     * Нет права публикации (или оборвалась связь): методика уже записана.
     * Экран, считавший это ошибкой, оставался на заведении — и следующее
     * «Створити» заводило вторую такую же.
     */
    const calls: string[] = [];
    const out = await saveThenPublish(
      async () => {
        calls.push("write");
        return { id: "s1" };
      },
      async () => {
        calls.push("publish");
        throw new ApiError("Потрібне право surveys.publish", 403);
      },
      "не вдалося",
    );
    expect(out).toEqual({ kind: "saved", id: "s1", publishError: "Потрібне право surveys.publish" });
    expect(calls).toEqual(["write", "publish"]);
  });

  test("409 на записи — конфликт версий; публиковать нечего", async () => {
    let published = false;
    const out = await saveThenPublish(
      async () => {
        throw new ApiError("Методику змінили", 409);
      },
      async () => {
        published = true;
      },
      "x",
    );
    expect(out).toEqual({ kind: "conflict", message: "Методику змінили" });
    expect(published).toBe(false);
  });

  test("прочий отказ записи — строка ошибки; без публикации — просто сохранено", async () => {
    expect(await saveThenPublish(async () => Promise.reject(new ApiError("Некоректні дані", 400)), null, "x")).toEqual({
      kind: "error",
      message: "Некоректні дані",
    });
    expect(await saveThenPublish(async () => ({ id: "s2" }), null, "x")).toEqual({
      kind: "saved",
      id: "s2",
      publishError: null,
    });
  });

  test("второе сохранение, начатое во время первого (удержанный Ctrl+S), не уходит", async () => {
    const gate = { busy: false };
    let writes = 0;
    let release: () => void = () => {};
    const slow = () =>
      new Promise<void>((resolve) => {
        writes += 1;
        release = resolve;
      });
    const first = oneAtATime(gate, slow);
    // повтор клавиши — пока первое в полёте
    expect(await oneAtATime(gate, slow)).toBe(false);
    expect(await oneAtATime(gate, slow)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(writes).toBe(1);
    // первое закончилось — следующее нажатие работает, в том числе после отказа
    expect(await oneAtATime(gate, async () => Promise.reject(new Error("x"))).catch(() => "упало")).toBe("упало");
    expect(gate.busy).toBe(false);
    expect(await oneAtATime(gate, async () => {})).toBe(true);
  });
});
