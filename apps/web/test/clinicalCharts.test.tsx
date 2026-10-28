import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BandTrend,
  GroupedHBars,
  HBars,
  HeatTable,
  Kpi,
  ScaleProfile,
  SeverityMeter,
  ShareBar,
  Sparkline,
  TimeColumns,
  TimeLines,
} from "../src/charts/clinical";
import { LangProvider } from "../src/lang";

/**
 * Клинические графики рисуются на краях: пустой ряд, одна точка, шкала без
 * полос, скрытая ячейка. Как и в chartRender.test.tsx, проверяется, что
 * разметка получилась и в ней нет NaN — деление на ноль в координатах
 * молча стирает SVG, и человек видит пустое место без ошибки.
 */
const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

const rungs = [
  { min: 0, max: 4, label: "Мінімальна", severity: "none" as const },
  { min: 5, max: 9, label: "Легка", severity: "mild" as const },
  { min: 10, max: 14, label: "Помірна", severity: "moderate" as const },
  { min: 15, max: 27, label: "Тяжка", severity: "severe" as const },
];

test("шкала тяжести: булавка, границы числами, попавшая ступень в полную силу и словом", () => {
  const html = draw(<SeverityMeter rungs={rungs} value={12} label="PHQ-9: 12" />);
  // попавшая ступень — цветом ступени, остальные — её подложкой
  expect(html.match(/data-rung="on"/g)?.length).toBe(1);
  expect(html).toContain("background:var(--sev-2)");
  expect(html).toContain("background:var(--sev-0-bg)");
  // слово ступени и значение под шкалой — тяжесть никогда не цветом в одиночку
  expect(html).toMatch(/Помірна, (<!-- -->)?12/);
  expect(html).toContain("data-pin");
  // границы ступеней — числами под шкалой
  for (const n of [">0<", ">5<", ">10<", ">15<", ">27<"]) expect(html).toContain(n);
  expect(html).not.toContain("NaN");
});

test("шкала без полос — метр от нуля фиолетовым набора", () => {
  const html = draw(<SeverityMeter rungs={[]} value={7} max={20} label="DASS" />);
  expect(html).toContain("data-fill");
  expect(html).toContain("background:var(--series)");
  expect(html).not.toContain("NaN");
});

test("шкала без балла не рисует булавку", () => {
  const html = draw(<SeverityMeter rungs={rungs} value={null} label="—" />);
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("data-pin");
});

test("профиль с одинаковыми лестницами соединён линией", () => {
  const row = (key: string, value: number) => ({
    key,
    title: key,
    rungs,
    value,
    valueText: String(value),
    band: null,
  });
  const html = draw(<ScaleProfile rows={[row("a", 3), row("b", 12), row("c", 20)]} />);
  expect(html).toContain("<polyline");
  expect(html).not.toContain("NaN");
});

test("динамика из одной точки не делит на ноль по времени", () => {
  const html = draw(
    <BandTrend
      label="PHQ-9"
      rungs={rungs}
      points={[{ key: "1", t: Date.parse("2026-09-01"), label: "1 вер", value: 8, focus: true }]}
    />,
  );
  expect(html).toContain("<svg");
  expect(html).not.toContain("NaN");
});

test("ступень из одного значения подписана одним числом — в подсказке линейки и в колонке динамики", () => {
  const cgi = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ min: v, max: v, label: `Ступінь ${v}`, severity: (v < 4 ? "none" : "severe") as "none" | "severe" }));
  const meter = draw(<SeverityMeter rungs={cgi} value={3} label="CGI-S: 3" />);
  expect(meter).not.toMatch(/>(\d)–\1</);
  const trend = draw(
    <BandTrend
      label="CGI-S"
      rungs={cgi}
      points={[
        { key: "1", t: Date.parse("2026-08-01"), label: "1 серп", value: 5 },
        { key: "2", t: Date.parse("2026-09-01"), label: "1 вер", value: 3 },
      ]}
    />,
  );
  const plain = trend.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/[ \t\n]+/g, " ");
  expect(plain).not.toMatch(/(\d)–\1(?!\d)/);
  expect(plain).toContain("3 Ступінь 3");
});

