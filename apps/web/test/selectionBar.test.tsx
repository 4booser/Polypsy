import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LangProvider } from "../src/lang";
import { SelectionBar } from "../src/pages/patientGroups/PersonGrid";

/**
 * Рядок под сеткой печатает ОДИН счётчик.
 *
 * Замер кадра f05 во всю ширину колонки (y 849…866): чернила только
 * x 201…296 цветом (102,102,102), правее до 1400 — чистый лист. Кадр снят
 * в состоянии с выборкой, значит пустота в этом рядке — решение макета, а
 * не «просто ничего не выбрано».
 *
 * Прежняя редакция ставила рядом со счётчиком глиф «⋯», и поймать это
 * глазами нельзя: он появляется только когда кто-то выбран, то есть на
 * снимке пустого списка его нет. Поэтому проверка смотрит на ВИДИМЫЙ ТЕКСТ
 * рядка целиком, а не ищет конкретный глиф: любая новая кнопка, ссылка или
 * подпись рядом со счётчиком уронит её так же.
 */

const render = (count: number, withEntries: boolean) =>
  renderToStaticMarkup(
    <LangProvider>
      <MemoryRouter>
        <SelectionBar
          count={count}
          entries={withEntries ? [{ label: "Додати до групи", onSelect: () => {} }] : undefined}
        />
      </MemoryRouter>
    </LangProvider>,
  );

/** Видимый текст: разметка без тегов, пробелы схлопнуты */
const visible = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("рядок выборки", () => {
  test("с выборкой и действиями виден только счётчик", () => {
    const html = render(18, true);
    expect(visible(html)).toBe("18 вибрано");
  });

  test("без выборки — тот же счётчик и никакого меню", () => {
    const html = render(0, true);
    expect(visible(html)).toBe("0 вибрано");
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  test("действия достижимы: счётчик и есть кнопка меню", () => {
    /* обратная половина: рядок без лишнего не должен оказаться рядком без входа */
    const html = render(18, true);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });
});
