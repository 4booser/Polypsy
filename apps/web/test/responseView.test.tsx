import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type ResponseDetail, type SurveyFull } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { AnswersPanel } from "../src/pages/response/index";
import { answerGrid, answerList } from "../src/pages/response/model";

/**
 * Экран «пройденный тест»: два места, где ошибка тихая.
 *
 * Первое — протокол. Сетка и список рисуют выбранный вариант заливкой, а
 * диктору нужен признак словом; балл пункта легко приписать каждому из
 * нескольких выбранных вариантов; порядок — цепочка, а не варианты с
 * весами. Ничего не падает, глазом поломка не видна. Веса и лестница
 * полос берутся из самого прохождения той версии, которую проходили
 * (сервер отдаёт их персоналу), — подставлять чужую версию больше неоткуда.
 *
 * Второе — адрес. Ссылки на прохождение собирают несколько экранов вручную,
 * а маршрут объявлен в одном; разъехаться им нечем помешать, кроме этой
 * проверки: ссылка на несуществующий адрес не ошибка сборки, а тихий уход
 * на «/» через запасной маршрут.
 */

const detail: ResponseDetail = {
  id: "r1",
  userId: "u1",
  survey: { id: "s1", title: "Тест", scoringEnabled: true, versionNumber: 1 },
  status: "completed",
  startedAt: "2026-09-01T10:00:00Z",
  submittedAt: "2026-09-01T10:10:00Z",
  durationMs: 600000,
  scores: [
    {
      scaleId: "sc1",
      scaleCode: "T",
      scaleTitle: "Загальна",
      kind: "clinical",
      rawScore: 15,
      correctedScore: 15,
      value: 15,
      normalized: true,
      normalization: "raw",
      maxScore: 30,
      percent: 50,
      band: { id: null, label: "Середній", severity: "mild", description: null, grade: null, recommendation: null },
      bands: [],
    },
  ],
  answers: [
    {
      questionId: "q2",
      title: "Друге",
      type: "single",
      position: 2,
      answered: true,
      optionIds: ["o2b"],
      options: [
        { id: "o2a", text: "Омтріамбакам", riskFlag: false, riskSeverity: null, score: 10 },
        { id: "o2b", text: "Яджамахе", riskFlag: false, riskSeverity: null, score: 15 },
      ],
      text: null,
      number: null,
      date: null,
      matrix: null,
      ranking: null,
      score: 15,
      durationMs: 0,
      changeCount: 0,
      visitCount: 0,
      events: [],
    },
    {
      questionId: "q1",
      title: "Перше",
      type: "single",
      position: 1,
      answered: false,
      optionIds: null,
      options: [
        { id: "o1a", text: "Омтріамбакам", riskFlag: false, riskSeverity: null, score: 10 },
        { id: "o1b", text: "Яджамахе", riskFlag: false, riskSeverity: null, score: 15 },
      ],
      text: null,
      number: null,
      date: null,
      matrix: null,
      ranking: null,
      score: null,
      durationMs: 0,
      changeCount: 0,
      visitCount: 0,
      events: [],
    },
  ],
};

/** Методика той же версии: идентификаторы вариантов и шкал совпадают с прохождением */
function survey(ids: { o1a: string; o1b: string; o2a: string; o2b: string; sc1: string }): SurveyFull {
  const option = (id: string, questionId: string, text: string, score: number) => ({
    id,
    questionId,
    text,
    keyCode: null,
    score,
    position: 0,
    kind: "option" as const,
    riskFlag: false,
    riskLabel: null,
    riskSeverity: null,
  });
  const band = (id: string, minScore: number, maxScore: number, label: string) => ({
    id,
    scaleId: ids.sc1,
    minScore,
    maxScore,
    label,
    severity: "mild" as const,
    description: null,
    grade: null,
    recommendation: null,
    cascadeBatteryId: null,
    cascadeDueDays: null,
    followUpDays: null,
    position: 0,
  });
  /*
   * Только то, что читает модель: пункты с вариантами и шкалы с полосами.
   * Остальные поля методики к экрану отношения не имеют, и приведение типа
   * честнее сорока строк заглушек, которые никто не проверяет.
   */
  return {
    id: "s1",
    title: "Тест",
    description: "Опис",
    versionNumber: 1,
    questions: [
      { id: "q1", position: 1, options: [option(ids.o1a, "q1", "Омтріамбакам", 10), option(ids.o1b, "q1", "Яджамахе", 15)] },
      { id: "q2", position: 2, options: [option(ids.o2a, "q2", "Омтріамбакам", 10), option(ids.o2b, "q2", "Яджамахе", 15)] },
    ],
    scales: [
      {
        id: ids.sc1,
        items: [{ questionId: "q1" }, { questionId: "q2" }],
        bands: [band("b3", 21, 30, "Високий"), band("b1", 1, 10, "Низький"), band("b2", 11, 20, "Середній")],
      },
    ],
  } as unknown as SurveyFull;
}

