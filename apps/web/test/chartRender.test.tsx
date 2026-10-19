import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LineChart } from "../src/charts";
import { LangProvider } from "../src/lang";

/**
 * Графики рисуются, а не только компилируются.
 *
 * Остальные проверки консоли обходятся без React намеренно: логику удобнее
 * гонять отдельно от разметки. Но у графиков логика и есть разметка — они
 * целиком состоят из арифметики, превращённой в координаты, и ломаются они
 * не типами, а делением на ноль. Пустой ряд, единственная точка, ось, у
 * которой верх совпал с низом, — всё это даёт NaN в атрибуте пути, и SVG
 * молча исчезает. Компилятор такого не видит, а человек видит пустую панель
 * без сообщения об ошибке.
 *
 * Поэтому здесь проверяется ровно две вещи: что разметка вообще получилась и
 * что в ней нет NaN.
 */
const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

test("линия медианы с полосой межквартильного размаха", () => {
  const html = draw(
    <LineChart
      unit=" с"
      series={[
        {
          label: "Медиана времени",
          points: [
            { x: "В1", y: 4.5, lo: 3.4, hi: 6.2 },
            { x: "В2", y: 5.1, lo: 3.6, hi: 6.9 },
            { x: "В3", y: 4.8, lo: 3.2, hi: 6.4 },
          ],
        },
      ]}
    />,
  );
  expect(html).toContain("<svg");
  // полоса — отдельная фигура под линией, а не вторая линия
  expect(html.match(/<path/g)?.length ?? 0).toBeGreaterThan(1);
  expect(html).not.toContain("NaN");
});

test("срезанная ось помечена изломом и подписана", () => {
  /*
   * Половина решения — подогнать ось, вторая половина — сказать об этом.
   * Без подписи разница в три балла на срезанной оси выглядит так же, как
   * разница в тридцать на полной, и подогнанный график врёт убедительнее
   * растянутого. Проверяется именно вторая половина.
   */
  const html = draw(
    <LineChart
      fullRange={100}
      series={[
        {
          label: "T-балл",
          points: [
            { x: "1 мая", y: 61 },
            { x: "1 июня", y: 64 },
            { x: "1 июля", y: 63 },
          ],
        },
      ]}
    />,
  );
  expect(html).not.toContain("NaN");
  expect(html.toLowerCase()).toMatch(/ось не с нуля|вісь не з нуля/);
  expect(html.toLowerCase()).toMatch(/полная шкала|повна шкала/);
});

test("пустые и вырожденные данные не роняют график", () => {
  /*
   * Именно тот случай, ради которого проверка написана. Пустая выборка —
   * не исключение, а первый рабочий день экземпляра: до первого обследования
   * все графики консоли пустые.
   */
  const cases = [
    draw(<LineChart series={[{ label: "нет", points: [] }]} />),
    draw(<LineChart series={[{ label: "один", points: [{ x: "1 мая", y: 7 }] }]} />),
  ];
  for (const html of cases) expect(html).not.toContain("NaN");
});
