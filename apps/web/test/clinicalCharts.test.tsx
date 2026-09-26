import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BandTrend, HBars, Kpi, ScaleProfile, SeverityRuler, ShareBar, TimeColumns } from "../src/charts/clinical";
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

test("линейка: маркер, подписи ступеней, попавшая ступень выделена", () => {
  const html = draw(<SeverityRuler rungs={rungs} value={12} label="PHQ-9: 12" />);
  expect(html).toContain("Помірна");
  expect(html).toContain("font-bold");
  expect(html).not.toContain("NaN");
});

test("линейка шкалы без полос — метр от нуля", () => {
  const html = draw(<SeverityRuler rungs={[]} value={7} max={20} label="DASS" />);
  expect(html).toContain("bg-primary");
  expect(html).not.toContain("NaN");
});

test("линейка без балла не рисует маркер", () => {
  const html = draw(<SeverityRuler rungs={rungs} value={null} label="—" />);
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("border-[var(--card)]");
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
  // один отрезок — только показанная часть; у скрытой лишь прочерк в легенде
  expect(html.match(/title="/g)?.length ?? 0).toBe(1);
  expect(html).toContain("—");
});

test("доли из одних нулей — пустая дорожка, а не NaN%", () => {
  const html = draw(<ShareBar label="x" parts={[{ key: "a", label: "a", value: 0 }]} />);
  expect(html).not.toContain("NaN");
});

test("полосы, столбцы и плитка переживают пустые и нулевые данные", () => {
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
