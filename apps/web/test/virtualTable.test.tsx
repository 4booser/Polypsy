import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import VirtualRows from "../src/ui/virtualRows";

/**
 * Длинная таблица набора (больше 60 строк без страниц: реестр пациентов по
 * 100, журналы техпанели).
 *
 * Прежняя виртуализация жила на классах наследия: обёртка `.virtual-wrap` с
 * `contain: strict` без высоты схлопывалась в ноль — реестр по 100 на
 * странице показывал «Показано 1–100 з 134» и пустое место под ним, — а
 * высоту строки брала 38 px из --row-h при строках набора 56. Таблица была
 * без классов и без имени, и тело без ссылки: J/K не находили строку.
 */
const draw = (n: number, rowHeight = 56) =>
  renderToStaticMarkup(
    <VirtualRows
      sorted={Array.from({ length: n }, (_, i) => i)}
      head={
        <thead>
          <tr>
            <th>№</th>
          </tr>
        </thead>
      }
      renderRow={(row, i, ref) => (
        <tr key={row} ref={ref} data-index={i}>
          <td>{row}</td>
        </tr>
      )}
      rowHeight={rowHeight}
      columnCount={3}
      tableClassName="w-full border-separate border-spacing-0 text-body leading-[19px]"
      label="Пацієнти"
      bodyRef={{ current: null }}
    />,
  );

describe("длинная таблица", () => {
  test("та же таблица набора: классы и имя для диктора", () => {
    const html = draw(100);
    expect(html).toContain('aria-label="Пацієнти"');
    expect(html).toContain('class="w-full border-separate border-spacing-0 text-body leading-[19px]"');
    expect(html).not.toContain("virtual-wrap");
  });

  test("прокрутка — своя, до 72 % окна, и не схлопывается: без size-containment", () => {
    const html = draw(100);
    expect(html).toMatch(/data-virtual="true" class="[^"]*max-h-\[min\(72vh,900px\)\][^"]*overflow-auto/);
    expect(html).not.toContain("contain:strict");
  });

  test("до замера строка — высоты набора (56, в плотной 44), а не 38 наследия; распорка — ячейкой во всю ширину", () => {
    // без окна прокрутки строк ещё нет: вся высота — нижняя распорка
    expect(draw(100)).toContain('<td colSpan="3" class="border-0 p-0" style="height:5600px"></td>');
    expect(draw(100, 44)).toContain("height:4400px");
  });

  test("в наследии правил длинной таблицы больше нет", () => {
    const legacy = readFileSync(resolve(import.meta.dir, "../src/styles/legacy.css"), "utf8");
    expect(legacy).not.toContain(".virtual-wrap");
  });
});