test("динамика по лестнице: полоса из одного значения среди обычных (SWLS «20») видна и подписана «20»", () => {
  const swls = [
    { min: 5, max: 14, label: "Незадоволеність", severity: "mild" as const },
    { min: 15, max: 19, label: "Незначна незадоволеність", severity: "none" as const },
    { min: 20, max: 20, label: "Нейтральна оцінка", severity: "none" as const },
    { min: 21, max: 35, label: "Задоволеність", severity: "none" as const },
  ];
  const html = draw(
    <BandTrend
      label="SWLS"
      rungs={swls}
      points={[
        { key: "1", t: Date.parse("2026-08-01"), label: "1 серп", value: 18 },
        { key: "2", t: Date.parse("2026-09-01"), label: "1 вер", value: 22 },
      ]}
    />,
  );
  const band = /data-band="Нейтральна оцінка"[^>]*height="([\d.]+)"/.exec(html);
  expect(Number(band?.[1])).toBeGreaterThanOrEqual(14);
  const plain = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/[ \t\n]+/g, " ");
  expect(plain).toContain("20 Нейтральна оцінка");
  expect(plain).not.toContain("20–20");
});

test("динамика по лестнице: подписи полос целиком, клинический порог, «менше — краще» у оси", () => {
  const long = [
    { min: 0, max: 4, label: "Депресія відсутня", severity: "none" as const },
    { min: 5, max: 9, label: "Легка («субклінічна») депресія", severity: "mild" as const },
    { min: 10, max: 14, label: "Помірної тяжкості депресія", severity: "moderate" as const },
    { min: 15, max: 27, label: "Тяжка депресія", severity: "severe" as const },
  ];
  const html = draw(
    <BandTrend
      label="PHQ-9"
      rungs={long}
      points={[
        { key: "1", t: Date.parse("2026-08-01"), label: "1 серп", value: 6.4 },
        { key: "2", t: Date.parse("2026-09-01"), label: "1 вер", value: 4.99 },
      ]}
    />,
  );
  const plain = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/[ \t\n]+/g, " ");
  // многоточия больше нет: подпись переносится по словам, но целиком
  expect(html).not.toContain("…");
  for (const word of ["Депресія відсутня", "(«субклінічна»)", "Помірної тяжкості", "Тяжка депресія"]) expect(plain).toContain(word);
  expect(html).toContain('data-cutoff="10"');
  expect(plain).toMatch(/(клінічний поріг|клинический порог|clinical cut-off) ≥ 10/);
  expect(plain).toMatch(/менше — краще|меньше — лучше|lower is better/);
  expect(html).not.toContain("NaN");
});

test("динамика без лестницы подгоняет ось и рисует полосу ошибки", () => {
  const html = draw(
    <BandTrend
      label="RSES"
      rungs={[]}
      sem={1.5}
      points={[
        { key: "1", t: Date.parse("2026-06-01"), label: "1 чер", value: 21 },
        { key: "2", t: Date.parse("2026-07-01"), label: "1 лип", value: 24 },
        { key: "3", t: Date.parse("2026-09-01"), label: "1 вер", value: 23 },
      ]}
    />,
  );
  expect(html.match(/<path/g)?.length ?? 0).toBe(2);
  expect(html).not.toContain("NaN");
});

test("доли: скрытая ячейка не рисуется отрезком", () => {
  const html = draw(
    <ShareBar
      label="Полоси"
      parts={[
        { key: "a", label: "Мінімальна", value: 30, severity: "none" },
        { key: "b", label: "Тяжка", value: null, severity: "severe" },
      ]}
    />,
  );
  // один отрезок — только показанная часть; у скрытой в легенде «n < 5» с объяснением
  expect(html.match(/data-part=/g)?.length ?? 0).toBe(1);
  expect(html).toContain("n &lt; 5");
  expect(html).toContain("role=\"tooltip\"");
});

test("доли из одних нулей — пустая дорожка, а не NaN%", () => {
  const html = draw(<ShareBar label="x" parts={[{ key: "a", label: "a", value: 0 }]} />);
  expect(html).not.toContain("NaN");
});

test("полосы, столбцы и крупное число переживают пустые и нулевые данные", () => {
  const html = draw(
    <>
      <HBars items={[{ key: "a", label: "a", value: 0 }, { key: "b", label: "b", value: null }]} />
      <TimeColumns label="x" columns={[{ key: "1", label: "1", value: 0 }]} />
      <Kpi label="x" value={null} spark={[1, 1, 1]} />
    </>,
  );
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("Infinity");
});

