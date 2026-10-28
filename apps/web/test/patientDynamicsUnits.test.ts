import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Вкладка «Динамика» карты пациента (#199): профиль, значение в шапке
 * графика курса и верх его оси — в одних единицах.
 *
 * rawScore точки динамики — вопреки имени T-балл или стен (routes/dynamics.ts),
 * maxScore — максимум сырого балла. Экран делил одно на другое: T 70 при
 * максимуме 16 давал ось профиля 437 % и строку «70 з 16». Доля и верх шкалы
 * теперь считаются в packages/shared (dynamicsPoint.ts, там же проверка на
 * T-баллах и стенах) — одной записью с мобилкой; здесь — что экран и график
 * курса на неё подписаны и прежнего деления в них не осталось.
 *
 * «Останній замір» под графиком ушёл вместе с переключателем методик: курс
 * теперь — сетка графиков, и значение каждой методики стоит в шапке её
 * графика (charts/course.tsx) — «19 з 27» у сырого балла, «64 T-бал» у
 * нормированного.
 */

const src = readFileSync(resolve(import.meta.dir, "../src/pages/Patients.tsx"), "utf8");
const dynamics = src.slice(src.indexOf("export function PatientDynamics"));
const model = readFileSync(resolve(import.meta.dir, "../src/charts/courseModel.ts"), "utf8");
const chart = readFileSync(resolve(import.meta.dir, "../src/charts/course.tsx"), "utf8");

describe("динамика пациента: доля и подпись в одних единицах", () => {
  test("профиль строится из pointShare, а не из rawScore / maxScore", () => {
    expect(dynamics).toContain("pointShare(s.first)");
    expect(dynamics).toContain("pointShare(s.last)");
    expect(dynamics).not.toMatch(/rawScore\s*\/\s*\w+\.maxScore/);
  });

  test("курс каждой методики — из её точек динамики, сеткой графиков", () => {
    expect(dynamics).toContain("courseFromDynamics(series(i.main)");
    expect(dynamics).toContain("<CourseGrid>");
  });

  test("верх шкалы у графика курса — в единицах значений (pointValueTop), ненормированная точка — сырым баллом", () => {
    expect(model).toContain("max: last ? pointValueTop(last) : null");
    expect(model).toContain('last.normalized === false ? "raw"');
    expect(model).not.toMatch(/rawScore\s*\/\s*\w+\.maxScore/);
  });

  test("«з 27» в шапке — только у сырого балла; у нормированного — единица шкалы", () => {
    expect(chart).toContain('`${ut("an.of")} ${fmt.num(max)}`');
    expect(chart).toContain("ut(`norm.${normalization}` as UiKey)");
  });

  test("положительный контроль: график по-прежнему рисует значение точки", () => {
    // сами значения на графике — T-балл или стен, как и полосы; меняются только доля и подписи
    expect(model).toContain("value: p.rawScore,");
  });
});