describe("пройденный тест: протокол списком", () => {
  test("пункты по позиции, вес варианта из прохождения, выбранный отмечен", () => {
    const list = answerList(detail);
    // пункты идут по позиции, а не в порядке ответа сервера
    expect(list.map((q) => q.number)).toEqual([1, 2]);
    expect(list[0]!.title).toBe("Перше");
    expect(list[0]!.answered).toBe(false);
    const second = list[1]!;
    expect(second.options.map((o) => o.score)).toEqual([10, 15]);
    expect(second.options.map((o) => o.chosen)).toEqual([false, true]);
  });

  test("у выбранного без веса — балл пункта; у нескольких выбранных балл не делится на каждого", () => {
    const one = answerList({
      ...detail,
      answers: [{ ...detail.answers[0]!, options: detail.answers[0]!.options.map((o) => ({ ...o, score: null })) }],
    })[0]!;
    expect(one.options.map((o) => o.score)).toEqual([null, 15]);
    const many = answerList({
      ...detail,
      answers: [
        {
          ...detail.answers[0]!,
          type: "multiple",
          optionIds: ["o2a", "o2b"],
          score: 25,
          options: detail.answers[0]!.options.map((o) => ({ ...o, score: null })),
        },
      ],
    })[0]!;
    expect(many.options.map((o) => o.score), "балл пункта приписан каждому выбранному").toEqual([null, null]);
  });

  /**
   * Мутация: рисовать список вариантов у всякого пункта, где они есть, — у
   * порядка выходит список с весами вместо цепочки, проверка называет пункт.
   */
  test("пункт «порядок» — цепочка, а не список вариантов с весами", () => {
    const order: (typeof detail.answers)[number] = {
      ...detail.answers[0]!,
      questionId: "q3",
      title: "Порядок",
      type: "ranking",
      position: 3,
      optionIds: null,
      ranking: ["o2b", "o2a"],
    };
    const q = answerList({ ...detail, answers: [order] })[0]!;
    expect(q.options, "у пункта «порядок» нарисован список вариантов").toEqual([]);
    expect(q.free).toBe("Яджамахе → Омтріамбакам");
  });
});

describe("пройденный тест: сетка ответов", () => {
  const ids = { o1a: "o1a", o1b: "o1b", o2a: "o2a", o2b: "o2b", sc1: "sc1" };

  test("общий набор вариантов — столбцы; вес столбца, выбранный и прежний ответ", () => {
    const prev = new Map([["q2", { optionIds: ["o2a"], score: 10, answered: true }]]);
    const grid = answerGrid(detail, survey(ids), prev)!;
    expect(grid.columns.map((c) => [c.text, c.score])).toEqual([
      ["Омтріамбакам", 10],
      ["Яджамахе", 15],
    ]);
    expect(grid.rows.map((r) => r.number)).toEqual([1, 2]);
    expect(grid.rows.map((r) => r.chosen)).toEqual([null, 1]);
    expect(grid.rows[1]!.prev).toBe(0);
    expect(grid.rows[1]!.prevScore).toBe(10);
    expect(grid.rows[0]!.prev, "у пропущенного раньше пункта кольца нет").toBeNull();
    expect(grid.extra).toEqual([]);
  });

  test("пункт вне ключа шкал — «не входить у суму»; другой набор вариантов — строкой под сеткой", () => {
    const other: (typeof detail.answers)[number] = {
      ...detail.answers[0]!,
      questionId: "q9",
      title: "Наскільки складно",
      position: 9,
      optionIds: ["x2"],
      options: [
        { id: "x1", text: "Легко", riskFlag: false, riskSeverity: null, score: 0 },
        { id: "x2", text: "Дещо складно", riskFlag: false, riskSeverity: null, score: 1 },
      ],
    };
    const sv = survey(ids);
    (sv.scales[0] as unknown as { items: { questionId: string }[] }).items = [{ questionId: "q1" }, { questionId: "q2" }];
    const grid = answerGrid({ ...detail, answers: [...detail.answers, other] }, sv, new Map())!;
    expect(grid.rows.map((r) => r.inScale)).toEqual([true, true]);
    expect(grid.extra.map((e) => [e.number, e.answer, e.inScale])).toEqual([[3, "Дещо складно", false]]);
  });

  test("общего набора нет — сетки нет, экран показывает список", () => {
    const mixed = {
      ...detail,
      answers: detail.answers.map((a, i) => ({
        ...a,
        options: a.options.map((o) => ({ ...o, text: `${o.text} ${i}` })),
      })),
    };
    expect(answerGrid(mixed, null, new Map())).toBeNull();
  });
});

