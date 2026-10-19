import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LangProvider } from "../src/lang";
import {
  BigValue,
  ChangeCell,
  CourseDigits,
  DataTable,
  decimal,
  Drawer,
  DrawerPane,
  Modal,
  Popover,
  ToastProvider,
  activePane,
  closeTipKey,
  draftToastText,
  focusFromKeyboard,
  placePopover,
  reliabilityOf,
  selectAllState,
  signed,
  stepRow,
  toggleAll,
  toggleKey,
  toastLifetime,
  type Column,
} from "../src/ui";
import { pageList, shownRange } from "../src/ui/pager";
import { ChoiceCard, Field, Input } from "../src/ui/primitives";

/**
 * Набор «Виразна»: то, что у ящика, поповера и таблицы проверяется без
 * браузера, — чистая логика (место слоя, отметка строк, шаг по строкам,
 * номера страниц) и обещания разметки (ящик не размонтируется при закрытии,
 * виды держат свои черновики, заголовок колонки говорит направление словом).
 * Поведение в браузере — Esc, ловушка фокуса, клавиатура — в e2e/kit.e2e.ts.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>
        <ToastProvider>{node}</ToastProvider>
      </LangProvider>
    </MemoryRouter>,
  );

/** Текст разметки без тегов и атрибутов: классы вроде gap-1.5 — не числа на экране */
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ");

/* ─────────── поповер: место ─────────── */

describe("поповер: место на экране", () => {
  const viewport = { width: 1280, height: 800 };
  const pop = { width: 300, height: 160 };

  test("под триггером, по левому краю, с зазором", () => {
    const at = placePopover({ trigger: { top: 100, left: 200, width: 120, height: 32 }, pop, viewport });
    expect(at).toEqual({ top: 140, left: 200, side: "bottom" });
  });

  test("внизу не помещается — переворачивается наверх", () => {
    const at = placePopover({ trigger: { top: 700, left: 200, width: 120, height: 32 }, pop, viewport });
    expect(at.side).toBe("top");
    expect(at.top).toBe(700 - 8 - 160);
  });

  test("не помещается нигде лучше — остаётся на своей стороне и прижимается к окну", () => {
    const tall = { width: 300, height: 790 };
    const at = placePopover({ trigger: { top: 380, left: 200, width: 120, height: 32 }, pop: tall, viewport });
    expect(at.side).toBe("bottom");
    expect(at.top).toBeGreaterThanOrEqual(8);
    expect(at.top + tall.height).toBeLessThanOrEqual(viewport.height);
  });

  test("у правого края окна — сдвигается внутрь, а не обрезается", () => {
    const at = placePopover({ trigger: { top: 100, left: 1200, width: 60, height: 32 }, pop, viewport });
    expect(at.left).toBe(1280 - 300 - 8);
  });

  test("справа не помещается — уходит влево", () => {
    const at = placePopover({
      trigger: { top: 100, left: 1100, width: 60, height: 32 },
      pop,
      viewport,
      side: "right",
    });
    expect(at.side).toBe("left");
    expect(at.left).toBe(1100 - 8 - 300);
  });
});

describe("поповер: разметка", () => {
  test("закрытый — без слоя; триггер без фокуса получает tabIndex=0", () => {
    const html = draw(
      <Popover title="Сигнал № 214" content="пункт 9">
        <span>Мельник</span>
      </Popover>,
    );
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain("data-popover");
    expect(html).not.toContain('role="tooltip"');
  });

  test("кнопка остаётся своей остановкой Tab: tabIndex ей не навязывается", () => {
    const html = draw(
      <Popover content="пункт 9">
        <button type="button">Сигнал</button>
      </Popover>,
    );
    expect(html).not.toContain("tabindex");
  });

  test("подсказка и поповер открываются на видимом фокусе (клавиатура), а не на программном", () => {
    /*
     * Ящик ставит фокус на крестик сам, и подсказка «Закрити…» висела над
     * каждым ящиком, открытым мышью. Решает :focus-visible элемента.
     */
    const el = (visible: boolean) => ({ matches: (sel: string) => sel === ":focus-visible" && visible }) as unknown as EventTarget;
    expect(focusFromKeyboard(el(true))).toBe(true);
    expect(focusFromKeyboard(el(false))).toBe(false);
    expect(focusFromKeyboard(null)).toBe(false);
    // браузер без :focus-visible — прежнее правило: любой фокус
    const old = { matches: () => { throw new SyntaxError("unknown pseudo-class"); } } as unknown as EventTarget;
    expect(focusFromKeyboard(old)).toBe(true);
  });
});

/* ─────────── ящик ─────────── */

