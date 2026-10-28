import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * «Динаміка» и «Курс» рабочего места пациента (#199): график и подпись
 * значения — в одних единицах.
 *
 * rawScore точки динамики — вопреки имени T-балл или стен (routes/dynamics.ts),
 * maxScore — максимум сырого балла. Экран делил одно на другое: T 70 при
 * максимуме 16 давал ось 437 % и строку «70 з 16». Верх шкалы и «з N»
 * считаются в packages/shared (dynamicsPoint.ts, там же проверка на T-баллах
 * и стенах) — одной записью с мобилкой; здесь — что экраны и график курса на
 * неё подписаны и прежнего деления в них не осталось.
 *
 * Курс — графиками участка графиков: значение каждой шкалы стоит в шапке её
 * графика (charts/course.tsx) — «19 з 27» у сырого балла, «64 T-бал» у
 * нормированного; методики и шкалы — сеткой малых графиков, а не
 * переключателем.
 */

const read = (f: string) => readFileSync(resolve(import.meta.dir, "../src", f), "utf8");
const dynamics = read("pages/patientCard/Dynamics.tsx");
const overview = read("pages/patientCard/Overview.tsx");
const words = read("pages/patientCard/words.tsx");
const model = read("charts/courseModel.ts");
const chart = read("charts/course.tsx");

describe("динамика пациента: график и подпись в одних единицах", () => {
  test("курс каждой шкалы — из её точек динамики, со ссылкой на протокол; сеткой графиков, легенда одна", () => {
    expect(dynamics).toContain("courseFromDynamics(seriesOf(r.scale, equating), r.rungs, undefined, { surveyId: sv.surveyId })");
    expect(dynamics).toContain("<CourseGrid>");
    expect(dynamics).toContain("legend={false}");
    expect(overview).toContain('size="compact" legend={false}');
    expect(overview).toContain("<CourseLegend");
  });

  test("малый курс строки картины — CourseSpark с лестницей полос и верхом шкалы", () => {
    expect(overview).toContain("<CourseSpark");
    expect(overview).toContain("max={pointValueTop(r.last)}");
  });

  test("верх шкалы у графика курса — в единицах значений (pointValueTop), ненормированная точка — сырым баллом", () => {
    expect(model).toContain("max: last ? pointValueTop(last) : null");
    expect(model).toContain('last.normalized === false ? "raw"');
    expect(model + dynamics + overview).not.toMatch(/rawScore\s*\/\s*\w+\.maxScore/);
  });

  test("«з N» — только у сырого балла: в шапке графика и в словах картины", () => {
    expect(chart).toContain('`${ut("an.of")} ${fmt.num(max)}`');
    expect(chart).toContain("ut(`norm.${normalization}` as UiKey)");
    expect(words).toContain('const top = units === "raw" ? pointValueTop(p) : null;');
    expect(words).not.toMatch(/rawScore\s*\/\s*\w+\.maxScore/);
  });

  test("положительный контроль: график по-прежнему рисует значение точки", () => {
    // сами значения на графике — T-балл или стен, как и полосы; меняются только подписи
    expect(model).toContain("value: p.rawScore,");
  });
});