test("крупное число — без плитки: ни заливки, ни рамки; ход — рядом с числом", () => {
  const html = draw(<Kpi label="Проходжень" value={1096} hint="за 90 днів" spark={[3, 5, 4, 8]} />);
  expect(html).toContain("text-stat");
  expect(html).not.toMatch(/bg-primary-soft|rounded-\[5px\]|shadow-tile/);
  // ход — фиксированного размера, а не растянутая полоса
  expect(html).toContain('width="84"');
  expect(html).not.toContain('preserveAspectRatio="none"');
  // внимание — янтарём набора
  expect(draw(<Kpi label="x" value={3} tone="attention" />)).toContain("text-warn");
});

test("ход величины рисуется своим цветом и меткой на последнем значении", () => {
  const html = draw(<Sparkline values={[1, 4, 2]} color="var(--c2)" />);
  expect(html).toContain('stroke="var(--c2)"');
  expect(html).toContain("fill:var(--c2)");
});

test("полосы: скрытая строка — пустая дорожка и «n < порог» с объяснением; отметка сравнения", () => {
  const html = draw(
    <HBars
      floor={10}
      reference={{ value: 5, label: "середнє" }}
      items={[
        { key: "a", label: "a", value: 8 },
        { key: "b", label: "b", value: null },
      ]}
    />,
  );
  expect(html).toContain("n &lt; 10");
  expect(html).toContain("shadow-[inset_0_0_0_1px_var(--ctl)]");
  expect(html.match(/data-bar=/g)?.length).toBe(1);
  expect(html).toContain("середнє");
  expect(html).not.toContain("NaN");
});

test("полосы: выделенная строка фиолетовым, остальные — «прочим»", () => {
  const html = draw(
    <HBars
      items={[
        { key: "a", label: "a", value: 8, strong: true },
        { key: "b", label: "b", value: 4 },
      ]}
    />,
  );
  expect(html).toContain("background:var(--series)");
  expect(html).toContain("background:var(--c5)");
});

test("сгруппированные полосы: свой цвет у ряда, легенда, скрытая ячейка", () => {
  const html = draw(
    <GroupedHBars
      series={[
        { key: "m", label: "чоловіки", color: "var(--c1)" },
        { key: "f", label: "жінки", color: "var(--c2)" },
      ]}
      rows={[
        { key: "1", label: "Сон", values: [12, 9] },
        { key: "2", label: "Тривога", values: [7, null] },
      ]}
    />,
  );
  expect(html.match(/data-bar="m"/g)?.length).toBe(2);
  expect(html.match(/data-bar="f"/g)?.length).toBe(1);
  expect(html).toContain("background:var(--c2)");
  expect(html).toContain("чоловіки");
  expect(html).toContain("n &lt; 5");
});

/*
 * Статистика прячет и большие числа (вместе с соседними они называют
 * людей): общая фраза «менше 5 людей» там неправда, и экран даёт свою.
 * Легенду он рисует одну на несколько групп полос.
 */
test("сгруппированные полосы: своё объяснение скрытой ячейки и легенда на стороне экрана", () => {
  const chart = (legend: boolean) =>
    draw(
      <GroupedHBars
        series={[
          { key: "a", label: "Вибірка 1", color: "var(--c1)" },
          { key: "b", label: "Вибірка 2", color: "var(--c2)" },
        ]}
        rows={[{ key: "1", label: "Сон", values: [null, 40] }]}
        hiddenWhy="Разом з іншими числами звіту воно називало б людей"
        legend={legend}
      />,
    );
  const html = chart(false);
  expect(html).toContain("Разом з іншими числами звіту");
  expect(html, "общая фраза о малой группе осталась рядом со своей").not.toContain("Менше 5 людей");
  // имя ряда остаётся в подсказке строки; легенда добавила бы его второй раз
  expect(html.match(/Вибірка 2/g)?.length, "легенда нарисована, хотя экран просил без неё").toBe(1);
  expect(chart(true).match(/Вибірка 2/g)?.length).toBe(2);
});