describe("ящик: черновик живёт, пока ящик закрыт", () => {
  test("закрытый ящик в разметке есть — inert и скрыт от диктора, содержимое смонтировано", () => {
    const html = draw(
      <Drawer open={false} onClose={() => {}} title="Розбір сигналу № 214" dirty>
        <textarea defaultValue="нотатка, яку набрали" />
      </Drawer>,
    );
    expect(html).toContain("data-drawer");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("inert");
    expect(html).toContain("нотатка, яку набрали");
  });

  test("открытый — модальный диалог с именем вида; несохранённый ввод сказан в подвале", () => {
    const html = draw(
      <Drawer open onClose={() => {}} title="Розбір сигналу № 214" dirty footer={<button type="button">Зберегти</button>}>
        <p>тіло</p>
      </Drawer>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Розбір сигналу № 214"');
    expect(html).toContain("data-saved");
    expect(html).toMatch(/(чернетку збережено|черновик сохранён)/);
  });

  test("несколько видов: показан названный, остальные смонтированы и скрыты", () => {
    const html = draw(
      <Drawer open mode="reply" onClose={() => {}}>
        <DrawerPane mode="signal" title="Розбір">
          <p>чернетка розбору</p>
        </DrawerPane>
        <DrawerPane mode="reply" title="Відповідь">
          <p>чернетка відповіді</p>
        </DrawerPane>
      </Drawer>,
    );
    expect(html).toContain("чернетка розбору");
    expect(html).toContain("чернетка відповіді");
    expect(html).toMatch(/data-pane="signal" hidden=""/);
    expect(html).not.toMatch(/data-pane="reply" hidden=""/);
  });

  test("вид по имени, неизвестное имя — первый; текст сообщения о черновике", () => {
    expect(activePane(["signal", "reply"], "reply")).toBe(1);
    expect(activePane(["signal", "reply"], "nope")).toBe(0);
    expect(activePane(["signal", "reply"])).toBe(0);
    const tpl = { of: "Чернетку {name} збережено", plain: "Чернетку збережено" };
    expect(draftToastText(tpl, "розбору сигналу № 214")).toBe("Чернетку розбору сигналу № 214 збережено");
    expect(draftToastText(tpl)).toBe("Чернетку збережено");
  });

  test("сообщение с действием живёт дольше: «Повернутися» не исчезает из-под руки", () => {
    expect(toastLifetime("info", true)).toBeGreaterThan(toastLifetime("info", false));
    expect(toastLifetime("err", false)).toBeGreaterThan(toastLifetime("ok", false));
  });

  test("подсказка крестика обещает черновик только там, где он бывает", () => {
    expect(closeTipKey({ dirty: true })).toBe("kit.closeKeep");
    expect(closeTipKey({ draftName: "розбору сигналу № 214" })).toBe("kit.closeKeep");
    expect(closeTipKey({})).toBe("common.close");
    expect(closeTipKey({ dirty: false })).toBe("common.close");
  });
});

describe("карточка выбора", () => {
  test("недоступный вариант выключен по-настоящему: радио disabled, карточка — «недоступно», не выбирается", () => {
    const html = draw(
      <ChoiceCard name="profile" value="full" checked={false} onChange={() => {}} title="Повний" sub="потрібне право exports.full" disabled />,
    );
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*disabled=""/);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("cursor-not-allowed");
    expect(html).not.toContain("hover:bg-sunk-2");
  });

  test("доступный — как прежде", () => {
    const html = draw(<ChoiceCard name="profile" value="short" checked onChange={() => {}} title="Короткий" />);
    expect(html).not.toContain("disabled");
    expect(html).toContain("bg-violet-tint");
  });
});

/* ─────────── окно ─────────── */

describe("окно, которое надо закончить", () => {
  test("esc={false} помечает слой data-esc=block; обычное — нет", () => {
    expect(draw(<Modal title="Коди" esc={false} onClose={() => {}}>x</Modal>)).toContain('data-esc="block"');
    expect(draw(<Modal title="Коди" onClose={() => {}}>x</Modal>)).not.toContain("data-esc");
  });

  test("Esc и подложка у такого окна ведут к толчку, а не к закрытию (исходник)", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/ui/index.tsx"), "utf8");
    expect(src).toContain("const onClose = esc ? closeProp : nudge;");
    /* крестик — своя кнопка окна: закрывает всегда */
    expect(src).toMatch(/onClose=\{closeProp\}/);
  });
});

/* ─────────── поле ─────────── */

describe("поле с отказом", () => {
  test("отказ — текстом со значком, поле — aria-invalid и описание отказом", () => {
    const html = draw(
      <Field label="Телефон" error="Номер неповний">
        <Input defaultValue="+380 67" />
      </Field>,
    );
    expect(html).toContain('aria-invalid="true"');
    const described = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(described).toBeTruthy();
    expect(html).toContain(`id="${described}"`);
    expect(html).toContain("text-risk-ink");
    /* никакой красной заливки поля */
    expect(html).not.toMatch(/<input[^>]*bg-risk/);
  });
});

