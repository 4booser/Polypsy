import { describe, expect, test } from "bun:test";

/**
 * Гонка постраничной подгрузки.
 *
 * Проверяется та же логика номеров запуска, что в usePagedResource: React
 * здесь не нужен, а нужна именно она. Сценарий, ради которого всё написано:
 * человек нажал «показать ещё», и пока летел ответ — сменил фильтр. Без
 * проверки номера хвост старой выборки допишется к новой, и список будет
 * выглядеть правдоподобно, содержа чужие строки.
 */

interface Page {
  items: string[];
  nextCursor: string | null;
}

/** Повторяет решающую часть хука: что применяется, а что отбрасывается */
function makeList() {
  let runId = 0;
  let items: string[] | null = null;
  let cursor: string | null = null;

  const run = async (more: boolean, load: (c: string | null) => Promise<Page>) => {
    const id = ++runId;
    const page = await load(more ? cursor : null);
    if (id !== runId) return "отброшено";
    cursor = page.nextCursor;
    items = more && items ? [...items, ...page.items] : page.items;
    return "применено";
  };

  return {
    run,
    get items() {
      return items;
    },
    get cursor() {
      return cursor;
    },
  };
}

const page = (items: string[], next: string | null = null): Page => ({ items, nextCursor: next });
const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe("подгрузка страниц", () => {
  test("вторая страница дописывается к первой", async () => {
    const list = makeList();
    await list.run(false, async () => page(["а", "б"], "c1"));
    await list.run(true, async () => page(["в", "г"], null));

    expect(list.items).toEqual(["а", "б", "в", "г"]);
    expect(list.cursor).toBeNull();
  });

  test("смена фильтра заменяет список, а не дописывает", async () => {
    const list = makeList();
    await list.run(false, async () => page(["старое"], "c1"));
    await list.run(false, async () => page(["новое"], null));

    expect(list.items).toEqual(["новое"]);
  });

  test("хвост старой выборки не дописывается к новой", async () => {
    const list = makeList();
    await list.run(false, async () => page(["старое"], "c1"));

    // «показать ещё» по старому фильтру — ответ придёт поздно
    const slow = list.run(true, async () => after(30, page(["хвост старого"], null)));
    // человек сменил фильтр, пока летел ответ
    const fast = list.run(false, async () => after(5, page(["новое"], null)));

    expect(await fast).toBe("применено");
    expect(await slow).toBe("отброшено");
    expect(list.items).toEqual(["новое"]);
  });

  test("курсор берётся от последней применённой страницы", async () => {
    // иначе «показать ещё» после смены фильтра продолжит чужую выборку
    const list = makeList();
    await list.run(false, async () => page(["а"], "старый-курсор"));
    await list.run(false, async () => page(["б"], "новый-курсор"));

    expect(list.cursor).toBe("новый-курсор");
  });
});