describe("пройденный тест: разметка сетки", () => {
  test("выбранный назван словом, а не одной заливкой; пропуск — словом", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LangProvider>
          <AnswersPanel detail={detail} survey={survey({ o1a: "o1a", o1b: "o1b", o2a: "o2a", o2b: "o2b", sc1: "sc1" })} ctx={null} prev={null} />
        </LangProvider>
      </MemoryRouter>,
    );
    const chosen = [UI["rsp.chosen"].uk, UI["rsp.chosen"].ru, UI["rsp.chosen"].en];
    expect(chosen.some((w) => html.includes(`${w}: Яджамахе`)), "выбранный вариант не назван для диктора").toBe(true);
    const skipped = [UI["cases.skipped"].uk, UI["cases.skipped"].ru, UI["cases.skipped"].en];
    expect(skipped.some((w) => html.includes(w)), "пропущенный пункт не назван словом").toBe(true);
    expect(html).not.toContain("NaN");
  });
});

const SRC = resolve(import.meta.dir, "../src");

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...codeFiles(path));
    else if (path.endsWith(".tsx") || path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("пройденный тест: адрес", () => {
  const ROUTE = '<Route path="/surveys/:id/responses/:rid"';
  const CHARTS = '<Route path="/surveys/:id/responses/:rid/charts"';

  test("маршрут объявлен в таблице маршрутов", () => {
    const app = readFileSync(join(SRC, "App.tsx"), "utf8");
    expect(app, "apps/web/src/App.tsx: маршрут прохождения снят или переименован").toContain(ROUTE);
    // вкладка «Графіки» и карточка пациента ведут сюда — без маршрута это тихий уход на «*»
    expect(app, "apps/web/src/App.tsx: маршрут графиков прохождения снят или переименован").toContain(CHARTS);
  });

  test("каждая ссылка на прохождение собрана по форме маршрута", () => {
    /*
     * Ищется хвост «/responses/${…}» в шаблонных строках и проверяется, что
     * перед ним стоит «/surveys/${…}»: ссылка вида `/responses/${id}` без
     * методики впереди ушла бы на запасной маршрут «*», то есть на сводку,
     * молча. Форма проверяется по исходнику, потому что адрес собирается в
     * трёх файлах руками, и общего помощника для него нет намеренно — он
     * стал бы четвёртым местом, которое надо помнить.
     */
    const APP = readFileSync(`${SRC}/App.tsx`, "utf8");
    const offenders: string[] = [];
    for (const file of codeFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/`([^`\n]*\/responses\/\$\{[^`\n]*)`/g)) {
        // адреса сервера («/api/reports/responses/…») — другой мир, к маршрутам консоли не относятся
        if (m[1]!.startsWith("/api/")) continue;
        /*
         * Заключение — свой экран со своим объявленным маршрутом
         * «/responses/:id/conclusion» (App.tsx). Он не проваливается в «*»,
         * и держать его нарушителем значило бы ловить не дыру, а форму.
         * Пропуск разрешён только пока маршрут объявлен: пропадёт из App.tsx —
         * ссылка снова станет зовом в пустоту, и сторож это увидит.
         */
        const conclusionDeclared = /path="\/responses\/:id\/conclusion"/.test(APP);
        if (conclusionDeclared && /^\/responses\/\$\{[^}]+\}\/conclusion$/.test(m[1]!)) continue;
        /*
         * Тот же экран с инструментами черновика — «/responses/:id/conclusion/draft».
         * Пропуск ровно на тех же условиях: пока маршрут объявлен. Дверь в него
         * ведёт из бургера (Topbar.tsx), и без этой строки сторож принимал бы
         * её за зов в пустоту.
         */
        const draftDeclared = /path="\/responses\/:id\/conclusion\/draft"/.test(APP);
        if (draftDeclared && /^\/responses\/\$\{[^}]+\}\/conclusion\/draft$/.test(m[1]!)) continue;
        /*
         * Вкладка «Графіки» того же прохождения — «/surveys/:id/responses/:rid/charts».
         * Пропуск на тех же условиях: пока маршрут объявлен. Форма начала —
         * та же, что у протокола: методика впереди обязательна и здесь.
         */
        const chartsDeclared = /path="\/surveys\/:id\/responses\/:rid\/charts"/.test(APP);
        if (chartsDeclared && /^\/surveys\/\$\{[^}]+\}\/responses\/\$\{[^}]+\}\/charts$/.test(m[1]!)) continue;
        if (!/^\/surveys\/\$\{[^}]+\}\/responses\/\$\{[^}]+\}$/.test(m[1]!)) {
          offenders.push(`${file.slice(SRC.length + 1)}: \`${m[1]}\``);
        }
      }
    }
    expect(offenders, "ссылка на прохождение не по форме /surveys/${…}/responses/${…}").toEqual([]);
  });
});