describe("поле со значком или хвостом", () => {
  /*
   * Коробка (span) несёт кегль, а <input> внутри — нет. Наследие ставит
   * всякому полю 12,5 (legacy.css, :where(input)), и поле поиска со
   * значком печатало мельче своей подсказки. Кегль поля — от коробки.
   */
  test("поле внутри коробки берёт кегль коробки, а не наследия", () => {
    for (const node of [<Input key="i" icon={<span />} defaultValue="Мельник" />, <Input key="s" suffix="хв" defaultValue="50" />]) {
      const html = draw(node);
      expect(html).toMatch(/<span[^>]*class="[^"]*text-body[^"]*"/);
      expect(html.match(/<input[^>]*class="([^"]*)"/)?.[1]).toContain("[font-size:inherit]");
    }
  });

  test("поле без коробки — свой кегль набора", () => {
    expect(draw(<Input defaultValue="x" />).match(/<input[^>]*class="([^"]*)"/)?.[1]).toContain("text-body");
  });
});

/* ─────────── таблица ─────────── */

describe("таблица: отметка строк", () => {
  test("одна строка — туда и обратно", () => {
    const a = toggleKey(new Set(), "a");
    expect([...a]).toEqual(["a"]);
    expect([...toggleKey(a, "a")]).toEqual([]);
  });

  test("«выбрать все»: никто → все видимые; часть → все; все → никто; чужие страницы не трогаются", () => {
    const visible = ["a", "b", "c"];
    expect(selectAllState(visible, new Set())).toBe("none");
    expect(selectAllState(visible, new Set(["b"]))).toBe("some");
    expect(selectAllState(visible, new Set(visible))).toBe("all");
    expect([...toggleAll(visible, new Set(["b", "z"]))].sort()).toEqual(["a", "b", "c", "z"]);
    expect([...toggleAll(visible, new Set(["a", "b", "c", "z"]))]).toEqual(["z"]);
    expect(selectAllState([], new Set(["z"]))).toBe("none");
  });

  test("J/K: шаг по строкам, на краю — на месте; без текущей — первая или последняя", () => {
    const keys = ["a", "b", "c"];
    expect(stepRow(keys, "a", 1)).toBe("b");
    expect(stepRow(keys, "c", 1)).toBe("c");
    expect(stepRow(keys, "a", -1)).toBe("a");
    expect(stepRow(keys, null, 1)).toBe("a");
    expect(stepRow(keys, null, -1)).toBe("c");
    expect(stepRow([], null, 1)).toBeNull();
  });
});

interface P {
  id: string;
  name: string;
  score: number;
  risk?: boolean;
}

const rows: P[] = [
  { id: "a", name: "Мельник", score: 14, risk: true },
  { id: "b", name: "Бойко", score: 23 },
  { id: "c", name: "Шевченко", score: 13 },
];
const columns: Column<P>[] = [
  { key: "name", header: "Пацієнт", sort: (r) => r.name, render: (r) => r.name },
  { key: "score", header: "Замір", num: true, sort: (r) => r.score, render: (r) => r.score },
];

