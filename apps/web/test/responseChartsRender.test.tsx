import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LangProvider } from "../src/lang";
import { ContributionPanel, DynamicsBody } from "../src/pages/response/charts";
import { ItemTimes, itemAxisTop } from "../src/pages/response/ItemTimes";
import { AnsweringPanel, ResultPanel } from "../src/pages/response/panels";
import { ANSWERS, answer, band, detail, dynamics, score, series, surveyFull } from "./responseFixtures";

/**
 * Графики прохождения рисуются на краях: первое прохождение, одиннадцать
 * шкал, шкала без полос и без нормы, ни одного замеренного пункта, пункт,
 * на котором человек отвлёкся на десять минут. Проверяется то же, что в
 * clinicalCharts.test.tsx: разметка получилась, и в ней нет NaN, —
 * деление на ноль в координатах стирает SVG молча, — и вместо пустоты
 * стоит слово.
 */
const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );
const clean = (html: string) => {
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("Infinity");
  expect(html).not.toContain("undefined");
};

describe("результат", () => {
  /*
   * Результат на протоколе стоит над ответами, и длинная лестница свёрнута:
   * видна строка попавшей полосы — подсвеченная, со смыслом и рекомендацией,
   * — остальные под «Усі смуги». Мутация: рисовать лестницу целиком — в
   * разметке появляются строки и тексты соседних полос.
   */
  test("одна шкала, длинная лестница: шкала тяжести, попавшая полоса со смыслом и рекомендацией; прочие — под кнопкой", () => {
    const html = draw(<ResultPanel detail={detail()} dynamics={null} ctx={null} variant="protocol" />);
    clean(html);
    expect(html).toContain('role="img"');
    expect(html).toContain("Помірна: опис");
    expect(html).toContain("Повторний замір за місяць");
    // попавшая ступень помечена словом, а не одной заливкой
    expect(html).toContain("це проходження");
    expect(html).not.toContain("Тяжка: опис");
    expect(html.match(/<li/g)?.length ?? 0).toBe(1);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Усі смуги: 4</);
  });

  test("короткая лестница видна целиком, попавшая ступень помечена словом «це проходження»", () => {
    const short = score({
      bands: [band("b1", 0, 9, "Норма", "none"), band("b2", 10, 19, "Помірна", "moderate", true), band("b3", 20, 27, "Тяжка", "severe")],
    });
    const html = draw(<ResultPanel detail={detail({ scores: [short] })} dynamics={null} ctx={null} variant="protocol" />);
    clean(html);
    expect(html.match(/<li/g)?.length ?? 0).toBe(3);
    // попавшая ступень помечена словом, а не одной заливкой
    expect(html).toContain("це проходження");
    expect(html).not.toContain("Усі смуги");
  });

  test("шкала без полос — лестницы нет; на графиках — смысл и рекомендация словами", () => {
    const bare = draw(<ResultPanel detail={detail({ scores: [score({ band: null, bands: [] })] })} dynamics={null} ctx={null} variant="protocol" />);
    clean(bare);
    expect(bare).not.toContain("<ol");
    expect(bare).toContain("без інтерпретаційних меж");
    const charts = draw(<ResultPanel detail={detail()} dynamics={null} ctx={null} variant="charts" />);
    clean(charts);
    expect(charts).toContain("Повторний замір за місяць");
  });

  test("сдвиг от предыдущего и от старта с порогом значущої зміни — словами", () => {
    const dyn = dynamics([
      series([
        { responseId: "r1", rawScore: 19 },
        { responseId: "r2", rawScore: 16 },
        { responseId: "r3", rawScore: 12 },
      ]),
    ]);
    const html = draw(<ResultPanel detail={detail()} dynamics={dyn} ctx={null} variant="protocol" />);
    clean(html);
    expect(html).toContain("−4");
    expect(html).toContain("−7");
    /* то же слово, что в шапке графика курса: «значуща», а не «надійна» */
    expect(html).toContain("поріг значущої зміни");
    expect(html).toContain("значуще покращення");
  });

  test("профиль: шкала без полос, ненормированная и T-балл без верха — пометки словами, без NaN", () => {
    const d = detail({
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
    });
    const html = draw(<ResultPanel detail={d} dynamics={null} ctx={null} variant="charts" />);
    clean(html);
    expect(html).toContain("не нормовано");
    expect(html).toContain("без інтерпретаційних меж");
    expect(html).toContain("T-бал 61");
  });
});

