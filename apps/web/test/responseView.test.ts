import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResponseDetail, SurveyFull } from "@quizzy/shared";
import { buildResponseView } from "../src/pages/response/model";

/**
 * Экран «пройденный тест»: два места, где ошибка тихая.
 *
 * Первое — веса вариантов и лестница диапазонов берутся из действующей
 * версии методики, а человек мог проходить прежнюю. Числа при этом
 * выглядят настоящими: «10» и «15» у вариантов, «від 11 до 20» залито.
 * Ничего не падает, и никто не сообщит, что баллы — от другой редакции
 * ключа. Проверяется, что при разошедшихся идентификаторах экран не
 * подставляет ничего.
 *
 * Второе — адрес. Ссылки на прохождение собирают три экрана вручную, а
 * маршрут объявлен в четвёртом; разъехаться им нечем помешать, кроме этой
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
      band: { label: "Середній", severity: "mild", description: null, grade: null, recommendation: null },
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
        { id: "o2a", text: "Омтріамбакам", riskFlag: false, riskSeverity: null, score: null },
        { id: "o2b", text: "Яджамахе", riskFlag: false, riskSeverity: null, score: null },
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
        { id: "o1a", text: "Омтріамбакам", riskFlag: false, riskSeverity: null, score: null },
        { id: "o1b", text: "Яджамахе", riskFlag: false, riskSeverity: null, score: null },
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
    questions: [
      { id: "q1", position: 1, options: [option(ids.o1a, "q1", "Омтріамбакам", 10), option(ids.o1b, "q1", "Яджамахе", 15)] },
      { id: "q2", position: 2, options: [option(ids.o2a, "q2", "Омтріамбакам", 10), option(ids.o2b, "q2", "Яджамахе", 15)] },
    ],
    scales: [
      {
        id: ids.sc1,
        bands: [band("b3", 21, 30, "Високий"), band("b1", 1, 10, "Низький"), band("b2", 11, 20, "Середній")],
      },
    ],
  } as unknown as SurveyFull;
}

describe("пройденный тест: модель экрана", () => {
  test("одна версия: веса у вариантов, выбранный отмечен, ступень с баллом залита", () => {
    const view = buildResponseView(detail, survey({ o1a: "o1a", o1b: "o1b", o2a: "o2a", o2b: "o2b", sc1: "sc1" }));

    expect(view.stale).toBe(false);
    // пункты идут по позиции, а не в порядке ответа сервера
    expect(view.questions.map((q) => q.number)).toEqual([1, 2]);
    expect(view.questions[0]!.title).toBe("Перше");

    const second = view.questions[1]!;
    expect(second.options.map((o) => o.score)).toEqual([10, 15]);
    expect(second.options.map((o) => o.chosen)).toEqual([false, true]);
    expect(view.questions[0]!.answered).toBe(false);

    const ladder = view.ladders[0]!;
    expect(ladder.rows.map((r) => r.min)).toEqual([1, 11, 21]);
    expect(ladder.rows.map((r) => r.hit)).toEqual([false, true, false]);
  });

  test("методика изменена после прохождения: ни весов, ни лестницы — но подпись полосы остаётся", () => {
    const view = buildResponseView(detail, survey({ o1a: "n1a", o1b: "n1b", o2a: "n2a", o2b: "n2b", sc1: "nsc" }));

    expect(view.stale).toBe(true);
    for (const q of view.questions) {
      expect(q.options.map((o) => o.score)).toEqual([null, null]);
    }
    // выбор известен из самого прохождения и версии не боится
    expect(view.questions[1]!.options.map((o) => o.chosen)).toEqual([false, true]);
    expect(view.ladders[0]!.rows).toEqual([]);
    expect(view.ladders[0]!.bandLabel).toBe("Середній");
  });

  /**
   * Мутация: рисовать список вариантов у всякого пункта, где они есть, — у
   * порядка выходит список с нулями вместо цепочки, проверка называет пункт.
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
    const ids = { o1a: "o1a", o1b: "o1b", o2a: "o2a", o2b: "o2b", sc1: "sc1" };
    const view = buildResponseView({ ...detail, answers: [order] }, survey(ids));
    const q = view.questions[0]!;
    expect(q.options, "у пункта «порядок» нарисован список вариантов").toEqual([]);
    expect(q.free).toBe("Яджамахе → Омтріамбакам");
    // чужая версия по-прежнему ловится по вариантам порядка, хотя их не показывают
    expect(buildResponseView({ ...detail, answers: [order] }, survey({ ...ids, o2a: "n2a", o2b: "n2b" })).stale).toBe(true);
  });

  test("половина совпавших идентификаторов — тоже чужая версия", () => {
    /*
     * Так в базе не бывает: версия меняет идентификаторы целиком. Но модель
     * не должна опираться на это свойство базы: совпавшая шкала при
     * несовпавших вариантах означает, что сопоставление идёт не с той
     * версией, и подставлять лестницу по ней нельзя.
     */
    const view = buildResponseView(detail, survey({ o1a: "n1a", o1b: "n1b", o2a: "n2a", o2b: "n2b", sc1: "sc1" }));
    expect(view.stale).toBe(true);
    expect(view.ladders[0]!.rows).toEqual([]);
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