/** Имена строк тела в порядке разметки (без колонки отметки) */
const names = (html: string) =>
  [...(html.split("<tbody")[1] ?? "").matchAll(/<tr[^>]*>(?:<td[^>]*><input[^>]*\/?><\/td>)?<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);

describe("таблица: разметка", () => {
  test("сортировка — словом у заголовка (aria-sort), строки — в её порядке", () => {
    const html = draw(<DataTable rows={rows} columns={columns} initialSort={{ key: "score", desc: true }} />);
    expect(names(html)).toEqual(["Бойко", "Мельник", "Шевченко"]);
    expect(html).toMatch(/<th[^>]*aria-sort="descending"[^>]*><button[^>]*>Замір/);
    expect(html).toMatch(/<th[^>]*aria-sort="none"[^>]*><button[^>]*>Пацієнт/);
  });

  test("отметка: «выбрать все» в шапке, флажок в строке, полоса действий с числом", () => {
    const html = draw(
      <DataTable
        rows={rows}
        columns={columns}
        selectable
        selected={new Set(["b"])}
        bulkActions={() => <button type="button">Написати</button>}
      />,
    );
    expect(html.match(/type="checkbox"/g)?.length).toBe(rows.length + 1);
    expect(html).toMatch(/(Вибрати всі рядки|Выбрать все строки)/);
    expect(html).toContain("Написати");
    expect(html).toMatch(/(Вибрано|Выбрано): <span[^>]*>1<\/span>/);
  });

  test("без отметки — полосы действий нет", () => {
    const html = draw(
      <DataTable rows={rows} columns={columns} selectable bulkActions={() => <button type="button">Написати</button>} />,
    );
    expect(html).not.toContain("Написати");
  });

  test("одна остановка Tab на таблицу: строка «в руке» — tabindex=0, прочие — −1", () => {
    const html = draw(<DataTable rows={rows} columns={columns} onRowClick={() => {}} />);
    expect(html.match(/<tr[^>]*tabindex="0"/g)?.length).toBe(1);
    expect(html.match(/<tr[^>]*tabindex="-1"/g)?.length).toBe(rows.length - 1);
  });

  test("тон строки: риск — тонировкой риска, открытая — фиолетовой", () => {
    const html = draw(
      <DataTable
        rows={rows}
        columns={columns}
        rowTone={(r) => (r.risk ? "risk" : undefined)}
        onRowClick={() => {}}
        isRowActive={(r) => r.id === "c"}
      />,
    );
    expect(html).toContain("bg-risk-tint");
    expect(html).toContain("bg-violet-tint");
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
  });

  test("страницы: строк больше страницы — пейджер с номерами и подписью «Сторінка N»", () => {
    const many: P[] = Array.from({ length: 23 }, (_, i) => ({ id: `r${i}`, name: `Людина ${i}`, score: i }));
    const html = draw(<DataTable rows={many} columns={columns} pageSize={10} />);
    expect(html.match(/<tbody[\s\S]*<\/tbody>/)?.[0].match(/<tr /g)?.length).toBe(10);
    expect(html).toMatch(/aria-current="page"[^>]*>1</);
    expect(html).toMatch(/(Сторінка|Страница) 3/);
  });
});

describe("пейджер: номера и подпись", () => {
  test("семь и меньше — подряд; больше — края, соседи и разрывы", () => {
    expect(pageList(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageList(1, 10)).toEqual([1, 2, 3, "gap", 10]);
    expect(pageList(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
    expect(pageList(10, 10)).toEqual([1, "gap", 8, 9, 10]);
  });

  test("«Показано 1–25 з 248»", () => {
    expect(shownRange(1, 25, 248)).toBe("1–25");
    expect(shownRange(10, 25, 248)).toBe("226–248");
    expect(shownRange(1, 25, 1)).toBe("1");
    expect(shownRange(1, 25, 0)).toBe("0");
  });
});

/* ─────────── числа ─────────── */

describe("число со смыслом", () => {
  test("надёжность: за порогом к лучшему — надёжно лучше; к худшему — хуже; внутри — погрешность", () => {
    expect(reliabilityOf(-14, 11, "down")).toBe("better");
    expect(reliabilityOf(16, 14, "up")).toBe("better");
    expect(reliabilityOf(12, 11, "down")).toBe("worse");
    expect(reliabilityOf(-5, 6, "down")).toBe("within");
  });

  test("знак — минус, а не дефис", () => {
    expect(signed(-14)).toBe("−14");
    expect(signed(16, " в. п.")).toBe("+16 в. п.");
    expect(signed(0)).toBe("0");
  });

  test("дробь — языка экрана: запятая в украинском и русском, точка в английском", () => {
    expect(signed(-2.5, "", "uk")).toBe("−2,5");
    expect(signed(2.5, " в. п.", "ru")).toBe("+2,5 в. п.");
    expect(signed(-2.5, "", "en")).toBe("−2.5");
    expect(decimal(5.55, "uk")).toBe("5,55");
    expect(decimal(0.1 + 0.2, "ru")).toBe("0,3");
    expect(decimal(1.96 * Math.SQRT2 * 2, "uk", 1)).toBe("5,5");
    expect(decimal(14, "en")).toBe("14");
  });

  test("ячейка изменения печатает порог и сдвиг дробью языка, а не точкой", () => {
    const html = draw(<ChangeCell delta={-2.5} threshold={5.54} better="down" />);
    expect(html).toContain("−2,5");
    expect(html).toContain("5,54");
    expect(textOf(html)).not.toMatch(/\d\.\d/);
  });

  test("большое значение, «було» и мини-курс — тоже", () => {
    const html = draw(
      <>
        <BigValue code="T" value={44.9} history={[51.5, 47]} better="down" change={{ delta: -6.5, threshold: 5.5 }} />
        <CourseDigits code="T" values={[51.5, 47, 44.9]} better="down" />
      </>,
    );
    expect(html).toContain("44,9");
    expect(html).toContain("51,5 → 47");
    expect(textOf(html)).not.toMatch(/\d\.\d/);
  });
});