describe("динамика", () => {
  test("одно прохождение — строка, а не график", () => {
    const html = draw(<DynamicsBody detail={detail()} dyn={dynamics([series([{ responseId: "r3", rawScore: 12 }])], 1)} events={[]} />);
    clean(html);
    expect(html).toContain("Перше проходження");
    expect(html).not.toMatch(/<svg[^>]*role="img"/);
  });

  test("ряд: график курса с полосами тяжести", () => {
    const html = draw(
      <DynamicsBody
        detail={detail()}
        events={[]}
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
    expect(html).toContain("Легка");
  });

  test("несколько шкал — выбор шкалы и один график, а не одиннадцать", () => {
    const codes = ["L", "F", "K", "Hs", "D", "Hy", "Pd", "Pa", "Pt", "Sc", "Ma"];
    const d = detail({ scores: codes.map((c) => score({ scaleId: c, scaleCode: c, scaleTitle: c })) });
    const dyn = dynamics(
      codes.map((c) => series([{ responseId: "r1", rawScore: 50 }, { responseId: "r3", rawScore: 60 }], { code: c, title: c, sem: null })),
    );
    const html = draw(<DynamicsBody detail={d} dyn={dyn} events={[]} />);
    clean(html);
    expect(html).toContain("<select");
    expect(html.match(/<svg[^>]*role="img"/g)?.length ?? 0).toBe(1);
  });
});

describe("вклад пунктов", () => {
  test("перечень с пометкой критического варианта и счётчиком пропусков", () => {
    const html = draw(<ContributionPanel detail={detail({ answers: ANSWERS })} survey={surveyFull()} loading={false} prev={null} />);
    clean(html);
    expect(html).toContain("без відповіді: 1 з 7");
    expect(html).toContain("text-risk-ink");
  });

  test("методика той версии недоступна или чужая — слово, а не пустота", () => {
    expect(draw(<ContributionPanel detail={detail({ answers: ANSWERS })} survey={null} loading={false} prev={null} />)).toContain("не вдалося");
    expect(
      draw(<ContributionPanel detail={detail({ answers: ANSWERS })} survey={surveyFull({ versionNumber: 9 })} loading={false} prev={null} />),
    ).toContain("Методику змінено");
  });
});

describe("как отвечал", () => {
  test("выброс в десять минут не сплющивает остальные столбцы; смена ответа — в перечне", () => {
    const answers = Array.from({ length: 12 }, (_, i) =>
      answer({ questionId: `q${i}`, position: i + 1, durationMs: i === 5 ? 600_000 : 900 + i * 700, changeCount: i === 2 ? 1 : 0 }),
    );
    const html = draw(<AnsweringPanel detail={detail({ answers })} survey={null} surveyLoading={false} variant="charts" />);
    clean(html);
    expect(html).toContain("поріг");
    expect(html).toContain("№3");
    // выброс обрезан: верх оси — по остальным пунктам, а не по десяти минутам
    expect(itemAxisTop(answers.map((a) => a.durationMs / 1000), 1.5)).toBeLessThan(60);
  });

  test("ничего не замерено — прочерки и строка вместо графика", () => {
    const html = draw(
      <AnsweringPanel
        detail={detail({ durationMs: 0, answers: [answer({ questionId: "a", position: 1 }), answer({ questionId: "b", position: 2, answered: false })] })}
        survey={null}
        surveyLoading={false}
        variant="charts"
      />,
    );
    clean(html);
    expect(html).not.toMatch(/<svg[^>]*role="img"/);
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
    // подсказка порога — текстом целиком: из нескольких узлов <title> выходил с предупреждением React
    expect(html).toContain("<title>поріг 1,5 с</title>");
  });
});