test("тепловая таблица: значение в каждой клетке, лестница одного тона, критический ответ — красным", () => {
  const html = draw(
    <HeatTable
      columns={["24.08", "11.09", "08.10"]}
      max={3}
      legend={[
        { value: 0, label: "зовсім ні" },
        { value: 3, label: "майже щодня" },
      ]}
      rows={[
        { key: "1", label: "Інтерес", cells: [3, 2, 2] },
        { key: "9", label: "Думки про смерть", cells: [0, 0, 1], critical: true },
        { key: "x", label: "Пропуск", cells: [1, null, 0] },
      ]}
    />,
  );
  // красный — только ненулевой ответ критического пункта
  expect(html.match(/data-cell="critical"/g)?.length).toBe(1);
  expect(html.match(/bg-risk/g)?.length).toBe(1);
  expect(html).toContain("text-risk-ink");
  // ступени лестницы — токены h1…h5, ноль — тихой подложкой, пропуск — прочерком в рамке
  expect(html).toContain("background:var(--h5)");
  expect(html).toContain('data-cell="h0"');
  expect(html).toContain('data-cell="empty"');
  expect(html).toContain("майже щодня");
  expect(html).not.toContain("NaN");
});

test("линии по корзинам: отметка выкатки пунктиром с подписью, подписи у концов", () => {
  const html = draw(
    <TimeLines
      label="p95"
      x={["a", "b", "c"].map((k) => ({ key: k, label: k }))}
      marks={[{ at: "b", label: "v1.22.0" }]}
      series={[
        { key: "p50", label: "p50", color: "var(--c3)", values: [10, 12, 11] },
        { key: "p95", label: "p95", color: "var(--c1)", values: [40, null, 44] },
      ]}
    />,
  );
  expect(html).toContain('data-mark="v1.22.0"');
  expect(html).toContain("v1.22.0");
  // разрыв: у p95 нет линии через пустую корзину — две одиночные метки
  expect(html.match(/data-single/g)?.length).toBe(2);
  // подписи у концов линий и легенда рядов
  expect(html).toContain("> p95</text>");
  expect(html).toContain(">p50<");
  expect(html).not.toContain("NaN");
});

test("ряд замеров (connect): пустые корзины его не рвут; длинное имя у конца — с многоточием, целиком в легенде", () => {
  const html = draw(
    <TimeLines
      label="Методики разом"
      connect
      x={["a", "b", "c", "d"].map((k) => ({ key: k, label: k }))}
      series={[
        { key: "s1", label: "Скринінг емоційного стану (демо)", color: "var(--c1)", values: [36, null, 50, 68] },
        { key: "s2", label: "Якість сну (демо)", color: "var(--c3)", values: [null, 69, null, 46] },
      ]}
      format={(v) => `${v} %`}
    />,
  );
  // каждый ряд — одной линией через свои замеры, без одиночных обрывков
  expect(html.match(/data-run=/g)?.length).toBe(2);
  expect(html).not.toContain("data-single");
  expect(html).toContain('data-run="3"');
  // у конца — обрезок имени, в легенде — имя целиком
  expect(html).toMatch(/> Скрин[^<]*…<\/text>/);
  expect(html).toContain(">Скринінг емоційного стану (демо)<");
  expect(html).not.toContain("NaN");
});

test("столбцы: числа на столбцах, пока их немного; неделя, что ещё идёт, светлее; скрытая — контуром", () => {
  const html = draw(
    <TimeColumns
      label="x"
      columns={[
        { key: "1", label: "1", value: 71 },
        { key: "2", label: "2", value: null, hidden: true },
        { key: "3", label: "3", value: 47, partial: true },
      ]}
    />,
  );
  expect(html).toContain(">71</text>");
  expect(html).toContain('fill-opacity="0.45"');
  expect(html).toContain('data-col="hidden"');
  expect(html).toContain("fill=\"var(--series)\"");
});

test("столбцы счёта: ось целыми делениями, а дробь — языка экрана", () => {
  /* «0 или 1 прохождение за день» — ось шла через 0,2, и подписи печатались с точкой */
  const counts = draw(
    <TimeColumns
      label="x"
      columns={[
        { key: "1", label: "1", value: 0 },
        { key: "2", label: "2", value: 1 },
        { key: "3", label: "3", value: 0 },
      ]}
    />,
  );
  const ticks = [...counts.matchAll(/text-anchor="end"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  expect(ticks).toEqual(["0", "1"]);
  /* величина дробная — деления дробные, через запятую украинской консоли */
  const shares = draw(<TimeColumns label="x" columns={[{ key: "1", label: "1", value: 0.5 }]} />);
  expect(shares).toContain(">0,1</text>");
  expect(shares).not.toContain(">0.1</text>");
});
