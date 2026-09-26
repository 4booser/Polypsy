import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "../src/lang";
import { AnsweringSection, ContributionSection, DynamicsSection, ResultSection } from "../src/pages/response/charts";
import { ItemTimes, itemAxisTop } from "../src/pages/response/ItemTimes";
import { resultRows } from "../src/pages/response/model";
import { ANSWERS, LABELS, answer, band, detail, dynamics, score, series, surveyFull } from "./responseFixtures";

/**
 * Графики прохождения рисуются на краях: первое прохождение, одиннадцать
 * шкал, шкала без полос и без нормы, ни одного замеренного пункта, пункт,
 * на котором человек отвлёкся на десять минут. Проверяется то же, что в
 * clinicalCharts.test.tsx: разметка получилась, и в ней нет NaN, —
 * деление на ноль в координатах стирает SVG молча, — и вместо пустоты
 * стоит слово.
 */
const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);
const clean = (html: string) => {
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("Infinity");
  expect(html).not.toContain("undefined");
};

describe("результат", () => {
  test("одна шкала: линейка, полоса словом, описание и рекомендация", () => {
    const html = draw(<ResultSection rows={resultRows(detail(), LABELS)} />);
    clean(html);
    expect(html).toContain('role="img"');
    expect(html).toContain("12 з 27");
    expect(html).toContain("Помірна: опис");
    expect(html).toContain("Повторний замір за місяць");
  });

  test("профиль: шкала без полос, ненормированная и T-балл без верха — пометки словами, без NaN", () => {
    const rows = resultRows(
      detail({
        scores: [
          score(),
          score({ scaleId: "s2", scaleCode: "A", scaleTitle: "Тривога", band: null, bands: [] }),
          score({
            scaleId: "s3",
            scaleCode: "Hs",
            scaleTitle: "Іпохондрія",
            normalization: "tscore",
            normalized: false,
            band: null,
            bands: [band("t1", 0, 44.9, "Низький", "none"), band("t2", 45, 120, "Високий", "severe")],
          }),
          score({ scaleId: "s4", scaleCode: "T", scaleTitle: "Т-шкала", normalization: "tscore", value: 61, band: null, bands: [] }),
        ],
      }),
      LABELS,
    );
    const html = draw(<ResultSection rows={rows} />);
    clean(html);
    expect(html).toContain("не нормовано");
    expect(html).toContain("без інтерпретаційних меж");
    expect(html).toContain("T-бал 61");
  });
});

describe("динамика", () => {
  test("одно прохождение — строка, а не график", () => {
    const html = draw(<DynamicsSection detail={detail()} dyn={dynamics([series([{ responseId: "r3", rawScore: 12 }])], 1)} />);
    clean(html);
    expect(html).toContain("Перше проходження");
    expect(html).not.toContain("<svg");
  });

  test("ряд: график с кольцом этого прохождения и сдвигом словами", () => {
    const html = draw(
      <DynamicsSection
        detail={detail()}
        dyn={dynamics([
          series([
            { responseId: "r1", rawScore: 6, bandLabel: "Легка", severity: "mild" },
            { responseId: "r3", rawScore: 12, bandLabel: "Помірна", severity: "moderate" },
          ]),
        ])}
      />,
    );
    clean(html);
    expect(html).toContain("<svg");
    expect(html).toContain("+6");
    expect(html).toContain("більше за похибку вимірювання");
    expect(html).toContain("Легка");
  });

  test("больше шести шкал — выбор шкалы и перечень сдвигов, а не одиннадцать графиков", () => {
    const codes = ["L", "F", "K", "Hs", "D", "Hy", "Pd", "Pa", "Pt", "Sc", "Ma"];
    const d = detail({ scores: codes.map((c) => score({ scaleId: c, scaleCode: c, scaleTitle: c })) });
    const dyn = dynamics(
      codes.map((c) =>
        series([{ responseId: "r1", rawScore: 50 }, { responseId: "r3", rawScore: 60 }], { code: c, title: c, sem: null }),
      ),
    );
    const html = draw(<DynamicsSection detail={d} dyn={dyn} />);
    clean(html);
    expect(html).toContain("<select");
    expect(html.match(/<svg/g)?.length ?? 0).toBe(1);
    expect(html).toContain("оцінити надійність зміни нема з чого");
  });
});

describe("вклад пунктов", () => {
  test("перечень с пометкой критического варианта и счётчиком пропусков", () => {
    const html = draw(<ContributionSection detail={detail({ answers: ANSWERS })} survey={surveyFull()} />);
    clean(html);
    expect(html).toContain("критичний варіант");
    expect(html).toContain("без відповіді: 1 з 7");
    expect(html).toContain("3 з 4");
  });

  test("методика той версии недоступна или чужая — слово, а не пустота", () => {
    expect(draw(<ContributionSection detail={detail({ answers: ANSWERS })} survey={null} />)).toContain("не вдалося");
    expect(draw(<ContributionSection detail={detail({ answers: ANSWERS })} survey={surveyFull({ versionNumber: 9 })} />)).toContain(
      "Методику змінено",
    );
  });
});

describe("как отвечал", () => {
  test("выброс в десять минут не сплющивает остальные столбцы; плитки с числами", () => {
    const answers = Array.from({ length: 12 }, (_, i) =>
      answer({ questionId: `q${i}`, position: i + 1, durationMs: i === 5 ? 600_000 : 900 + i * 700, changeCount: i === 2 ? 1 : 0 }),
    );
    const html = draw(<AnsweringSection detail={detail({ answers })} tooFastMs={null} locale="uk" />);
    clean(html);
    expect(html).toContain("поріг");
    expect(html).toContain("№3");
    // выброс обрезан: верх оси — по остальным пунктам, а не по десяти минутам
    expect(itemAxisTop(answers.map((a) => a.durationMs / 1000), 1.5)).toBeLessThan(60);
  });

  test("ничего не замерено — прочерки и строка вместо графика", () => {
    const html = draw(
      <AnsweringSection
        detail={detail({ durationMs: 0, answers: [answer({ questionId: "a", position: 1 }), answer({ questionId: "b", position: 2, answered: false })] })}
        tooFastMs={null}
        locale="uk"
      />,
    );
    clean(html);
    expect(html).not.toContain("<svg");
    expect(html).toContain("не записано");
    expect(html).toContain("—");
  });

  test("столбцы переживают один пункт и нулевое время", () => {
    const html = draw(
      <>
        <ItemTimes
          label="x"
          threshold={1.5}
          thresholdLabel="поріг"
          fastLabel="швидко"
          aboveLabel="вище"
          unit="с"
          columns={[{ key: "1", label: "1", title: "№1", value: 0, fast: false }]}
        />
        <ItemTimes
          label="x"
          threshold={1.5}
          thresholdLabel="поріг"
          fastLabel="швидко"
          aboveLabel="вище"
          unit="с"
          columns={[
            { key: "1", label: "1", title: "№1", value: 0.4, fast: true },
            { key: "2", label: "2", title: "№2", value: 3, fast: false },
          ]}
        />
      </>,
    );
    clean(html);
  });
});
